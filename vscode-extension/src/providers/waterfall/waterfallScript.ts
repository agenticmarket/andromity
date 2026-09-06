export function getWaterfallScript(sessionId: string): string {
  return `
    (function() {
      const vscode = acquireVsCodeApi();

      // State
      const state = {
        sessionId: ${JSON.stringify(sessionId)},
        turns: new Map(),
        spans: new Map(),
        currentTurnId: null,
        activeTab: 'timeline',
        filterType: 'all',
        searchQuery: '',
        autoScroll: true,
        isRunning: false,
        logs: [],
        totals: {
          durationMs: 0,
          llmMs: 0,
          toolMs: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0
        }
      };

      // DOM Elements
      const els = {
        viewContainer: document.getElementById('wf-view-container') || document.querySelector('.wf-view-container'),
        liveDot: document.getElementById('wf-live-dot'),
        liveText: document.getElementById('wf-live-text'),
        totalDuration: document.getElementById('wf-total-duration'),
        totalLlm: document.getElementById('wf-total-llm'),
        totalTools: document.getElementById('wf-total-tools'),
        totalTokens: document.getElementById('wf-total-tokens'),
        timelineContainer: document.getElementById('wf-timeline-container'),
        logContainer: document.getElementById('wf-log-container'),
        statsContainer: document.getElementById('wf-stats-container'),
        emptyState: document.getElementById('wf-empty-state'),
        searchInput: document.getElementById('wf-search'),
        btnAutoScroll: document.getElementById('btn-autoscroll'),
        btnClear: document.getElementById('btn-clear'),
        btnExport: document.getElementById('btn-export'),
        btnGuide: document.getElementById('btn-guide'),
        guideModal: document.getElementById('wf-guide-modal'),
        guideClose: document.getElementById('wf-guide-close')
      };

      let _scrollRaf = null;
      function scrollToBottomIfNeeded() {
        if (!state.autoScroll) return;
        if (_scrollRaf) return;
        _scrollRaf = requestAnimationFrame(() => {
          _scrollRaf = null;
          if (!state.autoScroll) return;

          const vc = els.viewContainer || document.getElementById('wf-view-container') || document.querySelector('.wf-view-container');
          if (state.activeTab === 'timeline') {
            if (vc) {
              vc.scrollTop = vc.scrollHeight;
            }
            if (document.documentElement) {
              document.documentElement.scrollTop = document.documentElement.scrollHeight;
            }
            if (document.body) {
              document.body.scrollTop = document.body.scrollHeight;
            }
          } else if (state.activeTab === 'log') {
            if (els.logContainer) {
              els.logContainer.scrollTop = els.logContainer.scrollHeight;
            }
            if (vc) {
              vc.scrollTop = vc.scrollHeight;
            }
          }
        });
      }

      function formatMs(ms) {
        if (!ms || isNaN(ms)) return '0.00s';
        if (ms < 1000) return Math.round(ms) + 'ms';
        return (ms / 1000).toFixed(2) + 's';
      }

      function formatTime(ts) {
        const d = ts ? new Date(ts * 1000) : new Date();
        return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
      }

      function ensureTurn(turnId, userQuery) {
        if (!turnId) {
          turnId = state.currentTurnId || ('turn_' + (state.turns.size + 1));
        }
        state.currentTurnId = turnId;

        if (!state.turns.has(turnId)) {
          const turnNumber = state.turns.size + 1;
          const t = {
            id: turnId,
            number: turnNumber,
            query: userQuery || 'Agent Turn',
            startTime: Date.now(),
            endTime: null,
            durationMs: 0,
            tokens: 0,
            spans: [],
            isExpanded: true,
            element: null
          };
          state.turns.set(turnId, t);
          renderTurn(t);
        } else if (userQuery && userQuery !== 'Agent Turn') {
          const t = state.turns.get(turnId);
          if (t && t.query === 'Agent Turn') {
            t.query = userQuery;
            const qEl = t.element ? t.element.querySelector('.wf-turn-query') : null;
            if (qEl) {
              qEl.textContent = userQuery;
              qEl.title = userQuery;
            }
          }
        }
        return state.turns.get(turnId);
      }

      function renderTurn(turn) {
        if (els.emptyState) els.emptyState.style.display = 'none';

        const group = document.createElement('div');
        group.className = 'wf-turn-group';
        group.id = 'wf-turn-' + turn.id;

        group.innerHTML = \`
          <div class="wf-turn-header" data-turn-id="\${turn.id}">
            <div class="wf-turn-title-wrap">
              <span class="wf-turn-badge">Turn #\${turn.number}</span>
              <span class="wf-turn-query" title="\${escapeHtml(turn.query)}">\${escapeHtml(turn.query)}</span>
            </div>
            <div class="wf-turn-meta">
              <span class="wf-turn-tokens" id="wf-turn-tok-\${turn.id}" style="color: var(--cyan); margin-right: 8px;"></span>
              <span class="wf-turn-duration" id="wf-turn-dur-\${turn.id}">0.00s</span>
            </div>
          </div>
          <div class="wf-timeline-table">
            <div class="wf-ruler">
              <div class="wf-ruler-left">OPERATION / LAYER</div>
              <div class="wf-ruler-track">
                <span>0s</span>
                <span>25%</span>
                <span>50%</span>
                <span>75%</span>
                <span class="wf-ruler-max" id="wf-ruler-max-\${turn.id}">1.0s</span>
              </div>
              <div class="wf-ruler-right">DURATION</div>
            </div>
            <div class="wf-spans-list" id="wf-spans-\${turn.id}"></div>
          </div>
        \`;

        group.querySelector('.wf-turn-header').addEventListener('click', () => {
          const list = group.querySelector('.wf-timeline-table');
          const isCollapsed = list.style.display === 'none';
          list.style.display = isCollapsed ? 'flex' : 'none';
        });

        turn.element = group;
        els.timelineContainer.appendChild(group);

        scrollToBottomIfNeeded();
      }

      function renderSpanRow(span) {
        const turn = state.turns.get(span.turnId);
        if (!turn) return;

        const container = document.getElementById('wf-spans-' + span.turnId);
        if (!container) return;

        const row = document.createElement('div');
        row.className = 'wf-span-row';
        row.id = 'wf-span-' + span.id;
        row.dataset.type = span.type;
        row.dataset.name = span.name.toLowerCase();

        const badgeClass = span.type === 'llm' ? 'llm' : span.type === 'subagent' ? 'subagent' : span.type === 'coordination' ? 'coordination' : 'tool';
        const badgeLabel = span.type === 'llm' ? 'LLM' : span.type === 'subagent' ? 'AGENT' : span.type === 'coordination' ? 'COORD' : 'TOOL';

        row.innerHTML = \`
          <div class="wf-span-main">
            <div class="wf-span-left">
              <div class="wf-span-chevron">▶</div>
              <span class="wf-span-badge \${badgeClass}">\${badgeLabel}</span>
              <span class="wf-span-name" title="\${escapeHtml(span.name)}">\${escapeHtml(span.name)}</span>
            </div>
            <div class="wf-span-track">
              <div class="wf-bar \${badgeClass} \${span.status === 'running' ? 'running' : ''}" id="wf-bar-\${span.id}" style="left: 0%; width: 5%;">
                <div class="wf-bar-ttfb" id="wf-ttfb-\${span.id}" style="display: none;"></div>
              </div>
            </div>
            <div class="wf-span-time" id="wf-label-\${span.id}">0.00s</div>
          </div>
          <div class="wf-span-details" id="wf-details-\${span.id}">
            <div class="wf-detail-grid" id="wf-meta-\${span.id}"></div>
            <div id="wf-payload-\${span.id}"></div>
          </div>
        \`;

        row.querySelector('.wf-span-main').addEventListener('click', () => {
          row.classList.toggle('expanded');
          updateSpanDetailsContent(span);
        });

        span.element = row;
        container.appendChild(row);
        scrollToBottomIfNeeded();
      }

      function updateSpanDetailsContent(span) {
        const metaEl = document.getElementById('wf-meta-' + span.id);
        const payloadEl = document.getElementById('wf-payload-' + span.id);
        if (!metaEl || !payloadEl) return;

        const now = Date.now();
        const effectiveDuration = span.durationMs || (span.startTime ? ((span.endTime || now) - span.startTime) : 0);

        let metaHtml = '';
        metaHtml += \`<div class="wf-detail-item" title="Total wall-clock duration of this operation"><div class="wf-detail-key">Duration</div><div class="wf-detail-val">\${formatMs(effectiveDuration)}</div></div>\`;
        metaHtml += \`<div class="wf-detail-item" title="Status of execution (running, done, or error)"><div class="wf-detail-key">Status</div><div class="wf-detail-val"><span class="wf-badge-pill \${span.status === 'done' ? 'response' : span.status === 'error' ? 'error' : 'thinking'}">\${span.status}</span></div></div>\`;

        if (span.type === 'llm') {
          if (span.model) metaHtml += \`<div class="wf-detail-item" title="Model and provider that generated this response"><div class="wf-detail-key">Model</div><div class="wf-detail-val">\${escapeHtml(span.model)}</div></div>\`;
          if (span.ttfbMs) metaHtml += \`<div class="wf-detail-item" title="Time to First Byte: Latency before first token was received from model"><div class="wf-detail-key">TTFB</div><div class="wf-detail-val">\${formatMs(span.ttfbMs)}</div></div>\`;
          if (span.totalTokens) metaHtml += \`<div class="wf-detail-item" title="Total tokens: P = Prompt (context sent) / C = Completion (generated response)"><div class="wf-detail-key">Tokens</div><div class="wf-detail-val">\${span.totalTokens.toLocaleString()} (P:\${span.promptTokens || 0} / C:\${span.completionTokens || 0})</div></div>\`;
          if (span.durationMs && span.completionTokens) {
            const tps = (span.completionTokens / (span.durationMs / 1000)).toFixed(1);
            metaHtml += \`<div class="wf-detail-item" title="Generation throughput in completion tokens per second"><div class="wf-detail-key">Speed</div><div class="wf-detail-val">\${tps} tok/s</div></div>\`;
          }
        } else if (span.type === 'tool') {
          metaHtml += \`<div class="wf-detail-item" title="Internal Tool Call ID"><div class="wf-detail-key">Tool Call ID</div><div class="wf-detail-val">\${escapeHtml(span.id)}</div></div>\`;
        } else if (span.type === 'subagent') {
          if (span.role) metaHtml += \`<div class="wf-detail-item" title="Specialized role of the subagent"><div class="wf-detail-key">Role</div><div class="wf-detail-val">\${escapeHtml(span.role)}</div></div>\`;
          if (span.model) metaHtml += \`<div class="wf-detail-item" title="Model assigned to subagent"><div class="wf-detail-key">Model</div><div class="wf-detail-val">\${escapeHtml(span.provider ? (span.provider + '/' + span.model) : span.model)}</div></div>\`;
          const stepsCount = (span.toolSteps || []).length;
          metaHtml += \`<div class="wf-detail-item" title="Count of internal tool actions executed by this subagent"><div class="wf-detail-key">Internal Steps</div><div class="wf-detail-val">\${stepsCount} tool\${stepsCount === 1 ? '' : 's'}</div></div>\`;
        }

        metaEl.innerHTML = metaHtml;

        let payloadHtml = '';
        if (span.type === 'llm') {
          if (span.thinking) {
            payloadHtml += \`
              <div style="margin-bottom: 10px;">
                <div class="wf-badge-pill thinking">Thinking / Chain of Thought</div>
                <div class="wf-thinking-box">
                  <button class="wf-copy-btn" data-copy-target="wf-cot-\${span.id}">Copy</button>
                  <code id="wf-cot-\${span.id}">\${escapeHtml(span.thinking)}</code>
                </div>
              </div>
            \`;
          }
          if (span.response) {
            let renderedResponse = '';
            if (typeof marked !== 'undefined' && marked.parse) {
              try {
                renderedResponse = marked.parse(span.response);
              } catch (e) {
                renderedResponse = \`<pre><code>\${escapeHtml(span.response)}</code></pre>\`;
              }
            } else {
              renderedResponse = \`<pre><code>\${escapeHtml(span.response)}</code></pre>\`;
            }

            payloadHtml += \`
              <div style="margin-bottom: 10px;">
                <div class="wf-badge-pill response">Model Response</div>
                <div class="wf-response-box">
                  <button class="wf-copy-btn" data-copy-target="wf-resp-\${span.id}">Copy</button>
                  <div class="wf-rendered-markdown" id="wf-resp-\${span.id}" data-raw-text="\${escapeHtml(span.response)}">\${renderedResponse}</div>
                </div>
              </div>
            \`;
          }
          if (span.toolCalls && span.toolCalls.length > 0) {
            const rawTools = JSON.stringify(span.toolCalls, null, 2);
            payloadHtml += \`
              <div>
                <div class="wf-badge-pill tools">Generated Tool Calls (\${span.toolCalls.length})</div>
                <div class="wf-code-box">
                  <button class="wf-copy-btn" data-copy-target="wf-tc-\${span.id}">Copy</button>
                  <code id="wf-tc-\${span.id}">\${escapeHtml(rawTools)}</code>
                </div>
              </div>
            \`;
          }
          if (!span.thinking && !span.response && (!span.toolCalls || span.toolCalls.length === 0)) {
            if (span.status === 'running') {
              payloadHtml += \`<div style="color: var(--cyan); font-family: var(--font-mono); font-size: 11px; padding: 6px 0;">⚡ Generating model completion...</div>\`;
            } else {
              payloadHtml += \`<div style="color: var(--muted); font-family: var(--font-mono); font-size: 11px; padding: 6px 0;">(No textual response content)</div>\`;
            }
          }
        } else if (span.type === 'subagent') {
          if (span.args) {
            const rawArgs = typeof span.args === 'string' ? span.args : JSON.stringify(span.args, null, 2);
            payloadHtml += \`
              <div style="margin-bottom: 12px;">
                <div class="wf-badge-pill tools" style="margin-bottom: 6px;">Subagent Assigned Task</div>
                <div class="wf-code-box" style="white-space: pre-wrap; font-family: var(--font-ui); font-size: 12px; line-height: 1.5; padding: 10px 12px;">
                  <button class="wf-copy-btn" data-copy-target="wf-args-\${span.id}">Copy</button>
                  <span id="wf-args-\${span.id}">\${escapeHtml(rawArgs)}</span>
                </div>
              </div>
            \`;
          }

          if (span.toolSteps && span.toolSteps.length > 0) {
            let stepsRows = '';
            span.toolSteps.forEach((step, idx) => {
              const stepDur = step.durationMs ? formatMs(step.durationMs) : (step.status === 'running' ? 'running...' : '-');
              const statusClass = step.status === 'done' ? 'response' : step.status === 'error' ? 'error' : 'thinking';
              const stepDomId = 'wf-step-' + span.id + '-' + idx;
              const hasContent = !!(step.args || step.result);
              stepsRows += \`
                <div style="border-bottom: 1px solid var(--border);">
                  <div onclick="window.toggleStepDetail('\${stepDomId}')" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; font-size: 11px; background: rgba(255,255,255,0.01); cursor: \${hasContent ? 'pointer' : 'default'};">
                    <div style="display: flex; align-items: center; gap: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 75%;">
                      \${hasContent ? \`<span id="wf-step-arrow-\${stepDomId}" style="font-size: 8px; color: var(--muted); transition: transform 0.15s ease; display: inline-block;">▶</span>\` : ''}
                      <span class="wf-span-badge tool" style="font-size: 9px; padding: 1px 6px;">#\${idx + 1} \${escapeHtml(step.name)}</span>
                      <span style="color: var(--fg); overflow: hidden; text-overflow: ellipsis;" title="\${escapeHtml(step.detail || step.name)}">\${escapeHtml(step.detail || step.name)}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px; flex-shrink: 0;">
                      <span style="color: var(--muted); font-family: var(--font-mono);">\${stepDur}</span>
                      <span class="wf-badge-pill \${statusClass}" style="font-size: 9px; padding: 1px 6px;">\${step.status}</span>
                    </div>
                  </div>
                  \${hasContent ? \`
                  <div id="wf-step-body-\${stepDomId}" style="display: none; padding: 10px 12px; background: rgba(0,0,0,0.3); border-top: 1px solid var(--border);">
                    \${step.args ? \`
                    <div style="margin-bottom: 8px;">
                      <div class="wf-detail-key" style="margin-bottom: 4px; font-size: 10px;">Arguments</div>
                      <div class="wf-code-box" style="font-size: 11px;">
                        <button class="wf-copy-btn" data-copy-target="wf-sargs-\${stepDomId}">Copy</button>
                        <code id="wf-sargs-\${stepDomId}">\${escapeHtml(typeof step.args === 'string' ? step.args : JSON.stringify(step.args, null, 2))}</code>
                      </div>
                    </div>
                    \` : ''}
                    \${step.result ? \`
                    <div>
                      <div class="wf-detail-key" style="margin-bottom: 4px; font-size: 10px;">Result / Output</div>
                      <div class="wf-code-box" style="font-size: 11px; max-height: 200px;">
                        <button class="wf-copy-btn" data-copy-target="wf-sres-\${stepDomId}">Copy</button>
                        <code id="wf-sres-\${stepDomId}">\${escapeHtml(typeof step.result === 'string' ? step.result : JSON.stringify(step.result, null, 2))}</code>
                      </div>
                    </div>
                    \` : ''}
                  </div>
                  \` : ''}
                </div>
              \`;
            });

            payloadHtml += \`
              <div style="margin-bottom: 12px;">
                <div class="wf-badge-pill tools" style="margin-bottom: 6px;">Internal Tool Execution Trace (\${span.toolSteps.length})</div>
                <div style="background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden;">
                  \${stepsRows}
                </div>
              </div>
            \`;
          } else if (span.status === 'running') {
            payloadHtml += \`
              <div style="margin-bottom: 12px; padding: 8px 12px; background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.2); border-radius: var(--radius); color: var(--cyan); font-size: 11px; display: flex; align-items: center; gap: 8px;">
                <span class="wf-live-dot active"></span>
                <span>Subagent is actively executing in the background...</span>
              </div>
            \`;
          }

          if (span.result) {
            let renderedSummary = '';
            if (typeof marked !== 'undefined' && marked.parse) {
              try {
                renderedSummary = marked.parse(span.result);
              } catch (e) {
                renderedSummary = \`<pre><code>\${escapeHtml(span.result)}</code></pre>\`;
              }
            } else {
              renderedSummary = \`<pre><code>\${escapeHtml(span.result)}</code></pre>\`;
            }

            payloadHtml += \`
              <div style="margin-bottom: 8px;">
                <div class="wf-badge-pill response" style="margin-bottom: 6px;">Final Subagent Summary & Findings</div>
                <div class="wf-response-box">
                  <button class="wf-copy-btn" data-copy-target="wf-res-\${span.id}">Copy</button>
                  <div class="wf-rendered-markdown" id="wf-res-\${span.id}" data-raw-text="\${escapeHtml(span.result)}">\${renderedSummary}</div>
                </div>
              </div>
            \`;
          }
        } else {
          if (span.args) {
            const rawArgs = typeof span.args === 'string' ? span.args : JSON.stringify(span.args, null, 2);
            payloadHtml += \`
              <div style="margin-bottom: 8px;">
                <div class="wf-detail-key" style="margin-bottom: 4px;">Arguments</div>
                <div class="wf-code-box">
                  <button class="wf-copy-btn" data-copy-target="wf-args-\${span.id}">Copy</button>
                  <code id="wf-args-\${span.id}">\${escapeHtml(rawArgs)}</code>
                </div>
              </div>
            \`;
          }
          if (span.result) {
            const rawResult = typeof span.result === 'string' ? span.result : JSON.stringify(span.result, null, 2);
            payloadHtml += \`
              <div>
                <div class="wf-detail-key" style="margin-bottom: 4px;">Result / Output</div>
                <div class="wf-code-box">
                  <button class="wf-copy-btn" data-copy-target="wf-res-\${span.id}">Copy</button>
                  <code id="wf-res-\${span.id}">\${escapeHtml(rawResult)}</code>
                </div>
              </div>
            \`;
          }
        }
        payloadEl.innerHTML = payloadHtml;
      }

      function updateTimingBars(turnId) {
        const turn = state.turns.get(turnId);
        if (!turn) return;

        const now = Date.now();
        let turnMaxElapsed = 100;

        for (const span of turn.spans) {
          const end = span.endTime || now;
          const elapsed = end - turn.startTime;
          if (elapsed > turnMaxElapsed) turnMaxElapsed = elapsed;
        }

        const durEl = document.getElementById('wf-turn-dur-' + turn.id);
        if (durEl) durEl.textContent = formatMs(turnMaxElapsed);

        const tokEl = document.getElementById('wf-turn-tok-' + turn.id);
        if (tokEl) {
          const turnTokens = turn.spans.reduce((acc, s) => acc + (s.totalTokens || 0), 0);
          tokEl.textContent = turnTokens > 0 ? (turnTokens.toLocaleString() + ' tok') : '';
        }

        const rulerMaxEl = document.getElementById('wf-ruler-max-' + turn.id);
        if (rulerMaxEl) rulerMaxEl.textContent = formatMs(turnMaxElapsed);

        for (const span of turn.spans) {
          const bar = document.getElementById('wf-bar-' + span.id);
          const label = document.getElementById('wf-label-' + span.id);
          const ttfb = document.getElementById('wf-ttfb-' + span.id);
          if (!bar) continue;

          const startOffset = Math.max(0, span.startTime - turn.startTime);
          const currentDuration = (span.endTime || now) - span.startTime;

          const leftPercent = Math.min(96, Math.max(0, (startOffset / turnMaxElapsed) * 100));
          const widthPercent = Math.min(100 - leftPercent, Math.max(2, (currentDuration / turnMaxElapsed) * 100));

          bar.style.left = leftPercent.toFixed(2) + '%';
          bar.style.width = widthPercent.toFixed(2) + '%';

          if (span.status === 'running') {
            bar.classList.add('running');
            bar.classList.remove('cancelled', 'waiting', 'error');
            if (label) {
              label.textContent = formatMs(currentDuration);
              label.classList.add('running');
            }
          } else {
            bar.classList.remove('running');
            bar.classList.toggle('error', span.status === 'error');
            bar.classList.toggle('cancelled', span.status === 'cancelled');
            bar.classList.toggle('waiting', span.status === 'waiting_approval');
            if (label) {
              label.classList.remove('running');
              label.textContent = formatMs(span.durationMs);
            }
          }

          bar.title = \`\${span.name} (\${formatMs(span.durationMs || currentDuration)}) [\${span.status}]\`;

          if (ttfb && span.ttfbMs && span.durationMs > 0) {
            const ttfbPercent = Math.min(100, Math.max(1, (span.ttfbMs / span.durationMs) * 100));
            ttfb.style.width = ttfbPercent.toFixed(1) + '%';
            ttfb.style.display = 'block';
            ttfb.title = \`TTFB: \${formatMs(span.ttfbMs)} (\${ttfbPercent.toFixed(0)}% prompt prefill delay)\`;
          }

          if (span.element && span.element.classList.contains('expanded') && span.status === 'running') {
            updateSpanDetailsContent(span);
          }
        }
      }

      function addLog(tag, msg) {
        const time = formatTime();
        state.logs.push({ time, tag, msg });

        if (els.logContainer) {
          const line = document.createElement('div');
          line.className = 'wf-log-line';
          const lower = tag.toLowerCase();
          const tagClass = lower.includes('llm') ? 'llm' : lower.includes('coord') || lower.includes('session') || lower.includes('shared') || lower.includes('handoff') ? 'coordination' : lower.includes('tool') ? 'tool' : lower.includes('sub') ? 'subagent' : 'done';
          line.innerHTML = \`
            <span class="wf-log-time">\${time}</span>
            <span class="wf-log-tag \${tagClass}">[\${tag}]</span>
            <span class="wf-log-msg">\${escapeHtml(msg)}</span>
          \`;
          els.logContainer.appendChild(line);
          scrollToBottomIfNeeded();
        }
      }

      function updateSummaryStats() {
        if (els.totalDuration) els.totalDuration.textContent = formatMs(state.totals.durationMs);
        if (els.totalLlm) els.totalLlm.textContent = formatMs(state.totals.llmMs);
        if (els.totalTools) els.totalTools.textContent = formatMs(state.totals.toolMs);
        if (els.totalTokens) els.totalTokens.textContent = state.totals.totalTokens.toLocaleString();

        if (els.liveDot) {
          if (state.isRunning) {
            els.liveDot.classList.add('active');
            els.liveText.textContent = 'LIVE';
          } else {
            els.liveDot.classList.remove('active');
            els.liveText.textContent = 'IDLE';
          }
        }

        renderStatsTab();
      }

      function renderStatsTab() {
        if (!els.statsContainer) return;

        const toolStats = new Map();
        let totalCalls = 0;
        const subagentsList = [];

        for (const span of state.spans.values()) {
          if (span.type === 'tool') {
            totalCalls++;
            const curr = toolStats.get(span.name) || { count: 0, totalMs: 0, errors: 0, fromSubagents: 0 };
            curr.count++;
            curr.totalMs += (span.durationMs || 0);
            if (span.status === 'error') curr.errors++;
            toolStats.set(span.name, curr);
          } else if (span.type === 'subagent') {
            subagentsList.push(span);
            if (span.toolSteps && span.toolSteps.length > 0) {
              for (const step of span.toolSteps) {
                totalCalls++;
                const curr = toolStats.get(step.name) || { count: 0, totalMs: 0, errors: 0, fromSubagents: 0 };
                curr.count++;
                curr.totalMs += (step.durationMs || 0);
                curr.fromSubagents++;
                if (step.status === 'error') curr.errors++;
                toolStats.set(step.name, curr);
              }
            }
          }
        }

        let tableRows = '';
        for (const [name, s] of toolStats.entries()) {
          const avg = s.count > 0 ? (s.totalMs / s.count) : 0;
          const rate = s.count > 0 ? (((s.count - s.errors) / s.count) * 100).toFixed(0) + '%' : '100%';
          const subagentBadge = s.fromSubagents > 0
            ? \`<span class="wf-span-badge subagent" style="font-size: 9px; margin-left: 6px; padding: 1px 5px;" title="\${s.fromSubagents} call(s) executed inside subagent">\${s.fromSubagents} subagent</span>\`
            : '';
          tableRows += \`
            <tr>
              <td><code>\${escapeHtml(name)}</code>\${subagentBadge}</td>
              <td>\${s.count}</td>
              <td>\${formatMs(s.totalMs)}</td>
              <td>\${formatMs(avg)}</td>
              <td style="color: \${s.errors > 0 ? 'var(--red)' : 'var(--green)'}">\${rate}</td>
            </tr>
          \`;
        }

        if (!tableRows) {
          tableRows = '<tr><td colspan="5" style="color: var(--muted); text-align: center; padding: 20px;">No tool calls recorded yet</td></tr>';
        }

        let subagentsHtml = '';
        if (subagentsList.length > 0) {
          let subRows = '';
          for (const sub of subagentsList) {
            const toolCount = sub.toolSteps ? sub.toolSteps.length : 0;
            const statusClass = sub.status === 'done' ? 'response' : sub.status === 'error' ? 'error' : 'thinking';
            subRows += \`
              <tr>
                <td><strong>\${escapeHtml(sub.name)}</strong></td>
                <td><code>\${escapeHtml(sub.model || 'default')}</code></td>
                <td>\${formatMs(sub.durationMs || 0)}</td>
                <td>\${toolCount}</td>
                <td><span class="wf-badge-pill \${statusClass}" style="font-size: 9px; padding: 1px 6px;">\${sub.status}</span></td>
              </tr>
            \`;
          }
          subagentsHtml = \`
            <div class="wf-stats-card">
              <div class="wf-stats-card-title">Subagents Execution Profile</div>
              <table class="wf-stats-table">
                <thead>
                  <tr>
                    <th>SUBAGENT</th>
                    <th>MODEL</th>
                    <th>DURATION</th>
                    <th>TOOLS RUN</th>
                    <th>STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  \${subRows}
                </tbody>
              </table>
            </div>
          \`;
        }

        els.statsContainer.innerHTML = \`
          <div class="wf-stats-card">
            <div class="wf-stats-card-title">Execution Latency Breakdown</div>
            <div style="display: flex; gap: 20px; align-items: center; margin-bottom: 8px;">
              <div>LLM Latency: <strong style="color: var(--purple);">\${formatMs(state.totals.llmMs)}</strong></div>
              <div>Tool Execution: <strong style="color: var(--blue);">\${formatMs(state.totals.toolMs)}</strong></div>
              <div>Total Tokens: <strong style="color: var(--cyan);">\${state.totals.totalTokens.toLocaleString()}</strong></div>
            </div>
          </div>
          <div class="wf-stats-card">
            <div class="wf-stats-card-title">Tool Execution Profiler</div>
            <table class="wf-stats-table">
              <thead>
                <tr>
                  <th>TOOL NAME</th>
                  <th>INVOCATIONS</th>
                  <th>TOTAL TIME</th>
                  <th>AVG DURATION</th>
                  <th>SUCCESS RATE</th>
                </tr>
              </thead>
              <tbody>
                \${tableRows}
              </tbody>
            </table>
          </div>
          \${subagentsHtml}
        \`;
      }

      function escapeHtml(str) {
        if (!str) return '';
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }

      window.toggleStepDetail = function(stepDomId) {
        const body = document.getElementById('wf-step-body-' + stepDomId);
        const arrow = document.getElementById('wf-step-arrow-' + stepDomId);
        if (!body) return;
        const isHidden = body.style.display === 'none';
        body.style.display = isHidden ? 'block' : 'none';
        if (arrow) {
          arrow.style.transform = isHidden ? 'rotate(90deg)' : 'none';
        }
      };

      document.addEventListener('click', (e) => {
        const btn = e.target.closest('.wf-copy-btn');
        if (!btn) return;
        e.stopPropagation();

        let text = '';
        const targetId = btn.dataset.copyTarget;
        if (targetId) {
          const el = document.getElementById(targetId);
          if (el) {
            text = el.dataset.rawText || el.textContent || '';
          }
        }
        if (!text) {
          const parent = btn.parentElement;
          if (parent) {
            const codeEl = parent.querySelector('code, .wf-rendered-markdown');
            if (codeEl) text = codeEl.dataset.rawText || codeEl.textContent || '';
          }
        }

        if (text) {
          vscode.postMessage({ type: 'copy_clipboard', text: text });
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text);
            }
          } catch {}

          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = orig;
            btn.classList.remove('copied');
          }, 1500);
        }
      });

      // Animation Loop for live running spans
      function animLoop() {
        if (state.isRunning) {
          for (const turn of state.turns.values()) {
            updateTimingBars(turn.id);
          }
        }
        requestAnimationFrame(animLoop);
      }
      requestAnimationFrame(animLoop);

      // Event Routing
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || !msg.type) return;

        switch (msg.type) {
          case 'agent_started': {
            state.isRunning = true;
            const query = msg.prompt || msg.user_input || '';
            const activeTurn = state.currentTurnId ? state.turns.get(state.currentTurnId) : null;
            if (!activeTurn || activeTurn.endTime) {
              const turnId = 'turn_' + (state.turns.size + 1);
              state.currentTurnId = turnId;
              ensureTurn(turnId, query || ('Turn #' + (state.turns.size + 1)));
            } else if (query && query !== 'Agent Turn') {
              activeTurn.query = query;
              const qEl = activeTurn.element ? activeTurn.element.querySelector('.wf-turn-query') : null;
              if (qEl) {
                qEl.textContent = query;
                qEl.title = query;
              }
            }
            addLog('AGENT', 'Agent turn started: ' + (state.currentTurnId || 'turn_1'));
            updateSummaryStats();
            break;
          }

          case 'waterfall_llm_start': {
            state.isRunning = true;
            const turn = ensureTurn(state.currentTurnId);
            const spanId = 'llm_' + (msg.turn_id || Date.now());
            const span = {
              id: spanId,
              turnId: turn.id,
              type: 'llm',
              name: msg.model || 'Model Inference',
              model: msg.model,
              provider: msg.provider,
              startTime: msg.ts ? msg.ts * 1000 : Date.now(),
              endTime: null,
              durationMs: 0,
              ttfbMs: 0,
              status: 'running',
              promptTokens: msg.prompt_tokens_est || 0,
              completionTokens: 0,
              totalTokens: 0,
              response: '',
              thinking: '',
              toolCalls: [],
              args: ''
            };
            state.spans.set(spanId, span);
            turn.spans.push(span);
            renderSpanRow(span);
            addLog('LLM-START', \`\${msg.provider || ''}/\${msg.model || 'model'} inference stream started\`);
            updateTimingBars(turn.id);
            updateSummaryStats();
            break;
          }

          case 'waterfall_llm_end': {
            const spanId = 'llm_' + (msg.turn_id || '');
            let span = state.spans.get(spanId);
            if (!span) {
              // Match any active running LLM span in current turn
              const turn = state.turns.get(state.currentTurnId);
              if (turn) {
                span = turn.spans.find(s => s.type === 'llm' && s.status === 'running');
              }
            }

            if (span) {
              span.status = 'done';
              span.endTime = msg.ts ? msg.ts * 1000 : Date.now();
              span.durationMs = msg.duration_ms || (span.endTime - span.startTime);
              span.ttfbMs = msg.ttfb_ms || 0;
              span.promptTokens = msg.prompt_tokens || span.promptTokens;
              span.completionTokens = msg.completion_tokens || 0;
              span.totalTokens = msg.total_tokens || (span.promptTokens + span.completionTokens);
              span.response = msg.response || span.response || '';
              span.thinking = msg.thinking || span.thinking || '';
              span.toolCalls = msg.tool_calls || [];
              span.args = '';

              state.totals.llmMs += span.durationMs;
              state.totals.durationMs += span.durationMs;
              state.totals.promptTokens += span.promptTokens;
              state.totals.completionTokens += span.completionTokens;
              state.totals.totalTokens += span.totalTokens;

              updateTimingBars(span.turnId);
              if (span.element && span.element.classList.contains('expanded')) {
                updateSpanDetailsContent(span);
              }
              addLog('LLM-END', \`Completed in \${formatMs(span.durationMs)} (TTFB \${formatMs(span.ttfbMs)}), tokens: \${span.totalTokens}\`);
              updateSummaryStats();
            }
            break;
          }

          case 'tool_start': {
            state.isRunning = true;
            const turn = ensureTurn(state.currentTurnId);
            const spanId = msg.tool_id || ('tool_' + Date.now());
            const isCoord = (msg.tool_name || '').startsWith('session_') || (msg.tool_name || '').startsWith('shared_state_');
            const span = {
              id: spanId,
              turnId: turn.id,
              type: isCoord ? 'coordination' : 'tool',
              name: msg.tool_name || 'tool_call',
              startTime: msg.ts ? msg.ts * 1000 : Date.now(),
              endTime: null,
              durationMs: 0,
              status: (msg.tool_name === 'session_ask_question') ? 'waiting' : 'running',
              args: '',
              result: ''
            };
            state.spans.set(spanId, span);
            turn.spans.push(span);
            renderSpanRow(span);
            addLog(isCoord ? 'COORD-START' : 'TOOL-START', \`Executing \${span.name} (id: \${span.id})\`);
            updateTimingBars(turn.id);
            updateSummaryStats();
            break;
          }

          case 'tool_delta': {
            const span = state.spans.get(msg.tool_id);
            if (span) {
              span.args = (span.args || '') + (msg.chunk || '');
            }
            break;
          }

          case 'tool_result': {
            const span = state.spans.get(msg.tool_id);
            if (span) {
              span.endTime = msg.ts ? msg.ts * 1000 : Date.now();
              span.durationMs = msg.duration_ms || (span.endTime - span.startTime);
              span.status = msg.success === false ? 'error' : 'done';
              span.result = msg.result || '';

              if (span.name === 'spawn_subagent' && msg.result) {
                try {
                  const parsed = typeof msg.result === 'string' ? JSON.parse(msg.result) : msg.result;
                  if (parsed && parsed.agent_id) {
                    const subSpan = state.spans.get(parsed.agent_id);
                    if (subSpan) {
                      subSpan.endTime = Date.now();
                      subSpan.durationMs = parsed.duration_ms || (subSpan.endTime - subSpan.startTime);
                      subSpan.status = (parsed.status === 'completed' || parsed.status === 'done') ? 'done' : 'error';
                      if (parsed.summary) subSpan.result = parsed.summary;
                      if (parsed.tools_called && Array.isArray(parsed.tools_called) && parsed.tools_called.length > 0) {
                        if (!subSpan.toolSteps || subSpan.toolSteps.length < parsed.tools_called.length) {
                          subSpan.toolSteps = parsed.tools_called.map((tc, idx) => ({
                            id: tc.id || ('step_' + idx),
                            name: tc.name,
                            args: tc.args,
                            detail: tc.name,
                            startTime: subSpan.startTime,
                            endTime: subSpan.startTime + (tc.duration_ms || 100),
                            durationMs: tc.duration_ms || 100,
                            status: tc.status || 'done',
                            result: tc.result || ''
                          }));
                        }
                      }
                      updateTimingBars(subSpan.turnId);
                      if (subSpan.element && subSpan.element.classList.contains('expanded')) {
                        updateSpanDetailsContent(subSpan);
                      }
                    }
                  }
                } catch (e) {}
              }

              state.totals.toolMs += span.durationMs;
              state.totals.durationMs += span.durationMs;

              updateTimingBars(span.turnId);
              if (span.element && span.element.classList.contains('expanded')) {
                updateSpanDetailsContent(span);
              }
              addLog('TOOL-END', \`\${span.name} finished in \${formatMs(span.durationMs)} (\${span.status})\`);
              updateSummaryStats();
            }
            break;
          }

          case 'subagent_spawned': {
            state.isRunning = true;
            const turn = ensureTurn(state.currentTurnId);
            const spanId = msg.agent_id || ('subagent_' + Date.now());
            const span = {
              id: spanId,
              turnId: turn.id,
              type: 'subagent',
              name: msg.role ? 'Subagent: ' + msg.role : 'Subagent',
              role: msg.role || '',
              model: msg.model,
              provider: msg.provider,
              startTime: Date.now(),
              endTime: null,
              durationMs: 0,
              status: 'running',
              args: msg.task || '',
              toolSteps: []
            };
            state.spans.set(spanId, span);
            turn.spans.push(span);
            renderSpanRow(span);
            addLog('SUBAGENT-SPAWN', \`Spawned subagent \${msg.role || ''} (\${msg.model || ''})\`);
            updateTimingBars(turn.id);
            updateSummaryStats();
            break;
          }

          case 'subagent_progress': {
            let span = state.spans.get(msg.agent_id);
            if (!span) {
              const turn = ensureTurn(state.currentTurnId);
              span = {
                id: msg.agent_id || ('subagent_' + Date.now()),
                turnId: turn.id,
                type: 'subagent',
                name: msg.role ? 'Subagent: ' + msg.role : 'Subagent',
                role: msg.role || '',
                model: msg.model,
                provider: msg.provider,
                startTime: Date.now(),
                endTime: null,
                durationMs: 0,
                status: 'running',
                args: msg.task || '',
                toolSteps: []
              };
              state.spans.set(span.id, span);
              turn.spans.push(span);
              renderSpanRow(span);
            }
            if (!span.toolSteps) span.toolSteps = [];

            if (msg.event_type === 'tool_call') {
              const existing = span.toolSteps.find(s => s.id === msg.tool_id);
              if (!existing) {
                span.toolSteps.push({
                  id: msg.tool_id || ('step_' + Date.now() + '_' + Math.random()),
                  name: msg.tool_name || 'tool_call',
                  args: msg.tool_args || '',
                  detail: msg.detail || '',
                  startTime: Date.now(),
                  endTime: null,
                  durationMs: 0,
                  status: 'running',
                  result: ''
                });
                addLog('SUBAGENT-TOOL', \`[\${span.name}] \${msg.detail || msg.tool_name || 'Tool call'}\`);
              }
            } else if (msg.event_type === 'tool_result') {
              let step = span.toolSteps.find(s => s.id === msg.tool_id);
              if (!step) {
                step = span.toolSteps.find(s => s.name === msg.tool_name && s.status === 'running');
              }
              const isError = (msg.status === 'error') || (typeof msg.tool_result === 'string' && (msg.tool_result.startsWith('Error:') || msg.tool_result.startsWith('TOOL BLOCKED') || msg.tool_result.startsWith('SECURITY BLOCKED')));
              if (!step) {
                step = {
                  id: msg.tool_id || ('step_' + Date.now() + '_' + Math.random()),
                  name: msg.tool_name || 'tool_call',
                  args: msg.tool_args || '',
                  detail: msg.detail || '',
                  startTime: Date.now() - (msg.duration_ms || 0),
                  endTime: Date.now(),
                  durationMs: msg.duration_ms || 0,
                  status: isError ? 'error' : 'done',
                  result: msg.tool_result || ''
                };
                span.toolSteps.push(step);
              } else {
                step.status = isError ? 'error' : 'done';
                step.result = msg.tool_result || '';
                step.endTime = Date.now();
                step.durationMs = msg.duration_ms || Math.max(0, step.endTime - step.startTime);
                if (msg.tool_args && !step.args) step.args = msg.tool_args;
              }
              addLog('SUBAGENT-TOOL', \`[\${span.name}] Finished \${msg.tool_name || 'tool'} (\${formatMs(step.durationMs)})\`);
            } else if (msg.event_type === 'completed' || msg.event_type === 'done') {
              if (span.status !== 'done') {
                span.endTime = Date.now();
                span.durationMs = msg.duration_ms || (span.endTime - span.startTime);
                span.status = 'done';
                if (msg.detail) span.result = msg.detail;
                updateTimingBars(span.turnId);
                addLog('SUBAGENT-DONE', \`Subagent \${span.name} completed in \${formatMs(span.durationMs)}\`);
                updateSummaryStats();
              }
            } else if (msg.event_type === 'failed' || msg.event_type === 'error' || msg.event_type === 'killed' || msg.event_type === 'timeout') {
              if (span.status !== 'error') {
                span.endTime = Date.now();
                span.durationMs = msg.duration_ms || (span.endTime - span.startTime);
                span.status = 'error';
                span.result = msg.detail || msg.error || 'Subagent execution failed';
                updateTimingBars(span.turnId);
                addLog('SUBAGENT-FAILED', \`Subagent \${span.name} failed: \${span.result}\`);
                updateSummaryStats();
              }
            }

            if (span.element && span.element.classList.contains('expanded')) {
              updateSpanDetailsContent(span);
            }
            break;
          }

          case 'subagent_done': {
            const span = state.spans.get(msg.agent_id);
            if (span && span.status !== 'done') {
              span.endTime = Date.now();
              span.durationMs = msg.duration_ms || (span.endTime - span.startTime);
              span.status = 'done';
              if (msg.result) span.result = msg.result;
              updateTimingBars(span.turnId);
              if (span.element && span.element.classList.contains('expanded')) {
                updateSpanDetailsContent(span);
              }
              addLog('SUBAGENT-DONE', \`Subagent \${span.name} completed in \${formatMs(span.durationMs)}\`);
              updateSummaryStats();
            }
            break;
          }

          case 'subagent_failed': {
            const span = state.spans.get(msg.agent_id);
            if (span && span.status !== 'error') {
              span.endTime = Date.now();
              span.durationMs = msg.duration_ms || (span.endTime - span.startTime);
              span.status = 'error';
              span.result = msg.error || msg.result || 'Subagent execution failed';
              updateTimingBars(span.turnId);
              if (span.element && span.element.classList.contains('expanded')) {
                updateSpanDetailsContent(span);
              }
              addLog('SUBAGENT-FAILED', \`Subagent \${span.name} failed: \${span.result}\`);
              updateSummaryStats();
            }
            break;
          }

          case 'session_message_received': {
            addLog('SESSION-MSG', \`✉ Message from \${msg.from_session || 'agent'}: \${(msg.content || '').slice(0, 100)}\`);
            break;
          }

          case 'session_question_received': {
            addLog('SESSION-Q', \`❓ Question from \${msg.from_session || 'agent'} (ID: \${msg.question_id || ''}): \${(msg.question || '').slice(0, 100)}\`);
            break;
          }

          case 'session_answer_received': {
            addLog('SESSION-ANS', \`✔ Answer from \${msg.from_session || 'agent'} for \${msg.question_id || ''}: \${(msg.answer || '').slice(0, 100)}\`);
            break;
          }

          case 'session_shared_state_changed': {
            addLog('SHARED-STATE', \`⚡ \${msg.author_session || 'agent'} set \${msg.key || ''} = \${JSON.stringify(msg.value || '').slice(0, 80)}\`);
            break;
          }

          case 'session_handoff_written': {
            addLog('HANDOFF', \`🤝 Handoff from \${msg.from_session || 'agent'} to \${msg.to_session || 'agent'}: \${(msg.task_summary || '').slice(0, 80)}\`);
            break;
          }

          case 'agent_done': {
            state.isRunning = false;
            const turn = state.turns.get(state.currentTurnId);
            if (turn) {
              turn.endTime = Date.now();
              turn.durationMs = turn.endTime - turn.startTime;
              updateTimingBars(turn.id);
            }
            addLog('DONE', 'Turn completed');
            updateSummaryStats();
            break;
          }

          case 'agent_cancelled': {
            state.isRunning = false;
            const now = Date.now();
            const turn = state.turns.get(state.currentTurnId);
            if (turn) {
              turn.endTime = now;
              turn.durationMs = Math.max(100, turn.endTime - turn.startTime);
              turn.status = 'cancelled';
            }

            for (const span of state.spans.values()) {
              if (span.status === 'running' || span.status === 'waiting_approval') {
                span.status = 'cancelled';
                span.endTime = now;
                span.durationMs = Math.max(0, span.endTime - span.startTime);
                if (!span.result) span.result = '[Execution cancelled by user]';

                if (span.toolSteps && span.toolSteps.length > 0) {
                  for (const step of span.toolSteps) {
                    if (step.status === 'running') {
                      step.status = 'cancelled';
                      step.endTime = now;
                      step.durationMs = Math.max(0, step.endTime - step.startTime);
                    }
                  }
                }

                if (span.element && span.element.classList.contains('expanded')) {
                  updateSpanDetailsContent(span);
                }
              }
            }

            if (turn) {
              updateTimingBars(turn.id);
            }
            addLog('CANCEL', 'Turn execution cancelled by user');
            updateSummaryStats();
            break;
          }

          case 'agent_error': {
            state.isRunning = false;
            const now = Date.now();
            const turn = state.turns.get(state.currentTurnId);
            if (turn) {
              turn.endTime = now;
              turn.durationMs = Math.max(100, turn.endTime - turn.startTime);
              turn.status = 'error';
            }

            for (const span of state.spans.values()) {
              if (span.status === 'running' || span.status === 'waiting_approval') {
                span.status = 'error';
                span.endTime = now;
                span.durationMs = Math.max(0, span.endTime - span.startTime);
                span.result = msg.error || span.result || '[Execution error]';

                if (span.toolSteps && span.toolSteps.length > 0) {
                  for (const step of span.toolSteps) {
                    if (step.status === 'running') {
                      step.status = 'error';
                      step.endTime = now;
                      step.durationMs = Math.max(0, step.endTime - step.startTime);
                    }
                  }
                }

                if (span.element && span.element.classList.contains('expanded')) {
                  updateSpanDetailsContent(span);
                }
              }
            }

            if (turn) {
              updateTimingBars(turn.id);
            }
            addLog('ERROR', \`Execution error: \${msg.error || 'Unknown error'}\`);
            updateSummaryStats();
            break;
          }

          case 'tool_approval_required': {
            const span = state.spans.get(msg.tool_id);
            if (span) {
              span.status = 'waiting_approval';
              updateTimingBars(span.turnId);
              if (span.element && span.element.classList.contains('expanded')) {
                updateSpanDetailsContent(span);
              }
            }
            addLog('APPROVAL', \`Tool \${msg.tool_name || 'action'} requires confirmation\`);
            break;
          }

          case 'agent_ask_questions': {
            addLog('QUESTION', 'Agent asked user clarifying question(s)');
            break;
          }

          case 'session_compacting': {
            addLog('COMPACT', msg.reason || 'Context window limit reached, auto-compacting');
            break;
          }

          case 'session_compacted': {
            addLog('COMPACT', 'Context compaction completed');
            break;
          }

          case 'thinking_delta': {
            for (const span of state.spans.values()) {
              if (span.type === 'llm' && span.status === 'running') {
                span.thinking = (span.thinking || '') + (msg.text || '');
                if (span.element && span.element.classList.contains('expanded')) {
                  const cotEl = document.getElementById('wf-cot-' + span.id);
                  if (cotEl) {
                    cotEl.textContent = span.thinking;
                  } else {
                    updateSpanDetailsContent(span);
                  }
                }
                break;
              }
            }
            break;
          }

          case 'text_delta': {
            for (const span of state.spans.values()) {
              if (span.type === 'llm' && span.status === 'running') {
                span.response = (span.response || '') + (msg.text || '');
                if (span.element && span.element.classList.contains('expanded')) {
                  const respEl = document.getElementById('wf-resp-' + span.id);
                  if (respEl) {
                    if (typeof marked !== 'undefined' && marked.parse) {
                      try { respEl.innerHTML = marked.parse(span.response); } catch (e) { respEl.textContent = span.response; }
                    } else {
                      respEl.textContent = span.response;
                    }
                  } else {
                    updateSpanDetailsContent(span);
                  }
                }
                break;
              }
            }
            break;
          }

          case 'session_history': {
            const sData = msg.session;
            if (!sData) break;

            if (state.turns.size === 0 && sData.messages && sData.messages.length > 0) {
              let currentTurn = null;
              let turnCounter = 0;

              for (let i = 0; i < sData.messages.length; i++) {
                const m = sData.messages[i];
                if (m.role === 'user') {
                  turnCounter++;
                  const tId = 'turn_' + turnCounter;
                  currentTurn = {
                    id: tId,
                    number: turnCounter,
                    query: m.content || ('Turn #' + turnCounter),
                    startTime: m.ts ? new Date(m.ts).getTime() : Date.now(),
                    endTime: null,
                    durationMs: 0,
                    tokens: 0,
                    spans: [],
                    isExpanded: true,
                    element: null
                  };
                  state.turns.set(tId, currentTurn);
                  state.currentTurnId = tId;
                  renderTurn(currentTurn);
                } else if (m.role === 'assistant' && currentTurn) {
                  const spanId = 'llm_' + currentTurn.id + '_' + currentTurn.spans.length;
                  const durMs = m.duration ? Math.round(m.duration * 1000) : 1000;
                  const span = {
                    id: spanId,
                    turnId: currentTurn.id,
                    type: 'llm',
                    name: sData.model || 'Model Inference',
                    model: sData.model,
                    provider: sData.provider,
                    startTime: currentTurn.startTime,
                    endTime: currentTurn.startTime + durMs,
                    durationMs: durMs,
                    ttfbMs: 250,
                    status: 'done',
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0,
                    response: m.content || '',
                    thinking: m.thinking || '',
                    toolCalls: m.tool_calls || [],
                    args: ''
                  };
                  state.spans.set(spanId, span);
                  currentTurn.spans.push(span);
                  renderSpanRow(span);

                  state.totals.llmMs += durMs;
                  state.totals.durationMs += durMs;

                  if (m.tool_calls && Array.isArray(m.tool_calls)) {
                    m.tool_calls.forEach((tc, tcIdx) => {
                      const tName = tc.function ? tc.function.name : (tc.name || 'tool');
                      const tArgs = tc.function ? tc.function.arguments : (tc.arguments || '');
                      const tSpanId = tc.id || ('tool_' + currentTurn.id + '_' + tcIdx);
                      const isSub = tName === 'spawn_subagent';
                      const tSpan = {
                        id: tSpanId,
                        turnId: currentTurn.id,
                        type: isSub ? 'subagent' : 'tool',
                        name: isSub ? 'Subagent' : tName,
                        startTime: currentTurn.startTime + durMs + (tcIdx * 400),
                        endTime: currentTurn.startTime + durMs + (tcIdx * 400) + 400,
                        durationMs: 400,
                        status: 'done',
                        args: tArgs,
                        result: '',
                        toolSteps: []
                      };
                      state.spans.set(tSpanId, tSpan);
                      currentTurn.spans.push(tSpan);
                      renderSpanRow(tSpan);
                      state.totals.toolMs += 400;
                      state.totals.durationMs += 400;
                    });
                  }
                } else if (m.role === 'tool' && currentTurn) {
                  let tSpan = m.tool_call_id ? state.spans.get(m.tool_call_id) : null;
                  if (tSpan) {
                    tSpan.result = m.content || '';
                    if (tSpan.name === 'spawn_subagent' || tSpan.type === 'subagent') {
                      try {
                        const parsed = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
                        if (parsed && parsed.duration_ms) {
                          tSpan.durationMs = Math.round(parsed.duration_ms);
                          tSpan.endTime = tSpan.startTime + tSpan.durationMs;
                        }
                        if (parsed && parsed.role) {
                          tSpan.name = 'Subagent: ' + parsed.role;
                          tSpan.role = parsed.role;
                        }
                        if (parsed && Array.isArray(parsed.tools_called) && parsed.tools_called.length > 0) {
                          tSpan.toolSteps = parsed.tools_called.map((tc, idx) => ({
                            id: tc.id || ('step_' + idx),
                            name: tc.name,
                            args: tc.args,
                            detail: tc.name,
                            startTime: tSpan.startTime,
                            endTime: tSpan.startTime + (tc.duration_ms || 100),
                            durationMs: tc.duration_ms || 100,
                            status: tc.status || 'done',
                            result: tc.result || ''
                          }));
                        }
                      } catch (e) {}
                    }
                  }
                }
              }

              for (const turn of state.turns.values()) {
                let maxEnd = turn.startTime;
                for (const s of turn.spans) {
                  if (s.endTime && s.endTime > maxEnd) maxEnd = s.endTime;
                }
                turn.endTime = maxEnd;
                turn.durationMs = Math.max(100, turn.endTime - turn.startTime);
                updateTimingBars(turn.id);
              }

              state.totals.totalTokens = sData.token_total || 0;
              state.totals.promptTokens = sData.context_tokens || 0;
              state.isRunning = sData.status === 'running';

              addLog('INIT', \`Loaded session history: \${turnCounter} turns, \${state.spans.size} spans\`);
              updateSummaryStats();
            }
            break;
          }
        }

        scrollToBottomIfNeeded();
      });

      // Filter & Search Handling
      function applyFilters() {
        const q = state.searchQuery.toLowerCase().trim();
        const type = state.filterType;

        const rows = document.querySelectorAll('.wf-span-row');
        rows.forEach(row => {
          const rowType = row.dataset.type;
          const rowName = row.dataset.name || '';
          const matchesType = (type === 'all') || (type === rowType) || (type === 'error' && row.querySelector('.wf-bar.error'));
          const matchesSearch = !q || rowName.includes(q);

          row.style.display = (matchesType && matchesSearch) ? 'block' : 'none';
        });
      }

      if (els.searchInput) {
        els.searchInput.addEventListener('input', (e) => {
          state.searchQuery = e.target.value;
          applyFilters();
        });
      }

      document.querySelectorAll('.wf-filter-pill').forEach(pill => {
        pill.addEventListener('click', () => {
          document.querySelectorAll('.wf-filter-pill').forEach(p => p.classList.remove('active'));
          pill.classList.add('active');
          state.filterType = pill.dataset.filter;
          applyFilters();
        });
      });

      // Tabs Navigation
      document.querySelectorAll('.wf-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          document.querySelectorAll('.wf-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          const target = tab.dataset.tab;
          state.activeTab = target;

          els.timelineContainer.style.display = target === 'timeline' ? 'flex' : 'none';
          els.logContainer.classList.toggle('active', target === 'log');
          els.statsContainer.classList.toggle('active', target === 'stats');

          if (target === 'stats') renderStatsTab();
          if (state.autoScroll) {
            scrollToBottomIfNeeded();
          }
        });
      });

      // Action Buttons
      if (els.btnAutoScroll) {
        els.btnAutoScroll.addEventListener('click', () => {
          state.autoScroll = !state.autoScroll;
          els.btnAutoScroll.classList.toggle('active', state.autoScroll);
          if (state.autoScroll) {
            scrollToBottomIfNeeded();
          }
        });
      }

      if (els.btnClear) {
        els.btnClear.addEventListener('click', () => {
          state.turns.clear();
          state.spans.clear();
          state.logs = [];
          state.totals = { durationMs: 0, llmMs: 0, toolMs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          els.timelineContainer.innerHTML = '';
          els.logContainer.innerHTML = '';
          if (els.emptyState) els.emptyState.style.display = 'flex';
          updateSummaryStats();
        });
      }

      if (els.btnExport) {
        els.btnExport.addEventListener('click', () => {
          const exportData = {
            sessionId: state.sessionId,
            exportedAt: new Date().toISOString(),
            totals: state.totals,
            turns: Array.from(state.turns.values()).map(t => ({
              id: t.id,
              query: t.query,
              durationMs: t.durationMs,
              spans: t.spans.map(s => ({
                id: s.id,
                type: s.type,
                name: s.name,
                durationMs: s.durationMs,
                status: s.status,
                ttfbMs: s.ttfbMs,
                tokens: s.totalTokens,
                args: s.args,
                result: s.result,
                response: s.response || '',
                thinking: s.thinking || '',
                toolCalls: s.toolCalls || []
              }))
            })),
            logs: state.logs
          };

          vscode.postMessage({
            type: 'export_waterfall',
            data: exportData
          });
        });
      }

      // Developer Guide Modal Handlers
      if (els.btnGuide && els.guideModal) {
        els.btnGuide.addEventListener('click', () => {
          els.guideModal.style.display = 'flex';
        });
      }

      if (els.guideClose && els.guideModal) {
        els.guideClose.addEventListener('click', () => {
          els.guideModal.style.display = 'none';
        });
      }

      if (els.guideModal) {
        els.guideModal.addEventListener('click', (e) => {
          if (e.target === els.guideModal) {
            els.guideModal.style.display = 'none';
          }
        });
      }

      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && els.guideModal && els.guideModal.style.display !== 'none') {
          els.guideModal.style.display = 'none';
        }
      });

      // Signal ready
      vscode.postMessage({ type: 'waterfall_ready' });
    })();
  `;
}
