// Behaviour edges of the portal data contract that pages rely on. Run with
// `npm test` (Node's built-in runner; Node strips the TypeScript types).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localizedText } from '../src/lib/i18n.ts';
import { BUILD_CORES_SCHEMA, BUILD_TARGETS_SCHEMA, CORE_VERSIONS_SCHEMA, parseBuildInventory } from '../src/lib/site-data.ts';

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

test('Japanese text falls back to English, then Chinese', () => {
  const all = { 'zh-CN': '中文', en: 'English', ja: '日本語' };
  const noJa = { 'zh-CN': '中文', en: 'English' };
  assert.deepEqual(localizedText(all, 'ja'), { text: '日本語', lang: 'ja' });
  assert.deepEqual(localizedText(noJa, 'ja'), { text: 'English', lang: 'en' });
  assert.deepEqual(localizedText(all, 'en'), { text: 'English', lang: 'en' });
  assert.deepEqual(localizedText(all, 'zh-cn'), { text: '中文', lang: 'zh-CN' });
});
