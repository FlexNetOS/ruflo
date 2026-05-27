/**
 * KG Multi-Hop Reasoning — ADR-135 Track H
 *
 * For GAIA questions that require multi-hop relational reasoning
 * ("what is the connection between X and Y"), traverse ruflo's
 * AgentDB graph backend via Cypher rather than relying on LLM
 * chain-of-thought. Graph traversal either finds the path or it
 * doesn't — it doesn't accumulate errors across hops the way a
 * free-form LLM chain does.
 *
 * Honest framing (post-iter-41):
 *   - HAL = 82.07% on 53-Q L1
 *   - Ruflo iter-35 = 49.1%  (gap = 33pp)
 *   - Track H doesn't close that gap on standard benchmarks
 *   - Track H gives ruflo a DETERMINISTIC primitive for multi-hop
 *     questions that HAL's LLM chain structurally cannot match
 *   - Real lift estimate: +2-5pp on multi-hop subset (~30% of L1)
 *
 * Graceful degradation throughout: module works even when ruflo's
 * KG infrastructure is not initialized — returns null/empty rather
 * than crashing, allowing the agent to fall back to LLM chain.
 *
 * NOT integrated into gaia-agent.ts yet. Wiring is a follow-up PR.
 *
 * Plugin sync TODO: when wiring, add --kg-reasoning flag to
 * plugins/ruflo-workflows/commands/gaia-run.md.
 *
 * Refs: ADR-135, ADR-130 (graph intelligence integration), #2156
 */

import { execSync } from 'node:child_process';
import type { GaiaQuestion } from './gaia-loader.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KGEntity {
  /** Canonical name of the entity. */
  name: string;
  /** Coarse type hint derived from context. */
  type?: 'person' | 'place' | 'date' | 'organization' | 'event' | 'concept' | string;
  /** Extraction confidence in [0, 1]. */
  confidence: number;
}

export interface KGRelation {
  subject: string;
  predicate: string;
  object: string;
  /** Path-scoring weight from AgentDB pathfinder. */
  confidence: number;
}

export interface MultiHopQuestion {
  questionText: string;
  /** Named entities extracted from the question. */
  entities: KGEntity[];
  /** Estimated number of relational steps required (1 = direct lookup, 2-3 = multi-hop). */
  inferredHops: number;
  /** Generated Cypher query, populated by buildCypherQuery(). */
  cypherQuery?: string;
}

export interface MultiHopAnswer {
  /** Final answer string (may be partial if only partial path found). */
  answer: string;
  /** The sequence of relations traversed to reach the answer. */
  path: KGRelation[];
  /** Aggregate confidence across the path edges. */
  confidence: number;
  /** Human-readable explanation of how the answer was derived. */
  reasoning: string;
  /** true if AgentDB KG resolved the path; false if fallback to LLM. */
  toolUsedKG: boolean;
}

export interface KGReasoningOptions {
  /** Maximum number of hops in the traversal (default: 3). */
  maxHops?: number;
  /** Graph backend to use (default: 'agentdb'). */
  graphBackend?: 'agentdb' | 'mock';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Keyword patterns that signal multi-hop relational questions. */
const MULTI_HOP_PATTERNS: RegExp[] = [
  /\bconnect(?:ion|ed|s)?\b/i,
  /\brelat(?:ion|ionship|ed)?\b/i,
  /\blink(?:ed)?\b/i,
  /\bfrom\s+\S+\s+to\s+\S+/i,
  /\bpath\b/i,
  /\bvia\b/i,
  /\bthrough\b/i,
  /\bhow\s+(?:did|does|do|is|was|were)\b.*\brelated\b/i,
  /\bwhat\s+(?:is|was)\s+the\s+(?:link|connection|relation)\b/i,
];

/** Very coarse proper-noun extraction (no NLP library to keep deps at zero). */
function extractProperNouns(text: string): string[] {
  // Capitalised words that are not sentence-initial and not stop words.
  const stopWords = new Set([
    'What', 'Who', 'Where', 'When', 'Why', 'How', 'Which', 'The', 'A', 'An',
    'In', 'On', 'At', 'By', 'For', 'With', 'To', 'Of', 'And', 'Or', 'But',
    'Is', 'Was', 'Are', 'Were', 'Be', 'Been', 'Have', 'Has', 'Had',
    'Did', 'Do', 'Does', 'Can', 'Could', 'Would', 'Should', 'Will',
  ]);

  const words = text.split(/\s+/);
  const results: string[] = [];

  // Collect runs of consecutive capitalised tokens (handles "New York", "Eiffel Tower").
  let run: string[] = [];
  for (let i = 1; i < words.length; i++) {   // skip index 0 — always capitalised
    const word = words[i].replace(/[^A-Za-z0-9'-]/g, '');
    if (word.length < 2) continue;
    const firstChar = word[0];
    if (firstChar >= 'A' && firstChar <= 'Z' && !stopWords.has(word)) {
      run.push(word);
    } else {
      if (run.length > 0) {
        results.push(run.join(' '));
        run = [];
      }
    }
  }
  if (run.length > 0) results.push(run.join(' '));

  return [...new Set(results)];
}

/**
 * Attempt entity extraction via ruflo's kg-extract CLI tool.
 * Returns null on any error so callers can fall back to regex.
 */
function tryKgExtractCli(questionText: string): KGEntity[] | null {
  try {
    const escaped = questionText.replace(/'/g, "'\\''");
    const raw = execSync(
      `npx @claude-flow/cli@latest kg-extract --text '${escaped}' --json 2>/dev/null`,
      { encoding: 'utf-8', timeout: 8_000 },
    ).trim();

    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;

    return (parsed as unknown[]).flatMap((item) => {
      if (
        item !== null &&
        typeof item === 'object' &&
        'name' in item &&
        typeof (item as Record<string, unknown>).name === 'string'
      ) {
        const e = item as Record<string, unknown>;
        return [{
          name: e.name as string,
          type: typeof e.type === 'string' ? e.type : undefined,
          confidence: typeof e.confidence === 'number' ? e.confidence : 0.8,
        }] satisfies KGEntity[];
      }
      return [];
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract entities and relations from a question text.
 *
 * Strategy:
 *   1. Try ruflo's kg-extract MCP tool (full NER pipeline).
 *   2. Fall back to regex proper-noun extraction when KG unavailable.
 *
 * Returns entities with confidence scores and an empty relations array
 * (relation extraction from a single question is out of scope for Track H;
 * relations are discovered by the Cypher traversal itself).
 */
export async function extractEntitiesAndRelations(
  questionText: string,
): Promise<{ entities: KGEntity[]; relations: KGRelation[] }> {
  // Try the full CLI pipeline first.
  const cliEntities = tryKgExtractCli(questionText);
  if (cliEntities !== null && cliEntities.length > 0) {
    return { entities: cliEntities, relations: [] };
  }

  // Fallback: regex proper-noun extraction.
  const nouns = extractProperNouns(questionText);
  const entities: KGEntity[] = nouns.map((name) => ({
    name,
    type: undefined,
    confidence: 0.6,  // lower confidence for regex fallback
  }));

  // Also capture bare year patterns as date entities.
  const yearMatches = questionText.match(/\b(1[0-9]{3}|20[0-9]{2})\b/g) ?? [];
  for (const year of yearMatches) {
    if (!entities.some((e) => e.name === year)) {
      entities.push({ name: year, type: 'date', confidence: 0.9 });
    }
  }

  return { entities, relations: [] };
}

/**
 * Classify whether a question requires multi-hop KG traversal.
 *
 * Returns null for single-entity or factoid questions (let the agent's
 * LLM chain handle those). Returns a MultiHopQuestion for questions
 * matching multi-hop patterns with 2+ extractable named entities.
 */
export function isMultiHopQuestion(questionText: string): MultiHopQuestion | null {
  // Quick path — must match at least one multi-hop pattern.
  const matchesPattern = MULTI_HOP_PATTERNS.some((re) => re.test(questionText));
  if (!matchesPattern) return null;

  // Must have at least two capitalised named entities (heuristic).
  const nouns = extractProperNouns(questionText);
  if (nouns.length < 2) return null;

  const entities: KGEntity[] = nouns.map((name) => ({
    name,
    confidence: 0.7,
  }));

  // Estimate hop count from keyword semantics.
  const hops =
    /\bvia\b|\bthrough\b/i.test(questionText) ? 3
    : /\bfrom\s+\S+\s+to\s+\S+/i.test(questionText) ? 2
    : 2;

  return {
    questionText,
    entities,
    inferredHops: hops,
  };
}

/**
 * Generate a conservative Cypher MATCH query for a multi-hop question.
 *
 * Pattern:
 *   MATCH p = (a)-[*1..N]->(b)
 *   WHERE toLower(a.name) CONTAINS toLower($aName)
 *     AND toLower(b.name) CONTAINS toLower($bName)
 *   RETURN p, relationships(p) AS rels
 *   ORDER BY length(p) ASC
 *   LIMIT 5
 *
 * Uses the first two entities as anchors. For 3+ entities, adds
 * intermediate waypoint constraints as additional MATCH clauses.
 */
export function buildCypherQuery(question: MultiHopQuestion): string {
  const maxHops = question.inferredHops + 1;  // +1 to allow slightly longer paths
  const entities = question.entities.slice(0, 3);  // cap at 3 anchors

  if (entities.length < 2) {
    // Single-entity fallback — neighbourhood query.
    const name = entities[0]?.name ?? '';
    return (
      `MATCH (n)-[r]->(m)\n` +
      `WHERE toLower(n.name) CONTAINS toLower('${name.replace(/'/g, "\\'")}')\n` +
      `RETURN n, r, m\n` +
      `LIMIT 10`
    );
  }

  const aName = entities[0].name.replace(/'/g, "\\'");
  const bName = entities[1].name.replace(/'/g, "\\'");

  let query =
    `MATCH p = (a)-[*1..${maxHops}]->(b)\n` +
    `WHERE toLower(a.name) CONTAINS toLower('${aName}')\n` +
    `  AND toLower(b.name) CONTAINS toLower('${bName}')\n`;

  if (entities.length >= 3) {
    const cName = entities[2].name.replace(/'/g, "\\'");
    query +=
      `WITH p, nodes(p) AS ns\n` +
      `WHERE any(n IN ns WHERE toLower(n.name) CONTAINS toLower('${cName}'))\n`;
  }

  query +=
    `RETURN p, relationships(p) AS rels\n` +
    `ORDER BY length(p) ASC\n` +
    `LIMIT 5`;

  return query;
}

/**
 * Execute a Cypher query against AgentDB's graph backend.
 *
 * Uses ruflo's agentdb-cypher CLI tool. Falls back to an empty result
 * set (with a warning) when AgentDB is unavailable, so the caller can
 * gracefully switch to LLM chain reasoning.
 */
export async function executeCypherTraversal(
  query: string,
  options: KGReasoningOptions = {},
): Promise<{ paths: KGRelation[][]; cost: number }> {
  const backend = options.graphBackend ?? 'agentdb';

  // Mock backend — used in unit tests to avoid spinning up AgentDB.
  if (backend === 'mock') {
    return {
      paths: [
        [
          { subject: 'Entity A', predicate: 'CONNECTED_TO', object: 'Entity B', confidence: 0.9 },
          { subject: 'Entity B', predicate: 'PART_OF', object: 'Entity C', confidence: 0.85 },
        ],
      ],
      cost: 1,
    };
  }

  // Real AgentDB traversal via CLI.
  try {
    const escaped = query.replace(/'/g, "'\\''").replace(/\n/g, ' ');
    const raw = execSync(
      `npx @claude-flow/cli@latest agentdb-cypher --query '${escaped}' --json 2>/dev/null`,
      { encoding: 'utf-8', timeout: 15_000 },
    ).trim();

    if (!raw) return { paths: [], cost: 0 };

    const result = JSON.parse(raw) as unknown;
    if (!result || typeof result !== 'object') return { paths: [], cost: 0 };

    const r = result as Record<string, unknown>;
    const rawPaths = Array.isArray(r.paths) ? (r.paths as unknown[]) : [];
    const cost = typeof r.cost === 'number' ? r.cost : rawPaths.length;

    const paths: KGRelation[][] = rawPaths.flatMap((pathItem) => {
      if (!Array.isArray(pathItem)) return [];
      const rels: KGRelation[] = (pathItem as unknown[]).flatMap((rel) => {
        if (
          rel !== null &&
          typeof rel === 'object' &&
          'subject' in rel &&
          'predicate' in rel &&
          'object' in rel
        ) {
          const r2 = rel as Record<string, unknown>;
          return [{
            subject: String(r2.subject),
            predicate: String(r2.predicate),
            object: String(r2.object),
            confidence: typeof r2.confidence === 'number' ? r2.confidence : 0.8,
          }] satisfies KGRelation[];
        }
        return [];
      });
      return rels.length > 0 ? [rels] : [];
    });

    return { paths, cost };
  } catch {
    // AgentDB not available — return empty rather than crashing.
    return { paths: [], cost: 0 };
  }
}

/**
 * High-level wrapper: given a GAIA question, attempt multi-hop KG reasoning.
 *
 * Pipeline:
 *   1. Classify question with isMultiHopQuestion().
 *   2. If not multi-hop → return null (let agent handle via LLM chain).
 *   3. Extract entities (CLI or regex fallback).
 *   4. Build Cypher query.
 *   5. Execute traversal against AgentDB.
 *   6. If paths found → synthesize answer from path.
 *   7. If no paths → return null (graceful fallback).
 *
 * Returns null when the question is atomic or when the KG can't resolve it,
 * so the caller always has a clean signal to fall back to LLM chain.
 */
export async function answerMultiHopQuestion(
  question: GaiaQuestion,
  options: KGReasoningOptions = {},
): Promise<MultiHopAnswer | null> {
  const questionText = question.question;

  // Step 1: classify.
  const mhq = isMultiHopQuestion(questionText);
  if (mhq === null) return null;

  // Step 2: enrich entities from full extractor (may have better NER).
  const { entities } = await extractEntitiesAndRelations(questionText);
  const enriched: MultiHopQuestion = {
    ...mhq,
    entities: entities.length >= 2 ? entities : mhq.entities,
  };

  // Step 3: build Cypher.
  const cypher = buildCypherQuery(enriched);
  enriched.cypherQuery = cypher;

  // Step 4: execute.
  const { paths, cost } = await executeCypherTraversal(cypher, options);

  if (paths.length === 0) {
    // KG traversal found nothing — signal caller to use LLM fallback.
    return null;
  }

  // Step 5: synthesize answer from the shortest path (first result).
  const bestPath = paths[0];
  const pathConfidence =
    bestPath.reduce((acc, rel) => acc * rel.confidence, 1.0);

  // Build a human-readable chain: "A --[PRED]--> B --[PRED]--> C"
  const chainStr = bestPath
    .map((rel) => `${rel.subject} -[${rel.predicate}]-> ${rel.object}`)
    .join(' => ');

  // The answer is the terminal node of the best path.
  const terminalNode = bestPath[bestPath.length - 1].object;

  const reasoning =
    `KG traversal (${bestPath.length} hop${bestPath.length === 1 ? '' : 's'}, ` +
    `cost=${cost}): ${chainStr}`;

  return {
    answer: terminalNode,
    path: bestPath,
    confidence: pathConfidence,
    reasoning,
    toolUsedKG: true,
  };
}
