/**
 * One resolver for "how wide is this vector?", shared by every adapter.
 *
 * Why a shared module instead of three copies: the previous bug was not that
 * one adapter guessed wrong, it was that the *intent* ("unknown model → probe
 * before creating a column") lived only in a comment, so no adapter implemented
 * it. Same shape as run-marker.ts — one writer, every caller routed through it,
 * so the next fix lands everywhere at once.
 *
 * A column created from a guessed width is silently wrong forever: writes fail
 * or get coerced, and search quietly returns nothing useful.
 */
import type { EmbeddingProvider } from './types.ts';

export async function resolveDimensions(
  embedder: EmbeddingProvider,
  storeLabel: string,
): Promise<number> {
  // Providers with a runtime-dependent model probe here; static ones are no-ops.
  if (embedder.ensureDimensions) await embedder.ensureDimensions();

  const dims = embedder.dimensions;
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(
      `${storeLabel}: refusing to create a collection with dimension ${dims}. ` +
      `Embedding provider '${embedder.name}' could not resolve its vector width. ` +
      `Check the model name in the vector config (Ollama's ':latest' tag is fine) ` +
      `or add the model to KNOWN_DIMS in src/vector/embeddings.ts.`
    );
  }
  return dims;
}
