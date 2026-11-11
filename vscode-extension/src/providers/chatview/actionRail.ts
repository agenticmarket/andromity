interface ActionRailItem {
  action: string;
  title: string;
  icon: keyof typeof ICON_PATHS;
}

const ICON_PATHS = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  files: '<path d="M20 7h-3a2 2 0 0 1-2-2V2"/><path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z"/><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8"/>',
  issues: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>',
  columns: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  fold: '<path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3-3-3 3"/><path d="m15 5-3 3-3-3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
} as const;

const PRIMARY: readonly ActionRailItem[] = [
  { action: "new", title: "New Session", icon: "plus" },
  { action: "sessions", title: "Sessions History", icon: "history" },
  { action: "review", title: "Changes Review", icon: "files" },
  { action: "prs", title: "Pull Requests and Issues", icon: "issues" },
  { action: "diffs", title: "View File Diffs", icon: "columns" },
];

const SETTINGS: ActionRailItem = { action: "settings", title: "Settings & API Keys", icon: "gear" };

const MORE: readonly ActionRailItem[] = [
  { action: "setup", title: "System Setup Check", icon: "check" },
  { action: "restart", title: "Restart Engine", icon: "refresh" },
  { action: "compact", title: "Compact Session Context", icon: "fold" },
  { action: "undo", title: "Undo Last Turn", icon: "undo" },
  { action: "welcome", title: "Welcome / Getting Started", icon: "rocket" },
];

const HOST_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["prs", "andromity.openPullRequestsView"],
  ["diffs", "andromity.viewGitDiff"],
  ["setup", "andromity.checkSetup"],
  ["restart", "andromity.restartServer"],
  ["welcome", "andromity.welcome"],
]);

export function actionRailCommand(action: unknown): string | undefined {
  return typeof action === "string" ? HOST_COMMANDS.get(action) : undefined;
}

function icon(name: keyof typeof ICON_PATHS, size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

export function getActionRailHtml(): string {
  const button = (item: ActionRailItem) =>
    `<button type="button" class="rail-btn" data-rail-action="${item.action}" aria-label="${item.title}" title="${item.title}">${icon(item.icon, 16)}<span class="rail-label">${item.title}</span></button>`;
  const menuItem = (item: ActionRailItem) =>
    `<button type="button" class="rail-menu-item" role="menuitem" tabindex="-1" data-rail-action="${item.action}">${icon(item.icon, 14)}<span>${item.title}</span></button>`;
  return `<nav class="action-rail" id="action-rail" aria-label="Andromity actions">
    <button type="button" class="rail-btn rail-toggle" id="rail-toggle" aria-expanded="false" aria-label="Show labels" title="Show labels">${icon("chevron", 16)}<span class="rail-label">Hide labels</span></button>
    <div class="rail-sep" role="presentation"></div>
    ${PRIMARY.map(button).join("")}
    <div class="rail-grow"></div>
    ${button(SETTINGS)}
    <button type="button" class="rail-btn" id="rail-more" aria-haspopup="menu" aria-expanded="false" aria-controls="rail-menu" aria-label="More actions" title="More actions">${icon("more", 16)}<span class="rail-label">More</span></button>
  </nav>
  <div class="rail-menu" id="rail-menu" role="menu" aria-label="More actions" hidden>${MORE.map(menuItem).join("")}</div>`;
}

export function getActionRailScript(): string {
  return `
    const actionRail = document.getElementById('action-rail');
    const railToggle = actionRail && document.getElementById('rail-toggle');
    const railMore = actionRail && document.getElementById('rail-more');
    const railMenu = actionRail && document.getElementById('rail-menu');
    if (actionRail && railToggle && railMore && railMenu) {
      const railTopBar = document.querySelector('.top-bar');
      const railStatusBar = document.querySelector('.status-bar');
      const RAIL_EXPANDED_KEY = 'andromity.actionRail.expanded';

      function syncRailInsets() {
        const top = railTopBar ? railTopBar.getBoundingClientRect().bottom : 0;
        const bottom = railStatusBar ? window.innerHeight - railStatusBar.getBoundingClientRect().top : 0;
        document.body.style.setProperty('--rail-top', Math.max(0, Math.round(top)) + 'px');
        document.body.style.setProperty('--rail-bottom', Math.max(0, Math.round(bottom)) + 'px');
      }

      function setRailExpanded(expanded, persist) {
        actionRail.classList.toggle('open', expanded);
        railToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        const label = expanded ? 'Hide labels' : 'Show labels';
        railToggle.setAttribute('aria-label', label);
        railToggle.title = label;
        if (persist) {
          try { localStorage.setItem(RAIL_EXPANDED_KEY, expanded ? '1' : '0'); } catch {}
        }
        syncRailMenu();
      }

      let railMenuHover = false;

      function closeRailMenu(restoreFocus) {
        railMenuHover = false;
        railMenu.hidden = true;
        railMore.setAttribute('aria-expanded', 'false');
        if (restoreFocus) railMore.focus();
      }

      function positionRailMenu() {
        const railRect = actionRail.getBoundingClientRect();
        const moreRect = railMore.getBoundingClientRect();
        railMenu.style.left = Math.round(railRect.right + 6) + 'px';
        railMenu.style.bottom = Math.max(6, Math.round(window.innerHeight - moreRect.bottom)) + 'px';
      }

      function openRailMenu(focusLast) {
        positionRailMenu();
        railMenu.hidden = false;
        railMore.setAttribute('aria-expanded', 'true');
        railMenu.querySelectorAll('.rail-menu-item').forEach((item) => {
          const action = item.getAttribute('data-rail-action');
          const blocked = isRunning && (action === 'compact' || action === 'restart');
          item.disabled = blocked;
          item.title = blocked ? 'Not available while a turn is running' : '';
        });
        const items = railMenu.querySelectorAll('.rail-menu-item:not(:disabled)');
        const target = items[focusLast ? items.length - 1 : 0];
        if (target) target.focus();
      }

      function syncRailMenu() {
        if (railMenu.hidden) return;
        if (!actionRail.getClientRects().length) closeRailMenu(false);
        else positionRailMenu();
      }

      function runRailAction(action) {
        if (isRunning && (action === 'compact' || action === 'restart')) return;
        switch (action) {
          case 'new':
            vscode.postMessage({ type: 'new_session' });
            break;
          case 'sessions':
            toggleSessionsFlyout();
            break;
          case 'review':
            vscode.postMessage({ type: 'open_review_tab' });
            break;
          case 'settings':
            vscode.postMessage({ type: 'open_settings' });
            break;
          case 'undo':
            vscode.postMessage({ type: 'undo_turn' });
            break;
          case 'compact':
            showCompactionBanner('Compacting conversation context to reduce token usage...');
            vscode.postMessage({ type: 'compact_session' });
            break;
          case 'prs':
          case 'diffs':
          case 'setup':
          case 'restart':
          case 'welcome':
            vscode.postMessage({ type: 'run_action', action });
            break;
        }
      }

      let savedExpanded = false;
      try { savedExpanded = localStorage.getItem(RAIL_EXPANDED_KEY) === '1'; } catch {}
      setRailExpanded(savedExpanded, false);
      syncRailInsets();
      window.addEventListener('resize', () => {
        syncRailInsets();
        syncRailMenu();
      });
      actionRail.addEventListener('transitionend', (e) => {
        if (e.propertyName === 'width') syncRailMenu();
      });
      railMenu.addEventListener('mousedown', (e) => {
        if (!e.target.closest('.rail-menu-item:not(:disabled)')) e.preventDefault();
      });
      railMenu.addEventListener('mouseenter', () => { railMenuHover = true; });
      railMenu.addEventListener('mouseleave', () => { railMenuHover = false; });
      railMenu.addEventListener('focusout', (e) => {
        if (railMenu.contains(e.relatedTarget) || e.relatedTarget === railMore) return;
        if (!e.relatedTarget && railMenuHover) {
          const lost = e.target;
          setTimeout(() => {
            if (!railMenu.hidden && lost.isConnected && !lost.disabled) lost.focus();
          }, 0);
          return;
        }
        closeRailMenu(false);
      });
      if (typeof ResizeObserver !== 'undefined') {
        const railObserver = new ResizeObserver(syncRailInsets);
        if (railTopBar) railObserver.observe(railTopBar);
        if (railStatusBar) railObserver.observe(railStatusBar);
      }

      actionRail.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn || !actionRail.contains(btn)) return;
        if (btn === railToggle) {
          setRailExpanded(!actionRail.classList.contains('open'), true);
          return;
        }
        if (btn === railMore) {
          if (railMenu.hidden) openRailMenu(false); else closeRailMenu(false);
          return;
        }
        const action = btn.getAttribute('data-rail-action');
        if (!action) return;
        closeRailMenu(false);
        runRailAction(action);
      });

      railMore.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          openRailMenu(e.key === 'ArrowUp');
        }
      });

      railMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.rail-menu-item');
        if (!item || item.disabled) return;
        closeRailMenu(true);
        runRailAction(item.getAttribute('data-rail-action'));
      });

      railMenu.addEventListener('keydown', (e) => {
        const items = Array.from(railMenu.querySelectorAll('.rail-menu-item:not(:disabled)'));
        const at = items.indexOf(document.activeElement);
        let next = -1;
        if (e.key === 'ArrowDown') next = (at + 1) % items.length;
        else if (e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = items.length - 1;
        else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeRailMenu(true);
          return;
        } else if (e.key === 'Tab') {
          closeRailMenu(false);
          return;
        }
        if (items[next]) {
          e.preventDefault();
          items[next].focus();
        }
      });

      document.addEventListener('click', (e) => {
        if (railMenu.hidden || railMenu.contains(e.target) || railMore.contains(e.target)) return;
        closeRailMenu(false);
      });
    }
  `;
}

export function getActionRailStyles(): string {
  return `
    .action-rail, .rail-menu { display: none; }
    @media (min-width: 481px) {
      body:has(> .action-rail) { --rail-w: 46px; padding-left: var(--rail-w); }
      body:has(> .action-rail) .top-bar,
      body:has(> .action-rail) .status-bar { margin-left: calc(var(--rail-w) * -1); }
      body:has(> .action-rail) .action-rail {
        position: fixed;
        left: 0;
        top: var(--rail-top, 46px);
        bottom: var(--rail-bottom, 26px);
        z-index: 7;
        width: var(--rail-w);
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 8px 6px;
        overflow-x: hidden;
        overflow-y: auto;
        scrollbar-width: none;
        border-right: 1px solid var(--border);
        background: var(--surface-header);
        transition: width 0.15s ease;
      }
      body:has(> .action-rail) .action-rail::-webkit-scrollbar { display: none; }
      body:has(> .action-rail) .rail-menu:not([hidden]) {
        position: fixed;
        z-index: 400;
        min-width: 230px;
        padding: 4px;
        display: flex;
        flex-direction: column;
        border: 1px solid var(--popover-border);
        border-radius: 8px;
        background: var(--popover-bg);
        box-shadow: 0 8px 24px var(--popover-shadow);
      }
    }
    .rail-btn {
      display: flex;
      align-items: center;
      flex: none;
      gap: 10px;
      height: 32px;
      padding: 0 8px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      font: inherit;
      font-size: 12.5px;
      white-space: nowrap;
      overflow: hidden;
      cursor: pointer;
      text-align: left;
    }
    .rail-btn svg { flex: none; }
    .rail-btn:hover,
    .rail-btn[aria-expanded="true"]:not(.rail-toggle) {
      background: var(--surface-hover);
      color: var(--fg);
    }
    .rail-btn:focus-visible,
    .rail-menu-item:focus-visible {
      outline: 1px solid var(--vscode-focusBorder, #007fd4);
      outline-offset: -1px;
    }
    .rail-label { display: none; }
    .action-rail.open .rail-label { display: inline; }
    .rail-toggle svg { transition: transform 0.15s ease; }
    .action-rail.open .rail-toggle svg { transform: rotate(180deg); }
    .rail-sep { flex: none; height: 1px; margin: 4px 6px; background: var(--border); }
    .rail-grow { flex: 1; min-height: 8px; }
    .rail-menu-item {
      display: flex;
      align-items: center;
      gap: 9px;
      width: 100%;
      padding: 5px 8px;
      border: 0;
      border-radius: 5px;
      background: none;
      color: var(--fg);
      font: inherit;
      font-size: 12px;
      text-align: left;
      white-space: nowrap;
      cursor: pointer;
    }
    .rail-menu-item svg { flex: none; color: var(--muted); }
    .rail-menu-item:hover,
    .rail-menu-item:focus-visible {
      background: var(--vscode-list-activeSelectionBackground, var(--surface-active));
      color: var(--vscode-list-activeSelectionForeground, var(--fg));
    }
    .rail-menu-item:hover svg,
    .rail-menu-item:focus-visible svg { color: inherit; }
    @media (min-width: 900px) {
      body:has(> .action-rail.open) { --rail-w: 224px; }
    }
    @media (min-width: 1500px) {
      body:has(> .action-rail.open) { padding-right: calc(var(--rail-w) - 46px); }
      body:has(> .action-rail.open) .top-bar,
      body:has(> .action-rail.open) .status-bar { margin-right: calc((var(--rail-w) - 46px) * -1); }
    }
    @media (min-width: 760px) and (max-width: 899.98px) {
      body:has(> .action-rail) .action-rail.open {
        width: 224px;
        box-shadow: 6px 0 18px rgba(0, 0, 0, 0.28);
      }
    }
    @media (max-width: 759.98px) {
      .rail-toggle, .rail-sep { display: none; }
      .action-rail.open .rail-label { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .action-rail, .rail-toggle svg { transition: none !important; }
    }
    @media (forced-colors: active) {
      .action-rail { border-right-color: CanvasText; }
      .rail-btn:hover, .rail-btn[aria-expanded="true"]:not(.rail-toggle) { outline: 1px solid Highlight; }
    }
  `;
}
