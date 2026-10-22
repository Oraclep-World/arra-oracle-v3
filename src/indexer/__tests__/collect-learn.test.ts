import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDocuments } from '../collectors.ts';
import { parseLearningFile } from '../parser.ts';

// ψ/learn = study notes per house (พลีม 22 Oct 2026 "เก็บเลยครับ"). ψ/lab must stay out.
describe('collectDocuments psiSubdir (ψ/learn)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-'));
  const house = path.join(root, 'github.com', 'oraclep-world', 'zz-oracle', 'ψ');
  fs.mkdirSync(path.join(house, 'learn', 'topic'), { recursive: true });
  fs.mkdirSync(path.join(house, 'lab'), { recursive: true });
  fs.mkdirSync(path.join(house, 'memory', 'learnings'), { recursive: true });
  fs.writeFileSync(path.join(house, 'learn', 'topic', 'note.md'), '# study note\n\nzebra-learn-marker body\n');
  fs.writeFileSync(path.join(house, 'lab', 'scratch.md'), '# lab\n\nzebra-lab-marker body\n');
  fs.writeFileSync(path.join(house, 'memory', 'learnings', 'x.md'), '# lesson\n\nzebra-memory-marker\n');
  const run = (psiSubdir: boolean, subdir: string) => collectDocuments({
    config: { repoRoot: root } as any, seenContentHashes: new Set(), subdir, psiSubdir,
    parseFn: parseLearningFile, label: 'test',
  });

  test('reads ψ/learn and keeps the real path', () => {
    const docs = run(true, 'learn');
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every(d => d.source_file.includes('/ψ/learn/'))).toBe(true);
    expect(docs.some(d => d.content.includes('zebra-learn-marker'))).toBe(true);
  });
  test('never reads ψ/lab or ψ/memory through the learn collector', () => {
    const text = run(true, 'learn').map(d => d.content).join('\n');
    expect(text.includes('zebra-lab-marker')).toBe(false);
    expect(text.includes('zebra-memory-marker')).toBe(false);
  });
  test('default (no psiSubdir) still reads ψ/memory/<subdir> only', () => {
    const docs = run(false, 'learnings');
    expect(docs.some(d => d.content.includes('zebra-memory-marker'))).toBe(true);
    expect(docs.some(d => d.source_file.includes('/ψ/learn/'))).toBe(false);
  });
});
