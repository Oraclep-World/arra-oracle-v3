/**
 * Regression: embedding width must never be guessed.
 *
 * The bug this locks down: OllamaEmbeddings did `KNOWN_DIMS[model] || 768`, so
 * any model name the table did not recognise silently claimed nomic's 768. The
 * name people paste from `ollama list` is `bge-m3:latest`, which missed the
 * table entry keyed `bge-m3` — the real model returns 1024. Adapters then baked
 * 768 into a vec0 column / LanceDB schema, which cannot be fixed without a
 * rebuild. A comment in the file already said unknown models should be 0 and
 * adapters should probe; no adapter did, and the fallback hid it.
 *
 * These tests need no Ollama: they exercise the table lookup and the guard.
 * The probe path (unknown model → embed) is covered separately and skips when
 * the daemon is absent, because that one genuinely needs a server.
 */

import { describe, test, expect } from 'bun:test';
import { KNOWN_DIMS, lookupKnownDims, OllamaEmbeddings } from '../embeddings.ts';
import { resolveDimensions } from '../resolve-dimensions.ts';
import type { EmbeddingProvider } from '../types.ts';

describe('lookupKnownDims', () => {
  test('known model resolves from the table', () => {
    expect(lookupKnownDims('bge-m3')).toBe(1024);
    expect(lookupKnownDims('nomic-embed-text')).toBe(768);
  });

  test("Ollama's ':latest' tag resolves to the same width as the bare name", () => {
    // The original bug, stated as a test: these two names are one model in Ollama.
    expect(lookupKnownDims('bge-m3:latest')).toBe(lookupKnownDims('bge-m3'));
    expect(lookupKnownDims('bge-m3:latest')).toBe(1024);
  });

  test('unknown model resolves to 0, not a borrowed width', () => {
    expect(lookupKnownDims('model-that-does-not-exist')).toBe(0);
    // Specifically not 768 — that was the old silent fallback.
    expect(lookupKnownDims('model-that-does-not-exist')).not.toBe(768);
  });

  test('an explicit tag in the table still wins over the stripped name', () => {
    // qwen3-embedding:4b is 2560 while the bare name is 1024; stripping must not
    // clobber a more specific entry.
    expect(KNOWN_DIMS['qwen3-embedding:4b']).toBe(2560);
    expect(lookupKnownDims('qwen3-embedding:4b')).toBe(2560);
    expect(lookupKnownDims('qwen3-embedding')).toBe(1024);
  });
});

describe('OllamaEmbeddings.dimensions before any embed call', () => {
  test('configured-but-tagged model reports its real width', () => {
    expect(new OllamaEmbeddings({ model: 'bge-m3:latest' }).dimensions).toBe(1024);
  });

  test('unknown model reports 0 so callers are forced to probe', () => {
    expect(new OllamaEmbeddings({ model: 'nonexistent-embed-model' }).dimensions).toBe(0);
  });
});

describe('resolveDimensions guard', () => {
  const stub = (dims: number, ensure?: () => Promise<number>): EmbeddingProvider => ({
    name: 'stub',
    dimensions: dims,
    embed: async () => [[]],
    ensureDimensions: ensure,
  });

  test('passes through a resolved width', async () => {
    expect(await resolveDimensions(stub(1024), '[test]')).toBe(1024);
  });

  test('refuses dimension 0 with a message naming the store and provider', async () => {
    const err = await resolveDimensions(stub(0), '[LanceDB]').then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    // The message has to be actionable — the old failure mode was a 768-wide
    // column created in silence, with nothing to grep for afterwards.
    expect(err!.message).toContain('[LanceDB]');
    expect(err!.message).toContain('stub');
    expect(err!.message).toContain('KNOWN_DIMS');
  });

  test('awaits ensureDimensions before reading the width', async () => {
    let probed = false;
    const provider: EmbeddingProvider = {
      name: 'late-resolver',
      dimensions: 0,
      embed: async () => [[]],
      ensureDimensions: async () => {
        probed = true;
        (provider as { dimensions: number }).dimensions = 384;
        return 384;
      },
    };

    expect(await resolveDimensions(provider, '[test]')).toBe(384);
    expect(probed).toBe(true);
  });

  test('rejects a non-integer width rather than creating a fractional column', async () => {
    await expect(resolveDimensions(stub(1024.5), '[test]')).rejects.toThrow('1024.5');
  });
});

describe('probe path against a live Ollama', () => {
  test('an unknown model name fails loudly instead of assuming 768', async () => {
    const up = await fetch('http://localhost:11434/api/tags').then(r => r.ok, () => false);
    if (!up) {
      console.log('  [SKIP] Ollama daemon not reachable at localhost:11434');
      return;
    }

    const provider = new OllamaEmbeddings({ model: 'definitely-not-a-real-model' });
    expect(provider.dimensions).toBe(0);

    // Either the probe embed errors (404 from Ollama) or ensureDimensions throws
    // its own actionable error. What must NOT happen is silently reporting 768.
    const err = await provider.ensureDimensions().then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(provider.dimensions).not.toBe(768);
  });
});
