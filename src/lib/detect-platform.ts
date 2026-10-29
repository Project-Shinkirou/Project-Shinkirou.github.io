// Client-side guess of the visitor's platform from the user agent, used to
// highlight the matching download. Pages never depend on it: without
// JavaScript every platform stays listed and the generic actions remain.

import type { Platform } from './site-data.ts';

export function detectPlatform(): Platform | null {
  const ua = navigator.userAgent;
  if (/OpenHarmony|HarmonyOS/i.test(ua)) return 'ohos';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux|X11|CrOS/.test(ua)) return 'linux';
  return null;
}
