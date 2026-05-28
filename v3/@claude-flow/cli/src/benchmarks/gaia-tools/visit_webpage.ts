/**
 * GAIA Tool: visit_webpage — ADR-138 iter 54
 *
 * Fetches a URL and returns the full page content as clean plain text.
 * This is the highest-leverage missing tool — HAL's visit_webpage is responsible
 * for ~25-35% of L1 question coverage (Wikipedia, government sites, reference pages).
 *
 * Implementation:
 * - Uses Node.js built-in fetch (Node 22 — no external dep)
 * - Strips HTML tags via a Python subprocess (requests + bs4.get_text) which
 *   handles encoding properly and is already available in the benchmark env.
 * - Falls back to pure-regex HTML stripping if Python subprocess fails.
 * - Truncates output to 8000 chars (enough for most reference articles;
 *   prevents context overflow).
 *
 * Refs: ADR-138, #2156, iter 54
 */

import { execFileSync } from 'node:child_process';
import { GaiaTool, ToolDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 8_000;
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// HTML extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract readable text from HTML using Python bs4.
 * bs4.get_text() handles encoding, strips scripts/styles, respects structure.
 */
function extractTextViaPython(html: string): string {
  const script = `
import sys, re
from bs4 import BeautifulSoup

html = sys.stdin.read()
soup = BeautifulSoup(html, 'html.parser')

# Remove scripts, styles, nav, footer
for tag in soup(['script', 'style', 'nav', 'footer', 'header', 'aside']):
    tag.decompose()

text = soup.get_text(separator='\\n', strip=True)
# Collapse multiple blank lines
text = re.sub(r'\\n{3,}', '\\n\\n', text)
print(text[:12000])
`.trim();

  try {
    return execFileSync('python3', ['-'], {
      input: script + '\n',
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Fallback: strip HTML tags with regex (no external dep, less accurate).
 */
function extractTextViaRegex(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Page fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch a URL and return the response HTML as a string.
 * Uses Node.js built-in fetch (Node 18+).
 */
async function fetchPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`visit_webpage: HTTP ${res.status} for ${url}`);
  }

  // Guard against non-HTML content types (PDFs, binary files)
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/pdf')) {
    throw new Error(
      `visit_webpage: URL returns a PDF. Use file_read with the downloaded path instead. URL: ${url}`,
    );
  }

  return await res.text();
}

// ---------------------------------------------------------------------------
// GaiaTool implementation
// ---------------------------------------------------------------------------

export class VisitWebpageTool implements GaiaTool {
  readonly name = 'visit_webpage';

  readonly definition: ToolDefinition = {
    name: 'visit_webpage',
    description:
      'Fetch the full text content of a webpage URL. ' +
      'Returns the readable text stripped of HTML, scripts, and navigation. ' +
      'Use after web_search to read the full content of a promising result. ' +
      `Output is truncated to ${MAX_OUTPUT_CHARS} characters.`,
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to fetch (must start with http:// or https://).',
        },
      },
      required: ['url'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<string> {
    const url = String(input['url'] ?? '').trim();
    if (!url) throw new Error('visit_webpage: `url` input is required.');
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new Error(`visit_webpage: URL must start with http:// or https://. Got: "${url}"`);
    }

    const html = await fetchPage(url);

    // Try Python extraction first (better quality), fall back to regex
    let text = extractTextViaPython(html);
    if (!text || text.length < 50) {
      text = extractTextViaRegex(html);
    }

    if (!text || text.length < 20) {
      return `[visit_webpage: page at ${url} returned no readable text content]`;
    }

    const truncated = text.length > MAX_OUTPUT_CHARS;
    const output = text.slice(0, MAX_OUTPUT_CHARS);
    return `[Page: ${url}]\n\n${output}${truncated ? `\n\n[... truncated at ${MAX_OUTPUT_CHARS} chars ...]` : ''}`;
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

export function createVisitWebpageTool(): VisitWebpageTool {
  return new VisitWebpageTool();
}
