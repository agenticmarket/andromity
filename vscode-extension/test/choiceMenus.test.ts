import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/providers/chatview/chatClientScript.ts', 'utf8');
test('choice menus support arrow navigation, endpoints, Escape and focus return', () => {
  const code = source.slice(source.indexOf('    function prepareChoiceMenu('), source.indexOf('    prepareChoiceMenu(modePopover'));
  let focused = 0;
  let handler: (event: any) => void = () => {};
  const items = [0,1,2,3].map(index => ({focus: () => {focused = index;}}));
  let returned = false;
  const trigger = {setAttribute() {}, classList:{remove() {}}, focus:() => {returned = true;}};
  const menu = {style:{display:'flex'}, insertAdjacentHTML() {}, querySelectorAll:() => items, addEventListener:(_key: string, callback: any) => {handler = callback;}};
  vm.runInNewContext(code + '\nprepareChoiceMenu(menu, trigger, "note");', {menu, trigger, document:{get activeElement() {return items[focused];}}});
  const press = (key: string) => handler({key, preventDefault() {}});
  press('ArrowUp'); assert.equal(focused, 3);
  press('ArrowDown'); assert.equal(focused, 0);
  press('End'); assert.equal(focused, 3);
  press('Home'); assert.equal(focused, 0);
  press('Escape'); assert.equal(menu.style.display, 'none'); assert.ok(returned);
});

test('permission change during a running turn reports next-turn timing after acknowledgement', async () => {
  const provider = readFileSync('src/providers/ChatViewProvider.ts', 'utf8');
  const block = provider.slice(provider.indexOf('      case "cycle_mode": {'), provider.indexOf('      case "cycle_profile":'))
    .replace(/^\s*case "cycle_mode": \{/, '').replace(/break;\s*\}\s*$/, '');
  const events: any[] = [];
  const notices: string[] = [];
  const host = {_currentMode:'trust', _isExecuting:true, _rpcClient:{call:async () => ({})}, _postToWebview:(event: any) => events.push(event)};
  const vscode = {workspace:{getConfiguration:() => ({update:async () => {}})}, ConfigurationTarget:{Global:1}, window:{showInformationMessage:(text: string) => notices.push(text)}};
  await vm.runInNewContext('(async function() {' + block + '}).call(host)', {host, vscode, message:{nextMode:'full'}, SettingsPanel:{currentPanel:null}});
  assert.equal(events[0].value, 'full');
  assert.equal(events[0].appliesNextTurn, true);
  assert.match(events[0].notice, /next turn/);
  assert.match(events[0].notice, /pending approvals/);
  assert.equal(notices[0], events[0].notice);
});
