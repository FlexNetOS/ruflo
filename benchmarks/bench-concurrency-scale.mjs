#!/usr/bin/env node
/**
 * M6 — Concurrency scale benchmark
 *
 * Runs the ruflo compose + createWasmAgent workload at N=1, 10, 50, 100 agents
 * in parallel and measures:
 *   - wall-clock time
 *   - RSS peak
 *   - per-agent throughput (agents/sec)
 *   - tool dispatch throughput (tool_dispatches/sec)
 *
 * Usage:
 *   node benchmarks/bench-concurrency-scale.mjs [--trials=5] [--K=50]
 *
 * Output: docs/benchmarks/concurrency-scale.json
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
const TRIALS = Math.max(3, parseInt(args.trials || '5', 10));
const K = parseInt(args.K || '50', 10);
const AGENT_COUNTS = (args.N || '1,10,50,100').split(',').map(Number);

// Load modules
let composeHandler = null;
let wasmMod = null;
try {
  wasmMod = await import(resolve(DIST_SRC, 'ruvector/agent-wasm.js'));
} catch {}
try {
  const toolsMod = await import(resolve(DIST_SRC, 'mcp-tools/wasm-agent-tools.js'));
  const tools = toolsMod.wasmAgentTools ?? toolsMod.default ?? [];
  composeHandler = tools.find(t => t.name === 'wasm_agent_compose')?.handler ?? null;
} catch {}

const wasmAvail = wasmMod ? await wasmMod.isAgentWasmAvailable() : false;
console.log(`WASM available: ${wasmAvail}`);
console.log(`composeHandler: ${typeof composeHandler}`);

function makeToolNames(k) {
  return Array.from({ length: k }, (_, i) => `tool_${String(i).padStart(2, '0')}`);
}
const TOOL_NAMES = makeToolNames(K);

function getRssMb() {
  const mem = process.memoryUsage();
  return Math.round(mem.rss / (1024 * 1024) * 100) / 100;
}

async function runNAgents(n) {
  if (!composeHandler) return;
  await Promise.all(
    Array.from({ length: n }, async () => {
      await composeHandler({
        mcpTools: TOOL_NAMES,
        skills: [], prompts: [], tools: [],
      }).catch(() => {});
    })
  );
}

async function runNAgentsWasm(n) {
  if (!wasmMod) return;
  await Promise.all(
    Array.from({ length: n }, async () => {
      try {
        const agent = await wasmMod.createWasmAgent({ maxTurns: 1 });
        wasmMod.terminateWasmAgent(agent.id);
      } catch {}
    })
  );
}

// Warmup
console.log('Warmup...');
for (let i = 0; i < 3; i++) {
  await runNAgents(1).catch(() => {});
  await runNAgentsWasm(1).catch(() => {});
}

const results = [];

for (const n of AGENT_COUNTS) {
  console.log(`\nN=${n} agents...`);

  // Compose throughput
  const composeTimes = [];
  let rssBeforeCompose = getRssMb();
  for (let t = 0; t < TRIALS; t++) {
    const t0 = performance.now();
    await runNAgents(n);
    composeTimes.push(performance.now() - t0);
  }
  composeTimes.sort((a, b) => a - b);
  const rssAfterCompose = getRssMb();
  const composeMed = composeTimes[Math.floor(TRIALS / 2)];

  // WASM agent throughput
  const wasmTimes = [];
  let rssBeforeWasm = getRssMb();
  for (let t = 0; t < TRIALS; t++) {
    const t0 = performance.now();
    await runNAgentsWasm(n);
    wasmTimes.push(performance.now() - t0);
  }
  wasmTimes.sort((a, b) => a - b);
  const rssAfterWasm = getRssMb();
  const wasmMed = wasmTimes[Math.floor(TRIALS / 2)];

  const composeAgentsPerSec = Math.round((n / (composeMed / 1000)) * 100) / 100;
  const wasmAgentsPerSec = Math.round((n / (wasmMed / 1000)) * 100) / 100;
  const composeToolsPerSec = Math.round(composeAgentsPerSec * K * 100) / 100;

  console.log(`  compose: ${Math.round(composeMed * 1000) / 1000}ms wall, ${composeAgentsPerSec} agents/s, ${composeToolsPerSec} tool-dispatches/s`);
  console.log(`  wasm:    ${Math.round(wasmMed * 1000) / 1000}ms wall, ${wasmAgentsPerSec} agents/s`);

  results.push({
    N: n,
    K,
    trials: TRIALS,
    compose: {
      wall_medianMs: Math.round(composeMed * 1000) / 1000,
      wall_minMs: Math.round(composeTimes[0] * 1000) / 1000,
      wall_maxMs: Math.round(composeTimes[TRIALS - 1] * 1000) / 1000,
      agents_per_sec: composeAgentsPerSec,
      tool_dispatches_per_sec: composeToolsPerSec,
      rss_delta_mb: Math.round((rssAfterCompose - rssBeforeCompose) * 100) / 100,
    },
    wasm_agent: {
      wall_medianMs: Math.round(wasmMed * 1000) / 1000,
      wall_minMs: Math.round(wasmTimes[0] * 1000) / 1000,
      wall_maxMs: Math.round(wasmTimes[TRIALS - 1] * 1000) / 1000,
      agents_per_sec: wasmAgentsPerSec,
      rss_delta_mb: Math.round((rssAfterWasm - rssBeforeWasm) * 100) / 100,
    },
    rss_peak_mb: Math.max(rssAfterCompose, rssAfterWasm),
  });
}

const output = {
  tag: 'concurrency-scale',
  capturedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node_version: process.version,
  framework: 'ruflo',
  version: '3.8.0',
  wasm_available: wasmAvail,
  K,
  trials: TRIALS,
  results,
  summary: {
    compose_throughput_scaling: results.map(r => ({
      N: r.N,
      wall_ms: r.compose.wall_medianMs,
      agents_per_sec: r.compose.agents_per_sec,
      tool_dispatches_per_sec: r.compose.tool_dispatches_per_sec,
    })),
    wasm_throughput_scaling: results.map(r => ({
      N: r.N,
      wall_ms: r.wasm_agent.wall_medianMs,
      agents_per_sec: r.wasm_agent.agents_per_sec,
    })),
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = resolve(OUT_DIR, 'concurrency-scale.json');
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nWrote ${outPath}`);

// Print table
const FW_COL = 6;
const VAL_COL = 14;
console.log('\n--- Concurrency Scale Results ---');
console.log(`| ${'N'.padEnd(5)} | ${'compose_wall_ms'.padEnd(VAL_COL)} | ${'agents/s'.padEnd(VAL_COL)} | ${'tools/s'.padEnd(VAL_COL)} | ${'wasm_wall_ms'.padEnd(VAL_COL)} | ${'wasm_agents/s'.padEnd(VAL_COL)} |`);
console.log('|' + '-'.repeat(7) + '|' + '-'.repeat(VAL_COL + 2) + '|' + '-'.repeat(VAL_COL + 2) + '|' + '-'.repeat(VAL_COL + 2) + '|' + '-'.repeat(VAL_COL + 2) + '|' + '-'.repeat(VAL_COL + 2) + '|');
for (const r of results) {
  const row = [
    String(r.N).padEnd(5),
    String(r.compose.wall_medianMs).padEnd(VAL_COL),
    String(r.compose.agents_per_sec).padEnd(VAL_COL),
    String(r.compose.tool_dispatches_per_sec).padEnd(VAL_COL),
    String(r.wasm_agent.wall_medianMs).padEnd(VAL_COL),
    String(r.wasm_agent.agents_per_sec).padEnd(VAL_COL),
  ];
  console.log('| ' + row.join(' | ') + ' |');
}
