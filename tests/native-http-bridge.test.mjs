import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { findSource, profile, root } from './frontend-context.mjs';
import { MAC_NATIVE_HTTP_MARK, NATIVE_HTTP_CLIENT, NATIVE_HTTP_CLIENT_PATCHED, patchMacNativeHttpAdapter } from '../scripts/patch-frontend.mjs';

const script = await readFile(new URL('../scripts/mac-http.js', import.meta.url), 'utf8');
const HOST = 'https://api-mc-wuwatappo.kurogames-global.com';
const NETWORK_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ERR_NETWORK', 'ERR_CANCELED', 'ECONNRESET', 'ENOTFOUND']);
const base64 = text => Buffer.from(text, 'utf8').toString('base64');
const plain = value => JSON.parse(JSON.stringify(value));

function options(adapter) {
  const start = NATIVE_HTTP_CLIENT_PATCHED.indexOf('new Request(') + 'new Request('.length;
  const end = NATIVE_HTTP_CLIENT_PATCHED.lastIndexOf('});/*') + 1;
  const window = adapter === undefined ? {} : { __WUWATAPPO_HTTP_ADAPTER__: adapter };
  return vm.runInNewContext('(' + NATIVE_HTTP_CLIENT_PATCHED.slice(start, end) + ')', { window, HOST });
}

function harness({ core = true, reject = null } = {}) {
  const calls = [], warnings = [];
  let pending = null, closed = 0;
  class Channel {
    constructor(callback) { this.callback = callback; this.cleanupCallback = () => { closed += 1 } }
  }
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (reject) throw reject;
    if (command === 'native_http_request') pending = args;
    return null;
  };
  const env = vm.createContext({
    window: { __TAURI__: core ? { core: { invoke, Channel } } : undefined },
    document: { readyState: 'complete', addEventListener() {} },
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    TextDecoder,
    setTimeout,
    clearTimeout,
    console: { warn: message => warnings.push(String(message)) },
  });
  vm.runInContext(script, env);
  return { adapter: env.window.__WUWATAPPO_HTTP_ADAPTER__, calls, warnings, closed: () => closed, pending: () => pending };
}

async function exchange(host, config, events = [{ type: 'head', status: 200, headers: [] }, { type: 'done', bytes: 0 }]) {
  const settled = host.adapter(config).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  await new Promise(resolve => setImmediate(resolve));
  const request = host.pending();
  for (const event of events) request?.events.callback?.(event);
  const outcome = await settled;
  return { request, ...outcome };
}

test('the shipped client is wired once and every other byte is preserved', () => {
  const { source } = findSource(content => content.includes(NATIVE_HTTP_CLIENT));
  assert.equal(source.split(NATIVE_HTTP_CLIENT).length - 1, 1);
  const patched = patchMacNativeHttpAdapter(source);
  assert.equal(patched, source.replace(NATIVE_HTTP_CLIENT, NATIVE_HTTP_CLIENT_PATCHED));
  assert.equal(patched.split(MAC_NATIVE_HTTP_MARK).length - 1, 1);
  assert.equal(patched.split('__WUWATAPPO_HTTP_ADAPTER__').length - 1, 2);
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
});

test('the prepared region bundle carries the marker exactly once', async () => {
  const main = findSource(source => source.includes(`const APP_REGION="${profile.region}"`));
  const prepared = await readFile(path.join(root, profile.preparedDir, 'assets', main.name), 'utf8');
  assert.equal(prepared.split(MAC_NATIVE_HTTP_MARK).length - 1, 1);
  assert.equal(prepared.split('window.__WUWATAPPO_HTTP_ADAPTER__').length - 1, 2);
  assert.ok(prepared.includes('adapter:window.__WUWATAPPO_HTTP_ADAPTER__'));
});

test('a bundle without the upstream client stops preparation', () => {
  assert.throws(() => patchMacNativeHttpAdapter(''), /Expected 1 original jsonp client, found 0/);
  assert.throws(() => patchMacNativeHttpAdapter(NATIVE_HTTP_CLIENT + NATIVE_HTTP_CLIENT), /found 2/);
});

test('an already wired client stops preparation instead of stacking adapters', () => {
  assert.throws(() => patchMacNativeHttpAdapter(patchMacNativeHttpAdapter(NATIVE_HTTP_CLIENT)), /already wired; reconcile the patch order/);
});

test('without the injection script the client keeps the stock options', () => {
  const stock = options(undefined);
  assert.deepEqual({ ...stock }, { timeout: 10 * 1e3, baseURL: HOST });
  const bridge = () => {};
  const wired = options(bridge);
  assert.deepEqual(Object.keys(wired), ['timeout', 'baseURL', 'adapter']);
  assert.equal(wired.timeout, 10 * 1e3);
  assert.equal(wired.baseURL, HOST);
  assert.equal(wired.adapter, bridge);
});

test('the adapter repairs the bare-concatenated origin and forwards the allow-listed spec', async () => {
  const host = harness();
  const { request, ok, value } = await exchange(host, {
    method: 'get',
    url: HOST + 'api/common/activity-config?',
    baseURL: HOST,
    timeout: 10 * 1e3,
    headers: { 'X-BLM-FRID': 'synthetic', Authorization: 'Bearer token', Accept: 'application/json' },
  }, [
    { type: 'head', status: 200, headers: [['Content-Type', 'application/json']] },
    { type: 'chunk', data: base64('{"code":0}') },
    { type: 'done', bytes: 10 },
  ]);
  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].command, 'native_http_request');
  assert.match(host.calls[0].args.id, /^http-[a-z0-9]+-1$/);
  assert.deepEqual(plain(host.calls[0].args.spec), {
    method: 'GET',
    url: `${HOST}/api/common/activity-config`,
    headers: [['x-blm-frid', 'synthetic'], ['authorization', 'Bearer token'], ['accept', 'application/json']],
    body: null,
    timeoutMs: 10 * 1e3,
  });
  assert.equal(ok, true);
  assert.equal(value.data, '{"code":0}');
  assert.equal(value.status, 200);
  assert.equal(value.statusText, 'OK');
  assert.deepEqual(plain(value.headers), { 'content-type': 'application/json' });
  assert.equal(value.request.id, host.calls[0].args.id);
  assert.equal(value.request.url, `${HOST}/api/common/activity-config`);
  assert.equal(host.closed(), 1);
});

test('every shipped url shape resolves to the official origin', async () => {
  for (const [url, expected] of [
    [HOST + 'api/common/activity-config?', `${HOST}/api/common/activity-config`],
    [HOST + '/api/frontend/user/logout', `${HOST}/api/frontend/user/logout`],
    ['api/frontend/user/me', `${HOST}/api/frontend/user/me`],
    ['/api/frontend/user/me', `${HOST}/api/frontend/user/me`],
    [HOST, `${HOST}/`],
  ]) {
    const { ok, value } = await exchange(harness(), { url, baseURL: HOST });
    assert.equal(ok, true, url);
    assert.equal(value.request.url, expected, url);
  }
});

test('query params are appended once and a relative url without a base stops the request', async () => {
  const host = harness();
  const { ok, value } = await exchange(host, { url: HOST + '/api/x?', baseURL: HOST, params: { lang: 'zh', tag: ['a', 'b'] } });
  assert.equal(ok, true);
  assert.equal(value.request.url, `${HOST}/api/x?lang=zh&tag=a&tag=b`);
  const orphan = await exchange(harness(), { url: 'api/x' });
  assert.equal(orphan.ok, false);
  assert.match(orphan.error.message, /only allows absolute https URLs/);
  const binary = await exchange(harness(), { url: HOST + '/api/x', baseURL: HOST, data: new Uint8Array([1, 2, 3]) });
  assert.equal(binary.ok, false);
  assert.match(binary.error.message, /does not support binary request bodies/);
});

test('a 4xx rejects with the transport intact so the 401 branch still runs', async () => {
  const host = harness();
  const { ok, error } = await exchange(host, { method: 'post', url: HOST + '/api/frontend/user/logout', baseURL: HOST, data: { synthetic: true } }, [
    { type: 'head', status: 401, headers: [['X-Request-Id', 'synthetic'], ['Content-Type', 'application/json']] },
    { type: 'chunk', data: base64('{"code":401,"message":"Expired"}') },
    { type: 'done', bytes: 30 },
  ]);
  assert.equal(host.calls[0].args.spec.body, '{"synthetic":true}');
  assert.equal(ok, false);
  assert.equal(error.message, 'Request failed with status code 401');
  assert.equal(error.code, 'ERR_BAD_REQUEST');
  assert.equal(error.isAxiosError, true);
  assert.equal(NETWORK_CODES.has(error.code), false);
  assert.equal(error.response.status, 401);
  assert.equal(error.response.data, '{"code":401,"message":"Expired"}');
  assert.equal(error.response.headers['x-request-id'], 'synthetic');
  assert.deepEqual(Object.keys(error.response.headers), ['x-request-id', 'content-type']);
  assert.equal(error.response.config, error.config);
});

test('a 5xx rejects as a server error and an overriding validateStatus resolves it', async () => {
  const events = [
    { type: 'head', status: 503, headers: [['Retry-After', '30']] },
    { type: 'chunk', data: base64('{"code":503}') },
    { type: 'done', bytes: 12 },
  ];
  const failed = await exchange(harness(), { url: `${HOST}/api/x`, baseURL: HOST }, events);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'ERR_BAD_RESPONSE');
  assert.equal(failed.error.response.status, 503);
  assert.equal(failed.error.response.headers['retry-after'], '30');
  const tolerated = await exchange(harness(), { url: `${HOST}/api/x`, baseURL: HOST, validateStatus: () => true }, events);
  assert.equal(tolerated.ok, true);
  assert.equal(tolerated.value.status, 503);
});

test('a transport failure stays a network error and never becomes a response', async () => {
  const host = harness();
  const { ok, error } = await exchange(host, { url: `${HOST}/api/frontend/user/me`, baseURL: HOST }, [
    { type: 'error', message: 'Network Error', kind: 'network' },
  ]);
  assert.equal(ok, false);
  assert.equal(error.code, 'ERR_NETWORK');
  assert.equal(error.message, 'Network Error');
  assert.equal(NETWORK_CODES.has(error.code), true);
  assert.equal(error.response, undefined);
});

test('a stalled bridge times out with the axios timeout contract', async () => {
  const { ok, error } = await exchange(harness(), { url: `${HOST}/api/x`, baseURL: HOST, timeout: 10 * 1e3 }, [
    { type: 'error', message: 'timeout of 10000ms exceeded', kind: 'timeout' },
  ]);
  assert.equal(ok, false);
  assert.equal(error.code, 'ETIMEDOUT');
  assert.equal(error.message, 'timeout of 10000ms exceeded');
});

test('an aborted signal cancels the native request and reports a cancellation', async () => {
  const host = harness();
  const controller = new AbortController();
  const settled = host.adapter({ url: `${HOST}/api/x`, baseURL: HOST, signal: controller.signal })
    .then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const { ok, error } = await settled;
  assert.equal(ok, false);
  assert.equal(error.code, 'ERR_CANCELED');
  assert.equal(error.__CANCEL__, true);
  assert.equal(error.name, 'CanceledError');
  const aborts = host.calls.filter(call => call.command === 'native_http_abort');
  assert.equal(aborts.length, 1);
  assert.equal(aborts[0].args.id, host.calls[0].args.id);
  assert.equal(host.closed(), 1);
  const pre = new AbortController();
  pre.abort();
  const early = await host.adapter({ url: `${HOST}/api/x`, baseURL: HOST, signal: pre.signal })
    .then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  assert.equal(early.ok, false);
  assert.equal(early.error.code, 'ERR_CANCELED');
  assert.equal(host.calls.filter(call => call.command === 'native_http_request').length, 1);
});

test('a rejected command surfaces the native reason instead of a generic network error', async () => {
  const host = harness({ reject: 'HTTP header is not allowed: x-evil' });
  const { ok, error } = await exchange(host, { url: HOST + '/api/x', baseURL: HOST });
  assert.equal(ok, false);
  assert.equal(error.code, 'ERR_NETWORK');
  assert.equal(error.message, 'HTTP header is not allowed: x-evil');
  assert.equal(host.warnings.length, 1);
  assert.match(host.warnings[0], /Native HTTP bridge rejected the request/);
});

test('a webview without the native core fails loudly instead of hanging', async () => {
  const host = harness({ core: false });
  const { ok, error } = await exchange(host, { url: `${HOST}/api/x`, baseURL: HOST });
  assert.equal(ok, false);
  assert.equal(error.code, 'ERR_NETWORK');
  assert.equal(host.calls.length, 0);
  assert.equal(host.warnings.length, 1);
  assert.match(host.warnings[0], /Native HTTP bridge is unavailable/);
});
