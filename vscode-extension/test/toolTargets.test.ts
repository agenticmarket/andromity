import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { getToolTargetSummary, getToolTargetsScript } from '../src/providers/chatview/toolTargets.js';

test('targets preserve exact paths and commands without guessing unknown tools', () => {
  assert.equal(getToolTargetSummary('list_dir', '{"path":"src/andromity"}'), 'src/andromity');
  assert.equal(getToolTargetSummary('read_file', {file_path:'package.json'}), 'package.json');
  assert.equal(getToolTargetSummary('shell_exec', {command:'npm test'}), 'npm test');
  assert.equal(getToolTargetSummary('mcp__unknown', {path:'secret'}), '');
  assert.equal(getToolTargetSummary('list_dir', '{"path":'), '');
  assert.equal(getToolTargetSummary('list_dir', {path:42}), '');
  assert.equal(getToolTargetSummary('list_dir', {}), '');
});
test('browser helper executes independently and preserves escaped Windows paths', () => {
  const result = vm.runInNewContext(getToolTargetsScript() + '; getToolTargetSummary("read_file", raw)', {raw:JSON.stringify({path:'D:\\project\\app.py'})});
  assert.equal(result, 'D:\\project\\app.py');
});
