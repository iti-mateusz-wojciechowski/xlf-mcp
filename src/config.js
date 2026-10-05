// How targets are labelled, and where that choice comes from.
//
// Resolved per call, first hit wins, key by key:
//   1. the tool call's own argument
//   2. xlf-mcp.json, the nearest one walking up from the path
//   3. the defaults below
//
// An empty string is a real value (it writes state=""), so presence is tested
// with `in` / `!== undefined`, never with truthiness. A qualifier set to "" or
// null is not written at all.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const CONFIG_FILE = 'xlf-mcp.json';

export const DEFAULTS = {
  // Target with no text yet: a unit new in source, or one cleared by a source change.
  stateEmpty: 'needs-translation',
  // Target whose source changed while its old text was kept for the translator.
  stateReview: 'needs-review-translation',
  // Target filled from an existing translation of the identical source text.
  stateMatched: 'needs-review-translation',
  // XLIFF state-qualifier, off by default: valid, but rarely used in BC apps.
  qualifierMatched: null,
  // Target written by xlf_set_targets (an agent's or a person's translation).
  stateWritten: 'needs-review-translation',
  qualifierWritten: null,
  // What a source change does to the existing target: "review" keeps it, "clear" empties it.
  onSourceChange: 'review',
};

function findConfig(path) {
  let dir = resolve(path);
  if (existsSync(dir) && statSync(dir).isFile()) dir = dirname(dir);
  for (;;) {
    const file = join(dir, CONFIG_FILE);
    if (existsSync(file)) return file;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** Effective settings for a path: { key: { value, from } } for every DEFAULTS key. */
export function resolveConfig(path, overrides = {}) {
  const file = findConfig(path);
  let json = {};
  if (file) {
    try {
      json = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      throw new Error(`${file}: ${err.message}`);
    }
    const unknown = Object.keys(json).filter((k) => !(k in DEFAULTS));
    if (unknown.length) throw new Error(`${file}: unknown setting(s) ${unknown.join(', ')}; valid: ${Object.keys(DEFAULTS).join(', ')}`);
    if (json.onSourceChange !== undefined && !['review', 'clear'].includes(json.onSourceChange)) {
      throw new Error(`${file}: onSourceChange must be "review" or "clear"`);
    }
  }
  const result = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (overrides[key] !== undefined) result[key] = { value: overrides[key], from: 'tool argument' };
    else if (key in json) result[key] = { value: json[key], from: file };
    else result[key] = { value, from: 'default' };
  }
  return result;
}

/** Plain { key: value } view of resolveConfig. */
export function settings(path, overrides) {
  return Object.fromEntries(Object.entries(resolveConfig(path, overrides)).map(([k, v]) => [k, v.value]));
}

export function describeConfig(config) {
  const fromFile = Object.values(config).find((v) => v.from !== 'default' && v.from !== 'tool argument')?.from;
  const mark = { default: '', 'tool argument': ' (argument)' };
  const show = (k) => `${k}=${JSON.stringify(config[k].value)}${mark[config[k].from] ?? '*'}`;
  return `settings: ${Object.keys(config).map(show).join(', ')}`
    + (fromFile ? `\n  (* from ${fromFile})` : `\n  (no ${CONFIG_FILE} found; defaults apply)`);
}
