#!/usr/bin/env node
/**
 * M7 — v3.7.0 vs v3.8.0 delta benchmark
 *
 * Installs ruflo@3.7.0 in a temp sandbox, runs the same Mode A workload
 * against both versions, and computes speedup ratios.
 *
 * Usage:
 *   node benchmarks/bench-version-delta.mjs [--trials=5] [--K=50]
 *
 * Requires: npm / npx available. Takes ~2 min for install.
 * Output: docs/benchmarks/version-delta.json
 */

import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(REPO_ROOT, 'docs', 'benchmarks');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const TRIALS = Math.max(3, parseInt(args.trials || '5', 10));
const K = parseInt(args.K || '50', 10);

// ---------------------------------------------------------------------------
// V3.8 measurement (current dist build)
// ---------------------------------------------------------------------------
async function measureV38() {
  const DIST_SRC = resolve(REPO_ROOT, 'v3/@claude-flow/cli/dist/src');
  let composeHandler = null;
  let wasmMod = null;
  try {
    wasmMod = await import(resolve(DIST_SRC, 'ruvector/agent-wasm.js'));
  } catch {}
  try {
    const toolsMod = await import(resolve(DIST_SRC, 'mcp-tools/wasm-agent-tools.js'));
    const tools = toolsMod.wasmAgentTools ?? [];
    composeHandler = tools.find(t => t.name === 'wasm_agent_compose')?.handler ?? null;
  } catch {}

  const toolNames = Array.from({ length: K }, (_, i) => `tool_${String(i).padStart(2, '0')}`);
  return { composeHandler, wasmMod, toolNames };
}

// ---------------------------------------------------------------------------
// Time a compose operation
// ---------------------------------------------------------------------------
async function benchCompose(composeHandler, toolNames, trials, warmup = 3) {
  if (!composeHandler) return null;
  for (let i = 0; i < warmup; i++) {
    try { await composeHandler({ mcpTools: toolNames, skills: [], prompts: [], tools: [] }); } catch {}
  }
  const times = [];
  for (let t = 0; t < trials; t++) {
    const t0 = performance.now();
    try { await composeHandler({ mcpTools: toolNames, skills: [], prompts: [], tools: [] }); } catch {}
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    medianMs: Math.round(times[Math.floor(trials / 2)] * 1000) / 1000,
    minMs: Math.round(times[0] * 1000) / 1000,
    maxMs: Math.round(times[trials - 1] * 1000) / 1000,
  };
}

async function benchCreateAgent(wasmMod, trials, warmup = 3) {
  if (!wasmMod) return null;
  for (let i = 0; i < warmup; i++) {
    try {
      const a = await wasmMod.createWasmAgent({ maxTurns: 1 });
      wasmMod.terminateWasmAgent(a.id);
    } catch {}
  }
  const times = [];
  for (let t = 0; t < trials; t++) {
    const t0 = performance.now();
    try {
      const a = await wasmMod.createWasmAgent({ maxTurns: 1 });
      wasmMod.terminateWasmAgent(a.id);
    } catch {}
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    medianMs: Math.round(times[Math.floor(trials / 2)] * 1000) / 1000,
    minMs: Math.round(times[0] * 1000) / 1000,
    maxMs: Math.round(times[trials - 1] * 1000) / 1000,
  };
}

// ---------------------------------------------------------------------------
// V3.7 measurement via npx-installed package in sandbox
// ---------------------------------------------------------------------------
async function measureV37() {
  const sandboxDir = join(tmpdir(), `ruflo-bench-v37-${Date.now()}`);
  mkdirSync(sandboxDir, { recursive: true });

  console.log(`Installing ruflo@3.7.0 in ${sandboxDir}...`);

  // Write minimal package.json
  writeFileSync(join(sandboxDir, 'package.json'), JSON.stringify({
    name: 'bench-v37-sandbox',
    version: '1.0.0',
    type: 'module',
  }, null, 2));

  // npm install ruflo@3.7.0 (this pulls @claude-flow/cli@3.7.0 as a dep)
  const installResult = spawnSync(
    'npm', ['install', '--save', 'ruflo@3.7.0', '@claude-flow/cli@3.7.0', '--loglevel=error'],
    {
      cwd: sandboxDir,
      encoding: 'utf8',
      timeout: 120_000,
    }
  );

  if (installResult.status !== 0) {
    console.warn(`[warn] Failed to install ruflo@3.7.0: ${installResult.stderr?.slice(0, 500)}`);
    rmSync(sandboxDir, { recursive: true, force: true });
    return null;
  }
  console.log('Install complete.');

  // Load the v3.7.0 modules
  const v37DistSrc = join(sandboxDir, 'node_modules/@claude-flow/cli/dist/src');
  let composeHandler = null;
  let wasmMod = null;

  try {
    wasmMod = await import(resolve(v37DistSrc, 'ruvector/agent-wasm.js'));
  } catch (e) {
    console.warn(`[warn] v3.7.0 agent-wasm not available: ${e.message}`);
  }

  try {
    const toolsMod = await import(resolve(v37DistSrc, 'mcp-tools/wasm-agent-tools.js'));
    const tools = toolsMod.wasmAgentTools ?? [];
    composeHandler = tools.find(t => t.name === 'wasm_agent_compose')?.handler ?? null;
  } catch (e) {
    console.warn(`[warn] v3.7.0 wasm-agent-tools not available: ${e.message}`);
  }

  return { composeHandler, wasmMod, sandboxDir };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('M7 — v3.7.0 vs v3.8.0 delta benchmark');
console.log(`trials=${TRIALS}  K=${K}`);
console.log('');

// Measure v3.8
console.log('Measuring v3.8.0 (current dist)...');
const v38 = await measureV38();
const v38Compose = await benchCompose(v38.composeHandler, v38.toolNames, TRIALS);
const v38Wasm = await benchCreateAgent(v38.wasmMod, TRIALS);
console.log(`  compose_${K}_tools: ${v38Compose?.medianMs}ms`);
console.log(`  createWasmAgent:    ${v38Wasm?.medianMs}ms`);

// Measure v3.7
console.log('\nMeasuring v3.7.0 (npx-installed)...');
const v37 = await measureV37();
let v37Compose = null;
let v37Wasm = null;
let sandboxDir = null;

if (v37) {
  sandboxDir = v37.sandboxDir;
  const toolNames = Array.from({ length: K }, (_, i) => `tool_${String(i).padStart(2, '0')}`);
  v37Compose = await benchCompose(v37.composeHandler, toolNames, TRIALS);
  v37Wasm = await benchCreateAgent(v37.wasmMod, TRIALS);
  console.log(`  compose_${K}_tools: ${v37Compose?.medianMs ?? 'N/A'}ms`);
  console.log(`  createWasmAgent:    ${v37Wasm?.medianMs ?? 'N/A'}ms`);
} else {
  console.log('  v3.7.0 install failed — delta cannot be computed');
}

// Compute speedup ratios
function speedup(v37ms, v38ms) {
  if (!v37ms || !v38ms || v38ms === 0) return null;
  return Math.round((v37ms / v38ms) * 100) / 100;
}

const result = {
  tag: 'version-delta',
  capturedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node_version: process.version,
  K,
  trials: TRIALS,
  v38: {
    version: '3.8.0',
    compose_K_tools: v38Compose,
    createWasmAgent: v38Wasm,
  },
  v37: v37 ? {
    version: '3.7.0',
    compose_K_tools: v37Compose,
    createWasmAgent: v37Wasm,
    available: true,
  } : {
    version: '3.7.0',
    available: false,
    reason: 'Install failed or dist not available',
  },
  speedup_v37_over_v38: {
    compose_K_tools: speedup(v37Compose?.medianMs, v38Compose?.medianMs),
    createWasmAgent: speedup(v37Wasm?.medianMs, v38Wasm?.medianMs),
    note: 'Values > 1 mean v3.8 is faster. null = data unavailable.',
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = resolve(OUT_DIR, 'version-delta.json');
writeFileSync(outPath, JSON.stringify(result, null, 2));

// Cleanup sandbox
if (sandboxDir) {
  rmSync(sandboxDir, { recursive: true, force: true });
  console.log('\nSandbox cleaned up.');
}

console.log(`\nWrote ${outPath}`);
console.log('\n--- v3.7 → v3.8 Delta ---');

const ru = result.speedup_v37_over_v38;
const fmt = (v) => v === null ? 'N/A' : (v > 1 ? `${v}x faster` : v === 1 ? 'same' : `${v}x SLOWER`);
console.log(`  compose_${K}_tools: ${fmt(ru.compose_K_tools)}`);
console.log(`  createWasmAgent:    ${fmt(ru.createWasmAgent)}`);
