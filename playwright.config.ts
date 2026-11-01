import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Use .e2e.ts (not .spec.ts) so `bun test` doesn't try to load these —
  // bun's runner auto-discovers **/*.{test,spec}.ts and would fail to
  // import @playwright/test (a separate dep/runner).
  testMatch: /.*\.e2e\.ts$/,
  timeout: 30000,
  // Own port + own temp data, never reuse: the old reuseExistingServer:!CI on
  // :47778 drove the LIVE brain locally (ferris, 1 Nov 2026 — break P).
  // `bun run test:seed` writes into the same /tmp/arra-e2e-data.
  use: {
    baseURL: 'http://localhost:47788',
  },
  webServer: {
    command: 'bun run src/server.ts',
    url: 'http://localhost:47788/api/health',
    reuseExistingServer: false,
    env: { ORACLE_PORT: '47788', ORACLE_DATA_DIR: '/tmp/arra-e2e-data', NODE_ENV: 'test' },
    timeout: 30000,
  },
});
