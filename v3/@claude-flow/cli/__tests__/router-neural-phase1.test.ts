/**
 * #2334 Phase 1 — neural seam + trajectory collection tests.
 *
 * What this proves:
 *  1. DEFAULT UNCHANGED — with both env gates off, route() reports
 *     routedBy: 'heuristic' and behaves exactly like the pre-#2334 router
 *     (no sidecar file, no neural import).
 *  2. SEAM IS LIVE — an embedding passed through EnhancedModelRouter.route()
 *     reaches computeSemanticDepth (complexity shifts with embedding
 *     variance), closing the unreachable-branch finding from #2329.
 *  3. GRACEFUL DEGRADATION — neural gate open but artifact missing →
 *     routedBy: 'bandit-fallback', valid decision, no throw (ADR-124).
 *  4. TRAJECTORY COLLECTION — flag on → decision + outcome JSONL rows in
 *     .swarm/model-router-trajectories.jsonl, joined on taskHash; flag off →
 *     no file (privacy default).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRouter } from '../src/ruvector/model-router.js';
import { createEnhancedModelRouter } from '../src/ruvector/enhanced-model-router.js';
import { resetNeuralRouter } from '../src/ruvector/neural-router.js';
import { TRAJECTORY_FILE, taskHash } from '../src/ruvector/router-trajectory.js';

let cwdRestore: string;
let tmpDir: string;
const ENV_KEYS = [
  'CLAUDE_FLOW_ROUTER_NEURAL',
  'CLAUDE_FLOW_ROUTER_MODEL_PATH',
  'CLAUDE_FLOW_ROUTER_TRAJECTORY',
] as const;
let envRestore: Record<string, string | undefined>;

beforeEach(() => {
  cwdRestore = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'router-neural-p1-'));
  process.chdir(tmpDir);
  envRestore = {};
  for (const k of ENV_KEYS) {
    envRestore[k] = process.env[k];
    delete process.env[k];
  }
  resetNeuralRouter();
});

afterEach(() => {
  process.chdir(cwdRestore);
  rmSync(tmpDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (envRestore[k] === undefined) delete process.env[k];
    else process.env[k] = envRestore[k];
  }
  resetNeuralRouter();
});

function trajectoryRows(): Array<Record<string, unknown>> {
  const p = join(tmpDir, TRAJECTORY_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('#2334 P1 — default behavior unchanged (gates off)', () => {
  it("reports routedBy: 'heuristic' with no env gates set", async () => {
    const router = new ModelRouter();
    const result = await router.route('fix a typo in the readme');
    expect(result.routedBy).toBe('heuristic');
    expect(['haiku', 'sonnet', 'opus']).toContain(result.model);
  });

  it('writes no trajectory sidecar when the flag is off', async () => {
    const router = new ModelRouter();
    await router.route('implement a small feature');
    router.recordOutcome('implement a small feature', 'haiku', 'success');
    expect(existsSync(join(tmpDir, TRAJECTORY_FILE))).toBe(false);
  });

  it("does not append '| RoutedBy:' to reasoning on the default path", async () => {
    const router = new ModelRouter();
    const result = await router.route('rename a variable');
    expect(result.reasoning).not.toContain('RoutedBy:');
  });
});

describe('#2334 P1 — the embedding seam is live end-to-end', () => {
  it('embedding changes complexity via computeSemanticDepth (base router)', async () => {
    const router = new ModelRouter();
    const task = 'implement the feature';
    const flat = new Array(384).fill(0.001); // ~zero variance
    const spiky = Array.from({ length: 384 }, (_, i) => (i % 2 === 0 ? 0.9 : -0.9)); // high variance

    const withoutEmbedding = await router.route(task);
    const withSpiky = await router.route(task, spiky);
    const withFlat = await router.route(task, flat);

    // The embedding branch blends variance into semanticDepth — a
    // high-variance embedding must produce a different complexity than a
    // near-zero-variance one, proving the branch executed.
    expect(withSpiky.complexity).not.toBeCloseTo(withFlat.complexity, 10);
    // And high variance pushes semantic depth (and so complexity) UP
    // relative to the no-embedding baseline of the same task.
    expect(withSpiky.complexity).toBeGreaterThan(withoutEmbedding.complexity - 1e-9);
  });

  it('EnhancedModelRouter threads context.embedding to the base router', async () => {
    const enhanced = createEnhancedModelRouter({ agentBoosterEnabled: false });
    const task = 'update the helper function'; // no tier-3 keywords, no codemod intent
    const spiky = Array.from({ length: 384 }, (_, i) => (i % 2 === 0 ? 0.9 : -0.9));

    const withEmbedding = await enhanced.route(task, { embedding: spiky });
    const withoutEmbedding = await enhanced.route(task);

    // routedBy surfaces from the base router on tier-2/3 results — proves
    // the call path went through baseRouter.route (not a shortcut).
    expect(withEmbedding.routedBy).toBe('heuristic');
    expect(withoutEmbedding.routedBy).toBe('heuristic');
    // Embedding variance shifts the blended complexity.
    expect(withEmbedding.complexity).not.toBeCloseTo(withoutEmbedding.complexity!, 10);
  });
});

describe('#2334 P1 — graceful degradation (ADR-124)', () => {
  it("gate open + artifact missing → routedBy: 'bandit-fallback', no throw", async () => {
    process.env.CLAUDE_FLOW_ROUTER_NEURAL = '1';
    process.env.CLAUDE_FLOW_ROUTER_MODEL_PATH = join(tmpDir, 'does-not-exist.safetensors');
    resetNeuralRouter();

    const router = new ModelRouter();
    const embedding = new Array(384).fill(0.1);
    const result = await router.route('implement the feature', embedding);

    expect(result.routedBy).toBe('bandit-fallback');
    expect(['haiku', 'sonnet', 'opus']).toContain(result.model);
    expect(result.reasoning).toContain('RoutedBy: bandit-fallback');
  });

  it('gate open but NO embedding → stays heuristic (neural never consulted)', async () => {
    process.env.CLAUDE_FLOW_ROUTER_NEURAL = '1';
    process.env.CLAUDE_FLOW_ROUTER_MODEL_PATH = join(tmpDir, 'does-not-exist.safetensors');
    resetNeuralRouter();

    const router = new ModelRouter();
    const result = await router.route('implement the feature');
    expect(result.routedBy).toBe('heuristic');
  });
});

describe('#2334 P1 — trajectory collection (flag on)', () => {
  it('writes decision + outcome rows joined on taskHash', async () => {
    process.env.CLAUDE_FLOW_ROUTER_TRAJECTORY = '1';
    const router = new ModelRouter();
    const task = 'implement the user-profile feature with tests';
    const embedding = new Array(8).fill(0.25);

    const decision = await router.route(task, embedding);
    router.recordOutcome(task, decision.model, 'success');

    const rows = trajectoryRows();
    const decisions = rows.filter((r) => r.type === 'decision');
    const outcomes = rows.filter((r) => r.type === 'outcome');
    expect(decisions).toHaveLength(1);
    expect(outcomes).toHaveLength(1);

    const d = decisions[0] as Record<string, any>;
    const o = outcomes[0] as Record<string, any>;
    // Join key
    expect(d.taskHash).toBe(taskHash(task));
    expect(o.taskHash).toBe(d.taskHash);
    // Training features present
    expect(d.embedding).toEqual(embedding);
    expect(typeof d.complexity).toBe('number');
    expect(d.features).toMatchObject({
      lexicalComplexity: expect.any(Number),
      semanticDepth: expect.any(Number),
      taskScope: expect.any(Number),
      uncertaintyLevel: expect.any(Number),
    });
    expect(d.model).toBe(decision.model);
    expect(d.routedBy).toBe('heuristic');
    // Outcome label
    expect(o.outcome).toBe('success');
    expect(o.model).toBe(decision.model);
  });

  it('omits the embedding field when route() received none', async () => {
    process.env.CLAUDE_FLOW_ROUTER_TRAJECTORY = '1';
    const router = new ModelRouter();
    await router.route('fix the bug');
    const d = trajectoryRows().find((r) => r.type === 'decision') as Record<string, any>;
    expect(d).toBeDefined();
    expect('embedding' in d).toBe(false);
  });

  it('keeps full task text up to 500 chars (vs learningHistory 100)', async () => {
    process.env.CLAUDE_FLOW_ROUTER_TRAJECTORY = '1';
    const router = new ModelRouter();
    const longTask = 'implement '.repeat(80); // 800 chars
    await router.route(longTask);
    const d = trajectoryRows().find((r) => r.type === 'decision') as Record<string, any>;
    expect((d.task as string).length).toBe(500);
    expect(d.taskHash).toBe(taskHash(longTask)); // hash of FULL text, not truncation
  });
});
