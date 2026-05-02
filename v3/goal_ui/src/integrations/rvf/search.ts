/**
 * In-memory cosine similarity search for RVF browser entries.
 *
 * For the goal_ui scale (≤10K entries per user) a linear scan is
 * faster than HNSW because of the constant-factor overhead of HNSW
 * construction in WASM. If profiling later shows this matters, swap
 * the search call out for ruvector's HNSW (issue: ADR-093 follow-up).
 *
 * All vectors are assumed L2-normalized at insert time, so cosine
 * similarity collapses to a dot product.
 */

import type { RvfEntry } from './format';

export interface SearchHit {
  entry: RvfEntry;
  /** Cosine similarity in [-1, 1]. Higher = more similar. */
  score: number;
}

export interface SearchOptions {
  /** Top-k to return (default 10). */
  k?: number;
  /** Minimum score threshold. Default 0 (no filter). */
  minScore?: number;
  /** Optional filter on namespace. */
  namespace?: string;
  /** Optional metadata predicate. */
  filter?: (entry: RvfEntry) => boolean;
}

/**
 * L2-normalize an embedding in place. Returns the same array.
 * Required for cosine = dot product equivalence.
 */
export function normalizeL2(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  if (norm === 0) return v;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) v[i] *= inv;
  return v;
}

/** Dot product. Vectors must be the same length. */
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  // Vectors should be equal length; loop bound is the min for safety.
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * Search a flat array of entries for the top-k most similar to `query`.
 * Linear scan; O(N * dim) per call. At 10K entries × 384 dim ≈ 4ms in
 * pure JS — still well under the 200ms p95 target in ADR-088.
 */
export function searchByVector(
  entries: RvfEntry[],
  query: Float32Array,
  opts: SearchOptions = {},
): SearchHit[] {
  const k = opts.k ?? 10;
  const minScore = opts.minScore ?? -Infinity;
  const ns = opts.namespace;
  const userFilter = opts.filter;

  const hits: SearchHit[] = [];
  for (const e of entries) {
    if (!e.vector) continue;
    if (ns !== undefined && e.namespace !== ns) continue;
    if (userFilter && !userFilter(e)) continue;
    if (e.vector.length !== query.length) continue;

    const score = dot(e.vector, query);
    if (score < minScore) continue;
    hits.push({ entry: e, score });
  }

  // Partial sort would beat full sort for very large N; not worth the
  // complexity at this scale. Keep it simple.
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}
