import { resolvePreset, MODE_FRAMES, paintFrame } from 'thinking-orbs/engine';
const states = ['working','searching','solving','listening','connecting','weaving','composing','breathing','shaping'];
const gallery = document.querySelector('#gallery');
for (const state of states) {
  const button = document.createElement('button');
  button.className = 'tile';
  button.innerHTML = `<canvas data-state="${state}" data-size="64" role="img" aria-label="${state} orb"></canvas><span>${state}</span><canvas data-state="${state}" data-size="20" role="img" aria-label="Compact ${state} orb"></canvas>`;
  button.onclick = () => select(state);
  gallery.append(button);
}
let selected = 'working', paused = false, seconds = 0, last = performance.now();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const canvases = [...document.querySelectorAll('canvas')];
const visible = new Set(canvases);
const observer = new IntersectionObserver(entries => entries.forEach(e => e.isIntersecting ? visible.add(e.target) : visible.delete(e.target)));
for (const canvas of canvases) {
  observer.observe(canvas);
  const size = Number(canvas.dataset.size);
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = size * dpr; canvas.height = size * dpr;
  canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
  canvas.getContext('2d').scale(dpr, dpr);
}
function select(state) {
  selected = state;
  document.querySelector('#inline').dataset.state = state;
  document.querySelector('#large').dataset.state = state;
  document.querySelector('#status').textContent = state === 'working' ? 'Andromity is thinking' : 'Andromity · ' + state;
  document.querySelectorAll('.tile').forEach((tile,i) => tile.setAttribute('aria-pressed', String(states[i] === state)));
}
document.querySelector('#pause').onclick = e => { paused = !paused; e.target.textContent = paused ? 'Resume' : 'Pause'; };
document.querySelector('#theme').onchange = e => { document.body.dataset.theme = e.target.value; };
function draw(now) {
  if (!paused && !document.hidden && !reduced.matches) seconds += Math.min((now-last)/1000, .05);
  last = now;
  for (const canvas of visible) {
    const size = Number(canvas.dataset.size), ctx = canvas.getContext('2d');
    const preset = resolvePreset(canvas.dataset.state || selected, size);
    ctx.clearRect(0,0,size,size);
    const tint = document.querySelector('#tint').value === 'violet' ? {r:188,g:140,b:255} : undefined;
    paintFrame(ctx, MODE_FRAMES[preset.mode](size, (reduced.matches ? 1 : seconds) * preset.speed, preset.opts), document.body.dataset.theme !== 'light', tint);
  }
  requestAnimationFrame(draw);
}
select(selected); requestAnimationFrame(draw);
