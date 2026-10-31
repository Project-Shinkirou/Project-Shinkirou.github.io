// Behaviour edges of the portal data contract that pages rely on. Run with
// `npm test` (Node's built-in runner; Node strips the TypeScript types).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { localizedText } from '../src/lib/i18n.ts';
import { readFileSync } from 'node:fs';
import { managerDownloads } from '../src/lib/platforms.ts';
import {
  BUILD_CORES_SCHEMA,
  BUILD_TARGETS_SCHEMA,
  COMPATIBILITY_SCHEMA,
  COMPATIBILITY_V5_SCHEMA,
  CORES_SCHEMA,
  CORES_V2_SCHEMA,
  CORE_VERSIONS_SCHEMA,
  RELEASE_DOWNLOAD_PREFIX,
  VNDB_COVERAGE_SCHEMA,
  coreReleaseLabel,
  latestCoreRelease,
  parseBuildInventory,
  parseCompatibility,
  parseCores,
  parseManagerRelease,
  parseVndbCoverage,
  sortCoreReleases,
  type CoreIdentity,
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

const UPSTREAM_COMMIT = '1'.repeat(40);
const ADAPTER_COMMIT = '7c241b477fb10efd981b20af67b1fb9745ec97fe';

function upstreamIdentity(overrides: Partial<CoreIdentity['upstream']> = {}): CoreIdentity['upstream'] {
  return {
    repo: 'https://github.com/xmoezzz/rfvp',
    ref_kind: 'tag',
    ref_name: 'v0.2.0',
    commit: UPSTREAM_COMMIT,
    ...overrides,
  };
}

function adapterIdentity(overrides: Partial<CoreIdentity['adapter']> = {}): CoreIdentity['adapter'] {
  return {
    repo: 'https://github.com/Project-Shinkirou/rfvp',
    branch: 'shinki',
    commit: ADAPTER_COMMIT,
    ...overrides,
  };
}

function coreIdentity(overrides: Partial<CoreIdentity> = {}): CoreIdentity {
  return {
    upstream: upstreamIdentity(overrides.upstream),
    adapter: adapterIdentity(overrides.adapter),
    release_sequence: overrides.release_sequence ?? 2,
  };
}

/** Mirror of the metadata contract, used to build and cross-check test vectors. */
function catalogVersion(identity: CoreIdentity): string {
  const canonical = [
    identity.upstream.repo,
    identity.upstream.ref_kind,
    identity.upstream.ref_name,
    identity.upstream.commit,
    identity.adapter.repo,
    identity.adapter.branch,
    identity.adapter.commit,
    String(identity.release_sequence),
  ]
    .map((field) => `${field}\n`)
    .join('');
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  const slug = identity.upstream.ref_name.slice(0, 16).replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
  return `${identity.upstream.ref_kind}-${slug}-${digest}`;
}

function legacyEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plugin_id: 'rfvp',
    display_name: 'RFVP',
    family_name: 'FVP',
    version: '0.1.0-beta.1',
    abi: 'shinki.emu.native.c.v3',
    platform: 'windows-x86_64',
    url: `${RELEASE_DOWNLOAD_PREFIX}core-rfvp-v0.1.0-beta.1/shinki-emu-core-rfvp-0.1.0-beta.1-windows-x86_64.zip`,
    sha256: 'f'.repeat(64),
    size: 1024,
    license: 'MPL-2.0',
    release_tag: 'core-rfvp-v0.1.0-beta.1',
    ...overrides,
  };
}

function externalEntry(
  pluginId: string,
  identity: CoreIdentity,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const version = catalogVersion(identity);
  const release_tag = `core-${pluginId.toLowerCase().replace(/[._]/g, '-')}-${version}`;
  const platform = String(overrides.platform ?? 'windows-x86_64');
  return {
    plugin_id: pluginId,
    display_name: 'RFVP',
    family_name: 'FVP',
    version,
    abi: 'shinki.emu.native.c.v3',
    platform,
    url: `${RELEASE_DOWNLOAD_PREFIX}${release_tag}/shinki-emu-core-${pluginId}-${version}-${platform}.zip`,
    sha256: 'a'.repeat(64),
    size: 2048,
    license: 'MPL-2.0',
    release_tag,
    identity,
    ...overrides,
  };
}

function catalogV2(entries: unknown[]): unknown {
  return { schema: CORES_V2_SCHEMA, entries };
}

test('legacy cores.v1 entries stay SemVer and carry no identity', () => {
  const [release] = parseCores({ schema: CORES_SCHEMA, entries: [legacyEntry()] }, new Set(['rfvp']));
  assert.equal(release.version, '0.1.0-beta.1');
  assert.equal(release.identity, null);
  assert.equal(coreReleaseLabel(release), '0.1.0-beta.1');
});

test('cores-v2 keeps legacy history and validates a tag identity digest', () => {
  const identity = coreIdentity();
  const version = 'tag-v0-2-0-c905156a27f88c96c23ed0e2b4248dc9d6edbaaa8cc2c525a7d6844422e1d3b8';
  assert.equal(catalogVersion(identity), version);
  const releases = parseCores(catalogV2([legacyEntry(), externalEntry('rfvp', identity, { version })]), new Set(['rfvp']));
  assert.equal(releases.length, 2);
  assert.equal(releases[1].version, version);
  assert.deepEqual(releases[1].identity, identity);
  assert.equal(releases[1].release_tag, `core-rfvp-${version}`);
  assert.equal(coreReleaseLabel(releases[1]), 'v0.2.0@111111111111 (adapter 7c241b477fb1)');
});

test('a slash branch keeps its raw ref and a 16-byte digest slug', () => {
  const identity = coreIdentity({
    upstream: upstreamIdentity({
      repo: 'https://github.com/xmoezzz/siglus_rs',
      ref_kind: 'branch',
      ref_name: 'feature/save-load',
      commit: '2'.repeat(40),
    }),
    adapter: adapterIdentity({
      repo: 'https://github.com/Project-Shinkirou/siglus_rs',
      commit: '2436c25fc966306e03cdada833b507eec97b51c4',
    }),
    release_sequence: 7,
  });
  const version = catalogVersion(identity);
  assert.match(version, /^branch-feature-save-loa-[0-9a-f]{64}$/);
  assert.equal(version.length, 88);
  const [release] = parseCores(catalogV2([externalEntry('siglus_rs', identity)]), new Set(['siglus_rs']));
  assert.equal(release.identity?.upstream.ref_name, 'feature/save-load');
  assert.equal(release.version, version);
  assert.equal(coreReleaseLabel(release), 'feature/save-load@222222222222 (adapter 2436c25fc966)');
});

test('cores.v1 rejects identity and v2 rejects a null identity', () => {
  const identity = coreIdentity();
  assert.throws(
    () => parseCores({ schema: CORES_SCHEMA, entries: [externalEntry('rfvp', identity)] }, new Set(['rfvp'])),
    /only shinki\.emu\.cores\.v2 entries carry identity/,
  );
  assert.throws(
    () => parseCores(catalogV2([{ ...legacyEntry(), identity: null }]), new Set(['rfvp'])),
    /identity: must be omitted, not null/,
  );
});

test('identity version and release tag must match the provenance digest', () => {
  const identity = coreIdentity();
  assert.throws(
    () => parseCores(catalogV2([externalEntry('rfvp', identity, { version: `tag-v0-2-0-${'0'.repeat(64)}` })]), new Set(['rfvp'])),
    /does not match the provenance digest/,
  );
  assert.throws(
    () => parseCores(catalogV2([externalEntry('rfvp', identity, { release_tag: 'core-other-wrong' })]), new Set(['rfvp'])),
    /release_tag: must be core-rfvp-/,
  );
});

test('identity fields reject unsupported refs, repos, commits and sequences', () => {
  const invalid = (identity: CoreIdentity) =>
    parseCores(catalogV2([externalEntry('rfvp', identity)]), new Set(['rfvp']));
  assert.throws(() => invalid(coreIdentity({ upstream: upstreamIdentity({ ref_kind: 'commit' as 'tag' }) })), /ref_kind/);
  assert.throws(() => invalid(coreIdentity({ upstream: upstreamIdentity({ commit: 'A'.repeat(40) }) })), /upstream\.commit/);
  assert.throws(() => invalid(coreIdentity({ upstream: upstreamIdentity({ ref_name: 'feature branch' }) })), /valid Git ref/);
  assert.throws(() => invalid(coreIdentity({ upstream: upstreamIdentity({ repo: 'https://github.com/Project-Shinkirou/rfvp' }) })), /original project/);
  assert.throws(() => invalid(coreIdentity({ adapter: adapterIdentity({ repo: 'https://github.com/other/rfvp' }) })), /organization fork/);
  assert.throws(() => invalid(coreIdentity({ release_sequence: 0 })), /release_sequence/);
});

test('Git refs accept the backend charset and reject unsafe segments', () => {
  const valid = coreIdentity({ upstream: upstreamIdentity({ ref_name: 'A-1_2.3+4/abc' }) });
  const [release] = parseCores(catalogV2([externalEntry('rfvp', valid)]), new Set(['rfvp']));
  assert.equal(release.identity?.upstream.ref_name, 'A-1_2.3+4/abc');
  const invalidRef = (ref: string) =>
    parseCores(catalogV2([externalEntry('rfvp', coreIdentity({ upstream: upstreamIdentity({ ref_name: ref }) }))]), new Set(['rfvp']));
  for (const ref of [
    '../evil',
    '.hidden',
    'foo/.hidden',
    'foo.lock',
    'foo/bar.lock',
    'foo//bar',
    '/foo',
    'foo/',
    'foo@bar',
    'foo\\bar',
    'foo.',
    'foo@{bar',
    'foo bar',
  ]) {
    assert.throws(() => invalidRef(ref), /valid Git ref/, ref);
  }
});

test('core repositories reject dot segments, forks and .git suffixes', () => {
  const invalid = (identity: CoreIdentity) =>
    parseCores(catalogV2([externalEntry('rfvp', identity)]), new Set(['rfvp']));
  for (const repo of ['https://github.com/./rfvp', 'https://github.com/../rfvp', 'https://github.com/xmoezzz/..']) {
    assert.throws(
      () => invalid(coreIdentity({ upstream: upstreamIdentity({ repo }) })),
      /owner and repository/,
      repo,
    );
  }
  assert.throws(
    () => invalid(coreIdentity({ upstream: upstreamIdentity({ repo: 'https://github.com/project-shinkirou/rfvp' }) })),
    /original project/,
  );
  assert.throws(
    () => invalid(coreIdentity({ adapter: adapterIdentity({ repo: 'https://github.com/Project-Shinkirou/rfvp.git' }) })),
    /\.git/,
  );
});

test('legacy core versions stay within 64 characters', () => {
  const version = `0.1.0-${'a'.repeat(60)}`;
  assert.throws(
    () =>
      parseCores(
        {
          schema: CORES_SCHEMA,
          entries: [
            legacyEntry({
              version,
              release_tag: 'core-rfvp-long',
              url: `${RELEASE_DOWNLOAD_PREFIX}core-rfvp-long/a.zip`,
            }),
          ],
        },
        new Set(['rfvp']),
      ),
    /legacy core version exceeds 64 characters/,
  );
});

test('compatibility v4 caps emulator versions at 64 and v5 allows 88', () => {
  const snapshot = (schema: string, emulatorVersion: string, managerVersion = '1.0.0') => ({
    schema,
    generated_at_unix_ms: 0,
    entries: [
      {
        vn_id: 'v1',
        release_id: 'r1',
        emulator: 'rfvp',
        status: 'perfect',
        notes: null,
        emulator_version: emulatorVersion,
        manager_version: managerVersion,
        platform: 'windows',
        architecture: 'x86_64',
        variant: 'desktop',
        issue: null,
        updated_at_unix_ms: 0,
      },
    ],
  });
  const parse = (value: unknown) => parseCompatibility(value, new Set(['rfvp']));
  assert.equal(parse(snapshot(COMPATIBILITY_SCHEMA, 'a'.repeat(64)))[0].emulator_version, 'a'.repeat(64));
  assert.throws(() => parse(snapshot(COMPATIBILITY_SCHEMA, 'a'.repeat(65))), /emulator_version/);
  assert.throws(() => parse(snapshot(COMPATIBILITY_SCHEMA, 'a'.repeat(88))), /emulator_version/);
  assert.equal(parse(snapshot(COMPATIBILITY_V5_SCHEMA, 'a'.repeat(88)))[0].emulator_version, 'a'.repeat(88));
  assert.throws(() => parse(snapshot(COMPATIBILITY_V5_SCHEMA, 'a'.repeat(89))), /emulator_version/);
  assert.throws(
    () => parse(snapshot(COMPATIBILITY_V5_SCHEMA, 'a'.repeat(64), 'b'.repeat(65))),
    /manager_version/,
  );
});

test('external core slugs stay inside the 32-byte release tag budget', () => {
  const pluginId = 'a'.repeat(33);
  assert.throws(
    () => parseCores(catalogV2([externalEntry(pluginId, coreIdentity())]), new Set([pluginId])),
    /external core slug exceeds 32 characters/,
  );
});

test('one release_sequence may span platforms but not versions', () => {
  const identity = coreIdentity();
  const releases = parseCores(
    catalogV2([
      externalEntry('rfvp', identity, { platform: 'windows-x86_64' }),
      externalEntry('rfvp', identity, { platform: 'linux-x86_64' }),
    ]),
    new Set(['rfvp']),
  );
  assert.equal(releases.length, 2);
  assert.equal(new Set(releases.map((release) => release.version)).size, 1);
  const another = coreIdentity({
    upstream: upstreamIdentity({ ref_name: 'v0.3.0', commit: '3'.repeat(40) }),
  });
  assert.throws(
    () => parseCores(catalogV2([externalEntry('rfvp', identity), externalEntry('rfvp', another)]), new Set(['rfvp'])),
    /is reused with a different version/,
  );
});

test('release order uses release_sequence and SemVer, never branch text', () => {
  const sequence2 = coreIdentity({
    upstream: upstreamIdentity({ ref_name: 'release/9', commit: '4'.repeat(40) }),
    release_sequence: 2,
  });
  const sequence10 = coreIdentity({
    upstream: upstreamIdentity({ ref_name: 'release/10', commit: '5'.repeat(40) }),
    release_sequence: 10,
  });
  const releases = parseCores(
    catalogV2([
      legacyEntry({ version: '0.1.0-beta.9', platform: 'windows-x86_64', release_tag: 'core-rfvp-v0.1.0-beta.9', url: `${RELEASE_DOWNLOAD_PREFIX}core-rfvp-v0.1.0-beta.9/a.zip` }),
      legacyEntry({ version: '0.1.0-beta.10', platform: 'linux-x86_64', release_tag: 'core-rfvp-v0.1.0-beta.10', url: `${RELEASE_DOWNLOAD_PREFIX}core-rfvp-v0.1.0-beta.10/b.zip` }),
      legacyEntry({ version: '9.9.9', platform: 'macos-aarch64', release_tag: 'core-rfvp-v9.9.9', url: `${RELEASE_DOWNLOAD_PREFIX}core-rfvp-v9.9.9/c.zip` }),
      externalEntry('rfvp', sequence2, { platform: 'windows-x86_64' }),
      externalEntry('rfvp', sequence10, { platform: 'windows-x86_64' }),
    ]),
    new Set(['rfvp']),
  );
  const sorted = sortCoreReleases(releases);
  assert.deepEqual(
    sorted.map((release) => release.identity?.release_sequence ?? release.version),
    [10, 2, '9.9.9', '0.1.0-beta.10', '0.1.0-beta.9'],
  );
  assert.equal(latestCoreRelease(releases)?.identity?.release_sequence, 10);
});

test('legacy-only cores pick the highest SemVer, including prerelease numbers', () => {
  const releases = parseCores(
    catalogV2([
      legacyEntry({ version: '0.1.0-beta.9', platform: 'windows-x86_64', release_tag: 'core-rfvp-v0.1.0-beta.9', url: `${RELEASE_DOWNLOAD_PREFIX}core-rfvp-v0.1.0-beta.9/a.zip` }),
      legacyEntry({ version: '0.1.0-beta.10', platform: 'linux-x86_64', release_tag: 'core-rfvp-v0.1.0-beta.10', url: `${RELEASE_DOWNLOAD_PREFIX}core-rfvp-v0.1.0-beta.10/b.zip` }),
      legacyEntry({ version: '0.1.0', platform: 'macos-aarch64', release_tag: 'core-rfvp-v0.1.0', url: `${RELEASE_DOWNLOAD_PREFIX}core-rfvp-v0.1.0/c.zip` }),
    ]),
    new Set(['rfvp']),
  );
  assert.equal(latestCoreRelease(releases)?.version, '0.1.0');
  assert.deepEqual(sortCoreReleases(releases).map((release) => release.version), ['0.1.0', '0.1.0-beta.10', '0.1.0-beta.9']);
});

test('build inventory carries the adapter branch and validates the readable label', () => {
  const inventory = cores([]) as {
    schema: string;
    cores: { source?: Record<string, unknown> }[];
  };
  inventory.cores[0].source = {
    repo: 'https://github.com/Project-Shinkirou/forked',
    branch: 'shinki',
    rev: FORK_REV,
    upstream: 'https://github.com/original/forked',
    upstream_identity: {
      repo: 'https://github.com/original/forked',
      ref_kind: 'tag',
      ref_name: 'v0.2.0',
      commit: UPSTREAM_COMMIT,
    },
    release_sequence: 2,
  };
  const versionsFile = versions(FORK_REV) as {
    schema: string;
    cores: Record<string, { version: string; rev: string }>;
  };
  versionsFile.cores.forked.version = 'v0.2.0@111111111111 (adapter aaaaaaaaaaaa)';
  const [forked] = parseBuildInventory(targets, inventory, versionsFile).cores;
  assert.equal(forked.adapter_branch, 'shinki');
  assert.equal(forked.identity?.upstream.ref_name, 'v0.2.0');
  assert.equal(forked.version, 'v0.2.0@111111111111 (adapter aaaaaaaaaaaa)');
  versionsFile.cores.forked.version = '0.2.0';
  assert.throws(
    () => parseBuildInventory(targets, inventory, versionsFile),
    /core-versions\.json\.cores\.forked\.version: must be v0\.2\.0@111111111111 \(adapter aaaaaaaaaaaa\)/,
  );

  versionsFile.cores.forked.version = 'v0.2.0@111111111111 (adapter aaaaaaaaaaaa)';
  const source = inventory.cores[0].source!;
  (source.upstream_identity as Record<string, unknown>).repo = 'https://github.com/other/forked';
  assert.throws(
    () => parseBuildInventory(targets, inventory, versionsFile),
    /source\.upstream_identity\.repo: must match \[cores\.source\]\.upstream/,
  );

  const legacyVersions = versions(FORK_REV) as {
    schema: string;
    cores: Record<string, { version: string; rev: string }>;
  };
  legacyVersions.cores.forked.version = `1.2.3-${'a'.repeat(60)}`;
  assert.throws(
    () => parseBuildInventory(targets, cores([]), legacyVersions),
    /legacy core version exceeds 64 characters/,
  );
});

test('the synthetic v2 snapshot keeps every legacy entry and adds typed history', () => {
  const data = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/synthetic/data/${name}`, import.meta.url), 'utf8'));
  const known = new Set(Object.keys(data('core-versions.json').cores));
  const legacy = parseCores(data('cores.json'), known);
  const catalog = parseCores(data('cores-v2.json'), known);
  assert.equal(catalog.length, legacy.length + 2);
  for (let i = 0; i < legacy.length; i += 1) {
    const { identity: catalogIdentity, ...fields } = catalog[i];
    const { identity: legacyIdentity, ...legacyFields } = legacy[i];
    assert.equal(catalogIdentity, null);
    assert.equal(legacyIdentity, null);
    assert.deepEqual(fields, legacyFields);
  }
  const rfvp = sortCoreReleases(catalog.filter((release) => release.plugin_id === 'rfvp'));
  assert.equal(rfvp[0].identity?.upstream.ref_name, 'v0.2.0');
  assert.equal(rfvp[1].version, '0.1.0-beta.1');
  const siglus = catalog.find((release) => release.plugin_id === 'siglus_rs');
  assert.equal(siglus?.identity?.upstream.ref_name, 'feature/save-load');
  assert.equal(coreReleaseLabel(siglus!), 'feature/save-load@222222222222 (adapter 2436c25fc966)');
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
