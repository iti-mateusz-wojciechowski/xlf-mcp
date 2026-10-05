// Tool definitions and handlers.
//
// Every write tool previews by default and reports what it would change as a
// summary plus a capped sample, never as a diff: a sync of a 7000-unit file can
// move every unit, and a diff of that costs more context than it is worth.

import { relative, resolve } from 'node:path';
import {
  readXlf, writeXlf, syncDocs, setTarget, parseUnit, decode, sourceKey, isEmptyTarget,
  isSourceDoc, STATE_EMPTY, STATE_FILLED,
} from './xlf.js';
import { findSets, findTargetDocs, findPackageDocs, resolveInput } from './workspace.js';

const DEFAULT_SAMPLE = 20;

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
    const k = u.hasTarget ? (u.state ?? '(no state)') || '(empty state)' : '(no target)';
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ');
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

function memoryDocs(path, language, { searchPath, includePackages }) {
  const docs = findTargetDocs(searchPath ?? path, language);
  if (includePackages) docs.push(...findPackageDocs(searchPath ?? path, language));
  return docs;
}

// --- xlf_status -----------------------------------------------------------------

function status({ path, languages }) {
  const base = baseOf(path);
  const { sets, orphans } = findSets(path, { languages });
  if (!sets.length && !orphans.length) return { text: `No .xlf files found under ${base}.` };
  const out = [];
  for (const s of sets) {
    out.push(`${rel(base, s.source.path)}  (${s.source.units.length} units, original="${s.source.original}")`);
    if (!s.targets.length) out.push('    no target files');
    for (const t of s.targets) {
      const { changes } = syncDocs(s.source, t);
      const empty = t.units.filter(isEmptyTarget).length;
      const sync = changes.added.length || changes.removed.length || changes.sourceChanged.length
        || changes.notesUpdated.length;
      out.push(`  ${t.targetLanguage}  ${rel(base, t.path)}`);
      out.push(`    units ${t.units.length}, empty targets ${empty}; states: ${stateCounts(t.units)}`);
      out.push(sync
        ? `    out of sync: +${changes.added.length} new, ${changes.sourceChanged.length} source changed, -${changes.removed.length} obsolete, ${changes.notesUpdated.length} notes`
        : '    in sync');
      if (changes.outOfOrder) out.push('    unit order differs from source (xlf_sync reorder: true fixes it)');
      if (changes.duplicates.length) out.push(`    duplicate ids: ${changes.duplicates.join(', ')}`);
    }
  }
  for (const o of orphans) {
    out.push(`unpaired target: ${rel(base, o.path)} (${o.targetLanguage}, original="${o.original}") -- no source file with that original beside it`);
  }
  return { text: out.join('\n') };
}

// --- xlf_list -------------------------------------------------------------------

function list({ path, filter = 'empty', offset = 0, limit = 50 }) {
  const doc = readXlf(resolveInput(path));
  const pick = {
    all: () => true,
    empty: isEmptyTarget,
    'needs-any': (u) => isEmptyTarget(u) || (u.state ?? '').startsWith('needs-'),
  }[filter] ?? ((u) => u.state === filter);
  const hits = doc.units.filter(pick);
  const page = hits.slice(offset, offset + limit);
  const lines = [`${doc.path} (${doc.targetLanguage}): ${hits.length} units match "${filter}", showing ${offset + 1}-${offset + page.length}`];
  for (const u of page) {
    lines.push(`- id: ${u.id}`);
    lines.push(`  source: ${decode(u.source)}`);
    if (!isSourceDoc(doc)) lines.push(`  target: ${decode(u.target)}${u.state !== undefined ? `  [state="${u.state}"]` : ''}`);
    if (u.devNote?.text?.trim()) lines.push(`  developer note: ${decode(u.devNote.text)}`);
    if (u.genNote?.text?.trim()) lines.push(`  context: ${decode(u.genNote.text)}`);
  }
  if (offset + page.length < hits.length) lines.push(`… pass offset: ${offset + page.length} for the next page`);
  return { text: lines.join('\n') };
}

// --- xlf_sync -------------------------------------------------------------------

function sync({ path, languages, write = false, maxItems = DEFAULT_SAMPLE, stateEmpty = STATE_EMPTY, reorder = false }) {
  const base = baseOf(path);
  const { sets, orphans } = findSets(path, { languages });
  if (!sets.length) return { text: `No source .g.xlf found under ${base}.` };
  const out = [write ? 'Synchronised:' : `Preview only -- nothing written (pass write: true to apply).`];
  let touched = 0;
  for (const s of sets) {
    for (const t of s.targets) {
      const { doc, changes } = syncDocs(s.source, t, { stateEmpty, reorder });
      const any = changes.added.length || changes.removed.length || changes.sourceChanged.length
        || changes.notesUpdated.length || changes.reordered;
      out.push(`\n${rel(base, t.path)} (${t.targetLanguage}): ${any ? '' : 'already in sync'}`.trimEnd());
      if (!any) continue;
      touched++;
      out.push(`  +${changes.added.length} new, ${changes.sourceChanged.length} source changed (target cleared), -${changes.removed.length} obsolete, ${changes.notesUpdated.length} notes updated${changes.reordered ? ', reordered to source order' : ''}`);
      if (changes.outOfOrder && !reorder) out.push('  unit order differs from source; kept (pass reorder: true to fix)');
      out.push(...sample(changes.added, maxItems, (c) => `    + ${c.id}: ${short(c.source)}`));
      out.push(...sample(changes.sourceChanged, maxItems, (c) => `    ~ ${c.id}: "${short(c.from, 40)}" -> "${short(c.to, 40)}" (drops "${short(c.droppedTarget, 40)}")`));
      out.push(...sample(changes.removed, maxItems, (c) => `    - ${c.id}: ${short(c.source)}`));
      if (changes.duplicates.length) out.push(`  duplicate ids kept once: ${changes.duplicates.join(', ')}`);
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
  if (!touched) out[0] = 'Everything already in sync.';
  return { text: out.join('\n') };
}

// --- xlf_find -------------------------------------------------------------------

function find({ path, text, language, match = 'exact', includePackages = false, limit = 20 }) {
  if (!text) throw new Error('text is required');
  const base = baseOf(path);
  const docs = memoryDocs(path, language, { includePackages });
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
  path, languages, searchPath, includePackages = false, state = STATE_FILLED,
  ambiguous = 'skip', write = false, maxItems = DEFAULT_SAMPLE,
}) {
  const base = baseOf(path);
  const { sets, orphans } = findSets(path, { languages });
  const targets = [...sets.flatMap((s) => s.targets), ...orphans];
  if (!targets.length) return { text: `No target .xlf found under ${base}.` };
  const memories = new Map();
  const out = [write ? 'Applied:' : 'Preview only -- nothing written (pass write: true to apply).'];
  for (const t of targets) {
    const lang = t.targetLanguage.toLowerCase();
    if (!memories.has(lang)) {
      memories.set(lang, buildMemory(memoryDocs(path, lang, { searchPath: searchPath ?? base, includePackages })));
    }
    const memory = memories.get(lang);
    const filled = [];
    const conflicts = [];
    let unmatched = 0;
    const units = t.units.map((u) => {
      if (!isEmptyTarget(u)) return u;
      const byText = memory.get(sourceKey(u.source));
      if (!byText) { unmatched++; return u; }
      const options = [...byText.values()].sort((a, b) => b.count - a.count);
      let chosen = options[0];
      if (options.length > 1) {
        const tie = options[0].count === options[1].count;
        if (ambiguous === 'skip' || tie) {
          conflicts.push({ id: u.id, source: decode(u.source), options });
          return u;
        }
        chosen = options[0];
      }
      filled.push({ id: u.id, source: decode(u.source), target: chosen.text });
      return parseUnit(setTarget(u.block, chosen.text, state, t.eol));
    });
    out.push(`\n${rel(base, t.path)} (${t.targetLanguage}): ${filled.length} filled, ${conflicts.length} ambiguous, ${unmatched} with no match`);
    out.push(...sample(filled, maxItems, (f) => `    = ${short(f.source, 40)} -> ${short(f.target, 40)}`));
    out.push(...sample(conflicts, maxItems, (c) => `    ? ${c.id}: ${short(c.source, 40)} -> ${c.options.map((o) => `"${short(o.text, 30)}" x${o.count}`).join(' | ')}`));
    if (write && filled.length) writeXlf({ ...t, units });
  }
  return { text: out.join('\n') };
}

// --- xlf_set_targets ------------------------------------------------------------

function setTargets({ path, entries, state = STATE_FILLED, write = false }) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('entries must be a non-empty array of { id, target }');
  const doc = readXlf(resolveInput(path));
  if (isSourceDoc(doc)) throw new Error(`${doc.path} is a source file; targets belong in a language file`);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const done = [];
  const units = doc.units.map((u) => {
    const e = byId.get(u.id);
    if (!e) return u;
    byId.delete(u.id);
    done.push({ id: u.id, source: decode(u.source), before: decode(u.target), after: e.target });
    return parseUnit(setTarget(u.block, e.target, e.state ?? state, doc.eol));
  });
  const missing = [...byId.keys()];
  if (write && done.length) writeXlf({ ...doc, units });
  const out = [`${write ? 'Written' : 'Preview only -- nothing written (pass write: true to apply)'}: ${done.length} targets in ${doc.path}`];
  for (const d of done) out.push(`    ${short(d.source, 40)}: "${short(d.before, 30)}" -> "${short(d.after, 40)}"`);
  if (missing.length) out.push(`ids not found, skipped: ${missing.join(', ')}`);
  return { text: out.join('\n') };
}

// --- schemas --------------------------------------------------------------------

const PATH = { type: 'string', description: 'A repo root, an app folder, a Translations folder, or one .xlf file' };
const LANGS = { type: 'array', items: { type: 'string' }, description: 'Restrict to these target languages, e.g. ["da-DK"]' };
const WRITE = { type: 'boolean', description: 'Apply the change. Default false: preview only' };
const MAX = { type: 'integer', description: `Sample size per file in the report (default ${DEFAULT_SAMPLE})` };

export const TOOLS = [
  {
    name: 'xlf_status',
    description: 'Per source .g.xlf and each target language beside it: unit count, empty targets, state breakdown, and whether the target is out of sync (new, changed, obsolete, notes, order). Read-only. Start here.',
    inputSchema: { type: 'object', properties: { path: PATH, languages: LANGS }, required: ['path'] },
    annotations: { readOnlyHint: true },
    handler: status,
  },
  {
    name: 'xlf_list',
    description: 'List the trans-units of one .xlf file with source, target, state, developer note and context, paged. filter: "empty" (default), "needs-any" (empty or state needs-*), "all", or an exact state value.',
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
    description: 'Synchronise target .xlf files with their source .g.xlf (XLF Editor rules): add new units with an empty needs-translation target, clear the target of units whose source text changed, remove obsolete units, copy changed notes. Existing units keep their place and new ones are appended; reorder: true puts all in source order. Untouched units keep their exact bytes. Preview by default.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH,
        languages: LANGS,
        reorder: { type: 'boolean', description: 'Put every unit in source order (default false: rewrites the whole file when the order differs)' },
        stateEmpty: { type: 'string', description: `State given to new or cleared targets (default "${STATE_EMPTY}")` },
        write: WRITE,
        maxItems: MAX,
      },
      required: ['path'],
    },
    handler: sync,
  },
  {
    name: 'xlf_find',
    description: 'Search existing translations by source text across every target .xlf under a path (optionally also inside .alpackages .app files), grouped by distinct translation with counts. match: "exact" (default, entity-decoded and trimmed), "ignoreCase", "contains".',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH,
        text: { type: 'string', description: 'Source (English) text to look up' },
        language: { type: 'string', description: 'Target language, e.g. "da-DK"; all when omitted' },
        match: { type: 'string', enum: ['exact', 'ignoreCase', 'contains'] },
        includePackages: { type: 'boolean', description: 'Also search translations embedded in .alpackages/*.app' },
        limit: { type: 'integer' },
      },
      required: ['path', 'text'],
    },
    annotations: { readOnlyHint: true },
    handler: find,
  },
  {
    name: 'xlf_apply_matches',
    description: 'Fill empty targets from translations of the identical source text found in other target files of the same language. One distinct translation is applied; several are reported as ambiguous and skipped (ambiguous: "mostFrequent" takes a clear majority). Preview by default. Run xlf_sync first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Targets to fill: a repo root, an app folder, a Translations folder, or one target .xlf' },
        languages: LANGS,
        searchPath: { type: 'string', description: 'Where to look for existing translations (default: same as path, or its folder for a single file). Pass the repo root to match across apps' },
        includePackages: { type: 'boolean', description: 'Also match against translations in .alpackages/*.app' },
        state: { type: 'string', description: `State for filled targets (default "${STATE_FILLED}")` },
        ambiguous: { type: 'string', enum: ['skip', 'mostFrequent'] },
        write: WRITE,
        maxItems: MAX,
      },
      required: ['path'],
    },
    handler: applyMatches,
  },
  {
    name: 'xlf_set_targets',
    description: 'Write given translations into one target .xlf by trans-unit id (for units no match could fill). Text is plain; it is XML-escaped here. Preview by default.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'One target .xlf file' },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, target: { type: 'string' }, state: { type: 'string' } },
            required: ['id', 'target'],
          },
        },
        state: { type: 'string', description: `Default state for written targets (default "${STATE_FILLED}")` },
        write: WRITE,
      },
      required: ['path', 'entries'],
    },
    handler: setTargets,
  },
];
