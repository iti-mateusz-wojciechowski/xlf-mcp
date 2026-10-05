// Locating XLIFF files on disk and inside .app packages.
//
// A "set" is one source file (the compiler's <App>.g.xlf, target-language equal to
// source-language) plus the target files beside it that translate it. Targets are
// paired by the <file original="..."> attribute, which the compiler sets to the app
// name, so a renamed target file still pairs and an unrelated .xlf never does.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { readXlf, parseXlf, isSourceDoc } from './xlf.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.alpackages', '.alcache', '.snapshots', '.output', '.vscode']);

export function walk(dir, accept, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, accept, out);
    } else if (accept(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const isXlf = (name) => /\.(xlf|xliff)$/i.test(name);

export function resolveInput(path) {
  if (!path) throw new Error('path is required: an app folder, a Translations folder, a repo root, or an .xlf file');
  const full = resolve(path);
  if (!existsSync(full)) throw new Error(`path not found: ${full}`);
  return full;
}

/** All translation sets under `path` (a folder, or one .xlf file and its siblings). */
export function findSets(path, { languages } = {}) {
  const full = resolveInput(path);
  const isFile = statSync(full).isFile();
  const files = isFile ? walk(dirname(full), isXlf).filter((f) => dirname(f) === dirname(full)) : walk(full, isXlf);
  const docs = files.map((f) => readXlf(f));
  const sources = docs.filter(isSourceDoc);
  const wanted = languages?.length ? new Set(languages.map((l) => l.toLowerCase())) : undefined;
  const sets = sources.map((source) => ({
    folder: dirname(source.path),
    source,
    targets: docs.filter((d) => !isSourceDoc(d)
      && dirname(d.path) === dirname(source.path)
      && d.original === source.original
      && (!wanted || wanted.has(d.targetLanguage.toLowerCase()))),
  }));
  const paired = new Set(sets.flatMap((s) => s.targets.map((t) => t.path)));
  const orphans = docs.filter((d) => !isSourceDoc(d) && !paired.has(d.path)
    && (!wanted || wanted.has(d.targetLanguage.toLowerCase())));
  if (isFile) {
    const only = sets.filter((s) => s.source.path === full || s.targets.some((t) => t.path === full));
    for (const s of only) s.targets = s.targets.filter((t) => full === s.source.path || t.path === full);
    return { sets: only, orphans: orphans.filter((d) => d.path === full) };
  }
  return { sets, orphans };
}

/** Every non-source .xlf under `path`, optionally restricted to one language. */
export function findTargetDocs(path, language) {
  const full = resolveInput(path);
  const files = statSync(full).isFile() ? [full] : walk(full, isXlf);
  return files.map((f) => readXlf(f))
    .filter((d) => !isSourceDoc(d) && (!language || d.targetLanguage?.toLowerCase() === language.toLowerCase()));
}

/**
 * The .xlf files embedded in a .app package. A .app is a zip, usually behind a
 * 40-byte NAVX header, so offsets are rebased on where the zip actually starts.
 */
export function readAppTranslations(appPath) {
  const buf = readFileSync(appPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${appPath}: not a zip archive`);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const base = eocd - cdSize - cdOffset;
  const out = [];
  let p = base + cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = base + buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!isXlf(name)) continue;
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? inflateRawSync(raw) : method === 0 ? raw : undefined;
    if (!data) continue;
    try {
      out.push(parseXlf(data.toString('utf8'), `${appPath}!${name}`));
    } catch { /* a malformed embedded file is skipped, not fatal */ }
  }
  return out;
}

/** Translations from every .app under each .alpackages folder below `path`. */
export function findPackageDocs(path, language) {
  const full = resolveInput(path);
  const roots = [];
  const collect = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sub = join(dir, e.name);
      if (e.name === '.alpackages') roots.push(sub);
      else if (!SKIP_DIRS.has(e.name)) collect(sub);
    }
  };
  if (statSync(full).isDirectory()) collect(full);
  const seen = new Set();
  const docs = [];
  for (const root of roots) {
    for (const app of readdirSync(root).filter((f) => extname(f).toLowerCase() === '.app')) {
      if (seen.has(app)) continue;
      seen.add(app);
      try {
        docs.push(...readAppTranslations(join(root, app)));
      } catch { /* unreadable package: skip */ }
    }
  }
  return docs.filter((d) => !isSourceDoc(d) && (!language || d.targetLanguage?.toLowerCase() === language.toLowerCase()));
}
