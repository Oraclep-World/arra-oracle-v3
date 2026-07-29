/**
 * SQLite error classification — side-effect-free module.
 *
 * Lives outside db/index.ts so tool handlers and tests can import it
 * without opening the module-level default database connection.
 */

/**
 * Detect SQLite contention errors that can occur while the indexer holds
 * a write lock long enough to trip bun:sqlite's busy_timeout.
 *
 * Mirrors the matching logic in the global Elysia .onError() handler
 * (see src/server.ts) so individual endpoints can return graceful
 * fallbacks instead of relying on the 503 catch-all.
 */
export function isDbLockError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('disk I/O') || msg.includes('SQLITE_BUSY') || msg.includes('database is locked');
}
