/**
 * v0.37.7.0 #1167 — `gbrain import --source-id <id>` routes to a brain source.
 *
 * Pre-fix, `gbrain import --source dept-x ./pages` silently fell back to
 * `default` because the CLI parser didn't consume `--source` at all
 * (PR #707's design intent explicitly excluded it). Users had no signal
 * their pages were being written to the wrong place.
 *
 * Fix: add `--source-id <id>` parsing. The flag is named --source-id
 * (not --source) to avoid colliding with future axes; matches the
 * v0.37.7.0 extract.ts convention from T2.
 *
 * Hermetic PGLite in-memory.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'node:child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncatePages(): Promise<void> {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  await (engine as any).db.exec(`DELETE FROM sources WHERE id <> 'default'`);
}

describe('import --source-id (#1167)', () => {
  let scratchDir: string;
  beforeEach(async () => {
    await truncatePages();
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('dept-x', 'dept-x') ON CONFLICT DO NOTHING`,
    );
    scratchDir = mkdtempSync(join(tmpdir(), 'gbrain-import-src-'));
    mkdirSync(join(scratchDir, 'wiki'), { recursive: true });
    writeFileSync(
      join(scratchDir, 'wiki', 'alpha.md'),
      '---\ntype: note\n---\n# Alpha\n\nContent of alpha.',
    );
    writeFileSync(
      join(scratchDir, 'wiki', 'beta.md'),
      '---\ntype: note\n---\n# Beta\n\nContent of beta.',
    );
  });

  test('without --source-id, pages land in default source', async () => {
    await runImport(engine, [scratchDir, '--no-embed', '--json']);
    const rows = await engine.executeRaw<{ source_id: string; slug: string }>(
      `SELECT source_id, slug FROM pages ORDER BY slug`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.source_id).toBe('default');
    }
  });

  test('--source-id dept-x routes pages to dept-x source', async () => {
    await runImport(engine, [scratchDir, '--source-id', 'dept-x', '--no-embed', '--json']);
    const rows = await engine.executeRaw<{ source_id: string; slug: string }>(
      `SELECT source_id, slug FROM pages ORDER BY slug`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(r.source_id).toBe('dept-x');
    }
  });

  test('--source-id value is NOT treated as a positional dir arg', async () => {
    // Regression: flag-value-as-dirArg was a real bug class in early
    // CLI parsers. Pre-fix the parser at line 82-83 would have
    // matched 'dept-x' as dirArg (since dept-x doesn't start with --).
    // The flagValues set now excludes the arg at sourceIdIdx+1.
    let threw = false;
    try {
      await runImport(engine, ['--source-id', 'dept-x', scratchDir, '--no-embed', '--json']);
    } catch (e) {
      threw = true;
    }
    // Should NOT throw "Usage: gbrain import <dir>..." because scratchDir
    // is still recognized as the positional dir.
    expect(threw).toBe(false);
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages LIMIT 1`,
    );
    expect(rows[0]?.source_id).toBe('dept-x');
  });
});

/**
 * Follow-up to the source-resolution fix: a source-scoped import must
 * advance THAT source's sync anchor (sources.last_commit / local_path),
 * not the global `sync.last_commit` config key. Pre-fix import.ts always
 * wrote the global key, so a scoped `gbrain sync --source X` (which reads
 * the source row) never saw the import's progress and re-walked the diff.
 */
describe('import writes a source-scoped sync anchor', () => {
  let gitDir: string;
  let head: string;

  beforeEach(async () => {
    await truncatePages();
    await engine.setConfig('sync.last_commit', '');  // clear global key
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('dept-x', 'dept-x') ON CONFLICT DO NOTHING`,
    );
    gitDir = mkdtempSync(join(tmpdir(), 'gbrain-import-git-'));
    const git = (...a: string[]) =>
      execFileSync('git', ['-C', gitDir, ...a], { encoding: 'utf-8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    writeFileSync(join(gitDir, 'alpha.md'), '---\ntype: note\n---\n# Alpha\n\nBody.');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    head = git('rev-parse', 'HEAD').trim();
  });

  afterEach(() => {
    rmSync(gitDir, { recursive: true, force: true });
  });

  test('--source-id advances sources.last_commit, NOT the global key', async () => {
    await runImport(engine, [gitDir, '--source-id', 'dept-x', '--no-embed', '--json']);

    const src = await engine.executeRaw<{ last_commit: string | null; local_path: string | null }>(
      `SELECT last_commit, local_path FROM sources WHERE id = 'dept-x'`,
    );
    expect(src[0]?.last_commit).toBe(head);     // source anchor advanced
    expect(src[0]?.local_path).toBe(gitDir);    // repo_path scoped too

    const globalCommit = await engine.getConfig('sync.last_commit');
    expect(globalCommit ?? '').toBe('');        // global key untouched
  });

  test('unscoped import still writes the global anchor (back-compat)', async () => {
    await runImport(engine, [gitDir, '--no-embed', '--json']);
    const globalCommit = await engine.getConfig('sync.last_commit');
    expect(globalCommit).toBe(head);
  });
});
