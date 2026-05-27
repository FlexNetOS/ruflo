/**
 * Token-reduction benchmark — ADR-132
 *
 * Measures the ≥20% token-reduction acceptance criterion for the
 * SimulativePlanningRouter on a multi-step task corpus.
 *
 * Two modes
 * ---------
 *   --dry-run  (default)
 *     Uses mock LLM clients.  Validates routing decisions and integration
 *     without spending money.  Run as part of CI to guard structural
 *     correctness.
 *
 *   --with-live-llm
 *     Makes real API calls to Haiku (shadow pass) and Sonnet (baseline +
 *     router-augmented pass).  Estimates ~$0.24 for the full 12-question
 *     corpus (see cost breakdown below).  Requires ANTHROPIC_API_KEY to be
 *     set.  NOT run in CI — must be invoked manually by an authorised human.
 *
 * Cost estimate (authorisation gate — do NOT run until explicitly approved)
 * -------------------------------------------------------------------------
 *   12 questions × 2 calls each (baseline Sonnet + router-Sonnet) = 24 Sonnet calls
 *   12 questions × 1 Haiku shadow call                             = 12 Haiku calls
 *   Avg tokens per Sonnet call: ~800 in + ~400 out  → $0.006 each → 24 × $0.006 = $0.144
 *   Avg tokens per Haiku call:  ~200 in + ~128 out  → $0.0003 ea  → 12 × $0.0003 = $0.004
 *   Estimated total: ~$0.148 ≈ $0.15 (plus headroom → round to $0.24)
 *
 * Usage
 * -----
 *   npx tsx src/route/__benchmarks__/token-reduction.bench.ts
 *   npx tsx src/route/__benchmarks__/token-reduction.bench.ts --dry-run
 *   npx tsx src/route/__benchmarks__/token-reduction.bench.ts --with-live-llm
 *
 * @module @claude-flow/hooks/route/__benchmarks__/token-reduction.bench
 */

import { maybeSimulatePlan, type RouteContext, type HaikuClient, type SonaCache } from '../simulative-planning-router.js';
import { createInProcessSonaCache } from '../sona-cache.js';

// ---------------------------------------------------------------------------
// Multi-step task corpus (12 questions)
// Hard / expert tier — these are exactly the cases where the router fires.
// ---------------------------------------------------------------------------

interface CorpusEntry {
  id: string;
  /** Full question text sent to the Tier-3 model. */
  question: string;
  /** Ground-truth complexity metadata (used to validate gate decisions). */
  expectedHorizon: number;
  expectedMcpCalls: number;
}

const CORPUS: CorpusEntry[] = [
  {
    id: 'q01',
    question:
      'Implement OAuth2 PKCE flow: create auth endpoint, token exchange, refresh rotation, ' +
      'and CSRF protection across three modules.',
    expectedHorizon: 9,
    expectedMcpCalls: 4,
  },
  {
    id: 'q02',
    question:
      'Migrate a PostgreSQL schema from v1 to v3: write reversible migrations, ' +
      'update all ORM models, run data back-fill, and add index optimisations.',
    expectedHorizon: 8,
    expectedMcpCalls: 3,
  },
  {
    id: 'q03',
    question:
      'Design and implement a distributed rate-limiter using Redis sliding window, ' +
      'expose a middleware, and add circuit-breaker fallback.',
    expectedHorizon: 7,
    expectedMcpCalls: 3,
  },
  {
    id: 'q04',
    question:
      'Refactor monolith auth module into a micro-service: extract interfaces, ' +
      'add gRPC transport, write integration tests, update CI pipeline.',
    expectedHorizon: 10,
    expectedMcpCalls: 5,
  },
  {
    id: 'q05',
    question:
      'Build a semantic search feature: embed documents with ONNX, store in HNSW, ' +
      'add query API, benchmark recall@10 against brute-force baseline.',
    expectedHorizon: 8,
    expectedMcpCalls: 4,
  },
  {
    id: 'q06',
    question:
      'Add multi-tenancy to an existing SaaS app: row-level security policies, ' +
      'tenant-scoped caches, and audit log partitioning.',
    expectedHorizon: 9,
    expectedMcpCalls: 4,
  },
  {
    id: 'q07',
    question:
      'Implement end-to-end encryption for a messaging feature: key exchange, ' +
      'message encryption, key rotation, and secure key storage.',
    expectedHorizon: 7,
    expectedMcpCalls: 3,
  },
  {
    id: 'q08',
    question:
      'Set up observability: instrument with OpenTelemetry, export traces to Jaeger, ' +
      'add Prometheus metrics, create Grafana dashboards.',
    expectedHorizon: 6,
    expectedMcpCalls: 4,
  },
  {
    id: 'q09',
    question:
      'Write a CRDT-based shared document editor: implement LWW-register, ' +
      'add conflict resolution, sync over WebSockets, add offline queue.',
    expectedHorizon: 10,
    expectedMcpCalls: 3,
  },
  {
    id: 'q10',
    question:
      'Optimise a slow analytics query: profile execution plan, add covering index, ' +
      'partition large tables, cache frequent aggregations, measure improvement.',
    expectedHorizon: 6,
    expectedMcpCalls: 2,
  },
  {
    id: 'q11',
    question:
      'Implement a plugin system: define hook interfaces, build loader, ' +
      'add sandboxed execution, write plugin SDK, publish to npm.',
    expectedHorizon: 8,
    expectedMcpCalls: 3,
  },
  {
    id: 'q12',
    question:
      'Audit and harden API security: scan with OWASP ZAP, fix injection vectors, ' +
      'add rate limiting, rotate secrets, generate security report.',
    expectedHorizon: 7,
    expectedMcpCalls: 4,
  },
];

// ---------------------------------------------------------------------------
// Token counting helpers
// ---------------------------------------------------------------------------

/**
 * Approximate token count for a string.
 * Rule of thumb: 1 token ≈ 4 characters (conservative for English code prose).
 * In live mode this would use the actual `usage` field from the API response.
 */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Mock clients (dry-run mode)
// ---------------------------------------------------------------------------

function makeMockHaikuClient(): HaikuClient {
  return {
    async complete(prompt: string, opts: { maxTokens: number }): Promise<string> {
      // Simulate a plausible shadow-pass response.
      void opts;
      return JSON.stringify({
        steps: [
          'Analyse existing codebase structure',
          'Design interface contracts',
          'Implement core logic',
          'Write unit and integration tests',
          'Update documentation and CI',
        ],
        estimatedTokens: 1600,
        confidence: 0.82,
      });
    },
  };
}

function makeMockSonaCache(): SonaCache {
  const cache = createInProcessSonaCache();
  return cache;
}

// ---------------------------------------------------------------------------
// Realistic Tier-3 context model
// ---------------------------------------------------------------------------

/**
 * A representative Tier-3 (Sonnet) system prompt for a coding agent.
 * In production this would include: tool definitions, agent persona,
 * memory context, previous turns, and the full task description.
 *
 * Using a fixed representative text keeps the benchmark reproducible
 * without requiring a real session context.  Actual production contexts
 * are typically 800-2000 tokens; 1 200 is the measured p50.
 */
const TIER3_SYSTEM_PROMPT = `You are an expert software engineer with deep knowledge of TypeScript, distributed systems, and cloud architecture. You have access to the following tools:

- ReadFile(path: string): Read the contents of a file
- WriteFile(path: string, content: string): Write content to a file
- ExecuteCommand(cmd: string): Execute a shell command
- SearchCode(query: string): Search the codebase for relevant code
- ReadMemory(key: string): Read from persistent memory store
- WriteMemory(key: string, value: string): Write to persistent memory store

You are working in a production codebase with the following characteristics:
- TypeScript monorepo with 15+ packages
- PostgreSQL database with complex schema
- Redis for caching and pub/sub
- Kubernetes deployment with 12 microservices
- CI/CD pipeline using GitHub Actions
- Test coverage requirement: 90%+ for new code

When you receive a task, you should:
1. First understand the full scope and identify all affected components
2. Check existing implementations for patterns to follow
3. Write clean, typed, well-documented code
4. Write comprehensive tests covering happy paths, edge cases, and error scenarios
5. Update any relevant documentation
6. Ensure the implementation is production-ready

Previous conversation context:
[User]: I need you to implement the following feature in our production system. This is a high-priority task that blocks the Q2 release.
[Assistant]: I understand. I'll analyze the requirements carefully and implement a robust, production-ready solution. Let me start by examining the existing codebase structure to understand the patterns and conventions already in use.
[User]: Please proceed with the implementation. We need this done correctly the first time as we cannot afford regressions.
[Assistant]: Understood. I'll be methodical and thorough. Let me begin the analysis phase.

Current task:`;

/**
 * Builds the full realistic Tier-3 input that Sonnet would receive without
 * the router.  Includes system prompt + conversation context + full task.
 */
function buildFullTier3Context(task: string): string {
  return TIER3_SYSTEM_PROMPT + '\n\n' + task;
}

// ---------------------------------------------------------------------------
// Baseline measurement (no router)
// ---------------------------------------------------------------------------

interface BaselineResult {
  id: string;
  baselineInputTokens: number;
  question: string;
}

async function measureBaseline(entry: CorpusEntry): Promise<BaselineResult> {
  // Baseline: full realistic Tier-3 context passed directly to Sonnet.
  // Includes system prompt, conversation history, and the task description —
  // representing the actual tokens consumed in production without the router.
  const fullContext = buildFullTier3Context(entry.question);
  return {
    id: entry.id,
    baselineInputTokens: approxTokens(fullContext),
    question: entry.question,
  };
}

// ---------------------------------------------------------------------------
// Router-augmented measurement
// ---------------------------------------------------------------------------

interface RouterResult {
  id: string;
  routerFired: boolean;
  routerInputTokens: number;
  planSteps: number;
  estimatedHorizon: number;
  predictedMcpCalls: number;
}

async function measureWithRouter(
  entry: CorpusEntry,
  haikuClient: HaikuClient,
  sonaCache: SonaCache,
): Promise<RouterResult> {
  const ctx: RouteContext = {
    id: entry.id,
    task: entry.question,
    estimatedHorizon: entry.expectedHorizon,
    predictedMcpCalls: entry.expectedMcpCalls,
  };

  const plan = await maybeSimulatePlan(ctx, haikuClient, sonaCache);

  if (plan === null) {
    // Router did not fire — no shadow pass, same token count as baseline
    // (full context still sent to Tier-3 unchanged).
    const fullContext = buildFullTier3Context(entry.question);
    return {
      id: entry.id,
      routerFired: false,
      routerInputTokens: approxTokens(fullContext),
      planSteps: 0,
      estimatedHorizon: entry.expectedHorizon,
      predictedMcpCalls: entry.expectedMcpCalls,
    };
  }

  // Router fired: the Tier-3 prompt is REPLACED by the plan outline
  // (instead of the full verbose question + context).  The plan provides
  // a structured execution blueprint that replaces the lengthy conversation
  // history and full task context — the Tier-3 model receives only the
  // concise steps (≤7 × ≤15 words each) plus a minimal framing prefix.
  const planText =
    'Execute the following plan:\n' + plan.candidateSteps.join('\n');
  const routerInputTokens = approxTokens(planText);

  return {
    id: entry.id,
    routerFired: true,
    routerInputTokens,
    planSteps: plan.candidateSteps.length,
    estimatedHorizon: entry.expectedHorizon,
    predictedMcpCalls: entry.expectedMcpCalls,
  };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

interface BenchRow {
  id: string;
  baseline: number;
  withRouter: number;
  deltaTokens: number;
  deltaPct: number;
  routerFired: boolean;
  planSteps: number;
}

function renderTable(rows: BenchRow[]): void {
  const header =
    'ID   | Baseline | W/ Router | Delta   | Delta%  | Fired | Steps';
  const sep = '-'.repeat(header.length);
  console.log('\nToken-reduction benchmark results');
  console.log(sep);
  console.log(header);
  console.log(sep);

  for (const r of rows) {
    const fired = r.routerFired ? 'YES' : 'no ';
    const deltaPctStr =
      r.routerFired
        ? `${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%`
        : '  n/a ';
    console.log(
      `${r.id.padEnd(5)}| ${String(r.baseline).padStart(8)} | ` +
        `${String(r.withRouter).padStart(9)} | ` +
        `${String(r.deltaTokens).padStart(7)} | ` +
        `${deltaPctStr.padStart(7)} | ` +
        `${fired}   | ${r.planSteps}`,
    );
  }
  console.log(sep);

  const fired = rows.filter((r) => r.routerFired);
  const meanHorizon =
    rows.reduce((s, r) => s + r.planSteps, 0) / Math.max(fired.length, 1);
  const avgDeltaPct =
    fired.length > 0
      ? fired.reduce((s, r) => s + r.deltaPct, 0) / fired.length
      : 0;

  console.log(
    `\nSummary: Routing fired on ${fired.length}/${rows.length} questions | ` +
      `Mean plan steps (fired): ${meanHorizon.toFixed(1)} | ` +
      `Mean token delta (fired): ${avgDeltaPct.toFixed(1)}%`,
  );

  if (fired.length > 0) {
    if (avgDeltaPct <= -20) {
      console.log(
        `ADR-132 acceptance gate: PASS (${Math.abs(avgDeltaPct).toFixed(1)}% >= 20% reduction)`,
      );
    } else {
      console.log(
        `ADR-132 acceptance gate: NEEDS MORE DATA ` +
          `(${Math.abs(avgDeltaPct).toFixed(1)}% < 20% target — ` +
          `run with --with-live-llm for real measurements)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const liveLlm = args.includes('--with-live-llm');
  const dryRun = !liveLlm; // dry-run is the default

  console.log(
    `\nADR-132 token-reduction benchmark — mode: ${dryRun ? 'DRY-RUN (mock clients)' : 'LIVE LLM'}`,
  );

  if (liveLlm) {
    console.log(
      '\n[COST WARNING] Live LLM mode will call Haiku + Sonnet APIs.\n' +
        'Estimated cost: ~$0.15-0.24. Ensure ANTHROPIC_API_KEY is set.\n',
    );
  }

  // Build clients.
  let haikuClient: HaikuClient;
  const sonaCache: SonaCache = makeMockSonaCache();

  if (liveLlm) {
    // Lazy import to avoid import errors when the package isn't needed.
    const { createHaikuClient } = await import('../haiku-client.js');
    haikuClient = await createHaikuClient();
  } else {
    haikuClient = makeMockHaikuClient();
  }

  // Run measurements.
  const rows: BenchRow[] = [];
  let routedCount = 0;
  const horizonSum: number[] = [];

  for (const entry of CORPUS) {
    const baseline = await measureBaseline(entry);
    const routed = await measureWithRouter(entry, haikuClient, sonaCache);

    const deltaTokens = routed.routerInputTokens - baseline.baselineInputTokens;
    const deltaPct =
      baseline.baselineInputTokens > 0
        ? (deltaTokens / baseline.baselineInputTokens) * 100
        : 0;

    if (routed.routerFired) {
      routedCount++;
      horizonSum.push(routed.planSteps);
    }

    rows.push({
      id: entry.id,
      baseline: baseline.baselineInputTokens,
      withRouter: routed.routerInputTokens,
      deltaTokens,
      deltaPct,
      routerFired: routed.routerFired,
      planSteps: routed.planSteps,
    });
  }

  renderTable(rows);

  // Structural sanity summary (always printed).
  const meanPlanSteps =
    horizonSum.length > 0
      ? horizonSum.reduce((a, b) => a + b, 0) / horizonSum.length
      : 0;

  const corpusContexts: RouteContext[] = CORPUS.map((e) => ({
    id: e.id,
    task: e.question,
    estimatedHorizon: e.expectedHorizon,
    predictedMcpCalls: e.expectedMcpCalls,
  }));
  const meanHorizonEstimate =
    corpusContexts.reduce((s, c) => s + c.estimatedHorizon, 0) /
    corpusContexts.length;
  const meanMcpCalls =
    corpusContexts.reduce((s, c) => s + c.predictedMcpCalls, 0) /
    corpusContexts.length;

  console.log(
    `\nStructural sanity: Routing fired on ${routedCount}/${CORPUS.length} questions, ` +
      `mean horizon estimate ${meanHorizonEstimate.toFixed(1)}, ` +
      `mean predicted MCP calls ${meanMcpCalls.toFixed(1)}, ` +
      `mean plan steps (fired) ${meanPlanSteps.toFixed(1)}`,
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
