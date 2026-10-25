// Platform-level views of the build inventory for player-facing pages. The
// full target-triple matrix lives on the docs platform page.

import type { MatrixCore, Platform } from './site-data.ts';
import { site } from './site.ts';

/** Order of platform cards and icons on product pages. */
export const PLATFORM_ORDER: readonly Platform[] = ['windows', 'macos', 'linux', 'android', 'ios', 'ohos'];

export type PlatformState = 'supported' | 'blocked' | 'none';

/** Fragment id of a core's card on the cores page (linked from the ShinkiEMU page). */
export function coreAnchor(pluginId: string): string {
  return `core-${pluginId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** One core per platform: buildable when any of its targets there is buildable. */
export function corePlatformStates(core: MatrixCore): { platform: Platform; state: PlatformState }[] {
  const platformOf = new Map(site.targets.map((target) => [target.triple, target.platform]));
  return PLATFORM_ORDER.map((platform) => {
    const targets = core.targets.filter((target) => platformOf.get(target.target) === platform);
    let state: PlatformState = 'none';
    if (targets.some((target) => target.status === 'supported')) state = 'supported';
    else if (targets.length > 0) state = 'blocked';
    return { platform, state };
  });
}
