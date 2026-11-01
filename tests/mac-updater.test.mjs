import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { patchMacUpdater } from '../scripts/patch-frontend.mjs';

const failure = 'if(logDiagnostic("UPDATE","check_failed",{stage:"check",reason_code:diagnosticErrorCode(t),fallback:e?.interactive?"report_error":"treat_as_latest"},"warn"),e?.interactive)return{kind:"error",message:n};try{const s=await getVersion();return console.warn("[updater] check skipped (treat as latest)",t),{kind:"none",currentVersion:s}}catch{return{kind:"error",message:n}}';
const source = `
async function resolveUpdaterLatestJsonUrl(){const e=resolveUpdaterLatestHostJsonUrl();if(!e)return null;return e}
async function checkForAppUpdate(e){try{throw new Error("offline")}catch(t){const n=t.message;${failure}}}
({resolveUpdaterLatestJsonUrl,checkForAppUpdate})`;

function runtime(initialHost, config, { version = null } = {}) {
  let host = initialHost;
  let reads = 0;
  const logs = [];
  const warnings = [];
  const api = vm.runInNewContext(patchMacUpdater(source), {
    resolveUpdaterLatestHostJsonUrl: () => host && `${host}/app/json-host/latest_host.json`,
    activityInfo: async () => { reads += 1; return config; },
    unwrapApiData: value => value.data,
    LOCAL_ROLE_ASSETS_HOST: '__local_role_assets__',
    setUpdaterAssetsHost: (value, options) => { assert.equal(options.triggerSilentCheck, false); host = value; },
    logDiagnostic: (...args) => logs.push(args),
    diagnosticErrorCode: () => 'network',
    getVersion: () => {
      if (version === null) throw new Error('A failed check must not be treated as latest');
      return version;
    },
    console: { warn: (...args) => warnings.push(args) },
  });
  return { api, logs, warnings, reads: () => reads };
}

test('an uninitialized auxiliary window gets its update host from the official config', async () => {
  const context = runtime('', { data: { assets_host: 'https://official.example' } });
  assert.equal(await context.api.resolveUpdaterLatestJsonUrl(), 'https://official.example/app/json-host/latest_host.json');
  assert.equal(context.reads(), 1);
  await context.api.resolveUpdaterLatestJsonUrl();
  assert.equal(context.reads(), 1);
});

test('an existing update host needs no additional config request', async () => {
  const context = runtime('https://existing.example');
  assert.equal(await context.api.resolveUpdaterLatestJsonUrl(), 'https://existing.example/app/json-host/latest_host.json');
  assert.equal(context.reads(), 0);
});

test('missing or local-only config is an explicit failure', async () => {
  for (const host of ['', '__local_role_assets__']) {
    const context = runtime('', { data: { assets_host: host } });
    await assert.rejects(context.api.resolveUpdaterLatestJsonUrl(), /官方配置缺少更新资源地址/);
  }
});

test('the patch ships the upstream failure branch word for word and stops on any drift', () => {
  const patched = patchMacUpdater(source);
  assert.equal(patched.split(failure).length - 1, 1, 'the upstream branch is left exactly as shipped');
  assert.equal(patched.includes('fallback:"report_error"},'), false, 'the fixed report_error fallback is not written back');
  assert.equal(patched.includes('return logDiagnostic("UPDATE","check_failed"'), false, 'nothing is prepended to the upstream return');
  assert.throws(() => patchMacUpdater(source.replace(failure, failure.replace('"treat_as_latest"', '"report_error"'))), /Original updater flow changed; reconcile the Mac update path before building/);
  assert.throws(() => patchMacUpdater(source.replace('const e=resolveUpdaterLatestHostJsonUrl();', 'const e=resolveUpdaterLatestHostUrl();')), /Original updater flow changed; reconcile the Mac update path before building/);
});

test('a silent failed check is treated as latest, an interactive one is still reported', async () => {
  const silent = runtime('https://existing.example', undefined, { version: '1.0.3' });
  const skipped = await silent.api.checkForAppUpdate({ interactive: false });
  assert.deepEqual([skipped.kind, skipped.currentVersion], ['none', '1.0.3']);
  assert.equal(silent.logs.length, 1);
  const [scope, event, fields, severity] = silent.logs[0];
  assert.deepEqual([scope, event, severity], ['UPDATE', 'check_failed', 'warn']);
  assert.deepEqual([fields.stage, fields.reason_code, fields.fallback], ['check', 'network', 'treat_as_latest']);
  assert.equal(silent.warnings.length, 1, 'the silent skip keeps the upstream console hint');
  assert.match(silent.warnings[0][0], /check skipped \(treat as latest\)/);

  const interactive = runtime('https://existing.example', undefined, { version: '1.0.3' });
  const reported = await interactive.api.checkForAppUpdate({ interactive: true });
  assert.deepEqual([reported.kind, reported.message], ['error', 'offline']);
  assert.equal(interactive.logs[0][2].fallback, 'report_error');
  assert.equal(interactive.warnings.length, 0, 'an interactive failure never claims to be the latest version');
});

test('a check without the interactive flag is silent, exactly like upstream', async () => {
  const context = runtime('https://existing.example', undefined, { version: '1.0.3' });
  const skipped = await context.api.checkForAppUpdate();
  assert.deepEqual([skipped.kind, skipped.currentVersion], ['none', '1.0.3']);
});

test('a failure that cannot even read the version stays an error on both paths', async () => {
  const context = runtime('https://existing.example');
  for (const interactive of [false, true]) {
    const result = await context.api.checkForAppUpdate({ interactive });
    assert.equal(result.kind, 'error');
    assert.equal(result.message, 'offline');
  }
  assert.equal(context.logs.length, 2);
  assert.deepEqual(context.logs.map(([, , fields]) => fields.fallback), ['treat_as_latest', 'report_error']);
});
