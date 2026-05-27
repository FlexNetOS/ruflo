/**
 * gaia-tools barrel — ADR-133-PR2
 *
 * Exports all tool implementations + shared types so that gaia-agent.ts
 * (PR-3) and future tools (PR-4: python_exec, PR-5: web_browse) can import
 * from a single entry point.
 *
 * Refs: ADR-133, #2156
 */

export * from './types.js';
export * from './web_search.js';
export * from './file_read.js';

import { createWebSearchTool } from './web_search.js';
import { createFileReadTool } from './file_read.js';
import type { GaiaToolCatalogue } from './types.js';

/**
 * Returns the default tool catalogue for a GAIA Level-1 run.
 *
 * PR-2 catalogue: web_search + file_read
 * PR-4 will add: python_exec (E2B sandbox)
 * PR-5 will add: web_browse, image_describe
 */
export function createDefaultToolCatalogue(): GaiaToolCatalogue {
  return [createWebSearchTool(), createFileReadTool()];
}
