/**
 * gaia-tools barrel — ADR-133-PR2 / ADR-138 iter 54
 *
 * Exports all tool implementations + shared types so that gaia-agent.ts
 * (PR-3) and gaia-codeagent.ts (ADR-138) can import from a single entry point.
 *
 * iter-47 fix: re-added grounded_query which was absent from the integration
 * branch because feat/adr-135-grounded-query-gemini was never cherry-picked
 * during Track A/B/D/E/Q integration (iter-42 measured −36pp / 13.2%).
 *
 * iter-54 adds: visit_webpage, python_exec, pdf_read (HAL tool parity).
 *
 * Refs: ADR-133, ADR-135, ADR-138, #2156
 */

export * from './types.js';
export * from './web_search.js';
export * from './file_read.js';
export * from './grounded_query.js';
export * from './visit_webpage.js';
export * from './python_exec.js';
export * from './pdf_read.js';

import { createWebSearchTool } from './web_search.js';
import { createFileReadTool } from './file_read.js';
import { createGroundedQueryTool } from './grounded_query.js';
import { createVisitWebpageTool } from './visit_webpage.js';
import { createPythonExecTool } from './python_exec.js';
import { createPdfReadTool } from './pdf_read.js';
import type { GaiaToolCatalogue } from './types.js';

/**
 * Returns the default tool catalogue for a GAIA Level-1 run (ToolCallingAgent).
 *
 * PR-2 catalogue: web_search + file_read
 * iter-33 adds:   grounded_query (Gemini 2.5 Flash grounding — pre-synthesised answer + citations)
 *
 * Both web_search and grounded_query are registered so the agent can choose:
 *   - grounded_query: for factoid questions needing a clean answer with citations (1 call)
 *   - web_search: for questions needing raw snippets or source page reading (multi-backend)
 */
export function createDefaultToolCatalogue(): GaiaToolCatalogue {
  return [createWebSearchTool(), createFileReadTool(), createGroundedQueryTool()];
}

/**
 * Returns the extended tool catalogue for CodeAgent (ADR-138 iter 54).
 *
 * Adds visit_webpage, python_exec, and pdf_read on top of the default set.
 * These tools are consumed by gaia-codeagent-runner.py, not the TypeScript
 * agent loop directly — the catalogue is registered so the system prompt
 * can enumerate them.
 */
export function createCodeAgentToolCatalogue(): GaiaToolCatalogue {
  return [
    createWebSearchTool(),
    createGroundedQueryTool(),
    createVisitWebpageTool(),
    createFileReadTool(),
    createPythonExecTool(),
    createPdfReadTool(),
  ];
}
