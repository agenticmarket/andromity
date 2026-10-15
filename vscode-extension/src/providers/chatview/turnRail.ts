/** Turn rail for the chat webview: one tick per prompt in the empty gutter
 *  left of the chat column, anchored to the top. It is injected into the chat
 *  script's scope and relies on chatContainer, escapeHtml, isRunning,
 *  currentSessionId, userScrolledUp, btnScrollBottom, markUserScrollActive and
 *  vscode from there. */
export function getTurnRailScript(): string {
  return `
    // ── Turn rail ──────────────────────────────────────────────────────────
    // Shown only when the gutter beside the chat column has room for it. Hover or focus
    // previews a turn, click jumps to it, Alt+Up/Down steps through turns.
    const TURN_RAIL_MIN_GUTTER = 44;
    const TURN_RAIL_TOP = 18;
    const TURN_RAIL_GAP = 14;
    const TURN_RAIL_MIN_GAP = 6;
    const TURN_RAIL_ERROR_SELECTOR = '.andromity-error-card, .error-card';
    const turnRailReducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const turnRail = document.createElement('nav');
    turnRail.className = 'turn-rail';
    turnRail.setAttribute('aria-label', 'Conversation turns');
    turnRail.hidden = true;
    const turnRailPreview = document.createElement('div');
    turnRailPreview.className = 'turn-rail-preview';
    turnRailPreview.setAttribute('aria-hidden', 'true');
    const turnRailHost = chatContainer ? chatContainer.parentElement : null;
    if (turnRailHost) turnRailHost.append(turnRail, turnRailPreview);

    let turnRailTurns = [];
    let turnRailActive = -1;
    let turnRailHover = -1;
    let turnRailFrame = 0;
    let turnRailScrollFrame = 0;
    let turnRailHideTimer = 0;
    let turnRailSession = null;

    function scheduleTurnRail() {
      if (!turnRailHost || turnRailFrame) return;
      turnRailFrame = requestAnimationFrame(renderTurnRail);
    }

    // Steering prompts typed mid-turn belong to the turn they steer.
    function isTurnRailPrompt(el) {
      return el.matches('.message-wrap.user') && !el.hasAttribute('data-steering');
    }

    function turnRailReplyNodes(wrap) {
      const nodes = [];
      for (let el = wrap.nextElementSibling; el && !isTurnRailPrompt(el); el = el.nextElementSibling) nodes.push(el);
      return nodes;
    }

    function turnRailFind(nodes, selector) {
      for (const node of nodes) {
        const found = node.matches(selector) ? node : node.querySelector(selector);
        if (found) return found;
      }
      return null;
    }

    function renderTurnRail() {
      turnRailFrame = 0;
      const wraps = Array.from(chatContainer.children).filter(isTurnRailPrompt);
      const gutter = wraps.length ? wraps[0].getBoundingClientRect().left - chatContainer.getBoundingClientRect().left : 0;
      const visible = wraps.length > 1 && gutter >= TURN_RAIL_MIN_GUTTER;
      const sameSession = turnRailSession === currentSessionId;
      const previousCount = sameSession ? turnRailTurns.length : wraps.length;
      turnRailSession = currentSessionId;
      turnRail.hidden = !visible;
      turnRail.textContent = '';
      turnRailTurns = [];
      if (!visible) {
        turnRailActive = -1;
        setTurnRailHover(-1);
        return;
      }
      turnRail.style.width = Math.floor(gutter) + 'px';
      turnRail.style.top = chatContainer.offsetTop + 'px';
      turnRail.style.height = chatContainer.clientHeight + 'px';
      const available = chatContainer.clientHeight - TURN_RAIL_TOP * 2;
      const gap = Math.max(TURN_RAIL_MIN_GAP, Math.min(TURN_RAIL_GAP, available / wraps.length));
      const sizer = document.createElement('div');
      sizer.className = 'turn-rail-sizer';
      sizer.style.height = (TURN_RAIL_TOP * 2 + gap * wraps.length) + 'px';
      turnRail.appendChild(sizer);

      wraps.forEach((wrap, i) => {
        const replies = turnRailReplyNodes(wrap);
        const replyLength = replies.reduce((sum, node) => sum + (node.textContent || '').length, 0);
        const promptEl = wrap.querySelector('.prompt-text-content');
        const prompt = (promptEl ? promptEl.textContent : '').trim();
        const tick = document.createElement('button');
        tick.type = 'button';
        tick.className = 'turn-rail-tick';
        if (turnRailFind(replies, TURN_RAIL_ERROR_SELECTOR)) tick.classList.add('error');
        if (isRunning && i === wraps.length - 1) tick.classList.add('running');
        if (i >= previousCount) {
          tick.classList.add('enter');
          tick.addEventListener('animationend', () => tick.classList.remove('enter'), { once: true });
        }
        tick.dataset.turn = String(i);
        tick.style.top = (TURN_RAIL_TOP + i * gap) + 'px';
        tick.style.height = gap + 'px';
        tick.style.setProperty('--tick-len', (8 + Math.round(Math.min(1, replyLength / 2400) * 14)) + 'px');
        tick.setAttribute('aria-label', 'Turn ' + (i + 1) + (prompt ? ': ' + prompt.slice(0, 120) : ''));
        tick.innerHTML = '<span class="turn-rail-mark"></span>';
        turnRail.appendChild(tick);
        turnRailTurns.push({ wrap, tick });
      });

      turnRailActive = -1;
      syncTurnRailActive();
      if (turnRailHover >= turnRailTurns.length) turnRailHover = -1;
      if (turnRailHover >= 0) {
        turnRailTurns[turnRailHover].tick.classList.add('hover');
        showTurnRailPreview(turnRailHover);
      }
    }

    function syncTurnRailActive() {
      turnRailScrollFrame = 0;
      if (turnRail.hidden || !turnRailTurns.length) return;
      let active = turnRailTurns.length - 1;
      if (chatContainer.scrollTop + chatContainer.clientHeight < chatContainer.scrollHeight - 2) {
        const line = chatContainer.scrollTop + chatContainer.clientHeight * 0.3;
        active = 0;
        turnRailTurns.forEach((turn, i) => { if (turn.wrap.offsetTop <= line) active = i; });
      }
      if (active === turnRailActive) return;
      turnRailActive = active;
      turnRailTurns.forEach((turn, i) => turn.tick.classList.toggle('active', i === active));
      const tick = turnRailTurns[active].tick;
      const top = tick.offsetTop;
      if (top < turnRail.scrollTop || top + tick.offsetHeight > turnRail.scrollTop + turnRail.clientHeight) {
        turnRail.scrollTop = Math.max(0, top - turnRail.clientHeight / 2);
      }
    }

    function setTurnRailHover(index) {
      if (index === turnRailHover) return;
      turnRailTurns.forEach((turn, i) => turn.tick.classList.toggle('hover', i === index));
      turnRailHover = index;
      clearTimeout(turnRailHideTimer);
      if (index < 0) {
        turnRailHideTimer = setTimeout(() => turnRailPreview.classList.remove('show'), 120);
        return;
      }
      showTurnRailPreview(index);
    }

    function turnRailPreviewHtml(index) {
      const turn = turnRailTurns[index];
      const replies = turnRailReplyNodes(turn.wrap);
      const promptEl = turn.wrap.querySelector('.prompt-text-content');
      const prompt = (promptEl ? promptEl.textContent : '').trim() || (turn.wrap.querySelector('img') ? 'Image prompt' : 'Prompt');
      const replyEl = turnRailFind(replies, '.assistant-text');
      const errorEl = turnRailFind(replies, TURN_RAIL_ERROR_SELECTOR);
      const errorBody = errorEl ? errorEl.querySelector('.error-card-body') : null;
      const reply = ((replyEl && replyEl.textContent) || (errorBody && errorBody.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 320);
      const tools = replies.reduce((sum, node) => sum + node.querySelectorAll('.tool-card, .activity-row').length, 0);
      const files = replies.reduce((sum, node) => sum + node.querySelectorAll('.file-edited-chip').length, 0);
      const timeEl = turn.wrap.querySelector('.message-time');
      const durationEl = turnRailFind(replies, '.turn-duration-badge > span:last-child');
      const running = isRunning && index === turnRailTurns.length - 1;
      const status = running ? ['running', 'Running'] : errorEl ? ['error', 'Error'] : ['done', 'Done'];
      const head = ['<span class="turn-rail-card-num">Turn ' + String(index + 1).padStart(2, '0') + '</span>'];
      if (timeEl) head.push('<span>' + escapeHtml(timeEl.textContent.trim()) + '</span>');
      if (durationEl && !running) head.push('<span>' + escapeHtml(durationEl.textContent.trim()) + '</span>');
      head.push('<span class="turn-rail-status ' + status[0] + '">' + status[1] + '</span>');
      return '<div class="turn-rail-card">' +
        '<div class="turn-rail-card-head">' + head.join('') + '</div>' +
        '<div class="turn-rail-card-prompt">' + escapeHtml(prompt) + '</div>' +
        (reply ? '<div class="turn-rail-card-reply">' + escapeHtml(reply) + '</div>' : '') +
        (tools || files
          ? '<div class="turn-rail-card-meta">' +
              (tools ? '<span>' + tools + (tools === 1 ? ' tool' : ' tools') + '</span>' : '') +
              (files ? '<span>' + files + (files === 1 ? ' file changed' : ' files changed') + '</span>' : '') +
            '</div>'
          : '') +
      '</div>';
    }

    function showTurnRailPreview(index) {
      const turn = turnRailTurns[index];
      if (!turn) return;
      const wasShown = turnRailPreview.classList.contains('show');
      turnRailPreview.innerHTML = turnRailPreviewHtml(index);
      const hostRect = turnRailHost.getBoundingClientRect();
      const markRect = turn.tick.querySelector('.turn-rail-mark').getBoundingClientRect();
      const tickRect = turn.tick.getBoundingClientRect();
      const x = Math.round(Math.max(markRect.right, tickRect.left + 46) - hostRect.left + 10);
      const center = tickRect.top + tickRect.height / 2 - hostRect.top;
      const height = turnRailPreview.offsetHeight;
      const y = Math.round(Math.min(Math.max(8, center - height / 2), turnRailHost.clientHeight - height - 8));
      turnRailPreview.style.setProperty('--x', x + 'px');
      turnRailPreview.style.setProperty('--y', y + 'px');
      if (!wasShown) {
        turnRailPreview.classList.add('instant');
        void turnRailPreview.offsetWidth;
        turnRailPreview.classList.remove('instant');
        turnRailPreview.classList.add('show');
      }
    }

    function jumpToTurn(index) {
      const turn = turnRailTurns[index];
      if (!turn) return;
      vscode.postMessage({ type: 'telemetry_feature', feature: 'turn_rail_used', once: true });
      // Reading history: set the scrolled-up state directly so a streaming reply cannot pull the view
      // back down before the first scroll event lands. Reaching the bottom clears it as usual.
      markUserScrollActive();
      userScrolledUp = true;
      if (btnScrollBottom) btnScrollBottom.classList.add('visible');
      const reduced = turnRailReducedMotion && turnRailReducedMotion.matches;
      chatContainer.scrollTo({ top: Math.max(0, turn.wrap.offsetTop - 8), behavior: reduced ? 'auto' : 'smooth' });
      const card = turn.wrap.querySelector('.prompt-card') || turn.wrap;
      card.classList.remove('turn-rail-landed');
      void card.offsetWidth;
      card.classList.add('turn-rail-landed');
      card.addEventListener('animationend', () => card.classList.remove('turn-rail-landed'), { once: true });
    }

    if (turnRailHost) {
      turnRail.addEventListener('pointerover', (event) => {
        const tick = event.target.closest('.turn-rail-tick');
        if (tick) setTurnRailHover(Number(tick.dataset.turn));
      });
      turnRail.addEventListener('pointerleave', () => setTurnRailHover(-1));
      turnRail.addEventListener('focusin', (event) => {
        const tick = event.target.closest('.turn-rail-tick');
        if (tick) setTurnRailHover(Number(tick.dataset.turn));
      });
      turnRail.addEventListener('focusout', () => setTurnRailHover(-1));
      turnRail.addEventListener('click', (event) => {
        const tick = event.target.closest('.turn-rail-tick');
        if (tick) jumpToTurn(Number(tick.dataset.turn));
      });
      document.addEventListener('keydown', (event) => {
        if (!event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        if (turnRail.hidden || !turnRailTurns.length || (event.target && event.target.closest && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return;
        event.preventDefault();
        const current = turnRailTurns[turnRailActive];
        const belowStart = current && chatContainer.scrollTop > current.wrap.offsetTop;
        const next = event.key === 'ArrowUp' ? (belowStart ? turnRailActive : turnRailActive - 1) : turnRailActive + 1;
        jumpToTurn(Math.max(0, Math.min(turnRailTurns.length - 1, next)));
      });
      chatContainer.addEventListener('scroll', () => {
        if (!turnRailScrollFrame) turnRailScrollFrame = requestAnimationFrame(syncTurnRailActive);
      }, { passive: true });
      new MutationObserver(scheduleTurnRail).observe(chatContainer, { childList: true });
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(scheduleTurnRail).observe(chatContainer);
    }
  `;
}

export function getTurnRailStyles(): string {
  return `
    /* ─── Turn rail ─────────────────────────────────────────────────────── */
    .turn-rail {
      position: absolute;
      left: 0;
      z-index: 5;
      overflow-x: hidden;
      overflow-y: auto;
      scrollbar-width: none;
    }
    .turn-rail::-webkit-scrollbar { display: none; }
    .turn-rail[hidden] { display: none; }
    .turn-rail-sizer { width: 1px; pointer-events: none; }
    .turn-rail-tick {
      position: absolute;
      left: 0;
      width: 100%;
      display: flex;
      align-items: center;
      padding: 0 0 0 16px;
      background: none;
      border: 0;
      cursor: pointer;
      outline: none;
    }
    .turn-rail-mark {
      height: 2px;
      width: var(--tick-len, 14px);
      border-radius: 2px;
      background: var(--muted);
      opacity: 0.35;
      transform-origin: left center;
      transition: width 0.18s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.18s ease, background-color 0.18s ease;
    }
    .turn-rail-tick.active .turn-rail-mark { background: var(--accent); opacity: 1; width: calc(var(--tick-len, 14px) + 8px); }
    .turn-rail-tick.error .turn-rail-mark { background: var(--red); opacity: 0.85; }
    .turn-rail-tick.running .turn-rail-mark { background: var(--accent); animation: turnRailBreathe 1.4s ease-in-out infinite; }
    .turn-rail-tick.hover .turn-rail-mark,
    .turn-rail-tick:focus-visible .turn-rail-mark { width: 30px; opacity: 1; }
    .turn-rail-tick:focus-visible .turn-rail-mark { box-shadow: 0 0 0 2px var(--accent-glow); }
    .turn-rail-tick.enter .turn-rail-mark { animation: turnRailEnter 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
    @keyframes turnRailBreathe { 50% { opacity: 0.35; } }
    @keyframes turnRailEnter { from { opacity: 0; transform: scaleX(0); } }

    .turn-rail-preview {
      position: absolute;
      left: 0;
      top: 0;
      z-index: 6;
      pointer-events: none;
      opacity: 0;
      transform: translate(var(--x, 0), var(--y, 0)) translateX(-6px);
      transition: opacity 0.14s ease, transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .turn-rail-preview.show { opacity: 1; transform: translate(var(--x, 0), var(--y, 0)); }
    .turn-rail-preview.instant { transition: none; }
    .turn-rail-card {
      width: 300px;
      max-width: calc(100vw - 80px);
      background: var(--popover-bg);
      border: 1px solid var(--popover-border);
      border-radius: 8px;
      box-shadow: 0 12px 32px var(--popover-shadow);
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.45;
      color: var(--fg);
    }
    .turn-rail-card-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      font: 10.5px var(--font-mono);
      color: var(--muted);
    }
    .turn-rail-card-num { color: var(--fg); }
    .turn-rail-status { margin-left: auto; padding: 0 6px; border-radius: 3px; }
    .turn-rail-status.done { color: var(--green); background: color-mix(in srgb, var(--green) 12%, transparent); }
    .turn-rail-status.error { color: var(--red); background: color-mix(in srgb, var(--red) 12%, transparent); }
    .turn-rail-status.running { color: var(--accent); background: var(--accent-glow); }
    .turn-rail-card-prompt {
      font-weight: 500;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .turn-rail-card-reply {
      margin-top: 5px;
      color: var(--muted);
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .turn-rail-card-meta { display: flex; gap: 6px; margin-top: 8px; }
    .turn-rail-card-meta span {
      font: 10.5px var(--font-mono);
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 0 6px;
    }

    .prompt-card.turn-rail-landed { animation: turnRailLanded 1.1s ease-out; }
    @keyframes turnRailLanded {
      0% { box-shadow: 0 0 0 1px var(--accent), 0 0 0 5px var(--accent-glow); }
      100% { box-shadow: 0 0 0 0 transparent; }
    }

    @media (prefers-reduced-motion: reduce) {
      .turn-rail-mark, .turn-rail-preview, .prompt-card.turn-rail-landed { animation: none !important; transition: none !important; }
    }
  `;
}
