/** Chapter rail for the plan tab: one tick per section in the gutter left of the
 *  plan, like the chat view's turn rail. It is injected into the plan script's
 *  scope and relies on contentEl and escapeHtml from there. */
export function getPlanChapterRailScript(): string {
  return `
    // ── Chapter rail ───────────────────────────────────────────────────────
    // Hover or focus previews a section, click jumps to it, Alt+Up/Down steps through sections.
    const CHAPTER_RAIL_MIN_WIDTH = 520;
    const CHAPTER_RAIL_TOP = 18;
    const CHAPTER_RAIL_GAP = 14;
    const CHAPTER_RAIL_MIN_GAP = 6;
    const CHAPTER_SELECTOR = '.plan-markdown > h1, .plan-markdown > h2, .plan-markdown > h3, #plan-content > .steps-card, #plan-content > .questions-box';
    const chapterTickLength = { H1: 22, H2: 16, H3: 10 };
    const chapterRailReducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const chapterRail = document.createElement('nav');
    chapterRail.className = 'chapter-rail';
    chapterRail.setAttribute('aria-label', 'Plan sections');
    chapterRail.hidden = true;
    const chapterRailPreview = document.createElement('div');
    chapterRailPreview.className = 'chapter-rail-preview';
    chapterRailPreview.setAttribute('aria-hidden', 'true');
    document.body.append(chapterRail, chapterRailPreview);

    let chapterRailItems = [];
    let chapterRailActive = -1;
    let chapterRailHover = -1;
    let chapterRailFrame = 0;
    let chapterRailScrollFrame = 0;
    let chapterRailHideTimer = 0;
    let chapterRailJumped = null;

    function scheduleChapterRail() {
      if (chapterRailFrame) return;
      chapterRailFrame = requestAnimationFrame(renderChapterRail);
    }

    function chapterTitle(el) {
      if (el.classList.contains('steps-card')) return 'Task checklist';
      if (el.classList.contains('questions-box')) return 'Open questions';
      return (el.textContent || '').trim() || 'Section';
    }

    function chapterSummary(el) {
      let text = '';
      if (el.classList.contains('steps-card')) {
        text = Array.from(el.querySelectorAll('.step-text')).map(s => s.textContent.trim()).join(' · ');
      } else if (el.classList.contains('questions-box')) {
        text = Array.from(el.querySelectorAll('li')).map(s => s.textContent.trim()).join(' · ');
      } else {
        const chapters = new Set(chapterRailItems.map(item => item.el));
        for (let node = el.nextElementSibling; node && !chapters.has(node) && text.length < 400; node = node.nextElementSibling) {
          text += ' ' + (node.textContent || '');
        }
      }
      return text.replace(/\\s+/g, ' ').trim().slice(0, 280);
    }

    function renderChapterRail() {
      chapterRailFrame = 0;
      const chapters = Array.from(contentEl.querySelectorAll(CHAPTER_SELECTOR));
      const visible = chapters.length > 1 && window.innerWidth >= CHAPTER_RAIL_MIN_WIDTH;
      const previousCount = chapterRailItems.length;
      document.body.classList.toggle('chapter-rail-on', visible);
      chapterRail.hidden = !visible;
      chapterRail.textContent = '';
      chapterRailItems = [];
      if (!visible) {
        chapterRailActive = -1;
        setChapterRailHover(-1);
        return;
      }
      const header = document.querySelector('.top-action-bar');
      const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
      chapterRail.style.top = Math.max(0, headerBottom) + 'px';
      const available = window.innerHeight - headerBottom - CHAPTER_RAIL_TOP * 2;
      const gap = Math.max(CHAPTER_RAIL_MIN_GAP, Math.min(CHAPTER_RAIL_GAP, available / chapters.length));
      const sizer = document.createElement('div');
      sizer.className = 'chapter-rail-sizer';
      sizer.style.height = (CHAPTER_RAIL_TOP * 2 + gap * chapters.length) + 'px';
      chapterRail.appendChild(sizer);

      chapters.forEach((el, i) => {
        const tick = document.createElement('button');
        tick.type = 'button';
        tick.className = 'chapter-rail-tick';
        if (i >= previousCount) {
          tick.classList.add('enter');
          tick.addEventListener('animationend', () => tick.classList.remove('enter'), { once: true });
        }
        tick.dataset.chapter = String(i);
        tick.style.top = (CHAPTER_RAIL_TOP + i * gap) + 'px';
        tick.style.height = gap + 'px';
        tick.style.setProperty('--tick-len', (chapterTickLength[el.tagName] || 16) + 'px');
        tick.setAttribute('aria-label', 'Section ' + (i + 1) + ': ' + chapterTitle(el).slice(0, 120));
        tick.innerHTML = '<span class="chapter-rail-mark"></span>';
        chapterRail.appendChild(tick);
        chapterRailItems.push({ el, tick });
      });

      chapterRailActive = -1;
      syncChapterRailActive();
      if (chapterRailHover >= chapterRailItems.length) chapterRailHover = -1;
      if (chapterRailHover >= 0) {
        chapterRailItems[chapterRailHover].tick.classList.add('hover');
        showChapterRailPreview(chapterRailHover);
      }
    }

    function syncChapterRailActive() {
      chapterRailScrollFrame = 0;
      if (chapterRail.hidden || !chapterRailItems.length) return;
      const doc = document.scrollingElement || document.documentElement;
      const header = document.querySelector('.top-action-bar');
      const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
      // A section picked on the rail stays active while it is on screen, even when the page
      // cannot scroll it to the top or a subheading sits right under it.
      const jumped = chapterRailItems.findIndex(item => item.el === chapterRailJumped);
      const jumpedTop = jumped >= 0 ? chapterRailItems[jumped].el.getBoundingClientRect().top : -1;
      let active = chapterRailItems.length - 1;
      if (jumped >= 0 && jumpedTop >= headerBottom - 4 && jumpedTop < window.innerHeight) {
        active = jumped;
      } else if (doc.scrollTop + window.innerHeight < doc.scrollHeight - 2) {
        const line = Math.min(window.innerHeight * 0.3, headerBottom + 96);
        active = 0;
        chapterRailItems.forEach((item, i) => { if (item.el.getBoundingClientRect().top <= line) active = i; });
      }
      if (active === chapterRailActive) return;
      chapterRailActive = active;
      chapterRailItems.forEach((item, i) => item.tick.classList.toggle('active', i === active));
      const tick = chapterRailItems[active].tick;
      const top = tick.offsetTop;
      if (top < chapterRail.scrollTop || top + tick.offsetHeight > chapterRail.scrollTop + chapterRail.clientHeight) {
        chapterRail.scrollTop = Math.max(0, top - chapterRail.clientHeight / 2);
      }
    }

    function setChapterRailHover(index) {
      if (index === chapterRailHover) return;
      chapterRailItems.forEach((item, i) => item.tick.classList.toggle('hover', i === index));
      chapterRailHover = index;
      clearTimeout(chapterRailHideTimer);
      if (index < 0) {
        chapterRailHideTimer = setTimeout(() => chapterRailPreview.classList.remove('show'), 120);
        return;
      }
      showChapterRailPreview(index);
    }

    function chapterRailPreviewHtml(index) {
      const el = chapterRailItems[index].el;
      const summary = chapterSummary(el);
      return '<div class="chapter-rail-card">' +
        '<div class="chapter-rail-card-head"><span class="chapter-rail-card-num">Section ' + String(index + 1).padStart(2, '0') + '</span>' +
          '<span>of ' + String(chapterRailItems.length).padStart(2, '0') + '</span></div>' +
        '<div class="chapter-rail-card-title">' + escapeHtml(chapterTitle(el)) + '</div>' +
        (summary ? '<div class="chapter-rail-card-text">' + escapeHtml(summary) + '</div>' : '') +
      '</div>';
    }

    function showChapterRailPreview(index) {
      const item = chapterRailItems[index];
      if (!item) return;
      const wasShown = chapterRailPreview.classList.contains('show');
      chapterRailPreview.innerHTML = chapterRailPreviewHtml(index);
      const markRect = item.tick.querySelector('.chapter-rail-mark').getBoundingClientRect();
      const tickRect = item.tick.getBoundingClientRect();
      const x = Math.round(Math.max(markRect.right, tickRect.left + 34) + 10);
      const center = tickRect.top + tickRect.height / 2;
      const height = chapterRailPreview.offsetHeight;
      const y = Math.round(Math.min(Math.max(8, center - height / 2), window.innerHeight - height - 8));
      chapterRailPreview.style.setProperty('--x', x + 'px');
      chapterRailPreview.style.setProperty('--y', y + 'px');
      if (!wasShown) {
        chapterRailPreview.classList.add('instant');
        void chapterRailPreview.offsetWidth;
        chapterRailPreview.classList.remove('instant');
        chapterRailPreview.classList.add('show');
      }
    }

    function jumpToChapter(index) {
      const item = chapterRailItems[index];
      if (!item) return;
      chapterRailJumped = item.el;
      const reduced = chapterRailReducedMotion && chapterRailReducedMotion.matches;
      item.el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
      item.el.classList.remove('chapter-rail-landed');
      void item.el.offsetWidth;
      item.el.classList.add('chapter-rail-landed');
      item.el.addEventListener('animationend', () => item.el.classList.remove('chapter-rail-landed'), { once: true });
    }

    chapterRail.addEventListener('pointerover', (event) => {
      const tick = event.target.closest('.chapter-rail-tick');
      if (tick) setChapterRailHover(Number(tick.dataset.chapter));
    });
    chapterRail.addEventListener('pointerleave', () => setChapterRailHover(-1));
    chapterRail.addEventListener('focusin', (event) => {
      const tick = event.target.closest('.chapter-rail-tick');
      if (tick) setChapterRailHover(Number(tick.dataset.chapter));
    });
    chapterRail.addEventListener('focusout', () => setChapterRailHover(-1));
    chapterRail.addEventListener('click', (event) => {
      const tick = event.target.closest('.chapter-rail-tick');
      if (tick) jumpToChapter(Number(tick.dataset.chapter));
    });
    const releaseChapterRailJump = () => { chapterRailJumped = null; };
    document.addEventListener('keydown', (event) => {
      releaseChapterRailJump();
      if (!event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      if (chapterRail.hidden || !chapterRailItems.length || (event.target && event.target.closest && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return;
      event.preventDefault();
      const current = chapterRailItems[chapterRailActive];
      const header = document.querySelector('.top-action-bar');
      const belowStart = current && current.el.getBoundingClientRect().top < (header ? header.getBoundingClientRect().bottom : 0) - 2;
      const next = event.key === 'ArrowUp' ? (belowStart ? chapterRailActive : chapterRailActive - 1) : chapterRailActive + 1;
      jumpToChapter(Math.max(0, Math.min(chapterRailItems.length - 1, next)));
    });
    window.addEventListener('wheel', releaseChapterRailJump, { passive: true });
    window.addEventListener('touchstart', releaseChapterRailJump, { passive: true });
    document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.chapter-rail')) releaseChapterRailJump(); });
    window.addEventListener('scroll', () => {
      if (!chapterRailScrollFrame) chapterRailScrollFrame = requestAnimationFrame(syncChapterRailActive);
    }, { passive: true });
    window.addEventListener('resize', scheduleChapterRail);
    new MutationObserver(scheduleChapterRail).observe(contentEl, { childList: true });
  `;
}

export function getPlanChapterRailStyles(): string {
  return `
    /* ─── Chapter rail ──────────────────────────────────────────────────── */
    body.chapter-rail-on .plan-body-container { padding-left: 56px !important; }
    .plan-markdown > h1, .plan-markdown > h2, .plan-markdown > h3, .steps-card, .questions-box { scroll-margin-top: 64px; }
    .chapter-rail {
      position: fixed;
      left: 0;
      bottom: 0;
      width: 44px;
      z-index: 40;
      overflow-x: hidden;
      overflow-y: auto;
      scrollbar-width: none;
    }
    .chapter-rail::-webkit-scrollbar { display: none; }
    .chapter-rail[hidden] { display: none; }
    .chapter-rail-sizer { width: 1px; pointer-events: none; }
    .chapter-rail-tick {
      position: absolute;
      left: 0;
      width: 100%;
      display: flex;
      align-items: center;
      padding: 0 0 0 14px;
      background: none;
      border: 0;
      cursor: pointer;
      outline: none;
    }
    .chapter-rail-mark {
      height: 2px;
      width: var(--tick-len, 14px);
      border-radius: 2px;
      background: var(--pending-fg);
      opacity: 0.35;
      transform-origin: left center;
      transition: width 0.18s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.18s ease, background-color 0.18s ease;
    }
    .chapter-rail-tick.active .chapter-rail-mark { background: var(--accent); opacity: 1; width: calc(var(--tick-len, 14px) + 6px); }
    .chapter-rail-tick.hover .chapter-rail-mark,
    .chapter-rail-tick:focus-visible .chapter-rail-mark { width: 26px; opacity: 1; }
    .chapter-rail-tick:focus-visible .chapter-rail-mark { box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.35); }
    .chapter-rail-tick.enter .chapter-rail-mark { animation: chapterRailEnter 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
    @keyframes chapterRailEnter { from { opacity: 0; transform: scaleX(0); } }

    .chapter-rail-preview {
      position: fixed;
      left: 0;
      top: 0;
      z-index: 60;
      pointer-events: none;
      opacity: 0;
      transform: translate(var(--x, 0), var(--y, 0)) translateX(-6px);
      transition: opacity 0.14s ease, transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .chapter-rail-preview.show { opacity: 1; transform: translate(var(--x, 0), var(--y, 0)); }
    .chapter-rail-preview.instant { transition: none; }
    .chapter-rail-card {
      width: 300px;
      max-width: calc(100vw - 70px);
      background: var(--vscode-editorWidget-background, var(--bg));
      border: 1px solid var(--vscode-editorWidget-border, var(--border));
      border-radius: 8px;
      box-shadow: 0 12px 32px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.45;
      color: var(--fg);
    }
    .chapter-rail-card-head {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
      font: 10.5px var(--font-mono);
      color: var(--pending-fg);
    }
    .chapter-rail-card-num { color: var(--fg); }
    .chapter-rail-card-title {
      font-weight: 600;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .chapter-rail-card-text {
      margin-top: 5px;
      color: var(--pending-fg);
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .chapter-rail-landed { animation: chapterRailLanded 1.1s ease-out; border-radius: 4px; }
    @keyframes chapterRailLanded {
      0% { box-shadow: 0 0 0 1px var(--accent), 0 0 0 5px rgba(6, 182, 212, 0.18); }
      100% { box-shadow: 0 0 0 0 transparent; }
    }

    @media (prefers-reduced-motion: reduce) {
      .chapter-rail-mark, .chapter-rail-preview, .chapter-rail-landed { animation: none !important; transition: none !important; }
    }
  `;
}
