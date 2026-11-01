import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { MAC_CHEST_CLICK_DIAG_MARK, MAC_CHEST_DIAGNOSTICS_MARK, patchMacChestClickDiagnostics, patchMacChestStateDiagnostics } from '../scripts/patch-frontend.mjs';

// One switch, three write points: the five second state snapshot, the claim record inside the
// claim path and the failed-click record. This fixture carries every anchor both patchers pin, so
// a single build can be driven through all three at once without a real page.
const handler = 'async function pc(e){if(Ie()){mt($("update_force_lock_hint"));return}if(Fn.value||kt.value)return;const t=e==="left"?Ei:Oi,o=e==="left"?xi:Fi;const f=Up(e);Fn.value=!0;let b=!1;try{b=!0;await Pm(e)}catch(M){try{await f}catch{}if(console.warn("[chest] openChest failed",M),b){me("reward:claim_failed");const j=od(M);j!=null?go(String(j)):go("api_error")}an(M)}finally{Fn.value=!1}}';
const cpFn = 'function Cp(e){const t=performance.now()+fr;e==="left"?(kr=t,Nt.value=fr,Po.value=fr):(Cr=t,Ht.value=fr,To.value=fr)}';

const fixture = [
  'const Nt=W(0),Ht=W(0),Po=W(0),To=W(0),Fn=W(!1);',
  'const Gy=400,fr=30*6e4;',
  'const Ns=1e3,Yy=2e3;',
  'const{localClickCount:ue,totalClickCount:Re}=fm(R);',
  // The mount and chest-ready flags are exposed so the harness can settle the button gate; the
  // boolean each one starts on is the one the patchers pin by name.
  'const Mi=W(!0);globalThis.__mi=Mi;const br=W(!1);let Mo=0;const Qn=W(!1),kt=pe(()=>Mi.value||br.value||R.isLoggedIn&&!Qn.value);globalThis.__qn=Qn;',
  'const Wn=pe(()=>kt.value||!R.isLoggedIn?!0:Nt.value<=0),Gn=pe(()=>kt.value||!R.isLoggedIn?!0:Ht.value<=0),Ta=pe(()=>kt.value||!R.isLoggedIn?!0:Re.value>=Ns),Fp=pe(()=>kt.value||!R.isLoggedIn?!1:Re.value>=Ns&&Re.value<Yy),Kr=pe(()=>Fp.value?Wn.value?"left":"right":null);',
  'const zr=pe(()=>!0),jr=pe(()=>!1);',
  'function Dp(){return kt.value||Fn.value||!Ta.value?!1:!!(zr.value&&Wn.value||jr.value&&Gn.value)}',
  'let kr=null,Cr=null;',
  'function is(){return 0}function co(e,t=is()){const o=Number(e);return o<=0?0:Math.max(0,o-t)}',
  'function Vn(){const e=is(),t=performance.now();Nt.value=kr===null?co(R.userInfo?.left_treasure_chest,e):Math.max(0,kr-t),Ht.value=Cr===null?co(R.userInfo?.right_treasure_chest,e):Math.max(0,Cr-t)}',
  cpFn,
  handler,
  'globalThis.__click=pc;',
  '',
].join('');

const patched = patchMacChestStateDiagnostics(patchMacChestClickDiagnostics(fixture));

function harness(storage) {
  const entries = new Map(Object.entries(storage));
  const timers = [];
  const calls = [];
  const ref = value => ({ value });
  const error = Object.assign(new Error('chest cooling down'), { code: '70002' });
  const context = {
    R: { isLoggedIn: true, totalClickCount: 1600, userInfo: { left_treasure_chest: 5000000, right_treasure_chest: null } },
    W: ref,
    pe: fn => ({ get value() { return fn(); } }),
    fm: () => ({ localClickCount: ref(0), totalClickCount: ref(1600) }),
    Ei: ref(!0), Oi: ref(!0), xi: ref(!1), Fi: ref(!1),
    Ie: () => false,
    $: key => key,
    mt: label => calls.push(['toast', label]),
    Up: () => Promise.resolve(),
    Pm: () => Promise.reject(error),
    me: name => calls.push(['event', name]),
    od: value => value?.code,
    go: code => calls.push(['go', code]),
    an: value => calls.push(['report', value]),
    console: { warn: () => {} },
    performance: { now: () => 0 },
    Date: { now: () => 1700000000000 },
    document: { hidden: false },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    localStorage: {
      getItem: key => (entries.has(key) ? entries.get(key) : null),
      setItem: (key, value) => entries.set(key, String(value)),
      removeItem: key => entries.delete(key),
    },
  };
  vm.createContext(context);
  vm.runInContext(patched, context);
  // Settling the button gate is what lets the stock click handler reach its request and its
  // failure branch; the patchers are not allowed to touch either flag.
  context.__mi.value = false;
  context.__qn.value = true;
  return {
    entries,
    calls,
    claim: side => context.Cp(side),
    click: side => context.__click(side),
    tick: () => timers[0].fn(),
    interval: () => timers[0].ms,
  };
}

async function drive(h) {
  h.claim('left');
  h.tick();
  await h.click('left');
  return h;
}

test('writing "on", or "1", arms the snapshot, the claim record and the click record together', async () => {
  for (const value of ['on', '1']) {
    const h = await drive(harness({ 'wuwa.chestDbg': value }));
    assert.equal(h.interval(), 5000, 'switch ' + JSON.stringify(value) + ' keeps the five second snapshot');
    const snapshot = JSON.parse(h.entries.get('wuwa.chestDbg'));
    assert.deepEqual([snapshot.tick, snapshot.anchorL], [1, 1800000], 'switch ' + JSON.stringify(value) + ' snapshot after the claim');
    const claim = JSON.parse(h.entries.get('wuwa.chestClaim'));
    assert.deepEqual(claim.map(entry => [entry.side, entry.anchorAfter]), [['left', 1800000]], 'switch ' + JSON.stringify(value) + ' claim record');
    const click = JSON.parse(h.entries.get('wuwa.chestClick'));
    assert.deepEqual(click.map(entry => [entry.side, entry.code]), [['left', '70002']], 'switch ' + JSON.stringify(value) + ' click record');
    assert.deepEqual([...h.entries.keys()].sort(), ['wuwa.chestClaim', 'wuwa.chestClick', 'wuwa.chestDbg']);
  }
});

test('unarmed, all three write points stay silent and the stock failure path is untouched', async () => {
  const armed = await drive(harness({ 'wuwa.chestDbg': 'on' }));
  assert.deepEqual(armed.calls.map(([kind]) => kind), ['event', 'go', 'report'], 'the stock failure branch still runs when armed');
  for (const value of [null, '', 'off', 'OFF ', 'yes', '0', '{"t":1}']) {
    const h = await drive(harness(value === null ? {} : { 'wuwa.chestDbg': value }));
    const label = 'switch ' + JSON.stringify(value);
    assert.deepEqual([...h.entries], value === null ? [] : [['wuwa.chestDbg', value]], label + ' writes no snapshot, no claim and no click');
    assert.deepEqual(h.calls.map(([kind]) => kind), armed.calls.map(([kind]) => kind), label + ' leaves the failure branch unchanged');
    assert.deepEqual(h.calls[1], ['go', '70002'], label + ' still dispatches the stock error code');
  }
});

test('each write point sits behind the switch it shares with the other two', () => {
  assert.equal(patched.split(MAC_CHEST_DIAGNOSTICS_MARK).length - 1, 1);
  assert.equal(patched.split(MAC_CHEST_CLICK_DIAG_MARK).length - 1, 1);
  assert.equal(patched.split('localStorage.getItem("wuwa.chestDbg")').length - 1, 2, 'one read per helper, none per tick');
  const guards = [
    ['if(!__wuwatappoChestDbgOn)return;', 2],
    ['if(!__wuwatappoChestClickOn)return;', 1],
  ];
  for (const [guard, count] of guards) assert.equal(patched.split(guard).length - 1, count, guard);
  const writes = ['localStorage.setItem("wuwa.chestDbg"', 'localStorage.setItem(__wuwatappoChestClaimKey', 'localStorage.setItem(__wuwatappoChestClickKey'];
  for (const write of writes) {
    assert.equal(patched.split(write).length - 1, 1, write + ' is written once');
    assert.ok(patched.indexOf(guardOf(write)) < patched.indexOf(write), write + ' is written after the switch was read');
  }
  assert.equal(patched.includes('!=="off"'), false, 'no default-on switch survives');
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
});

function guardOf(write) {
  return write.includes('ClickKey') ? 'if(!__wuwatappoChestClickOn)return;' : 'if(!__wuwatappoChestDbgOn)return;';
}
