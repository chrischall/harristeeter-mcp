import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionSyncTest } from '@chrischall/mcp-utils/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

describe('version sync', () => {
  it('every x-release-please-version marker in src matches package.json', () => {
    expect(
      versionSyncTest({ srcDir: join(ROOT, 'src'), pkgPath: join(ROOT, 'package.json') })
    ).toEqual([]);
  });

  // The manifests below are only kept in step by release-please's `extra-files`
  // registration. A file that carries the version but is missing from that list
  // drifts silently at the next release, so assert each one here — this test is
  // the thing that fails the release PR's CI when the registration is wrong.
  it.each([
    ['manifest.json', () => readJson('manifest.json').version],
    ['server.json', () => readJson('server.json').version],
    ['server.json packages[0]', () => readJson('server.json').packages[0].version],
    ['.claude-plugin/plugin.json', () => readJson('.claude-plugin/plugin.json').version],
    [
      '.claude-plugin/marketplace.json metadata',
      () => readJson('.claude-plugin/marketplace.json').metadata.version,
    ],
    [
      '.claude-plugin/marketplace.json plugins[0]',
      () => readJson('.claude-plugin/marketplace.json').plugins[0].version,
    ],
    ['.release-please-manifest.json', () => readJson('.release-please-manifest.json')['.']],
  ])('%s matches package.json', (_label, get) => {
    expect(get()).toBe(pkgVersion);
  });

  it('release-please registers every file that carries the version', () => {
    const cfg = readJson('release-please-config.json').packages['.'];
    const registered = new Set(
      (cfg['extra-files'] as (string | { path: string })[]).map((e) =>
        typeof e === 'string' ? e : e.path
      )
    );
    for (const f of [
      'manifest.json',
      'server.json',
      '.claude-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      'src/version.ts',
    ]) {
      expect(registered, `${f} missing from release-please extra-files`).toContain(f);
    }
  });

  it('is configured so the FIRST release is 0.1.0, not 1.0.0', () => {
    const cfg = readJson('release-please-config.json').packages['.'];
    // With no prior tag release-please applies its initial-release default and
    // proposes 1.0.0 — a brand-new server advertising a stable API it has not
    // earned. `initial-version` pins that first release, and it is the only
    // half of this still worth asserting.
    //
    // `bump-minor-pre-major` used to be asserted here too, and it was a
    // DIFFERENT claim wearing the same sentence: it governs every later
    // breaking change rather than the first release, and it does so by
    // downgrading one to a minor for as long as the package sits below 1.0.
    // That kept this server on 0.x through the SDK v2 migration — a breaking
    // change with its own warning section in the changelog — and would have
    // kept it there indefinitely. It is removed, so a breaking commit now
    // cuts a major on its own, and the guard is not reinstated: the version
    // this repo has earned is the one release-please should be free to
    // propose.
    //
    // Deliberately NOT asserted here: that the manifest still reads its 0.0.0
    // seed. Advancing that value is release-please's whole job, so pinning it
    // made this test a one-shot tripwire that failed on the first release PR
    // (v0.1.0) — the assertion described a transient state, not an invariant.
    // The manifest is already checked against package.json above.
    expect(cfg['initial-version']).toBe('0.1.0');
    expect(cfg['bump-minor-pre-major']).toBeUndefined();
  });
});
