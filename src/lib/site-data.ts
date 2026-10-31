import { createHash } from 'node:crypto';

// Data contract for the portal build. The prebuild script validates the
// ShinkiEMU metadata snapshot against these rules and writes a normalized
// `src/generated/site-data.json`; pages only read that validated file.
//
// The rules mirror the Rust DTO validators in ShinkiEMU
// (`Source/Providers/shinki-emu-metadata`) closely enough that a snapshot the
// portal accepts is also accepted by the Manager. The Rust crate stays the
// schema source of truth; this module only refuses data the site cannot render
// honestly.

export const INDEX_SCHEMA = 'shinki.emu.metadata.index.v1';
export const COMPATIBILITY_SCHEMA = 'shinki.emu.compatibility.v4';
export const CORES_SCHEMA = 'shinki.emu.cores.v1';
export const CORES_V2_SCHEMA = 'shinki.emu.cores.v2';
export const PATCHES_SCHEMA = 'shinki.emu.patches.v1';

export const RELEASE_DOWNLOAD_PREFIX =
  'https://github.com/Project-Shinkirou/ShinkiEMU/releases/download/';
export const SHINKIEMU_REPO = 'https://github.com/Project-Shinkirou/ShinkiEMU';
export const ROUKAKU_REPO = 'https://github.com/Project-Shinkirou/RoukakuEngine';

export const MAX_INDEXED_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_INDEXED_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_INDEXED_FILES = 4096;
export const MAX_HOSTED_PATCH_BYTES = 1024 * 1024 * 1024;
export const MAX_CORE_PACKAGE_BYTES = 512 * 1024 * 1024;

export const PLATFORMS = ['windows', 'linux', 'macos', 'android', 'ios', 'ohos'] as const;
export const ARCHITECTURES = ['x86_64', 'aarch64'] as const;
export const VARIANTS = ['desktop', 'device', 'simulator'] as const;
export const STATUSES = ['perfect', 'completable', 'flawed', 'boot_only', 'unplayable'] as const;
export const PATCH_KINDS = ['recipe', 'external', 'hosted'] as const;

export type Platform = (typeof PLATFORMS)[number];
export type Architecture = (typeof ARCHITECTURES)[number];
export type Variant = (typeof VARIANTS)[number];
export type Status = (typeof STATUSES)[number];
export type PatchKind = (typeof PATCH_KINDS)[number];

export interface IndexedFile {
  path: string;
  sha256: string;
  size: number;
}

export interface MetadataIndex {
  schema: string;
  generated_at_unix_ms: number;
  source_commit: string;
  files: IndexedFile[];
}

export interface CompatibilityEntry {
  vn_id: string;
  release_id: string;
  emulator: string;
  status: Status;
  notes: string | null;
  emulator_version: string | null;
  manager_version: string | null;
  platform: Platform;
  architecture: Architecture;
  variant: Variant;
  issue: number | null;
  updated_at_unix_ms: number;
}

/** Upstream repository and ref a third-party core release is based on. */
export interface CoreUpstreamIdentity {
  repo: string;
  ref_kind: 'tag' | 'branch';
  /** Raw upstream ref name, kept verbatim for display. */
  ref_name: string;
  commit: string;
}

/** Organization fork branch and commit that adapt the upstream ref. */
export interface CoreAdapterIdentity {
  repo: string;
  branch: string;
  commit: string;
}

/**
 * Provenance of a third-party release in `cores-v2.json`. Its `version` is a
 * deterministic digest of these fields; the release order is the monotonic
 * `release_sequence`, never the text of a tag, branch or hash.
 */
export interface CoreIdentity {
  upstream: CoreUpstreamIdentity;
  adapter: CoreAdapterIdentity;
  release_sequence: number;
}

/** One downloadable core package. */
export interface CoreRelease {
  plugin_id: string;
  display_name: string;
  family_name: string;
  version: string;
  abi: string;
  platform: string;
  url: string;
  sha256: string;
  size: number;
  license: string;
  release_tag: string;
  /** Present on new third-party releases; null for legacy and self-owned SemVer entries. */
  identity: CoreIdentity | null;
}

export interface LocalizedText {
  'zh-CN': string;
  en: string;
  /**
   * Optional Japanese text. patches.v1 in ShinkiEMU currently carries only
   * zh-CN and en, so real snapshots omit it and Japanese pages fall back to
   * English, then Chinese (`localizedText` in i18n.ts).
   */
  ja?: string;
}

export interface PatchArtifact {
  url: string;
  sha256: string;
  size: number;
  file_name: string;
}

export interface PatchEntry {
  id: string;
  title: LocalizedText;
  version: string;
  vn_ids: string[];
  release_ids: string[];
  emulators: string[];
  kind: PatchKind;
  source_url: string | null;
  license: string;
  authorization_url: string | null;
  summary: LocalizedText;
  issue_url: string | null;
  artifact: PatchArtifact | null;
  recipe: { script: string } | null;
}

export interface MatrixTarget {
  target: string;
  /**
   * `static`: the core ships statically inside the Manager on this target
   * (`static_manager_targets`). It is available to players there even though
   * no standalone core package is built, so it counts as supported.
   */
  status: 'supported' | 'static' | 'blocked';
  /** Why the target is blocked, or why a static target has no standalone package. */
  reason: string | null;
}

/** One core of ShinkiEMU `build/cores.toml`, with targets in `build/targets.toml` order. */
export interface MatrixCore {
  core: string;
  plugin_id: string;
  family: string;
  license: string;
  /**
   * Upstream ref at the adapter revision for new third-party releases, or the
   * manifest version for legacy/self-owned cores. `core-versions.json` renders
   * the readable label from the same identity.
   */
  version: string;
  /** Commit the core is built from: the fork pin, or the ShinkiEMU commit for owned cores. */
  revision: string;
  /** Repository `revision` belongs to: the organization fork, or ShinkiEMU for owned cores. */
  repo: string;
  /** Original upstream project of a third-party core (`[cores.source].upstream`); null for owned cores. */
  upstream: string | null;
  /** Adapter branch of the organization fork; null for owned cores. */
  adapter_branch: string | null;
  /** Provenance of the current external release from `build/cores.toml`; null for legacy/owned cores. */
  identity: CoreIdentity | null;
  /** Non-empty when binaries are withheld until distribution review closes. */
  publish_blocked: string | null;
  /** Targets where the core ships statically inside the Manager rather than as a package. */
  static_manager_targets: string[];
  targets: MatrixTarget[];
}

/** One target of ShinkiEMU `build/targets.toml`, including the Manager's own status. */
export interface BuildTarget {
  triple: string;
  platform: Platform;
  architecture: Architecture;
  variant: Variant;
  manager: MatrixTarget;
}

export interface BuildInventory {
  targets: BuildTarget[];
  cores: MatrixCore[];
}

export interface SiteSources {
  roukaku_commit: string;
  shinkiemu_commit: string;
  /** Latest published Manager release tag at build time, `null` before the first release. */
  manager_release_tag: string | null;
  generated_at: string;
}

/** VNDB title of a work or release, fetched at build time. */
export interface VndbTitle {
  /** VNDB main title (romanized when the original script is not Latin). */
  title: string;
  /** Title in the original script when it differs from `title`. */
  alttitle: string | null;
}

export interface VndbTitles {
  vn: Record<string, VndbTitle>;
  release: Record<string, VndbTitle>;
}

/** VNDB releases made with one engine family (exact VNDB `engine` strings). */
export interface FamilyCoverage {
  family: string;
  engines: string[];
  releases: number;
}

/** VNDB release counts per engine family, fetched at build time. */
export interface VndbCoverage {
  fetched_at: string;
  /** VNDB releases with any engine recorded. */
  engine_releases: number;
  /** Families in `build/cores.toml` order. */
  families: FamilyCoverage[];
  /** Sum of the family counts; engine strings are disjoint, so no release counts twice. */
  total: number;
}

/** A Manager release archive for one platform. */
export interface ManagerAsset {
  name: string;
  url: string;
  size: number;
  sha256: string | null;
  platform: Platform;
  architecture: Architecture | 'universal';
  /** Set for test packages (iOS `-test.zip` and OpenHarmony `-debug-test-signed.hap`). */
  variant: Variant | null;
}

export interface ManagerRelease {
  tag: string;
  version: string;
  prerelease: boolean;
  published_at: string;
  html_url: string;
  /** Platform packages; source bundles and other attachments are left out. */
  assets: ManagerAsset[];
}

export interface SiteData {
  /** True when any input came from `fixtures/synthetic/`; such builds are never deployed. */
  synthetic: boolean;
  index: {
    generated_at_unix_ms: number;
    source_commit: string;
    file_count: number;
  };
  sources: SiteSources;
  titles: VndbTitles;
  coverage: VndbCoverage;
  manager_release: ManagerRelease | null;
  compatibility: CompatibilityEntry[];
  cores: CoreRelease[];
  patches: PatchEntry[];
  targets: BuildTarget[];
  matrix: MatrixCore[];
}

export class DataError extends Error {
  constructor(where: string, message: string) {
    super(`${where}: ${message}`);
    this.name = 'DataError';
  }
}

type Json = unknown;

function record(value: Json, where: string): Record<string, Json> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DataError(where, 'expected an object');
  }
  return value as Record<string, Json>;
}

function only(object: Record<string, Json>, where: string, allowed: readonly string[]): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new DataError(where, `unknown field "${key}"`);
  }
}

function array(value: Json, where: string): Json[] {
  if (!Array.isArray(value)) throw new DataError(where, 'expected an array');
  return value;
}

function text(value: Json, where: string, min = 1, max = 1024): string {
  if (typeof value !== 'string') throw new DataError(where, 'expected a string');
  const length = [...value].length;
  if (length < min || length > max) throw new DataError(where, `length must be ${min}..${max}`);
  // Control characters other than newline/tab never reach rendered pages.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) {
    throw new DataError(where, 'contains control characters');
  }
  return value;
}

function optionalText(value: Json, where: string, min = 1, max = 1024): string | null {
  return value === undefined || value === null ? null : text(value, where, min, max);
}

function pattern(value: Json, where: string, regex: RegExp): string {
  if (typeof value !== 'string' || !regex.test(value)) {
    throw new DataError(where, `must match ${regex}`);
  }
  return value;
}

function oneOf<T extends string>(value: Json, where: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new DataError(where, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function integer(value: Json, where: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new DataError(where, `must be an integer in ${min}..${max}`);
  }
  return value;
}

function https(value: Json, where: string): string {
  const raw = text(value, where, 1, 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DataError(where, 'must be an absolute URL');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new DataError(where, 'must be an https URL without credentials');
  }
  return raw;
}

function optionalHttps(value: Json, where: string): string | null {
  return value === undefined || value === null ? null : https(value, where);
}

function uniqueList(value: Json, where: string, item: (value: Json, where: string) => string): string[] {
  const list = array(value, where).map((entry, i) => item(entry, `${where}[${i}]`));
  if (new Set(list).size !== list.length) throw new DataError(where, 'contains duplicates');
  return list;
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const VN_ID = /^v[0-9]{1,63}$/;
const RELEASE_ID = /^r[0-9]{1,63}$/;
const PLUGIN_ID = /^[A-Za-z0-9._-]{1,128}$/;
const TRIPLE = /^[a-z0-9_]+(-[a-z0-9_]+){1,4}$/;
const ASSET = /^[A-Za-z0-9._-]{1,256}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const ORG_REPO_PREFIX = 'https://github.com/Project-Shinkirou/';
const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const CORE_COMMIT = /^[0-9a-f]{40}$/;
/** A raw Git ref: printable ASCII without spaces, length bounded for display. */
const CORE_REF_NAME = /^[\x21-\x7e]{1,255}$/;
const CORE_RELEASE_SEQUENCE_MAX = 9007199254740991;
const CORE_REF_KINDS = ['tag', 'branch'] as const;

function coreRepo(value: Json, where: string, role: 'upstream' | 'adapter'): string {
  const repo = pattern(value, where, GITHUB_REPO);
  if (repo.endsWith('.git')) throw new DataError(where, 'must not end with .git');
  if (role === 'adapter' && !repo.startsWith(ORG_REPO_PREFIX)) {
    throw new DataError(where, 'must be an organization fork');
  }
  if (role === 'upstream' && repo.startsWith(ORG_REPO_PREFIX)) {
    throw new DataError(where, 'must be the original project, not the fork');
  }
  return repo;
}

function coreRefName(value: Json, where: string): string {
  const name = text(value, where, 1, 255);
  if (!CORE_REF_NAME.test(name)) throw new DataError(where, 'must be a printable ASCII Git ref');
  return name;
}

function parseCoreUpstream(value: Json, where: string): CoreUpstreamIdentity {
  const upstream = record(value, where);
  only(upstream, where, ['repo', 'ref_kind', 'ref_name', 'commit']);
  return {
    repo: coreRepo(upstream.repo, `${where}.repo`, 'upstream'),
    ref_kind: oneOf(upstream.ref_kind, `${where}.ref_kind`, CORE_REF_KINDS),
    ref_name: coreRefName(upstream.ref_name, `${where}.ref_name`),
    commit: pattern(upstream.commit, `${where}.commit`, CORE_COMMIT),
  };
}

function parseCoreIdentity(value: Json, where: string): CoreIdentity {
  const identity = record(value, where);
  only(identity, where, ['upstream', 'adapter', 'release_sequence']);
  const adapter = record(identity.adapter, `${where}.adapter`);
  only(adapter, `${where}.adapter`, ['repo', 'branch', 'commit']);
  return {
    upstream: parseCoreUpstream(identity.upstream, `${where}.upstream`),
    adapter: {
      repo: coreRepo(adapter.repo, `${where}.adapter.repo`, 'adapter'),
      branch: coreRefName(adapter.branch, `${where}.adapter.branch`),
      commit: pattern(adapter.commit, `${where}.adapter.commit`, CORE_COMMIT),
    },
    release_sequence: integer(identity.release_sequence, `${where}.release_sequence`, 1, CORE_RELEASE_SEQUENCE_MAX),
  };
}

/** First 16 ASCII bytes of the raw upstream ref, each non-alphanumeric replaced by `-`. */
function coreRefSlug(refName: string): string {
  return refName.slice(0, 16).replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
}

/**
 * SHA-256 over the canonical provenance lines in the order fixed by the
 * metadata contract, each field followed by LF. The digest, not a rendered
 * tag or branch name, identifies a third-party release.
 */
function coreIdentityDigest(identity: CoreIdentity): string {
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
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Full readable provenance label for a third-party release. */
export function coreIdentityLabel(identity: CoreIdentity): string {
  return `${identity.upstream.ref_name}@${identity.upstream.commit.slice(0, 12)} (adapter ${identity.adapter.commit.slice(0, 12)})`;
}

/** The readable version a page shows: upstream ref + both short commits, or a manifest version. */
export function coreReleaseLabel(release: Pick<CoreRelease, 'identity' | 'version'>): string {
  return release.identity === null ? release.version : coreIdentityLabel(release.identity);
}

/**
 * Relative `/`-separated path without traversal, drive letters, alternate
 * streams, or Windows-trimmed trailing dots/spaces (same rule as the Rust
 * `is_safe_metadata_relative_path`).
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 256 || path.includes('..')) return false;
  return path
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && !segment.endsWith('.') && /^[A-Za-z0-9._-]+$/.test(segment));
}

export function parseIndex(value: Json): MetadataIndex {
  const object = record(value, 'index.json');
  only(object, 'index.json', ['schema', 'generated_at_unix_ms', 'source_commit', 'files']);
  if (object.schema !== INDEX_SCHEMA) throw new DataError('index.json.schema', `expected ${INDEX_SCHEMA}`);
  const files = array(object.files, 'index.json.files');
  if (files.length > MAX_INDEXED_FILES) throw new DataError('index.json.files', `more than ${MAX_INDEXED_FILES} files`);
  const seen = new Set<string>();
  let total = 0;
  const parsed = files.map((raw, i) => {
    const where = `index.json.files[${i}]`;
    const file = record(raw, where);
    only(file, where, ['path', 'sha256', 'size']);
    const path = text(file.path, `${where}.path`, 1, 256);
    if (!isSafeRelativePath(path) || path === 'index.json') throw new DataError(`${where}.path`, `unsafe path "${path}"`);
    const folded = path.toLowerCase();
    if (seen.has(folded)) throw new DataError(`${where}.path`, `duplicate (case-insensitive) path "${path}"`);
    seen.add(folded);
    const size = integer(file.size, `${where}.size`, 0, MAX_INDEXED_FILE_BYTES);
    total += size;
    return { path, sha256: pattern(file.sha256, `${where}.sha256`, SHA256), size };
  });
  if (total > MAX_INDEXED_TOTAL_BYTES) throw new DataError('index.json.files', 'total size exceeds 64 MiB');
  return {
    schema: INDEX_SCHEMA,
    generated_at_unix_ms: integer(object.generated_at_unix_ms, 'index.json.generated_at_unix_ms', 0),
    source_commit: pattern(object.source_commit, 'index.json.source_commit', COMMIT),
    files: parsed,
  };
}

export function parseCompatibility(value: Json, cores: ReadonlySet<string>): CompatibilityEntry[] {
  const object = record(value, 'compatibility.json');
  only(object, 'compatibility.json', ['schema', 'generated_at_unix_ms', 'entries']);
  if (object.schema !== COMPATIBILITY_SCHEMA) {
    throw new DataError('compatibility.json.schema', `expected ${COMPATIBILITY_SCHEMA}`);
  }
  const keys = new Set<string>();
  return array(object.entries, 'compatibility.json.entries').map((raw, i) => {
    const where = `compatibility.json.entries[${i}]`;
    const entry = record(raw, where);
    only(entry, where, [
      'vn_id', 'release_id', 'emulator', 'status', 'notes', 'emulator_version', 'manager_version',
      'platform', 'architecture', 'variant', 'issue', 'updated_at_unix_ms',
    ]);
    const platform = oneOf(entry.platform, `${where}.platform`, PLATFORMS);
    const variant = oneOf(entry.variant, `${where}.variant`, VARIANTS);
    const desktop = platform === 'windows' || platform === 'linux' || platform === 'macos';
    if (desktop !== (variant === 'desktop')) {
      throw new DataError(`${where}.variant`, `"${variant}" is not valid for platform "${platform}"`);
    }
    const emulator = pattern(entry.emulator, `${where}.emulator`, PLUGIN_ID);
    if (!cores.has(emulator)) throw new DataError(`${where}.emulator`, `unknown core "${emulator}"`);
    const parsed: CompatibilityEntry = {
      vn_id: pattern(entry.vn_id, `${where}.vn_id`, VN_ID),
      release_id: pattern(entry.release_id, `${where}.release_id`, RELEASE_ID),
      emulator,
      status: oneOf(entry.status, `${where}.status`, STATUSES),
      notes: optionalText(entry.notes, `${where}.notes`, 0, 1024),
      emulator_version: optionalText(entry.emulator_version, `${where}.emulator_version`, 1, 64),
      manager_version: optionalText(entry.manager_version, `${where}.manager_version`, 1, 64),
      platform,
      architecture: oneOf(entry.architecture, `${where}.architecture`, ARCHITECTURES),
      variant,
      issue: entry.issue === undefined || entry.issue === null ? null : integer(entry.issue, `${where}.issue`, 1),
      updated_at_unix_ms: integer(entry.updated_at_unix_ms, `${where}.updated_at_unix_ms`, 0),
    };
    const key = [parsed.release_id, parsed.emulator, parsed.platform, parsed.architecture, parsed.variant].join('/');
    if (keys.has(key)) throw new DataError(where, `duplicate record key ${key}`);
    keys.add(key);
    return parsed;
  });
}

/** `<tag>/<asset>` under the organization's ShinkiEMU release downloads. */
function releaseAsset(url: string): { tag: string; asset: string } | null {
  if (!url.startsWith(RELEASE_DOWNLOAD_PREFIX)) return null;
  const [tag, asset, ...rest] = url.slice(RELEASE_DOWNLOAD_PREFIX.length).split('/');
  if (rest.length > 0 || !tag || !asset || !ASSET.test(tag) || !ASSET.test(asset)) return null;
  if (asset === '.' || asset === '..') return null;
  return { tag, asset };
}

/**
 * Validates the legacy `cores.json` or the additive `cores-v2.json`. Version 2
 * keeps every legacy entry and adds typed provenance to new third-party
 * releases; the portal prefers it when the metadata index publishes it and
 * falls back to version 1, which stays downloadable for older Managers.
 */
export function parseCores(value: Json, cores: ReadonlySet<string>): CoreRelease[] {
  const object = record(value, 'cores.json');
  const v2 = object.schema === CORES_V2_SCHEMA;
  const name = v2 ? 'cores-v2.json' : 'cores.json';
  only(object, name, ['schema', 'entries']);
  if (!v2 && object.schema !== CORES_SCHEMA) {
    throw new DataError(`${name}.schema`, `expected ${CORES_SCHEMA} or ${CORES_V2_SCHEMA}`);
  }
  const keys = new Set<string>();
  /** plugin id + release_sequence -> version; one release can span platforms. */
  const sequences = new Map<string, string>();
  return array(object.entries, `${name}.entries`).map((raw, i) => {
    const where = `${name}.entries[${i}]`;
    const entry = record(raw, where);
    only(entry, where, [
      'plugin_id', 'display_name', 'family_name', 'version', 'abi', 'platform', 'url', 'sha256', 'size',
      'license', 'release_tag', 'identity',
    ]);
    const plugin_id = pattern(entry.plugin_id, `${where}.plugin_id`, PLUGIN_ID);
    if (!cores.has(plugin_id)) throw new DataError(`${where}.plugin_id`, `core "${plugin_id}" is not in build-cores.toml`);
    let identity: CoreIdentity | null = null;
    if (entry.identity === null) throw new DataError(`${where}.identity`, 'must be omitted, not null');
    if (entry.identity !== undefined) {
      if (!v2) throw new DataError(`${where}.identity`, `only ${CORES_V2_SCHEMA} entries carry identity`);
      identity = parseCoreIdentity(entry.identity, `${where}.identity`);
    }
    const versionText = text(entry.version, `${where}.version`, 1, 512);
    let version: string;
    if (identity === null) {
      version = pattern(versionText, `${where}.version`, SEMVER);
    } else {
      const expected = `${identity.upstream.ref_kind}-${coreRefSlug(identity.upstream.ref_name)}-${coreIdentityDigest(identity)}`;
      if (versionText !== expected) {
        throw new DataError(`${where}.version`, `does not match the provenance digest (expected ${expected})`);
      }
      version = versionText;
    }
    const pluginSlug = plugin_id.toLowerCase().replace(/[._]/g, '-');
    if (identity !== null && pluginSlug.length > 32) {
      throw new DataError(`${where}.plugin_id`, 'external core slug exceeds 32 characters');
    }
    const release_tag = pattern(entry.release_tag, `${where}.release_tag`, /^[A-Za-z0-9._-]{1,128}$/);
    if (identity !== null) {
      const expected = `core-${pluginSlug}-${version}`;
      if (release_tag !== expected) {
        throw new DataError(`${where}.release_tag`, `must be ${expected}`);
      }
    }
    const url = https(entry.url, `${where}.url`);
    const asset = releaseAsset(url);
    if (!asset || asset.tag !== release_tag) {
      throw new DataError(`${where}.url`, `must be ${RELEASE_DOWNLOAD_PREFIX}${release_tag}/<asset>`);
    }
    const parsed: CoreRelease = {
      plugin_id,
      display_name: text(entry.display_name, `${where}.display_name`, 1, 64),
      family_name: text(entry.family_name, `${where}.family_name`, 1, 64),
      version,
      abi: text(entry.abi, `${where}.abi`, 1, 128),
      platform: pattern(entry.platform, `${where}.platform`, /^[a-z0-9_]{1,32}-[a-z0-9_]{1,32}$/),
      url,
      sha256: pattern(entry.sha256, `${where}.sha256`, SHA256),
      size: integer(entry.size, `${where}.size`, 1, MAX_CORE_PACKAGE_BYTES),
      license: text(entry.license, `${where}.license`, 1, 128),
      release_tag,
      identity,
    };
    const key = `${parsed.plugin_id}/${parsed.platform}/${parsed.version}`;
    if (keys.has(key)) throw new DataError(where, `duplicate release ${key}`);
    keys.add(key);
    if (identity !== null) {
      const sequenceKey = `${parsed.plugin_id}/${identity.release_sequence}`;
      const known = sequences.get(sequenceKey);
      if (known !== undefined && known !== version) {
        throw new DataError(`${where}.identity.release_sequence`, 'is reused with a different version');
      }
      sequences.set(sequenceKey, version);
    }
    return parsed;
  });
}

function compareNumericText(a: string, b: string): number {
  const x = a.replace(/^0+/, '') || '0';
  const y = b.replace(/^0+/, '') || '0';
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * SemVer precedence for identity-free core versions. Build metadata is
 * ignored; prerelease identifiers follow the SemVer numeric/lexical rule.
 */
function compareCoreSemVer(a: string, b: string): number {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (!left || !right) return 0;
  for (let i = 1; i <= 3; i += 1) {
    const order = compareNumericText(left[i], right[i]);
    if (order !== 0) return order;
  }
  const leftPre = left[4];
  const rightPre = right[4];
  if (leftPre === undefined && rightPre === undefined) return 0;
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;
  const leftParts = leftPre.split('.');
  const rightParts = rightPre.split('.');
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i += 1) {
    const x = leftParts[i];
    const y = rightParts[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^[0-9]+$/.test(x);
    const yNumeric = /^[0-9]+$/.test(y);
    if (xNumeric && yNumeric) {
      const order = compareNumericText(x, y);
      if (order !== 0) return order;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Newest first for one core: typed identity releases use their monotonic
 * `release_sequence` (never the text of a tag, branch or hash) and supersede
 * legacy SemVer entries, which stay listed for download.
 */
export function sortCoreReleases(releases: readonly CoreRelease[]): CoreRelease[] {
  return [...releases].sort((a, b) => {
    const left = a.identity;
    const right = b.identity;
    if (left !== null && right === null) return -1;
    if (left === null && right !== null) return 1;
    const order =
      left !== null && right !== null
        ? right.release_sequence - left.release_sequence
        : left === null && right === null
          ? compareCoreSemVer(b.version, a.version)
          : 0;
    return order !== 0 ? order : a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0;
  });
}

/** The release the core management page marks as newest under the same rule. */
export function latestCoreRelease(releases: readonly CoreRelease[]): CoreRelease | null {
  return sortCoreReleases(releases)[0] ?? null;
}

function localized(value: Json, where: string, max: number): LocalizedText {
  const object = record(value, where);
  only(object, where, ['zh-CN', 'en', 'ja']);
  const result: LocalizedText = { 'zh-CN': text(object['zh-CN'], `${where}.zh-CN`, 1, max), en: text(object.en, `${where}.en`, 1, max) };
  if (object.ja !== undefined) result.ja = text(object.ja, `${where}.ja`, 1, max);
  return result;
}

export function parsePatches(value: Json, cores: ReadonlySet<string>): PatchEntry[] {
  const object = record(value, 'patches.json');
  only(object, 'patches.json', ['schema', 'entries']);
  if (object.schema !== PATCHES_SCHEMA) throw new DataError('patches.json.schema', `expected ${PATCHES_SCHEMA}`);
  const ids = new Set<string>();
  return array(object.entries, 'patches.json.entries').map((raw, i) => {
    const where = `patches.json.entries[${i}]`;
    const entry = record(raw, where);
    only(entry, where, [
      'id', 'title', 'version', 'vn_ids', 'release_ids', 'emulators', 'kind', 'source_url', 'license',
      'authorization_url', 'summary', 'issue_url', 'artifact', 'recipe',
    ]);
    const id = pattern(entry.id, `${where}.id`, PLUGIN_ID);
    if (id === '.') throw new DataError(`${where}.id`, 'invalid patch id');
    if (ids.has(id)) throw new DataError(`${where}.id`, `duplicate patch id "${id}"`);
    ids.add(id);
    const version = pattern(entry.version, `${where}.version`, SEMVER);
    const kind = oneOf(entry.kind, `${where}.kind`, PATCH_KINDS);
    const emulators = uniqueList(entry.emulators, `${where}.emulators`, (v, w) => pattern(v, w, PLUGIN_ID));
    for (const emulator of emulators) {
      if (!cores.has(emulator)) throw new DataError(`${where}.emulators`, `unknown core "${emulator}"`);
    }
    let artifact: PatchArtifact | null = null;
    if (entry.artifact !== undefined && entry.artifact !== null) {
      const a = record(entry.artifact, `${where}.artifact`);
      only(a, `${where}.artifact`, ['url', 'sha256', 'size', 'file_name']);
      artifact = {
        url: https(a.url, `${where}.artifact.url`),
        sha256: pattern(a.sha256, `${where}.artifact.sha256`, SHA256),
        size: integer(a.size, `${where}.artifact.size`, 1, MAX_HOSTED_PATCH_BYTES),
        file_name: pattern(a.file_name, `${where}.artifact.file_name`, ASSET),
      };
    }
    let recipe: { script: string } | null = null;
    if (entry.recipe !== undefined && entry.recipe !== null) {
      const r = record(entry.recipe, `${where}.recipe`);
      only(r, `${where}.recipe`, ['script']);
      const script = text(r.script, `${where}.recipe.script`, 1, 256);
      if (!isSafeRelativePath(script) || !script.endsWith('.luau')) {
        throw new DataError(`${where}.recipe.script`, 'must be a safe relative .luau path');
      }
      recipe = { script };
    }
    const parsed: PatchEntry = {
      id,
      title: localized(entry.title, `${where}.title`, 256),
      version,
      vn_ids: uniqueList(entry.vn_ids, `${where}.vn_ids`, (v, w) => pattern(v, w, VN_ID)),
      release_ids: uniqueList(entry.release_ids, `${where}.release_ids`, (v, w) => pattern(v, w, RELEASE_ID)),
      emulators,
      kind,
      source_url: optionalHttps(entry.source_url, `${where}.source_url`),
      license: text(entry.license, `${where}.license`, 1, 256),
      authorization_url: optionalHttps(entry.authorization_url, `${where}.authorization_url`),
      summary: localized(entry.summary, `${where}.summary`, 2048),
      issue_url: optionalHttps(entry.issue_url, `${where}.issue_url`),
      artifact,
      recipe,
    };
    if (parsed.vn_ids.length === 0) throw new DataError(`${where}.vn_ids`, 'needs at least one VNDB work id');
    if (parsed.emulators.length === 0) throw new DataError(`${where}.emulators`, 'needs at least one core');
    switch (kind) {
      case 'hosted': {
        if (!parsed.authorization_url) throw new DataError(where, 'hosted patch needs authorization_url');
        if (!artifact) throw new DataError(where, 'hosted patch needs an artifact');
        const asset = releaseAsset(artifact.url);
        if (!asset || asset.asset !== artifact.file_name) {
          throw new DataError(
            `${where}.artifact.url`,
            `must be ${RELEASE_DOWNLOAD_PREFIX}<tag>/${artifact.file_name} (conventionally tag patch-${id}-v${version})`,
          );
        }
        if (recipe) throw new DataError(where, 'hosted patch must not carry a recipe');
        break;
      }
      case 'external':
        if (!artifact && !parsed.source_url) throw new DataError(where, 'external patch needs artifact or source_url');
        if (recipe) throw new DataError(where, 'external patch must not carry a recipe');
        break;
      case 'recipe':
        if (!recipe) throw new DataError(where, 'recipe patch needs recipe.script');
        if (artifact) throw new DataError(where, 'recipe patch must not carry an artifact');
        break;
    }
    return parsed;
  });
}

export const BUILD_CORES_SCHEMA = 'shinki.emu.build_cores.v1';
export const BUILD_TARGETS_SCHEMA = 'shinki.emu.build_targets.v1';
/** Written by `xtask site prepare` (`xtask/src/versions.rs`). */
export const CORE_VERSIONS_SCHEMA = 'shinki.portal.core_versions.v1';

/**
 * Reads the parsed ShinkiEMU `build/targets.toml` and `build/cores.toml`, the
 * single build/release inventory, together with `core-versions.json` (each
 * core's readable version label at the revision it is built from). External
 * cores with `[cores.source].upstream_identity` carry the upstream ref and
 * both commits; legacy/owned cores keep their manifest SemVer. Fields the site
 * does not render (manifests, features, tools, runners) are ignored so
 * build-only additions do not break the portal; every rendered field is
 * validated.
 */
export function parseBuildInventory(targetsValue: Json, coresValue: Json, versionsValue: Json): BuildInventory {
  const versionsFile = record(versionsValue, 'core-versions.json');
  only(versionsFile, 'core-versions.json', ['schema', 'cores']);
  if (versionsFile.schema !== CORE_VERSIONS_SCHEMA) {
    throw new DataError('core-versions.json.schema', `expected ${CORE_VERSIONS_SCHEMA}`);
  }
  const versions = record(versionsFile.cores, 'core-versions.json.cores');
  const targetsFile = record(targetsValue, 'build-targets.toml');
  if (targetsFile.schema !== BUILD_TARGETS_SCHEMA) {
    throw new DataError('build-targets.toml.schema', `expected ${BUILD_TARGETS_SCHEMA}`);
  }
  const targetList = array(targetsFile.targets, 'build-targets.toml.targets');
  if (targetList.length === 0) throw new DataError('build-targets.toml.targets', 'target list is empty');
  const triples: string[] = [];
  // Non-empty `blocked` blocks the Manager and every core on that target,
  // overriding `manager_supported` and each core's per-target state.
  const targetBlocked = new Map<string, string>();
  const targets = targetList.map((raw, i): BuildTarget => {
    const where = `build-targets.toml.targets[${i}]`;
    const t = record(raw, where);
    const triple = pattern(t.triple, `${where}.triple`, TRIPLE);
    if (triples.includes(triple)) throw new DataError(`${where}.triple`, `duplicate target "${triple}"`);
    triples.push(triple);
    if (typeof t.manager_supported !== 'boolean') throw new DataError(`${where}.manager_supported`, 'expected a boolean');
    const managerBlocked = text(t.manager_blocked ?? '', `${where}.manager_blocked`, 0, 1024);
    if (!t.manager_supported && managerBlocked === '') {
      throw new DataError(`${where}.manager_blocked`, 'unsupported Manager target needs a reason');
    }
    const blocked = text(t.blocked ?? '', `${where}.blocked`, 0, 1024);
    if (blocked !== '') targetBlocked.set(triple, blocked);
    return {
      triple,
      platform: oneOf(t.platform, `${where}.platform`, PLATFORMS),
      architecture: oneOf(t.architecture, `${where}.architecture`, ARCHITECTURES),
      variant: oneOf(t.variant, `${where}.variant`, VARIANTS),
      manager:
        blocked !== ''
          ? { target: triple, status: 'blocked', reason: blocked }
          : t.manager_supported
            ? { target: triple, status: 'supported', reason: null }
            : { target: triple, status: 'blocked', reason: managerBlocked },
    };
  });

  const coresFile = record(coresValue, 'build-cores.toml');
  if (coresFile.schema !== BUILD_CORES_SCHEMA) {
    throw new DataError('build-cores.toml.schema', `expected ${BUILD_CORES_SCHEMA}`);
  }
  const coreList = array(coresFile.cores, 'build-cores.toml.cores');
  if (coreList.length === 0) throw new DataError('build-cores.toml.cores', 'core inventory is empty');
  const ids = new Set<string>();
  const cores = coreList.map((raw, i): MatrixCore => {
    const where = `build-cores.toml.cores[${i}]`;
    const core = record(raw, where);
    const plugin_id = pattern(core.id, `${where}.id`, PLUGIN_ID);
    if (ids.has(plugin_id)) throw new DataError(`${where}.id`, `duplicate core "${plugin_id}"`);
    ids.add(plugin_id);
    const targetName = (value: Json, w: string) => {
      const triple = pattern(value, w, TRIPLE);
      if (!triples.includes(triple)) throw new DataError(w, `target "${triple}" is not in build-targets.toml`);
      return triple;
    };
    const supported = uniqueList(core.supported_targets, `${where}.supported_targets`, targetName);
    const status: Record<string, MatrixTarget> = {};
    for (const triple of supported) status[triple] = { target: triple, status: 'supported', reason: null };
    array(core.blocked ?? [], `${where}.blocked`).forEach((rawBlocked, j) => {
      const w = `${where}.blocked[${j}]`;
      const blocked = record(rawBlocked, w);
      const triple = targetName(blocked.target, `${w}.target`);
      if (status[triple]) throw new DataError(`${w}.target`, `target "${triple}" is listed twice`);
      status[triple] = { target: triple, status: 'blocked', reason: text(blocked.reason, `${w}.reason`, 1, 1024) };
    });
    const missing = triples.filter((triple) => !status[triple]);
    if (missing.length > 0) throw new DataError(where, `no supported/blocked status for ${missing.join(', ')}`);
    const staticTargets = uniqueList(core.static_manager_targets ?? [], `${where}.static_manager_targets`, targetName);
    // Statically embedded targets ship inside the Manager, so players have the
    // core there; the inventory's `blocked` reason only explains why no
    // standalone package exists.
    for (const triple of staticTargets) status[triple] = { ...status[triple], status: 'static' };
    for (const [triple, reason] of targetBlocked) status[triple] = { target: triple, status: 'blocked', reason };
    const publishBlocked = text(core.publish_blocked ?? '', `${where}.publish_blocked`, 0, 1024);

    let repo = SHINKIEMU_REPO;
    let upstream: string | null = null;
    let pinned: string | null = null;
    let adapterBranch: string | null = null;
    let identity: CoreIdentity | null = null;
    if (core.source !== undefined) {
      const source = record(core.source, `${where}.source`);
      repo = pattern(source.repo, `${where}.source.repo`, GITHUB_REPO);
      if (!repo.startsWith(ORG_REPO_PREFIX)) throw new DataError(`${where}.source.repo`, 'must be an organization fork');
      const pin = pattern(source.rev, `${where}.source.rev`, COMMIT);
      pinned = pin;
      upstream = pattern(source.upstream, `${where}.source.upstream`, GITHUB_REPO);
      if (upstream.startsWith(ORG_REPO_PREFIX)) throw new DataError(`${where}.source.upstream`, 'must be the original project, not the fork');
      adapterBranch =
        source.branch === undefined || source.branch === null ? null : coreRefName(source.branch, `${where}.source.branch`);
      if ((source.upstream_identity === undefined) !== (source.release_sequence === undefined)) {
        throw new DataError(where, 'source.upstream_identity and source.release_sequence must be set together');
      }
      if (source.upstream_identity !== undefined) {
        if (adapterBranch === null) throw new DataError(`${where}.source.branch`, 'an external release needs an adapter branch');
        identity = {
          upstream: parseCoreUpstream(source.upstream_identity, `${where}.source.upstream_identity`),
          adapter: { repo, branch: adapterBranch, commit: pattern(pin, `${where}.source.rev`, CORE_COMMIT) },
          release_sequence: integer(
            source.release_sequence,
            `${where}.source.release_sequence`,
            1,
            CORE_RELEASE_SEQUENCE_MAX,
          ),
        };
      }
    }
    const versionWhere = `core-versions.json.cores.${plugin_id}`;
    const version = record(versions[plugin_id], versionWhere);
    only(version, versionWhere, ['version', 'rev']);
    const revision = pattern(version.rev, `${versionWhere}.rev`, COMMIT);
    if (pinned !== null && revision !== pinned) {
      throw new DataError(`${versionWhere}.rev`, 'does not match the pinned [cores.source].rev');
    }
    const versionText = text(version.version, `${versionWhere}.version`, 1, 512);
    if (identity === null) {
      pattern(versionText, `${versionWhere}.version`, SEMVER);
    } else if (versionText !== coreIdentityLabel(identity)) {
      throw new DataError(`${versionWhere}.version`, `must be ${coreIdentityLabel(identity)}`);
    }
    return {
      core: text(core.display_name, `${where}.display_name`, 1, 128),
      plugin_id,
      family: text(core.family_name, `${where}.family_name`, 1, 128),
      license: text(core.license, `${where}.license`, 1, 256),
      version: versionText,
      revision,
      repo,
      upstream,
      adapter_branch: adapterBranch,
      identity,
      publish_blocked: publishBlocked === '' ? null : publishBlocked,
      static_manager_targets: staticTargets,
      targets: triples.map((triple) => status[triple]),
    };
  });
  const unknown = Object.keys(versions).filter((id) => !ids.has(id));
  if (unknown.length > 0) throw new DataError('core-versions.json.cores', `unknown cores ${unknown.join(', ')}`);
  return { targets, cores };
}

export function parseSources(value: Json): SiteSources {
  const object = record(value, 'site-sources.json');
  only(object, 'site-sources.json', ['roukaku_commit', 'shinkiemu_commit', 'manager_release_tag', 'generated_at']);
  const generated_at = text(object.generated_at, 'site-sources.json.generated_at', 1, 64);
  if (Number.isNaN(Date.parse(generated_at))) {
    throw new DataError('site-sources.json.generated_at', 'must be an ISO 8601 timestamp');
  }
  return {
    roukaku_commit: pattern(object.roukaku_commit, 'site-sources.json.roukaku_commit', COMMIT),
    shinkiemu_commit: pattern(object.shinkiemu_commit, 'site-sources.json.shinkiemu_commit', COMMIT),
    manager_release_tag:
      object.manager_release_tag === null
        ? null
        : pattern(object.manager_release_tag, 'site-sources.json.manager_release_tag', MANAGER_TAG),
    generated_at: new Date(generated_at).toISOString(),
  };
}

export const VNDB_TITLES_SCHEMA = 'shinki.portal.vndb_titles.v1';
export const MANAGER_RELEASE_SCHEMA = 'shinki.portal.manager_release.v1';
const MANAGER_TAG = /^manager-v[0-9A-Za-z.+-]{1,64}$/;

function titleMap(value: Json, where: string, id: RegExp, required: ReadonlySet<string>): Record<string, VndbTitle> {
  const object = record(value, where);
  const out: Record<string, VndbTitle> = {};
  for (const [key, entry] of Object.entries(object)) {
    pattern(key, `${where} key`, id);
    const item = record(entry, `${where}.${key}`);
    only(item, `${where}.${key}`, ['title', 'alttitle']);
    out[key] = {
      title: text(item.title, `${where}.${key}.title`, 1, 512),
      alttitle: optionalText(item.alttitle, `${where}.${key}.alttitle`, 1, 512),
    };
  }
  for (const key of required) {
    if (!(key in out)) throw new DataError(where, `no VNDB title for ${key}`);
  }
  return out;
}

/** VNDB titles for every referenced work and release; a missing one fails the build. */
export function parseVndbTitles(value: Json, vnIds: ReadonlySet<string>, releaseIds: ReadonlySet<string>): VndbTitles {
  const object = record(value, 'vndb.json');
  only(object, 'vndb.json', ['schema', 'vn', 'release']);
  if (object.schema !== VNDB_TITLES_SCHEMA) throw new DataError('vndb.json.schema', `must be ${VNDB_TITLES_SCHEMA}`);
  return {
    vn: titleMap(object.vn, 'vndb.json.vn', VN_ID, vnIds),
    release: titleMap(object.release, 'vndb.json.release', RELEASE_ID, releaseIds),
  };
}

export const VNDB_COVERAGE_SCHEMA = 'shinki.portal.vndb_coverage.v1';

/**
 * VNDB release counts for exactly the engine families of `build/cores.toml`
 * (written by `xtask site prepare`). A missing or extra family, a family with
 * no releases, or counts above the denominator fail the build.
 */
export function parseVndbCoverage(value: Json, families: readonly string[]): VndbCoverage {
  const where = 'vndb-coverage.json';
  const object = record(value, where);
  only(object, where, ['schema', 'fetched_at', 'engine_releases', 'families']);
  if (object.schema !== VNDB_COVERAGE_SCHEMA) throw new DataError(`${where}.schema`, `must be ${VNDB_COVERAGE_SCHEMA}`);
  const fetched_at = text(object.fetched_at, `${where}.fetched_at`, 1, 64);
  if (Number.isNaN(Date.parse(fetched_at))) throw new DataError(`${where}.fetched_at`, 'must be an ISO 8601 timestamp');
  const engine_releases = integer(object.engine_releases, `${where}.engine_releases`, 1);
  const engines = new Set<string>();
  const entries = array(object.families, `${where}.families`).map((raw, i): FamilyCoverage => {
    const w = `${where}.families[${i}]`;
    const entry = record(raw, w);
    only(entry, w, ['family', 'engines', 'releases']);
    const family = text(entry.family, `${w}.family`, 1, 128);
    const strings = uniqueList(entry.engines, `${w}.engines`, (item, iw) => text(item, iw, 1, 128));
    if (strings.length === 0) throw new DataError(`${w}.engines`, 'needs at least one VNDB engine string');
    for (const engine of strings) {
      if (engines.has(engine)) throw new DataError(`${w}.engines`, `"${engine}" is mapped to two families`);
      engines.add(engine);
    }
    return { family, engines: strings, releases: integer(entry.releases, `${w}.releases`, 1) };
  });
  const listed = entries.map((entry) => entry.family);
  const duplicate = listed.find((family, i) => listed.indexOf(family) !== i);
  if (duplicate !== undefined) throw new DataError(`${where}.families`, `duplicate family "${duplicate}"`);
  const missing = families.filter((family) => !listed.includes(family));
  if (missing.length > 0) throw new DataError(`${where}.families`, `no counts for ${missing.join(', ')}`);
  const extra = listed.filter((family) => !families.includes(family));
  if (extra.length > 0) throw new DataError(`${where}.families`, `not in build-cores.toml: ${extra.join(', ')}`);
  const total = entries.reduce((sum, entry) => sum + entry.releases, 0);
  if (total > engine_releases) {
    throw new DataError(`${where}.engine_releases`, `family counts (${total}) exceed releases with an engine (${engine_releases})`);
  }
  return { fetched_at: new Date(fetched_at).toISOString(), engine_releases, families: entries, total };
}

/**
 * Manager binary assets use ZIPs for desktop/Apple, one universal APK for
 * Android, and an OpenHarmony test-signed HAP for OHOS. Source bundles end in
 * `-sources.zip` and do not match.
 */
function classifyAsset(name: string, version: string): Pick<ManagerAsset, 'platform' | 'architecture' | 'variant'> | null {
  const prefix = `shinki-emu-manager-manager-${version}-`;
  if (!name.startsWith(prefix)) return null;
  if (name === `${prefix}android-universal.apk`) {
    return { platform: 'android', architecture: 'universal', variant: null };
  }
  if (name === `${prefix}ohos-aarch64-debug-test-signed.hap`) {
    return { platform: 'ohos', architecture: 'aarch64', variant: 'device' };
  }
  if (!name.endsWith('.zip')) return null;
  const rest = name.slice(prefix.length, -'.zip'.length);
  const ios = /^ios-(x86_64|aarch64)-(device|simulator)-test$/.exec(rest);
  if (ios) return { platform: 'ios', architecture: ios[1] as Architecture, variant: ios[2] as Variant };
  const desktop = /^(windows|linux|macos)-(x86_64|aarch64)$/.exec(rest);
  if (desktop) return { platform: desktop[1] as Platform, architecture: desktop[2] as Architecture, variant: null };
  return null;
}

export function parseManagerRelease(value: Json, expectedTag: string | null): ManagerRelease | null {
  const object = record(value, 'manager-release.json');
  only(object, 'manager-release.json', ['schema', 'release']);
  if (object.schema !== MANAGER_RELEASE_SCHEMA) {
    throw new DataError('manager-release.json.schema', `must be ${MANAGER_RELEASE_SCHEMA}`);
  }
  if (object.release === null) {
    if (expectedTag !== null) throw new DataError('manager-release.json', `missing release ${expectedTag}`);
    return null;
  }
  const where = 'manager-release.json.release';
  const release = record(object.release, where);
  only(release, where, ['tag', 'version', 'prerelease', 'published_at', 'html_url', 'assets']);
  const tag = pattern(release.tag, `${where}.tag`, MANAGER_TAG);
  if (tag !== expectedTag) throw new DataError(`${where}.tag`, `${tag} does not match site-sources.json (${expectedTag})`);
  const version = pattern(release.version, `${where}.version`, SEMVER);
  if (tag !== `manager-v${version}`) throw new DataError(`${where}.version`, `does not match tag ${tag}`);
  if (typeof release.prerelease !== 'boolean') throw new DataError(`${where}.prerelease`, 'must be a boolean');
  const published_at = text(release.published_at, `${where}.published_at`, 1, 64);
  if (Number.isNaN(Date.parse(published_at))) throw new DataError(`${where}.published_at`, 'must be an ISO 8601 timestamp');
  const html_url = https(release.html_url, `${where}.html_url`);
  if (html_url !== `${SHINKIEMU_REPO}/releases/tag/${tag}`) throw new DataError(`${where}.html_url`, 'must be the release page');
  const assets: ManagerAsset[] = [];
  array(release.assets, `${where}.assets`).forEach((value, i) => {
    const at = `${where}.assets[${i}]`;
    const asset = record(value, at);
    only(asset, at, ['name', 'url', 'size', 'sha256']);
    const name = pattern(asset.name, `${at}.name`, ASSET);
    const url = https(asset.url, `${at}.url`);
    if (url !== `${RELEASE_DOWNLOAD_PREFIX}${tag}/${name}`) throw new DataError(`${at}.url`, 'must be this release download');
    const kind = classifyAsset(name, version);
    if (!kind) return;
    assets.push({
      name,
      url,
      size: integer(asset.size, `${at}.size`, 1, MAX_CORE_PACKAGE_BYTES * 4),
      sha256: asset.sha256 === null ? null : pattern(asset.sha256, `${at}.sha256`, SHA256),
      ...kind,
    });
  });
  return { tag, version, prerelease: release.prerelease, published_at: new Date(published_at).toISOString(), html_url, assets };
}
