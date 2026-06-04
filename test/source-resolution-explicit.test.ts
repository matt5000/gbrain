/**
 * fix/source-resolution-remote-url — explicit `--source` threading + the
 * import-asymmetry regression it unblocks.
 *
 * Background. A single logical repo (e.g. `gbrain-notes`) synced from two
 * machines registers under a per-machine `local_path`. On the machine that
 * did NOT register the source, the path-based `resolveSourceForDir`
 * (src/core/cycle.ts) misses → returns undefined → the daily sync runs
 * UNSCOPED (sourceId undefined). URL-based auto-detection was abandoned
 * because the VM's origin is an SSH host-alias URL that parseRemoteUrl
 * rejects. The fix is an EXPLICIT `--source <id>` flag, threaded
 * dream → runCycle (CycleOpts.sourceId) → runPhaseSync, where it overrides
 * path-based auto-detection.
 *
 * Two fixes verified here:
 *
 * 1. Explicit source threading (src/commands/dream.ts + src/core/cycle.ts):
 *    runCycle({ sourceId: 'X', phases: ['sync'] }) must sync into source 'X'
 *    even when no source row's local_path matches brainDir — i.e. the
 *    explicit id wins over path auto-detection. Without the threading, the
 *    sync would fall back to resolveSourceForDir → undefined → 'default'.
 *
 * 2. importFromContent existence-read scoping (src/core/import-file.ts): the
 *    existence READ must be scoped to the SAME source its version/page WRITES
 *    target, so an unscoped read can never pair with a default-scoped write.
 *    Bug: getPage(slug, undefined) matched ANY source's row (existing
 *    truthy), then createVersion(slug, undefined) looked under 'default',
 *    found nothing, and threw `createVersion failed: page "..."
 *    (source=default) not found`, aborting the import and stranding the page.
 *    That throw is exactly what the unscoped sync from the missing fix (1)
 *    used to trip.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { importFromContent } from '../src/core/import-file.ts';

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

let engine: PGLiteEngine;

async function pageCountBySource(): Promise<Record<string, number>> {
  const rows = await engine.executeRaw<{ source_id: string; n: number }>(
    `SELECT source_id, COUNT(*)::int AS n FROM pages GROUP BY source_id`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.source_id] = r.n;
  return out;
}

/** Create a throwaway git repo with one committed topic page. */
function makeRepoWithPage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-explicit-src-'));
  execFileSync('git', ['-C', dir, 'init', '-q'], { env: GIT_ENV });
  mkdirSync(join(dir, 'topics'), { recursive: true });
  writeFileSync(join(dir, 'topics/foo.md'), [
    '---',
    'type: concept',
    'title: Foo Topic',
    '---',
    '',
    'Test content for explicit-source binding.',
  ].join('\n'));
  execFileSync('git', ['-C', dir, 'add', '-A'], { env: GIT_ENV });
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'initial'], {
    env: GIT_ENV,
  });
  return dir;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

describe('explicit sourceId threads through runCycle sync phase', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = makeRepoWithPage();
  });

  afterEach(async () => {
    // Clear pages + non-default sources between cases so counts are unambiguous.
    // Also clear the GLOBAL sync.last_commit config key: the full-import path
    // (import.ts) writes that global anchor regardless of the scoped sourceId,
    // so a prior case's anchor would otherwise make the next fresh repo look
    // already-synced (an unrelated pre-existing quirk; each test wants a clean
    // first-sync, which is also the real per-machine first-run scenario).
    await engine.executeRaw(`DELETE FROM pages`);
    await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
    await engine.executeRaw(`DELETE FROM config WHERE key = 'sync.last_commit'`);
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('runCycle with explicit sourceId routes pages to that source, not path auto-detection', async () => {
    // Register source 'X' under a local_path that does NOT match repoPath, so
    // path-based resolveSourceForDir would MISS (→ undefined → 'default').
    // The explicit sourceId must win and route pages into 'X'.
    const otherMachinePath = '/some/other/machine/clone';
    expect(otherMachinePath).not.toBe(repoPath);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $2, $3, '{}'::jsonb)`,
      ['X', 'X', otherMachinePath],
    );

    const report = await runCycle(engine, {
      brainDir: repoPath,
      phases: ['sync'],
      pull: false,
      sourceId: 'X',
    });

    const syncPhase = report.phases.find((p) => p.phase === 'sync');
    expect(syncPhase?.status).not.toBe('error');

    const counts = await pageCountBySource();
    expect(counts['X']).toBeGreaterThan(0);
    expect(counts['default'] ?? 0).toBe(0);
  });

  test('runCycle WITHOUT explicit sourceId falls back to path auto-detection (default when no match)', async () => {
    // No source row matches repoPath and no explicit id → resolveSourceForDir
    // returns undefined → sync targets 'default'. Proves the explicit id is
    // what changed routing in the prior case, not some unrelated default.
    const report = await runCycle(engine, {
      brainDir: repoPath,
      phases: ['sync'],
      pull: false,
    });

    const syncPhase = report.phases.find((p) => p.phase === 'sync');
    expect(syncPhase?.status).not.toBe('error');

    const counts = await pageCountBySource();
    expect(counts['default']).toBeGreaterThan(0);
    expect(counts['X'] ?? 0).toBe(0);
  });
});

describe('importFromContent existence read is scoped to the write source', () => {
  test('page that exists ONLY under a non-default source does not break an undefined-sourceId import', async () => {
    const NOTES_SRC = 'notes';
    const SLUG = 'topics/multi-machine-stranded-page';

    // Ensure the `notes` source row exists (pages.source_id FKs to sources).
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $2, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [NOTES_SRC, NOTES_SRC],
    );

    // Seed a page ONLY under the `notes` source (no 'default' row exists).
    // This mirrors the production state: the page was imported correctly on
    // the Mac under `notes`, and the shared Postgres carries only that row.
    await engine.putPage(
      SLUG,
      {
        type: 'concept',
        title: 'Lives only under notes',
        compiled_truth: 'Original body authored on the Mac.',
      },
      { sourceId: NOTES_SRC },
    );

    const md = `---
type: concept
title: Updated by an unscoped sync
---

# Updated by an unscoped sync

This import arrives with sourceId undefined (the unscoped-sync case).
`;

    // Pre-fix: getPage(slug, undefined) finds the notes row (existing
    // truthy), then createVersion(slug, undefined) looks under 'default',
    // finds nothing, and throws `createVersion failed ... (source=default)
    // not found`. Post-fix: the read is scoped to 'default' (the effective
    // write source), finds no row, skips createVersion, and putPage creates
    // a clean 'default' row.
    let err: Error | null = null;
    let result: Awaited<ReturnType<typeof importFromContent>> | null = null;
    try {
      result = await importFromContent(engine, SLUG, md, { noEmbed: true });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeNull();
    expect(result!.status).toBe('imported');

    // Both rows now coexist: the original notes row is untouched, and a fresh
    // default row carries the unscoped import.
    const rows = await engine.executeRaw<{ source_id: string; title: string }>(
      `SELECT source_id, title FROM pages WHERE slug = $1 ORDER BY source_id`,
      [SLUG],
    );
    expect(rows.length).toBe(2);
    const def = rows.find((r) => r.source_id === 'default')!;
    const notes = rows.find((r) => r.source_id === NOTES_SRC)!;
    expect(def.title).toBe('Updated by an unscoped sync');
    expect(notes.title).toBe('Lives only under notes');
  });
});
