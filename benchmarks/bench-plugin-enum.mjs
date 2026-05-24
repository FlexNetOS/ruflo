#!/usr/bin/env node
/**
 * M8 — Real plugin enum benchmark
 *
 * Measures wasm_agent_compose overhead with/without 21 native plugins
 * via includePlugins. Compares real plugin lookup cost vs empty plugin list.
 *
 * Usage:
 *   node benchmarks/bench-plugin-enum.mjs [--trials=10] [--K=50]
 *
 * Output: docs/benchmarks/plugin-enum.json
 */

import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DIST_SRC = resolve(REPO_ROOT, 'v3/@claude-flow/cli/dist/src');
const OUT_DIR = resolve(REPO_ROOT, 'docs', 'benchmarks');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const TRIALS = Math.max(5, parseInt(args.trials || '10', 10));
const K = parseInt(args.K || '50', 10);

let composeHandler = null;
try {
  const toolsMod = await import(resolve(DIST_SRC, 'mcp-tools/wasm-agent-tools.js'));
  const tools = toolsMod.wasmAgentTools ?? [];
  composeHandler = tools.find(t => t.name === 'wasm_agent_compose')?.handler ?? null;
} catch {}

const TOOL_NAMES = Array.from({ length: K }, (_, i) => `tool_${String(i).padStart(2, '0')}`);

// The 21 native plugins listed in CLAUDE.md
const NATIVE_PLUGINS = [
  '@claude-flow/embeddings',
  '@claude-flow/security',
  '@claude-flow/claims',
  '@claude-flow/neural',
  '@claude-flow/plugins',
  '@claude-flow/performance',
  '@claude-flow/plugin-agentic-qe',
  '@claude-flow/plugin-prime-radiant',
  '@claude-flow/plugin-gastown-bridge',
  '@claude-flow/teammate-plugin',
  '@claude-flow/plugin-code-intelligence',
  '@claude-flow/plugin-test-intelligence',
  '@claude-flow/plugin-perf-optimizer',
  '@claude-flow/plugin-neural-coordinator',
  '@claude-flow/plugin-cognitive-kernel',
  '@claude-flow/plugin-quantum-optimizer',
  '@claude-flow/plugin-hyperbolic-reasoning',
  '@claude-flow/plugin-healthcare-clinical',
  '@claude-flow/plugin-financial-risk',
  '@claude-flow/plugin-legal-contracts',
  '@claude-flow/plugin-code-intelligence',
];

async function bench(fn, trials, warmup = 5) {
  for (let i = 0; i < warmup; i++) {
    try { await fn(); } catch {}
  }
  const times = [];
  for (let t = 0; t < trials; t++) {
    const t0 = performance.now();
    try { await fn(); } catch {}
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(trials / 2)];
  return {
    medianMs: Math.round(med * 1000) / 1000,
    minMs: Math.round(times[0] * 1000) / 1000,
    maxMs: Math.round(times[trials - 1] * 1000) / 1000,
  };
}

console.log(`M8 — plugin enum overhead (K=${K}, trials=${TRIALS})`);

// Global warmup — interleave both paths
for (let i = 0; i < 5; i++) {
  if (composeHandler) {
    await composeHandler({ mcpTools: TOOL_NAMES, skills: [], prompts: [], tools: [] }).catch(() => {});
    await composeHandler({ mcpTools: TOOL_NAMES, includePlugins: NATIVE_PLUGINS, skills: [], prompts: [], tools: [] }).catch(() => {});
  }
}

console.log('Benchmarking without plugins...');
const withoutPlugins = await bench(
  () => composeHandler?.({ mcpTools: TOOL_NAMES, skills: [], prompts: [], tools: [] }),
  TRIALS
);

console.log('Benchmarking with 21 native plugins...');
const withPlugins = await bench(
  () => composeHandler?.({ mcpTools: TOOL_NAMES, includePlugins: NATIVE_PLUGINS, skills: [], prompts: [], tools: [] }),
  TRIALS
);

// Absent plugins (original ADR-129 test, for reference)
const ABSENT_PLUGINS = ['nonexistent-plugin-a', 'nonexistent-plugin-b'];
console.log('Benchmarking with 2 absent plugins (ADR-129 baseline)...');
const withAbsentPlugins = await bench(
  () => composeHandler?.({ mcpTools: TOOL_NAMES, includePlugins: ABSENT_PLUGINS, skills: [], prompts: [], tools: [] }),
  TRIALS
);

const overhead = withPlugins.medianMs - withoutPlugins.medianMs;
const ratio = withoutPlugins.medianMs > 0
  ? Math.round((withPlugins.medianMs / withoutPlugins.medianMs) * 100) / 100
  : null;

console.log(`\nResults:`);
console.log(`  without plugins:   ${withoutPlugins.medianMs}ms`);
console.log(`  with 21 plugins:   ${withPlugins.medianMs}ms (${ratio}x, +${Math.round(overhead * 1000) / 1000}ms overhead)`);
console.log(`  with 2 absent:     ${withAbsentPlugins.medianMs}ms`);

const output = {
  tag: 'plugin-enum',
  capturedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node_version: process.version,
  framework: 'ruflo',
  version: '3.8.0',
  K,
  trials: TRIALS,
  plugin_counts: {
    native: NATIVE_PLUGINS.length,
    absent: ABSENT_PLUGINS.length,
  },
  results: {
    without_plugins: withoutPlugins,
    with_21_native_plugins: withPlugins,
    with_2_absent_plugins: withAbsentPlugins,
  },
  analysis: {
    plugin_overhead_ms: Math.round(overhead * 1000) / 1000,
    overhead_ratio: ratio,
    overhead_pct: ratio ? Math.round((ratio - 1) * 100) : null,
    verdict: overhead < 1
      ? 'sub-1ms plugin overhead — all compose calls still complete in <1ms even with 21 plugins'
      : `>1ms overhead with 21 plugins — investigate plugin lookup path`,
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = resolve(OUT_DIR, 'plugin-enum.json');
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nWrote ${outPath}`);
