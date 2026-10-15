import { scriptJson } from "../webviewSecurity.js";

export function getFingerprintScript(sessionId: string): string {
  return `
    (function() {
      const vscode = acquireVsCodeApi();
      const saved = vscode.getState() || {};

      const CARD_W = 250;
      const MIN_ZOOM = 0.2;
      const MAX_ZOOM = 2;
      const MAX_SAVED_POSITIONS = 400;

      let activeView = saved.view === 'blast' ? 'blast' : 'dag';
      let activeTurnFilter = 'all';
      let activeCategoryFilter = 'all';
      let searchQuery = '';
      let selectedNodeId = null;
      let activeSubagentId = null;
      let zoomScale = 1;
      let panX = 0;
      let panY = 0;
      // Until the user pans or zooms, every refresh re-fits so new work stays in view.
      let cameraTouched = false;
      let isCanvasPanning = false;
      let panStartX = 0;
      let panStartY = 0;
      let draggingNodeId = null;
      let nodeDragStartX = 0;
      let nodeDragStartY = 0;
      let nodeOrigX = 0;
      let nodeOrigY = 0;
      let hasDraggedNode = false;
      let isLeftSidebarCollapsed = !!saved.leftCollapsed;
      let isInspectorCollapsed = true;
      let isInspectorPinned = false;
      let inspectorSignature = '';
      // Dragged card positions survive live refreshes and reopening the panel.
      let manualPositions = saved.positions && typeof saved.positions === 'object' ? saved.positions : {};
      let renderedNodes = new Map();
      let lastFitMinScale = MIN_ZOOM;

      let traceData = {
        session_id: ${scriptJson(sessionId)},
        status: 'idle',
        nodes: [],
        connections: [],
        turns: [],
        metrics: { durationMs: 0, filesModified: 0, filesRead: 0, commandsRun: 0, searches: 0, sensitiveBlocked: 0, sensitiveAccessed: 0 },
        subagents: {}
      };

      const TAG_LABELS = { llm: 'Turn', read: 'Read', write: 'Change', explore: 'Search', web: 'Web', shell: 'Shell', subagent: 'Subagent', plan: 'Plan', coord: 'Sessions', other: 'Tool' };
      const STATUS_LABELS = { ok: 'OK', error: 'Error', blocked: 'Blocked', running: 'Running', none: 'No result', done: 'Done', failed: 'Failed' };

      function saveState() {
        const keys = Object.keys(manualPositions);
        if (keys.length > MAX_SAVED_POSITIONS) keys.slice(0, keys.length - MAX_SAVED_POSITIONS).forEach(k => delete manualPositions[k]);
        vscode.setState({ view: activeView, leftCollapsed: isLeftSidebarCollapsed, positions: manualPositions });
      }

      function escapeHtml(str) {
        if (str === undefined || str === null) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      function formatDuration(ms) {
        if (!ms || ms < 0) return '0s';
        if (ms < 10000) return (ms / 1000).toFixed(1) + 's';
        const totalSeconds = Math.round(ms / 1000);
        if (totalSeconds < 60) return totalSeconds + 's';
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        if (minutes < 60) return minutes + 'm' + (seconds ? ' ' + seconds + 's' : '');
        const hours = Math.floor(minutes / 60);
        return hours + 'h' + (minutes % 60 ? ' ' + (minutes % 60) + 'm' : '');
      }

      function formatTime(ts) {
        if (!ts) return '';
        const date = new Date(ts);
        if (isNaN(date.getTime())) return '';
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      }

      function plural(n, word) {
        return n + ' ' + word + (n === 1 ? '' : 's');
      }

      function getCurrentDataset() {
        if (activeSubagentId && traceData.subagents && traceData.subagents[activeSubagentId]) {
          return traceData.subagents[activeSubagentId];
        }
        return traceData;
      }

      function datasetKey() {
        return activeSubagentId || 'main';
      }

      function positionKey(nodeId) {
        return activeView + '|' + datasetKey() + '|' + nodeId;
      }

      function getNodeIconSvg(type) {
        const open = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
        const icons = {
          llm: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
          read: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
          write: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
          explore: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
          web: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
          shell: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
          subagent: '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/>',
          plan: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
          coord: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>',
          lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
        };
        return open + (icons[type] || '<circle cx="12" cy="12" r="9"/>') + '</svg>';
      }

      // ── Panels ─────────────────────────────────────────────────────────
      function toggleLeftSidebar(collapse) {
        const sb = document.getElementById('fp-sidebar');
        const btn = document.getElementById('btn-toggle-left-sidebar');
        if (!sb) return;
        isLeftSidebarCollapsed = collapse !== undefined ? collapse : !isLeftSidebarCollapsed;
        sb.classList.toggle('collapsed', isLeftSidebarCollapsed);
        if (btn) {
          btn.classList.toggle('active', !isLeftSidebarCollapsed);
          btn.setAttribute('aria-pressed', String(!isLeftSidebarCollapsed));
        }
        saveState();
      }

      function toggleInspector(collapse) {
        const insp = document.getElementById('fp-inspector');
        const btn = document.getElementById('btn-toggle-right-sidebar');
        if (!insp) return;
        isInspectorCollapsed = collapse !== undefined ? collapse : !isInspectorCollapsed;
        insp.classList.toggle('collapsed', isInspectorCollapsed);
        if (btn) {
          btn.classList.toggle('active', !isInspectorCollapsed);
          btn.setAttribute('aria-pressed', String(!isInspectorCollapsed));
        }
      }

      function togglePinInspector() {
        isInspectorPinned = !isInspectorPinned;
        const pinBtn = document.getElementById('btn-pin-inspector');
        const pinIcon = document.getElementById('pin-icon');
        if (pinBtn) {
          pinBtn.classList.toggle('pinned', isInspectorPinned);
          pinBtn.title = isInspectorPinned ? 'Close the inspector when clicking the canvas' : 'Keep the inspector open when clicking the canvas';
        }
        if (pinIcon) pinIcon.setAttribute('fill', isInspectorPinned ? 'currentColor' : 'none');
      }

      // ── Header ─────────────────────────────────────────────────────────
      function updateMetricsBar() {
        const m = getCurrentDataset().metrics || {};
        const set = (id, text) => {
          const el = document.getElementById(id);
          if (el) el.textContent = text;
        };
        set('metric-duration', formatDuration(m.durationMs || 0));
        set('metric-modified', String(m.filesModified || 0));
        set('metric-read', String(m.filesRead || 0) + (m.searches ? ' · ' + plural(m.searches, 'search').replace('searchs', 'searches') : ''));
        set('metric-commands', String(m.commandsRun || 0));
        const sec = document.getElementById('metric-security');
        if (sec) {
          const parts = [];
          if (m.sensitiveAccessed) parts.push(m.sensitiveAccessed + ' accessed');
          if (m.sensitiveBlocked) parts.push(m.sensitiveBlocked + ' blocked');
          sec.textContent = parts.length ? parts.join(' · ') : 'None';
          sec.className = 'wf-metric-value ' + (m.sensitiveAccessed ? 'red' : m.sensitiveBlocked ? 'amber' : 'muted');
        }
        const live = traceData.status === 'running';
        const pill = document.getElementById('status-pill');
        if (pill) pill.classList.toggle('live', live);
        set('status-text', live ? 'Live' : 'Idle');
      }

      function updateTurnsSidebar() {
        const turnListEl = document.getElementById('dynamic-turn-list');
        const badgeAll = document.getElementById('badge-all-turns');
        const titleEl = document.getElementById('sidebar-title');
        const labelAllEl = document.getElementById('turn-item-all-label');
        const subSecEl = document.getElementById('sidebar-subagents-section');
        const subListEl = document.getElementById('dynamic-subagent-list');
        const allEl = document.getElementById('turn-item-all');
        if (!turnListEl) return;

        const ds = getCurrentDataset();
        const turns = ds.turns || [];
        if (badgeAll) badgeAll.textContent = String(turns.length);
        if (allEl) allEl.classList.toggle('active', activeTurnFilter === 'all');

        if (activeSubagentId) {
          if (titleEl) titleEl.textContent = 'Subagent';
          if (labelAllEl) labelAllEl.textContent = 'All actions';
          if (subSecEl) subSecEl.style.display = 'none';
        } else {
          if (titleEl) titleEl.textContent = 'Turns';
          if (labelAllEl) labelAllEl.textContent = 'All turns';
          const subagentKeys = traceData.subagents ? Object.keys(traceData.subagents) : [];
          if (subSecEl) subSecEl.style.display = subagentKeys.length ? 'block' : 'none';
          if (subListEl) {
            subListEl.innerHTML = subagentKeys.map(aid => {
              const sub = traceData.subagents[aid];
              const status = (sub.status || 'done').toLowerCase();
              return '<div class="fp-subagent-item" data-subagent-id="' + escapeHtml(aid) + '" role="button" tabindex="0" title="' + escapeHtml(sub.task || '') + '">' +
                '<div class="fp-subagent-item-left">' + getNodeIconSvg('subagent') + '<span>' + escapeHtml(sub.role || 'subagent') + '</span></div>' +
                '<div class="fp-subagent-item-right">' +
                  '<span class="fp-subagent-actions-badge">' + (sub.tools ? sub.tools.length : 0) + '</span>' +
                  '<span class="fp-badge-subagent ' + escapeHtml(status) + '">' + escapeHtml(STATUS_LABELS[status] || status) + '</span>' +
                '</div></div>';
            }).join('');
          }
        }

        turnListEl.innerHTML = turns.map(turn => {
          const meta = [formatTime(turn.ts), turn.durationMs ? formatDuration(turn.durationMs) : '', plural(turn.actions || 0, 'action')].filter(Boolean);
          const statusHtml = turn.status === 'error' || turn.status === 'running'
            ? '<span class="fp-turn-status ' + turn.status + '">' + (turn.status === 'error' ? 'Error' : 'Running') + '</span>'
            : '';
          return '<div class="fp-turn-item' + (activeTurnFilter === turn.id ? ' active' : '') + '" data-turn="' + escapeHtml(turn.id) + '" role="button" tabindex="0" title="' + escapeHtml(turn.prompt || '') + '">' +
            '<div class="fp-turn-main"><span class="fp-turn-num">' + String(turn.index).padStart(2, '0') + '</span><span class="fp-turn-prompt">' + escapeHtml(turn.prompt || '') + '</span></div>' +
            '<div class="fp-turn-meta">' + meta.map(part => '<span>' + escapeHtml(part) + '</span>').join('') + statusHtml + '</div>' +
          '</div>';
        }).join('');
      }

      // ── Subagent drilldown ─────────────────────────────────────────────
      function resetFilters() {
        activeTurnFilter = 'all';
        activeCategoryFilter = 'all';
        searchQuery = '';
        const sInp = document.getElementById('search-input');
        if (sInp) sInp.value = '';
        document.querySelectorAll('.wf-filter-pill').forEach(p => p.classList.toggle('active', p.getAttribute('data-filter') === 'all'));
      }

      function drilldownSubagent(subagentId) {
        if (!subagentId || !traceData.subagents || !traceData.subagents[subagentId]) return;
        activeSubagentId = subagentId;
        vscode.postMessage({ command: 'telemetry_feature', feature: 'fingerprint_drilldown' });
        const sub = traceData.subagents[subagentId];
        const bc = document.getElementById('subagent-breadcrumb');
        if (bc) bc.style.display = 'flex';
        const rEl = document.getElementById('crumb-subagent-role');
        if (rEl) rEl.textContent = 'Subagent: ' + (sub.role || 'subagent');
        const idEl = document.getElementById('crumb-subagent-id');
        if (idEl) idEl.textContent = sub.id || '';
        const status = (sub.status || 'done').toLowerCase();
        const sEl = document.getElementById('subagent-badge-status');
        if (sEl) {
          sEl.textContent = STATUS_LABELS[status] || status;
          sEl.className = 'fp-badge-subagent ' + status;
        }
        const aEl = document.getElementById('subagent-badge-actions');
        if (aEl) aEl.textContent = plural(sub.tools ? sub.tools.length : 0, 'action');
        resetFilters();
        selectedNodeId = null;
        cameraTouched = false;
        updateMetricsBar();
        updateTurnsSidebar();
        renderCanvas();
        fitToContent();
        if (sub.nodes && sub.nodes.length) selectNode(sub.nodes[0].id);
      }

      function exitSubagentDrilldown() {
        const prevSubId = activeSubagentId;
        activeSubagentId = null;
        const bc = document.getElementById('subagent-breadcrumb');
        if (bc) bc.style.display = 'none';
        resetFilters();
        cameraTouched = false;
        updateMetricsBar();
        updateTurnsSidebar();
        renderCanvas();
        fitToContent();
        if (prevSubId) {
          const subNode = (traceData.nodes || []).find(n => n.subagentId === prevSubId);
          if (subNode) selectNode(subNode.id);
        }
      }

      // ── Camera ─────────────────────────────────────────────────────────
      function applyTransform() {
        const vp = document.getElementById('viewport');
        if (vp) vp.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoomScale + ')';
        const lbl = document.getElementById('zoom-label');
        if (lbl) lbl.textContent = Math.round(zoomScale * 100) + '%';
      }

      function zoomAt(nextScale, clientX, clientY) {
        const container = document.querySelector('.fp-canvas-container');
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const x = clientX === undefined ? rect.width / 2 : clientX - rect.left;
        const y = clientY === undefined ? rect.height / 2 : clientY - rect.top;
        const scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextScale));
        // Keep the point under the cursor (or the centre) where it is.
        panX = x - (x - panX) * (scale / zoomScale);
        panY = y - (y - panY) * (scale / zoomScale);
        zoomScale = scale;
        cameraTouched = true;
        applyTransform();
      }

      function contentBounds() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        renderedNodes.forEach(node => {
          minX = Math.min(minX, node.posX);
          minY = Math.min(minY, node.posY);
          maxX = Math.max(maxX, node.posX + CARD_W);
          maxY = Math.max(maxY, node.posY + (node.h || 90));
        });
        return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      }

      // Fit everything; when that would make cards unreadable, keep a readable scale and show the start.
      function fitToContent(minScale) {
        const container = document.querySelector('.fp-canvas-container');
        const bounds = contentBounds();
        lastFitMinScale = minScale || MIN_ZOOM;
        if (!container || !bounds) return;
        const pad = 32;
        const width = container.clientWidth;
        const height = container.clientHeight;
        const fit = Math.min((width - pad * 2) / bounds.w, (height - pad * 2) / bounds.h, 1);
        zoomScale = Math.max(minScale || MIN_ZOOM, Math.min(MAX_ZOOM, fit));
        const scaledW = bounds.w * zoomScale;
        const scaledH = bounds.h * zoomScale;
        panX = scaledW <= width - pad * 2 ? (width - scaledW) / 2 - bounds.x * zoomScale : pad - bounds.x * zoomScale;
        panY = scaledH <= height - pad * 2 ? (height - scaledH) / 2 - bounds.y * zoomScale : pad - bounds.y * zoomScale;
        applyTransform();
      }

      // ── Canvas ─────────────────────────────────────────────────────────
      function nodeMatches(node) {
        if (activeCategoryFilter !== 'all') {
          if (activeCategoryFilter === 'sensitive' ? !node.sensitive : node.category !== activeCategoryFilter) return false;
        }
        if (searchQuery.trim()) {
          const q = searchQuery.trim().toLowerCase();
          const calls = (node.details && node.details.calls) || [];
          const haystack = [node.title, node.sub, node.filePath].concat(calls.map(c => (c.target || '') + ' ' + (c.command || ''))).join(' ').toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      }

      function visibleNodes(ds) {
        let nodes = ds.nodes || [];
        if (activeTurnFilter !== 'all') nodes = nodes.filter(n => n.turn === activeTurnFilter);
        if (activeCategoryFilter === 'all' && !searchQuery.trim()) return nodes;
        const matches = nodes.filter(n => !n.isTurnHub && nodeMatches(n));
        const turns = new Set(matches.map(n => n.turn));
        // Keep each matching turn's hub so results stay anchored to their turn.
        return nodes.filter(n => (n.isTurnHub && turns.has(n.turn)) || matches.includes(n));
      }

      function layoutBlast(nodes) {
        const hubs = nodes.filter(n => n.isTurnHub);
        let cursorX = 0;
        hubs.forEach(hub => {
          const satellites = nodes.filter(n => n !== hub && n.turn === hub.turn);
          const outer = satellites.length > 6;
          const rx = outer ? 470 : 330;
          const ry = outer ? 330 : 230;
          const clusterCx = cursorX + rx + CARD_W / 2;
          const cy = ry + 80;
          hub.bx = clusterCx - CARD_W / 2;
          hub.by = cy - 40;
          satellites.forEach((sat, i) => {
            const inner = !outer || i < 6;
            const count = inner ? Math.min(6, satellites.length) : satellites.length - 6;
            const index = inner ? i : i - 6;
            const angle = (index / count) * 2 * Math.PI - Math.PI / 2 + (inner ? 0 : Math.PI / count);
            const radiusX = inner && outer ? 300 : rx;
            const radiusY = inner && outer ? 205 : ry;
            sat.bx = clusterCx + Math.cos(angle) * radiusX - CARD_W / 2;
            sat.by = cy + Math.sin(angle) * radiusY - 40;
          });
          cursorX += rx * 2 + CARD_W + 140;
        });
      }

      function cardHtml(node) {
        const tagLabel = TAG_LABELS[node.type] || 'Tool';
        let footer = '';
        if (node.isTurnHub && node.details) {
          const meta = [formatTime(node.details.ts), node.details.durationMs ? formatDuration(node.details.durationMs) : '', plural(node.details.actions || 0, 'action')].filter(Boolean);
          footer += '<div class="fp-node-meta">' + escapeHtml(meta.join(' · ')) + '</div>';
        }
        const actions = [];
        if (node.sensitive) actions.push('<span class="fp-node-flag" title="Matches the sensitive-path rules">' + getNodeIconSvg('lock') + ' Sensitive</span>');
        if (node.filePath) actions.push('<button class="fp-node-open" data-action="open-file" data-filepath="' + escapeHtml(node.filePath) + '" data-line="' + (node.line || 1) + '" title="Open in the editor">Open file</button>');
        if (node.hasSubagentDrilldown && node.subagentId) {
          actions.push('<button class="fp-card-drilldown-btn" data-action="drilldown-subagent" data-subagent-id="' + escapeHtml(node.subagentId) + '">View ' + plural(node.subagentActionCount || 0, 'action') + ' →</button>');
        }
        if (actions.length) footer += '<div class="fp-node-actions">' + actions.join('') + '</div>';
        return '<div class="fp-node-top">' +
            '<span class="fp-node-tag ' + escapeHtml(node.type) + '">' + getNodeIconSvg(node.type) + ' ' + tagLabel + '</span>' +
            '<span class="fp-node-badge ' + escapeHtml(node.badgeType || 'muted') + '">' + escapeHtml(node.badge || 'OK') + '</span>' +
          '</div>' +
          '<div class="fp-node-name" title="' + escapeHtml(node.title) + '">' + escapeHtml(node.title) + '</div>' +
          (node.sub ? '<div class="fp-node-sub' + (node.isTurnHub ? ' prompt' : '') + '" title="' + escapeHtml(node.sub) + '">' + escapeHtml(node.sub) + '</div>' : '') +
          footer;
      }

      function renderCanvas() {
        const nodesLayer = document.getElementById('nodes-layer');
        const emptyEl = document.getElementById('empty-state');
        if (!nodesLayer) return;
        nodesLayer.innerHTML = '';
        renderedNodes = new Map();

        const ds = getCurrentDataset();
        const nodes = visibleNodes(ds);
        if (emptyEl) {
          emptyEl.style.display = nodes.length ? 'none' : 'flex';
          const filtered = (ds.nodes || []).length > 0;
          const title = document.getElementById('empty-title');
          const text = document.getElementById('empty-text');
          if (title) title.textContent = filtered ? 'Nothing matches' : 'No activity yet';
          if (text) text.textContent = filtered ? 'Try another filter or search.' : 'Send a prompt to the agent. The files it reads, changes and runs appear here.';
        }
        if (activeView === 'blast') layoutBlast(nodes);

        nodes.forEach(node => {
          const manual = manualPositions[positionKey(node.id)];
          node.posX = manual ? manual.x : activeView === 'blast' ? node.bx : node.x;
          node.posY = manual ? manual.y : activeView === 'blast' ? node.by : node.y;
          const card = document.createElement('div');
          card.className = 'fp-node-card ' + node.type + (node.isTurnHub ? ' hub' : '') + (node.sensitive ? ' sensitive' : '') + (node.id === selectedNodeId ? ' selected' : '');
          card.dataset.nodeId = node.id;
          card.tabIndex = 0;
          card.setAttribute('role', 'button');
          card.setAttribute('aria-label', (TAG_LABELS[node.type] || 'Tool') + ': ' + node.title + (node.badge ? ', ' + node.badge : ''));
          card.style.left = node.posX + 'px';
          card.style.top = node.posY + 'px';
          card.innerHTML = cardHtml(node);
          nodesLayer.appendChild(card);
          renderedNodes.set(node.id, node);
        });
        nodesLayer.querySelectorAll('.fp-node-card').forEach(card => {
          const node = renderedNodes.get(card.dataset.nodeId);
          if (node) node.h = card.offsetHeight;
        });
        renderConnections();
      }

      function renderConnections() {
        const svg = document.getElementById('svg-layer');
        if (!svg) return;
        svg.querySelectorAll('path').forEach(p => p.remove());
        const ds = getCurrentDataset();
        let maxX = 0, maxY = 0;
        renderedNodes.forEach(n => {
          maxX = Math.max(maxX, n.posX + CARD_W);
          maxY = Math.max(maxY, n.posY + (n.h || 90));
        });
        svg.style.width = (maxX + 400) + 'px';
        svg.style.height = (maxY + 400) + 'px';

        (ds.connections || []).forEach(conn => {
          const from = renderedNodes.get(conn.from);
          const to = renderedNodes.get(conn.to);
          if (!from || !to) return;
          const fromH = from.h || 90;
          const toH = to.h || 90;
          let d;
          if (activeView === 'blast') {
            const x1 = from.posX + CARD_W / 2, y1 = from.posY + fromH / 2;
            const x2 = to.posX + CARD_W / 2, y2 = to.posY + toH / 2;
            d = conn.kind === 'turn'
              ? 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + 200) + ' ' + (y1 - 160) + ', ' + (x2 - 200) + ' ' + (y2 - 160) + ', ' + x2 + ' ' + y2
              : 'M ' + x1 + ' ' + y1 + ' L ' + x2 + ' ' + y2;
          } else if (conn.kind === 'turn') {
            const x = from.posX + 24;
            const y1 = from.posY + fromH;
            const x2 = to.posX + 24;
            const y2 = to.posY;
            d = 'M ' + x + ' ' + y1 + ' C ' + x + ' ' + (y1 + 30) + ', ' + x2 + ' ' + (y2 - 30) + ', ' + x2 + ' ' + y2;
          } else {
            const x1 = from.posX + CARD_W, y1 = from.posY + Math.min(fromH / 2, 44);
            const x2 = to.posX, y2 = to.posY + Math.min(toH / 2, 44);
            const span = Math.max(24, Math.abs(x2 - x1) * 0.5);
            d = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + span) + ' ' + y1 + ', ' + (x2 - span) + ' ' + y2 + ', ' + x2 + ' ' + y2;
          }
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', d);
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke', conn.kind === 'turn' ? 'var(--line-strong)' : 'url(#' + (conn.grad || 'grad-dag-2') + ')');
          path.setAttribute('stroke-width', conn.kind === 'turn' ? '1.5' : '1.8');
          if (conn.dashed || to.sensitive) path.setAttribute('stroke-dasharray', '4 4');
          svg.appendChild(path);
        });
      }

      // ── Inspector ──────────────────────────────────────────────────────
      function box(label, body, tone) {
        return '<div class="fp-box' + (tone ? ' ' + tone : '') + '"><div class="fp-box-label">' + escapeHtml(label) + '</div>' + body + '</div>';
      }

      function outputBlock(text, length) {
        if (!text) return '<p class="fp-muted">No output.</p>';
        const truncated = length && length > text.length ? '<p class="fp-muted">Showing the first ' + text.length.toLocaleString() + ' of ' + length.toLocaleString() + ' characters.</p>' : '';
        return '<div class="fp-output collapsed"><pre>' + escapeHtml(text) + '</pre><button class="fp-output-toggle" data-action="toggle-output">Show all</button></div>' + truncated;
      }

      function callHtml(call, index, total) {
        const status = call.status || 'ok';
        let html = '<div class="fp-call">' +
          '<div class="fp-call-head"><span class="fp-call-title">' + (total > 1 ? '<span class="fp-call-num">' + (index + 1) + '</span>' : '') + escapeHtml(call.title || call.name) + '</span>' +
          '<span class="fp-node-badge ' + (status === 'error' ? 'red' : status === 'blocked' || status === 'running' ? 'amber' : 'muted') + '">' + escapeHtml(STATUS_LABELS[status] || status) + '</span></div>';
        if (call.command) html += '<div class="fp-term-line">$ ' + escapeHtml(call.command) + '</div>';
        else if (call.target) html += '<div class="fp-call-target">' + escapeHtml(call.target) + '</div>';
        html += '<div class="fp-call-label">' + (call.name === 'shell_exec' || call.name === 'shell_bg' || call.name === 'shell_read' ? 'Output' : 'Tool result') + '</div>';
        html += outputBlock(call.output, call.outputLength);
        html += '<details class="fp-call-args"><summary>Arguments</summary><pre>' + escapeHtml(call.args || '{}') + '</pre></details>';
        return html + '</div>';
      }

      function sensitiveBox(node) {
        const calls = (node.details && node.details.calls) || [];
        const blocked = calls.length > 0 && calls.every(c => c.status === 'blocked');
        return blocked
          ? box('Sensitive file', '<p>Andromity refused this access under its sensitive-path rules. The content did not reach the model.</p>', 'amber')
          : box('Sensitive file', '<p>This matches the sensitive-path rules and the access was not blocked, so its content may have reached the model.</p>', 'red');
      }

      function populateInspectorContent(id) {
        const ds = getCurrentDataset();
        const node = (ds.nodes || []).find(n => n.id === id);
        const bodyEl = document.getElementById('insp-content');
        if (!node || !bodyEl) return;
        const signature = JSON.stringify(node) + '|' + activeSubagentId;
        if (signature === inspectorSignature) return;
        inspectorSignature = signature;

        const titleEl = document.getElementById('insp-tab-title');
        const iconEl = document.getElementById('insp-icon');
        if (titleEl) titleEl.textContent = node.title || 'Inspector';
        if (iconEl) iconEl.innerHTML = getNodeIconSvg(node.type);
        const d = node.details || {};
        let html = '';

        if (node.isTurnHub) {
          const meta = [formatTime(d.ts), d.durationMs ? formatDuration(d.durationMs) : '', plural(d.actions || 0, 'action')].filter(Boolean).join(' · ');
          html += box(node.type === 'subagent' ? 'Task' : 'Prompt', '<p class="fp-prewrap">' + escapeHtml(d.prompt || node.sub || '') + '</p>' + (meta ? '<p class="fp-muted">' + escapeHtml(meta) + '</p>' : ''));
          if (d.followUps && d.followUps.length) {
            html += box('Follow-ups sent while it worked', d.followUps.map(f => '<p class="fp-prewrap">' + escapeHtml(f) + '</p>').join(''));
          }
          if (node.type === 'subagent') {
            const facts = [d.role ? 'Role: ' + d.role : '', d.model ? 'Model: ' + d.model : '', d.provider ? 'Provider: ' + d.provider : ''].filter(Boolean);
            if (facts.length) html += box('Subagent', '<p class="fp-muted">' + escapeHtml(facts.join(' · ')) + '</p>');
            if (d.error) html += box('Error', '<p class="fp-prewrap">' + escapeHtml(d.error) + '</p>', 'red');
            if (d.finalSummary) html += box('Result', outputBlock(d.finalSummary));
          }
        } else if (node.hasSubagentDrilldown) {
          const sub = (traceData.subagents || {})[node.subagentId] || {};
          const facts = ['Role: ' + (sub.role || 'subagent'), 'Status: ' + (STATUS_LABELS[sub.status] || sub.status || 'done'), sub.durationMs ? 'Time: ' + formatDuration(sub.durationMs) : '', sub.model ? 'Model: ' + sub.model : ''].filter(Boolean);
          html += box('Subagent', '<p class="fp-muted">' + escapeHtml(facts.join(' · ')) + '</p>' +
            '<button class="fp-btn-primary-drilldown" data-action="drilldown-subagent" data-subagent-id="' + escapeHtml(node.subagentId) + '">View its ' + plural((sub.tools || []).length, 'action') + ' →</button>');
          if (sub.task) html += box('Task', '<p class="fp-prewrap">' + escapeHtml(sub.task) + '</p>');
          if ((sub.tools || []).length) {
            html += box('Actions', '<div class="fp-subagent-tools-list">' + sub.tools.slice(0, 12).map(t =>
              '<div class="fp-subagent-tool-row"><span class="fp-subagent-tool-name">' + escapeHtml(t.name) + '</span><span class="fp-subagent-tool-desc">' + escapeHtml(t.target || '') + '</span></div>'
            ).join('') + (sub.tools.length > 12 ? '<p class="fp-muted">+' + (sub.tools.length - 12) + ' more</p>' : '') + '</div>');
          }
          if (sub.error) html += box('Error', '<p class="fp-prewrap">' + escapeHtml(sub.error) + '</p>', 'red');
          if (sub.summary) html += box('Result', outputBlock(sub.summary));
        } else {
          if (node.sensitive) html += sensitiveBox(node);
          if (node.filePath) {
            html += box('File', '<div class="fp-box-val">' + escapeHtml(node.sub || node.filePath) + '</div>' +
              '<button class="fp-btn-open-file" data-action="open-file" data-filepath="' + escapeHtml(node.filePath) + '" data-line="' + (node.line || 1) + '">Open in editor</button>');
          }
          const calls = d.calls || [];
          html += box(calls.length > 1 ? plural(calls.length, 'call') : 'Call', calls.map((call, i) => callHtml(call, i, calls.length)).join(''));
        }
        bodyEl.innerHTML = html;
      }

      function selectNode(id) {
        selectedNodeId = id;
        document.querySelectorAll('.fp-node-card').forEach(c => c.classList.toggle('selected', c.dataset.nodeId === id));
        toggleInspector(false);
        inspectorSignature = '';
        populateInspectorContent(id);
      }

      function triggerOpenFile(filePath, line) {
        if (filePath) vscode.postMessage({ command: 'open_file', filePath: filePath, line: line || 1 });
      }

      function switchView(view) {
        activeView = view;
        const tabDag = document.getElementById('tab-dag');
        const tabBlast = document.getElementById('tab-blast');
        if (tabDag) { tabDag.classList.toggle('active', view === 'dag'); tabDag.setAttribute('aria-selected', String(view === 'dag')); }
        if (tabBlast) { tabBlast.classList.toggle('active', view === 'blast'); tabBlast.setAttribute('aria-selected', String(view === 'blast')); }
        if (view === 'blast') vscode.postMessage({ command: 'telemetry_feature', feature: 'fingerprint_blast_view' });
        saveState();
        renderCanvas();
        cameraTouched = false;
        fitToContent();
      }

      function refit() {
        cameraTouched = false;
        renderCanvas();
        fitToContent();
      }

      function selectTurn(turn) {
        activeTurnFilter = turn;
        document.querySelectorAll('.fp-turn-item').forEach(item => item.classList.toggle('active', item.dataset.turn === turn));
        refit();
      }

      function setFilter(cat, el) {
        activeCategoryFilter = cat;
        document.querySelectorAll('.wf-filter-pill').forEach(pill => pill.classList.toggle('active', pill === el));
        refit();
      }

      function exportTraceJSON() {
        const ds = getCurrentDataset();
        vscode.postMessage({
          command: 'export_fingerprint',
          data: activeSubagentId ? Object.assign({ session_id: traceData.session_id, subagent_id: activeSubagentId }, ds) : traceData
        });
      }

      // ── Pointer and keyboard ───────────────────────────────────────────
      function setupInteractions() {
        const container = document.querySelector('.fp-canvas-container');
        if (!container) return;

        container.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          if (e.target.closest('.fp-canvas-toolbar, button, input, a, [data-action]')) return;
          const card = e.target.closest('.fp-node-card');
          if (card) {
            const node = renderedNodes.get(card.dataset.nodeId);
            if (node) {
              draggingNodeId = node.id;
              nodeDragStartX = e.clientX;
              nodeDragStartY = e.clientY;
              nodeOrigX = node.posX;
              nodeOrigY = node.posY;
              hasDraggedNode = false;
              card.classList.add('dragging');
            }
            return;
          }
          if (!isInspectorPinned && !isInspectorCollapsed) toggleInspector(true);
          if (selectedNodeId) {
            selectedNodeId = null;
            document.querySelectorAll('.fp-node-card.selected').forEach(c => c.classList.remove('selected'));
          }
          isCanvasPanning = true;
          panStartX = e.clientX - panX;
          panStartY = e.clientY - panY;
          container.classList.add('panning');
        });

        container.addEventListener('dblclick', (e) => {
          const card = e.target.closest('.fp-node-card');
          const node = card && renderedNodes.get(card.dataset.nodeId);
          if (node && node.hasSubagentDrilldown) drilldownSubagent(node.subagentId);
        });

        window.addEventListener('mousemove', (e) => {
          if (isCanvasPanning) {
            panX = e.clientX - panStartX;
            panY = e.clientY - panStartY;
            cameraTouched = true;
            applyTransform();
            return;
          }
          if (!draggingNodeId) return;
          const dx = (e.clientX - nodeDragStartX) / zoomScale;
          const dy = (e.clientY - nodeDragStartY) / zoomScale;
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasDraggedNode = true;
          if (!hasDraggedNode) return;
          const node = renderedNodes.get(draggingNodeId);
          const card = document.querySelector('.fp-node-card[data-node-id="' + CSS.escape(draggingNodeId) + '"]');
          if (node && card) {
            node.posX = nodeOrigX + dx;
            node.posY = nodeOrigY + dy;
            card.style.left = node.posX + 'px';
            card.style.top = node.posY + 'px';
            renderConnections();
          }
        });

        window.addEventListener('mouseup', () => {
          if (isCanvasPanning) {
            isCanvasPanning = false;
            container.classList.remove('panning');
          }
          if (!draggingNodeId) return;
          const card = document.querySelector('.fp-node-card[data-node-id="' + CSS.escape(draggingNodeId) + '"]');
          if (card) card.classList.remove('dragging');
          const node = renderedNodes.get(draggingNodeId);
          if (hasDraggedNode && node) {
            manualPositions[positionKey(node.id)] = { x: Math.round(node.posX), y: Math.round(node.posY) };
            saveState();
          } else if (node) {
            selectNode(node.id);
          }
          draggingNodeId = null;
        });

        container.addEventListener('wheel', (e) => {
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) {
            zoomAt(zoomScale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
          } else {
            panX -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
            panY -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
            cameraTouched = true;
            applyTransform();
          }
        }, { passive: false });

        container.addEventListener('keydown', (e) => {
          const card = e.target.closest && e.target.closest('.fp-node-card');
          if (!card || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          selectNode(card.dataset.nodeId);
        });
      }

      function activate(target) {
        const drillEl = target.closest('[data-action="drilldown-subagent"]');
        if (drillEl) {
          drilldownSubagent(drillEl.getAttribute('data-subagent-id'));
          return true;
        }
        const subItem = target.closest('.fp-subagent-item');
        if (subItem && subItem.dataset.subagentId) {
          drilldownSubagent(subItem.dataset.subagentId);
          return true;
        }
        const openFileEl = target.closest('[data-action="open-file"]');
        if (openFileEl) {
          triggerOpenFile(openFileEl.getAttribute('data-filepath'), parseInt(openFileEl.getAttribute('data-line') || '1', 10));
          return true;
        }
        const toggle = target.closest('[data-action="toggle-output"]');
        if (toggle) {
          const wrap = toggle.closest('.fp-output');
          const collapsed = wrap.classList.toggle('collapsed');
          toggle.textContent = collapsed ? 'Show all' : 'Show less';
          return true;
        }
        const turnEl = target.closest('.fp-turn-item');
        if (turnEl && turnEl.dataset.turn) {
          selectTurn(turnEl.dataset.turn);
          return true;
        }
        if (target.closest('#crumb-main-session')) {
          exitSubagentDrilldown();
          return true;
        }
        return false;
      }

      function bindControls() {
        const on = (id, handler) => {
          const el = document.getElementById(id);
          if (el) el.addEventListener('click', handler);
        };
        on('btn-banner-dismiss', () => {
          const pill = document.getElementById('banner-pill');
          if (pill) pill.remove();
          vscode.postMessage({ command: 'dismiss_notice' });
        });
        on('btn-back-to-session', exitSubagentDrilldown);
        on('btn-toggle-left-sidebar', () => toggleLeftSidebar());
        on('btn-collapse-left', () => toggleLeftSidebar(true));
        on('btn-pin-inspector', togglePinInspector);
        on('btn-toggle-right-sidebar', () => toggleInspector());
        on('btn-collapse-right', () => toggleInspector(true));
        on('btn-export-json', exportTraceJSON);
        on('btn-docs', () => vscode.postMessage({ command: 'open_docs' }));
        on('tab-dag', () => switchView('dag'));
        on('tab-blast', () => switchView('blast'));
        on('btn-zoom-out', () => zoomAt(zoomScale / 1.2));
        on('btn-zoom-in', () => zoomAt(zoomScale * 1.2));
        on('btn-zoom-fit', () => { cameraTouched = false; fitToContent(); });

        document.querySelectorAll('.wf-filter-pill').forEach(pill => {
          pill.addEventListener('click', () => setFilter(pill.getAttribute('data-filter') || 'all', pill));
        });
        const searchInp = document.getElementById('search-input');
        if (searchInp) {
          searchInp.addEventListener('input', () => {
            searchQuery = searchInp.value;
            refit();
          });
        }
        document.addEventListener('click', (e) => {
          if (e.target && activate(e.target)) e.stopPropagation();
        });
        document.addEventListener('keydown', (e) => {
          if ((e.key !== 'Enter' && e.key !== ' ') || !e.target || !e.target.closest) return;
          if (!e.target.closest('.fp-turn-item, .fp-subagent-item, #crumb-main-session')) return;
          e.preventDefault();
          activate(e.target);
        });
      }

      // ── Data from the extension ────────────────────────────────────────
      window.addEventListener('message', event => {
        const msg = event.data;
        if (!msg || msg.type !== 'fingerprint_init' || !msg.data) return;
        traceData = msg.data;
        if (activeSubagentId && (!traceData.subagents || !traceData.subagents[activeSubagentId])) {
          activeSubagentId = null;
          const bc = document.getElementById('subagent-breadcrumb');
          if (bc) bc.style.display = 'none';
        }
        updateMetricsBar();
        updateTurnsSidebar();
        renderCanvas();
        if (!cameraTouched) fitToContent(0.55);
        const ds = getCurrentDataset();
        if (selectedNodeId && (ds.nodes || []).some(n => n.id === selectedNodeId)) populateInspectorContent(selectedNodeId);
      });

      function init() {
        toggleLeftSidebar(isLeftSidebarCollapsed);
        const tabDag = document.getElementById('tab-dag');
        const tabBlast = document.getElementById('tab-blast');
        if (tabDag) tabDag.classList.toggle('active', activeView === 'dag');
        if (tabBlast) tabBlast.classList.toggle('active', activeView === 'blast');
        applyTransform();
        bindControls();
        setupInteractions();
        // The inspector and sidebar animate their widths; keep the fit until the user takes over the camera.
        const canvas = document.querySelector('.fp-canvas-container');
        if (canvas && typeof ResizeObserver !== 'undefined') {
          new ResizeObserver(() => { if (!cameraTouched) fitToContent(lastFitMinScale); }).observe(canvas);
        }
        vscode.postMessage({ type: 'fingerprint_ready' });
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
    })();
  `;
}
