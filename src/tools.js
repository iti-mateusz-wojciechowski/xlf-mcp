// Tool definitions and handlers.
//
// Every write tool previews by default and reports what it would change as a
// summary plus a capped sample, never as a diff: a sync of a 7000-unit file can
// touch every unit, and a diff of that costs more context than it is worth.

import { relative, resolve, dirname, basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  readXlf, writeXlf, syncDocs, setTarget, parseUnit, decode, sourceKey, isEmptyTarget,
  isSourceDoc, createTargetDoc, placeholders, isStandardState, restateTarget,
} from './xlf.js';
import { findSets, findTargetDocs, findPackageDocs, resolveInput } from './workspace.js';
import { resolveConfig, settings, describeConfig, CONFIG_FILE } from './config.js';

const DEFAULT_SAMPLE = 20;
const PREVIEW = 'Preview only -- nothing written (pass write: true to apply).';

function rel(base, path) {
  const r = relative(base, path);
  return r && !r.startsWith('..') ? r.split('\\').join('/') : path.split('\\').join('/');
}

function baseOf(path) {
  const full = resolveInput(path);
  return /\.(xlf|xliff)$/i.test(full) ? resolve(full, '..') : full;
}

function sample(list, max, fmt) {
  const lines = list.slice(0, max).map(fmt);
  if (list.length > max) lines.push(`    … ${list.length - max} more`);
  return lines;
}

function short(text, n = 80) {
  const t = String(text ?? '').replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function stateCounts(units) {
  const counts = {};
  for (const u of units) {
    const k = !u.hasTarget ? '(no target)' : u.state === undefined ? '(no state)' : u.state === '' ? '""' : u.state;
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ');
}

function placeholderMismatch(u) {
  return !isEmptyTarget(u) && placeholders(u.source) !== placeholders(u.target);
}

/** Translation memory: source text -> distinct target texts with where each came from. */
function buildMemory(docs) {
  const memory = new Map();
  for (const d of docs) {
    for (const u of d.units) {
      if (isEmptyTarget(u)) continue;
      const key = sourceKey(u.source);
      if (!key) continue;
      const text = decode(u.target);
      let byText = memory.get(key);
      if (!byText) memory.set(key, (byText = new Map()));
      let entry = byText.get(text);
      if (!entry) byText.set(text, (entry = { text, count: 0, where: [] }));
      entry.count++;
      if (entry.where.length < 3) entry.where.push({ path: d.path, id: u.id, state: u.state });
    }
  }
  return memory;
}

function memoryFor(cache, language, { searchPath, includePackages }) {
  const key = language.toLowerCase();
  if (!cache.has(key)) {
    const docs = findTargetDocs(searchPath, key);
    if (includePackages) docs.push(...findPackageDocs(searchPath, key));
    cache.set(key, buildMemory(docs));
  }
  return cache.get(key);
}

/** Fill the empty targets of one doc from a translation memory. */
function fillFromMemory(doc, memory, { state, qualifier, ambiguous }) {
  const filled = [];
  const conflicts = [];
  let unmatched = 0;
  const units = doc.units.map((u) => {
    if (!isEmptyTarget(u)) return u;
    const byText = memory.get(sourceKey(u.source));
    if (!byText) { unmatched++; return u; }
    const options = [...byText.values()].sort((a, b) => b.count - a.count);
    if (options.length > 1 && (ambiguous !== 'mostFrequent' || options[0].count === options[1].count)) {
      conflicts.push({ id: u.id, source: decode(u.source), options });
      return u;
    }
    filled.push({ id: u.id, source: decode(u.source), target: options[0].text });
    return parseUnit(setTarget(u.block, options[0].text, state, doc.eol, qualifier));
  });
  return { doc: { ...doc, units }, filled, conflicts, unmatched };
}

function reportFill(out, label, r, maxItems) {
  out.push(`${label}: ${r.filled.length} filled, ${r.conflicts.length} ambiguous, ${r.unmatched} with no match`);
  out.push(...sample(r.filled, maxItems, (f) => `    = ${short(f.source, 40)} -> ${short(f.target, 40)}`));
  out.push(...sample(r.conflicts, maxItems, (c) => `    ? ${c.id}: ${short(c.source, 40)} -> ${c.options.map((o) => `"${short(o.text, 30)}" x${o.count}`).join(' | ')}`));
}

// --- xlf_status -----------------------------------------------------------------

function status({ path, languages }) {
  const base = baseOf(path);
  const { sets, orphans } = findSets(path, { languages });
  if (!sets.length && !orphans.length) return { text: `No .xlf files found under ${base}.` };
  const cfg = settings(base);
  const out = [describeConfig(resolveConfig(base))];
  for (const s of sets) {
    out.push(`\n${rel(base, s.source.path)}  (${s.source.units.length} units, original="${s.source.original}")`);
    if (!s.targets.length) out.push('    no target files');
    for (const t of s.targets) {
      const { changes } = syncDocs(s.source, t, cfg);
      const empty = t.units.filter(isEmptyTarget).length;
      const review = t.units.filter((u) => !isEmptyTarget(u) && (u.state ?? '').startsWith('needs-')).length;
      const nonStandard = t.units.filter((u) => u.hasTarget && !isStandardState(u.state ?? 'translated')).length;
      const mismatched = t.units.filter(placeholderMismatch).length;
      const outOfSync = changes.added.length || changes.removed.length || changes.sourceChanged.length
        || changes.notesUpdated.length;
      out.push(`  ${t.targetLanguage}  ${rel(base, t.path)}`);
      out.push(`    ${t.units.length} units: ${empty} empty, ${review} filled but needs-*; states ${stateCounts(t.units)}`);
      out.push(outOfSync
        ? `    out of sync: +${changes.added.length} new, ${changes.sourceChanged.length} source changed, -${changes.removed.length} obsolete, ${changes.notesUpdated.length} notes`
        : '    in sync with source');
      if (changes.outOfOrder) out.push('    unit order differs from source (harmless; xlf_sync reorder: true aligns it)');
      if (changes.duplicates.length) out.push(`    duplicate ids (xlf_sync keeps one): ${changes.duplicates.join(', ')}`);
      if (mismatched) out.push(`    ${mismatched} targets whose %n placeholders differ from the source (xlf_list filter "placeholders")`);
      if (nonStandard) out.push(`    ${nonStandard} targets with a state outside XLIFF 1.2 (xlf_normalize_states converts them)`);
    }
  }
  for (const o of orphans) {
    out.push(`\nunpaired target: ${rel(base, o.path)} (${o.targetLanguage}, original="${o.original}") -- no source file with that original beside it`);
  }
  return { text: out.join('\n') };
}

// --- xlf_list -------------------------------------------------------------------

const LIST_FILTERS = {
  all: () => true,
  empty: isEmptyTarget,
  'needs-any': (u) => isEmptyTarget(u) || (u.state ?? '').startsWith('needs-'),
  placeholders: placeholderMismatch,
};

function list({ path, filter = 'empty', offset = 0, limit = 50 }) {
  const doc = readXlf(resolveInput(path));
  const pick = LIST_FILTERS[filter] ?? ((u) => u.state === filter);
  const hits = doc.units.filter(pick);
  const page = hits.slice(offset, offset + limit);
  const lines = [`${doc.path} (${doc.targetLanguage}): ${hits.length} units match "${filter}", showing ${page.length ? offset + 1 : 0}-${offset + page.length}`];
  for (const u of page) {
    lines.push(`- id: ${u.id}`);
    lines.push(`  source: ${decode(u.source)}`);
    if (!isSourceDoc(doc)) {
      const attrs = [u.state !== undefined && `state="${u.state}"`, u.qualifier && `state-qualifier="${u.qualifier}"`].filter(Boolean);
      lines.push(`  target: ${decode(u.target)}${attrs.length ? `  [${attrs.join(' ')}]` : ''}`);
      if (placeholderMismatch(u)) lines.push(`  placeholders differ: source "${placeholders(u.source)}" vs target "${placeholders(u.target)}"`);
    }
    if (u.devNote?.text?.trim()) lines.push(`  developer note: ${decode(u.devNote.text)}`);
    if (u.genNote?.text?.trim()) lines.push(`  context: ${decode(u.genNote.text)}`);
  }
  if (offset + page.length < hits.length) lines.push(`… pass offset: ${offset + page.length} for the next page`);
  return { text: lines.join('\n') };
}

// --- xlf_sync -------------------------------------------------------------------

function sync({ path, languages, reorder = false, onSourceChange, write = false, maxItems = DEFAULT_SAMPLE }) {
  const base = baseOf(path);
  const { sets, orphans } = findSets(path, { languages });
  if (!sets.length) return { text: `No source .g.xlf found under ${base}.` };
  const cfg = settings(base, { onSourceChange });
  const out = [write ? 'Synchronised:' : PREVIEW,
    `new targets: state "${cfg.stateEmpty}"; changed source: ${cfg.onSourceChange === 'clear' ? `target emptied, state "${cfg.stateEmpty}"` : `target kept, state "${cfg.stateReview}"`}`];
  let touched = 0;
  for (const s of sets) {
    for (const t of s.targets) {
      const { doc, changes } = syncDocs(s.source, t, { ...cfg, reorder });
      const any = changes.added.length || changes.removed.length || changes.sourceChanged.length
        || changes.notesUpdated.length || changes.reordered || changes.duplicates.length;
      out.push(`\n${rel(base, t.path)} (${t.targetLanguage}): ${any ? '' : 'already in sync'}`.trimEnd());
      if (!any) continue;
      touched++;
      out.push(`  +${changes.added.length} new, ${changes.sourceChanged.length} source changed, -${changes.removed.length} obsolete, ${changes.notesUpdated.length} notes updated${changes.reordered ? ', reordered to source order' : ''}`);
      out.push(...sample(changes.added, maxItems, (c) => `    + ${c.id}: ${short(c.source)}`));
      out.push(...sample(changes.sourceChanged, maxItems, (c) => `    ~ ${c.id}: "${short(c.from, 40)}" -> "${short(c.to, 40)}"; target "${short(c.target, 40)}" ${c.kept ? 'kept for review' : 'emptied'}`));
      out.push(...sample(changes.removed, maxItems, (c) => `    - ${c.id}: ${short(c.source)}`));
      if (changes.duplicates.length) out.push(`  duplicate ids collapsed to one copy (a translated copy wins over an empty one): ${changes.duplicates.join(', ')}`);
      if (write) {
        const ids = new Set(doc.units.map((u) => u.id));
        if (ids.size !== doc.units.length || ids.size !== s.source.units.length || s.source.units.some((u) => !ids.has(u.id))) {
          throw new Error(`${t.path}: self-check failed, synced units do not match the source; nothing written`);
        }
        writeXlf(doc);
      }
    }
  }
  for (const o of orphans) out.push(`\nunpaired target left alone: ${rel(base, o.path)} (original="${o.original}")`);
  if (!touched) return { text: 'Every target is already in sync with its source.' };
  return { text: out.join('\n') };
}

// --- xlf_find -------------------------------------------------------------------

function find({ path, text, language, match = 'exact', includePackages = false, limit = 20 }) {
  if (!text) throw new Error('text is required');
  const base = baseOf(path);
  const docs = findTargetDocs(path, language);
  if (includePackages) docs.push(...findPackageDocs(path, language));
  const needle = sourceKey(text);
  const lower = needle.toLowerCase();
  const test = match === 'contains'
    ? (k) => k.toLowerCase().includes(lower)
    : match === 'ignoreCase' ? (k) => k.toLowerCase() === lower : (k) => k === needle;
  const memory = buildMemory(docs);
  const hits = [...memory.entries()].filter(([k]) => test(k)).slice(0, limit);
  if (!hits.length) return { text: `No translation of "${text}" found in ${docs.length} target files${language ? ` (${language})` : ''}.` };
  const out = [];
  for (const [src, byText] of hits) {
    out.push(`source: ${src}`);
    for (const e of [...byText.values()].sort((a, b) => b.count - a.count)) {
      const where = e.where.map((w) => `${rel(base, w.path)}${w.state ? ` [${w.state}]` : ''}`).join('; ');
      out.push(`  ${e.text}   (x${e.count}; ${where})`);
    }
  }
  return { text: out.join('\n') };
}

// --- xlf_apply_matches ----------------------------------------------------------

function applyMatches({
  path, languages, searchPath, includePackages = false, ambiguous = 'skip', write = false, maxItems = DEFAULT_SAMPLE,
}) {
  const base = baseOf(path);
  const { sets, orphans } = findSets(path, { languages });
  const targets = [...sets.flatMap((s) => s.targets), ...orphans];
  if (!targets.length) return { text: `No target .xlf found under ${base}.` };
  const cfg = settings(base);
  const cache = new Map();
  const out = [write ? 'Applied:' : PREVIEW,
    `filled targets: state "${cfg.stateMatched}"${cfg.qualifierMatched ? `, state-qualifier "${cfg.qualifierMatched}"` : ''}`];
  for (const t of targets) {
    const memory = memoryFor(cache, t.targetLanguage, { searchPath: searchPath ?? base, includePackages });
    const r = fillFromMemory(t, memory, { state: cfg.stateMatched, qualifier: cfg.qualifierMatched, ambiguous });
    reportFill(out, `\n${rel(base, t.path)} (${t.targetLanguage})`, r, maxItems);
    if (write && r.filled.length) writeXlf(r.doc);
  }
  return { text: out.join('\n') };
}

// --- xlf_set_targets ------------------------------------------------------------

function setTargets({ path, entries, write = false }) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('entries must be a non-empty array of { id, target }');
  const doc = readXlf(resolveInput(path));
  if (isSourceDoc(doc)) throw new Error(`${doc.path} is a source file; targets belong in a language file`);
  const cfg = settings(doc.path);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const done = [];
  const units = doc.units.map((u) => {
    const e = byId.get(u.id);
    if (!e) return u;
    byId.delete(u.id);
    const unit = parseUnit(setTarget(u.block, e.target, e.state ?? cfg.stateWritten, doc.eol,
      e.qualifier !== undefined ? e.qualifier : cfg.qualifierWritten));
    done.push({ id: u.id, source: decode(u.source), before: decode(u.target), after: e.target, mismatch: placeholderMismatch(unit) });
    return unit;
  });
  const missing = [...byId.keys()];
  if (write && done.length) writeXlf({ ...doc, units });
  const out = [`${write ? 'Written' : PREVIEW} ${done.length} targets in ${doc.path}`];
  for (const d of done) out.push(`    ${short(d.source, 40)}: "${short(d.before, 30)}" -> "${short(d.after, 40)}"${d.mismatch ? '  !! placeholders differ from source' : ''}`);
  if (missing.length) out.push(`ids not found, skipped: ${missing.join(', ')}`);
  return { text: out.join('\n') };
}

// --- xlf_create -----------------------------------------------------------------

const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*(_[A-Za-z]+)?$/;

/** "<App>.g.xlf" -> "<App>.g.<lang>.xlf"; any other "<name>.xlf" -> "<name>.<lang>.xlf". */
function targetPathFor(sourcePath, language) {
  const name = basename(sourcePath).replace(/\.(xlf|xliff)$/i, '');
  return join(dirname(sourcePath), `${name}.${language}.xlf`);
}

function create({
  path, languages, prefill = true, searchPath, includePackages = false,
  ambiguous = 'skip', write = false, maxItems = DEFAULT_SAMPLE,
}) {
  if (!Array.isArray(languages) || !languages.length) throw new Error('languages is required, e.g. ["sv-SE"]');
  for (const l of languages) {
    if (!LANGUAGE_RE.test(l)) throw new Error(`"${l}" is not a language code like "sv-SE"`);
  }
  const base = baseOf(path);
  const { sets } = findSets(path);
  if (!sets.length) return { text: `No source .g.xlf found under ${base}.` };
  const cfg = settings(base);
  const cache = new Map();
  const out = [write ? 'Created:' : PREVIEW];
  for (const s of sets) {
    for (const language of languages) {
      const existing = s.targets.find((t) => t.targetLanguage.toLowerCase() === language.toLowerCase());
      const file = targetPathFor(s.source.path, language);
      if (existing || existsSync(file)) {
        out.push(`\n${rel(base, existing?.path ?? file)}: ${language} already exists, skipped (xlf_sync updates it)`);
        continue;
      }
      let doc = createTargetDoc(s.source, language, cfg.stateEmpty, file);
      out.push(`\n${rel(base, file)} (${language}): ${doc.units.length} units, each with an empty target in state "${cfg.stateEmpty}"`);
      if (prefill) {
        const memory = memoryFor(cache, language, { searchPath: searchPath ?? base, includePackages });
        const r = fillFromMemory(doc, memory, { state: cfg.stateMatched, qualifier: cfg.qualifierMatched, ambiguous });
        reportFill(out, '  prefilled from existing translations', r, maxItems);
        doc = r.doc;
      }
      if (write) writeXlf(doc);
    }
  }
  return { text: out.join('\n') };
}

// --- xlf_normalize_states -------------------------------------------------------

/**
 * Replace every state outside XLIFF 1.2 with a standard one. Without a `map`, a
 * filled target becomes `filledState` and an empty one `stateEmpty`; a `map`
 * entry ({ "old": "new" }) wins for the values it names. Only the state attribute
 * changes; target text keeps its exact bytes.
 */
function normalizeStates({ path, languages, map = {}, filledState = 'translated', write = false, maxItems = DEFAULT_SAMPLE }) {
  const base = baseOf(path);
  const { sets, orphans } = findSets(path, { languages });
  const targets = [...sets.flatMap((s) => s.targets), ...orphans];
  if (!targets.length) return { text: `No target .xlf found under ${base}.` };
  const cfg = settings(base);
  for (const [from, to] of Object.entries(map)) {
    if (!isStandardState(to)) throw new Error(`map "${from}" -> "${to}": "${to}" is not an XLIFF 1.2 state`);
  }
  if (!isStandardState(filledState)) throw new Error(`filledState "${filledState}" is not an XLIFF 1.2 state`);
  const out = [write ? 'Normalised:' : PREVIEW];
  let total = 0;
  for (const t of targets) {
    const moves = {};
    const units = t.units.map((u) => {
      if (!u.hasTarget || u.state === undefined || isStandardState(u.state)) return u;
      const to = map[u.state] ?? (isEmptyTarget(u) ? cfg.stateEmpty : filledState);
      const key = `"${u.state}" -> "${to}"${isEmptyTarget(u) ? ' (empty)' : ''}`;
      moves[key] = (moves[key] || 0) + 1;
      return parseUnit(restateTarget(u.block, to));
    });
    const count = Object.values(moves).reduce((a, b) => a + b, 0);
    total += count;
    out.push(`\n${rel(base, t.path)} (${t.targetLanguage}): ${count ? `${count} states changed` : 'all states already standard'}`);
    out.push(...sample(Object.entries(moves), maxItems, ([k, v]) => `    ${k}: ${v}`));
    if (write && count) writeXlf({ ...t, units });
  }
  if (!total) return { text: 'Every target state is already an XLIFF 1.2 value.' };
  return { text: out.join('\n') };
}

// --- schemas --------------------------------------------------------------------

const PATH = { type: 'string', description: 'A repo root, an app folder, a Translations folder, or one .xlf file' };
const LANGS = { type: 'array', items: { type: 'string' }, description: 'Restrict to these target languages, e.g. ["da-DK"]' };
const WRITE = { type: 'boolean', description: 'Apply the change. Default false: preview only' };
const MAX = { type: 'integer', description: `Sample size per file in the report (default ${DEFAULT_SAMPLE})` };
const SEARCH = { type: 'string', description: 'Where to look for existing translations (default: path, or its folder for a single file). Pass the repo root to reuse translations across apps' };
const PACKAGES = { type: 'boolean', description: 'Also reuse translations shipped inside .alpackages/*.app' };
const AMBIGUOUS = { type: 'string', enum: ['skip', 'mostFrequent'], description: 'A source text with several translations: skip (default) leaves it empty and lists the candidates; mostFrequent takes a clear majority, never a tie' };
const STATES_NOTE = `States and qualifiers come from ${CONFIG_FILE} (see xlf_status) or the defaults.`;

export const TOOLS = [
  {
    name: 'xlf_status',
    description: 'Read-only health check, start here. For each source .g.xlf and every target language beside it: unit count, empty targets, filled-but-needs-review targets, state breakdown, out-of-sync counts, duplicate ids, %n placeholder mismatches, and states outside XLIFF 1.2. Also prints the effective settings and where they come from.',
    inputSchema: { type: 'object', properties: { path: PATH, languages: LANGS }, required: ['path'] },
    annotations: { readOnlyHint: true },
    handler: status,
  },
  {
    name: 'xlf_list',
    description: 'Read-only. Page through the units of one .xlf with source, target, state, state-qualifier, developer note and context. filter: "empty" (default), "needs-any" (empty or state needs-*), "placeholders" (%n differs from source), "all", or an exact state value.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'One .xlf file' },
        filter: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer', description: 'Page size (default 50)' },
      },
      required: ['path'],
    },
    annotations: { readOnlyHint: true },
    handler: list,
  },
  {
    name: 'xlf_sync',
    description: `Bring target .xlf files in line with their source .g.xlf: add units new in source (empty target), update the source text of changed units (old target kept and flagged for review, or emptied with onSourceChange "clear"), remove units gone from source, copy changed notes, collapse duplicate ids. Existing units keep their position; new ones are appended. Untouched units keep their exact bytes. ${STATES_NOTE} Preview by default.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH,
        languages: LANGS,
        onSourceChange: { type: 'string', enum: ['review', 'clear'], description: 'Overrides the setting for this call' },
        reorder: { type: 'boolean', description: 'Also put every unit in source order (default false; rewrites the whole file when the order differs)' },
        write: WRITE,
        maxItems: MAX,
      },
      required: ['path'],
    },
    handler: sync,
  },
  {
    name: 'xlf_find',
    description: 'Read-only. Look up how a source text is already translated across every target .xlf under a path (optionally inside .alpackages too), grouped by distinct translation with counts and states. match: "exact" (default; entities decoded, trimmed), "ignoreCase", "contains".',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH,
        text: { type: 'string', description: 'Source (English) text to look up' },
        language: { type: 'string', description: 'Target language, e.g. "da-DK"; all when omitted' },
        match: { type: 'string', enum: ['exact', 'ignoreCase', 'contains'] },
        includePackages: PACKAGES,
        limit: { type: 'integer' },
      },
      required: ['path', 'text'],
    },
    annotations: { readOnlyHint: true },
    handler: find,
  },
  {
    name: 'xlf_apply_matches',
    description: `Fill empty targets by reusing the translation of the identical source text from other target files of the same language (a translation-memory exact match). Only empty targets are touched. ${STATES_NOTE} Preview by default. Run xlf_sync first.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Targets to fill: a repo root, an app folder, a Translations folder, or one target .xlf' },
        languages: LANGS,
        searchPath: SEARCH,
        includePackages: PACKAGES,
        ambiguous: AMBIGUOUS,
        write: WRITE,
        maxItems: MAX,
      },
      required: ['path'],
    },
    handler: applyMatches,
  },
  {
    name: 'xlf_set_targets',
    description: `Write translations into one target .xlf by trans-unit id, for what no match could fill. Text is plain and XML-escaped here; a %n placeholder mismatch with the source is flagged. An entry may set its own state and qualifier. ${STATES_NOTE} Preview by default.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'One target .xlf file' },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              target: { type: 'string' },
              state: { type: 'string' },
              qualifier: { type: 'string', description: 'XLIFF state-qualifier; "" writes none' },
            },
            required: ['id', 'target'],
          },
        },
        write: WRITE,
      },
      required: ['path', 'entries'],
    },
    handler: setTargets,
  },
  {
    name: 'xlf_create',
    description: `Add a new language: create <App>.g.<lang>.xlf beside each source .g.xlf, with the same header (target-language set) and an empty target for every unit, then (prefill, default true) reuse existing translations of that language. A language that already has a file is skipped. ${STATES_NOTE} Preview by default.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH,
        languages: { type: 'array', items: { type: 'string' }, description: 'Languages to create, e.g. ["sv-SE", "nb-NO"]' },
        prefill: { type: 'boolean', description: 'Reuse existing translations right away (default true)' },
        searchPath: SEARCH,
        includePackages: PACKAGES,
        ambiguous: AMBIGUOUS,
        write: WRITE,
        maxItems: MAX,
      },
      required: ['path', 'languages'],
    },
    handler: create,
  },
  {
    name: 'xlf_normalize_states',
    description: 'Replace target states that are not XLIFF 1.2 values (e.g. state="") with standard ones: a filled target becomes filledState (default "translated"), an empty one the configured stateEmpty; map ({ "old": "new" }) overrides per value. Only the attribute changes, text keeps its bytes. Preview by default.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH,
        languages: LANGS,
        filledState: { type: 'string', description: 'State for a filled target with a non-standard state (default "translated")' },
        map: { type: 'object', additionalProperties: { type: 'string' }, description: 'Explicit old -> new state values, e.g. { "ai-translated": "needs-review-translation" }' },
        write: WRITE,
        maxItems: MAX,
      },
      required: ['path'],
    },
    handler: normalizeStates,
  },
];
