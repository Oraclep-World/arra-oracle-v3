/**
 * Regression for #1244 Phase 1:
 * a covered MCP tool should proxy first, then fall back to lazy embedded mode
 * when ORACLE_API is unreachable so standalone stdio usage stays safe.
 */

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = resolve(import.meta.dir, '../../..');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Oraclep-World fork, 8 Nov 2026 (Pleam: "เอาออกได้เลย"): the lazy embedded fallback was removed on purpose.
// This test used to assert the fallback answered; it now asserts the opposite — a loud error, no local answer.
test('MCP covered tools do NOT fall back to embedded when ORACLE_API is unreachable (fail loud)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'arra-mcp-fallback-'));
  tempDirs.push(dataDir);

  const transport = new StdioClientTransport({
    command: 'bun',
    args: [join(repoRoot, 'src/index.ts')],
    env: {
      ...process.env,
      ORACLE_API: 'http://127.0.0.1:1',
      ORACLE_DATA_DIR: dataDir,
      ORACLE_INDEXER_ENQUEUE: '0',
    },
    stderr: 'pipe',
  });

  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));

  const client = new Client(
    { name: 'mcp-proxy-fallback-test', version: '0.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);

    const result = await client.callTool({
      name: 'oracle_search',
      arguments: { query: 'standalone fallback smoke', mode: 'fts', limit: 1 },
    }) as { content?: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('CENTRAL BRAIN DOWN');
    expect(result.content?.[0]?.text).not.toContain('"results"');
    expect(stderr.join('')).toContain('ORACLE_API unavailable for oracle_search; no embedded fallback');
  } finally {
    await client.close();
  }
}, 20_000);
