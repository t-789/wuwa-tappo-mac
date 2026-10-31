import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { assetDirectory, root, sourceFiles } from './frontend-context.mjs';
import { MAC_FPS_CAP_GATE, MAC_FPS_CAP_MARK, patchMacThrottleAnimation } from '../scripts/patch-frontend.mjs';

const head = 'function De(X){const O=Math.min((X-C)/1e3,.028);C=X;';
const gated = 'function De(X){if(!__wuwatappoFpsGate(S)){const O=Math.min((X-C)/1e3,__wuwatappoFpsStep());C=X;';
const loop = `${head}for(const[K,G]of S)[G.x,G.vx]=E(G.x,G.vx,G.targetX,245,13.2,O),[G.y,G.vy]=E(G.y,G.vy,G.targetY,285,14,O),[G.r,G.vr]=E(G.r,G.vr,G.targetR,205,12.5,O),H(K,G);L=requestAnimationFrame(De)}`;
const fixture = `const S=new Map,C=0;let L=0;function E(){return[0,0]}function H(){}${loop}function js(fn){fn()}function Ai(){}js(()=>{C=performance.now(),L=requestAnimationFrame(De)});export{};\n`;

function harness({ storage = {}, visibility = 'visible' } = {}) {
  const entries = new Map(Object.entries(storage));
  const clock = { value: 0 };
  const context = {
    localStorage: {
      getItem: key => (entries.has(key) ? entries.get(key) : null),
      setItem: (key, value) => entries.set(key, String(value)),
      removeItem: key => entries.delete(key),
    },
    document: { visibilityState: visibility },
    performance: { now: () => clock.value },
  };
  vm.createContext(context);
  vm.runInContext(MAC_FPS_CAP_GATE, context);
  return {
    entries,
    clock,
    step: () => context.__wuwatappoFpsStep(),
    gate: items => context.__wuwatappoFpsGate(items),
    show: () => { context.document.visibilityState = 'visible'; },
    frames(ms, { hz = 120, items = null } = {}) {
      const tick = 1000 / hz;
      let frames = 0;
      for (let elapsed = tick; elapsed <= ms + 1e-9; elapsed += tick) {
        clock.value += tick;
        if (!context.__wuwatappoFpsGate(items)) frames += 1;
      }
      return frames;
    },
  };
}

test('the pet render loop gains one gate and keeps its stock step', () => {
  const patched = patchMacThrottleAnimation(fixture);
  assert.equal(patched, MAC_FPS_CAP_GATE + fixture.replace(head, gated).replace('H(K,G);L=requestAnimationFrame(De)', 'H(K,G);}L=requestAnimationFrame(De)'));
  assert.equal(patched.split(MAC_FPS_CAP_MARK).length - 1, 1);
  assert.equal(patched.split('if(!__wuwatappoFpsGate(S)){').length - 1, 1);
  assert.equal((patched.match(/requestAnimationFrame\(De\)/g) ?? []).length, 2);
  assert.equal((patched.match(/Math\.min\(/g) ?? []).length, 1);
  assert.equal(patched.split('__wuwatappoFpsStep').length - 1, 2);
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
});

test('the cap never reassigns requestAnimationFrame, so events and one-shot frames stay stock', () => {
  const patched = patchMacThrottleAnimation(fixture);
  assert.equal(/requestAnimationFrame\s*=/.test(patched), false);
  assert.equal(patched.includes('cancelAnimationFrame'), false);
  assert.equal(patched.split('if(!__wuwatappoFpsGate(').length - 1, 1);
  assert.equal(patched.includes('window.addEventListener'), fixture.includes('window.addEventListener'));
});

test('a bundle without the pet render loop stops preparation', () => {
  assert.throws(() => patchMacThrottleAnimation(''), /Original pet animation frame loop changed; found 0 loop heads/);
  assert.throws(() => patchMacThrottleAnimation(fixture.replace('Math.min((X-C)/1e3,.028)', '(X-C)/1e3')), /found 0 loop heads/);
});

test('a loop that lost its item map or its self-schedule stops preparation', () => {
  assert.throws(() => patchMacThrottleAnimation(fixture.replace('for(const[K,G]of S)', '')), /Original pet animation frame loop changed;/);
  assert.throws(() => patchMacThrottleAnimation(fixture.replace('H(K,G);L=requestAnimationFrame(De)', 'H(K,G);M=requestAnimationFrame(De)')), /Original pet animation frame loop changed;/);
});

test('an already gated bundle stops preparation instead of gating twice', () => {
  assert.throws(() => patchMacThrottleAnimation(patchMacThrottleAnimation(fixture)), /already applied; reconcile the patch order/);
});

test('the default render budget is 30 frames per second on a 120 Hz display', () => {
  const h = harness();
  assert.ok(Math.abs(h.frames(1000) - 30) <= 1, String(h.frames(1000)));
  assert.ok(h.frames(1000) < 31);
  assert.ok(Math.abs(h.step() - 1.05 / 30) < 1e-12);
});

test('wuwa.fpsCap overrides the budget between 20 and 120 and ignores anything else', () => {
  assert.ok(Math.abs(harness({ storage: { 'wuwa.fpsCap': '60' } }).frames(1000) - 60) <= 1);
  assert.ok(Math.abs(harness({ storage: { 'wuwa.fpsCap': '20' } }).frames(1000) - 20) <= 1);
  assert.ok(Math.abs(harness({ storage: { 'wuwa.fpsCap': '120' } }).frames(1000) - 120) <= 1);
  for (const value of ['0', '19', '121', '30.5', 'abc', '', '  ', '-30', 'NaN']) {
    const h = harness({ storage: { 'wuwa.fpsCap': value } });
    assert.ok(Math.abs(h.frames(1000) - 30) <= 1, value);
  }
});

test('a hidden window stops the beat and the visible one resumes it', () => {
  const h = harness({ visibility: 'hidden' });
  assert.equal(h.frames(500), 0);
  h.show();
  assert.equal(h.gate(null), false);
  assert.equal(h.frames(1000) > 0, true);
});

test('a pressed emotion item keeps the stock cadence instead of the cap', () => {
  const items = new Map([['idle', { held: false }], ['happy', { held: true }]]);
  assert.equal(harness().frames(1000, { items }), 120);
  assert.equal(harness().frames(1000, { items: new Map([['idle', { held: false }]]) }) <= 31, true);
});

test('the shipped room bundle carries exactly one render loop and survives the gate', () => {
  const matches = sourceFiles()
    .map(name => ({ name, source: readFileSync(path.join(assetDirectory, name), 'utf8') }))
    .filter(({ source }) => /Math\.min\(\([$\w]+-[$\w]+\)\/1e3,\.028\)/.test(source));
  assert.equal(matches.length, 1);
  const [{ name, source }] = matches;
  const patched = patchMacThrottleAnimation(source);
  assert.equal(patched.split(MAC_FPS_CAP_MARK).length - 1, 1, name);
  assert.equal(patched.split('__wuwatappoFpsStep').length - 1, 2);
  assert.equal((patched.match(/requestAnimationFrame\([$\w]+\)/g) ?? []).length, (source.match(/requestAnimationFrame\([$\w]+\)/g) ?? []).length);
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
  const prepare = readFileSync(path.join(root, 'scripts', 'prepare-frontend.mjs'), 'utf8');
  assert.ok(prepare.includes("patchOne('pet animation frame loop', (_, content) => /Math\\.min\\(\\([$\\w]+-[$\\w]+\\)\\/1e3,\\.028\\)/.test(content), patchMacThrottleAnimation);"));
});
