import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseXlf, serializeXlf, syncDocs, readXlf } from '../src/xlf.js';
import { TOOLS } from '../src/tools.js';

const tool = (name) => TOOLS.find((t) => t.name === name).handler;

function unit(id, source, { target, state = '', dev = '', gen = `Context ${id}` } = {}) {
  const lines = [
    `        <trans-unit id="${id}" size-unit="char" translate="yes" xml:space="preserve">`,
    `          <source>${source}</source>`,
  ];
  if (target !== undefined) lines.push(`          <target state="${state}">${target}</target>`);
  lines.push(
    dev ? `          <note from="Developer" annotates="general" priority="2">${dev}</note>`
      : '          <note from="Developer" annotates="general" priority="2" />',
    `          <note from="Xliff Generator" annotates="general" priority="3">${gen}</note>`,
    '        </trans-unit>',
  );
  return lines.join('\r\n');
}

function file(lang, units, { bom = false } = {}) {
  const text = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">',
    `  <file datatype="xml" source-language="en-US" target-language="${lang}" original="TestApp">`,
    '    <body>',
    '      <group id="body">',
    ...units,
    '      </group>',
    '    </body>',
    '  </file>',
    '</xliff>',
    '',
  ].join('\r\n');
  return (bom ? '﻿' : '') + text;
}

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'xlf-mcp-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return root;
}

test('parse + serialize round-trips byte for byte, BOM and CRLF included', () => {
  const text = file('da-DK', [unit('A', 'One', { target: 'En' }), unit('B', 'Two &amp; three', { target: 'To' })], { bom: true });
  assert.equal(serializeXlf(parseXlf(text)), text);
});

test('sync adds, clears, removes, copies notes and reorders; untouched units keep their bytes', () => {
  const source = parseXlf(file('en-US', [
    unit('A', 'Alpha'),
    unit('N', 'New one'),
    unit('B', 'Beta changed'),
    unit('C', 'Gamma', { dev: '%1 - new note' }),
  ]));
  const kept = unit('A', 'Alpha', { target: 'Alfa' });
  const target = parseXlf(file('da-DK', [
    unit('C', 'Gamma', { target: 'Gamma DK', dev: '%1 - old note' }),
    kept,
    unit('B', 'Beta', { target: 'Beta DK' }),
    unit('X', 'Obsolete', { target: 'Forældet' }),
  ]));
  const { doc, changes } = syncDocs(source, target, { reorder: true });
  assert.deepEqual(doc.units.map((u) => u.id), ['A', 'N', 'B', 'C']);
  assert.deepEqual(changes.added.map((c) => c.id), ['N']);
  assert.deepEqual(changes.sourceChanged.map((c) => c.id), ['B']);
  assert.deepEqual(changes.removed.map((c) => c.id), ['X']);
  assert.deepEqual(changes.notesUpdated, ['C']);
  assert.equal(changes.reordered, true);

  assert.equal(doc.units[0].block, kept.trimStart());
  assert.match(doc.units[1].block, /<\/source>\r\n          <target state="needs-translation"><\/target>\r\n/);
  assert.match(doc.units[2].block, /<source>Beta changed<\/source>\r\n          <target state="needs-translation"><\/target>/);
  assert.match(doc.units[3].block, /%1 - new note/);
  assert.match(doc.units[3].block, /Gamma DK/);
  assert.doesNotMatch(serializeXlf(doc).replace(/\r\n/g, ''), /\n/);
});

test('sync without reorder keeps existing order and appends new units', () => {
  const source = parseXlf(file('en-US', [unit('A', 'Alpha'), unit('N', 'New'), unit('B', 'Beta')]));
  const target = parseXlf(file('da-DK', [unit('B', 'Beta', { target: 'B' }), unit('A', 'Alpha', { target: 'A' })]));
  const { doc, changes } = syncDocs(source, target);
  assert.deepEqual(doc.units.map((u) => u.id), ['B', 'A', 'N']);
  assert.equal(changes.outOfOrder, true);
  assert.equal(changes.reordered, false);
});

test('sync treats entity and whitespace differences in source as unchanged', () => {
  const source = parseXlf(file('en-US', [unit('A', 'Say &quot;hi&quot; ')]));
  const target = parseXlf(file('da-DK', [unit('A', 'Say "hi"', { target: 'Sig "hej"' })]));
  const { changes } = syncDocs(source, target);
  assert.equal(changes.sourceChanged.length, 0);
});

test('xlf_sync previews without writing, then writes with write:true', () => {
  const root = workspace({
    'App/Translations/TestApp.g.xlf': file('en-US', [unit('A', 'Alpha'), unit('B', 'Beta')], { bom: true }),
    'App/Translations/TestApp.g.da-DK.xlf': file('da-DK', [unit('A', 'Alpha', { target: 'Alfa' })]),
  });
  const targetPath = join(root, 'App/Translations/TestApp.g.da-DK.xlf');
  const before = readFileSync(targetPath, 'utf8');
  const preview = tool('xlf_sync')({ path: root });
  assert.match(preview.text, /Preview only/);
  assert.match(preview.text, /\+1 new/);
  assert.equal(readFileSync(targetPath, 'utf8'), before);

  tool('xlf_sync')({ path: root, write: true });
  const after = readXlf(targetPath);
  assert.deepEqual(after.units.map((u) => u.id), ['A', 'B']);
  assert.equal(after.bom, false, 'target keeps its own BOM setting, not the source one');
  assert.match(tool('xlf_status')({ path: root }).text, /in sync/);
});

test('xlf_apply_matches fills a unique match, skips ambiguity, leaves filled targets alone', () => {
  const root = workspace({
    'App1/Translations/TestApp.g.xlf': file('en-US', [unit('A', 'Customer'), unit('B', 'Order'), unit('C', 'Item'), unit('D', 'Unknown')]),
    'App1/Translations/TestApp.g.da-DK.xlf': file('da-DK', [
      unit('A', 'Customer', { target: '', state: 'needs-translation' }),
      unit('B', 'Order', { target: '', state: 'needs-translation' }),
      unit('C', 'Item', { target: 'Vare' }),
      unit('D', 'Unknown', { target: '', state: 'needs-translation' }),
    ]),
    'App2/Translations/Other.g.da-DK.xlf': file('da-DK', [
      unit('X1', 'Customer', { target: 'Debitor &amp; "kunde"' }),
      unit('X2', 'Order', { target: 'Ordre' }),
      unit('X3', 'Order', { target: 'Bestilling' }),
      unit('X4', 'Item', { target: 'Artikel' }),
    ]),
  });
  const target = join(root, 'App1/Translations/TestApp.g.da-DK.xlf');
  const out = tool('xlf_apply_matches')({ path: join(root, 'App1'), searchPath: root, write: true });
  assert.match(out.text, /1 filled, 1 ambiguous, 1 with no match/);
  const doc = readXlf(target);
  const get = (id) => doc.units.find((u) => u.id === id);
  assert.match(get('A').block, /<target state="needs-review-translation">Debitor &amp; "kunde"<\/target>/);
  assert.equal(get('B').target, '');
  assert.equal(get('C').target, 'Vare');
});

test('xlf_apply_matches mostFrequent takes a clear majority, not a tie', () => {
  const root = workspace({
    'A/TestApp.g.da-DK.xlf': file('da-DK', [unit('A', 'Order', { target: '', state: 'needs-translation' })]),
    'B/X.g.da-DK.xlf': file('da-DK', [
      unit('1', 'Order', { target: 'Ordre' }), unit('2', 'Order', { target: 'Ordre' }), unit('3', 'Order', { target: 'Bestilling' }),
    ]),
  });
  tool('xlf_apply_matches')({ path: join(root, 'A'), searchPath: root, ambiguous: 'mostFrequent', write: true });
  assert.equal(readXlf(join(root, 'A/TestApp.g.da-DK.xlf')).units[0].target, 'Ordre');
});

test('xlf_set_targets escapes markup and keeps quotes literal', () => {
  const root = workspace({ 'T.g.da-DK.xlf': file('da-DK', [unit('A', 'A &lt; B', { target: '', state: 'needs-translation' })]) });
  const path = join(root, 'T.g.da-DK.xlf');
  tool('xlf_set_targets')({ path, entries: [{ id: 'A', target: 'A < B "x" & y' }], write: true });
  assert.match(readFileSync(path, 'utf8'), /<target state="needs-review-translation">A &lt; B "x" &amp; y<\/target>/);
});

test('server answers tools/list over stdio', async () => {
  const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] });
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const lines = [];
  child.stdout.setEncoding('utf8');
  const got = new Promise((resolveList, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        lines.push(msg);
        if (msg.id === 2) resolveList(msg);
      }
    });
    setTimeout(() => reject(new Error('timeout')), 10_000);
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await got;
  child.kill();
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(),
    ['xlf_apply_matches', 'xlf_find', 'xlf_list', 'xlf_set_targets', 'xlf_status', 'xlf_sync']);
});
