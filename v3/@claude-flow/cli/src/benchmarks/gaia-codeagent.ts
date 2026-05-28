/**
 * GAIA CodeAgent — ADR-138 iter 54 (FINAL design)
 *
 * smolagents-style CodeAgent harness for the GAIA L1 benchmark.
 * NOT the smolagents library — this is the PATTERN implemented natively in ruflo TS.
 *
 * Architecture (HAL replication):
 *   Instead of Anthropic native tool_use blocks (JSON → execute → repeat),
 *   the agent writes Python code that calls tools as functions.  The code is
 *   parsed from markdown code blocks, executed in gaia-codeagent-runner.py,
 *   and the stdout is fed back as the next user turn.  The agent commits its
 *   answer by calling final_answer("value") in Python.
 *
 * Why this beats ToolCallingAgent on GAIA (from HAL-DEEP-STUDY.md):
 *   - 30% fewer steps for the same task (Python is more expressive than JSON)
 *   - Variables persist across steps in the agent's mental model
 *   - Complex control flow (loops, try/except) is native
 *   - final_answer() is deterministic — no regex extraction fragility
 *
 * Loop algorithm:
 *   1. Build system prompt with tool signatures and GAIA instruction template.
 *   2. Call Anthropic Messages API (text-in / text-out — NO tools array).
 *   3. Parse the response for a ```python ... ``` code block.
 *   4. If code block found: run gaia-codeagent-runner.py subprocess.
 *      - Runner pre-defines tool functions (web_search, visit_webpage, etc.)
 *      - If final_answer("X") is called in the code: extract X, return result.
 *      - Otherwise: feed stdout back as user turn, continue.
 *   5. If no code block: prompt agent to produce one (max 3 retries).
 *   6. If maxTurns exceeded: return timedOut=true.
 *   7. Every planningInterval turns: inject a planning checkpoint.
 *
 * Tool routing (via gaia-codeagent-runner.py):
 *   web_search(query)      → claude -p with WebSearch (best web coverage)
 *   visit_webpage(url)     → requests + bs4 HTML extraction
 *   grounded_query(query)  → Gemini with Google Search grounding (ruflo unique)
 *   read_file(path)        → Python direct (text/csv/json/xlsx) or subprocess
 *   describe_image(path)   → claude -p with vision
 *   final_answer(x)        → writes sentinel JSON and exits runner
 *
 * Key parameters:
 *   model:            claude-sonnet-4-6 (default; ADR-138 targets Sonnet 4.5+)
 *   maxTurns:         20 (HAL uses 200; 20 is cost-controlled for L1)
 *   planningInterval: 4 (match HAL's planning_interval=4)
 *   maxTokensPerTurn: 4096 (code generation needs more space than ToolCalling)
 *
 * Refs: ADR-138, HAL-DEEP-STUDY.md, smolagents CodeAgent, #2156, iter 54
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  GaiaQuestion,
  SMOKE_FIXTURE,
} from './gaia-loader.js';
import { resolveAnthropicApiKey, isAnswerCorrect } from './gaia-agent.js';

// ---------------------------------------------------------------------------
// Re-export for callers
// ---------------------------------------------------------------------------

export { isAnswerCorrect };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';

/** Default model: Sonnet 4.6 (ADR-138 targets Sonnet 4.5+; 4.6 is available). */
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_TOKENS_PER_TURN = 4096;
const DEFAULT_PER_TURN_TIMEOUT_MS = 90_000;
const DEFAULT_PLANNING_INTERVAL = 4;
const DEFAULT_PER_STEP_TIMEOUT_MS = 30_000;
const MAX_OBSERVATION_CHARS = 6_000;
const MAX_NO_CODE_RETRIES = 3;

/** Pattern for final_answer in text output (GAIA format, fallback). */
const FINAL_ANSWER_TEXT_RE = /FINAL_ANSWER:\s*(.+)/i;

/** Path to the Python runner script — co-located with this file. */
function getRunnerPath(): string {
  const RUNNER_NAME = 'gaia-codeagent-runner.py';

  // Primary: resolve relative to this compiled JS file (dist/src/benchmarks/)
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const candidate = path.join(path.dirname(thisFile), RUNNER_NAME);
    if (fs.existsSync(candidate)) return candidate;
  } catch { /* ESM URL resolution failed */ }

  // Secondary: look for the Python runner next to the current file via __dirname-style
  // heuristic — for Jest/ts-node contexts where import.meta.url is file://...src/...
  try {
    const thisFile = fileURLToPath(import.meta.url);
    // Walk up the dist/ tree to find src/benchmarks/ sibling
    const distBenchmarks = path.dirname(thisFile);
    const srcBenchmarks = distBenchmarks.replace(
      path.join('dist', 'src', 'benchmarks'),
      path.join('src', 'benchmarks'),
    );
    const srcCandidate = path.join(srcBenchmarks, RUNNER_NAME);
    if (fs.existsSync(srcCandidate)) return srcCandidate;
  } catch { /* ignore */ }

  // Tertiary: CJS fallback (process.argv[1] path)
  const fallback = path.join(path.dirname(process.argv[1] ?? '.'), RUNNER_NAME);
  return fallback;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CodeAgentResult {
  questionId: string;
  finalAnswer: string | null;
  turns: number;
  toolCallsByName: Record<string, number>;
  totalInputTokens: number;
  totalOutputTokens: number;
  wallMs: number;
  replanCount: number;
  timedOut?: boolean;
  error?: string;
  /** Steps log for debugging — each entry is one turn's code + output. */
  steps?: Array<{ code: string; output: string }>;
}

export interface CodeAgentOptions {
  model?: string;
  maxTurns?: number;
  maxTokensPerTurn?: number;
  perTurnTimeoutMs?: number;
  /** Timeout for each Python step execution (default: 30s). */
  perStepTimeoutMs?: number;
  planningInterval?: number;
  apiKey?: string;
  /** If true, include step-by-step code/output log in the result. */
  verbose?: boolean;
  /**
   * Optional tool catalogue override — used by unit tests to inject mock tools.
   * In production (Python runner mode) this is ignored; the runner defines its own tools.
   */
  catalogue?: unknown[];
}

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

interface MessageParam {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicTextResponse {
  id: string;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | string;
  content: Array<{ type: 'text'; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Build the CodeAgent system prompt.
 *
 * The prompt explains the coding loop to the model and lists all available
 * tools with their signatures.  This mirrors HAL's CodeAgent system prompt
 * format as documented in HAL-DEEP-STUDY.md.
 */
function buildCodeAgentSystemPrompt(): string {
  const toolDocs = [
    '  web_search(query: str) -> str',
    '    Search the web and return snippets. Use for factual lookups.',
    '',
    '  visit_webpage(url: str) -> str',
    '    Fetch full text content of a webpage. Use after web_search to read a page.',
    '',
    '  grounded_query(query: str) -> str',
    '    Ask Gemini with Google grounding — returns synthesized answer with citations.',
    '    Best for factoid questions. Use this OR web_search (not both for same query).',
    '',
    '  read_file(path: str) -> str',
    '    Read a file — supports txt, csv, json, xlsx, pptx, pdf, images.',
    '    Use the ATTACHMENT_PATH variable if a file was provided with the question.',
    '',
    '  describe_image(path: str) -> str',
    '    Describe an image using Claude vision.',
    '',
    '  final_answer(answer) -> never',
    '    Submit your final answer. This ENDS the loop immediately.',
  ].join('\n');

  return [
    'You are a Python-capable agent solving GAIA benchmark questions.',
    'To use tools, write Python code in ```python blocks and call tool functions directly.',
    'After each code block, you will receive the output. Continue until you have the answer.',
    '',
    'TOOL FUNCTIONS AVAILABLE (call these in your Python code):',
    toolDocs,
    '',
    'GLOBAL VARIABLES:',
    '  ATTACHMENT_PATH: str  (path to attached file, or empty string if no attachment)',
    '',
    'PRE-IMPORTED: math, re, json, datetime, collections, itertools, statistics,',
    '  fractions, decimal, string, unicodedata, urllib.parse, pathlib.Path,',
    '  pandas as pd (optional), numpy as np (optional), sympy (optional)',
    '',
    'CODING RULES:',
    '1. Write Python code in ```python\\n...\\n``` blocks.',
    '2. Use print() to see tool outputs and intermediate results.',
    '3. Call final_answer("your answer here") when you are certain of the answer.',
    '4. Handle errors with try/except — do not crash on tool failures.',
    '5. Use ATTACHMENT_PATH to access attached files when provided.',
    '',
    'GAIA ANSWER FORMAT (CRITICAL — follow exactly):',
    'Return only the answer, which should be:',
    '- A number: no commas, no units unless specified. Do not round unless asked.',
    '- A string: no articles (a/an/the), no abbreviations. Spell out digits unless specified.',
    '- A comma-separated list: apply the above per element.',
    '',
    'IMPORTANT: Do not include extra explanation in final_answer(). Just the bare answer.',
    'Example: final_answer("3") or final_answer("Paris") or final_answer("2, 4, 6")',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Planning checkpoint
// ---------------------------------------------------------------------------

function buildCodeAgentPlanningCheckpoint(turn: number, maxTurns: number): string {
  return (
    `[PLANNING CHECKPOINT — step ${turn}/${maxTurns}]\n` +
    `You have used ${turn} steps so far. Before continuing:\n` +
    `1. Briefly summarize what you have learned from tool calls so far.\n` +
    `2. State explicitly: is your current approach making progress toward the answer?\n` +
    `3. If NOT making progress: switch strategy. Different tool, different query, different approach.\n` +
    `4. If you are confident in an answer: call final_answer("your answer") now.\n` +
    `Continue with your next Python code block.`
  );
}

// ---------------------------------------------------------------------------
// Code block parser
// ---------------------------------------------------------------------------

/**
 * Extract the first ```python ... ``` code block from assistant output.
 * Returns null if no code block is found.
 *
 * Exported for use in unit tests (gaia-codeagent.smoke.ts T1).
 */
export function extractCodeBlock(text: string): string | null {
  // Match ```python or ```py (with optional language tag) then newline then content
  const withLangMatch = /```(?:python|py)\s*\n([\s\S]*?)```/.exec(text);
  if (withLangMatch) return withLangMatch[1].trim();

  // Bare ``` with no language tag
  const lenientMatch = /```\s*\n([\s\S]*?)```/.exec(text);
  if (lenientMatch) return lenientMatch[1].trim();

  return null;
}

// ---------------------------------------------------------------------------
// Python execution via gaia-codeagent-runner.py subprocess
// ---------------------------------------------------------------------------

/**
 * Execute one step of agent code via gaia-codeagent-runner.py.
 *
 * The runner:
 * 1. Pre-defines tool functions (web_search, visit_webpage, grounded_query,
 *    read_file, describe_image, final_answer)
 * 2. exec()s the agent's code in that context
 * 3. If final_answer() is called: writes GAIA_RESULT_FILE JSON and exits 0
 * 4. stdout is captured as the observation for the next turn
 *
 * Returns { output, finalAnswer }.
 */
function executeAgentCodeStep(
  code: string,
  attachmentPath: string | null,
  stepTimeoutMs: number,
  apiKey: string,
  toolCallsByName: Record<string, number>,
): { output: string; finalAnswer: string | null } {
  const runnerPath = getRunnerPath();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-ca-'));
  const codeFile = path.join(tmpDir, 'agent_code.py');
  const resultFile = path.join(tmpDir, 'final_answer.json');

  try {
    fs.writeFileSync(codeFile, code, 'utf-8');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      GAIA_CODE_FILE: codeFile,
      GAIA_RESULT_FILE: resultFile,
      ANTHROPIC_API_KEY: apiKey,
    };
    if (attachmentPath) {
      env.GAIA_ATTACHMENT_PATH = attachmentPath;
    }

    const result = spawnSync('python3', [runnerPath], {
      encoding: 'utf-8',
      timeout: stepTimeoutMs,
      env,
      maxBuffer: 10 * 1024 * 1024,
    });

    // Count tool calls detected in stdout (heuristic from output markers)
    const stdout = result.stdout ?? '';
    const toolPatterns = ['web_search', 'visit_webpage', 'grounded_query', 'read_file', 'describe_image'];
    for (const toolName of toolPatterns) {
      // Rough heuristic: count function calls in agent code
      const count = (code.match(new RegExp(`\\b${toolName}\\s*\\(`, 'g')) ?? []).length;
      if (count > 0) {
        toolCallsByName[toolName] = (toolCallsByName[toolName] ?? 0) + count;
      }
    }

    // Check for final_answer sentinel
    let finalAnswer: string | null = null;
    if (fs.existsSync(resultFile)) {
      try {
        const sentinel = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        finalAnswer = String(sentinel.answer ?? '').trim();
      } catch { /* ignore */ }
    }

    const stdoutTrimmed = stdout.trim();
    const stderr = (result.stderr ?? '').trim();

    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
      return { output: `[Execution timed out after ${stepTimeoutMs / 1000}s]`, finalAnswer: null };
    }

    // Filter out non-critical warnings from stderr
    const stderrClean = stderr
      ? stderr.split('\n').filter(l =>
          !l.includes('UserWarning') && !l.includes('DeprecationWarning') && l.trim()
        ).slice(0, 5).join('\n')
      : '';

    let observation = stdoutTrimmed;
    if (stderrClean) {
      observation = observation
        ? `${observation}\n[stderr]: ${stderrClean.slice(0, 500)}`
        : `[stderr]: ${stderrClean.slice(0, 500)}`;
    }
    if (!observation && finalAnswer !== null) {
      observation = `[Code executed — final_answer captured: ${finalAnswer}]`;
    }
    if (!observation) {
      observation = '[Code executed — no output]';
    }

    if (observation.length > MAX_OBSERVATION_CHARS) {
      observation = observation.slice(0, MAX_OBSERVATION_CHARS) + '\n[... truncated ...]';
    }

    return { output: observation, finalAnswer };
  } catch (err) {
    return { output: `[Execution error: ${String(err)}]`, finalAnswer: null };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Public step runner (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Execute a single Python code step via the gaia-codeagent-runner.py subprocess.
 *
 * This is a thin public wrapper around `executeAgentCodeStep` that:
 * - Exposes a clean typed signature for unit tests (gaia-codeagent.smoke.ts T2-T4)
 * - Renames `output` → `observation` to match the smolagents naming convention
 *
 * @param code       Python code to execute
 * @param attachmentPath  Path to attached file, or null
 * @param timeoutMs  Subprocess timeout in ms (default: 30s)
 * @param apiKey     Anthropic API key (passed to runner for claude -p tool calls)
 */
export function runCodeAgentStep(
  code: string,
  attachmentPath: string | null,
  timeoutMs = DEFAULT_PER_STEP_TIMEOUT_MS,
  apiKey = '',
): { observation: string; finalAnswer: string | null } {
  const toolCallsByName: Record<string, number> = {};
  const { output, finalAnswer } = executeAgentCodeStep(code, attachmentPath, timeoutMs, apiKey, toolCallsByName);
  return { observation: output, finalAnswer };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API call (text-only — no tools array)
// ---------------------------------------------------------------------------

async function callAnthropicTextOnly(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: MessageParam[],
  maxTokens: number,
  timeoutMs: number,
): Promise<AnthropicTextResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '<unreadable>');
    throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 400)}`);
  }

  return (await res.json()) as AnthropicTextResponse;
}

// ---------------------------------------------------------------------------
// Main CodeAgent loop
// ---------------------------------------------------------------------------

/**
 * Run a GAIA question through the smolagents-style CodeAgent harness.
 *
 * The agent writes Python code, we execute it with tool stubs, and feed
 * the output back.  The loop continues until final_answer() is called
 * or maxTurns is exhausted.
 */
export async function runGaiaCodeAgent(
  question: GaiaQuestion,
  options: CodeAgentOptions = {},
): Promise<CodeAgentResult> {
  const {
    model = DEFAULT_MODEL,
    maxTurns = DEFAULT_MAX_TURNS,
    maxTokensPerTurn = DEFAULT_MAX_TOKENS_PER_TURN,
    perTurnTimeoutMs = DEFAULT_PER_TURN_TIMEOUT_MS,
    perStepTimeoutMs = DEFAULT_PER_STEP_TIMEOUT_MS,
    planningInterval = DEFAULT_PLANNING_INTERVAL,
    apiKey: suppliedKey,
    verbose = false,
  } = options;

  const wallStart = Date.now();
  const apiKey = resolveAnthropicApiKey(suppliedKey);
  const attachmentPath = question.file_path ?? null;

  const toolCallsByName: Record<string, number> = {};
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let replanCount = 0;
  let noCodeRetries = 0;
  const steps: Array<{ code: string; output: string }> = [];

  const systemPrompt = buildCodeAgentSystemPrompt();

  // Build the initial user message following the GAIA instruction template
  // (exact format from HAL-DEEP-STUDY.md §4)
  const questionText = buildGaiaQuestionMessage(question);
  const messages: MessageParam[] = [
    { role: 'user', content: questionText },
  ];

  let turns = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    turns = turn + 1;

    // Call the model (text only — no tools array)
    let resp: AnthropicTextResponse;
    try {
      resp = await callAnthropicTextOnly(
        apiKey,
        model,
        systemPrompt,
        messages,
        maxTokensPerTurn,
        perTurnTimeoutMs,
      );
    } catch (err) {
      return {
        questionId: question.task_id,
        finalAnswer: null,
        turns,
        toolCallsByName,
        totalInputTokens,
        totalOutputTokens,
        wallMs: Date.now() - wallStart,
        replanCount,
        error: err instanceof Error ? err.message : String(err),
        steps: verbose ? steps : undefined,
      };
    }

    totalInputTokens += resp.usage.input_tokens;
    totalOutputTokens += resp.usage.output_tokens;

    // Extract text content
    const assistantText = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    // Append assistant turn to messages
    messages.push({ role: 'assistant', content: assistantText });

    // --- Check for final_answer in TEXT output (before code execution) ---
    // Sometimes the agent commits in prose without a code block
    const textFinalMatch = FINAL_ANSWER_TEXT_RE.exec(assistantText);
    if (textFinalMatch) {
      const finalAnswer = textFinalMatch[1].trim();
      return {
        questionId: question.task_id,
        finalAnswer,
        turns,
        toolCallsByName,
        totalInputTokens,
        totalOutputTokens,
        wallMs: Date.now() - wallStart,
        replanCount,
        steps: verbose ? steps : undefined,
      };
    }

    // --- Extract code block ---
    const codeBlock = extractCodeBlock(assistantText);

    if (!codeBlock) {
      noCodeRetries++;
      if (noCodeRetries >= MAX_NO_CODE_RETRIES) {
        // Give up on prompting — try to extract answer from prose
        const textMatch = FINAL_ANSWER_TEXT_RE.exec(assistantText);
        if (textMatch) {
          return {
            questionId: question.task_id,
            finalAnswer: textMatch[1].trim(),
            turns,
            toolCallsByName,
            totalInputTokens,
            totalOutputTokens,
            wallMs: Date.now() - wallStart,
            replanCount,
            steps: verbose ? steps : undefined,
          };
        }
        break;
      }
      // Prompt agent to produce a code block
      messages.push({
        role: 'user',
        content: 'Please write a Python code block. Use ```python\\n...\\n``` format. Call final_answer("your answer") when done.',
      });
      continue;
    }

    noCodeRetries = 0;

    // --- Execute the code via the Python runner ---
    const { output, finalAnswer: execFinalAnswer } = executeAgentCodeStep(
      codeBlock,
      attachmentPath,
      perStepTimeoutMs,
      apiKey,
      toolCallsByName,
    );

    if (verbose) {
      steps.push({ code: codeBlock, output });
    }

    // If execution produced a final_answer, return it
    if (execFinalAnswer !== null) {
      return {
        questionId: question.task_id,
        finalAnswer: execFinalAnswer,
        turns,
        toolCallsByName,
        totalInputTokens,
        totalOutputTokens,
        wallMs: Date.now() - wallStart,
        replanCount,
        steps: verbose ? steps : undefined,
      };
    }

    // --- Build next user turn (observation) ---
    // Every planningInterval turns, inject a planning checkpoint
    const shouldReplan =
      planningInterval > 0 && turns > 0 && turns % planningInterval === 0;

    let observationText = `\`\`\`output\n${output}\n\`\`\``;
    if (shouldReplan) {
      replanCount++;
      observationText += `\n\n${buildCodeAgentPlanningCheckpoint(turns, maxTurns)}`;
    }

    messages.push({ role: 'user', content: observationText });
  }

  // Exhausted maxTurns
  return {
    questionId: question.task_id,
    finalAnswer: null,
    turns,
    toolCallsByName,
    totalInputTokens,
    totalOutputTokens,
    wallMs: Date.now() - wallStart,
    replanCount,
    timedOut: true,
    steps: verbose ? steps : undefined,
  };
}

// ---------------------------------------------------------------------------
// GAIA question message builder
// ---------------------------------------------------------------------------

/**
 * Build the user message for a GAIA question.
 * Follows the HAL instruction template exactly (HAL-DEEP-STUDY.md §4).
 */
function buildGaiaQuestionMessage(question: GaiaQuestion): string {
  const gaiaPreamble = [
    'Please answer the question below. You should:',
    '- Return only your answer, which should be a number, or a short phrase with as few words as possible, or a comma separated list.',
    '- If you are asked for a number, don\'t use commas to write your number neither use units such as $ or percent sign unless specified otherwise. Don\'t round numbers unless specified.',
    '- If you are asked for a string, don\'t use articles, neither abbreviations (e.g. for cities), and write the digits in full unless specified otherwise.',
    '- If you are asked for a comma separated list, apply the above rules depending on whether the element to be put in the list is a number or a string.',
    '',
    'To submit your answer, use: final_answer("your answer here")',
    '',
  ].join('\n');

  let questionText = question.question;

  // Attachment hint
  if (question.file_path) {
    const ext = question.file_path.split('.').pop()?.toLowerCase() ?? '';
    const toolHint = ext === 'pdf'
      ? `Use pdf_read(path="${question.file_path}") to read the attached PDF.`
      : ext === 'xlsx' || ext === 'csv'
      ? `Use file_read(path="${question.file_path}") to read the attached spreadsheet.`
      : `Use file_read(path="${question.file_path}") to read the attached file.`;

    questionText += `\n\n[ATTACHMENT: ${question.file_name ?? question.file_path}]\n${toolHint}`;
  }

  return gaiaPreamble + questionText;
}

// ---------------------------------------------------------------------------
// Smoke runner
// ---------------------------------------------------------------------------

const SONNET_INPUT_COST_PER_M = 3.0;
const SONNET_OUTPUT_COST_PER_M = 15.0;

/**
 * Run all 5 SMOKE_FIXTURE questions through the CodeAgent harness.
 * Pass criteria: ≥3/5 correct (60%).
 */
export async function runCodeAgentSmokeTest(opts: {
  verbose?: boolean;
  apiKey?: string;
  model?: string;
} = {}): Promise<{ passRate: number; passed: number; total: number }> {
  const { verbose = true, apiKey, model = DEFAULT_MODEL } = opts;

  if (verbose) {
    console.log('\n=== GAIA CodeAgent Smoke Test (ADR-138 iter 54) ===');
    console.log(`Model: ${model}`);
    console.log(`Questions: ${SMOKE_FIXTURE.length}\n`);
  }

  let passed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const question of SMOKE_FIXTURE) {
    const result = await runGaiaCodeAgent(question, { model, apiKey, verbose });

    const correct =
      result.finalAnswer !== null &&
      isAnswerCorrect(result.finalAnswer, question.final_answer);

    if (correct) passed++;
    totalInputTokens += result.totalInputTokens;
    totalOutputTokens += result.totalOutputTokens;

    if (verbose) {
      const status = correct ? 'PASS' : 'FAIL';
      console.log(`[${status}] ${question.task_id}: ${question.question.slice(0, 60)}`);
      console.log(
        `       Expected: "${question.final_answer}" | Got: "${result.finalAnswer ?? 'null'}"`,
      );
      console.log(
        `       Turns: ${result.turns} | Replans: ${result.replanCount} ` +
        `| Tools: ${JSON.stringify(result.toolCallsByName)} | Wall: ${result.wallMs}ms`,
      );
      if (result.error) console.log(`       Error: ${result.error}`);
      console.log();
    }
  }

  const passRate = passed / SMOKE_FIXTURE.length;
  const estCost =
    (totalInputTokens / 1_000_000) * SONNET_INPUT_COST_PER_M +
    (totalOutputTokens / 1_000_000) * SONNET_OUTPUT_COST_PER_M;

  if (verbose) {
    console.log('=== Summary ===');
    console.log(`Pass rate: ${passed}/${SMOKE_FIXTURE.length} (${(passRate * 100).toFixed(0)}%)`);
    console.log(`Status:    ${passed >= 3 ? 'SMOKE PASSED' : 'SMOKE FAILED'}`);
    console.log(`Tokens in: ${totalInputTokens.toLocaleString()}`);
    console.log(`Tokens out: ${totalOutputTokens.toLocaleString()}`);
    console.log(`Est. cost: $${estCost.toFixed(4)} (Sonnet pricing)`);
    console.log();
  }

  return { passRate, passed, total: SMOKE_FIXTURE.length };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (process.argv.includes('--smoke')) {
  runCodeAgentSmokeTest({ verbose: true })
    .then(({ passed }) => {
      process.exit(passed >= 3 ? 0 : 1);
    })
    .catch((err) => {
      console.error('CodeAgent smoke test crashed:', err);
      process.exit(2);
    });
}
