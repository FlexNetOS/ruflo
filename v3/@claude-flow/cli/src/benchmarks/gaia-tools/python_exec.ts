/**
 * GAIA Tool: python_exec — ADR-138 iter 54
 *
 * Executes a Python code snippet in a constrained subprocess and returns
 * stdout. This is the second-highest-leverage missing tool — HAL's
 * python_interpreter covers computation, data manipulation, and string
 * processing that the LLM cannot reliably do in prose.
 *
 * Design:
 * - Runs `python3 -c "..."` via execFileSync (NOT shell=true — avoids injection)
 * - The agent's code is injected directly; stdout is captured and returned.
 * - Pre-amble imports: math, datetime, json, re, collections, itertools,
 *   statistics, urllib.parse, fractions, decimal, operator — no requests/bs4
 *   (those are for visit_webpage, not computation).
 * - Timeout: 30s
 * - Output capped at 4000 chars.
 *
 * Security note: This runs in our controlled benchmark environment against
 * known GAIA questions. We accept the subprocess risk in that context.
 * For production agent sandboxing, use a proper E2B/Firecracker sandbox.
 *
 * Refs: ADR-138, #2156, iter 54
 */

import { execFileSync } from 'node:child_process';
import { GaiaTool, ToolDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 4_000;

/**
 * Authorized imports pre-loaded into the execution preamble.
 * Mirrors HAL's additional_authorized_imports list (HAL-DEEP-STUDY.md §3.2).
 */
const PREAMBLE = `
import math
import re
import json
import datetime
from datetime import date, timedelta
from collections import Counter, defaultdict, OrderedDict
import itertools
import statistics
import fractions
import decimal
import operator
from urllib.parse import urlparse, quote, unquote
import string
import unicodedata
import sys
import os.path

# pandas/scipy/sympy optional — handle ImportError gracefully
try:
    import pandas as pd
    import numpy as np
except ImportError:
    pd = None
    np = None

try:
    import sympy
except ImportError:
    sympy = None
`.trim();

// ---------------------------------------------------------------------------
// Execution helper
// ---------------------------------------------------------------------------

/**
 * Run a Python snippet and return its stdout.
 * The preamble is prepended so agent code can use math/datetime/etc directly.
 */
export function runPythonSnippet(code: string): string {
  const fullCode = `${PREAMBLE}\n\n${code}`;

  let stdout: string;
  try {
    stdout = execFileSync('python3', ['-c', fullCode], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
  } catch (err: unknown) {
    if (err instanceof Error && 'stderr' in err) {
      const execErr = err as { stderr?: string; message: string };
      const stderr = (execErr.stderr ?? '').trim();
      const msg = err.message ?? '';
      // Timeout
      if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
        return `[python_exec: timed out after ${EXEC_TIMEOUT_MS / 1000}s]`;
      }
      if (stderr) {
        return `[python_exec error]\n${stderr.slice(0, 1000)}`;
      }
    }
    return `[python_exec error: ${String(err)}]`;
  }

  const result = stdout.trim();
  if (result.length > MAX_OUTPUT_CHARS) {
    return result.slice(0, MAX_OUTPUT_CHARS) + `\n[... truncated at ${MAX_OUTPUT_CHARS} chars ...]`;
  }
  return result || '[python_exec: no output]';
}

// ---------------------------------------------------------------------------
// GaiaTool implementation
// ---------------------------------------------------------------------------

export class PythonExecTool implements GaiaTool {
  readonly name = 'python_exec';

  readonly definition: ToolDefinition = {
    name: 'python_exec',
    description:
      'Execute a Python code snippet and return the stdout output. ' +
      'Use for: arithmetic, date calculations, string manipulation, list operations, ' +
      'statistical computations, data conversions, unit conversions. ' +
      'Pre-imported: math, datetime, re, json, collections, itertools, statistics, fractions, ' +
      'decimal, string, unicodedata, urllib.parse. ' +
      'pandas/numpy/sympy available if installed. ' +
      'Use print() to output results. Timeout: 30s.',
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Python code to execute. Use print() to produce output.',
        },
      },
      required: ['code'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<string> {
    const code = String(input['code'] ?? '').trim();
    if (!code) throw new Error('python_exec: `code` input is required and must be non-empty.');
    return runPythonSnippet(code);
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

export function createPythonExecTool(): PythonExecTool {
  return new PythonExecTool();
}
