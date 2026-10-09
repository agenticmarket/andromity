import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import vm from 'node:vm';
import { getThinkingOrbsScript } from '../src/providers/chatview/thinkingOrbs.js';

test('orbs paint all selected states and stop for hidden, detached, and reduced-motion views', () => {
  let paints = 0;
  let queued = 0;
  let reduced = false;
  let visible = true;
  const ctx = {setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() { paints++; }, moveTo() {}, lineTo() {}, stroke() {}};
  const canvas = {dataset:{orbState:'connecting'}, getBoundingClientRect:() => ({width:20,height:20,top:visible ? 0 : 1000,bottom:visible ? 20 : 1020}), getContext:() => ctx};
  const document = {hidden:false, body:{classList:{contains:() => false}}, querySelectorAll:() => [canvas], addEventListener() {}};
  const sandbox = vm.createContext({document, innerHeight:800, matchMedia:() => ({get matches() { return reduced; }, addEventListener() {}}), requestAnimationFrame:() => ++queued, cancelAnimationFrame() {}});
  vm.runInContext(getThinkingOrbsScript(), sandbox);
  for (const state of ['connecting','weaving','composing']) {
    canvas.dataset.orbState = state;
    const before = paints;
    vm.runInContext('drawThinkingOrbs(1000)', sandbox);
    assert.ok(paints > before, state + ' should paint');
  }
  reduced = true;
  const beforeReduced = queued;
  vm.runInContext('drawThinkingOrbs(1100)', sandbox);
  assert.equal(queued, beforeReduced);
  reduced = false; visible = false;
  vm.runInContext('drawThinkingOrbs(1200)', sandbox);
  assert.equal(queued, beforeReduced);
  document.hidden = true;
  vm.runInContext('drawThinkingOrbs(1300)', sandbox);
  assert.equal(queued, beforeReduced);
  document.hidden = false;
  document.querySelectorAll = () => [];
  vm.runInContext('drawThinkingOrbs(1400)', sandbox);
  assert.equal(queued, beforeReduced);
});
