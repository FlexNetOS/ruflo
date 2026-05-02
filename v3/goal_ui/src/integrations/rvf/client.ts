/**
 * Browser-side RVF client — IndexedDB-backed key-value + vector store.
 *
 * Singleton `RvfClient`. Mirrors the public surface of
 * `IMemoryBackend` from `@claude-flow/memory` so server and browser
 * stay format-compatible. Operations:
 *
 *   put(key, value, opts?)      - upsert
 *   get(key, opts?)             - by key
 *   delete(key, opts?)          - by key
 *   list(opts?)                 - all entries (filtered)
 *   searchByVector(vec, opts?)  - top-k cosine similarity
 *   exportRvf()                 - serialize whole store to RVF v1 binary
 *   importRvf(buf)              - load from RVF v1 binary
 *   clear()                     - drop all entries (test harness)
 *
 * Storage:
 *   IndexedDB database `ruflo-research-rvf`
 *   ObjectStore     `entries` keyed by `id` (UUID v4)
 *   Index           `key`         non-unique
 *   Index           `namespace`   non-unique
 *
 * Vectors live with the entry. Cosine search loads ALL entries into
 * memory (per `searchByVector` in search.ts) — fine for ≤10K entries
 * (~15MB at 384-dim fp32). Future: a separate HNSW index ObjectStore.
 */

import { openDB, type IDBPDatabase } from 'idb';
import {
  decodeRvf,
  encodeRvf,
  DEFAULT_DIMENSIONS,
  VERSION,
  MAGIC,
  type RvfEntry,
  type RvfFile,
  type Metric,
  type Quantization,
} from './format';
import { searchByVector, type SearchHit, type SearchOptions } from './search';

const DB_NAME = 'ruflo-research-rvf';
const DB_VERSION = 1;
const STORE = 'entries';

interface RvfDbSchema {
  entries: {
    key: string; // id
    value: RvfEntry;
    indexes: { 'key': string; 'namespace': string };
  };
}

let dbPromise: Promise<IDBPDatabase<RvfDbSchema>> | null = null;

async function getDb(): Promise<IDBPDatabase<RvfDbSchema>> {
  if (dbPromise) return dbPromise;
  dbPromise = openDB<RvfDbSchema>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('key', 'key', { unique: false });
        store.createIndex('namespace', 'namespace', { unique: false });
      }
    },
  });
  return dbPromise;
}

export interface PutOptions {
  /** Caller-supplied lookup key. Defaults to a generated UUID. */
  key?: string;
  /** Logical namespace. Default 'default'. */
  namespace?: string;
  /** Optional pre-computed vector. */
  vector?: Float32Array;
  /** Optional metadata. */
  metadata?: Record<string, unknown>;
  /** Override id (for migration / re-import). */
  id?: string;
}

export interface GetOptions {
  namespace?: string;
}

export interface ListOptions {
  namespace?: string;
  limit?: number;
}

/** Generate a UUID v4 — uses crypto.randomUUID where available. */
function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: not crypto-secure but good enough for a non-secret id.
  let out = '';
  for (let i = 0; i < 32; i++) {
    if (i === 8 || i === 12 || i === 16 || i === 20) out += '-';
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

export class RvfClient {
  /**
   * Upsert an entry. If `key` is given AND a row already exists with
   * the same key in the same namespace, that row is updated; otherwise
   * a new row is inserted with a fresh id.
   *
   * Returns the inserted/updated entry.
   */
  async put(value: unknown, opts: PutOptions = {}): Promise<RvfEntry> {
    const db = await getDb();
    const namespace = opts.namespace ?? 'default';
    const now = Date.now();

    // Try to find an existing row by (key, namespace).
    let existing: RvfEntry | undefined;
    if (opts.key !== undefined) {
      const tx = db.transaction(STORE, 'readonly');
      const idx = tx.store.index('key');
      let cursor = await idx.openCursor(opts.key);
      while (cursor) {
        if (cursor.value.namespace === namespace) {
          existing = cursor.value;
          break;
        }
        cursor = await cursor.continue();
      }
      await tx.done;
    }

    const entry: RvfEntry = {
      id: opts.id ?? existing?.id ?? uuid(),
      key: opts.key ?? existing?.key ?? uuid(),
      namespace,
      value,
      vector: opts.vector,
      metadata: opts.metadata,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await db.put(STORE, entry);
    return entry;
  }

  /** Lookup by caller-supplied key. Returns undefined if not found. */
  async get(key: string, opts: GetOptions = {}): Promise<RvfEntry | undefined> {
    const db = await getDb();
    const namespace = opts.namespace ?? 'default';
    const tx = db.transaction(STORE, 'readonly');
    const idx = tx.store.index('key');
    let cursor = await idx.openCursor(key);
    let result: RvfEntry | undefined;
    while (cursor) {
      if (cursor.value.namespace === namespace) {
        result = cursor.value;
        break;
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    return result;
  }

  /** Delete by caller-supplied key. Returns true if a row was removed. */
  async delete(key: string, opts: GetOptions = {}): Promise<boolean> {
    const db = await getDb();
    const namespace = opts.namespace ?? 'default';
    const tx = db.transaction(STORE, 'readwrite');
    const idx = tx.store.index('key');
    let cursor = await idx.openCursor(key);
    let removed = false;
    while (cursor) {
      if (cursor.value.namespace === namespace) {
        await cursor.delete();
        removed = true;
        break;
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    return removed;
  }

  /** List entries, optionally filtered by namespace. */
  async list(opts: ListOptions = {}): Promise<RvfEntry[]> {
    const db = await getDb();
    const all = await db.getAll(STORE);
    const filtered = opts.namespace
      ? all.filter((e) => e.namespace === opts.namespace)
      : all;
    return opts.limit ? filtered.slice(0, opts.limit) : filtered;
  }

  /**
   * Top-k cosine similarity search. Loads all entries (or namespace
   * subset) into memory and runs a linear scan.
   */
  async searchByVector(query: Float32Array, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const entries = await this.list({ namespace: opts.namespace });
    return searchByVector(entries, query, opts);
  }

  /** Snapshot the entire store as an RVF v1 binary blob. */
  async exportRvf(meta?: { metric?: Metric; quantization?: Quantization }): Promise<Uint8Array> {
    const entries = await this.list();
    const now = Date.now();
    const file: RvfFile = {
      header: {
        magic: MAGIC,
        version: VERSION,
        dimensions: entries.find((e) => e.vector)?.vector?.length ?? DEFAULT_DIMENSIONS,
        metric: meta?.metric ?? 'cosine',
        quantization: meta?.quantization ?? 'fp32',
        entryCount: entries.length,
        createdAt: entries.reduce((m, e) => Math.min(m, e.createdAt), now),
        updatedAt: entries.reduce((m, e) => Math.max(m, e.updatedAt), 0) || now,
      },
      entries,
    };
    return encodeRvf(file);
  }

  /** Replace the store contents with the entries from an RVF v1 blob. */
  async importRvf(buf: Uint8Array, opts: { merge?: boolean } = {}): Promise<number> {
    const file = decodeRvf(buf);
    const db = await getDb();
    if (!opts.merge) {
      await db.clear(STORE);
    }
    const tx = db.transaction(STORE, 'readwrite');
    for (const e of file.entries) {
      await tx.store.put(e);
    }
    await tx.done;
    return file.entries.length;
  }

  /** Drop all entries. Test/dev helper. */
  async clear(): Promise<void> {
    const db = await getDb();
    await db.clear(STORE);
  }
}

let singleton: RvfClient | null = null;
export function getRvfClient(): RvfClient {
  if (!singleton) singleton = new RvfClient();
  return singleton;
}
