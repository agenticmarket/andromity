import { orbEngineScript } from './orbEngine.js';

export function getThinkingOrbsScript(): string {
  return `${orbEngineScript}
    const orbMotionPreference = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : {matches:true, addEventListener() {}};
    let orbFrameRequest = 0;
    let orbTime = 0;
    let orbLastFrame = 0;
    function orbMarkup(state) {
      return '<canvas class="agent-thinking-orb" data-orb-state="' + state + '" width="40" height="40" aria-hidden="true" style="width:20px;height:20px;flex-shrink:0;vertical-align:middle"></canvas>';
    }
    function setTurnOrb(state) {
      const header = currentTurnAssistantDiv?.querySelector('.assistant-header');
      if (!header) return;
      const existing = header.querySelector('.agent-thinking-orb');
      if (existing && state) { existing.dataset.orbState = state; return; }
      existing?.remove();
      if (state) header.insertAdjacentHTML('beforeend', orbMarkup(state));
    }
    function drawThinkingOrbs(now) {
      orbFrameRequest = 0;
      const canvases = [...document.querySelectorAll('.agent-thinking-orb')];
      if (!canvases.length || document.hidden) { orbLastFrame = 0; return; }
      if (orbLastFrame) orbTime += Math.min((now - orbLastFrame) / 1000, 0.05);
      orbLastFrame = now;
      const dark = !document.body.classList.contains('vscode-light') && !document.body.classList.contains('vscode-high-contrast-light');
      let painted = false;
      for (const canvas of canvases) {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) continue;
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        painted = true;
        const preset = AndromityOrbEngine.resolvePreset(canvas.dataset.orbState, 20);
        ctx.setTransform(2, 0, 0, 2, 0, 0);
        ctx.clearRect(0, 0, 20, 20);
        AndromityOrbEngine.paintFrame(ctx,
          AndromityOrbEngine.MODE_FRAMES[preset.mode](20, (orbMotionPreference.matches ? 1 : orbTime) * preset.speed, preset.opts), dark);
      }
      if (painted && !orbMotionPreference.matches) orbFrameRequest = requestAnimationFrame(drawThinkingOrbs);
    }
    function refreshThinkingOrbs() {
      if (orbFrameRequest) cancelAnimationFrame(orbFrameRequest);
      orbLastFrame = 0;
      orbFrameRequest = requestAnimationFrame(drawThinkingOrbs);
    }
    if (typeof MutationObserver === 'function') new MutationObserver(refreshThinkingOrbs).observe(document.body, {childList:true, subtree:true, attributes:true, attributeFilter:['class','data-orb-state']});
    document.addEventListener('visibilitychange', refreshThinkingOrbs);
    document.addEventListener('scroll', refreshThinkingOrbs, true);
    orbMotionPreference.addEventListener('change', refreshThinkingOrbs);
  `;
}
