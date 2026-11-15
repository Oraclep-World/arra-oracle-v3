import type { Database } from 'bun:sqlite';
import { FTS_THAI, hasThai, segmentThai } from './fts-thai.ts';
import { ftsTokens, joinMatchQuery, pruneDeadTokens } from './fts-tables.ts';

/** More than the 8 of the other legs: Thai questions carry many particles
 *  (ที่/การ/ของ) and bm25 idf already down-weights them. */
const THAI_TOKEN_LIMIT = 16;

/**
 * MATCH expression for oracle_fts_th, or null when the query has no Thai —
 * non-Thai queries are served exactly as before by the other two legs.
 */
export function thaiMatchQuery(query: string, sqlite?: Database): string | null {
  if (!hasThai(query)) return null;
  const unique = Array.from(new Set(ftsTokens(segmentThai(query.normalize('NFC')))));
  if (unique.length === 0) return null;
  const tokens = sqlite
    ? pruneDeadTokens(sqlite, FTS_THAI, unique, THAI_TOKEN_LIMIT)
    : unique.slice(0, THAI_TOKEN_LIMIT);
  return tokens.length > 0 ? joinMatchQuery(tokens) : null;
}
