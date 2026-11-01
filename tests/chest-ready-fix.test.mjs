import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { assetDirectory, root, sourceFiles } from './frontend-context.mjs';
import { MAC_CHEST_DIAGNOSTICS_MARK, MAC_CHEST_READY_FIX_MARK, patchMacChestReadyFix, patchMacChestStateDiagnostics } from '../scripts/patch-frontend.mjs';

const watcher = 'Oe(()=>R.isLoggedIn,e=>{Qn.value=!1,Pi++,Zn=null,kr=null,Cr=null,Vn(),e&&sc()},{flush:"sync"})';
const xoDecl = 'let fo=null,Ua=!1,Va=!1;';
const xoSlot = xoDecl + 'async function Xo(e){';
const xoGate = 'if(e?.force,nt.value.status,e?.force&&(Va=!0),fo)return fo;if(Ua&&!e?.force)return;';
const xoReset = 'fo=t;try{await t}finally{fo===t&&(fo=null)}';
const refresher = `${xoSlot}${xoGate}const t=__body();${xoReset}}`;
const fixture = ['const before=1;', refresher, watcher + ';', 'const after=1;', ''].join('');

function harness({ storage = {}, loggedIn = true, ready = false, status = 'online' } = {}) {
  const entries = new Map(Object.entries(storage));
  const timers = new Map();
  const watchers = [];
  const cleared = [];
  const calls = { sc: 0 };
  let nextId = 0;
  const context = {
    nt: { value: { status } },
    R: { isLoggedIn: loggedIn },
    Qn: { value: ready },
    sc: () => { calls.sc += 1; },
    Oe: (getter, handler, options) => { watchers.push({ getter, handler, options }); return watchers.length; },
    __body: () => Promise.resolve(),
    localStorage: {
      getItem: key => (entries.has(key) ? entries.get(key) : null),
      setItem: (key, value) => entries.set(key, String(value)),
    },
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => { cleared.push(id); timers.delete(id); },
  };
  vm.createContext(context);
  vm.runInContext(patchMacChestReadyFix(fixture), context);
  const setStatus = value => {
    context.nt.value = { status: value };
    for (const watcher of watchers) {
      let watched;
      try { watched = watcher.getter(); } catch { continue; }
      if (typeof watched === 'string') watcher.handler(value);
    }
  };
  return { context, entries, timers, watchers, cleared, calls, setStatus };
}

function first(h) {
  const [id, timer] = [...h.timers.entries()][0];
  h.timers.delete(id);
  return timer;
}

function drain(h) {
  const gaps = [];
  let guard = 0;
  while (h.timers.size && guard++ < 20) {
    const timer = first(h);
    gaps.push(timer.ms);
    timer.fn();
  }
  return gaps;
}

test('the fix block sits above the login watcher and leaves every stock statement alone', () => {
  const patched = patchMacChestReadyFix(fixture);
  assert.equal(patched.split(MAC_CHEST_READY_FIX_MARK).length - 1, 1);
  const at = fixture.indexOf(watcher);
  assert.equal(patched.startsWith(fixture.slice(0, at)), true);
  const inserted = patched.slice(at);
  assert.equal(inserted.startsWith('\n/* ' + MAC_CHEST_READY_FIX_MARK + ':'), true);
  const tail = '})();\n' + watcher;
  const end = inserted.indexOf(tail) + tail.length;
  assert.equal(inserted.slice(end), fixture.slice(at + watcher.length));
  assert.equal(patched.split('{flush:"sync"}').length - 1, 2, 'the stock watcher and the one watch this block adds');
  assert.equal(patched.includes('function __wuwatappoChestOpen(){try{const s=nt.value.status;return s==="online"||s==="unknown"}catch{return!1}}'), true);
  assert.equal(patched.includes('Oe(()=>nt.value.status,()=>__wuwatappoChestFire(),{flush:"sync"})'), true);
  assert.equal(patched.includes('const __wuwatappoChestRetryLimit=6,__wuwatappoChestRetryGap=1e4'), true);
  assert.equal(patched.includes('immediate'), false);
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
});

test('an already patched bundle stops preparation instead of stacking a second timer', () => {
  assert.throws(() => patchMacChestReadyFix(patchMacChestReadyFix(fixture)), /already applied; reconcile the patch order/);
});

test('a bundle whose login watcher or refresher moved stops preparation', () => {
  assert.throws(() => patchMacChestReadyFix(''), /Original treasure chest login watcher changed; found 0 of 1/);
  assert.throws(() => patchMacChestReadyFix(fixture.replace('{flush:"sync"}', '{flush:"post"}')), /Original treasure chest login watcher changed; found 0 of 1/);
  assert.throws(() => patchMacChestReadyFix(fixture.replace('Qn.value=!1,', '')), /Original treasure chest login watcher changed; found 0 of 1/);
  assert.throws(() => patchMacChestReadyFix(fixture.replace(xoGate, '')), /Original treasure chest refresher gate changed; found 0 of 1/);
  assert.throws(() => patchMacChestReadyFix(fixture.replace(refresher, '')), /Original treasure chest refresher changed; found 0 of 1, reconcile the Mac chest ready fix/);
});

test('stock behaviour is kept while the kill switch holds off, with no timer and no watch at all', () => {
  const h = harness({ storage: { 'wuwa.chestReadyFix': 'off' } });
  assert.equal(h.timers.size, 0);
  assert.equal(h.watchers.filter(watcher => { try { return typeof watcher.getter() === 'string'; } catch { return false; } }).length, 0, 'not even a status watch is installed');
  assert.deepEqual(h.calls, { sc: 0 });
  assert.deepEqual([...h.entries.keys()], ['wuwa.chestReadyFix']);
});

test('a session restored before mount gets its chest refresh replayed once, on a timer', () => {
  const h = harness({ loggedIn: true, ready: false });
  assert.equal(h.timers.size, 1);
  assert.equal(first(h).ms, 0);
  assert.equal(h.calls.sc, 0, 'nothing runs during setup');
});

test('the replay itself fires once the timer lands, and only with the gate open', () => {
  const open = harness({ status: 'online' });
  first(open).fn();
  assert.equal(open.calls.sc, 1);
  const closed = harness({ status: 'offline' });
  first(closed).fn();
  assert.equal(closed.calls.sc, 0, 'a closed gate is not worth a request');
});

test('the replay stays out of the way of a logged-out mount and of an already ready gate', () => {
  const out = harness({ loggedIn: false });
  first(out).fn();
  assert.deepEqual(out.calls, { sc: 0 });
  const ready = harness({ ready: true });
  first(ready).fn();
  assert.deepEqual(ready.calls, { sc: 0 });
});

test('nothing is refreshed while the store is not online, and the watch fires the moment it is', () => {
  const h = harness({ status: 'offline' });
  first(h).fn();
  h.setStatus('degraded');
  assert.equal(h.calls.sc, 0, 'offline and degraded only ever log the stock skip');
  h.setStatus('online');
  assert.equal(h.calls.sc, 1, 'one refresh as the gate opens');
  h.setStatus('reconnecting');
  assert.equal(h.calls.sc, 1);
  h.setStatus('online');
  assert.equal(h.calls.sc, 2, 'and one more on the next opening');
});

test('unknown counts as usable, exactly like the stock gate branch', () => {
  const h = harness({ status: 'unknown' });
  first(h).fn();
  assert.equal(h.calls.sc, 1);
  h.setStatus('unknown');
  assert.equal(h.calls.sc, 2);
});

test('the watch stays quiet while the gate is ready or the session is logged out', () => {
  const ready = harness({ status: 'offline', ready: true });
  ready.setStatus('online');
  assert.equal(ready.calls.sc, 0);
  const out = harness({ status: 'offline', loggedIn: false });
  out.setStatus('online');
  assert.equal(out.calls.sc, 0);
});

test('the fallback retries at ten second intervals and stops after six attempts', () => {
  const h = harness({ status: 'online' });
  assert.deepEqual(drain(h), [0, 1e4, 1e4, 1e4, 1e4, 1e4, 1e4]);
  assert.equal(h.calls.sc, 7, 'one replay plus six bounded fallback attempts');
  assert.equal(h.timers.size, 0, 'the budget is spent, so no request storm can follow');
});

test('a closed gate still spends the same bounded fallback, without a request', () => {
  const h = harness({ status: 'offline' });
  assert.deepEqual(drain(h), [0, 1e4, 1e4, 1e4, 1e4, 1e4, 1e4]);
  assert.equal(h.calls.sc, 0);
  assert.equal(h.timers.size, 0);
});

test('the retries stop as soon as the gate turns ready', () => {
  const h = harness({ status: 'online' });
  first(h).fn();
  assert.equal(h.calls.sc, 1);
  h.context.Qn.value = true;
  assert.deepEqual(drain(h), [1e4]);
  assert.equal(h.calls.sc, 1, 'a ready gate is not refreshed again');
  assert.equal(h.timers.size, 0);
});

test('a logged-out session stops at its first tick', () => {
  const h = harness({ loggedIn: false });
  assert.deepEqual(drain(h), [0]);
  assert.deepEqual(h.calls, { sc: 0 });
  assert.equal(h.timers.size, 0);
});

test('a gate that turns ready before the replay lands clears the pending timer', () => {
  const h = harness({ status: 'online' });
  assert.equal(h.timers.size, 1);
  h.context.Qn.value = true;
  h.setStatus('online');
  assert.equal(h.timers.size, 0, 'the watch stops the chain instead of waiting for the timer');
  assert.equal(h.cleared.length, 1);
  assert.equal(h.calls.sc, 0);
});

test('a refresh that throws cannot escape the timer or the watch', () => {
  const h = harness({ status: 'online' });
  h.context.sc = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => first(h).fn());
  assert.doesNotThrow(() => h.setStatus('degraded'));
  assert.doesNotThrow(() => h.setStatus('online'));
  assert.deepEqual(drain(h), [1e4, 1e4, 1e4, 1e4, 1e4, 1e4]);
  assert.equal(h.timers.size, 0);
});

test('the shipped room bundle anchors once, keeps the watcher text and gains no ref write', () => {
  const matches = sourceFiles()
    .map(name => ({ name, source: readFileSync(path.join(assetDirectory, name), 'utf8') }))
    .filter(({ source }) => /Oe\(\(\)=>[$\w]+\.isLoggedIn,[$\w]+=>\{[$\w]+\.value=!1,/.test(source));
  assert.equal(matches.length, 1);
  const [{ name, source }] = matches;
  const patched = patchMacChestReadyFix(patchMacChestStateDiagnostics(source));
  assert.equal(patched.split(MAC_CHEST_READY_FIX_MARK).length - 1, 1, name);
  assert.equal(patched.split(MAC_CHEST_DIAGNOSTICS_MARK).length - 1, 1, name);
  assert.equal(patched.split(watcher).length - 1, 1, name);
  assert.equal(patched.split('{flush:"sync"}').length - 1, source.split('{flush:"sync"}').length - 1 + 1, name);
  for (const target of ['Qn', 'Mi', 'br', 'Pi', 'Zn', 'kr', 'Cr']) {
    assert.equal(patched.split(target + '.value=').length - 1, source.split(target + '.value=').length - 1, target);
  }
  assert.equal(patched.indexOf(MAC_CHEST_READY_FIX_MARK) < patched.indexOf(watcher), true);
  assert.equal(patched.split(';,').length - 1, source.split(';,').length - 1);
  assert.equal(patched.includes('if(!R.isLoggedIn||!Qn.value)return'), false, 'the fix never replays outside its own guard');
  assert.equal(patched.includes('function __wuwatappoChestArmed(){try{return!!R.isLoggedIn&&!Qn.value}catch{return!1}}'), true);
  assert.equal(patched.includes('const s=nt.value.status;return s==="online"||s==="unknown"'), true);
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
});

test('preparation registers the ready fix on the same room bundle', () => {
  const prepare = readFileSync(path.join(root, 'scripts', 'prepare-frontend.mjs'), 'utf8');
  assert.ok(prepare.includes("patchOne('treasure chest login watcher', (_, content) => /Oe\\(\\(\\)=>[$\\w]+\\.isLoggedIn,[$\\w]+=>\\{[$\\w]+\\.value=!1,/.test(content), patchMacChestReadyFix);"));
});
