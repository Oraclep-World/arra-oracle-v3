/**
 * bun test preload — FORCES isolation for every file bun test runs from this
 * repo, including explicit non-suffixed paths with a preset NODE_ENV (ferris,
 * 1 Nov 2026: `NODE_ENV=production bun test ./probe3.ts` → live DB under v3).
 * Bun exposes no runtime signal for "under bun test" (globals, Bun keys and env
 * are identical to `bun run`, measured), but this preload is only loaded by
 * bun test via bunfig, so loading it IS the signal.
 * The logic lives in src/test-isolation.ts (also the first import of config.ts,
 * which covers runs from other cwds by NODE_ENV / entry filename).
 * Accepted residual: a non-suffixed file run with `bun test` from a cwd without
 * this bunfig AND a preset non-test NODE_ENV.
 */
process.env.ARRA_TEST_ISOLATION = '1';
await import('../src/test-isolation.ts');
