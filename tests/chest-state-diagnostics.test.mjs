import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { assetDirectory, root, sourceFiles } from './frontend-context.mjs';
import { MAC_CHEST_DIAGNOSTICS_MARK, MAC_CHEST_READY_FIX_MARK, MAC_CHEST_VN_BEAT_MARK, MAC_CHEST_XO_GUARD_MARK, macChestVnBeatHelper, patchMacChestReadyFix, patchMacChestStateDiagnostics, patchMacChestVnBeat, patchMacChestXoGuard } from '../scripts/patch-frontend.mjs';

const cpFn = 'function Cp(e){const t=performance.now()+fr;e==="left"?(kr=t,Nt.value=fr,Po.value=fr):(Cr=t,Ht.value=fr,To.value=fr)}';
const cpClaimed = cpFn.slice(0, -1) + ';__wuwatappoChestClaim(e)}';
const clockFn = 'function co(e,t=is()){const o=No(e);return o<=0?0:Math.max(0,o-t)}';
const fixture = [
  'const Nt=W(0),Ht=W(0),Po=W(0),To=W(0),Fn=W(!1);',
  'let Zn=null,kr=null,Cr=null;',
  'const Gy=400,fr=30*6e4;',
  'function No(e){if(e==null)return 0;const t=Math.floor(Number(e));return!Number.isFinite(t)||t<=0?0:t}',
  'function is(){return Date.now()}',
  clockFn,
  cpFn,
  'const Ns=1e3,Yy=2e3;',
  'const{localClickCount:ue,totalClickCount:Re}=fm(R);',
  'const Mi=W(!0),br=W(!1);let Mo=0;const Qn=W(!1),kt=pe(()=>Mi.value||br.value||R.isLoggedIn&&!Qn.value);',
  'const Wn=pe(()=>kt.value||!R.isLoggedIn?!0:Nt.value<=0),Gn=pe(()=>kt.value||!R.isLoggedIn?!0:Ht.value<=0),Ta=pe(()=>kt.value||!R.isLoggedIn?!0:Re.value>=Ns),Fp=pe(()=>kt.value||!R.isLoggedIn?!1:Re.value>=Ns&&Re.value<Yy),Kr=pe(()=>Fp.value?Wn.value?"left":"right":null);',
  'const zr=pe(()=>!0),jr=pe(()=>!1);',
  'function Dp(){return kt.value||Fn.value||!Ta.value?!1:!!(zr.value&&Wn.value||jr.value&&Gn.value)}',
  'const after=1;',
  '',
].join('');
const renderGate = 'function Dp(){return kt.value||Fn.value||!Ta.value?!1:!!(zr.value&&Wn.value||jr.value&&Gn.value)}';
const helperTail = '},5e3);\n';

function harness({ storage = {}, hidden = false, source = fixture, patch = patchMacChestStateDiagnostics } = {}) {
  const entries = new Map(Object.entries(storage));
  const timers = [];
  const wall = { value: 1700000000000 };
  const ref = value => ({ value });
  const context = {
    R: { isLoggedIn: true, userInfo: { left_treasure_chest: 5000000, right_treasure_chest: null } },
    W: ref,
    pe: fn => ({ get value() { return fn(); } }),
    fm: () => ({ localClickCount: ref(0), totalClickCount: ref(1600) }),
    localStorage: {
      getItem: key => (entries.has(key) ? entries.get(key) : null),
      setItem: (key, value) => entries.set(key, String(value)),
      removeItem: key => entries.delete(key),
    },
    document: { hidden },
    performance: { now: () => wall.value },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    Date: { now: () => wall.value },
  };
  vm.createContext(context);
  vm.runInContext(patch(source), context);
  return { context, entries, timers, wall };
}

test('the block sits behind the render gate and appends one statement to the claim path', () => {
  const patched = patchMacChestStateDiagnostics(fixture);
  assert.equal(patched.split(MAC_CHEST_DIAGNOSTICS_MARK).length - 1, 1);
  assert.equal(patched.includes(cpClaimed), true, 'the claim record is the only statement added to the anchor');
  assert.equal(patched.includes('__wuwatappoChestClaim('), true);
  assert.equal(patched.split('__wuwatappoChestClaim(').length - 1, 2, 'one recorder, one call site');
  const anchored = fixture.replace(cpFn, () => cpClaimed);
  const head = anchored.slice(0, anchored.indexOf(renderGate) + renderGate.length);
  assert.equal(patched.startsWith(head), true);
  const inserted = patched.slice(head.length);
  assert.equal(inserted.startsWith('\n/* ' + MAC_CHEST_DIAGNOSTICS_MARK + ':'), true);
  const end = inserted.indexOf(helperTail) + helperTail.length;
  assert.equal(inserted.slice(end), anchored.slice(head.length));
  assert.equal(patched.includes('const __wuwatappoChestDbgOn=(()=>{try{return localStorage.getItem("wuwa.chestDbg")!=="off"}catch{return!0}})();'), true);
  assert.equal(patched.split('localStorage.getItem("wuwa.chestDbg")').length - 1, 1, 'the switch is read once, not on every tick');
  assert.equal(patched.includes('==="on"||value==="1"'), false, 'the opt-in switch is gone for this round');
  assert.equal(patched.split('localStorage.setItem("wuwa.chestDbg"').length - 1, 1);
  assert.equal(patched.split('localStorage.setItem(__wuwatappoChestClaimKey').length - 1, 1);
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
});

test('an already patched bundle stops preparation instead of wrapping twice', () => {
  assert.throws(() => patchMacChestStateDiagnostics(patchMacChestStateDiagnostics(fixture)), /already applied; reconcile the patch order/);
});

test('a bundle without the chest gates stops preparation', () => {
  assert.throws(() => patchMacChestStateDiagnostics(''), /Original treasure chest visibility gates changed; found 0 of 1/);
  assert.throws(() => patchMacChestStateDiagnostics(fixture.replace('Wn=pe(()=>kt.value', 'Wn=pe(()=>!kt.value')), /Original treasure chest visibility gates changed; found 0 of 1/);
  assert.throws(() => patchMacChestStateDiagnostics(fixture.replace('Re.value>=Ns&&Re.value<Yy', 'Re.value>=Ns&&Re.value<=Yy')), /Original treasure chest click gates changed; found 0 of 1/);
  assert.throws(() => patchMacChestStateDiagnostics(fixture.replace('jr.value&&Gn.value', 'jr.value&&jr.value')), /Original treasure chest render gate changed; found 1 of 1/);
  assert.throws(() => patchMacChestStateDiagnostics(fixture.replace('!!(zr.value', '!!(zr.value||!0')), /Original treasure chest render gate changed; found 0 of 1/);
  assert.throws(() => patchMacChestStateDiagnostics(fixture.replace('const Qn=W(!1),kt=pe', 'const Qn=W(!0),kt=pe')), /Original treasure chest busy gate changed; found 0 of 1/);
  assert.throws(() => patchMacChestStateDiagnostics(fixture.replace('&&!Qn.value', '&&!!Qn.value')), /Original treasure chest busy gate changed; found 0 of 1/);
  assert.throws(() => patchMacChestStateDiagnostics(fixture.replace('br=W(!1)', 'br=W(!0)')), /Original treasure chest busy gate changed; found 1 of 1/);
  assert.throws(() => patchMacChestStateDiagnostics(fixture.replace(cpFn, 'function Cp(e){const t=performance.now()+fr;e==="left"?(kr=t,Po.value=fr):(Cr=t,Ht.value=fr,To.value=fr)}')), /Original treasure chest claim anchor changed; found 0 of 1/);
  assert.throws(() => patchMacChestStateDiagnostics(fixture.replace('e==="left"?(kr=t,Nt.value=fr', 'e==="left"?(kr=t,Ht.value=fr')), /Original treasure chest claim anchor changed; found 1 of 1/);
  assert.throws(() => patchMacChestStateDiagnostics(fixture.replace('t=is()', 't=Date.now()')), /Original treasure chest countdown clock changed; found 0 of 1/);
});

test('the snapshot is taken every five seconds and carries the whole gate state', () => {
  const h = harness({ storage: { 'wuwa.chestDbg': 'on' } });
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 5000);
  h.timers[0].fn();
  assert.deepEqual(JSON.parse(h.entries.get('wuwa.chestDbg')), {
    t: 1700000000000,
    tick: 1,
    isLoggedIn: true,
    qt: true,
    fn: false,
    mi: true,
    br: false,
    qn: false,
    fr: 1800000,
    now: 1700000000000,
    anchorL: null,
    anchorR: null,
    vn: null,
    vnAt: null,
    left: { raw: 5000000, remaining: 0, show: true },
    right: { raw: null, remaining: 0, show: true },
    clicks: { re: 1600, need: 1000, upper: 2000 },
    visible: { zr: true, jr: false },
    xo: null,
    vars: {
      user: 'R', loading: 'kt', request: 'Fn', left: 'Nt', right: 'Ht',
      leftShow: 'Wn', rightShow: 'Gn', clicks: 'Re', need: 'Ns', upper: 'Yy',
      visibleLeft: 'zr', visibleRight: 'jr',
      mi: 'Mi', br: 'br', qn: 'Qn',
      duration: 'fr', anchorLeft: 'kr', anchorRight: 'Cr', clock: 'is',
    },
  });
});

test('the observer touches nothing but its own key, and every tick refreshes the timestamp', () => {
  const h = harness({ storage: { 'wuwa.chestDbg': 'on' } });
  const before = JSON.stringify({ loggedIn: h.context.R.isLoggedIn, userInfo: h.context.R.userInfo });
  h.timers[0].fn();
  h.timers[0].fn();
  assert.deepEqual([...h.entries.keys()], ['wuwa.chestDbg']);
  assert.equal(JSON.stringify({ loggedIn: h.context.R.isLoggedIn, userInfo: h.context.R.userInfo }), before);
  h.wall.value += 5000;
  h.timers[0].fn();
  assert.equal(JSON.parse(h.entries.get('wuwa.chestDbg')).t, 1700000005000);
});

test('the snapshot is written by default and only the exact "off" switch silences it', () => {
  for (const value of [null, '', 'on', '1', 'off ', 'OFF']) {
    const h = harness(value === null ? {} : { storage: { 'wuwa.chestDbg': value } });
    h.timers[0].fn();
    assert.equal(JSON.parse(h.entries.get('wuwa.chestDbg')).isLoggedIn, true, 'switch ' + JSON.stringify(value) + ' arms the snapshot');
  }
  const off = harness({ storage: { 'wuwa.chestDbg': 'off' } });
  off.timers[0].fn();
  assert.equal(off.entries.get('wuwa.chestDbg'), 'off', 'the kill switch leaves the key untouched');
});

test('an empty store is armed, and the kill switch stays quiet for every tick', () => {
  const h = harness();
  for (let tick = 0; tick < 3; tick += 1) h.timers[0].fn();
  assert.equal(JSON.parse(h.entries.get('wuwa.chestDbg')).tick, 3);
  assert.equal(h.timers[0].ms, 5000);
  const off = harness({ storage: { 'wuwa.chestDbg': 'off' } });
  for (let tick = 0; tick < 3; tick += 1) off.timers[0].fn();
  assert.deepEqual([...off.entries], [['wuwa.chestDbg', 'off']]);
});

test('a hidden document is skipped', () => {
  const h = harness({ hidden: true });
  h.timers[0].fn();
  assert.equal(h.entries.size, 0, 'a hidden document keeps the armed switch and writes nothing');
});

test('every snapshot counts itself and carries the cooldown, the clock and the raw anchors', () => {
  const h = harness();
  h.timers[0].fn();
  h.timers[0].fn();
  h.wall.value += 5000;
  h.timers[0].fn();
  const snapshot = JSON.parse(h.entries.get('wuwa.chestDbg'));
  assert.deepEqual([snapshot.tick, snapshot.t, snapshot.now], [3, 1700000005000, 1700000005000]);
  assert.equal(snapshot.fr, 1800000, 'the claimed cooldown the local anchor is built from');
  assert.deepEqual([snapshot.anchorL, snapshot.anchorR], [null, null], 'no claim yet, so no anchor');
});

test('a claim writes its anchor and one three field record, keeping the last three', () => {
  const h = harness();
  h.context.Cp('left');
  assert.deepEqual(JSON.parse(h.entries.get('wuwa.chestClaim')), [
    { t: 1700000000000, side: 'left', fr: 1800000, anchorAfter: 1700001800000, remainingAfter: 1800000, raw: 5000000 },
  ]);
  h.timers[0].fn();
  const snapshot = JSON.parse(h.entries.get('wuwa.chestDbg'));
  assert.deepEqual([snapshot.anchorL, snapshot.anchorR, snapshot.left.remaining], [1700001800000, null, 1800000]);
  for (const side of ['right', 'left', 'right', 'left']) {
    h.wall.value += 1000;
    h.context.Cp(side);
  }
  const list = JSON.parse(h.entries.get('wuwa.chestClaim'));
  assert.equal(list.length, 3, 'the record is capped at the last three claims');
  assert.deepEqual(list.map(entry => [entry.side, entry.raw]), [['left', 5000000], ['right', null], ['left', 5000000]]);
  assert.deepEqual(list.map(entry => entry.anchorAfter), [1700001802000, 1700001803000, 1700001804000], 'each anchor follows the wall clock of its own claim');
});

test('a store that refuses its own key never reaches the claim path', () => {
  const h = harness();
  const store = h.context.localStorage;
  const { setItem, getItem } = store;
  store.setItem = () => { throw new Error('quota'); };
  assert.doesNotThrow(() => h.context.Cp('left'));
  assert.equal(h.entries.has('wuwa.chestClaim'), false);
  store.setItem = setItem;
  store.getItem = key => { if (key === 'wuwa.chestClaim') throw new Error('denied'); return getItem(key); };
  assert.doesNotThrow(() => h.context.Cp('left'));
  store.getItem = getItem;
  assert.equal(JSON.parse(h.entries.get('wuwa.chestClaim')).length, 1, 'an unreadable store starts the record over instead of failing');
  h.timers[0].fn();
  assert.equal(JSON.parse(h.entries.get('wuwa.chestDbg')).anchorL, 1700001800000, 'the stock anchor assignment ran and the record failures stayed silent');
});

test('the shipped room bundle anchors once and keeps every assignment and formatter intact', () => {
  const matches = sourceFiles()
    .map(name => ({ name, source: readFileSync(path.join(assetDirectory, name), 'utf8') }))
    .filter(({ source }) => /===null\?[$\w]+\([$\w]+\.userInfo\?\.left_treasure_chest,/.test(source));
  assert.equal(matches.length, 1);
  const [{ name, source }] = matches;
  const patched = patchMacChestStateDiagnostics(source);
  assert.equal(patched.split(MAC_CHEST_DIAGNOSTICS_MARK).length - 1, 1, name);
  assert.equal(patched.split('localStorage.setItem("wuwa.chestDbg"').length - 1, 1, name);
  for (const target of ['Nt', 'Ht', 'Wn', 'Gn', 'Fn', 'kt', 'Re', 'Ta', 'Fp', 'zr', 'jr', 'Mi', 'br', 'Qn']) {
    assert.equal(patched.split(target + '.value=').length - 1, source.split(target + '.value=').length - 1, target);
  }
  for (const anchor of [
    'Math.max(0,kr-t)',
    'Math.max(0,Cr-t)',
    'function co(e,t=is()){const o=No(e);return o<=0?0:Math.max(0,o-t)}',
    'function ac(e,t){return e<=0||t<=0?0:Math.min(1,Math.max(0,e/t))}',
    'function ic(e){return Math.max(0,Math.ceil(e/1e3))}',
  ]) {
    assert.equal(patched.split(anchor).length - 1, source.split(anchor).length - 1, anchor);
  }
  assert.equal(patched.includes(cpClaimed), true, name + ' claim record');
  assert.equal(patched.split('__wuwatappoChestClaim(').length - 1, 2, name + ' one recorder, one call site');
  assert.equal(patched.split('"wuwa.chestClaim"').length - 1, 1, name + ' one key for the claim record');
  assert.equal(patched.includes('fr:fr,now:is(),anchorL:kr,anchorR:Cr'), true, name + ' cooldown, clock and raw anchors');
  for (const field of ['left_treasure_chest', 'right_treasure_chest']) {
    assert.equal(patched.split(field).length - 1, source.split(field).length - 1 + 2, field + ': the snapshot and the claim record');
  }
  assert.equal(patched.indexOf(MAC_CHEST_DIAGNOSTICS_MARK) > patched.indexOf(renderGate), true);
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
});

const tickHead = 'function Vn(){if(!R.isLoggedIn){Nt.value=0,Ht.value=0,Po.value=0,To.value=0;return}if(!Qn.value)return;const e=is(),t=performance.now();';
const tickCall = 'Vn(){__wuwatappoChestVnBeat();if(!R.isLoggedIn){';
const tickSource = `${fixture}function Yr(){}\n${tickHead}Nt.value=Math.max(0,kr===null?0:Math.max(0,kr-t)),Yr("left",Nt.value)}\nfunction tickRefs(){return [Nt.value,Ht.value,Po.value,To.value]}\n`;

function beatHarness(source = tickSource) {
  const wall = { value: 1700000000000 };
  const ref = value => ({ value });
  const context = {
    R: { isLoggedIn: true, userInfo: { left_treasure_chest: 5000000 } },
    W: ref,
    pe: fn => ({ get value() { return fn(); } }),
    fm: () => ({ localClickCount: ref(0), totalClickCount: ref(1600) }),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    Date: { now: () => wall.value },
    performance: { now: () => wall.value },
  };
  vm.createContext(context);
  vm.runInContext(patchMacChestVnBeat(source), context);
  return { context, wall, state: () => context.__wuwatappoChestVn };
}

test('the tick beat counts every call, keeps both stock early returns and stamps the wall clock', () => {
  const h = beatHarness();
  assert.deepEqual([h.state().calls, h.state().at], [0, null], 'the block is armed before the first tick, so zero calls is visible');
  h.context.Vn();
  assert.deepEqual([h.state().calls, h.state().at], [1, 1700000000000], 'the ready gate early return still counts a call');
  h.wall.value += 15000;
  assert.doesNotThrow(() => h.context.Vn());
  assert.deepEqual([h.state().calls, h.state().at], [2, 1700000015000], 'the last call keeps its own wall clock');
  h.context.R.isLoggedIn = false;
  assert.doesNotThrow(() => h.context.Vn());
  assert.deepEqual([h.state().calls, h.state().at], [3, 1700000015000], 'the logged out branch counts too');
  assert.deepEqual(Array.from(h.context.tickRefs()), [0, 0, 0, 0], 'the stock reset ran unchanged');
});

test('the beat adds one bare call and leaves every other byte of the tick alone', () => {
  const patched = patchMacChestVnBeat(tickSource);
  const helper = macChestVnBeatHelper();
  assert.equal(patched.split(MAC_CHEST_VN_BEAT_MARK).length - 1, 1);
  assert.equal(patched.split(helper).length - 1, 1, 'one block, once');
  assert.equal(patched.includes('function ' + tickCall), true, 'the call is the first thing in the tick body');
  assert.equal(patched.replace(helper + 'function Vn(){__wuwatappoChestVnBeat();', 'function Vn(){'), tickSource, 'every other byte is the bundled one');
  assert.equal(patched.split('__wuwatappoChestVnBeat()').length - 1, 2, 'one definition, one call site');
  assert.equal(patched.includes('function __wuwatappoChestVnBeat(){const state=globalThis.__wuwatappoChestVn;state.at=Date.now(),state.calls++}'), true, 'the beat is a stamp and a count, nothing else');
  assert.equal(patched.includes('try{'), false, 'the beat wraps no stock path');
  assert.throws(() => patchMacChestVnBeat(patched), /already applied; reconcile the patch order/);
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
});

test('a bundle without the stock tick stops preparation', () => {
  assert.throws(() => patchMacChestVnBeat(''), /Original treasure chest visibility gates changed; found 0 of 1/);
  assert.throws(() => patchMacChestVnBeat(tickSource.replace('function Vn(){if(!R.isLoggedIn){', 'function Vn(){if(!R.isLoggedIn) {')), /Original treasure chest tick changed; found 0 of 1/);
  assert.throws(() => patchMacChestVnBeat(tickSource.replace('const e=is(),t=performance.now()', 'const e=is(),t=Date.now()')), /Original treasure chest tick changed; found 0 of 1/);
  assert.throws(() => patchMacChestVnBeat(tickSource.replace('function Vn(){if(!R.isLoggedIn){', 'function Vn(){if(!Q.isLoggedIn){')), /Original treasure chest tick changed; found 1 of 1/, 'a renamed store does not carry the tick');
  assert.throws(() => patchMacChestVnBeat(tickSource.replace('Nt.value=0,Ht.value=0,Po.value=0,To.value=0', 'Ht.value=0,Nt.value=0,Po.value=0,To.value=0')), /Original treasure chest tick changed; found 1 of 1/, 'the two countdowns are pinned to their own stores');
});

test('the snapshot carries the tick beat count next to the anchors', () => {
  const withBeat = () => harness({ source: tickSource, patch: source => patchMacChestStateDiagnostics(patchMacChestVnBeat(source)) });
  const h = withBeat();
  h.timers[0].fn();
  let snapshot = JSON.parse(h.entries.get('wuwa.chestDbg'));
  assert.deepEqual([snapshot.vn, snapshot.vnAt], [0, null], 'armed but never called is zero, not absent');
  h.context.Vn();
  h.context.Vn();
  h.wall.value += 5000;
  h.timers[0].fn();
  snapshot = JSON.parse(h.entries.get('wuwa.chestDbg'));
  assert.deepEqual([snapshot.vn, snapshot.vnAt, snapshot.anchorL], [2, 1700000000000, null], 'the beat is readable beside the frozen anchor');
  const without = harness();
  without.timers[0].fn();
  const plain = JSON.parse(without.entries.get('wuwa.chestDbg'));
  assert.deepEqual([plain.vn, plain.vnAt], [null, null], 'a build without the beat reads null instead of throwing');
});

test('the shipped room bundle takes the beat once and no byte of the tick moves', () => {
  const matches = sourceFiles()
    .map(name => ({ name, source: readFileSync(path.join(assetDirectory, name), 'utf8') }))
    .filter(({ source }) => /function [$\w]+\(\)\{if\(![$\w]+\.isLoggedIn\)\{[$\w]+\.value=0,[$\w]+\.value=0,[$\w]+\.value=0,[$\w]+\.value=0;return\}/.test(source));
  assert.equal(matches.length, 1);
  const [{ name, source }] = matches;
  const patched = patchMacChestVnBeat(source);
  const helper = macChestVnBeatHelper();
  const tick = /function ([$\w]+)\(\)\{if\(!([$\w]+)\.isLoggedIn\)\{[$\w]+\.value=0,[$\w]+\.value=0,[$\w]+\.value=0,[$\w]+\.value=0;return\}/.exec(source);
  assert.deepEqual([tick[1], tick[2]], ['Vn', 'R'], name + ' the minified tick and store this bundle ships');
  assert.equal(patched.split(MAC_CHEST_VN_BEAT_MARK).length - 1, 1, name);
  assert.equal(patched.includes('function ' + tick[1] + '(){__wuwatappoChestVnBeat();if(!' + tick[2] + '.isLoggedIn){'), true, name + ' one bare call ahead of the stock first branch');
  assert.equal(patched.replace(helper + 'function ' + tick[1] + '(){__wuwatappoChestVnBeat();', 'function ' + tick[1] + '(){'), source, name + ' every other byte is the bundled one');
  for (const anchor of ['performance.now()', 'Math.max(0,kr-t)', 'Math.max(0,Cr-t)', ';return}if(!']) {
    assert.equal(patched.split(anchor).length - 1, source.split(anchor).length - 1, anchor);
  }
  assert.equal(patched.split('isLoggedIn').length - 1, source.split('isLoggedIn').length - 1, 'no gate condition is duplicated');
  const stacked = patchMacChestStateDiagnostics(patched);
  for (const mark of [MAC_CHEST_VN_BEAT_MARK, MAC_CHEST_DIAGNOSTICS_MARK]) assert.equal(stacked.split(mark).length - 1, 1, name + ' ' + mark);
  assert.throws(() => patchMacChestVnBeat(stacked), /already applied; reconcile the patch order/);
  parse(stacked, { sourceType: 'module', ecmaVersion: 'latest' });
});

test('preparation registers the tick beat on the same room bundle', () => {
  const prepare = readFileSync(path.join(root, 'scripts', 'prepare-frontend.mjs'), 'utf8');
  assert.ok(/import \{[^}]*patchMacChestVnBeat[^}]*\} from '.\/patch-frontend.mjs';/.test(prepare));
  assert.ok(prepare.includes("patchOne('treasure chest tick',"));
  assert.equal(prepare.includes('patchMacChestVnBeat);'), true);
});

test('preparation registers the diagnostics on the same room bundle', () => {
  const prepare = readFileSync(path.join(root, 'scripts', 'prepare-frontend.mjs'), 'utf8');
  assert.ok(prepare.includes("patchOne('treasure chest state diagnostics', (_, content) => content.includes('left_treasure_chest'), patchMacChestStateDiagnostics);"));
});

const xoDecl = 'let fo=null,Ua=!1,Va=!1;';
const xoSlot = xoDecl + 'async function Xo(e){';
const xoGate = 'if(e?.force,nt.value.status,e?.force&&(Va=!0),fo)return fo;if(Ua&&!e?.force)return;';
const xoReset = 'fo=t;try{await t}finally{fo===t&&(fo=null)}';
const xoFixture = `${xoSlot}${xoGate}const t=__body();${xoReset}}const after=1;`;

function xoHarness({ storage = {}, status = 'online', body = () => Promise.resolve() } = {}) {
  const entries = new Map(Object.entries(storage));
  const wall = { value: 1700000000000 };
  const calls = { body: 0 };
  const context = {
    nt: { value: { status } },
    R: { isLoggedIn: true },
    localStorage: {
      getItem: key => (entries.has(key) ? entries.get(key) : null),
      setItem: (key, value) => entries.set(key, String(value)),
    },
    Date: { now: () => wall.value },
    __body: () => { calls.body += 1; return body(calls.body); },
    setTimeout: () => 0,
  };
  vm.createContext(context);
  vm.runInContext(patchMacChestXoGuard(xoFixture), context);
  return { context, entries, wall, calls, view: () => context.__wuwatappoChestXoProbe() };
}

test('the guard sits between the slot and the refresher and keeps the stock reset word for word', () => {
  const patched = patchMacChestXoGuard(xoFixture);
  assert.equal(patched.split(MAC_CHEST_XO_GUARD_MARK).length - 1, 1);
  const at = xoFixture.indexOf(xoSlot);
  assert.equal(patched.startsWith(xoFixture.slice(0, at) + xoDecl + '\n/* ' + MAC_CHEST_XO_GUARD_MARK + ':'), true, 'the block sits between the slot declaration and the refresher');
  assert.equal(patched.includes('async function Xo(e){__wuwatappoChestXoEnter(e);' + xoGate), true);
  assert.equal(patched.includes(';try{await t}finally{fo===t&&(fo=null)}'), true);
  assert.equal(patched.includes('fo=t;__wuwatappoChestXoStart(t);'), true);
  assert.equal(patched.split(',fo)return fo;').length - 1, 1, 'the reader itself is untouched');
  assert.equal(patched.split('fo=null').length - 1, 3, 'the slot declaration, the stock reset and one expiry write');
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
});

test('a refresher that moved, or one already guarded, stops preparation', () => {
  assert.throws(() => patchMacChestXoGuard(''), /Original treasure chest refresher changed; found 0 of 1/);
  assert.throws(() => patchMacChestXoGuard(xoFixture.replace('nt.value.status', 'nt.value.state')), /Original treasure chest refresher gate changed; found 0 of 1/);
  assert.throws(() => patchMacChestXoGuard(xoFixture.replace(xoReset, 'fo=t;await t')), /Original treasure chest refresher reset changed; found 0 of 1/);
  assert.throws(() => patchMacChestXoGuard(patchMacChestXoGuard(xoFixture)), /already applied; reconcile the patch order/);
});

test('a failed refresh reaches the caller unchanged and leaves its reason in the snapshot', async () => {
  const boom = Object.assign(new Error('响应格式异常'), { name: 'ApiBusinessError', code: -1 });
  const h = xoHarness({ body: () => Promise.reject(boom) });
  await assert.rejects(h.context.Xo({ force: true }), error => error === boom);
  const view = h.view();
  assert.equal(view.inflight, false);
  assert.equal(view.failures, 1);
  assert.equal(view.error, '响应格式异常');
  assert.equal(view.errorName, 'ApiBusinessError');
  assert.equal(view.code, -1);
  await assert.rejects(h.context.Xo({ force: true }), error => error === boom);
  assert.equal(h.calls.body, 2, 'the stock reset already frees the slot on settle');
  assert.equal(h.view().runs, 2);
});

test('a settled refresh frees the slot, so the next call starts a new attempt', async () => {
  const h = xoHarness();
  await h.context.Xo({ force: true });
  assert.equal(h.calls.body, 1);
  assert.deepEqual([h.view().inflight, h.view().settles, h.view().failures], [false, 1, 0]);
  await h.context.Xo({ force: true });
  assert.equal(h.calls.body, 2);
  assert.deepEqual([h.view().runs, h.view().settles], [2, 2]);
});

test('a refresh pending past twenty seconds is dropped before the next one reads the slot', () => {
  const h = xoHarness({ body: () => new Promise(() => {}) });
  h.context.Xo({ force: true });
  assert.equal(h.view().inflight, true);
  h.context.Xo({ force: true });
  assert.equal(h.calls.body, 1, 'the reader is handed the in-flight promise inside the deadline');
  h.wall.value += 19e3;
  h.context.Xo({ force: true });
  assert.equal(h.calls.body, 1, 'and right up to the deadline');
  assert.equal(h.view().ageMs, 19e3);
  h.wall.value += 1001;
  h.context.Xo({ force: true });
  assert.equal(h.calls.body, 2, 'past the deadline the slot is cleared and a fresh attempt starts');
  assert.equal(h.view().expired, 1);
  assert.equal(h.view().gate, 'online');
});

test('wuwa.chestReadyFix=off leaves the stock slot alone and records nothing', async () => {
  const stalled = xoHarness({ storage: { 'wuwa.chestReadyFix': 'off' }, body: () => new Promise(() => {}) });
  stalled.context.Xo({ force: true });
  stalled.wall.value += 6e4;
  stalled.context.Xo({ force: true });
  assert.equal(stalled.calls.body, 1, 'the stuck slot is never dropped');
  assert.deepEqual([stalled.view().expired, stalled.view().runs, stalled.view().inflight], [0, 0, true]);
  assert.deepEqual([stalled.view().skips, stalled.view().gateAtCall, stalled.view().onlineAt], [0, null, null], 'the kill switch records no gate observation either');
  const boom = Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ETIMEDOUT' });
  const failing = xoHarness({ storage: { 'wuwa.chestReadyFix': 'off' }, body: () => Promise.reject(boom) });
  await assert.rejects(failing.context.Xo({ force: true }), error => error === boom);
  assert.deepEqual([failing.view().failures, failing.view().error, failing.view().code], [0, null, null]);
  assert.deepEqual([...failing.entries.keys()], ['wuwa.chestReadyFix']);
});

test('the snapshot carries the refresher view when the guard publishes one, and survives a throwing probe', () => {
  const view = { inflight: true, ageMs: 1500, calls: 3, runs: 1, settles: 0, failures: 1, expired: 0, error: 'timeout', errorName: 'Error', code: 'ETIMEDOUT', force: true, done: false, gate: 'offline' };
  const h = harness({ storage: { 'wuwa.chestDbg': 'on' } });
  h.context.__wuwatappoChestXoProbe = () => view;
  h.timers[0].fn();
  assert.deepEqual(JSON.parse(h.entries.get('wuwa.chestDbg')).xo, view);
  h.context.__wuwatappoChestXoProbe = () => { throw new Error('probe failed'); };
  assert.doesNotThrow(() => h.timers[0].fn());
  assert.deepEqual(JSON.parse(h.entries.get('wuwa.chestDbg')).xo, view, 'a failing probe skips the write instead of throwing into the page');
});

test('the shipped room bundle keeps its slot, gate and reset and gains one controlled write', () => {
  const matches = sourceFiles()
    .map(name => ({ name, source: readFileSync(path.join(assetDirectory, name), 'utf8') }))
    .filter(({ source }) => /let [$\w]+=null,[$\w]+=!1,[$\w]+=!1;async function [$\w]+\([$\w]+\)\{/.test(source));
  assert.equal(matches.length, 1);
  const [{ name, source }] = matches;
  const patched = patchMacChestXoGuard(patchMacChestReadyFix(patchMacChestStateDiagnostics(source)));
  for (const mark of [MAC_CHEST_DIAGNOSTICS_MARK, MAC_CHEST_READY_FIX_MARK, MAC_CHEST_XO_GUARD_MARK]) {
    assert.equal(patched.split(mark).length - 1, 1, name + ' ' + mark);
  }
  assert.equal(patched.split(';try{await t}finally{fo===t&&(fo=null)}').length - 1, 1, name);
  assert.equal(patched.split('fo=t;__wuwatappoChestXoStart(t);').length - 1, 1, name);
  assert.equal(patched.split(',fo)return fo;').length - 1, source.split(',fo)return fo;').length - 1, name);
  assert.equal(patched.split('fo=').length - 1, source.split('fo=').length - 1 + 1, 'only the expiry clears the slot');
  for (const target of ['_r', 'Ti', 'Ua', 'Va']) {
    assert.equal(patched.split(target + '=').length - 1, source.split(target + '=').length - 1, target);
  }
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
});

test('preparation registers the in-flight guard on the same room bundle', () => {
  const prepare = readFileSync(path.join(root, 'scripts', 'prepare-frontend.mjs'), 'utf8');
  assert.ok(prepare.includes("patchOne('treasure chest in-flight refresher', (_, content) => /let [$\\w]+=null,[$\\w]+=!1,[$\\w]+=!1;async function [$\\w]+\\([$\\w]+\\)\\{/.test(content), patchMacChestXoGuard);"));
});

test('the call-time gate is remembered per call, apart from the live status', async () => {
  const h = xoHarness({ status: 'offline' });
  await h.context.Xo({ force: true });
  assert.deepEqual([h.view().gateAtCall, h.view().skips], ['offline', 1]);
  h.context.nt.value.status = 'online';
  await h.context.Xo({ force: true });
  assert.deepEqual([h.view().gateAtCall, h.view().skips], ['online', 1], 'an online entry is not a skip');
  h.context.nt.value.status = 'degraded';
  assert.equal(h.view().gateAtCall, 'online', 'the last call is remembered, not the live status');
  assert.equal(h.view().gate, 'degraded', 'while the live field follows the store');
});

test('unknown is accepted as usable, exactly like the stock gate branch', async () => {
  const h = xoHarness({ status: 'unknown' });
  await h.context.Xo({ force: true });
  assert.deepEqual([h.view().gateAtCall, h.view().skips], ['unknown', 0]);
});

test('a call handed the in-flight promise is not counted as a gate skip', () => {
  const h = xoHarness({ status: 'offline', body: () => new Promise(() => {}) });
  h.context.Xo({ force: true });
  assert.deepEqual([h.view().calls, h.view().runs, h.view().skips], [1, 1, 1]);
  h.context.Xo({ force: true });
  assert.deepEqual([h.view().calls, h.view().runs, h.view().skips], [2, 1, 1], 'the handed-over call never reaches the body');
});

test('onlineAt records the first observation of an online store and is never rewritten', () => {
  const h = xoHarness({ status: 'offline' });
  assert.equal(h.view().onlineAt, null);
  h.context.nt.value.status = 'online';
  assert.equal(h.view().onlineAt, 1700000000000);
  h.wall.value += 5e3;
  h.context.nt.value.status = 'degraded';
  assert.equal(h.view().onlineAt, 1700000000000);
  h.context.nt.value.status = 'online';
  assert.equal(h.view().onlineAt, 1700000000000, 'the first observation stays the first');
});
