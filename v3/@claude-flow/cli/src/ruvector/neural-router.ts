/**
 * Neural routing scaffold — `@ruvector/tiny-dancer` FastGRNN seam (#2334 Phase 1)
 *
 * Wires the optional neural path that ADR-026 originally described, behind a
 * double gate that is OFF by default:
 *
 *   CLAUDE_FLOW_ROUTER_NEURAL=1                      — opt in to the neural path
 *   CLAUDE_FLOW_ROUTER_MODEL_PATH=<x.safetensors>    — trained FastGRNN artifact
 *
 * Both must be set; otherwise `tryNeuralRoute` returns `null` immediately and
 * the caller stays on the shipped heuristic + Thompson-bandit path. When the
 * gate is open but anything fails (package not installed — it is an
 * optionalDependency per ADR-124 — artifact missing/incompatible, runtime
 * error), this module degrades gracefully: it returns `null`, never throws,
 * and the caller reports `routedBy: 'bandit-fallback'` so the active path is
 * observable rather than inferred from import success (ADR-086/074).
 *
 * Candidate modeling (#2334 Q3, provisional): the 3 model tiers are encoded as
 * fixed candidates with deterministic placeholder embeddings (orthogonal-ish
 * one-hot-block vectors). This is explicitly provisional — the trained Phase 2
 * artifact defines what candidate embeddings mean, and this encoding is the
 * scaffolding default until the maintainers answer #2334's candidate-modeling
 * question. Until a real artifact exists the gate stays closed in practice, so
 * the placeholder never influences routing.
 *
 * @module neural-router
 */

import { existsSync } from 'fs';

// ============================================================================
// Types (local mirror of the @ruvector/tiny-dancer surface we consume)
// ============================================================================

/** The three routable tiers — 'inherit' is never a neural candidate. */
export type NeuralRoutableModel = 'haiku' | 'sonnet' | 'opus';

export interface NeuralRouteDecision {
  model: NeuralRoutableModel;
  confidence: number;
  uncertainty: number;
  inferenceTimeUs: number;
}

interface TinyDancerRoutingDecision {
  candidateId: string;
  confidence: number;
  useLightweight: boolean;
  uncertainty: number;
}

interface TinyDancerRouter {
  route(request: {
    queryEmbedding: Float32Array | number[];
    candidates: Array<{ id: string; embedding: Float32Array | number[]; metadata?: string }>;
    metadata?: string;
  }): Promise<{
    decisions: TinyDancerRoutingDecision[];
    inferenceTimeUs: number;
    candidatesProcessed: number;
  }>;
}

// ============================================================================
// Gate & lifecycle
// ============================================================================

/** True when the user has opted in AND pointed at a model artifact. */
export function neuralRoutingEnabled(): boolean {
  return process.env.CLAUDE_FLOW_ROUTER_NEURAL === '1'
    && !!process.env.CLAUDE_FLOW_ROUTER_MODEL_PATH;
}

// Cached router instance + a sticky failure latch so a broken install/artifact
// costs one failed load, not one per routing call.
let routerInstance: TinyDancerRouter | null = null;
let loadFailed = false;

/** Reset cached state — for tests. */
export function resetNeuralRouter(): void {
  routerInstance = null;
  loadFailed = false;
}

async function loadRouter(): Promise<TinyDancerRouter | null> {
  if (routerInstance) return routerInstance;
  if (loadFailed) return null;

  const modelPath = process.env.CLAUDE_FLOW_ROUTER_MODEL_PATH;
  if (!modelPath || !existsSync(modelPath)) {
    loadFailed = true;
    return null;
  }

  try {
    // Dynamic import of an optionalDependency (ADR-124): absent on installs
    // where the native binding failed or was skipped — degrade, don't throw.
    const mod = await import('@ruvector/tiny-dancer');
    const RouterCtor = (mod as { Router?: new (cfg: { modelPath: string }) => TinyDancerRouter }).Router;
    if (!RouterCtor) {
      loadFailed = true;
      return null;
    }
    routerInstance = new RouterCtor({ modelPath });
    return routerInstance;
  } catch {
    loadFailed = true;
    return null;
  }
}

// ============================================================================
// Candidate encoding (provisional — see header + #2334 Q3)
// ============================================================================

const TIER_ORDER: NeuralRoutableModel[] = ['haiku', 'sonnet', 'opus'];

/**
 * Deterministic placeholder embedding for a tier candidate: a block one-hot
 * over the embedding dimensionality. Replaced by whatever the Phase 2 trained
 * artifact defines as candidate space.
 */
function tierCandidateEmbedding(tierIndex: number, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  const block = Math.max(1, Math.floor(dim / TIER_ORDER.length));
  const start = tierIndex * block;
  for (let i = start; i < Math.min(start + block, dim); i++) v[i] = 1 / Math.sqrt(block);
  return v;
}

// ============================================================================
// Routing
// ============================================================================

/**
 * Attempt a neural routing decision for the given task embedding.
 *
 * Returns `null` (never throws) when the gate is closed, the package or
 * artifact is unavailable, or inference fails — callers fall back to the
 * bandit and report `routedBy: 'bandit-fallback'` (when the gate was open)
 * or `'heuristic'` (when it never was).
 */
export async function tryNeuralRoute(embedding: number[]): Promise<NeuralRouteDecision | null> {
  if (!neuralRoutingEnabled()) return null;
  if (!embedding || embedding.length === 0) return null;

  const router = await loadRouter();
  if (!router) return null;

  try {
    const response = await router.route({
      queryEmbedding: embedding,
      candidates: TIER_ORDER.map((tier, i) => ({
        id: tier,
        embedding: tierCandidateEmbedding(i, embedding.length),
        metadata: JSON.stringify({ tier }),
      })),
    });

    const best = response.decisions?.[0];
    if (!best || !TIER_ORDER.includes(best.candidateId as NeuralRoutableModel)) return null;

    return {
      model: best.candidateId as NeuralRoutableModel,
      confidence: best.confidence,
      uncertainty: best.uncertainty,
      inferenceTimeUs: response.inferenceTimeUs,
    };
  } catch {
    return null;
  }
}
