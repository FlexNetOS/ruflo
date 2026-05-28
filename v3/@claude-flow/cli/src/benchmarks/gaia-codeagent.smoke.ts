/**
 * GAIA CodeAgent Smoke Tests — ADR-138 iter 54 (FINAL design)
 *
 * 5 tests validating the CodeAgent harness end-to-end.
 * Tests 1-4 are unit-level (no API calls). Test 5 uses 1 API call.
 *
 * Tests:
 *   T1: Code block extraction — parser correctness (no subprocess)
 *   T2: Python runner — simple math (subprocess, no API)
 *   T3: Python runner — file read via ATTACHMENT_PATH
 *   T4: Python runner — code error recovery (traceback returned as obs)
 *   T5: End-to-end — simple factual question (1 API call, ~$0.01)
 *
 * Pass criteria: 5/5. Gate before iter 55 5Q run.
 *
 * Run: npx tsx gaia-codeagent.smoke.ts
 *      or: node dist/src/benchmarks/gaia-codeagent.smoke.js
 *
 * Refs: ADR-138, #2156, iter 54
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractCodeBlock,
  runCodeAgentStep,
  runGaiaCodeAgent,
  isAnswerCorrect,
} from './gaia-codeagent.js';
import type { GaiaQuestion } from './gaia-loader.js';
import { resolveAnthropicApiKey } from './gaia-agent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  durationMs: number;
}

function makeQ(overrides: Partial<GaiaQuestion> = {}): GaiaQuestion {
  return {
    task_id: 'smoke-test',
    level: 1 as const,
    question: 'What is 2 + 2?',
    final_answer: '4',
    file_name: null,
    file_path: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T1: Code block extraction (no subprocess, no API)
// ---------------------------------------------------------------------------

function testCodeBlockExtraction(): TestResult {
  const name = 'T1: Code block extraction';
  const start = Date.now();

  const cases: Array<{ input: string; expected: string | null }> = [
    { input: '```python\nprint(2+2)\n```', expected: 'print(2+2)' },
    { input: '```py\nresult = 42\n```', expected: 'result = 42' },
    { input: '```\nfinal_answer("test")\n```', expected: 'final_answer("test")' },
    { input: 'No code block here', expected: null },
    {
      input: 'Reasoning...\n```python\nweb_search("q")\nprint(r)\n```\nMore',
      expected: 'web_search("q")\nprint(r)',
    },
  ];

  for (const { input, expected } of cases) {
    const result = extractCodeBlock(input);
    if (result !== expected) {
      return {
        name,
        passed: false,
        message: `Case "${input.slice(0, 40)}": got "${result}", expected "${expected}"`,
        durationMs: Date.now() - start,
      };
    }
  }
  return { name, passed: true, message: `${cases.length}/5 cases passed`, durationMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// T2: Python runner — simple math (subprocess, no API)
// ---------------------------------------------------------------------------

function testPythonRunnerMath(): TestResult {
  const name = 'T2: Python runner — simple math';
  const start = Date.now();

  const apiKey = process.env.ANTHROPIC_API_KEY ?? 'test-key';
  const code = `result = 2 + 2\nprint(result)\nfinal_answer(str(result))`;
  const stepResult = runCodeAgentStep(code, null, 15_000, apiKey);

  if (stepResult.finalAnswer !== '4') {
    return {
      name,
      passed: false,
      message: `Expected finalAnswer "4", got "${stepResult.finalAnswer ?? 'null'}". Obs: ${stepResult.observation.slice(0, 200)}`,
      durationMs: Date.now() - start,
    };
  }
  return { name, passed: true, message: `finalAnswer="4" as expected`, durationMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// T3: Python runner — file read via ATTACHMENT_PATH
// ---------------------------------------------------------------------------

function testPythonRunnerFileRead(): TestResult {
  const name = 'T3: Python runner — file read';
  const start = Date.now();
  const tmpFile = path.join(os.tmpdir(), `gaia-smoke-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'The magic number is forty-two (42).', 'utf-8');

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? 'test-key';
    const code = `content = read_file(ATTACHMENT_PATH)\nprint("Read:", content[:80])\nfinal_answer("42")`;
    const stepResult = runCodeAgentStep(code, tmpFile, 15_000, apiKey);

    if (stepResult.finalAnswer !== '42') {
      return {
        name, passed: false,
        message: `Expected finalAnswer "42", got "${stepResult.finalAnswer ?? 'null'}". Obs: ${stepResult.observation.slice(0, 200)}`,
        durationMs: Date.now() - start,
      };
    }
    if (!stepResult.observation.includes('forty-two') && !stepResult.observation.includes('42')) {
      return {
        name, passed: false,
        message: `File content not in observation. Obs: ${stepResult.observation.slice(0, 200)}`,
        durationMs: Date.now() - start,
      };
    }
    return { name, passed: true, message: `File read OK, finalAnswer="42"`, durationMs: Date.now() - start };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// T4: Python runner — code error recovery
// ---------------------------------------------------------------------------

function testPythonRunnerErrorRecovery(): TestResult {
  const name = 'T4: Python runner — error recovery';
  const start = Date.now();

  const apiKey = process.env.ANTHROPIC_API_KEY ?? 'test-key';
  const badCode = `result = undefined_variable_xyz + 1\nprint(result)`;
  const stepResult = runCodeAgentStep(badCode, null, 15_000, apiKey);

  if (stepResult.finalAnswer !== null) {
    return {
      name, passed: false,
      message: `Expected no finalAnswer from errored code, got "${stepResult.finalAnswer}"`,
      durationMs: Date.now() - start,
    };
  }
  const obs = stepResult.observation.toLowerCase();
  if (!obs.includes('error') && !obs.includes('nameerror')) {
    return {
      name, passed: false,
      message: `Observation should contain error info, got: ${stepResult.observation.slice(0, 200)}`,
      durationMs: Date.now() - start,
    };
  }
  return {
    name, passed: true,
    message: `Error returned as observation: "${stepResult.observation.slice(0, 60)}..."`,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// T5: End-to-end — simple factual question (1 API call)
// ---------------------------------------------------------------------------

async function testEndToEndSimple(): Promise<TestResult> {
  const name = 'T5: End-to-end — simple factual (1 API call)';
  const start = Date.now();

  let apiKey: string;
  try {
    apiKey = resolveAnthropicApiKey();
  } catch (err) {
    return {
      name, passed: false,
      message: `No API key: ${String(err)}`,
      durationMs: Date.now() - start,
    };
  }

  const q = makeQ({
    task_id: 'smoke-e2e-01',
    question: 'What is 6 multiplied by 7? Answer as a number.',
    final_answer: '42',
  });

  try {
    const result = await runGaiaCodeAgent(q, {
      model: 'claude-sonnet-4-6',
      maxTurns: 5,
      apiKey,
    });

    if (result.error && !result.finalAnswer) {
      return { name, passed: false, message: `Agent error: ${result.error}`, durationMs: Date.now() - start };
    }
    if (result.finalAnswer === null) {
      return { name, passed: false, message: `No final answer (timedOut=${result.timedOut})`, durationMs: Date.now() - start };
    }
    const num = parseFloat(result.finalAnswer.replace(/,/g, ''));
    if (Math.abs(num - 42) > 0.01) {
      return {
        name, passed: false,
        message: `Expected "42", got "${result.finalAnswer}" (turns=${result.turns})`,
        durationMs: Date.now() - start,
      };
    }
    const estCost = (result.totalInputTokens / 1e6) * 3.0 + (result.totalOutputTokens / 1e6) * 15.0;
    return {
      name, passed: true,
      message: `finalAnswer="${result.finalAnswer}" turns=${result.turns} cost~=$${estCost.toFixed(4)}`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return { name, passed: false, message: `Exception: ${String(err)}`, durationMs: Date.now() - start };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n=== GAIA CodeAgent Smoke Tests (ADR-138 iter 54) ===\n');

  const results: TestResult[] = [
    testCodeBlockExtraction(),
    testPythonRunnerMath(),
    testPythonRunnerFileRead(),
    testPythonRunnerErrorRecovery(),
    await testEndToEndSimple(),
  ];

  let passed = 0;
  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${r.name} (${r.durationMs}ms)`);
    console.log(`       ${r.message}`);
    if (r.passed) passed++;
  }

  console.log(`\n=== ${passed}/${results.length} passed ===`);
  if (passed === results.length) {
    console.log('All smoke tests passed. CodeAgent harness ready for 1Q sanity check.\n');
    process.exit(0);
  } else {
    console.log(`SMOKE FAILED — ${results.length - passed} test(s) failed.\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(2);
});

export {
  testCodeBlockExtraction,
  testPythonRunnerMath,
  testPythonRunnerFileRead,
  testPythonRunnerErrorRecovery,
  testEndToEndSimple,
};
