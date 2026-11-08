/**
 * No silent embedded fallback in HTTP-client mode (Oraclep-World fork · Pleam 8 Nov 2026).
 * When ORACLE_API is unreachable, or a tool call has no central route, the MCP must
 * answer with a loud CENTRAL BRAIN DOWN error and must NOT create/open its own DB.
 */

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = resolve(import.meta.dir, '../../..');
const tempDirs: string[] = [];
const clients: Client[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function connectDeadApi() {
  const mcpDataDir = tempDir('arra-no-fallback-mcp-');
  const mcpDbPath = join(mcpDataDir, 'oracle.db');
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [join(repoRoot, 'src/index.ts')],
    env: {
      ...process.env,
      ORACLE_API: 'http://127.0.0.1:1', // nothing listens here
      ORACLE_DATA_DIR: mcpDataDir,
      ORACLE_DB_PATH: mcpDbPath,
      ORACLE_INDEXER_ENQUEUE: '0',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'no-fallback-test', version: '0.0.0' });
  clients.push(client);
  await client.connect(transport);
  return { client, mcpDbPath, mcpDataDir };
}

function text(result: any): string {
  return (result.content ?? []).map((c: any) => c.text ?? '').join('\n');
}

test('unreachable ORACLE_API → loud CENTRAL BRAIN DOWN, no local DB', async () => {
  const { client, mcpDbPath } = await connectDeadApi();
  const result: any = await client.callTool({ name: 'oracle_search', arguments: { query: 'anything' } });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain('CENTRAL BRAIN DOWN');
  expect(existsSync(mcpDbPath)).toBe(false);
}, 30_000);

test('no central route for the arguments → refuse, no local DB', async () => {
  const { client, mcpDbPath } = await connectDeadApi();
  // oracle_trace_get without traceId has no proxy route; before this change it fell through to embedded
  const result: any = await client.callTool({ name: 'oracle_trace_get', arguments: {} });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain('CENTRAL BRAIN DOWN');
  expect(existsSync(mcpDbPath)).toBe(false);
}, 30_000);
