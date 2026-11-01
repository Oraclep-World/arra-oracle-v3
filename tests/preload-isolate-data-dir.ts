/**
 * bun test preload — loads the fail-closed isolation before any test file.
 * The real logic lives in src/test-isolation.ts and is also imported first by
 * src/config.ts, so isolation holds even when bun test runs from a cwd without
 * this bunfig. History of why: see that file (and 95dd56f8, the detect-based
 * version ferris broke 6 ways on 1 Nov 2026).
 */
import '../src/test-isolation.ts';
