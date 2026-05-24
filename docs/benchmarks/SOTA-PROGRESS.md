# SOTA Comparator Progress

## Current Milestone: M6+M7+M8 Complete (M1-M3 + M6+M7+M8 shipped)

**Branch:** `perf/sota-comparator-benchmarks`
**Last updated:** 2026-05-24

---

## What Landed

### M1 — Workload Spec
- `docs/benchmarks/sota-workload-spec.md` — pinned N=10, K=50, T=5, TRIALS=7, WARMUP=3
- Two modes: Mode A (orchestration-only, stub LLM) and Mode B (end-to-end, real model)
- Single-command repro: `node benchmarks/run-sota-matrix.mjs`

### M2 — Comparators Selected
Three frameworks: LangGraph 1.2.1, AutoGen 0.4.9, CrewAI 0.80.0

### M3 — First Verified Matrix (darwin-arm64)
- All harnesses verified; WASM path confirmed active
- Fixed silent path resolution bug that was measuring no-ops
- Results: `docs/benchmarks/sota-matrix.json` (`"status": "verified-real-numbers"`)

### M4 partial — CI Workflow
- `.github/workflows/sota-bench.yml` — matrix on ubuntu-latest + macos-latest
- Linux numbers will appear on PR CI run

### M6 — Concurrency Scale (N=1/10/50/100)
- `benchmarks/bench-concurrency-scale.mjs`
- Results: `docs/benchmarks/concurrency-scale.json`

### M7 — v3.7.0 → v3.8.0 Delta
- `benchmarks/bench-version-delta.mjs`
- Results: `docs/benchmarks/version-delta.json`

### M8 — Real Plugin Enum (21 native plugins)
- `benchmarks/bench-plugin-enum.mjs`
- Results: `docs/benchmarks/plugin-enum.json`

---

## Current Matrix Results (darwin-arm64, 2026-05-24, verified)

N=10 agents, K=50 tools, T=5 turns, 7 trials (stub LLM Mode A)

| Dimension | ruflo | AutoGen 0.4.9 | LangGraph 1.2.1 | CrewAI 0.80.0 |
|-----------|-------|---------------|-----------------|----------------|
| Cold start (ms) | **3.44** | 186.4 | 508.1 | 2239.7 |
| Compose 50 tools (ms) | 0.294 | 6.52 | 34.8 | 0.115† |
| Single turn dispatch (ms) | **0.023** | 6.73 | 36.4 | 0.113† |
| N=10 parallel wall (ms) | 1.16 | 64.2 | 394.9 | 0.114† |
| RSS peak (MB) | **58.9** | 78.5 | 80.5 | 264.1 |

†CrewAI = proxied instantiation (lower bound, labeled in JSON)

**ruflo wins:** cold start (54x vs AutoGen), single-turn (293x vs AutoGen), RSS (25% less)

---

## M6 — Concurrency Scale Results

N=100 peak: **421,000 tool dispatches/second**, **86,576 WASM agent create/terminate/second**

| N | compose wall (ms) | agents/s | tool_dispatches/s | wasm wall (ms) | wasm agents/s |
|---|-------------------|----------|-------------------|----------------|---------------|
| 1 | 0.383 | 2,613 | 130,648 | 0.033 | 30,227 |
| 10 | 1.307 | 7,650 | 382,483 | 0.105 | 95,276 |
| 50 | 6.241 | 8,012 | 400,577 | 0.473 | 105,634 |
| 100 | 11.875 | 8,421 | **421,069** | 1.155 | 86,577 |

---

## M7 — v3.7.0 vs v3.8.0 Delta

| Dimension | v3.7.0 | v3.8.0 | Speedup |
|-----------|--------|--------|---------|
| createWasmAgent | 0.033ms | 0.018ms | **1.83x faster** |
| compose_50_tools | N/A (not in v3.7) | 0.344ms | New in v3.8 |

`wasm_agent_compose` did not exist in v3.7.0 — it's a net-new capability in ADR-129.

---

## M8 — Plugin Enum (21 native plugins)

| Mode | compose median (ms) | Notes |
|------|---------------------|-------|
| Without plugins | 0.132 | baseline |
| With 21 native plugins | 0.328 | +0.196ms overhead (2.48x) |
| With 2 absent plugins | 0.140 | graceful no-op path |

All compose calls complete in under 1ms even with all 21 plugins. Sub-millisecond overhead.

---

## What's Still Pending

- **M4 complete:** Linux numbers pending PR CI (workflow stub pushed)
- **M5 (end-to-end real model):** Mode B — requires ANTHROPIC_API_KEY, ~$0.10 budget
- **M9 (publish gist + release notes):** Scheduled after M4 Linux numbers in
- **M10 (speedups):** compose_50_tools is 2.56x slower than CrewAI's proxy lower bound. Real comparison pending Mode A dispatch support from CrewAI side.

---

## Test Baseline
Pre-existing: 2293 passing / 449 failing (failing tests are in worktrees + other pre-existing issues, not caused by this branch). Our changes add zero test files.
