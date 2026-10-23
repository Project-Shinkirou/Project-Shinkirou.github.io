// The validated snapshot written by `scripts/prebuild.ts`. Pages import this
// instead of reading input directories, so every page renders the same data.
import generated from '../generated/site-data.json';
import type { SiteData } from './site-data.ts';

export const site = generated as SiteData;

export const ISSUES_URL = 'https://github.com/Project-Shinkirou/ShinkiEMU/issues';
export const RELEASES_URL = 'https://github.com/Project-Shinkirou/ShinkiEMU/releases';
