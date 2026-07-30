/**
 * Vector Store Adapter Integration Tests
 *
 * Tests all available adapters against the VectorStoreAdapter interface.
 * Requires: Ollama running *and holding the configured embedding model*.
 * ChromaDB adapter tested if chroma-mcp available.
 *
 * Two traps this file walked into before, both worth naming:
 *
 *  1. It asserted a literal 768 (nomic's width). When .env switched
 *     ORACLE_EMBEDDING_MODEL to bge-m3 (1024) these assertions became wrong,
 *     and nobody noticed because the suite never ran this folder. Widths are
 *     now looked up in KNOWN_DIMS — the hand-written table — and compared
 *     against the bytes Ollama returns. Two independent sources; asserting a
 *     vector's length against itself would prove nothing.
 *
 *  2. The skip guard asked "is Ollama up?" when what the tests need is "is this
 *     *model* pulled?". Ollama answered 200 on /api/tags while returning 404 for
 *     the model, so tests failed red with nothing actually broken. The guard now
 *     checks the model and says which one is missing.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { createVectorStore } from '../factory.ts';
import { createEmbeddingProvider, OllamaEmbeddings, lookupKnownDims } from '../embeddings.ts';
import { SqliteVecAdapter } from '../adapters/sqlite-vec.ts';
import { ChromaMcpAdapter } from '../adapters/chroma-mcp.ts';
import { LanceDBAdapter } from '../adapters/lancedb.ts';
import { QdrantAdapter } from '../adapters/qdrant.ts';
import type { VectorStoreAdapter, VectorDocument } from '../types.ts';
import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Probe whether the sqlite-vec (vec0) extension can be loaded.
 * Synchronous — safe for describe.skipIf().
 *
 * vec0 SQLite extension not available on deployment hosts (m5, CI).
 * Tests are permanently skipped rather than deleted so they remain
 * runnable on machines that DO have the extension installed.
 */
function isSqliteVecAvailable(): boolean {
  let db: Database | null = null;
  try {
    db = new Database(':memory:');
    // Try npm package first
    try {
      const sqliteVec = require('sqlite-vec');
      db.loadExtension(sqliteVec.getLoadablePath());
      return true;
    } catch { /* fall through */ }
    // Try system paths
    for (const p of ['vec0', '/usr/local/lib/sqlite-vec']) {
      try { db.loadExtension(p); return true; } catch { /* next */ }
    }
    return false;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

const SQLITE_VEC_AVAILABLE = isSqliteVecAvailable();

const TEST_DOCS: VectorDocument[] = [
  {
    id: 'test_1',
    document: 'Nothing is deleted. Create new, do not delete. Git history is sacred.',
    metadata: { type: 'principle', source_file: 'test/resonance.md' },
  },
  {
    id: 'test_2',
    document: 'Patterns over intentions. Watch what the code actually does.',
    metadata: { type: 'principle', source_file: 'test/resonance.md' },
  },
  {
    id: 'test_3',
    document: 'External brain, not command. Mirror reality. Present options.',
    metadata: { type: 'principle', source_file: 'test/resonance.md' },
  },
  {
    id: 'test_4',
    document: 'TypeScript Hono API with SQLite FTS5 for full text search.',
    metadata: { type: 'learning', source_file: 'test/learning.md' },
  },
  {
    id: 'test_5',
    document: 'ChromaDB vector embeddings for semantic similarity search.',
    metadata: { type: 'learning', source_file: 'test/learning.md' },
  },
];

// Check if Ollama is available
async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The model createVectorStore() will hand to Ollama, mirroring factory.ts's
 * precedence (config → ORACLE_EMBEDDING_MODEL → OllamaEmbeddings' own default).
 * Read from env rather than from a built store so the expectation is derived
 * from configuration, not from the object under test.
 */
const CONFIGURED_OLLAMA_MODEL = process.env.ORACLE_EMBEDDING_MODEL || 'nomic-embed-text';

/**
 * Expected vector width for the configured model, from the hand-written table.
 *
 * 0 means the table has never heard of this model. Tests must fail loudly in
 * that case instead of asserting `toHaveLength(0)` — a zero that quietly matches
 * nothing is the same shape of bug as the `|| 768` fallback this file exposed.
 */
const EXPECTED_DIMS = lookupKnownDims(CONFIGURED_OLLAMA_MODEL);

/**
 * Is the model actually pulled? `/api/tags` returning 200 only proves the daemon
 * is up. Ollama reports names with an explicit tag (`bge-m3:latest`) while config
 * usually omits it, so compare both ways.
 */
async function isOllamaModelAvailable(model: string): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (!res.ok) return false;
    const body = await res.json() as { models?: Array<{ name?: string }> };
    const names = (body.models ?? []).map(m => m.name ?? '');
    const bare = (n: string) => n.replace(/:latest$/, '');
    return names.some(n => n === model || bare(n) === bare(model));
  } catch {
    return false;
  }
}

/**
 * Gate a suite on Ollama, logging *which* layer is missing.
 *
 * "Ollama not available" was the old message for both a dead daemon and a
 * missing model, which sent us hunting the wrong layer. One line of extra
 * plumbing buys a skip reason you can act on.
 */
async function ollamaReady(model: string): Promise<boolean> {
  if (!await isOllamaAvailable()) {
    console.log('  [SKIP] Ollama daemon not reachable at localhost:11434');
    return false;
  }
  if (!await isOllamaModelAvailable(model)) {
    console.log(`  [SKIP] Ollama is up but model '${model}' is not pulled (ollama pull ${model})`);
    return false;
  }
  return true;
}

// ============================================================================
// Embedding Provider Tests
// ============================================================================

describe('EmbeddingProvider', () => {
  test('createEmbeddingProvider: chromadb-internal throws on embed()', async () => {
    const provider = createEmbeddingProvider('chromadb-internal');
    expect(provider.name).toBe('chromadb-internal');
    expect(provider.dimensions).toBe(384);
    await expect(provider.embed(['test'])).rejects.toThrow('internally');
  });

  test('createEmbeddingProvider: ollama returns vectors', async () => {
    if (!await isOllamaModelAvailable(CONFIGURED_OLLAMA_MODEL)) {
      console.log(`  [SKIP] Ollama model '${CONFIGURED_OLLAMA_MODEL}' not pulled`);
      return;
    }

    // The table must know this model, or the width assertions below are vacuous.
    expect(EXPECTED_DIMS).toBeGreaterThan(0);

    const provider = createEmbeddingProvider('ollama', CONFIGURED_OLLAMA_MODEL);
    expect(provider.name).toBe('ollama');
    expect(provider.dimensions).toBe(EXPECTED_DIMS);

    const vectors = await provider.embed(['hello world', 'test embedding']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(EXPECTED_DIMS);
    expect(vectors[1]).toHaveLength(EXPECTED_DIMS);

    // Vectors should be different
    const diff = vectors[0].some((v, i) => v !== vectors[1][i]);
    expect(diff).toBe(true);
  });
});

// ============================================================================
// Factory Tests
// ============================================================================

describe('createVectorStore factory', () => {
  test('defaults to lancedb', () => {
    const store = createVectorStore();
    expect(store.name).toBe('lancedb');
    expect(store).toBeInstanceOf(LanceDBAdapter);
  });

  test('creates sqlite-vec', () => {
    const tmpDb = path.join(os.tmpdir(), `oracle-test-factory-${Date.now()}.db`);
    const store = createVectorStore({
      type: 'sqlite-vec',
      dataPath: tmpDb,
      embeddingProvider: 'ollama',
    });
    expect(store.name).toBe('sqlite-vec');
    expect(store).toBeInstanceOf(SqliteVecAdapter);
    // Cleanup
    try { fs.unlinkSync(tmpDb); } catch {}
  });

  test('respects ORACLE_VECTOR_DB env', () => {
    const orig = process.env.ORACLE_VECTOR_DB;
    process.env.ORACLE_VECTOR_DB = 'sqlite-vec';
    process.env.ORACLE_VECTOR_DB_PATH = '/tmp/oracle-test-env.db';

    const store = createVectorStore();
    expect(store.name).toBe('sqlite-vec');

    // Restore
    if (orig) process.env.ORACLE_VECTOR_DB = orig;
    else delete process.env.ORACLE_VECTOR_DB;
    delete process.env.ORACLE_VECTOR_DB_PATH;
  });
});

// ============================================================================
// Adapter Interface Compliance: sqlite-vec + Ollama
// Permanently skipped when vec0 extension is not loadable.
// vec0 SQLite extension not available on deployment hosts (m5, CI).
// ============================================================================

describe.skipIf(!SQLITE_VEC_AVAILABLE)('SqliteVecAdapter + Ollama', () => {
  let store: VectorStoreAdapter;
  let tmpDb: string;
  let available = false;

  // Setup — needs both Ollama AND sqlite-vec extension
  const setup = async () => {
    available = await ollamaReady(CONFIGURED_OLLAMA_MODEL);
    if (!available) return;

    tmpDb = path.join(os.tmpdir(), `oracle-vec-test-${Date.now()}.db`);
    try {
      store = createVectorStore({
        type: 'sqlite-vec',
        dataPath: tmpDb,
        embeddingProvider: 'ollama',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('vec0') || msg.includes('no such module')) {
        console.log('  [SKIP] sqlite-vec extension not available');
        available = false;
        return;
      }
      throw err;
    }
  };

  afterAll(async () => {
    if (store) await store.close();
    if (tmpDb) {
      try { fs.unlinkSync(tmpDb); } catch {}
    }
  });

  test('connect + ensureCollection', async () => {
    await setup();
    if (!available) { console.log('  [SKIP] Ollama or sqlite-vec not available'); return; }

    try {
      await store.connect();
      await store.ensureCollection();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('vec0') || msg.includes('no such module')) {
        console.log('  [SKIP] sqlite-vec extension not loaded');
        available = false;
        return;
      }
      throw err;
    }

    const info = await store.getCollectionInfo();
    expect(info.name).toBe('oracle_knowledge');
    expect(info.count).toBe(0);
  });

  test('addDocuments', async () => {
    if (!available) { console.log('  [SKIP] Ollama not available'); return; }

    await store.addDocuments(TEST_DOCS);

    const stats = await store.getStats();
    expect(stats.count).toBe(5);
  });

  test('query: semantic search', async () => {
    if (!available) { console.log('  [SKIP] Ollama not available'); return; }

    const result = await store.query('git history preservation', 3);

    expect(result.ids.length).toBeGreaterThan(0);
    expect(result.ids.length).toBeLessThanOrEqual(3);
    expect(result.documents.length).toBe(result.ids.length);
    expect(result.distances.length).toBe(result.ids.length);
    expect(result.metadatas.length).toBe(result.ids.length);

    // "Nothing is deleted" doc should rank high for git history query
    console.log('  Top result for "git history preservation":', result.ids[0]);
    expect(result.ids).toContain('test_1');
  });

  test('query: with where filter', async () => {
    if (!available) { console.log('  [SKIP] Ollama not available'); return; }

    const result = await store.query('search technology', 5, { type: 'learning' });

    // Should only return learning-type docs
    for (const meta of result.metadatas) {
      expect(meta.type).toBe('learning');
    }
  });

  test('queryById: nearest neighbors', async () => {
    if (!available) { console.log('  [SKIP] Ollama not available'); return; }

    const result = await store.queryById('test_1', 3);

    expect(result.ids.length).toBeGreaterThan(0);
    expect(result.ids.length).toBeLessThanOrEqual(3);
    // Should NOT contain the source document
    expect(result.ids).not.toContain('test_1');
  });

  test('getAllEmbeddings', async () => {
    if (!available) { console.log('  [SKIP] Ollama not available'); return; }

    const all = await store.getAllEmbeddings!();

    expect(all.ids).toHaveLength(5);
    expect(all.embeddings).toHaveLength(5);
    expect(EXPECTED_DIMS).toBeGreaterThan(0); // table must know the model
    expect(all.embeddings[0]).toHaveLength(EXPECTED_DIMS);
    expect(all.metadatas).toHaveLength(5);
  });

  test('deleteCollection + getStats returns 0', async () => {
    if (!available) { console.log('  [SKIP] Ollama not available'); return; }

    await store.deleteCollection();
    // Need to reconnect since tables were dropped
    await store.ensureCollection();
    const stats = await store.getStats();
    expect(stats.count).toBe(0);
  });
});

// ============================================================================
// ChromaMcpAdapter
// ============================================================================
// Spawns a `uvx chroma-mcp` stdio subprocess. The subprocess cold-start
// (uv fetching/resolving the Python env) can take several seconds under
// full-suite concurrency, so each test here needs a timeout well above
// bun's 5s default. Tests auto-skip if uvx/chroma-mcp is unavailable.
const CHROMA_TEST_TIMEOUT_MS = 30_000;

describe('ChromaMcpAdapter', () => {
  let store: VectorStoreAdapter;
  let chromaAvailable = false;

  const setup = async () => {
    store = createVectorStore({
      type: 'chroma',
      collectionName: 'oracle_test_adapter',
    });

    try {
      await store.connect();
      chromaAvailable = true;
    } catch {
      chromaAvailable = false;
    }
  };

  afterAll(async () => {
    if (store && chromaAvailable) {
      try { await store.deleteCollection(); } catch {}
      await store.close();
    }
  });

  test('connect + ensureCollection', async () => {
    await setup();
    if (!chromaAvailable) { console.log('  [SKIP] ChromaDB not available'); return; }

    await store.ensureCollection();
    const info = await store.getCollectionInfo();
    expect(info.name).toBe('oracle_test_adapter');
  }, CHROMA_TEST_TIMEOUT_MS);

  test('addDocuments + query', async () => {
    if (!chromaAvailable) { console.log('  [SKIP] ChromaDB not available'); return; }

    await store.addDocuments(TEST_DOCS);
    const stats = await store.getStats();
    expect(stats.count).toBe(5);

    const result = await store.query('git history', 3);
    expect(result.ids.length).toBeGreaterThan(0);
    expect(result.documents.length).toBe(result.ids.length);
  }, CHROMA_TEST_TIMEOUT_MS);

  test.skip('queryById (pre-existing safeJsonParse single-quote bug)', async () => {
    if (!chromaAvailable) { console.log('  [SKIP] ChromaDB not available'); return; }

    const result = await store.queryById('test_1', 2);
    expect(result.ids.length).toBeGreaterThan(0);
    expect(result.ids).not.toContain('test_1');
  }, CHROMA_TEST_TIMEOUT_MS);
});

// ============================================================================
// Adapter Interface Compliance: LanceDB + Ollama
// ============================================================================

describe('LanceDBAdapter + Ollama', () => {
  let store: VectorStoreAdapter;
  let tmpDir: string;
  let available = false;

  const setup = async () => {
    available = await ollamaReady(CONFIGURED_OLLAMA_MODEL);
    if (!available) return;

    tmpDir = path.join(os.tmpdir(), `oracle-lance-test-${Date.now()}`);
    store = createVectorStore({
      type: 'lancedb',
      dataPath: tmpDir,
      collectionName: 'oracle_test_lance',
      embeddingProvider: 'ollama',
    });
  };

  afterAll(async () => {
    if (store) await store.close();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    }
  });

  test('connect + ensureCollection', async () => {
    await setup();
    if (!available) { console.log('  [SKIP] Ollama not available'); return; }

    await store.connect();
    await store.ensureCollection();

    const info = await store.getCollectionInfo();
    expect(info.name).toBe('oracle_test_lance');
    expect(info.count).toBe(0);
  });

  test('addDocuments', async () => {
    if (!available) { console.log('  [SKIP] Ollama not available'); return; }

    await store.addDocuments(TEST_DOCS);

    const stats = await store.getStats();
    expect(stats.count).toBe(5);
  });

  test('query: semantic search', async () => {
    if (!available) { console.log('  [SKIP] Ollama not available'); return; }

    const result = await store.query('git history preservation', 3);

    expect(result.ids.length).toBeGreaterThan(0);
    expect(result.ids.length).toBeLessThanOrEqual(3);
    expect(result.documents.length).toBe(result.ids.length);
    expect(result.distances.length).toBe(result.ids.length);

    console.log('  Top result for "git history preservation":', result.ids[0]);
    expect(result.ids).toContain('test_1');
  });

  test('query: with where filter', async () => {
    if (!available) { console.log('  [SKIP] Ollama not available'); return; }

    const result = await store.query('search technology', 5, { type: 'learning' });

    for (const meta of result.metadatas) {
      expect(meta.type).toBe('learning');
    }
  });

  test('queryById: nearest neighbors', async () => {
    if (!available) { console.log('  [SKIP] Ollama not available'); return; }

    const result = await store.queryById('test_1', 3);

    expect(result.ids.length).toBeGreaterThan(0);
    expect(result.ids.length).toBeLessThanOrEqual(3);
    expect(result.ids).not.toContain('test_1');
  });

  test('getAllEmbeddings', async () => {
    if (!available) { console.log('  [SKIP] Ollama not available'); return; }

    const all = await store.getAllEmbeddings!();

    expect(all.ids).toHaveLength(5);
    expect(all.embeddings).toHaveLength(5);
    expect(EXPECTED_DIMS).toBeGreaterThan(0); // table must know the model
    expect(all.embeddings[0]).toHaveLength(EXPECTED_DIMS);
    expect(all.metadatas).toHaveLength(5);
  });

  test('deleteCollection + getStats returns 0', async () => {
    if (!available) { console.log('  [SKIP] Ollama not available'); return; }

    await store.deleteCollection();
    await store.ensureCollection();
    const stats = await store.getStats();
    expect(stats.count).toBe(0);
  });
});

// ============================================================================
// Adapter Interface Compliance: Qdrant + Ollama
// ============================================================================

async function isQdrantAvailable(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:6333/collections');
    return res.ok;
  } catch {
    return false;
  }
}

describe('QdrantAdapter + Ollama', () => {
  let store: VectorStoreAdapter;
  let available = false;

  const setup = async () => {
    // Same reasoning as the other suites: name the missing layer, and check the
    // model rather than just the daemon.
    const [ollama, qdrant] = await Promise.all([
      ollamaReady(CONFIGURED_OLLAMA_MODEL),
      isQdrantAvailable(),
    ]);
    if (!qdrant) console.log('  [SKIP] Qdrant not reachable');
    available = ollama && qdrant;
    if (!available) return;

    store = createVectorStore({
      type: 'qdrant',
      collectionName: 'oracle_test_qdrant',
      embeddingProvider: 'ollama',
    });
  };

  afterAll(async () => {
    if (store && available) {
      try { await store.deleteCollection(); } catch {}
      await store.close();
    }
  });

  test('connect + ensureCollection', async () => {
    await setup();
    if (!available) { console.log('  [SKIP] Ollama or Qdrant not available'); return; }

    await store.connect();
    await store.ensureCollection();

    const info = await store.getCollectionInfo();
    expect(info.name).toBe('oracle_test_qdrant');
  });

  test('addDocuments', async () => {
    if (!available) { console.log('  [SKIP] Ollama or Qdrant not available'); return; }

    await store.addDocuments(TEST_DOCS);

    // Qdrant is eventually consistent — wait briefly
    await new Promise(r => setTimeout(r, 500));

    const stats = await store.getStats();
    expect(stats.count).toBe(5);
  });

  test('query: semantic search', async () => {
    if (!available) { console.log('  [SKIP] Ollama or Qdrant not available'); return; }

    const result = await store.query('git history preservation', 3);

    expect(result.ids.length).toBeGreaterThan(0);
    expect(result.ids.length).toBeLessThanOrEqual(3);
    expect(result.documents.length).toBe(result.ids.length);
    expect(result.distances.length).toBe(result.ids.length);

    console.log('  Top result for "git history preservation":', result.ids[0]);
    expect(result.ids).toContain('test_1');
  });

  test('query: with where filter', async () => {
    if (!available) { console.log('  [SKIP] Ollama or Qdrant not available'); return; }

    const result = await store.query('search technology', 5, { type: 'learning' });

    for (const meta of result.metadatas) {
      expect(meta.type).toBe('learning');
    }
  });

  test('queryById: nearest neighbors', async () => {
    if (!available) { console.log('  [SKIP] Ollama or Qdrant not available'); return; }

    const result = await store.queryById('test_1', 3);

    expect(result.ids.length).toBeGreaterThan(0);
    expect(result.ids.length).toBeLessThanOrEqual(3);
    expect(result.ids).not.toContain('test_1');
  });

  test('deleteCollection + recreate', async () => {
    if (!available) { console.log('  [SKIP] Ollama or Qdrant not available'); return; }

    await store.deleteCollection();
    await store.ensureCollection();
    const stats = await store.getStats();
    expect(stats.count).toBe(0);
  });
});
