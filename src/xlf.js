// XLIFF 1.2 reading and writing, as text surgery rather than a DOM round trip.
//
// Business Central's generated XLIFF is extremely regular: one <group id="body">
// holding flat <trans-unit> blocks. Treating each block as a string, and only
// rewriting the element that actually changes, keeps every untouched byte as it
// was -- BOM, line endings, indentation, attribute order, self-closing notes. A
// DOM parse and re-serialise reformats the whole file, so a one-unit change would
// show up as a thousand-line diff.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const UNIT_RE = /<trans-unit\b[^>]*>[\s\S]*?<\/trans-unit>/g;
const ID_RE = /^<trans-unit\b[^>]*?\bid="([^"]*)"/;
const SOURCE_RE = /<source\b[^>]*?(?:\/>|>([\s\S]*?)<\/source>)/;
const TARGET_RE = /<target\b([^>]*?)(?:\/>|>([\s\S]*?)<\/target>)/;
const STATE_RE = /\bstate="([^"]*)"/;
const QUALIFIER_RE = /\bstate-qualifier="([^"]*)"/;
const BOM = '﻿';

/** XLIFF 1.2 `state` values; anything else must start with "x-". */
export const XLIFF_STATES = [
  'new', 'needs-translation', 'needs-adaptation', 'needs-l10n',
  'needs-review-translation', 'needs-review-adaptation', 'needs-review-l10n',
  'translated', 'signed-off', 'final',
];

export function isStandardState(state) {
  return XLIFF_STATES.includes(state) || /^x-.+/.test(state ?? '');
}

/** Decode the XML entities an XLIFF text node can carry. */
export function decode(text) {
  if (!text) return '';
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    return String.fromCodePoint(parseInt(k.slice(1), 10));
  });
}

/** Encode for a text node. Quotes need no escaping in element content, so they stay literal. */
export function encode(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Comparison key for source texts: decoded and trimmed. */
export function sourceKey(text) {
  return decode(text).trim();
}

/** BC placeholders (%1, %2, …) in a text, sorted, for comparing source and target. */
export function placeholders(text) {
  return (decode(text).match(/%\d+/g) || []).sort().join(' ');
}

function noteRe(from) {
  return new RegExp(`<note\\b[^>]*?\\bfrom="${from}"[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/note>)`);
}
const DEV_NOTE_RE = noteRe('Developer');
const GEN_NOTE_RE = noteRe('Xliff Generator');

/** Parse one <trans-unit> block into the fields the tools work with. */
export function parseUnit(block) {
  const id = (block.match(ID_RE) || [])[1];
  const src = block.match(SOURCE_RE);
  const tgt = block.match(TARGET_RE);
  const dev = block.match(DEV_NOTE_RE);
  const gen = block.match(GEN_NOTE_RE);
  const attrs = tgt ? tgt[1] || '' : '';
  return {
    id,
    block,
    source: src ? src[1] ?? '' : '',
    hasTarget: !!tgt,
    target: tgt ? tgt[2] ?? '' : '',
    state: tgt ? (attrs.match(STATE_RE) || [])[1] : undefined,
    qualifier: tgt ? (attrs.match(QUALIFIER_RE) || [])[1] : undefined,
    devNote: dev ? { element: dev[0], text: dev[1] ?? '' } : undefined,
    genNote: gen ? { element: gen[0], text: gen[1] ?? '' } : undefined,
  };
}

/**
 * Split a file into the text around the units and the units themselves.
 * `prefix + units.map(u => u.block).join(separator) + suffix` rebuilds it exactly
 * whenever the inter-unit whitespace is uniform, which it is for generated files.
 */
export function parseXlf(text, path = '<memory>') {
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const fileTag = (body.match(/<file\b[^>]*>/) || [''])[0];
  const attr = (name) => ((fileTag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1]);

  const matches = [...body.matchAll(UNIT_RE)];
  const units = matches.map((m) => parseUnit(m[0]));
  let prefix;
  let suffix;
  let separator;
  if (matches.length) {
    const first = matches[0];
    const last = matches[matches.length - 1];
    prefix = body.slice(0, first.index);
    suffix = body.slice(last.index + last[0].length);
    separator = matches.length > 1
      ? body.slice(first.index + first[0].length, matches[1].index)
      : eol + (prefix.match(/[ \t]*$/) || [''])[0];
  } else {
    const anchor = body.search(/<\/group>|<\/body>/);
    if (anchor < 0) throw new Error(`${path}: no <group> or <body> to hold trans-units`);
    const indent = (body.slice(0, anchor).match(/[ \t]*$/) || [''])[0];
    prefix = body.slice(0, anchor - indent.length) + indent + '  ';
    suffix = eol + indent + body.slice(anchor);
    separator = eol + indent + '  ';
  }
  for (const u of units) {
    if (!u.id) throw new Error(`${path}: a <trans-unit> has no id attribute`);
  }
  return {
    path,
    bom,
    eol,
    prefix,
    suffix,
    separator,
    sourceLanguage: attr('source-language'),
    targetLanguage: attr('target-language'),
    original: attr('original'),
    units,
  };
}

export function readXlf(path) {
  return parseXlf(readFileSync(path, 'utf8'), path);
}

export function serializeXlf(doc) {
  const text = doc.units.length
    ? doc.prefix + doc.units.map((u) => u.block).join(doc.separator) + doc.suffix
    : doc.prefix.replace(/\s+$/, '') + doc.suffix;
  return (doc.bom ? BOM : '') + text;
}

/** Write via a temp file and rename, so a crash never leaves half a file. */
export function writeXlf(doc, path = doc.path) {
  const tmp = `${path}.xlf-mcp.tmp`;
  writeFileSync(tmp, serializeXlf(doc), 'utf8');
  renameSync(tmp, path);
}

/** A source file's own units carry no translation: target-language equals source-language. */
export function isSourceDoc(doc) {
  return !doc.targetLanguage || doc.targetLanguage === doc.sourceLanguage;
}

export function isEmptyTarget(u) {
  return !u.hasTarget || decode(u.target).trim() === '';
}

function lineIndent(block, index) {
  const lineStart = block.lastIndexOf('\n', index - 1) + 1;
  return (block.slice(lineStart, index).match(/^[ \t]*/) || [''])[0];
}

function targetElement(rawText, state, qualifier) {
  const q = qualifier ? ` state-qualifier="${qualifier}"` : '';
  return `<target state="${state}"${q}>${rawText}</target>`;
}

/**
 * Return the block with its <target> replaced, or inserted after </source> when it
 * has none. `qualifier` (XLIFF state-qualifier) is written only when given.
 */
export function setTarget(block, text, state, eol, qualifier) {
  const element = targetElement(encode(text), state, qualifier);
  const tgt = block.match(TARGET_RE);
  if (tgt) {
    return block.slice(0, tgt.index) + element + block.slice(tgt.index + tgt[0].length);
  }
  const src = block.match(SOURCE_RE);
  if (!src) throw new Error('trans-unit has no <source>');
  const at = src.index + src[0].length;
  return block.slice(0, at) + eol + lineIndent(block, src.index) + element + block.slice(at);
}

/** Change only the state of an existing target; its text keeps its exact bytes. */
export function restateTarget(block, state) {
  const tgt = block.match(TARGET_RE);
  if (!tgt) return block;
  return block.slice(0, tgt.index) + targetElement(tgt[2] ?? '', state) + block.slice(tgt.index + tgt[0].length);
}

export function setSource(block, rawSource) {
  const src = block.match(SOURCE_RE);
  if (!src) throw new Error('trans-unit has no <source>');
  const open = src[0].match(/^<source\b[^>]*?(?=\/?>)/)[0];
  return block.slice(0, src.index) + `${open}>${rawSource}</source>` + block.slice(src.index + src[0].length);
}

function setNote(block, re, element) {
  const m = block.match(re);
  if (!m) return block;
  return block.slice(0, m.index) + element + block.slice(m.index + m[0].length);
}

/** Drop any <target> line from a block taken from the source file. */
function stripTarget(block) {
  return block.replace(/\r?\n[ \t]*<target\b[^>]*?(?:\/>|>[\s\S]*?<\/target>)/, '')
    .replace(/<target\b[^>]*?(?:\/>|>[\s\S]*?<\/target>)/, '');
}

function withEol(block, eol) {
  return block.replace(/\r?\n/g, eol);
}

/**
 * Bring a target document in line with its source:
 *   new in source       -> appended, with an empty target in `stateEmpty`
 *   source text changed -> source replaced; the old target is kept for the
 *                          translator and flagged `stateReview` (onSourceChange
 *                          "review"), or emptied into `stateEmpty` ("clear")
 *   gone from source    -> removed
 *   note changed        -> copied from source (Developer, and Xliff Generator)
 * Ordering (`order`):
 *   "auto"   existing units stay exactly where they are; new ones are inserted
 *            where the file's own order puts them -- by id when the file is
 *            sorted by id, by source position when it follows the source, at
 *            the end when it follows neither
 *   "id"     every unit sorted by id
 *   "source" every unit in source order
 * Returns the new doc and a change log; `changes.order` is the detected order.
 */
export function syncDocs(source, target, {
  stateEmpty = 'needs-translation', stateReview = 'needs-review-translation',
  onSourceChange = 'review', order = 'auto',
} = {}) {
  if (!['auto', 'id', 'source'].includes(order)) throw new Error(`order must be "auto", "id" or "source", not "${order}"`);
  const changes = { added: [], sourceChanged: [], removed: [], notesUpdated: [], duplicates: [], reordered: false };
  const byId = new Map();
  for (const u of target.units) {
    const first = byId.get(u.id);
    if (!first) {
      byId.set(u.id, u);
      continue;
    }
    changes.duplicates.push(u.id);
    if (isEmptyTarget(first) && !isEmptyTarget(u)) byId.set(u.id, u);
  }
  const sourceIds = new Set(source.units.map((u) => u.id));
  const synced = new Map();
  const added = [];
  for (const s of source.units) {
    const t = byId.get(s.id);
    if (!t) {
      const unit = parseUnit(setTarget(withEol(stripTarget(s.block), target.eol), '', stateEmpty, target.eol));
      added.push(unit);
      synced.set(s.id, unit);
      changes.added.push({ id: s.id, source: decode(s.source) });
      continue;
    }
    let block = t.block;
    if (sourceKey(s.source) !== sourceKey(t.source)) {
      block = setSource(block, s.source);
      const keep = onSourceChange !== 'clear' && !isEmptyTarget(t);
      block = keep ? restateTarget(block, stateReview) : setTarget(block, '', stateEmpty, target.eol);
      changes.sourceChanged.push({
        id: s.id, from: decode(t.source), to: decode(s.source), target: decode(t.target), kept: keep,
      });
    }
    let notes = false;
    for (const [key, re] of [['devNote', DEV_NOTE_RE], ['genNote', GEN_NOTE_RE]]) {
      const sn = s[key];
      const tn = t[key];
      if (sn && tn && decode(sn.text).trim() !== decode(tn.text).trim()) {
        block = setNote(block, re, sn.element);
        notes = true;
      }
    }
    if (notes) changes.notesUpdated.push(s.id);
    synced.set(s.id, block === t.block ? t : parseUnit(block));
  }
  for (const t of byId.values()) {
    if (!sourceIds.has(t.id)) changes.removed.push({ id: t.id, source: decode(t.source), target: decode(t.target) });
  }
  const keptOrder = [...new Set(target.units.filter((u) => sourceIds.has(u.id)).map((u) => u.id))];
  const position = new Map(source.units.map((u, i) => [u.id, i]));
  const bySource = (a, b) => position.get(a) - position.get(b);
  changes.order = detectOrder(target.units.map((u) => u.id).filter((id) => position.has(id)), bySource);
  const mode = order === 'auto' ? changes.order : order;
  const cmp = mode === 'id' ? compareIds : mode === 'source' ? bySource : undefined;
  let ids;
  if (order === 'auto') {
    const fresh = added.map((u) => u.id);
    ids = cmp ? merge(keptOrder, fresh.sort(cmp), cmp) : [...keptOrder, ...fresh];
  } else {
    ids = source.units.map((u) => u.id).sort(cmp);
  }
  const keptAfter = ids.filter((x) => byId.has(x));
  changes.reordered = order !== 'auto' && keptOrder.some((id, i) => id !== keptAfter[i]);
  changes.duplicates = [...new Set(changes.duplicates)];
  return { doc: { ...target, units: ids.map((id) => synced.get(id)) }, changes };
}

/** Plain string order on trans-unit ids, the order BC language files are commonly kept in. */
export function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function inversions(ids, cmp) {
  let n = 0;
  for (let i = 1; i < ids.length; i++) if (cmp(ids[i - 1], ids[i]) > 0) n++;
  return n;
}

/**
 * Which order a file's units follow: "id" (sorted by id), "source" (the source
 * file's order) or "none". A handful of stray units -- left by an earlier
 * append -- still counts as the order the rest of the file follows.
 */
export function detectOrder(ids, bySource) {
  if (ids.length < 2) return 'source';
  const tolerance = Math.max(2, Math.floor(ids.length / 100));
  const sorted = inversions(ids, compareIds);
  const src = inversions(ids, bySource);
  if (src <= tolerance && src <= sorted) return 'source';
  if (sorted <= tolerance) return 'id';
  return 'none';
}

/** Merge new ids into an existing sequence without moving any existing one. */
function merge(existing, fresh, cmp) {
  const out = [];
  let j = 0;
  for (const id of existing) {
    while (j < fresh.length && cmp(fresh[j], id) < 0) out.push(fresh[j++]);
    out.push(id);
  }
  while (j < fresh.length) out.push(fresh[j++]);
  return out;
}

/**
 * A new target document for `language`, built from the source: the same header
 * with target-language set, and every unit given an empty target in `stateEmpty`.
 */
export function createTargetDoc(source, language, stateEmpty, path) {
  const fileTag = /<file\b[^>]*>/;
  const tag = source.prefix.match(fileTag)?.[0];
  if (!tag) throw new Error(`${source.path}: no <file> element`);
  const newTag = /\btarget-language="[^"]*"/.test(tag)
    ? tag.replace(/\btarget-language="[^"]*"/, `target-language="${language}"`)
    : tag.replace(/<file\b/, `<file target-language="${language}"`);
  const units = source.units.map((u) => parseUnit(setTarget(stripTarget(u.block), '', stateEmpty, source.eol)));
  return { ...source, path, prefix: source.prefix.replace(fileTag, newTag), targetLanguage: language, units };
}
