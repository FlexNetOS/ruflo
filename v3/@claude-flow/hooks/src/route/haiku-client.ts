/**
 * Concrete HaikuClient implementation — ADR-132
 *
 * Calls the Anthropic Messages API using `fetch` (no SDK dependency).
 * API key resolution order:
 *   1. Explicit `apiKey` option passed to the factory.
 *   2. `ANTHROPIC_API_KEY` environment variable.
 *   3. GCP Secret Manager via `gcloud secrets versions access latest
 *      --secret=ANTHROPIC_API_KEY` (uppercase — aligns with iter-7 fix).
 *
 * This is the live implementation; tests inject mock HaikuClient instances
 * (the interface from simulative-planning-router.ts) to avoid network calls.
 *
 * @module @claude-flow/hooks/route/haiku-client
 */

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { HaikuClient } from './simulative-planning-router.js';

const exec = promisify(execCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HaikuClientOptions {
  /** Explicit API key. Overrides env + GCP fallback when provided. */
  apiKey?: string;
  /** Anthropic model identifier. Defaults to `claude-haiku-4-5`. */
  model?: string;
  /** Request timeout in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicResponse {
  content?: AnthropicTextBlock[];
  error?: { message?: string };
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Anthropic API key from the available sources, in priority order.
 * Returns null if no key can be found (callers should surface a clear error).
 */
async function resolveApiKey(explicit?: string): Promise<string | null> {
  // 1. Caller-supplied value.
  if (explicit) return explicit;

  // 2. Environment variable.
  const fromEnv = process.env['ANTHROPIC_API_KEY'];
  if (fromEnv) return fromEnv;

  // 3. GCP Secret Manager (best-effort; fails silently if gcloud is absent).
  try {
    const { stdout } = await exec(
      'gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY',
      { timeout: 5_000 },
    );
    const trimmed = stdout.trim();
    if (trimmed) return trimmed;
  } catch {
    // gcloud not available or secret not found — continue.
  }

  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `HaikuClient` backed by the Anthropic Messages API.
 *
 * @example
 * ```ts
 * const client = await createHaikuClient({ timeoutMs: 15_000 });
 * const reply = await client.complete('Outline 5 steps for X', { maxTokens: 256 });
 * ```
 */
export async function createHaikuClient(
  options: HaikuClientOptions = {},
): Promise<HaikuClient> {
  const {
    apiKey: explicitKey,
    model = 'claude-haiku-4-5',
    timeoutMs = 30_000,
  } = options;

  const apiKey = await resolveApiKey(explicitKey);
  if (!apiKey) {
    throw new Error(
      'HaikuClient: no API key found. ' +
        'Set ANTHROPIC_API_KEY env var, pass apiKey option, or ' +
        'ensure gcloud has access to the ANTHROPIC_API_KEY secret.',
    );
  }

  return {
    async complete(prompt: string, opts: { maxTokens: number }): Promise<string> {
      const body: AnthropicRequest = {
        model,
        max_tokens: opts.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const json = (await response.json()) as AnthropicResponse;

      if (!response.ok || json.error) {
        throw new Error(
          `HaikuClient: API error ${response.status}: ` +
            (json.error?.message ?? 'unknown error'),
        );
      }

      const textBlock = json.content?.find((b) => b.type === 'text');
      if (!textBlock) {
        throw new Error('HaikuClient: response contained no text block');
      }
      return textBlock.text;
    },
  };
}
