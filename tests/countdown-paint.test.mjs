import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'acorn';
import vm from 'node:vm';
import { patchMacCountdownPaintPolicy } from '../scripts/patch-frontend.mjs';

const entry = 'const __vite__mapDeps=(m=[]);const APP_REGION="CN";function boot(e){return e}\nexport{boot as b};\n';
const key = 'wuwa.countdownPaint';

function apply(source = entry) {
  return patchMacCountdownPaintPolicy(source);
}

test('countdown paint switch is appended to the entry module tail exactly once', () => {
  const patched = apply();
  for (const once of ['/* wuwa.countdownPaint diagnostic switch', 'const KEY="wuwa.countdownPaint"', ';(()=>{', 'data-wuwa-countdown-paint']) {
    assert.equal(patched.split(once).length - 1, 1, once);
  }
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
  assert.ok(patched.startsWith(entry));
  assert.ok(patched.indexOf('export{boot as b};') < patched.indexOf('new MutationObserver'));
  assert.equal(patched.trimEnd().endsWith('catch{}})();'), true);
  assert.equal(entry.includes(key), false);
  const injected = patched.slice(entry.length);
  assert.equal(/__TAURI|invoke\(/.test(injected), false);
});

test('missing or unfamiliar anchors stop preparation', () => {
  assert.throws(() => apply(''), /entry module not found/);
  assert.throws(() => apply('const other=1;\nexport{other as o};\n'), /entry module not found/);
  assert.throws(() => apply('const APP_REGION="CN";const value=1;\n'), /export tail changed/);
  assert.throws(() => apply('const APP_REGION="CN";\nexport{a};\nexport{b};\n'), /export tail changed/);
  assert.throws(() => apply('const APP_REGION="CN";const mid=1;const tail=2;'), /export tail changed/);
});

test('storage key and the whole mode table live in one injected constant', () => {
  const patched = apply();
  assert.ok(patched.includes('const KEY="wuwa.countdownPaint"'));
  for (const mode of ['no-shadow', 'no-svgfilter', 'no-mask', 'no-transition', 'hidden']) {
    assert.ok(patched.includes(`"${mode}":{`) || patched.includes(`${mode}:{`), mode);
  }
  assert.ok(patched.includes('default:null'));
  assert.ok(patched.includes('.reward-countdown__progress{filter:none!important}'));
  assert.ok(patched.includes('mask image[filter]'));
  assert.ok(patched.includes('path.reward-countdown__bar[mask]'));
  assert.ok(patched.includes('.reward-countdown__bar{transition:none!important}'));
  assert.ok(patched.includes('.reward-countdown{display:none!important}'));
  assert.ok(patched.includes('data-wuwa-countdown-paint'));
});

test('unset and default values return before touching the DOM', () => {
  const patched = apply();
  const early = patched.indexOf('if(!mode||mode==="default"||!Object.prototype.hasOwnProperty.call(MODES,mode))return;');
  assert.ok(early > 0);
  for (const later of ['createElement("style")', 'removeAttribute', 'new MutationObserver']) {
    assert.ok(patched.indexOf(later) > early, later);
  }
  assert.ok(patched.indexOf('localStorage.getItem(KEY)') < early);
  assert.ok(patched.indexOf('try{') < early && patched.trimEnd().endsWith('catch{}})();'));
});

test('the injected switch reads the native global before the storage key', () => {
  const patched = apply();
  const nativeAt = patched.indexOf('window.__WUWATAPPO_COUNTDOWN_PAINT__');
  const storageAt = patched.indexOf('localStorage.getItem(KEY)');
  assert.ok(nativeAt > 0 && storageAt > nativeAt);
  assert.ok(patched.includes('window.__WUWATAPPO_COUNTDOWN_PAINT__??localStorage.getItem(KEY)'));
  assert.equal(/__TAURI__|invoke\(/.test(patched.slice(patched.length - 1400)), false);
});

test('re-applying the switch is refused instead of injecting twice', () => {
  const patched = apply();
  assert.throws(() => apply(patched), /already applied/);
});

function runInjected(mode, nativeMode) {
  const patched = apply();
  const injected = patched.slice(patched.lastIndexOf(';(()=>{'));
  const storage = new Map();
  if (mode !== undefined) storage.set(key, mode);
  const windowObject = {};
  if (nativeMode !== undefined) windowObject.__WUWATAPPO_COUNTDOWN_PAINT__ = nativeMode;
  const calls = [];
  const root = {
    nodeType: 1,
    matches(selector) { calls.push(['matches', selector]); return false; },
    querySelectorAll(selector) { calls.push(['querySelectorAll', selector]); return []; },
    removeAttribute(name) { calls.push(['removeAttribute', name]); },
  };
  let style = null, observed = null;
  const env = vm.createContext({
    window: windowObject,
    localStorage: { getItem: name => storage.get(name) ?? null },
    document: {
      documentElement: root,
      head: { appendChild(node) { style = node; } },
      createElement() { return { textContent: '', dataset: {}, setAttribute(name, value) { this[name] = value; } }; },
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(node, options) { observed = { node, options }; }
    },
  });
  vm.runInContext(injected, env);
  return { calls, style, observed };
}

test('unset, default and unknown values are a true no-op at runtime', () => {
  for (const mode of [undefined, 'default', 'bogus', 'constructor']) {
    const { calls, style, observed } = runInjected(mode);
    assert.deepEqual(calls, [], String(mode));
    assert.equal(style, null, String(mode));
    assert.equal(observed, null, String(mode));
  }
});

test('a native launch override wins over the storage key, and stays a no-op when unset', () => {
  const nativeWins = runInjected('hidden', 'no-mask');
  assert.equal(nativeWins.style, null);
  assert.deepEqual(nativeWins.calls[0], ['matches', 'path.reward-countdown__bar[mask]']);
  const nativeDefaultWins = runInjected('hidden', 'default');
  assert.deepEqual(nativeDefaultWins.calls, []);
  assert.equal(nativeDefaultWins.style, null);
  assert.equal(nativeDefaultWins.observed, null);
  const storageOnly = runInjected('hidden', undefined);
  assert.equal(storageOnly.style.textContent, '.reward-countdown{display:none!important}');
});

test('each mode touches only its own paint knob', () => {
  const hidden = runInjected('hidden');
  assert.equal(hidden.style.textContent, '.reward-countdown{display:none!important}');
  assert.equal(hidden.style['data-wuwa-countdown-paint'], 'hidden');
  assert.equal(hidden.observed, null);
  const shadow = runInjected('no-shadow');
  assert.equal(shadow.style.textContent, '.reward-countdown__progress{filter:none!important}');
  const transition = runInjected('no-transition');
  assert.equal(transition.style.textContent, '.reward-countdown__bar{transition:none!important}');
  const mask = runInjected('no-mask');
  assert.equal(mask.style, null);
  assert.deepEqual(mask.calls[0], ['matches', 'path.reward-countdown__bar[mask]']);
  assert.equal(mask.observed.node.nodeType, 1);
  assert.equal(mask.observed.options.subtree, true);
  assert.equal(mask.observed.options.attributes, true);
  assert.deepEqual([...mask.observed.options.attributeFilter], ['filter', 'mask']);
  const svgFilter = runInjected('no-svgfilter');
  assert.deepEqual(svgFilter.calls[0], ['matches', 'mask image[filter]']);
  assert.equal(svgFilter.style, null);
});
