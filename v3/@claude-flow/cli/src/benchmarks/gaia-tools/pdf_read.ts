/**
 * GAIA Tool: pdf_read — ADR-138 iter 54
 *
 * Extracts text content from a PDF file using a Python subprocess.
 * GAIA L1 has ~20-30% of questions with PDF attachments; without this,
 * ruflo is functionally blind on those questions.
 *
 * Extraction chain (tries in order, returns first success):
 *   1. pdfminer.six  — best quality, handles most text PDFs
 *   2. pdfplumber    — good alternative, especially for tables
 *   3. PyPDF2/pypdf  — fallback, lower quality but widely available
 *   4. pdftotext     — CLI tool (poppler-utils), if installed
 *   5. Stub          — returns a note that extraction failed
 *
 * For image-only (scanned) PDFs, all text extractors return empty.
 * In that case we return a note so the agent can try describe_image.
 *
 * Refs: ADR-138, #2156, iter 54
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { GaiaTool, ToolDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract PDF text using Python pdfminer.six (best quality).
 */
function extractViaPdfminer(filePath: string): string {
  const script = `
import sys
try:
    from pdfminer.high_level import extract_text
    text = extract_text(sys.argv[1])
    print(text[:12000] if text else '')
except ImportError:
    print('[pdfminer_not_installed]')
except Exception as e:
    print('[pdfminer_error:' + str(e) + ']')
`.trim();

  try {
    const out = execFileSync('python3', ['-', filePath], {
      input: script,
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    if (out && !out.startsWith('[pdfminer_not_installed]') && !out.startsWith('[pdfminer_error:')) {
      return out;
    }
  } catch { /* fall through */ }
  return '';
}

/**
 * Try to extract PDF text using pdfplumber (good for tables).
 */
function extractViaPdfplumber(filePath: string): string {
  const script = `
import sys
try:
    import pdfplumber
    with pdfplumber.open(sys.argv[1]) as pdf:
        texts = []
        for page in pdf.pages:
            t = page.extract_text()
            if t:
                texts.append(t)
        print('\\n\\n'.join(texts)[:12000])
except ImportError:
    print('[pdfplumber_not_installed]')
except Exception as e:
    print('[pdfplumber_error:' + str(e) + ']')
`.trim();

  try {
    const out = execFileSync('python3', ['-', filePath], {
      input: script,
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    if (out && !out.startsWith('[pdfplumber_not_installed]') && !out.startsWith('[pdfplumber_error:')) {
      return out;
    }
  } catch { /* fall through */ }
  return '';
}

/**
 * Try to extract PDF text using pypdf (widely available, lower quality).
 */
function extractViaPypdf(filePath: string): string {
  const script = `
import sys
try:
    try:
        import pypdf as pdf_lib
    except ImportError:
        import PyPDF2 as pdf_lib
    with open(sys.argv[1], 'rb') as f:
        reader = pdf_lib.PdfReader(f)
        texts = []
        for page in reader.pages:
            t = page.extract_text()
            if t:
                texts.append(t)
        print('\\n\\n'.join(texts)[:12000])
except ImportError:
    print('[pypdf_not_installed]')
except Exception as e:
    print('[pypdf_error:' + str(e) + ']')
`.trim();

  try {
    const out = execFileSync('python3', ['-', filePath], {
      input: script,
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    if (out && !out.startsWith('[pypdf_not_installed]') && !out.startsWith('[pypdf_error:')) {
      return out;
    }
  } catch { /* fall through */ }
  return '';
}

/**
 * Try to extract PDF text using the `pdftotext` CLI tool (poppler-utils).
 */
function extractViaPdftotext(filePath: string): string {
  try {
    const out = execFileSync('pdftotext', [filePath, '-'], {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    return out.slice(0, 12000);
  } catch { /* fall through */ }
  return '';
}

// ---------------------------------------------------------------------------
// Path validation (mirrors file_read.ts)
// ---------------------------------------------------------------------------

function validatePdfPath(filePath: string): void {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('pdf_read: `path` must be a non-empty string.');
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error(`pdf_read: path must be absolute. Got: "${filePath}".`);
  }
  if (filePath.includes('\0')) {
    throw new Error('pdf_read: path contains null byte — rejected.');
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.pdf') {
    throw new Error(`pdf_read: expected a .pdf file, got extension "${ext}". Use file_read for other formats.`);
  }
}

// ---------------------------------------------------------------------------
// GaiaTool implementation
// ---------------------------------------------------------------------------

export class PdfReadTool implements GaiaTool {
  readonly name = 'pdf_read';

  readonly definition: ToolDefinition = {
    name: 'pdf_read',
    description:
      'Extract text content from a PDF file. ' +
      'Path must be absolute. ' +
      'Tries pdfminer.six, pdfplumber, pypdf, and pdftotext in order. ' +
      'Returns extracted text or a note if the PDF is image-only (scanned). ' +
      `Output truncated to ${MAX_OUTPUT_CHARS} characters.`,
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the PDF file.',
        },
      },
      required: ['path'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<string> {
    const filePath = String(input['path'] ?? '').trim();
    validatePdfPath(filePath);

    // Check existence
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error(`pdf_read: "${filePath}" is not a regular file.`);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') throw new Error(`pdf_read: file not found: ${filePath}`);
      throw e;
    }

    const filename = path.basename(filePath);

    // Try extractors in order
    let text = extractViaPdfminer(filePath);
    if (!text) text = extractViaPdfplumber(filePath);
    if (!text) text = extractViaPypdf(filePath);
    if (!text) text = extractViaPdftotext(filePath);

    if (!text || text.length < 20) {
      return (
        `[PDF: ${filename}]\n` +
        `Text extraction returned no content. This may be a scanned/image-only PDF.\n` +
        `If the PDF contains images, consider using describe_image on specific pages.\n` +
        `File: ${filePath}`
      );
    }

    const truncated = text.length > MAX_OUTPUT_CHARS;
    const output = text.slice(0, MAX_OUTPUT_CHARS);
    return (
      `[PDF: ${filename}]\n\n${output}` +
      (truncated ? `\n\n[... truncated at ${MAX_OUTPUT_CHARS} chars ...]` : '')
    );
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

export function createPdfReadTool(): PdfReadTool {
  return new PdfReadTool();
}
