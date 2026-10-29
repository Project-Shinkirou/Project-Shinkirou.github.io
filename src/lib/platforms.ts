// Platform-level views of the build inventory for player-facing pages. The
// full target-triple matrix lives on the docs platform page. Everything here
// is a pure function of the parsed inventory (pages pass `site.targets` and
// `site.matrix`), so new targets and cores in ShinkiEMU's build/targets.toml
// and build/cores.toml show up without copy changes.

import type { BuildTarget, ManagerAsset, ManagerRelease, MatrixCore, Platform } from './site-data.ts';

/** Order of platform cards and icons on product pages. */
export const PLATFORM_ORDER: readonly Platform[] = ['windows', 'macos', 'linux', 'android', 'ios', 'ohos'];

/** `static`: no standalone package, but the Manager embeds the core statically. */
export type PlatformState = 'supported' | 'static' | 'blocked' | 'none';

/** Fragment id of a core's card on the cores page (linked from the product pages). */
export function coreAnchor(pluginId: string): string {
  return `core-${pluginId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * One core per platform: buildable when any of its targets there is buildable,
 * otherwise static when any target embeds it in the Manager. Both are green.
 */
export function corePlatformStates(
  core: MatrixCore,
  targets: readonly BuildTarget[],
): { platform: Platform; state: PlatformState }[] {
  const platformOf = new Map(targets.map((target) => [target.triple, target.platform]));
  return PLATFORM_ORDER.map((platform) => {
    const own = core.targets.filter((target) => platformOf.get(target.target) === platform);
    let state: PlatformState = 'none';
    if (own.some((target) => target.status === 'supported')) state = 'supported';
    else if (own.some((target) => target.status === 'static')) state = 'static';
    else if (own.length > 0) state = 'blocked';
    return { platform, state };
  });
}

const STATE_RANK: Record<PlatformState, number> = { supported: 3, static: 2, blocked: 1, none: 0 };

export interface EngineFamily {
  family: string;
  /** Cores of this family, in inventory order. */
  cores: MatrixCore[];
  /** Best state of any of the family's cores on each platform. */
  states: { platform: Platform; state: PlatformState }[];
}

/** Cores grouped by original engine family, in order of first appearance in the inventory. */
export function engineFamilies(matrix: readonly MatrixCore[], targets: readonly BuildTarget[]): EngineFamily[] {
  const families = new Map<string, MatrixCore[]>();
  for (const core of matrix) families.set(core.family, [...(families.get(core.family) ?? []), core]);
  return [...families].map(([family, cores]) => {
    const perCore = cores.map((core) => corePlatformStates(core, targets));
    const states = PLATFORM_ORDER.map((platform, i) => ({
      platform,
      state: perCore.reduce<PlatformState>(
        (best, own) => (STATE_RANK[own[i].state] > STATE_RANK[best] ? own[i].state : best),
        'none',
      ),
    }));
    return { family, cores, states };
  });
}

/** Platforms where the Manager has a buildable target, and listed platforms where it has none. */
export function managerPlatforms(targets: readonly BuildTarget[]): { available: Platform[]; blocked: Platform[] } {
  const listed = PLATFORM_ORDER.filter((platform) => targets.some((target) => target.platform === platform));
  const available = listed.filter((platform) =>
    targets.some((target) => target.platform === platform && target.manager.status === 'supported'),
  );
  return { available, blocked: listed.filter((platform) => !available.includes(platform)) };
}

/** Per platform, the cores the Manager embeds statically there (platforms without any are left out). */
export function embeddedCores(
  matrix: readonly MatrixCore[],
  targets: readonly BuildTarget[],
): { platform: Platform; cores: MatrixCore[] }[] {
  return PLATFORM_ORDER.map((platform) => ({
    platform,
    cores: matrix.filter((core) =>
      corePlatformStates(core, targets).some((entry) => entry.platform === platform && entry.state === 'static'),
    ),
  })).filter((entry) => entry.cores.length > 0);
}

export interface ManagerDownload {
  platform: Platform;
  /** Build targets of this platform in build/targets.toml order. */
  targets: BuildTarget[];
  /** Targets where the Manager is buildable. */
  supported: number;
  /** Packages of the latest Manager release for this platform. */
  assets: ManagerAsset[];
  /** The platform's only regular (non-test) package; download buttons link to it directly. */
  direct: ManagerAsset | null;
  /** What a visitor on this platform can do today. */
  state: 'download' | 'test' | 'source' | 'blocked';
}

/** The latest Manager release per platform, with the build state of its targets. */
export function managerDownloads(targets: readonly BuildTarget[], release: ManagerRelease | null): ManagerDownload[] {
  return PLATFORM_ORDER.map((platform) => {
    const own = targets.filter((target) => target.platform === platform);
    const supported = own.filter((target) => target.manager.status === 'supported').length;
    const assets = release ? release.assets.filter((asset) => asset.platform === platform) : [];
    const regular = assets.filter((asset) => asset.variant === null);
    const state = regular.length > 0 ? 'download' : assets.length > 0 ? 'test' : supported > 0 ? 'source' : 'blocked';
    return { platform, targets: own, supported, assets, direct: regular.length === 1 ? regular[0] : null, state };
  });
}
