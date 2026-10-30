import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assetDirectory } from './frontend-context.mjs';
import { COUNTDOWN_PAINT_COST_MARK, patchMacCountdownPaintCost } from '../scripts/patch-frontend.mjs';

const progress = '.reward-countdown .reward-countdown__progress{position:absolute;inset:0;filter:drop-shadow(0 0 1px #fed291) drop-shadow(0 0 1px rgba(254,210,145,.85))}';
const bar = '.reward-countdown .reward-countdown__bar{stroke-dasharray:calc(var(--progress) * 100) 100;transition:stroke-dasharray .9s linear}';
const stock = `html{color:#fff}.reward-countdown{position:relative}${progress}${bar}.pet-dock{position:fixed}\n`;

const override = [
  '.reward-countdown .reward-countdown__progress{filter:none!important}',
  '.reward-countdown .reward-countdown__bar{transition:none!important}',
];

test('countdown paint cost override is appended once at the tail of the stylesheet', () => {
  const patched = patchMacCountdownPaintCost(stock);
  assert.equal(patched.slice(0, stock.length), stock);
  const suffix = patched.slice(stock.length);
  const lines = suffix.split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[0], '');
  assert.equal(lines[4], '');
  assert.equal(lines[1].includes(COUNTDOWN_PAINT_COST_MARK), true);
  assert.equal(lines[1].startsWith('/* ') && lines[1].endsWith(' */'), true);
  assert.equal(lines[1].includes('*/'), true);
  assert.deepEqual(lines.slice(2, 4), override);
  for (const rule of override) assert.equal(patched.split(rule).length - 1, 1, rule);
  assert.equal(patched.split(COUNTDOWN_PAINT_COST_MARK).length - 1, 1);
});

test('a stylesheet without the stroke-dasharray tween stops preparation', () => {
  const css = stock.replace(bar, '.reward-countdown .reward-countdown__bar{stroke-dasharray:calc(var(--progress) * 100) 100}');
  assert.throws(() => patchMacCountdownPaintCost(css), /Original countdown bar stroke-dasharray transition changed; found 0 stock rules/);
  assert.throws(() => patchMacCountdownPaintCost(progress), /Original countdown bar stroke-dasharray transition changed/);
});

test('a stylesheet without the drop-shadow filter stops preparation', () => {
  const css = stock.replace(progress, '.reward-countdown .reward-countdown__progress{position:absolute;inset:0}');
  assert.throws(() => patchMacCountdownPaintCost(css), /Original countdown progress drop-shadow filter changed; found 0 stock rules/);
  assert.throws(() => patchMacCountdownPaintCost(bar), /Original countdown progress drop-shadow filter changed/);
});

test('an already patched stylesheet stops preparation instead of stacking overrides', () => {
  const patched = patchMacCountdownPaintCost(stock);
  assert.throws(() => patchMacCountdownPaintCost(patched), /already applied; reconcile the patch order/);
});

test('the stock stylesheet is left byte for byte intact and grows only by the appended block', () => {
  const patched = patchMacCountdownPaintCost(stock);
  const suffix = patched.slice(stock.length);
  const appended = suffix.split('\n').filter(Boolean);
  assert.equal(patched.length - stock.length, 4 + appended.reduce((total, line) => total + line.length, 0));
  assert.equal(patched.replace(suffix, ''), stock);
  assert.equal(patched.trimEnd().endsWith(override[1]), true);
});

test('the shipped countdown stylesheet carries exactly one stock anchor per overridden rule', () => {
  const matches = readdirSync(assetDirectory)
    .filter(name => name.endsWith('.css'))
    .map(name => ({ name, css: readFileSync(path.join(assetDirectory, name), 'utf8') }))
    .filter(({ css }) => css.includes('.reward-countdown .reward-countdown__bar'));
  assert.equal(matches.length, 1);
  const patched = patchMacCountdownPaintCost(matches[0].css);
  assert.equal(patched.slice(0, matches[0].css.length), matches[0].css);
  for (const rule of override) assert.equal(patched.split(rule).length - 1, 1, rule);
});
