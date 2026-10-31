import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'acorn';
import { assetDirectory, root, sourceFiles } from './frontend-context.mjs';
import { patchMacHideShortcutSettings } from '../scripts/patch-frontend.mjs';

const actions = ['togglePet', 'gameMode', 'switchScreen'];
const capture = (action, label) => `h(E,{action:"${action}",binding:A.value.${action},disabled:!O.value,label:p(t)("${label}"),onChange:F},null,8,["binding","disabled","label"]),`;
const petRow = `e("div",xa,[${capture('togglePet', 'setting_toggle_pet')}e("label",Ta,[e("input",{checked:v.petHidden,type:"checkbox"},null,8)])])`;
const gameRow = `e("div",Oa,[${capture('gameMode', 'setting_game_mode')}e("label",Ba,[e("input",{"onUpdate:modelValue":o[10]},null,8)])])`;
const screenRow = `e("div",_l,[${capture('switchScreen', 'setting_screen')}e("button",{type:"button"},null,8)])`;
const autoGameRow = 'e("div",Fa,[e("div",Da,[e("div",Ha,S(p(t)("setting_auto_game_mode_fullscreen")),1)]),e("div",Wa,[e("label",Ka,[e("input",{checked:v.auto},null,8)])])])';
const fixture = `function render(){return e("div",Jo,[${petRow},${gameRow},${screenRow},${autoGameRow}])}`;

test('each shortcut capture control is filtered out of its row exactly once', () => {
  const patched = patchMacHideShortcutSettings(fixture);
  const removed = [capture('togglePet', 'setting_toggle_pet'), capture('gameMode', 'setting_game_mode'), capture('switchScreen', 'setting_screen')];
  const expected = removed.reduce((source, call) => source.replace(call, ''), fixture);
  assert.equal(patched, expected);
  assert.equal(fixture.length - patched.length, removed.reduce((total, call) => total + call.length, 0));
  for (const call of removed) {
    assert.equal(fixture.split(call).length - 1, 1, call);
    assert.equal(patched.includes(call), false, call);
  }
  assert.equal(patched.includes('action:"'), false);
});

test('the rows keep their own switches and the other settings of the page stay intact', () => {
  const patched = patchMacHideShortcutSettings(fixture);
  for (const row of ['e("div",xa,[e("label",Ta,', 'e("div",Oa,[e("label",Ba,', 'e("div",_l,[e("button",{type:"button"}']) {
    assert.equal(patched.split(row).length - 1, 1, row);
  }
  assert.equal(patched.includes(autoGameRow), true);
  assert.equal((patched.match(/e\("div",/g) ?? []).length, (fixture.match(/e\("div",/g) ?? []).length);
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
});

test('a bundle without the capture controls stops preparation', () => {
  assert.throws(() => patchMacHideShortcutSettings(''), /Original shortcut capture controls changed; found 0 of 3 \(none\)/);
  assert.throws(() => patchMacHideShortcutSettings('function render(){return e("div",Jo,[])}'), /found 0 of 3/);
});

test('a bundle that lost one of the three capture controls stops preparation', () => {
  const partial = fixture.replace(capture('gameMode', 'setting_game_mode'), '');
  assert.throws(() => patchMacHideShortcutSettings(partial), /Original shortcut capture controls changed; found 2 of 3 \(togglePet, switchScreen\)/);
  assert.throws(() => patchMacHideShortcutSettings(fixture.replace('action:"switchScreen"', 'action:"otherScreen"')), /found 2 of 3/);
});

test('an already hidden bundle stops preparation instead of filtering twice', () => {
  const patched = patchMacHideShortcutSettings(fixture);
  assert.throws(() => patchMacHideShortcutSettings(patched), /Original shortcut capture controls changed; found 0 of 3 \(none\)/);
});

test('the shipped settings view exposes exactly the three capture controls and survives the filter', () => {
  const matches = sourceFiles()
    .map(name => ({ name, source: readFileSync(path.join(assetDirectory, name), 'utf8') }))
    .filter(({ source }) => source.includes('action:"switchScreen"'));
  assert.equal(matches.length, 1);
  const [{ name, source }] = matches;
  const flags = 'null,8,["binding","disabled","label"])';
  for (const action of actions) assert.equal(source.split(`{action:"${action}",`).length - 1, 1, action);
  const patched = patchMacHideShortcutSettings(source);
  for (const action of actions) assert.equal(patched.split(`{action:"${action}",`).length - 1, 0, action);
  assert.equal(source.split(flags).length - patched.split(flags).length, 3);
  for (const anchor of ['setting_auto_game_mode_fullscreen', 'setting_auto_game_mode_fullscreen_tip', 'setting_toggle_pet_tip', 'setting_pet_scale', 'setting_screen_tips', 'setting_window_penetrate', 'class:"setting-switch"', 'class:"setting-item"']) {
    assert.equal(patched.split(anchor).length - 1, source.split(anchor).length - 1, anchor);
  }
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
  const prepare = readFileSync(path.join(root, 'scripts', 'prepare-frontend.mjs'), 'utf8');
  assert.ok(prepare.includes("patchOne('shortcut settings view', (_, content) => content.includes('action:\"switchScreen\"'), patchMacHideShortcutSettings);"), name);
});
