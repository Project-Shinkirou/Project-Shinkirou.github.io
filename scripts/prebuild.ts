// Prepares every build input for Astro:
// - validates the ShinkiEMU metadata snapshot (index hashes, schemas) and writes
//   the normalized `src/generated/site-data.json` read by the pages;
// - copies exactly the indexed snapshot files to `public/data/shinkiemu/v1/` so
//   the deployed pages and the published data come from one snapshot, and the
//   validated source record to `public/data/shinkiemu/site-sources.json`;
// - imports the RoukakuEngine and ShinkiEMU markdown docs into the Starlight
//   content collection.
//
// Environment:
//   SHINKI_DATA_DIR     metadata snapshot, plus site-sources.json, vndb.json,
//                       manager-release.json (from `xtask site prepare`) and verbatim
//                       copies of ShinkiEMU build/targets.toml and build/cores.toml
//                       as build-targets.toml and build-cores.toml
//   ROUKAKU_DOCS_DIR    RoukakuEngine docs/ tree with zh-cn/ and en/
//   SHINKIEMU_DOCS_DIR  ShinkiEMU docs/ tree with zh-cn/ and en/
//   SITE_PRODUCTION=1   all three are required; synthetic fixtures are refused
// Unset inputs fall back to fixtures/synthetic/ outside production.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';
import { parse as parseToml } from 'smol-toml';
import {
  DataError,
  ROUKAKU_REPO,
  SHINKIEMU_REPO,
  isSafeRelativePath,
  parseCompatibility,
  parseCores,
  parseIndex,
  parseBuildInventory,
  parseManagerRelease,
  parseVndbTitles,
  parsePatches,
  parseSources,
  type SiteData,
  type SiteSources,
} from '../src/lib/site-data.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'fixtures', 'synthetic');
const SYNTHETIC_MARKER = 'SYNTHETIC';
const LOCALES = ['zh-cn', 'en'] as const;
const REQUIRED_DATA_FILES = ['compatibility.json', 'cores.json', 'patches.json'];

const production = process.env.SITE_PRODUCTION === '1';
let synthetic = false;

function fail(message: string): never {
  console.error(`prebuild: ${message}`);
  process.exit(1);
}

/** Resolves an input directory from `env`, or the synthetic fixture outside production. */
function inputDir(env: string, fixture: string): string {
  const configured = process.env[env];
  let dir: string;
  if (configured === undefined || configured === '') {
    if (production) fail(`SITE_PRODUCTION=1 requires ${env}; synthetic fixtures are never deployed.`);
    dir = path.join(fixtures, fixture);
    console.warn(`prebuild: ${env} is unset; using synthetic fixture ${path.relative(root, dir)}`);
  } else {
    dir = path.resolve(configured);
  }
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    fail(`${env} directory does not exist: ${dir}`);
  }
  if (!lstatSync(real).isDirectory()) fail(`${env} is not a directory: ${dir}`);
  const isFixture = real === realpathSync(fixtures) || real.startsWith(realpathSync(fixtures) + path.sep);
  const marked = readdirSync(real).includes(SYNTHETIC_MARKER);
  if (isFixture || marked) {
    if (production) fail(`${env} points at synthetic test data (${dir}); refusing a production build.`);
    synthetic = true;
  }
  return real;
}

/** Reads a regular file inside `dir`; links and reparse points are refused. */
function readInside(dir: string, relative: string): Buffer {
  const file = path.join(dir, ...relative.split('/'));
  let current = dir;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) throw new DataError(relative, 'file is missing');
    if (stat.isSymbolicLink()) throw new DataError(relative, 'links are not accepted');
  }
  if (!lstatSync(file).isFile()) throw new DataError(relative, 'not a regular file');
  return readFileSync(file);
}

function parseJson(bytes: Buffer, where: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new DataError(where, `invalid JSON (${(error as Error).message})`);
  }
}

function parseTomlFile(bytes: Buffer, where: string): unknown {
  try {
    return parseToml(bytes.toString('utf8'));
  } catch (error) {
    throw new DataError(where, `invalid TOML (${(error as Error).message})`);
  }
}

/** Validated site data plus the exact indexed snapshot bytes to publish. */
interface LoadedSnapshot {
  data: SiteData;
  files: Map<string, Buffer>;
}

function loadData(dataDir: string): LoadedSnapshot {
  const index = parseIndex(parseJson(readInside(dataDir, 'index.json'), 'index.json'));
  const files = new Map<string, Buffer>();
  for (const file of index.files) {
    const bytes = readInside(dataDir, file.path);
    if (bytes.length !== file.size) throw new DataError(file.path, `size ${bytes.length} != indexed ${file.size}`);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new DataError(file.path, 'sha256 does not match index.json');
    }
    files.set(file.path, bytes);
  }
  for (const required of REQUIRED_DATA_FILES) {
    if (!files.has(required)) throw new DataError('index.json', `${required} is not indexed`);
  }
  const json = (name: string) => parseJson(files.get(name) ?? readInside(dataDir, name), name);
  const inventory = parseBuildInventory(
    parseTomlFile(readInside(dataDir, 'build-targets.toml'), 'build-targets.toml'),
    parseTomlFile(readInside(dataDir, 'build-cores.toml'), 'build-cores.toml'),
  );
  const known = new Set(inventory.cores.map((core) => core.plugin_id));
  const sources = parseSources(json('site-sources.json'));
  const compatibility = parseCompatibility(json('compatibility.json'), known);
  const patches = parsePatches(json('patches.json'), known);
  // Fetched by `xtask site prepare`; not part of the indexed metadata snapshot.
  const titles = parseVndbTitles(
    json('vndb.json'),
    new Set([...compatibility.map((entry) => entry.vn_id), ...patches.flatMap((patch) => patch.vn_ids)]),
    new Set([...compatibility.map((entry) => entry.release_id), ...patches.flatMap((patch) => patch.release_ids)]),
  );
  const data: SiteData = {
    synthetic,
    index: {
      generated_at_unix_ms: index.generated_at_unix_ms,
      source_commit: index.source_commit,
      file_count: index.files.length,
    },
    sources,
    titles,
    manager_release: parseManagerRelease(json('manager-release.json'), sources.manager_release_tag),
    compatibility,
    cores: parseCores(json('cores.json'), known),
    patches,
    targets: inventory.targets,
    matrix: inventory.cores,
  };
  files.set('index.json', readInside(dataDir, 'index.json'));
  return { data, files };
}

/**
 * Publishes exactly the indexed snapshot under `v1/`, plus the validated source
 * record beside it at `/data/shinkiemu/site-sources.json`. The Pages workflow
 * fetches that record to compare the deployed product commits; it stays out of
 * `v1/` so the snapshot directory matches its index.
 */
function writePublishedSnapshot(files: Map<string, Buffer>, sources: SiteSources): void {
  const dataRoot = path.join(root, 'public', 'data', 'shinkiemu');
  rmSync(dataRoot, { recursive: true, force: true });
  const out = path.join(dataRoot, 'v1');
  for (const [relative, bytes] of files) {
    const target = path.join(out, ...relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(path.join(dataRoot, 'site-sources.json'), JSON.stringify(sources, null, 2) + '\n');
}

interface DocsSource {
  env: string;
  fixture: string;
  repo: string;
  commit: string;
  /** Route segment under `/<locale>/`. */
  route: string;
}

const MARKDOWN = /\.(md|mdx)$/i;

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`docs: links are not accepted (${relative})`);
    if (entry.isDirectory()) out.push(...listFiles(dir, relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

/** Route slug for a markdown file, matching Astro's glob loader id generation. */
function docSlug(relative: string): string {
  const slugger = new GithubSlugger();
  return relative
    .replace(MARKDOWN, '')
    .split('/')
    .map((segment) => {
      slugger.reset();
      return slugger.slug(segment);
    })
    .join('/')
    .replace(/(^|\/)index$/, '');
}

/** Adds a `title` from the first H1 when frontmatter lacks one; Starlight requires it. */
function withTitle(source: string, where: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  if (frontmatter && /^title\s*:/m.test(frontmatter[1])) return source;
  const body = frontmatter ? source.slice(frontmatter[0].length) : source;
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body);
  if (!heading) fail(`docs: ${where} needs a title frontmatter field or a "# " heading`);
  const title = JSON.stringify(heading[1]);
  const rest = body.slice(0, heading.index) + body.slice(heading.index + heading[0].length).replace(/^\r?\n/, '');
  return `---\ntitle: ${title}\n${frontmatter ? frontmatter[1] + '\n' : ''}---\n${rest}`;
}

/**
 * Rewrites relative markdown links: links to docs pages become site routes,
 * links leaving the language tree become GitHub links at the pinned commit.
 * Fenced code blocks are left untouched.
 */
function rewriteLinks(
  source: string,
  where: { locale: string; file: string; pages: Set<string> },
  docs: DocsSource,
): string {
  let fenced = false;
  return source
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (match, target: string, titlePart: string | undefined) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) return match;
        const [pathPart, hash = ''] = target.split('#', 2);
        const fromDir = path.posix.dirname(where.file);
        const resolved = path.posix.normalize(path.posix.join(fromDir, pathPart));
        const anchor = hash ? `#${hash}` : '';
        let href: string;
        if (!resolved.startsWith('../') && resolved !== '..') {
          if (!MARKDOWN.test(resolved)) return match;
          if (!where.pages.has(resolved)) fail(`docs: ${where.locale}/${where.file} links to missing page ${target}`);
          const slug = docSlug(resolved);
          href = `/${where.locale}/${docs.route}/${slug ? slug + '/' : ''}${anchor}`;
        } else {
          // `<repo>/docs/<locale>/<file>`: resolve against the repository root.
          const repoPath = path.posix.normalize(path.posix.join('docs', where.locale, fromDir, pathPart));
          if (repoPath.startsWith('..')) fail(`docs: ${where.locale}/${where.file} links outside the repository: ${target}`);
          href = `${docs.repo}/blob/${docs.commit}/${repoPath}${anchor}`;
        }
        return `](${href}${titlePart ?? ''})`;
      });
    })
    .join('\n');
}

function importDocs(docs: DocsSource, contentRoot: string): number {
  const dir = inputDir(docs.env, docs.fixture);
  const perLocale = new Map<string, string[]>();
  for (const locale of LOCALES) {
    const localeDir = path.join(dir, locale);
    if (!lstatSync(localeDir, { throwIfNoEntry: false })?.isDirectory()) {
      fail(`${docs.env} must contain a ${locale}/ directory (${dir})`);
    }
    const files = listFiles(localeDir);
    for (const file of files) {
      if (!isSafeRelativePath(file)) fail(`docs: unsafe file name ${locale}/${file}`);
    }
    if (!files.includes('index.md') && !files.includes('index.mdx')) fail(`docs: ${docs.env}/${locale}/index.md is required`);
    perLocale.set(locale, files);
  }
  // zh-cn is the default locale: Starlight falls back to it for missing English
  // pages, but an English-only page would have no zh-cn route.
  const zhPages = new Set((perLocale.get('zh-cn') ?? []).filter((f) => MARKDOWN.test(f)).map(docSlug));
  for (const file of perLocale.get('en') ?? []) {
    if (MARKDOWN.test(file) && !zhPages.has(docSlug(file))) {
      fail(`docs: ${docs.env}/en/${file} has no zh-cn counterpart`);
    }
  }
  let count = 0;
  for (const locale of LOCALES) {
    const files = perLocale.get(locale) ?? [];
    const pages = new Set(files.filter((f) => MARKDOWN.test(f)));
    for (const file of files) {
      const source = path.join(dir, locale, ...file.split('/'));
      const target = path.join(contentRoot, locale, ...docs.route.split('/'), ...file.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      if (MARKDOWN.test(file)) {
        const text = readFileSync(source, 'utf8').replace(/^\uFEFF/, '');
        writeFileSync(target, rewriteLinks(withTitle(text, `${locale}/${file}`), { locale, file, pages }, docs));
        count += 1;
      } else {
        writeFileSync(target, readFileSync(source));
      }
    }
  }
  return count;
}

function main(): void {
  const dataDir = inputDir('SHINKI_DATA_DIR', 'data');
  let loaded: LoadedSnapshot;
  try {
    loaded = loadData(dataDir);
  } catch (error) {
    if (error instanceof DataError) fail(`invalid ShinkiEMU data in ${dataDir}: ${error.message}`);
    throw error;
  }
  const { sources } = loaded.data;

  const contentRoot = path.join(root, 'src', 'content', 'docs');
  rmSync(contentRoot, { recursive: true, force: true });
  const pages =
    importDocs(
      { env: 'ROUKAKU_DOCS_DIR', fixture: 'roukaku-docs', repo: ROUKAKU_REPO, commit: sources.roukaku_commit, route: 'roukaku/docs' },
      contentRoot,
    ) +
    importDocs(
      { env: 'SHINKIEMU_DOCS_DIR', fixture: 'shinkiemu-docs', repo: SHINKIEMU_REPO, commit: sources.shinkiemu_commit, route: 'shinkiemu/docs' },
      contentRoot,
    );

  // `synthetic` may have been set by a docs input after the data was loaded.
  loaded.data.synthetic = synthetic;
  const generated = path.join(root, 'src', 'generated');
  mkdirSync(generated, { recursive: true });
  writeFileSync(path.join(generated, 'site-data.json'), JSON.stringify(loaded.data, null, 2) + '\n');
  writePublishedSnapshot(loaded.files, sources);

  const { data } = loaded;
  console.log(
    `prebuild: ${data.compatibility.length} compatibility reports, ${data.cores.length} core releases, ` +
      `${data.patches.length} patches, ${data.matrix.length} cores in matrix, ${pages} docs pages` +
      (synthetic ? ' [SYNTHETIC — not for deployment]' : ''),
  );
}

main();
