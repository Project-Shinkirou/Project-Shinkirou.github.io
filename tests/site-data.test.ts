// Behaviour edges of the portal data contract that pages rely on. Run with
// `npm test` (Node's built-in runner; Node strips the TypeScript types).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localizedText } from '../src/lib/i18n.ts';
import { readFileSync } from 'node:fs';
import { managerDownloads } from '../src/lib/platforms.ts';
import {
  BUILD_CORES_SCHEMA,
  BUILD_TARGETS_SCHEMA,
  CORE_VERSIONS_SCHEMA,
  VNDB_COVERAGE_SCHEMA,
  parseBuildInventory,
  parseManagerRelease,
  parseVndbCoverage,
} from '../src/lib/site-data.ts';

const FORK_REV = 'a'.repeat(40);
const OWNED_REV = 'b'.repeat(40);

const targets = {
  schema: BUILD_TARGETS_SCHEMA,
  targets: [
    { triple: 'x86_64-pc-windows-msvc', platform: 'windows', architecture: 'x86_64', variant: 'desktop', manager_supported: true },
    { triple: 'aarch64-apple-ios', platform: 'ios', architecture: 'aarch64', variant: 'device', manager_supported: true },
  ],
};

function cores(staticTargets: string[]): unknown {
  return {
    schema: BUILD_CORES_SCHEMA,
    cores: [
      {
        id: 'forked',
        display_name: 'Forked',
        family_name: 'Forked',
        license: 'MIT',
        supported_targets: ['x86_64-pc-windows-msvc'],
        blocked: [{ target: 'aarch64-apple-ios', reason: 'no standalone iOS package' }],
        static_manager_targets: staticTargets,
        source: {
          repo: 'https://github.com/Project-Shinkirou/forked',
          rev: FORK_REV,
          upstream: 'https://github.com/original/forked',
        },
      },
      {
        id: 'owned',
        display_name: 'Owned',
        family_name: 'Owned',
        license: 'MIT',
        supported_targets: ['x86_64-pc-windows-msvc', 'aarch64-apple-ios'],
      },
    ],
  };
}

function versions(forkRev: string): unknown {
  return {
    schema: CORE_VERSIONS_SCHEMA,
    cores: { forked: { version: '1.2.3', rev: forkRev }, owned: { version: '0.4.0', rev: OWNED_REV } },
  };
}

test('a static Manager target overrides the blocked package state and keeps its reason', () => {
  const [forked] = parseBuildInventory(targets, cores(['aarch64-apple-ios']), versions(FORK_REV)).cores;
  assert.deepEqual(forked.targets, [
    { target: 'x86_64-pc-windows-msvc', status: 'supported', reason: null },
    { target: 'aarch64-apple-ios', status: 'static', reason: 'no standalone iOS package' },
  ]);
});

test('without static_manager_targets a blocked target stays blocked', () => {
  const [forked] = parseBuildInventory(targets, cores([]), versions(FORK_REV)).cores;
  assert.equal(forked.targets[1].status, 'blocked');
});

test('third-party cores carry the fork, pinned revision and upstream; owned cores have no upstream', () => {
  const [forked, owned] = parseBuildInventory(targets, cores([]), versions(FORK_REV)).cores;
  assert.equal(forked.version, '1.2.3');
  assert.equal(forked.revision, FORK_REV);
  assert.equal(forked.repo, 'https://github.com/Project-Shinkirou/forked');
  assert.equal(forked.upstream, 'https://github.com/original/forked');
  assert.equal(owned.revision, OWNED_REV);
  assert.equal(owned.repo, 'https://github.com/Project-Shinkirou/ShinkiEMU');
  assert.equal(owned.upstream, null);
});

test('a version resolved at a different revision than the fork pin is rejected', () => {
  assert.throws(
    () => parseBuildInventory(targets, cores([]), versions('c'.repeat(40))),
    /core-versions\.json\.cores\.forked\.rev: does not match the pinned \[cores\.source\]\.rev/,
  );
});

test('a blocked target overrides supported_targets, static targets and manager_supported', () => {
  const reason = 'Apple builds are excluded from current CI and releases until the cross-build toolchain is validated.';
  const blockedTargets = {
    ...targets,
    targets: targets.targets.map((target) => (target.triple === 'aarch64-apple-ios' ? { ...target, blocked: reason } : target)),
  };
  const inventory = parseBuildInventory(blockedTargets, cores(['aarch64-apple-ios']), versions(FORK_REV));
  assert.deepEqual(
    inventory.targets.map((target) => target.manager),
    [
      { target: 'x86_64-pc-windows-msvc', status: 'supported', reason: null },
      { target: 'aarch64-apple-ios', status: 'blocked', reason },
    ],
  );
  for (const core of inventory.cores) {
    assert.deepEqual(core.targets, [
      { target: 'x86_64-pc-windows-msvc', status: 'supported', reason: null },
      { target: 'aarch64-apple-ios', status: 'blocked', reason },
    ]);
  }
});

test('an empty blocked string leaves the target unaffected', () => {
  const emptyBlocked = { ...targets, targets: targets.targets.map((target) => ({ ...target, blocked: '' })) };
  const [, owned] = parseBuildInventory(emptyBlocked, cores([]), versions(FORK_REV)).cores;
  assert.equal(owned.targets[1].status, 'supported');
});

test('Japanese text falls back to English, then Chinese', () => {
  const all = { 'zh-CN': '中文', en: 'English', ja: '日本語' };
  const noJa = { 'zh-CN': '中文', en: 'English' };
  assert.deepEqual(localizedText(all, 'ja'), { text: '日本語', lang: 'ja' });
  assert.deepEqual(localizedText(noJa, 'ja'), { text: 'English', lang: 'en' });
  assert.deepEqual(localizedText(all, 'en'), { text: 'English', lang: 'en' });
  assert.deepEqual(localizedText(all, 'zh-cn'), { text: '中文', lang: 'zh-CN' });
});

test('a universal Android APK is downloadable while its sources ZIP is excluded', () => {
  const version = '0.1.0-beta.4';
  const tag = `manager-v${version}`;
  const names = [`shinki-emu-manager-manager-${version}-android-universal.apk`, `shinki-emu-manager-${version}-android-aarch64-sources.zip`];
  const release = parseManagerRelease({
    schema: 'shinki.portal.manager_release.v1',
    release: {
      tag, version, prerelease: true, published_at: '2026-10-30T00:00:00Z',
      html_url: `https://github.com/Project-Shinkirou/ShinkiEMU/releases/tag/${tag}`,
      assets: names.map(name => ({ name, url: `https://github.com/Project-Shinkirou/ShinkiEMU/releases/download/${tag}/${name}`, size: 1, sha256: null })),
    },
  }, tag);
  assert.equal(release?.assets.length, 1);
  assert.equal(release?.assets[0].architecture, 'universal');
  assert.equal(release?.assets[0].url.endsWith('.apk'), true);
});

test('an OHOS test-signed HAP is classified as a device test package while preserving APK/desktop entries and rejecting malformed HAPs', () => {
  const version = '0.1.0-beta.5';
  const tag = `manager-v${version}`;
  const names = [
    `shinki-emu-manager-manager-${version}-windows-x86_64.zip`,
    `shinki-emu-manager-manager-${version}-linux-x86_64.zip`,
    `shinki-emu-manager-manager-${version}-macos-aarch64.zip`,
    `shinki-emu-manager-manager-${version}-android-universal.apk`,
    `shinki-emu-manager-manager-${version}-ios-aarch64-device-test.zip`,
    `shinki-emu-manager-manager-${version}-ohos-aarch64-debug-test-signed.hap`,
    `shinki-emu-manager-${version}-ohos-aarch64-debug-test-signed-sources.zip`,
    `shinki-emu-manager-${version}-android-aarch64-sources.zip`,
    `shinki-emu-manager-manager-${version}-ohos-aarch64.hap`,
    `shinki-emu-manager-manager-${version}-ohos-x86_64-debug-test-signed.hap`,
    `shinki-emu-manager-manager-${version}-ohos-aarch64.zip`,
    `shinki-emu-manager-${version}-ohos-aarch64-debug-test-signed.hap`,
    'unrelated-package.hap',
  ];
  const release = parseManagerRelease(
    {
      schema: 'shinki.portal.manager_release.v1',
      release: {
        tag,
        version,
        prerelease: true,
        published_at: '2026-10-31T00:00:00Z',
        html_url: `https://github.com/Project-Shinkirou/ShinkiEMU/releases/tag/${tag}`,
        assets: names.map((name) => ({
          name,
          url: `https://github.com/Project-Shinkirou/ShinkiEMU/releases/download/${tag}/${name}`,
          size: 1,
          sha256: null,
        })),
      },
    },
    tag,
  );
  assert.deepEqual(
    release?.assets.map(({ name, platform, architecture, variant }) => ({ name, platform, architecture, variant })),
    [
      {
        name: `shinki-emu-manager-manager-${version}-windows-x86_64.zip`,
        platform: 'windows',
        architecture: 'x86_64',
        variant: null,
      },
      {
        name: `shinki-emu-manager-manager-${version}-linux-x86_64.zip`,
        platform: 'linux',
        architecture: 'x86_64',
        variant: null,
      },
      {
        name: `shinki-emu-manager-manager-${version}-macos-aarch64.zip`,
        platform: 'macos',
        architecture: 'aarch64',
        variant: null,
      },
      {
        name: `shinki-emu-manager-manager-${version}-android-universal.apk`,
        platform: 'android',
        architecture: 'universal',
        variant: null,
      },
      {
        name: `shinki-emu-manager-manager-${version}-ios-aarch64-device-test.zip`,
        platform: 'ios',
        architecture: 'aarch64',
        variant: 'device',
      },
      {
        name: `shinki-emu-manager-manager-${version}-ohos-aarch64-debug-test-signed.hap`,
        platform: 'ohos',
        architecture: 'aarch64',
        variant: 'device',
      },
    ],
  );

  const downloads = managerDownloads(
    [
      {
        triple: 'aarch64-unknown-linux-ohos',
        platform: 'ohos',
        architecture: 'aarch64',
        variant: 'device',
        manager: { target: 'aarch64-unknown-linux-ohos', status: 'supported', reason: null },
      },
    ],
    release,
  );
  const ohos = downloads.find((card) => card.platform === 'ohos');
  assert.equal(ohos?.state, 'test');
  assert.equal(ohos?.direct, null);
  assert.equal(ohos?.assets.length, 1);

  const fixture = JSON.parse(readFileSync(new URL('../fixtures/synthetic/data/manager-release.json', import.meta.url), 'utf8'));
  const parsedFixture = parseManagerRelease(fixture, 'manager-v0.1.0-beta.2');
  assert.deepEqual(
    parsedFixture?.assets.map(({ platform, architecture, variant }) => ({ platform, architecture, variant })),
    [
      { platform: 'windows', architecture: 'x86_64', variant: null },
      { platform: 'linux', architecture: 'x86_64', variant: null },
      { platform: 'android', architecture: 'universal', variant: null },
      { platform: 'ios', architecture: 'aarch64', variant: 'device' },
      { platform: 'ohos', architecture: 'aarch64', variant: 'device' },
    ],
  );
});

const coverage = (families: unknown[], engine_releases = 1000) => ({
  schema: VNDB_COVERAGE_SCHEMA,
  fetched_at: '2026-10-30T00:00:00Z',
  engine_releases,
  families,
});
const family = (name: string, engine: string, releases: number) => ({ family: name, engines: [engine], releases });

test('VNDB coverage sums the family counts against releases with an engine', () => {
  const parsed = parseVndbCoverage(coverage([family('CMVS', 'CMVS', 70), family('Ren’Py', "Ren'Py", 300)]), ['CMVS', 'Ren’Py']);
  assert.equal(parsed.total, 370);
  assert.equal(parsed.engine_releases, 1000);
  assert.deepEqual(parsed.families.map((entry) => entry.family), ['CMVS', 'Ren’Py']);
});

test('VNDB coverage must list exactly the inventory families', () => {
  assert.throws(() => parseVndbCoverage(coverage([family('CMVS', 'CMVS', 70)]), ['CMVS', 'FVP']), /no counts for FVP/);
  assert.throws(
    () => parseVndbCoverage(coverage([family('CMVS', 'CMVS', 70), family('FVP', 'FVP', 60)]), ['CMVS']),
    /not in build-cores\.toml: FVP/,
  );
});

test('VNDB coverage rejects zero counts, shared engine strings, inflated totals and unknown fields', () => {
  assert.throws(() => parseVndbCoverage(coverage([family('CMVS', 'CMVS', 0)]), ['CMVS']), /releases: must be an integer/);
  assert.throws(
    () => parseVndbCoverage(coverage([family('A', 'X', 1), family('B', 'X', 1)]), ['A', 'B']),
    /"X" is mapped to two families/,
  );
  assert.throws(() => parseVndbCoverage(coverage([family('CMVS', 'CMVS', 70)], 10), ['CMVS']), /exceed releases with an engine/);
  assert.throws(() => parseVndbCoverage({ ...coverage([]), share: 0.5 }, []), /unknown field "share"/);
  assert.throws(() => parseVndbCoverage({ ...coverage([]), schema: 'v0' }, []), /schema: must be/);
});
