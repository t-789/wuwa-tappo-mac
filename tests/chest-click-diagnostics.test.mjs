import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { findSource } from './frontend-context.mjs';
import { MAC_CHEST_CLICK_DIAG_MARK, patchMacChestClickDiagnostics } from '../scripts/patch-frontend.mjs';

const renderGate = 'function Dp(){return kt.value||Fn.value||!Ta.value?!1:!!(zr.value&&Wn.value||jr.value&&Gn.value)}';
const handler = 'async function pc(e){if(Ie()){mt($("update_force_lock_hint"));return}if(Fn.value||kt.value)return;const t=e==="left"?Ei:Oi,o=e==="left"?xi:Fi;const f=Up(e);Fn.value=!0;let b=!1;try{b=!0;await Pm(e)}catch(M){try{await f}catch{}if(console.warn("[chest] openChest failed",M),b){me("reward:claim_failed");const j=od(M);j!=null?go(String(j)):go("api_error")}an(M)}finally{Fn.value=!1}}';

const fixture = [
  'const Nt=W(0),Ht=W(0),Fn=W(!1);',
  'const Ns=1e3,Yy=2e3;',
  'const{localClickCount:ue,totalClickCount:Re}=fm(R);',
  // The mount and login flags are settled so the stock handler runs through to its request.
  'const Mi=W(!1),br=W(!1);let Mo=0;const Qn=W(!0),kt=pe(()=>Mi.value||br.value||R.isLoggedIn&&!Qn.value);',
  'const Wn=pe(()=>kt.value||!R.isLoggedIn?!0:Nt.value<=0),Gn=pe(()=>kt.value||!R.isLoggedIn?!0:Ht.value<=0),Ta=pe(()=>kt.value||!R.isLoggedIn?!0:Re.value>=Ns),Fp=pe(()=>kt.value||!R.isLoggedIn?!1:Re.value>=Ns&&Re.value<Yy),Kr=pe(()=>Fp.value?Wn.value?"left":"right":null);',
  'const zr=pe(()=>!0),jr=pe(()=>!1);',
  renderGate,
  'let kr=null,Cr=null;',
  'function is(){return 0}function co(e,t=is()){const o=Number(e);return o<=0?0:Math.max(0,o-t)}',
  'function Vn(){const e=is(),t=performance.now();Nt.value=kr===null?co(R.userInfo?.left_treasure_chest,e):Math.max(0,kr-t),Ht.value=Cr===null?co(R.userInfo?.right_treasure_chest,e):Math.max(0,Cr-t)}',
  handler,
  'globalThis.__click=pc;',
  '',
].join('');

function harness({ storage = {}, wall = 1700000000000, failStore = false, failure = null } = {}) {
  const entries = new Map(Object.entries(storage));
  const calls = [];
  const ref = value => ({ value });
  const error = failure ?? Object.assign(new Error('chest cooling down'), { code: '70002' });
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
    Date: { now: () => wall },
    localStorage: {
      getItem: key => (entries.has(key) ? entries.get(key) : null),
      setItem: (key, value) => {
        if (failStore) throw new Error('quota exceeded');
        entries.set(key, String(value));
      },
      removeItem: key => entries.delete(key),
    },
  };
  vm.createContext(context);
  vm.runInContext(patchMacChestClickDiagnostics(fixture), context);
  return { context, entries, calls, error, records: () => JSON.parse(entries.get('wuwa.chestClick') ?? '[]') };
}

test('the recorder is the only change and it sits ahead of the stock code dispatch', () => {
  const patched = patchMacChestClickDiagnostics(fixture);
  assert.equal(patched.split(MAC_CHEST_CLICK_DIAG_MARK).length - 1, 1);
  assert.equal(patched.split('__wuwatappoChestClickRecord(').length - 1, 2, 'one definition and one call site');
  assert.equal(patched.includes('const j=od(M);__wuwatappoChestClickRecord(e,j,M);j!=null?go(String(j)):go("api_error")'), true);
  const head = fixture.slice(0, fixture.indexOf('async function pc('));
  const tail = fixture.slice(fixture.indexOf('async function pc('))
    .replace('const j=od(M);j!=null?', 'const j=od(M);__wuwatappoChestClickRecord(e,j,M);j!=null?');
  assert.equal(patched.startsWith(head), true, 'nothing above the handler moved');
  assert.equal(patched.endsWith(tail), true, 'nothing below the handler moved');
  const inserted = patched.slice(head.length, patched.length - tail.length);
  assert.equal(inserted.startsWith('/* ' + MAC_CHEST_CLICK_DIAG_MARK + ':'), true);
  assert.equal(inserted.trimEnd().endsWith('}'), true);
  parse(patched, { ecmaVersion: 'latest', sourceType: 'module' });
});

test('a failed click records the shape the diagnosis needs', async () => {
  const { context, calls, records, error } = harness();
  assert.equal(await context.__click('left'), undefined);
  const [entry, ...rest] = records();
  assert.equal(rest.length, 0);
  assert.deepEqual({ ...entry }, {
    t: 1700000000000,
    side: 'left',
    code: '70002',
    message: 'chest cooling down',
    raw: 5000000,
    remaining: 0,
    anchor: true,
    clicks: 1600,
    need: 1000,
  });
  assert.deepEqual(calls.map(([kind]) => kind), ['event', 'go', 'report']);
  assert.deepEqual(calls[1], ['go', '70002']);
  assert.deepEqual(calls[2][1], error, 'the stock reporter still gets the error it always got');
});

test('the recorded side follows the clicked chest', async () => {
  const { context, records } = harness();
  await context.__click('right');
  await context.__click('left');
  const [right, left] = records();
  assert.equal(right.side, 'right');
  assert.equal(right.raw, null, 'a null userInfo deadline is recorded as null');
  assert.equal(right.anchor, true);
  assert.equal(left.side, 'left');
  assert.equal(left.raw, 5000000);
});

test('only the last three failures are kept', async () => {
  const { context, records } = harness({ wall: 1700000000000 });
  for (const side of ['left', 'right', 'left', 'right']) await context.__click(side);
  const kept = records();
  assert.equal(kept.length, 3);
  assert.deepEqual(kept.map(entry => entry.side), ['right', 'left', 'right']);
  assert.deepEqual(kept.map(entry => entry.t), [1700000000000, 1700000000000, 1700000000000]);
});

test('a code the server did not send is recorded as null', async () => {
  const { context, records, calls } = harness({ failure: new Error('network down') });
  await context.__click('left');
  assert.equal(records()[0].code, null);
  assert.equal(records()[0].message, 'network down');
  assert.deepEqual(calls.map(([kind]) => kind), ['event', 'go', 'report'], 'the api_error branch still runs');
});

test('the message is cut at two hundred characters', async () => {
  const { context, records } = harness({ failure: Object.assign(new Error('x'.repeat(500)), { code: 70003 }) });
  await context.__click('left');
  const [entry] = records();
  assert.equal(entry.message.length, 200);
  assert.equal(entry.code, 70003);
});

test('a throwing store never escapes into the failure path', async () => {
  const { context, calls, error } = harness({ failStore: true });
  assert.equal(await context.__click('left'), undefined);
  assert.deepEqual(calls.map(([kind]) => kind), ['event', 'go', 'report']);
  assert.deepEqual(calls[2][1], error);
});

test('a store holding junk is replaced instead of throwing', async () => {
  const { context, records } = harness({ storage: { 'wuwa.chestClick': '{"not":"a list"}' } });
  await context.__click('left');
  assert.equal(records().length, 1);
  const broken = harness({ storage: { 'wuwa.chestClick': 'not json at all' } });
  await broken.context.__click('left');
  assert.equal(broken.records().length, 1);
});

test('the shipped bundle takes the patcher unchanged', () => {
  const { source } = findSource(content => content.includes('[chest] openChest failed'));
  const patched = patchMacChestClickDiagnostics(source);
  assert.equal(patched.split(MAC_CHEST_CLICK_DIAG_MARK).length - 1, 1);
  assert.equal(patched.split('__wuwatappoChestClickRecord(').length - 1, 2);
  parse(patched, { ecmaVersion: 'latest', sourceType: 'module' });
  assert.throws(() => patchMacChestClickDiagnostics(patched), /already applied/);
});
