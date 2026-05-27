/**
 * V3 CLI Performance Capability Benchmark
 *
 * Runs a small verifiable-answer corpus through the Anthropic API and reports
 * pass-rate, latency, and cost. Closes the capability-evaluation gap that
 * `performance benchmark --suite agent` does NOT cover — that suite measures
 * the agent control plane (router, memory, hooks) without LLM calls; this
 * subcommand measures the actual model's ability to solve agent-style tasks.
 *
 * Inspired by GAIA / SWE-bench format but text-only and scoreable via
 * substring / exact match — no web browsing, no file attachments, no
 * Hugging Face dataset download. The fixture lives at
 * `src/benchmarks/capability-tasks.json` and can be overridden via
 * `--questions <path>` to point at a larger / private dataset.
 *
 * API key resolution (in order):
 *   1. $ANTHROPIC_API_KEY env var
 *   2. `gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY`
 *      (matches the pattern used by plugins/ruflo-cost-tracker/scripts/bench.mjs)
 *   3. Fail with a clear error
 *
 * Refs: #2156 (Dream Cycle 2026-05-27 capabilities scan)
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { BUILTIN_CAPABILITY_TASKS } from '../benchmarks/capability-tasks.js';

interface Task {
  id: string;
  category: string;
  prompt: string;
  expected: string;
  matchMode: 'exact' | 'substring' | 'regex';
}

interface TaskFile {
  version: string;
  description?: string;
  answerFormat?: string;
  tasks: Task[];
}

interface RunResult {
  id: string;
  category: string;
  correct: boolean;
  answer: string;
  expected: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

// Anthropic pricing (per 1M tokens, USD) — keep in sync with cost-tracker/scripts/bench.mjs
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-opus-4-7': { in: 15.0, out: 75.0 },
};

function resolveApiKey(): string {
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();

  try {
    const out = execSync(
      'gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY 2>/dev/null',
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    if (out) return out;
  } catch {
    /* fall through */
  }

  throw new Error(
    'ANTHROPIC_API_KEY not found. Set the env var or store it as a gcloud secret named ANTHROPIC_API_KEY (e.g. `echo -n "$KEY" | gcloud secrets create ANTHROPIC_API_KEY --data-file=-`).',
  );
}

function loadTaskFile(custom?: string): TaskFile {
  if (custom) {
    const resolved = path.resolve(custom);
    if (!fs.existsSync(resolved)) throw new Error(`questions file not found: ${resolved}`);
    return JSON.parse(fs.readFileSync(resolved, 'utf-8')) as TaskFile;
  }
  // Built-in fixture is bundled as a TS module (not a JSON file) so it lands
  // in dist/ via tsc — JSON files are not copied by the default tsc build.
  return BUILTIN_CAPABILITY_TASKS as unknown as TaskFile;
}

function buildPrompt(task: Task): string {
  return `You are answering an agent-capability benchmark question. Provide your reasoning briefly, then wrap your final answer in <answer>...</answer> tags. Be exact — the harness compares the tag contents to a ground-truth string.

Question: ${task.prompt}`;
}

function extractAnswer(text: string): string {
  const m = text.match(/<answer>([\s\S]*?)<\/answer>/i);
  if (m && m[1] !== undefined) return m[1].trim();
  // Fallback: take last non-empty line, stripped of punctuation/whitespace
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] || '').replace(/[.,!?]$/, '').trim();
}

function check(answer: string, task: Task): boolean {
  const a = answer.trim().toLowerCase();
  const e = task.expected.trim().toLowerCase();
  switch (task.matchMode) {
    case 'exact':
      return a === e;
    case 'substring':
      return a.includes(e);
    case 'regex':
      try {
        return new RegExp(task.expected, 'i').test(answer);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

async function callAnthropic(
  apiKey: string,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      signal: ac.signal,
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const body = (await resp.json()) as {
      content?: { text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = body.content?.[0]?.text ?? '';
    return {
      text,
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

const capabilityCommand: Command = {
  name: 'capability',
  description: 'Run a real LLM-driven agent-capability benchmark against the Anthropic API',
  options: [
    { name: 'model', short: 'm', type: 'string', description: 'Anthropic model id', default: 'claude-haiku-4-5' },
    { name: 'questions', short: 'q', type: 'string', description: 'Path to a custom tasks JSON file (default: built-in fixture)' },
    { name: 'output', short: 'o', type: 'string', description: 'Output format: text, json', default: 'text' },
    { name: 'timeout', short: 't', type: 'number', description: 'Per-question timeout (ms)', default: '30000' },
    { name: 'limit', short: 'l', type: 'number', description: 'Run only the first N questions' },
  ],
  examples: [
    { command: 'claude-flow performance capability', description: 'Run the built-in 8-question fixture against Haiku' },
    { command: 'claude-flow performance capability -m claude-sonnet-4-6', description: 'Run against Sonnet 4.6' },
    { command: 'claude-flow performance capability -q ./my-eval.json -o json', description: 'Use a custom dataset, emit JSON' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const model = (ctx.flags.model as string) || 'claude-haiku-4-5';
    const customPath = ctx.flags.questions as string | undefined;
    const outputFormat = (ctx.flags.output as string) || 'text';
    const timeoutMs = parseInt(String(ctx.flags.timeout ?? '30000'), 10);
    const limit = ctx.flags.limit ? parseInt(String(ctx.flags.limit), 10) : undefined;

    output.writeln();
    output.writeln(output.bold('Agent Capability Benchmark (Anthropic API)'));
    output.writeln(output.dim('─'.repeat(60)));

    let apiKey: string;
    try {
      apiKey = resolveApiKey();
    } catch (err) {
      output.writeln(output.error((err as Error).message));
      return { success: false, message: (err as Error).message, exitCode: 1 };
    }

    let file: TaskFile;
    try {
      file = loadTaskFile(customPath);
    } catch (err) {
      output.writeln(output.error((err as Error).message));
      return { success: false, message: (err as Error).message, exitCode: 1 };
    }

    const tasks = limit ? file.tasks.slice(0, limit) : file.tasks;
    output.writeln(`Model:        ${model}`);
    output.writeln(`Questions:    ${tasks.length}${customPath ? ` (custom: ${customPath})` : ' (built-in fixture)'}`);
    output.writeln(`Timeout/Q:    ${timeoutMs}ms`);
    output.writeln();

    const results: RunResult[] = [];
    const spinner = output.createSpinner({ text: `Q 0/${tasks.length}`, spinner: 'dots' });
    spinner.start();

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      spinner.setText(`Q ${i + 1}/${tasks.length} — ${task.id}`);
      const start = performance.now();
      try {
        const { text, inputTokens, outputTokens } = await callAnthropic(apiKey, model, buildPrompt(task), timeoutMs);
        const answer = extractAnswer(text);
        results.push({
          id: task.id,
          category: task.category,
          correct: check(answer, task),
          answer,
          expected: task.expected,
          latencyMs: performance.now() - start,
          inputTokens,
          outputTokens,
        });
      } catch (err) {
        results.push({
          id: task.id,
          category: task.category,
          correct: false,
          answer: '',
          expected: task.expected,
          latencyMs: performance.now() - start,
          inputTokens: 0,
          outputTokens: 0,
          error: (err as Error).message.slice(0, 120),
        });
      }
    }

    spinner.succeed(`Completed ${tasks.length} questions`);

    const passed = results.filter((r) => r.correct).length;
    const passRate = passed / results.length;
    const meanLatency = results.reduce((a, b) => a + b.latencyMs, 0) / results.length;
    const totalInputTokens = results.reduce((a, b) => a + b.inputTokens, 0);
    const totalOutputTokens = results.reduce((a, b) => a + b.outputTokens, 0);
    const price = PRICING[model] ?? { in: 3.0, out: 15.0 };
    const usd = (totalInputTokens / 1_000_000) * price.in + (totalOutputTokens / 1_000_000) * price.out;

    if (outputFormat === 'json') {
      output.printJson({
        model,
        questions: tasks.length,
        passed,
        passRate,
        meanLatencyMs: meanLatency,
        totalInputTokens,
        totalOutputTokens,
        estCostUsd: usd,
        results,
      });
      return { success: passRate >= 0.5, data: { passRate, results } };
    }

    output.writeln();
    output.printTable({
      columns: [
        { key: 'id', header: 'Question', width: 20 },
        { key: 'category', header: 'Category', width: 22 },
        { key: 'correct', header: 'Pass', width: 6 },
        { key: 'latency', header: 'Latency', width: 10 },
        { key: 'answer', header: 'Answer (got vs expected)', width: 40 },
      ],
      data: results.map((r) => ({
        id: r.id,
        category: r.category,
        correct: r.correct ? output.success('✓') : output.error('✗'),
        latency: `${r.latencyMs.toFixed(0)}ms`,
        answer: r.error
          ? output.dim(`error: ${r.error}`)
          : r.correct
            ? r.answer.slice(0, 38)
            : `${r.answer.slice(0, 18)} ≠ ${r.expected.slice(0, 18)}`,
      })),
    });

    output.writeln();
    output.printBox(
      [
        `Model:           ${model}`,
        `Pass rate:       ${(passRate * 100).toFixed(1)}% (${passed}/${results.length})`,
        `Mean latency:    ${meanLatency.toFixed(0)}ms`,
        `Tokens:          ${totalInputTokens} in / ${totalOutputTokens} out`,
        `Est. cost:       $${usd.toFixed(4)}`,
        ``,
        `Overall:         ${passRate >= 0.75 ? output.success('Strong') : passRate >= 0.5 ? output.warning('Moderate') : output.error('Weak')}`,
      ].join('\n'),
      'Capability Summary',
    );

    return { success: passRate >= 0.5, data: { passRate, meanLatencyMs: meanLatency, costUsd: usd, results } };
  },
};

export default capabilityCommand;
