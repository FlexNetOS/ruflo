/**
 * Router trajectory collection (#2334 Phase 1)
 *
 * Opt-in per-decision dataset collection for the model router. The persisted
 * bandit state (`.swarm/model-router-state.json`) keeps only aggregates —
 * 9 Beta(α,β) cells and a capped/truncated history — which is not trainable
 * material for the Phase 2 FastGRNN tier-classifier. This sidecar captures
 * the per-example rows that training needs:
 *
 *   decision rows: { taskHash, task, embedding?, complexity, features,
 *                    model, confidence, uncertainty, routedBy, ts }
 *   outcome rows:  { taskHash, model, outcome, ts }
 *
 * joined offline on `taskHash` (sha256-16 of the task text).
 *
 * OFF by default. Enable with CLAUDE_FLOW_ROUTER_TRAJECTORY=1. Rows append to
 * `.swarm/model-router-trajectories.jsonl` — local-only, same trust domain as
 * the existing state file, but unlike it the rows contain full task text (up
 * to 500 chars) and raw embeddings, which is why this is opt-in rather than
 * always-on.
 *
 * Writes are best-effort: any fs error is swallowed (collection must never
 * break routing), matching the state-file behavior in model-router.ts.
 *
 * @module router-trajectory
 */

import { createHash } from 'crypto';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

export const TRAJECTORY_FILE = '.swarm/model-router-trajectories.jsonl';

/** Schema version stamped on every row so offline training can dispatch. */
const ROW_VERSION = 1;

export function trajectoryCollectionEnabled(): boolean {
  return process.env.CLAUDE_FLOW_ROUTER_TRAJECTORY === '1';
}

/** Join key: first 16 hex chars of sha256(task). */
export function taskHash(task: string): string {
  return createHash('sha256').update(task).digest('hex').slice(0, 16);
}

export interface TrajectoryDecisionRow {
  v: number;
  type: 'decision';
  ts: string;
  taskHash: string;
  /** Task text, capped at 500 chars (cf. learningHistory's 100). */
  task: string;
  /** Raw embedding when one was threaded through route(); else omitted. */
  embedding?: number[];
  complexity: number;
  features: {
    lexicalComplexity: number;
    semanticDepth: number;
    taskScope: number;
    uncertaintyLevel: number;
  };
  model: string;
  confidence: number;
  uncertainty: number;
  routedBy: string;
}

export interface TrajectoryOutcomeRow {
  v: number;
  type: 'outcome';
  ts: string;
  taskHash: string;
  model: string;
  outcome: 'success' | 'failure' | 'escalated';
}

function appendRow(row: TrajectoryDecisionRow | TrajectoryOutcomeRow): void {
  try {
    const fullPath = join(process.cwd(), TRAJECTORY_FILE);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(fullPath, JSON.stringify(row) + '\n');
  } catch {
    // Best-effort: collection must never break routing.
  }
}

export function recordTrajectoryDecision(
  task: string,
  embedding: number[] | undefined,
  complexity: TrajectoryDecisionRow['features'] & { score: number },
  decision: { model: string; confidence: number; uncertainty: number; routedBy: string },
): void {
  if (!trajectoryCollectionEnabled()) return;
  appendRow({
    v: ROW_VERSION,
    type: 'decision',
    ts: new Date().toISOString(),
    taskHash: taskHash(task),
    task: task.slice(0, 500),
    ...(embedding && embedding.length > 0 ? { embedding } : {}),
    complexity: complexity.score,
    features: {
      lexicalComplexity: complexity.lexicalComplexity,
      semanticDepth: complexity.semanticDepth,
      taskScope: complexity.taskScope,
      uncertaintyLevel: complexity.uncertaintyLevel,
    },
    model: decision.model,
    confidence: decision.confidence,
    uncertainty: decision.uncertainty,
    routedBy: decision.routedBy,
  });
}

export function recordTrajectoryOutcome(
  task: string,
  model: string,
  outcome: 'success' | 'failure' | 'escalated',
): void {
  if (!trajectoryCollectionEnabled()) return;
  appendRow({
    v: ROW_VERSION,
    type: 'outcome',
    ts: new Date().toISOString(),
    taskHash: taskHash(task),
    model,
    outcome,
  });
}
