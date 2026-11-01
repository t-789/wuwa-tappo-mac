import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { assetDirectory, root, sourceFiles } from './frontend-context.mjs';
import { MAC_CHEST_FALLBACK_MARK, macChestFallbackHelper, patchMacChestCountdownFallback } from '../scripts/patch-frontend.mjs';

const clock = 'function is(){return 0}function No(e){if(e==null)return 0;const t=Math.floor(Number(e));return!Number.isFinite(t)||t<=0?0:t}function co(e,t=is()){const o=No(e);return o<=0?0:Math.max(0,o-t)}';
const formatters = 'function rc(e){const t=Math.floor(e/60),o=e%60;return(t<10?"0"+t:t)+":"+(o<10?"0"+o:o)}function ic(e){return Math.max(0,Math.ceil(e/1e3))}function ac(e,t){return e<=0||t<=0?0:Math.min(1,Math.max(0,e/t))}';
const projection = 'function Vn(){const e=is(),t=performance.now();Nt.value=kr===null?co(R.userInfo?.left_treasure_chest,e):Math.max(0,kr-t),Ht.value=Cr===null?co(R.userInfo?.right_treasure_chest,e):Math.max(0,Cr-t),Yr("left",Nt.value)}';
const fixture = clock + formatters + projection + '\n';
// The later of the two sources wins on both sides: the server projection (with its recorded
// fallback) and the anchor a successful open writes. `wuwa.chestFallback=off` keeps the stock
// projection verbatim, anchor first.
const rewritten = projection
  .replace('kr===null?co(R.userInfo?.left_treasure_chest,e):Math.max(0,kr-t)',
    '__wuwatappoChestDisabled()?kr===null?co(R.userInfo?.left_treasure_chest,e):Math.max(0,kr-t):Math.max(__wuwatappoChestRemaining("left",R.userInfo?.left_treasure_chest,e),kr===null?0:Math.max(0,kr-t))')
  .replace('Cr===null?co(R.userInfo?.right_treasure_chest,e):Math.max(0,Cr-t)',
    '__wuwatappoChestDisabled()?Cr===null?co(R.userInfo?.right_treasure_chest,e):Math.max(0,Cr-t):Math.max(__wuwatappoChestRemaining("right",R.userInfo?.right_treasure_chest,e),Cr===null?0:Math.max(0,Cr-t))');
const helper = macChestFallbackHelper('co');

// Mirrors the shipped No()/co() pair the injected helper calls, so the branches under test are the
// fallback bookkeeping only.
const stockClock = (value, now) => {
  const deadline = value == null ? 0 : Math.floor(Number(value));
  return !Number.isFinite(deadline) || deadline <= 0 ? 0 : Math.max(0, deadline - now);
};

function harness({ storage = {} } = {}) {
  const entries = new Map(Object.entries(storage));
  const wall = { value: 1_700_000_000_000 };
  const context = {
    co: stockClock,
    localStorage: {
      getItem: key => (entries.has(key) ? entries.get(key) : null),
      setItem: (key, value) => entries.set(key, String(value)),
      removeItem: key => entries.delete(key),
    },
    Date: { now: () => wall.value },
  };
  vm.createContext(context);
  vm.runInContext(helper, context);
  return { entries, wall, remaining: (side, raw, now) => context.__wuwatappoChestRemaining(side, raw, now) };
}

test('both chest projections route through the fallback helper and nothing else moves', () => {
  const patched = patchMacChestCountdownFallback(fixture);
  assert.equal(patched, helper + fixture.replace(projection, rewritten));
  assert.equal(patched.split(MAC_CHEST_FALLBACK_MARK).length - 1, 1);
  assert.equal(patched.split('__wuwatappoChestRemaining(').length - 1, 3);
  // Each side keeps the stock anchor projection twice: once as the verbatim off switch, once as
  // the anchor half of the merge.
  assert.equal(patched.split('Math.max(0,kr-t)').length - 1, 2);
  assert.equal(patched.split('Math.max(0,Cr-t)').length - 1, 2);
  assert.equal(patched.split('Math.max(__wuwatappoChestRemaining(').length - 1, 2);
  assert.equal(patched.split(clock).length - 1, 1);
  assert.equal(patched.includes(formatters), true);
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
});

test('a bundle without both chest projections stops preparation', () => {
  assert.throws(() => patchMacChestCountdownFallback(''), /Original treasure chest countdown projection changed; found 0 of 2 \(none\)/);
  const half = fixture.replace(',Ht.value=Cr===null?co(R.userInfo?.right_treasure_chest,e):Math.max(0,Cr-t)', '');
  assert.throws(() => patchMacChestCountdownFallback(half), /found 1 of 2 \(left_treasure_chest\)/);
});

test('a projection whose stock clock moved stops preparation', () => {
  const moved = fixture.replace('function co(e,t=is()){const o=No(e);return o<=0?0:Math.max(0,o-t)}', 'function co(e,t){return Math.max(0,e-t)}');
  assert.throws(() => patchMacChestCountdownFallback(moved), /Original treasure chest countdown clock changed/);
});

test('an already patched bundle stops preparation instead of wrapping twice', () => {
  assert.throws(() => patchMacChestCountdownFallback(patchMacChestCountdownFallback(fixture)), /already applied; reconcile the patch order/);
});

test('a live server deadline is recorded per side and projected as before', () => {
  const h = harness();
  assert.equal(h.remaining('left', 5_000_000, 1_000_000), 4_000_000);
  assert.deepEqual(JSON.parse(h.entries.get('wuwa.chestDeadline.left')), { deadline: 5_000_000, stamp: h.wall.value });
  assert.equal(h.remaining('right', 9_000_000, 1_000_000), 8_000_000);
  assert.equal(JSON.parse(h.entries.get('wuwa.chestDeadline.right')).deadline, 9_000_000);
  assert.equal(h.remaining('left', 5_000_000, 1_000_000), 4_000_000);
});

test('a missing or zero server deadline reuses the recorded one, so the bubble keeps its countdown', () => {
  const h = harness();
  h.remaining('left', 5_000_000, 1_000_000);
  h.wall.value += 30 * 60 * 1000;
  assert.equal(h.remaining('left', 0, 4_000_000), 1_000_000);
  assert.equal(h.remaining('left', null, 4_500_000), 500_000);
  assert.equal(h.remaining('left', undefined, 4_900_000), 100_000);
  assert.equal(h.remaining('right', 0, 4_000_000), 0);
  assert.equal(h.entries.has('wuwa.chestDeadline.right'), false);
});

test('a record older than 90 minutes is dropped instead of showing a stale countdown', () => {
  const h = harness();
  h.remaining('left', 5_000_000, 1_000_000);
  h.wall.value += 90 * 60 * 1000 + 1;
  assert.equal(h.remaining('left', 0, 1_000_000), 0);
  assert.equal(h.entries.has('wuwa.chestDeadline.left'), false);
});

test('a record whose deadline already passed is dropped', () => {
  const h = harness();
  h.remaining('left', 5_000_000, 1_000_000);
  h.wall.value += 60_000;
  assert.equal(h.remaining('left', 0, 5_000_000), 0);
  assert.equal(h.entries.has('wuwa.chestDeadline.left'), false);
});

test('a garbage record is ignored and cleared', () => {
  const h = harness({ storage: { 'wuwa.chestDeadline.left': 'not json' } });
  assert.equal(h.remaining('left', 0, 1_000), 0);
  assert.equal(h.entries.has('wuwa.chestDeadline.left'), false);
});

test('wuwa.chestFallback=off restores the stock projection and leaves the record alone', () => {
  const record = JSON.stringify({ deadline: 5_000_000, stamp: 1 });
  const h = harness({ storage: { 'wuwa.chestFallback': 'off', 'wuwa.chestDeadline.left': record } });
  assert.equal(h.remaining('left', 5_000_000, 1_000_000), 4_000_000);
  assert.equal(h.entries.get('wuwa.chestDeadline.left'), record);
  assert.equal(h.remaining('left', 0, 1_000_000), 0);
  assert.equal(h.entries.get('wuwa.chestDeadline.left'), record);
});

test('the shipped room bundle carries both countdown sites and keeps the formatters intact', () => {
  const matches = sourceFiles()
    .map(name => ({ name, source: readFileSync(path.join(assetDirectory, name), 'utf8') }))
    .filter(({ source }) => /===null\?[$\w]+\([$\w]+\.userInfo\?\.left_treasure_chest,/.test(source));
  assert.equal(matches.length, 1);
  const [{ name, source }] = matches;
  const patched = patchMacChestCountdownFallback(source);
  assert.equal(patched.split(MAC_CHEST_FALLBACK_MARK).length - 1, 1, name);
  for (const anchor of [
    'function ic(e){return Math.max(0,Math.ceil(e/1e3))}',
    'function ac(e,t){return e<=0||t<=0?0:Math.min(1,Math.max(0,e/t))}',
    'const t=Math.floor(e/60),o=e%60',
    'function co(e,t=is()){const o=No(e);return o<=0?0:Math.max(0,o-t)}',
  ]) {
    assert.equal(patched.split(anchor).length - 1, source.split(anchor).length - 1, anchor);
  }
  // One extra read per side: the off switch and the merged server half both name the field.
  for (const field of ['left_treasure_chest', 'right_treasure_chest']) {
    assert.equal(patched.split(field).length - 1, source.split(field).length, field);
  }
  assert.equal(source.split('?co(R.userInfo?.left_treasure_chest,e)').length - 1, 1);
  assert.equal(patched.split('__wuwatappoChestDisabled()?kr===null?co(R.userInfo?.left_treasure_chest,e):Math.max(0,kr-t):Math.max(__wuwatappoChestRemaining("left",R.userInfo?.left_treasure_chest,e),kr===null?0:Math.max(0,kr-t))').length - 1, 1);
  assert.equal(patched.split('__wuwatappoChestDisabled()?Cr===null?co(R.userInfo?.right_treasure_chest,e):Math.max(0,Cr-t):Math.max(__wuwatappoChestRemaining("right",R.userInfo?.right_treasure_chest,e),Cr===null?0:Math.max(0,Cr-t))').length - 1, 1);
  // The helper's own off switch plus one per side: the merge never runs while the switch is off.
  assert.equal(patched.split('__wuwatappoChestDisabled()').length - 1, 4);
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
  const prepare = readFileSync(path.join(root, 'scripts', 'prepare-frontend.mjs'), 'utf8');
  assert.ok(prepare.includes("patchOne('treasure chest countdown projection', (_, content) => /===null\\?[$\\w]+\\([$\\w]+\\.userInfo\\?\\.left_treasure_chest,/.test(content), patchMacChestCountdownFallback);"));
});

// Runs the shipped rewrite end to end: the injected helper plus the patched projection, with the
// stock `is()` fixture clock (0) standing in for Date.now and a controllable performance.now.
// `kr`/`Cr` are the local anchors a successful open writes.
const patchedProjection = patchMacChestCountdownFallback(fixture);

function projectionHarness({ storage = {}, now = 0, leftChest = 0, rightChest = 0 } = {}) {
  const entries = new Map(Object.entries(storage));
  const context = {
    localStorage: {
      getItem: key => (entries.has(key) ? entries.get(key) : null),
      setItem: (key, value) => entries.set(key, String(value)),
      removeItem: key => entries.delete(key),
    },
    Date: { now: () => 1_700_000_000_000 },
    performance: { now: () => context.now },
    R: { userInfo: { left_treasure_chest: leftChest, right_treasure_chest: rightChest } },
    Nt: { value: -1 },
    Ht: { value: -1 },
    Yr: () => {},
    kr: null,
    Cr: null,
    now,
  };
  vm.createContext(context);
  vm.runInContext(patchedProjection, context);
  context.entries = entries;
  return context;
}

test('a live server deadline keeps the gate closed even when the local anchor is spent', () => {
  const h = projectionHarness({ leftChest: 5_000_000, now: 0 });
  h.kr = 2_000;
  h.Vn();
  assert.equal(h.Nt.value, 5_000_000);
  assert.equal(h.Nt.value > 0, true);
});

test('a local anchor that outlasts the server keeps the bubble closed instead of reopening it', () => {
  const h = projectionHarness({ now: 1_000, rightChest: 6_000_000 });
  h.kr = 1_000 + 9_000_000;
  h.Vn();
  assert.equal(h.Nt.value, 9_000_000);
  // The other side keeps its own sources: a spent anchor loses to the later server projection.
  h.Cr = 1_000 + 4_000;
  h.Vn();
  assert.equal(h.Nt.value, 9_000_000);
  assert.equal(h.Ht.value, 6_000_000);
});

test('the gate only reads as ready when both sources are spent', () => {
  const h = projectionHarness({ now: 5_000 });
  h.Vn();
  assert.equal(h.Nt.value, 0);
  assert.equal(h.Nt.value <= 0, true);
  // An anchor in the past is not a source either.
  h.kr = 1_000;
  h.Vn();
  assert.equal(h.Nt.value, 0);
});

test('wuwa.chestFallback=off keeps the stock projection verbatim, anchor first', () => {
  const h = projectionHarness({
    storage: { 'wuwa.chestFallback': 'off' },
    leftChest: 5_000_000,
    now: 0,
  });
  h.kr = 2_000;
  h.Vn();
  assert.equal(h.Nt.value, 2_000);
  assert.equal(h.entries.has('wuwa.chestDeadline.left'), false);
  h.kr = null;
  h.Vn();
  assert.equal(h.Nt.value, 5_000_000);
  assert.equal(h.entries.has('wuwa.chestDeadline.left'), false);
});

