export function getFingerprintScript(sessionId: string): string {
  return `
    (function() {
      const vscode = acquireVsCodeApi();

      let activeView = "dag";
      let activeTurnFilter = "all";
      let activeCategoryFilter = "all";
      let searchQuery = "";
      let selectedNodeId = null;
      let activeSubagentId = null;
      let zoomScale = 0.88;
      let panX = 0;
      let panY = 0;
      let isCanvasPanning = false;
      let panStartX = 0;
      let panStartY = 0;

      let draggingNodeId = null;
      let nodeDragStartX = 0;
      let nodeDragStartY = 0;
      let nodeOrigX = 0;
      let nodeOrigY = 0;
      let hasDraggedNode = false;

      let isLeftSidebarCollapsed = false;
      let isInspectorCollapsed = true;
      let isInspectorPinned = false;

      function toggleLeftSidebar(collapse) {
        const sb = document.getElementById('fp-sidebar');
        const btn = document.getElementById('btn-toggle-left-sidebar');
        if (!sb) return;
        if (collapse !== undefined) {
          isLeftSidebarCollapsed = collapse;
        } else {
          isLeftSidebarCollapsed = !isLeftSidebarCollapsed;
        }
        sb.classList.toggle('collapsed', isLeftSidebarCollapsed);
        if (btn) btn.classList.toggle('active', !isLeftSidebarCollapsed);
      }

      function toggleInspector(collapse) {
        const insp = document.getElementById('fp-inspector');
        const btn = document.getElementById('btn-toggle-right-sidebar');
        if (!insp) return;
        if (collapse !== undefined) {
          isInspectorCollapsed = collapse;
        } else {
          isInspectorCollapsed = !isInspectorCollapsed;
        }
        insp.classList.toggle('collapsed', isInspectorCollapsed);
        if (btn) btn.classList.toggle('active', !isInspectorCollapsed);
      }

      function togglePinInspector() {
        isInspectorPinned = !isInspectorPinned;
        const pinBtn = document.getElementById('btn-pin-inspector');
        const pinIcon = document.getElementById('pin-icon');
        if (pinBtn) {
          pinBtn.classList.toggle('pinned', isInspectorPinned);
          pinBtn.title = isInspectorPinned ? 'Unpin Inspector (Auto-close on canvas click)' : 'Pin Inspector (Keep open on canvas click)';
        }
        if (pinIcon) {
          pinIcon.setAttribute('fill', isInspectorPinned ? 'currentColor' : 'none');
        }
      }

      let traceData = {
        session_id: ${JSON.stringify(sessionId)},
        nodes: [],
        connections: [],
        metrics: {
          durationMs: 0,
          filesModified: 0,
          filesRead: 0,
          commandsRun: 0,
          airgapCount: 0
        },
        subagents: {}
      };

      function getCurrentDataset() {
        if (activeSubagentId && traceData.subagents && traceData.subagents[activeSubagentId]) {
          return traceData.subagents[activeSubagentId];
        }
        return traceData;
      }

      function getNodeIconSvg(type) {
        if (type === "llm") {
          return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>';
        }
        if (type === "read") {
          return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
        }
        if (type === "write") {
          return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
        }
        if (type === "shell") {
          return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
        }
        if (type === "subagent") {
          return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>';
        }
        if (type === "security") {
          return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
        }
        return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><circle cx="12" cy="12" r="10"/></svg>';
      }

      function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }

      function updateMetricsBar() {
        const ds = getCurrentDataset();
        const m = ds.metrics || {};
        const durEl = document.getElementById('metric-duration');
        const modEl = document.getElementById('metric-modified');
        const readEl = document.getElementById('metric-read');
        const cmdEl = document.getElementById('metric-commands');
        const secEl = document.getElementById('metric-security');

        if (durEl) durEl.innerText = ((m.durationMs || 0) / 1000).toFixed(2) + 's';
        if (modEl) modEl.innerText = (m.filesModified || 0) + ' Files';
        if (readEl) readEl.innerText = (m.filesRead || 0) + ' Context Ingested';
        if (cmdEl) cmdEl.innerText = (m.commandsRun || 0) + ' Executed';
        if (secEl) secEl.innerText = (m.airgapCount || 0) > 0 ? (m.airgapCount + ' Protected (.env)') : '0 Leaks · Clean';
      }

      function updateTurnsSidebar() {
        const turnListEl = document.getElementById('dynamic-turn-list');
        const badgeAll = document.getElementById('badge-all-turns');
        const titleEl = document.getElementById('sidebar-title');
        const labelAllEl = document.getElementById('turn-item-all-label');
        const subSecEl = document.getElementById('sidebar-subagents-section');
        const subListEl = document.getElementById('dynamic-subagent-list');

        if (!turnListEl) return;

        const ds = getCurrentDataset();
        const turns = new Set();
        (ds.nodes || []).forEach(n => {
          if (n.turn) turns.add(n.turn);
        });

        if (badgeAll) {
          badgeAll.innerText = String(turns.size);
        }

        if (activeSubagentId) {
          if (titleEl) titleEl.innerText = 'Subagent Lineage';
          if (labelAllEl) labelAllEl.innerText = 'All Subagent Actions';
          if (subSecEl) subSecEl.style.display = 'none';
        } else {
          if (titleEl) titleEl.innerText = 'Turn Sequence';
          if (labelAllEl) labelAllEl.innerText = 'All Turns & Lineage';

          // Spawned Subagents in main sidebar
          const subagentKeys = traceData.subagents ? Object.keys(traceData.subagents) : [];
          if (subSecEl) {
            if (subagentKeys.length > 0) {
              subSecEl.style.display = 'block';
              if (subListEl) {
                subListEl.innerHTML = '';
                subagentKeys.forEach(aid => {
                  const sub = traceData.subagents[aid];
                  const item = document.createElement('div');
                  item.className = 'fp-subagent-item';
                  item.dataset.subagentId = aid;
                  item.innerHTML = \`
                    <div class="fp-subagent-item-left">
                      \${getNodeIconSvg('subagent')}
                      <span>\${escapeHtml((sub.role || 'subagent').toUpperCase())}</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:4px;">
                      <span class="fp-subagent-actions-badge" style="font-size:10px; padding:1px 5px;">\${sub.tools ? sub.tools.length : 0}</span>
                      <span class="fp-badge-subagent \${(sub.status || 'done').toLowerCase()}">\${escapeHtml((sub.status || 'OK').toUpperCase())}</span>
                    </div>
                  \`;
                  subListEl.appendChild(item);
                });
              }
            } else {
              subSecEl.style.display = 'none';
            }
          }
        }

        turnListEl.innerHTML = '';
        Array.from(turns).forEach(t => {
          const item = document.createElement('div');
          item.className = 'fp-turn-item' + (activeTurnFilter === t ? ' active' : '');
          item.dataset.turn = t;
          const count = (ds.nodes || []).filter(n => n.turn === t).length;
          item.innerHTML = \`
            <span>\${escapeHtml(t.replace('-', ' ').toUpperCase())}</span>
            <span class="fp-badge">\${count}</span>
          \`;
          turnListEl.appendChild(item);
        });
      }

      function drilldownSubagent(subagentId) {
        if (!subagentId || !traceData.subagents || !traceData.subagents[subagentId]) return;
        activeSubagentId = subagentId;
        vscode.postMessage({ command: 'telemetry_feature', feature: 'fingerprint_drilldown' });
        const sub = traceData.subagents[subagentId];

        const bc = document.getElementById('subagent-breadcrumb');
        if (bc) bc.style.display = 'flex';
        const rEl = document.getElementById('crumb-subagent-role');
        if (rEl) rEl.innerText = 'Subagent: ' + (sub.role || 'agent').toUpperCase();
        const idEl = document.getElementById('crumb-subagent-id');
        if (idEl) idEl.innerText = sub.id || '';
        const sEl = document.getElementById('subagent-badge-status');
        if (sEl) {
          sEl.innerText = (sub.status || 'OK').toUpperCase();
          sEl.className = 'fp-badge-subagent ' + (sub.status || 'done').toLowerCase();
        }
        const aEl = document.getElementById('subagent-badge-actions');
        if (aEl) aEl.innerText = (sub.tools ? sub.tools.length : 0) + ' Actions';

        activeTurnFilter = 'all';
        activeCategoryFilter = 'all';
        searchQuery = '';
        const sInp = document.getElementById('search-input');
        if (sInp) sInp.value = '';
        document.querySelectorAll('.wf-filter-pill').forEach(p => {
          p.classList.toggle('active', p.getAttribute('data-filter') === 'all');
        });

        updateMetricsBar();
        updateTurnsSidebar();
        renderCanvas();

        if (sub.nodes && sub.nodes.length > 0) {
          selectedNodeId = sub.nodes[0].id;
          populateInspectorContent(selectedNodeId);
        }
        resetZoom();
      }

      function exitSubagentDrilldown() {
        const prevSubId = activeSubagentId;
        activeSubagentId = null;

        const bc = document.getElementById('subagent-breadcrumb');
        if (bc) bc.style.display = 'none';

        activeTurnFilter = 'all';
        activeCategoryFilter = 'all';
        searchQuery = '';
        const sInp = document.getElementById('search-input');
        if (sInp) sInp.value = '';
        document.querySelectorAll('.wf-filter-pill').forEach(p => {
          p.classList.toggle('active', p.getAttribute('data-filter') === 'all');
        });

        updateMetricsBar();
        updateTurnsSidebar();
        renderCanvas();

        if (prevSubId) {
          const subNode = (traceData.nodes || []).find(n => n.subagentId === prevSubId || n.id === prevSubId);
          if (subNode) {
            selectedNodeId = subNode.id;
            selectNode(subNode.id);
          }
        }
        resetZoom();
      }

      function applyTransform() {
        const vp = document.getElementById('viewport');
        if (vp) {
          vp.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoomScale + ')';
        }
        const lbl = document.getElementById('zoom-label');
        if (lbl) {
          lbl.innerText = Math.round(zoomScale * 100) + '%';
        }
      }

      function zoomCanvas(delta) {
        zoomScale = Math.max(0.4, Math.min(2.0, zoomScale + delta));
        applyTransform();
      }

      function resetZoom() {
        zoomScale = 0.88;
        panX = 0;
        panY = 0;
        applyTransform();
      }

      function renderConnections(nodeMap) {
        const svg = document.getElementById('svg-layer');
        if (!svg) return;
        svg.querySelectorAll('path').forEach(p => p.remove());

        const ds = getCurrentDataset();
        (ds.connections || []).forEach(conn => {
          const from = nodeMap.get(conn.from);
          const to = nodeMap.get(conn.to);
          if (from && to) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

            if (activeView === 'blast') {
              if (from.isTurnHub && to.isTurnHub) {
                // Inter-turn hub bridge
                const x1 = from.posX + 250;
                const y1 = from.posY + 40;
                const x2 = to.posX;
                const y2 = to.posY + 40;
                const span = (x2 - x1) * 0.5;
                const d = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + span) + ' ' + (y1 - 70) + ', ' + (x2 - span) + ' ' + (y2 - 70) + ', ' + x2 + ' ' + y2;
                path.setAttribute('d', d);
                path.setAttribute('stroke', 'url(#grad-dag-1)');
                path.setAttribute('stroke-width', '3');
              } else {
                // Radial ray connecting turn hub or subagent to satellite
                const x1 = from.posX + 125;
                const y1 = from.posY + 40;
                const x2 = to.posX + 125;
                const y2 = to.posY + 40;
                const mx = (x1 + x2) * 0.5;
                const my = (y1 + y2) * 0.5;
                const d = 'M ' + x1 + ' ' + y1 + ' Q ' + mx + ' ' + my + ' ' + x2 + ' ' + y2;
                path.setAttribute('d', d);
                path.setAttribute('stroke', 'url(#' + (conn.grad || 'grad-dag-2') + ')');
                path.setAttribute('stroke-width', '1.8');
              }
            } else {
              // Causal DAG smooth horizontal bezier
              const x1 = from.posX + 250;
              const y1 = from.posY + 40;
              const x2 = to.posX;
              const y2 = to.posY + 40;
              const sign = x2 >= x1 ? 1 : -1;
              const span = Math.max(30, Math.abs(x2 - x1) * 0.45);
              const d = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + span * sign) + ' ' + y1 + ', ' + (x2 - span * sign) + ' ' + y2 + ', ' + x2 + ' ' + y2;
              path.setAttribute('d', d);
              path.setAttribute('stroke', 'url(#' + (conn.grad || 'grad-dag-1') + ')');
              path.setAttribute('stroke-width', '2');
            }

            path.setAttribute('fill', 'none');
            if (conn.dashed || conn.to === 'security-env' || to.category === 'security') {
              path.setAttribute('stroke-dasharray', '4 4');
            }
            svg.appendChild(path);
          }
        });
      }

      function renderCanvas() {
        const nodesLayer = document.getElementById('nodes-layer');
        const emptyEl = document.getElementById('empty-state');
        if (!nodesLayer) return;

        nodesLayer.innerHTML = '';

        const ds = getCurrentDataset();
        let nodes = ds.nodes || [];

        if (nodes.length === 0) {
          if (emptyEl) emptyEl.style.display = 'flex';
          const svg = document.getElementById('svg-layer');
          if (svg) svg.querySelectorAll('path').forEach(p => p.remove());
          return;
        } else {
          if (emptyEl) emptyEl.style.display = 'none';
        }

        if (activeTurnFilter !== 'all') {
          nodes = nodes.filter(n => n.turn === activeTurnFilter);
        }
        if (activeCategoryFilter !== 'all') {
          nodes = nodes.filter(n => n.category === activeCategoryFilter);
        }
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          nodes = nodes.filter(n => (n.title && n.title.toLowerCase().includes(q)) || (n.sub && n.sub.toLowerCase().includes(q)));
        }

        const nodeMap = new Map();

        // Multi-Turn Planetary Clusters in Blast Radius View
        if (activeView === 'blast') {
          const turnHubs = nodes.filter(n => n.isTurnHub);
          const turnKeys = turnHubs.length > 0
            ? turnHubs.map(h => h.turn)
            : Array.from(new Set(nodes.map(n => n.turn || 'turn-1')));

          turnKeys.forEach((tKey, hIdx) => {
            const clusterCx = activeTurnFilter !== 'all' ? 520 : (520 + hIdx * 1100);
            const clusterCy = 420;

            const hub = nodes.find(n => n.isTurnHub && n.turn === tKey) || nodes.find(n => n.turn === tKey);
            const satellites = nodes.filter(n => n !== hub && n.turn === tKey);

            if (hub) {
              hub.posX = clusterCx - 125;
              hub.posY = clusterCy - 40;
            }

            const total = satellites.length;
            satellites.forEach((sat, sIdx) => {
              let satX, satY;
              if (total <= 6) {
                const rx = 320;
                const ry = 220;
                const angle = (sIdx / total) * 2 * Math.PI - Math.PI / 2;
                satX = clusterCx + Math.cos(angle) * rx - 125;
                satY = clusterCy + Math.sin(angle) * ry - 40;
              } else {
                if (sIdx < 6) {
                  const rx1 = 290;
                  const ry1 = 200;
                  const angle = (sIdx / 6) * 2 * Math.PI - Math.PI / 2;
                  satX = clusterCx + Math.cos(angle) * rx1 - 125;
                  satY = clusterCy + Math.sin(angle) * ry1 - 40;
                } else {
                  const rx2 = 450;
                  const ry2 = 320;
                  const outerTotal = total - 6;
                  const angle = ((sIdx - 6) / outerTotal) * 2 * Math.PI - Math.PI / 2 + (Math.PI / 6);
                  satX = clusterCx + Math.cos(angle) * rx2 - 125;
                  satY = clusterCy + Math.sin(angle) * ry2 - 40;
                }
              }
              sat.posX = satX;
              sat.posY = satY;
            });
          });
        }

        nodes.forEach(node => {
          let posX = activeView === 'blast' ? node.posX : node.x;
          let posY = activeView === 'blast' ? node.posY : node.y;

          node.posX = posX;
          node.posY = posY;
          nodeMap.set(node.id, node);

          const card = document.createElement('div');
          card.className = 'fp-node-card' + (node.type === 'subagent' ? ' subagent' : '') + (node.id === selectedNodeId ? ' selected' : '');
          card.dataset.nodeId = node.id;
          if (node.subagentId) {
            card.dataset.subagentId = node.subagentId;
          }
          card.style.left = posX + 'px';
          card.style.top = posY + 'px';

          const iconSvg = getNodeIconSvg(node.type);

          let fileActionHtml = '';
          if (node.filePath) {
            fileActionHtml = \`
              <div class="fp-node-file-link">
                <span class="fp-file-path-text" data-action="open-file" data-filepath="\${escapeHtml(node.filePath)}" data-line="\${node.line || 1}">
                  \${escapeHtml(node.filePath)}
                </span>
                <span class="fp-file-open-icon" data-action="open-file" data-filepath="\${escapeHtml(node.filePath)}" data-line="\${node.line || 1}">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  open
                </span>
              </div>
            \`;
          }

          if (node.type === 'subagent' || node.subagentId) {
            fileActionHtml += \`
              <button class="fp-card-drilldown-btn" data-action="drilldown-subagent" data-subagent-id="\${escapeHtml(node.subagentId || node.id)}">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                <span>Go Inside Subagent (\${node.subagentActionCount || (node.details?.actionsCount || 0)} Actions) &rarr;</span>
              </button>
            \`;
          }

          card.innerHTML = \`
            <div class="fp-node-top">
              <span class="fp-node-tag \${node.type}">\${iconSvg} \${node.type}</span>
              <span class="fp-node-badge \${node.badgeType || 'muted'}">\${escapeHtml(node.badge || 'OK')}</span>
            </div>
            <div class="fp-node-name">\${escapeHtml(node.title)}</div>
            <div class="fp-node-sub">\${escapeHtml(node.sub || '')}</div>
            \${fileActionHtml}
          \`;

          nodesLayer.appendChild(card);
        });

        // Draw SVG Connections
        renderConnections(nodeMap);
      }

      function populateInspectorContent(id) {
        const ds = getCurrentDataset();
        const node = (ds.nodes || []).find(n => n.id === id) || (traceData.nodes || []).find(n => n.id === id);
        if (!node) return;

        const titleEl = document.getElementById('insp-tab-title');
        const iconEl = document.getElementById('insp-icon');
        const bodyEl = document.getElementById('insp-content');

        if (titleEl) titleEl.innerText = node.title || 'Inspector';
        if (iconEl) iconEl.innerHTML = getNodeIconSvg(node.type);

        let html = \`
          <div class="fp-box">
            <div class="fp-box-label">Node Class</div>
            <div class="fp-box-val" style="color:var(--cyan);">\${escapeHtml(node.type.toUpperCase())} \${node.turn ? ('· ' + escapeHtml(node.turn.toUpperCase())) : ''}</div>
          </div>
        \`;

        // Subagent node inspector view
        if (node.type === "subagent" || node.subagentId) {
          const subId = node.subagentId || node.id;
          const subObj = (traceData.subagents && traceData.subagents[subId]) || null;
          const subRole = (subObj?.role || node.details?.role || "subagent").toUpperCase();
          const subStatus = (subObj?.status || node.details?.status || "OK").toUpperCase();
          const subDur = ((subObj?.durationMs || node.details?.durationMs || 0) / 1000).toFixed(2);
          const actCount = subObj?.tools ? subObj.tools.length : (node.subagentActionCount || node.details?.actionsCount || 0);

          html += \`
            <div class="fp-box" style="border-color: rgba(188, 140, 255, 0.4);">
              <div class="fp-box-label" style="color:var(--purple);">Subagent Details</div>
              <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:11.5px;">
                <span>Role: <strong style="color:var(--cyan);">\${escapeHtml(subRole)}</strong></span>
                <span class="fp-badge-subagent \${(subObj?.status || 'done').toLowerCase()}">\${escapeHtml(subStatus)}</span>
              </div>
              <div style="font-size:11px; color:var(--muted); margin-bottom:8px;">
                Duration: <span style="color:var(--fg);">\${subDur}s</span> · Actions: <span style="color:var(--fg);">\${actCount}</span>
                \${node.details?.model ? (' · Model: <span style="color:var(--fg);">' + escapeHtml(node.details.model) + '</span>') : ''}
              </div>
              <button class="fp-btn-primary-drilldown" data-action="drilldown-subagent" data-subagent-id="\${escapeHtml(subId)}">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                <span>Enter Subagent Trace (\${actCount} Actions) &rarr;</span>
              </button>
            </div>
          \`;

          if (node.details && (node.details.task || node.details.summary)) {
            html += \`
              <div class="fp-box">
                <div class="fp-box-label">Assigned Task Prompt</div>
                <p style="color:var(--fg); font-size:11.5px; line-height:1.4;">\${escapeHtml(node.details.task || node.details.summary)}</p>
              </div>
            \`;
          }

          const toolsList = subObj?.tools || node.details?.toolsPreview;
          if (Array.isArray(toolsList) && toolsList.length > 0) {
            html += \`
              <div class="fp-box">
                <div class="fp-box-label">Executed Actions Preview</div>
                <div class="fp-subagent-tools-list">
                  \${toolsList.map(t => \`
                    <div class="fp-subagent-tool-row" data-action="drilldown-subagent" data-subagent-id="\${escapeHtml(subId)}">
                      <span class="fp-subagent-tool-name">\${escapeHtml(t.name || 'tool')}</span>
                      <span class="fp-subagent-tool-desc">\${escapeHtml(t.desc || t.args?.file_path || t.args?.path || t.args?.command || '')}</span>
                      <span class="fp-subagent-tool-tag \${t.status === 'error' ? 'fp-badge-subagent failed' : 'fp-badge-subagent done'}">\${escapeHtml(t.status || 'OK')}</span>
                    </div>
                  \`).join('')}
                </div>
              </div>
            \`;
          }

          if (node.details?.finalSummary || (node.details?.summary && node.details?.summary !== node.details?.task)) {
            html += \`
              <div class="fp-box">
                <div class="fp-box-label">Subagent Final Output</div>
                <p style="color:var(--fg); font-size:11.5px; line-height:1.4;">\${escapeHtml(node.details.finalSummary || node.details.summary)}</p>
              </div>
            \`;
          }
        }

        if (node.details && node.details.diff && Array.isArray(node.details.diff)) {
          html += \`
            <div class="fp-box">
              <div class="fp-box-label">Modified File Diff</div>
              <div class="fp-box-val" style="color:var(--green);">\${escapeHtml(node.details.filePath || node.filePath)}</div>
              <div class="fp-diff-container">
                \${node.details.diff.map(d => \`
                  <div class="fp-diff-row \${d.type}">
                    <span class="fp-diff-num">\${d.ln || ''}</span>
                    <span>\${escapeHtml(d.text)}</span>
                  </div>
                \`).join('')}
              </div>
              <button class="fp-btn-open-file" data-action="open-file" data-filepath="\${escapeHtml(node.details.filePath || node.filePath)}" data-line="\${node.line || 1}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                <span>Open in VS Code Editor</span>
              </button>
            </div>
          \`;
        } else if (node.filePath) {
          html += \`
            <div class="fp-box">
              <div class="fp-box-label">File Details</div>
              <div class="fp-box-val">\${escapeHtml(node.filePath)}</div>
              <p style="color:var(--muted); font-size:11.5px; margin-top:6px;">\${escapeHtml(node.details?.purpose || node.sub || '')}</p>
              <button class="fp-btn-open-file" data-action="open-file" data-filepath="\${escapeHtml(node.filePath)}" data-line="\${node.line || 1}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                <span>Open File in Editor (Line \${node.line || 1})</span>
              </button>
            </div>
          \`;
        }

        if (node.details && node.details.cmd) {
          html += \`
            <div class="fp-box">
              <div class="fp-box-label">Shell Command & Output</div>
              <div class="fp-term-box">
                <div style="color:var(--cyan); margin-bottom:4px;">$ \${escapeHtml(node.details.cmd)}</div>
                <div>\${escapeHtml(node.details.stdout || '')}</div>
              </div>
            </div>
          \`;
        }

        if (node.type !== "subagent" && !node.subagentId && node.details && node.details.summary) {
          html += \`
            <div class="fp-box">
              <div class="fp-box-label">LLM Reasoning & Output</div>
              <p style="color:var(--fg); font-size:11.5px; line-height:1.4;">\${escapeHtml(node.details.summary)}</p>
            </div>
          \`;
        }

        if (node.details && node.details.reason) {
          html += \`
            <div class="fp-box" style="border-color: rgba(248, 81, 73, 0.3);">
              <div class="fp-box-label" style="color:var(--red);">AirGap Policy Interception</div>
              <p style="color:var(--fg); font-size:11.5px; margin-bottom:6px;">\${escapeHtml(node.details.reason)}</p>
              <div class="fp-box-val" style="color:var(--green);">\${escapeHtml(node.details.auditResult || 'Zero-Leak Protected')}</div>
            </div>
          \`;
        }

        if (bodyEl) bodyEl.innerHTML = html;
      }

      function selectNode(id) {
        selectedNodeId = id;
        document.querySelectorAll('.fp-node-card').forEach(c => {
          c.classList.toggle('selected', c.dataset.nodeId === id);
        });

        // Open inspector when explicitly selecting a node
        toggleInspector(false);
        populateInspectorContent(id);
      }

      function triggerOpenFile(filePath, line) {
        if (!filePath) return;
        vscode.postMessage({ command: 'open_file', filePath: filePath, line: line || 1 });
      }

      function switchView(view) {
        activeView = view;
        const tabDag = document.getElementById('tab-dag');
        const tabBlast = document.getElementById('tab-blast');
        if (tabDag) tabDag.classList.toggle('active', view === 'dag');
        if (tabBlast) tabBlast.classList.toggle('active', view === 'blast');
        if (view === 'blast') {
          vscode.postMessage({ command: 'telemetry_feature', feature: 'fingerprint_blast_view' });
        }
        renderCanvas();
      }

      function selectTurn(turn, el) {
        activeTurnFilter = turn;
        document.querySelectorAll('.fp-turn-item').forEach(item => item.classList.remove('active'));
        if (el) el.classList.add('active');
        renderCanvas();
      }

      function setFilter(cat, el) {
        activeCategoryFilter = cat;
        document.querySelectorAll('.wf-filter-pill').forEach(pill => pill.classList.remove('active'));
        if (el) el.classList.add('active');
        renderCanvas();
      }

      function showSafetyNotice() {
        vscode.postMessage({
          command: 'show_info',
          message: 'The Fingerprint panel is 100% READ-ONLY. It listens passively to the in-memory trace event log and cannot modify code, execute commands, or infiltrate agent core.'
        });
      }

      function exportTraceJSON() {
        const ds = getCurrentDataset();
        vscode.postMessage({
          command: 'export_fingerprint',
          data: activeSubagentId ? { session_id: traceData.session_id, subagent_id: activeSubagentId, ...ds } : traceData
        });
      }

      function setupInteractions() {
        const container = document.querySelector('.fp-canvas-container');
        if (!container) return;

        container.addEventListener('mousedown', (e) => {
          // If clicking on toolbar, buttons, inputs, file link actions, or drilldown actions, do not initiate canvas pan
          if (
            e.target.closest('.fp-canvas-toolbar') ||
            e.target.closest('button') ||
            e.target.closest('input') ||
            e.target.closest('[data-action="open-file"]') ||
            e.target.closest('[data-action="drilldown-subagent"]')
          ) {
            return;
          }

          const card = e.target.closest('.fp-node-card');
          if (card) {
            // Node Dragging initiated
            const nId = card.dataset.nodeId;
            const ds = getCurrentDataset();
            const node = (ds.nodes || []).find(n => n.id === nId);
            if (node) {
              draggingNodeId = nId;
              nodeDragStartX = e.clientX;
              nodeDragStartY = e.clientY;
              nodeOrigX = node.posX !== undefined ? node.posX : node.x;
              nodeOrigY = node.posY !== undefined ? node.posY : node.y;
              hasDraggedNode = false;
              card.classList.add('dragging');
            }
            return;
          }

          // Canvas Panning initiated on empty background
          if (!isInspectorPinned && !isInspectorCollapsed) {
            toggleInspector(true);
          }
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
          if (card && card.dataset.nodeId) {
            const ds = getCurrentDataset();
            const node = (ds.nodes || []).find(n => n.id === card.dataset.nodeId);
            if (node && (node.type === 'subagent' || node.subagentId)) {
              drilldownSubagent(node.subagentId || node.id);
            }
          }
        });

        window.addEventListener('mousemove', (e) => {
          if (isCanvasPanning) {
            panX = e.clientX - panStartX;
            panY = e.clientY - panStartY;
            applyTransform();
            return;
          }

          if (draggingNodeId) {
            const dx = (e.clientX - nodeDragStartX) / zoomScale;
            const dy = (e.clientY - nodeDragStartY) / zoomScale;

            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
              hasDraggedNode = true;
            }

            const ds = getCurrentDataset();
            const node = (ds.nodes || []).find(n => n.id === draggingNodeId);
            const card = document.querySelector('.fp-node-card[data-node-id="' + draggingNodeId + '"]');
            if (node && card) {
              node.posX = nodeOrigX + dx;
              node.posY = nodeOrigY + dy;
              node.x = node.posX;
              node.y = node.posY;
              card.style.left = node.posX + 'px';
              card.style.top = node.posY + 'px';

              // Redraw connections in real time
              const nodeMap = new Map();
              (ds.nodes || []).forEach(n => nodeMap.set(n.id, n));
              renderConnections(nodeMap);
            }
          }
        });

        window.addEventListener('mouseup', () => {
          if (isCanvasPanning) {
            isCanvasPanning = false;
            container.classList.remove('panning');
          }

          if (draggingNodeId) {
            const card = document.querySelector('.fp-node-card[data-node-id="' + draggingNodeId + '"]');
            if (card) {
              card.classList.remove('dragging');
            }

            if (!hasDraggedNode) {
              selectNode(draggingNodeId);
            }

            draggingNodeId = null;
          }
        });

        // Mouse Wheel: Pan or Ctrl+Wheel to Zoom
        container.addEventListener('wheel', (e) => {
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) {
            const delta = e.deltaY < 0 ? 0.08 : -0.08;
            zoomScale = Math.max(0.4, Math.min(2.0, zoomScale + delta));
            applyTransform();
          } else {
            panX -= e.deltaX;
            panY -= e.deltaY;
            applyTransform();
          }
        }, { passive: false });
      }

      function bindControls() {
        const btnBannerSafety = document.getElementById('btn-banner-safety');
        if (btnBannerSafety) {
          btnBannerSafety.addEventListener('click', showSafetyNotice);
        }

        const btnBannerDismiss = document.getElementById('btn-banner-dismiss');
        if (btnBannerDismiss) {
          btnBannerDismiss.addEventListener('click', () => {
            const pill = document.getElementById('banner-pill');
            if (pill) pill.style.display = 'none';
          });
        }

        const btnBack = document.getElementById('btn-back-to-session');
        if (btnBack) {
          btnBack.addEventListener('click', exitSubagentDrilldown);
        }

        const crumbMain = document.getElementById('crumb-main-session');
        if (crumbMain) {
          crumbMain.addEventListener('click', exitSubagentDrilldown);
        }

        const btnToggleLeft = document.getElementById('btn-toggle-left-sidebar');
        if (btnToggleLeft) {
          btnToggleLeft.addEventListener('click', () => toggleLeftSidebar());
        }

        const btnCollapseLeft = document.getElementById('btn-collapse-left');
        if (btnCollapseLeft) {
          btnCollapseLeft.addEventListener('click', () => toggleLeftSidebar(true));
        }

        const btnPin = document.getElementById('btn-pin-inspector');
        if (btnPin) {
          btnPin.addEventListener('click', () => togglePinInspector());
        }

        const btnToggleRight = document.getElementById('btn-toggle-right-sidebar');
        if (btnToggleRight) {
          btnToggleRight.addEventListener('click', () => toggleInspector());
        }

        const btnCollapseRight = document.getElementById('btn-collapse-right');
        if (btnCollapseRight) {
          btnCollapseRight.addEventListener('click', () => toggleInspector(true));
        }

        const btnSafetyGuard = document.getElementById('btn-safety-guard');
        if (btnSafetyGuard) {
          btnSafetyGuard.addEventListener('click', showSafetyNotice);
        }

        const btnFit = document.getElementById('btn-fit-canvas');
        if (btnFit) {
          btnFit.addEventListener('click', resetZoom);
        }

        const btnExport = document.getElementById('btn-export-json');
        if (btnExport) {
          btnExport.addEventListener('click', exportTraceJSON);
        }

        const tabDag = document.getElementById('tab-dag');
        if (tabDag) {
          tabDag.addEventListener('click', () => switchView('dag'));
        }

        const tabBlast = document.getElementById('tab-blast');
        if (tabBlast) {
          tabBlast.addEventListener('click', () => switchView('blast'));
        }

        document.querySelectorAll('.wf-filter-pill').forEach(pill => {
          pill.addEventListener('click', () => {
            const filter = pill.getAttribute('data-filter') || 'all';
            setFilter(filter, pill);
          });
        });

        const searchInp = document.getElementById('search-input');
        if (searchInp) {
          searchInp.addEventListener('input', () => {
            searchQuery = searchInp.value;
            renderCanvas();
          });
        }

        const btnZoomOut = document.getElementById('btn-zoom-out');
        if (btnZoomOut) {
          btnZoomOut.addEventListener('click', () => zoomCanvas(-0.1));
        }

        const btnZoomIn = document.getElementById('btn-zoom-in');
        if (btnZoomIn) {
          btnZoomIn.addEventListener('click', () => zoomCanvas(0.1));
        }

        const btnZoomFit = document.getElementById('btn-zoom-fit');
        if (btnZoomFit) {
          btnZoomFit.addEventListener('click', resetZoom);
        }

        const turnItemAll = document.getElementById('turn-item-all');
        if (turnItemAll) {
          turnItemAll.addEventListener('click', () => selectTurn('all', turnItemAll));
        }

        // Delegated click handler for file links, drilldowns, and dynamic sidebar turns
        document.addEventListener('click', (e) => {
          const target = e.target;
          if (!target) return;

          const drillEl = target.closest('[data-action="drilldown-subagent"]');
          if (drillEl) {
            e.stopPropagation();
            const subId = drillEl.getAttribute('data-subagent-id');
            if (subId) {
              drilldownSubagent(subId);
            }
            return;
          }

          const subItem = target.closest('.fp-subagent-item');
          if (subItem && subItem.dataset.subagentId) {
            e.stopPropagation();
            drilldownSubagent(subItem.dataset.subagentId);
            return;
          }

          const openFileEl = target.closest('[data-action="open-file"]');
          if (openFileEl) {
            e.stopPropagation();
            const filePath = openFileEl.getAttribute('data-filepath');
            const line = parseInt(openFileEl.getAttribute('data-line') || '1', 10);
            if (filePath) {
              triggerOpenFile(filePath, line);
            }
            return;
          }

          const turnEl = target.closest('.fp-turn-item');
          if (turnEl && turnEl.dataset.turn) {
            e.stopPropagation();
            selectTurn(turnEl.dataset.turn, turnEl);
            return;
          }
        });
      }

      // Message Handling from VS Code Extension Host
      window.addEventListener('message', event => {
        const msg = event.data;
        if (!msg) return;

        if (msg.type === 'fingerprint_init') {
          if (msg.data) {
            traceData = msg.data;
            if (activeSubagentId && (!traceData.subagents || !traceData.subagents[activeSubagentId])) {
              activeSubagentId = null;
              const bc = document.getElementById('subagent-breadcrumb');
              if (bc) bc.style.display = 'none';
            }
            updateMetricsBar();
            updateTurnsSidebar();
            renderCanvas();

            const ds = getCurrentDataset();
            if (ds.nodes && ds.nodes.length > 0) {
              if (!selectedNodeId || !ds.nodes.find(n => n.id === selectedNodeId)) {
                selectedNodeId = ds.nodes[0].id;
              }
              populateInspectorContent(selectedNodeId);
            }
          }
        }
      });

      // Signal ready with robust readyState check
      function init() {
        applyTransform();
        bindControls();
        setupInteractions();
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
