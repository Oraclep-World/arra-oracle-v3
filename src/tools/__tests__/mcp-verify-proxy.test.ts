/**
 * Regression for #1244 Phase 2 (verify gap): oracle_verify should proxy
 * through ORACLE_API instead of lazy-opening embedded SQLite when the HTTP
 * server is reachable.
 */

import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnTestServer, waitForHealth } from './helpers/test-http-server.ts';

const repoRoot = resolve(import.meta.dir, '../../..');
const tempDirs: string[] = [];
const childProcesses: Array<{ kill: () => void }> = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}


afterEach(() => {
  for (const proc of childProcesses.splice(0)) proc.kill();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('oracle_verify proxies through ORACLE_API without opening the MCP DB', async () => {
  const serverDataDir = tempDir('arra-verify-proxy-server-');
  const serverRepoRoot = tempDir('arra-verify-proxy-repo-');
  const mcpDataDir = tempDir('arra-verify-proxy-mcp-');
  const mcpDbPath = join(mcpDataDir, 'oracle.db');

  const server = spawnTestServer({
      ORACLE_DATA_DIR: serverDataDir,
      ORACLE_DB_PATH: join(serverDataDir, 'oracle.db'),
      ORACLE_REPO_ROOT: serverRepoRoot,
      ORACLE_INDEXER_ENQUEUE: '0',
  });
  const { port, baseUrl } = server;
  childProcesses.push(server.proc);
  await waitForHealth(server);

  const transport = new StdioClientTransport({
    command: 'bun',
    args: [join(repoRoot, 'src/index.ts')],
    env: {
      ...process.env,
      ORACLE_API: baseUrl,
      ORACLE_DATA_DIR: mcpDataDir,
      ORACLE_DB_PATH: mcpDbPath,
      ORACLE_INDEXER_ENQUEUE: '0',
    },
    stderr: 'pipe',
  });

  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk) => stderr.push(chunk.toString()));

  const client = new Client(
    { name: 'mcp-verify-proxy-test', version: '0.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'oracle_verify',
      arguments: { check: true, type: 'all' },
    }) as { content?: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content?.[0]?.text ?? '{}');
    expect(payload.counts).toBeDefined();
    expect(payload.counts.healthy).toBeNumber();
    expect(stderr.join('')).not.toContain('ORACLE_API unavailable for oracle_verify');
    expect(existsSync(mcpDbPath)).toBe(false);
  } finally {
    await client.close();
  }
}, 90_000);
