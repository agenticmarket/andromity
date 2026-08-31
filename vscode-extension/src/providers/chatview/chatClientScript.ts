import { ChatViewState } from "./chatHtml.js";

export function getChatClientScript(sidebarIconUri: string, state: ChatViewState): string {
  return `
    const vscode = acquireVsCodeApi();
    const sidebarIconUri = "${sidebarIconUri}";

    window.onerror = function(msg, url, lineNo, columnNo, error) {
      console.error("[Andromity Webview Error]", msg, lineNo, columnNo, error);
      try {
        vscode.postMessage({
          type: "webview_error",
          message: String(msg),
          line: lineNo,
          col: columnNo,
          stack: error ? error.stack : ""
        });
      } catch(e) {}
    };
    window.addEventListener("unhandledrejection", function(event) {
      console.error("[Andromity Webview Unhandled Rejection]", event.reason);
      try {
        vscode.postMessage({
          type: "webview_error",
          message: "Unhandled promise rejection: " + String(event.reason),
          stack: event.reason && event.reason.stack ? event.reason.stack : ""
        });
      } catch(e) {}
    });

    const chatContainer = document.getElementById('chat-messages');
    const zeroState = document.getElementById('zero-state');
    const promptInput = document.getElementById('prompt-input');
    const sendBtn = document.getElementById('btn-send');
    const cancelBtn = document.getElementById('btn-cancel');
    const CANCEL_BTN_STOP_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>';
    const interactiveSlot = document.getElementById('interactive-slot');
    const activeModelName = document.getElementById('active-model-name');
    const activeModeLabel = document.getElementById('active-mode-label');
    const modelFlyout = document.getElementById('model-flyout');
    const flyoutSearch = document.getElementById('flyout-search');
    const flyoutList = document.getElementById('flyout-list');
    const queueContainer = document.getElementById('queue-container');
    const tokenLabel = document.getElementById('token-label');
    const costLabel = document.getElementById('cost-label');

    const sessionsFlyout = document.getElementById('sessions-flyout');
    const sessionsSearch = document.getElementById('sessions-search');
    const sessionsListEl = document.getElementById('sessions-list');
    const cronsFlyout = document.getElementById('crons-flyout');
    const cronsListEl = document.getElementById('crons-list');
    const planTrackerStrip = document.getElementById('plan-tracker-strip');
    const trackerTitle = document.getElementById('tracker-title');
    const trackerCount = document.getElementById('tracker-count');
    const trackerProgressBar = document.getElementById('tracker-progress-bar');
    const trackerStepTitle = document.getElementById('tracker-step-title');
    const zeroWorkspaceLabel = document.getElementById('zero-workspace-label');
    const recentSessionsSection = document.getElementById('recent-sessions-section');
    const recentSessionsList = document.getElementById('recent-sessions-list');
    let allSessions = [];
    let sessionDisplayLimit = 10;

    const slashPalette = document.getElementById('slash-palette');
    const slashPaletteList = document.getElementById('slash-palette-list');
    let activeSlashIdx = 0;
    let currentSlashMatches = [];

    const mentionPalette = document.getElementById('mention-palette');
    const mentionPaletteList = document.getElementById('mention-palette-list');
    let activeMentionIdx = 0;
    let currentMentionMatches = [];
    let currentMentionPrefix = '';
    let allSkills = [];

    const slashCommands = [
      { cmd: '/help', desc: 'Show all available commands & shortcuts', action: 'help' },
      { cmd: '/skills', desc: 'Browse and mention installed agent skills', action: 'skills' },
      { cmd: '/undo', desc: 'Undo last turn & rollback file modifications', action: 'undo' },
      { cmd: '/compact', desc: 'Compress conversation context to save tokens', action: 'compact' },
      { cmd: '/new', desc: 'Start a fresh conversation session', action: 'new' },
      { cmd: '/clear', desc: 'Clear current chat history view', action: 'clear' },
      { cmd: '/sessions', desc: 'Open sessions browser', action: 'sessions' },
      { cmd: '/settings', desc: 'Open Settings, Model Catalog & MCP Hub', action: 'settings' },
      { cmd: '/model', desc: 'Switch AI model', action: 'model' },
      { cmd: '/mode', desc: 'Cycle permission mode (safe / trust / full / yolo)', action: 'mode' },
      { cmd: '/plan', desc: 'Open Implementation Plan editor tab', action: 'plan' },
      { cmd: '/diff', desc: 'View git diff of current changes', action: 'diff' },
      { cmd: '/cron', desc: 'Manage scheduled background cron jobs', action: 'cron' },
    ];

    const DEVELOPER_STATEMENTS = [
      { main: "Make it work.<br>Make it right.", sub: "First functional, then optimal." },
      { main: "Think twice.<br>Code once.", sub: "Clarity precedes execution." },
      { main: "First solve the problem.<br>Then write the code.", sub: "Understand deeply before building." },
      { main: "Ship fast.<br>Break nothing.", sub: "Precision in every iteration." },
      { main: "Simplicity is prerequisite<br>for reliability.", sub: "Keep architectures clean & focused." },
      { main: "Leave the code<br>better than you found it.", sub: "Continuous craftsmanship." },
      { main: "Talk is cheap.<br>Show me the code.", sub: "Let working software speak." },
      { main: "Stay curious.<br>Build fearlessly.", sub: "What are we engineering today?" },
      { main: "Less code.<br>Fewer bugs.", sub: "Elegance through minimalism." },
      { main: "Design is how it works,<br>not just how it looks.", sub: "Form follows function." },
      { main: "Premature optimization<br>is the root of all evil.", sub: "Measure before you tune." },
      { main: "Code is read more<br>than it is written.", sub: "Optimize for readability." }
    ];

    function setRandomStatement() {
      const mainEl = document.getElementById('zero-statement-main');
      const subEl = document.getElementById('zero-statement-sub');
      if (mainEl && subEl) {
        const item = DEVELOPER_STATEMENTS[Math.floor(Math.random() * DEVELOPER_STATEMENTS.length)];
        mainEl.innerHTML = item.main;
        subEl.textContent = item.sub;
      }
    }

    function formatTokCompact(n) {
      if (!n || n <= 0) return '0';
      if (n >= 1000000) {
        var val = n / 1000000;
        return (val % 1 !== 0 && val < 10) ? val.toFixed(1) + 'M' : Math.round(val) + 'M';
      } else if (n >= 1000) {
        var val = n / 1000;
        return (val % 1 !== 0 && val < 10) ? val.toFixed(1) + 'K' : Math.round(val) + 'K';
      }
      return String(n);
    }

    function formatTokenCount(tokens) {
      return formatTokCompact(tokens) + ' tokens';
    }

    function parseContextToTokens(ctx) {
      if (!ctx) return 0;
      if (typeof ctx === 'number') return ctx;
      const s = String(ctx).trim();
      if (/^\\d+$/.test(s)) return parseInt(s, 10);
      const m = s.match(/^([\\d.]+)\\s*([KMG])?$/i);
      if (!m) return 0;
      const num = parseFloat(m[1]);
      const suf = (m[2] || '').toUpperCase();
      const mult = suf === 'K' ? 1000 : suf === 'M' ? 1000000 : suf === 'G' ? 1000000000 : 1;
      if (suf === 'K' && [4,8,16,32,64,128,200].includes(Math.round(num))) {
        const map = {4:4096,8:8192,16:16384,32:32768,64:65536,128:131072,200:200000};
        if (map[Math.round(num)] && s.toUpperCase().endsWith('K')) return map[Math.round(num)];
      }
      if (suf === 'M' && Math.round(num) === 1) return 1048576;
      return Math.round(num * mult);
    }

    function updateTokenDisplay(sessionOrUsage) {
      // TUI parity:
      // Status bar displays the latest request input size (self.session.context_tokens)
      // formatted as: "{tok_str}/{ctx_k} tok" (e.g. "7.2K/1.3M tok" or "5.3K/1.3M tok").
      // Cumulative billed usage (token_total) is displayed in the hover tooltip.
      let contextTok = 0;
      let totalTok = 0;
      let cost = 0;

      if (sessionOrUsage) {
        if (typeof sessionOrUsage.context_tokens === 'number') {
          contextTok = sessionOrUsage.context_tokens;
        } else if (sessionOrUsage.usage && typeof sessionOrUsage.usage.prompt_tokens === 'number') {
          contextTok = sessionOrUsage.usage.prompt_tokens;
        }
        if (typeof sessionOrUsage.token_total === 'number') {
          totalTok = sessionOrUsage.token_total;
        } else if (sessionOrUsage.usage && typeof sessionOrUsage.usage.total_tokens === 'number') {
          totalTok = sessionOrUsage.usage.total_tokens;
        }
        if (typeof sessionOrUsage.cost_usd === 'number') {
          cost = sessionOrUsage.cost_usd;
        }
      }

      let capacity = 0;
      // Match active model context limit
      let matched = null;
      if (currentModel) {
        const cur = String(currentModel);
        matched = allModels.find(m => m.id === cur)
          || allModels.find(m => cur.endsWith('/' + m.id) || cur.endsWith(m.id))
          || allModels.find(m => m.id && (m.id.endsWith('/' + cur.split('/').pop()) || m.id.split('/').pop() === cur.split('/').pop()));
      }
      if (matched) {
        if (matched.context_limit) {
          capacity = matched.context_limit;
        } else if (matched.context) {
          capacity = parseContextToTokens(matched.context);
        }
      }
      if (!capacity) {
        // Fallbacks by known family — keep in sync with src/andromity/core/models.py MODEL_CATALOG
        const cm = String(currentModel).toLowerCase();
        if (cm.includes('gemini') || cm.includes('claude-opus') || cm.includes('claude-sonnet') || cm.includes('gpt-4.1') || cm.includes('deepseek-v4') || cm.includes('deepseek')) {
          capacity = 1310720; // 1.3M / 1M for deepseek, gemini, claude
        } else if (cm.includes('claude-haiku') || cm.includes('o3') || cm.includes('o4')) {
          capacity = 200000;
        } else if (cm.includes('llama') || cm.includes('qwen') || cm.includes('gpt-4o') || cm.includes('gpt-5')) {
          capacity = 131072; // 128K
        } else {
          capacity = 131072;
        }
      }

      const tokStr = formatTokCompact(contextTok);
      const capStr = formatTokCompact(capacity);
      const pct = capacity > 0 ? Math.min(100, Math.max(0, (contextTok / capacity) * 100)) : 0;

      const miniBar = document.getElementById('token-mini-bar');
      if (miniBar) {
        miniBar.style.width = pct.toFixed(1) + '%';
        if (pct > 85) miniBar.style.background = '#ef4444';
        else if (pct > 65) miniBar.style.background = '#f59e0b';
        else miniBar.style.background = 'linear-gradient(90deg, #06b6d4, #10b981)';
      }

      if (tokenLabel) {
        tokenLabel.textContent = capacity > 0 ? (tokStr + '/' + capStr + ' tok') : (tokStr + ' tok');
      }
      if (costLabel) {
        costLabel.textContent = cost > 0 ? ('$' + cost.toFixed(4) + ' USD') : '$0.0000 USD';
      }

      // Update Rich Context Popover Card
      const popoverPct = document.getElementById('context-popover-pct');
      if (popoverPct) {
        popoverPct.textContent = Math.round(pct) + '%';
      }

      const ringFill = document.getElementById('context-ring-fill');
      if (ringFill) {
        const circum = 87.96;
        const offset = circum * (1 - Math.min(100, Math.max(0, pct)) / 100);
        ringFill.style.strokeDashoffset = offset.toFixed(2);
        if (pct > 85) ringFill.style.stroke = '#ef4444';
        else if (pct > 65) ringFill.style.stroke = '#f59e0b';
        else ringFill.style.stroke = '#e4e4e7';
      }

      const popoverRatio = document.getElementById('context-popover-ratio');
      if (popoverRatio) {
        popoverRatio.textContent = Number(contextTok).toLocaleString() + ' / ' + Number(capacity).toLocaleString();
      }

      const popoverUsed = document.getElementById('context-popover-used');
      if (popoverUsed) {
        popoverUsed.textContent = Number(contextTok).toLocaleString();
      }

      const popoverAvail = document.getElementById('context-popover-avail');
      if (popoverAvail) {
        popoverAvail.textContent = Number(Math.max(0, capacity - contextTok)).toLocaleString();
      }

      const widget = document.getElementById('token-capacity-widget');
      if (widget) {
        widget.removeAttribute('title');
      }
    }

    // Context Window Popover click toggle support
    const tokenWidgetEl = document.getElementById('token-capacity-widget');
    if (tokenWidgetEl) {
      tokenWidgetEl.addEventListener('click', (e) => {
        e.stopPropagation();
        tokenWidgetEl.classList.toggle('active');
      });
      document.addEventListener('click', (e) => {
        if (!tokenWidgetEl.contains(e.target)) {
          tokenWidgetEl.classList.remove('active');
        }
      });
    }

    function hideZeroState() {
      if (zeroState) zeroState.style.display = 'none';
    }
    function showZeroState() {
      if (zeroState) {
        if (!chatContainer.contains(zeroState)) {
          chatContainer.appendChild(zeroState);
        }
        zeroState.style.display = 'flex';
        setRandomStatement();
      }
    }

    let currentSessionId = ${JSON.stringify(state.currentSessionId || "")};
    let currentModel = ${JSON.stringify(state.currentModel || "anthropic/claude-3.7-sonnet")};
    let currentProvider = ${JSON.stringify(state.currentProvider || "openrouter")};
    let currentMode = ${JSON.stringify(state.currentMode || "safe")};
    let currentProfile = ${JSON.stringify(state.currentProfile || "builder")};
    let currentReasoning = ${JSON.stringify(state.currentReasoning || "medium")};
    const DEFAULT_POPULAR_MODELS = [
      { id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', provider: 'openrouter', pricing: '$3.00/M' },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'openrouter', pricing: '$3.00/M' },
      { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'openrouter', pricing: '$2.50/M' },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openrouter', pricing: '$0.15/M' },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'openrouter', pricing: '$1.25/M' },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'openrouter', pricing: '$0.10/M' },
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', provider: 'openrouter', pricing: '$0.55/M' },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3', provider: 'openrouter', pricing: '$0.14/M' },
      { id: 'qwen/qwen-2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B', provider: 'openrouter', pricing: '$0.07/M' },
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', provider: 'openrouter', pricing: '$0.12/M' }
    ];
    let allModels = [...DEFAULT_POPULAR_MODELS];
    let isRunning = false;
    const promptQueue = [];
    let currentTurnStartTime = 0;
    let thinkingStartTime = 0;

    let currentTurnAssistantDiv = null;
    let currentThinkingDiv = null;
    let currentThinkingContent = null;
    let currentAssistantContent = null;
    let accumulatedAssistantText = '';
    let currentToolSequence = null;
    let toolSeqCount = 0;
    let toolSeqStartTime = 0;
    let toolSeqTimer = null;
    let lastToolName = "";
    let lastToolRunning = false;
    let planToolCalledInTurn = false;  // set true when write_plan / update_plan_step fires in the current turn
    let userScrolledUp = false;

    function isAtBottom() {
      if (!chatContainer) return true;
      return chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 90;
    }
    function scrollToBottomIfNeeded() {
      if (!userScrolledUp && chatContainer) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }
    if (chatContainer) {
      chatContainer.addEventListener('scroll', () => {
        userScrolledUp = !isAtBottom();
      });
    }

    let toolSeqDoneTools = new Set();
    let toolSeqUserToggled = false;
    let toolSeqFinished = false;

    function ensureToolSequence() {
      if (currentToolSequence && !toolSeqFinished) return currentToolSequence;

      // Finish previous sequence if one was open
      if (currentToolSequence) {
        finishToolSequence();
      }

      currentToolSequence = document.createElement('div');
      currentToolSequence.className = 'tool-sequence';
      toolSeqCount = 0;
      toolSeqStartTime = Date.now();
      lastToolName = "";
      lastToolRunning = false;
      toolSeqDoneTools = new Set();
      toolSeqUserToggled = false;
      toolSeqFinished = false;

      currentToolSequence.innerHTML = '<div class="tool-seq-header"><svg class="tool-seq-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg><span class="tool-seq-title">0 tools · working... (0s)</span><svg class="tool-seq-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg><button class="tool-seq-copy" title="Copy tool log"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy</button></div><div class="tool-seq-body"></div>';
      
      const thisSeq = currentToolSequence;
      const hdr = thisSeq.querySelector('.tool-seq-header');
      hdr.addEventListener('click', (e) => {
        if (e.target.closest('.tool-seq-copy')) return;
        thisSeq.classList.toggle('collapsed');
        toolSeqUserToggled = true;
      });

      thisSeq.querySelector('.tool-seq-copy').addEventListener('click', () => {
        try {
          const parts = [];
          thisSeq.querySelectorAll('.tool-card').forEach((c, i) => {
            const n = c.querySelector('.tool-title-group span')?.textContent || 'tool';
            const args = c.querySelector('.tool-body')?.textContent || '';
            parts.push((i + 1) + '. ' + n + '\\n   Args: ' + args);
          });
          const txt = parts.join('\\n\\n') || thisSeq.textContent;
          copyToClipboard(txt);
        } catch {}
      });

      if (currentTurnAssistantDiv) {
        currentTurnAssistantDiv.appendChild(thisSeq);
      }

      // Reset currentAssistantContent so any subsequent text creates a new text block below this tool sequence
      currentAssistantContent = null;

      if (toolSeqTimer) clearInterval(toolSeqTimer);
      toolSeqTimer = setInterval(updateToolSeqHeader, 1000);
      return currentToolSequence;
    }

    function updateToolSeqHeader() {
      if (!currentToolSequence) return;
      const elapsed = Math.floor((Date.now() - toolSeqStartTime) / 1000);
      const el = currentToolSequence.querySelector('.tool-seq-title');
      if (!el) return;
      const label = toolSeqCount + (toolSeqCount === 1 ? ' tool' : ' tools');
      const doneCount = toolSeqDoneTools.size;

      if (toolSeqFinished) {
        el.textContent = label + ' · ' + (elapsed < 1 ? 'complete' : 'worked for ' + elapsed + 's');
      } else if (lastToolRunning && lastToolName) {
        el.textContent = label + ' · ' + lastToolName + ' working... (' + elapsed + 's)';
      } else if (doneCount > 0) {
        el.textContent = label + ' · ' + doneCount + '/' + toolSeqCount + ' done · working... (' + elapsed + 's)';
      } else {
        el.textContent = label + ' · working... (' + elapsed + 's)';
      }
    }

    function finishToolSequence() {
      if (currentToolSequence && !toolSeqFinished) {
        toolSeqFinished = true;
        if (toolSeqTimer) {
          clearInterval(toolSeqTimer);
          toolSeqTimer = null;
        }
        updateToolSeqHeader();
        const seqToCollapse = currentToolSequence;
        if (!toolSeqUserToggled) {
          seqToCollapse.classList.add('collapsed');
        }
        currentToolSequence = null;
      }
    }

    function showSlashPalette(matches) {
      if (!slashPalette || !matches || matches.length === 0) {
        hideSlashPalette();
        return;
      }
      hideMentionPalette();
      currentSlashMatches = matches;
      activeSlashIdx = 0;
      slashPalette.style.display = 'flex';
      renderSlashPalette();
    }

    function hideSlashPalette() {
      if (slashPalette) slashPalette.style.display = 'none';
      currentSlashMatches = [];
      activeSlashIdx = 0;
    }

    function renderSlashPalette() {
      if (!slashPaletteList) return;
      slashPaletteList.innerHTML = currentSlashMatches.map((c, idx) => {
        const isSel = idx === activeSlashIdx;
        return '<div class="slash-item ' + (isSel ? 'active' : '') + '" data-action="select-slash-cmd" data-cmd="' + escapeHtml(c.cmd) + '" data-idx="' + idx + '" role="option" aria-selected="' + isSel + '">' +
          '<span class="slash-cmd">' + escapeHtml(c.cmd) + '</span>' +
          '<span class="slash-desc">' + escapeHtml(c.desc) + '</span>' +
        '</div>';
      }).join('');
    }

    function navigateSlashPalette(direction) {
      if (!currentSlashMatches || currentSlashMatches.length === 0) return;
      activeSlashIdx = (activeSlashIdx + direction + currentSlashMatches.length) % currentSlashMatches.length;
      renderSlashPalette();
      const activeEl = slashPaletteList.querySelector('.slash-item.active');
      if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
    }

    function showMentionPalette(matches, prefix) {
      if (!mentionPalette || !matches || matches.length === 0) {
        hideMentionPalette();
        return;
      }
      hideSlashPalette();
      currentMentionMatches = matches;
      currentMentionPrefix = prefix || '@';
      activeMentionIdx = 0;
      mentionPalette.style.display = 'flex';
      renderMentionPalette();
    }

    function hideMentionPalette() {
      if (mentionPalette) mentionPalette.style.display = 'none';
      currentMentionMatches = [];
      activeMentionIdx = 0;
    }

    function renderMentionPalette() {
      if (!mentionPaletteList) return;
      mentionPaletteList.innerHTML = currentMentionMatches.map((s, idx) => {
        const isSel = idx === activeMentionIdx;
        const name = s.name || s.id || 'skill';
        const desc = s.description || 'Agent skill';
        return '<div class="slash-item ' + (isSel ? 'active' : '') + '" data-action="select-mention-skill" data-skill="' + escapeHtml(name) + '" data-idx="' + idx + '" role="option" aria-selected="' + isSel + '">' +
          '<span class="slash-cmd" style="color:#c084fc;">@' + escapeHtml(name) + '</span>' +
          '<span class="slash-desc">' + escapeHtml(desc) + '</span>' +
        '</div>';
      }).join('');
    }

    function navigateMentionPalette(direction) {
      if (!currentMentionMatches || currentMentionMatches.length === 0) return;
      activeMentionIdx = (activeMentionIdx + direction + currentMentionMatches.length) % currentMentionMatches.length;
      renderMentionPalette();
      const activeEl = mentionPaletteList.querySelector('.slash-item.active');
      if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
    }

    function executeMentionSkill(skillObj) {
      if (!skillObj) return;
      hideMentionPalette();
      const skillName = skillObj.name || skillObj.id || '';
      insertSkillIntoInput(skillName);
    }

    function insertSkillIntoInput(skillName) {
      const val = promptInput.value;
      const cursorPos = promptInput.selectionStart || val.length;
      const textBefore = val.slice(0, cursorPos);
      const textAfter = val.slice(cursorPos);
      
      const newBefore = textBefore.replace(/@([a-zA-Z0-9_-]*)$/, '@' + skillName + ' ');
      if (newBefore === textBefore) {
        // If not typed with @, append to beginning or cursor
        promptInput.value = val ? val + ' @' + skillName + ' ' : '@' + skillName + ' ';
      } else {
        promptInput.value = newBefore + textAfter;
      }
      promptInput.focus();
      promptInput.style.height = 'auto';
      promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + 'px';
      sendBtn.classList.add('has-text');
    }

    function executeSlashCommand(cmdObj) {
      if (!cmdObj) return;
      hideSlashPalette();
      promptInput.value = '';
      promptInput.style.height = 'auto';
      sendBtn.classList.remove('has-text');

      switch (cmdObj.action) {
        case 'help':
          appendHelpCard();
          break;
        case 'skills':
          appendSkillsCard();
          break;
        case 'undo':
          vscode.postMessage({ type: 'undo_turn' });
          break;
        case 'compact':
          vscode.postMessage({ type: 'compact_session' });
          break;
        case 'new':
          vscode.postMessage({ type: 'new_session' });
          break;
        case 'clear':
          chatContainer.innerHTML = '';
          hideZeroState();
          break;
        case 'sessions':
          toggleSessionsFlyout();
          break;
        case 'settings':
          vscode.postMessage({ type: 'open_settings' });
          break;
        case 'model':
          toggleModelFlyout();
          break;
        case 'mode':
          vscode.postMessage({ type: 'cycle_mode' });
          break;
        case 'plan':
          vscode.postMessage({ type: 'open_plan_tab' });
          break;
        case 'diff':
          vscode.postMessage({ type: 'open_diff' });
          break;
        case 'cron':
          toggleCronsFlyout();
          break;
      }
    }

    // Send on click or Enter
    if (sendBtn) {
      sendBtn.addEventListener('click', sendCurrentPrompt);
    }
    if (promptInput) {
      promptInput.addEventListener('keydown', (e) => {
        // Mentions navigation
        if (mentionPalette && mentionPalette.style.display === 'flex' && currentMentionMatches.length > 0) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            navigateMentionPalette(1);
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            navigateMentionPalette(-1);
            return;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            executeMentionSkill(currentMentionMatches[activeMentionIdx]);
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            hideMentionPalette();
            return;
          }
        }

        // Slash palette navigation
        if (slashPalette && slashPalette.style.display === 'flex' && currentSlashMatches.length > 0) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            navigateSlashPalette(1);
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            navigateSlashPalette(-1);
            return;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            executeSlashCommand(currentSlashMatches[activeSlashIdx]);
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            hideSlashPalette();
            return;
          }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendCurrentPrompt();
        }
      });

      // Auto-resize prompt input, slash command & @ mention detection
      promptInput.addEventListener('input', () => {
        promptInput.style.height = 'auto';
        promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + 'px';
        const val = promptInput.value;
        if (sendBtn) {
          if (val.trim().length > 0) {
            sendBtn.classList.add('has-text');
          } else {
            sendBtn.classList.remove('has-text');
          }
        }

        const cursorPos = promptInput.selectionStart || val.length;
        const textBefore = val.slice(0, cursorPos);

        if (val.startsWith('/')) {
          hideMentionPalette();
          const query = val.slice(1).toLowerCase().trim();
          const matches = slashCommands.filter(c => c.cmd.slice(1).toLowerCase().startsWith(query));
          showSlashPalette(matches);
        } else {
          hideSlashPalette();
          const atMatch = textBefore.match(/@([a-zA-Z0-9_-]*)$/);
          if (atMatch) {
            const query = atMatch[1].toLowerCase();
            const skillsPool = (allSkills && allSkills.length > 0) ? allSkills : [
              { name: 'browser', description: 'Browse and interact with web pages' },
              { name: 'terminal', description: 'Run shell and command-line tasks' },
              { name: 'editor', description: 'Inspect and edit codebase files' },
              { name: 'git', description: 'Version control and commit actions' },
            ];
            const matches = skillsPool.filter(s => {
              const name = (s.name || s.id || '').toLowerCase();
              return name.includes(query);
            });
            showMentionPalette(matches, atMatch[0]);
          } else {
            hideMentionPalette();
          }
        }
      });
    }

    let cancelFallbackTimer = null;
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        // Optimistic UI: immediate feedback so user knows click registered even if daemon is slow
        cancelBtn.disabled = true;
        cancelBtn.style.opacity = '0.6';
        cancelBtn.innerHTML = '<span style="font-size:10px;">Cancelling...</span>';
        appendSystemNote('Cancelling turn...');
        vscode.postMessage({ type: 'cancel_turn' });
        // Fallback: if daemon does not reply with agent_cancelled / agent_done within 4s, force-reset UI so it never stays stuck
        if (cancelFallbackTimer) clearTimeout(cancelFallbackTimer);
        cancelFallbackTimer = setTimeout(() => {
          if (isRunning) {
            console.warn('[Andromity] Cancel fallback: forcing endAssistantTurn after timeout');
            endAssistantTurn();
            interactiveSlot.innerHTML = '';
            appendSystemNote('Cancel timed out — UI force-reset. If daemon still streaming, next message will queue.');
          }
          cancelBtn.disabled = false;
          cancelBtn.style.opacity = '';
          cancelBtn.innerHTML = CANCEL_BTN_STOP_ICON;
        }, 4000);
      });
    }

    document.getElementById('btn-session-picker')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSessionsFlyout();
    });

    sessionsSearch?.addEventListener('input', (e) => {
      sessionDisplayLimit = 10;
      filterAndRenderSessions(e.target.value);
    });

    document.getElementById('btn-sessions-new')?.addEventListener('click', () => {
      sessionsFlyout.style.display = 'none';
      vscode.postMessage({ type: 'new_session' });
    });

    document.getElementById('btn-crons-close')?.addEventListener('click', () => {
      cronsFlyout.style.display = 'none';
    });

    document.getElementById('btn-slash-close')?.addEventListener('click', () => {
      hideSlashPalette();
    });

    document.getElementById('btn-mention-close')?.addEventListener('click', () => {
      hideMentionPalette();
    });

    document.getElementById('btn-tracker-open')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'open_plan_tab' });
    });

    function toggleSessionsFlyout() {
      if (!sessionsFlyout) return;
      if (sessionsFlyout.style.display === 'none' || !sessionsFlyout.style.display) {
        sessionsFlyout.style.display = 'flex';
        if (cronsFlyout) cronsFlyout.style.display = 'none';
        if (modelFlyout) modelFlyout.style.display = 'none';
        vscode.postMessage({ type: 'fetch_sessions' });
        if (sessionsSearch) {
          sessionsSearch.value = '';
          setTimeout(() => sessionsSearch.focus(), 50);
        }
      } else {
        sessionsFlyout.style.display = 'none';
      }
    }

    function toggleCronsFlyout() {
      if (!cronsFlyout) return;
      if (cronsFlyout.style.display === 'none' || !cronsFlyout.style.display) {
        cronsFlyout.style.display = 'flex';
        if (sessionsFlyout) sessionsFlyout.style.display = 'none';
        if (modelFlyout) modelFlyout.style.display = 'none';
        vscode.postMessage({ type: 'fetch_crons' });
      } else {
        cronsFlyout.style.display = 'none';
      }
    }

    function formatDateBadge(dateStr) {
      if (!dateStr) return '';
      try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return '';
        const now = new Date();
        const diffMs = now.getTime() - d.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffMins < 2) return 'Just now';
        if (diffMins < 60) return diffMins + 'm ago';
        if (diffHours < 24 && now.getDate() === d.getDate()) return formatTime(d);
        if (diffDays === 1 || (diffDays === 0 && now.getDate() !== d.getDate())) return 'Yesterday';

        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return months[d.getMonth()] + ' ' + d.getDate();
      } catch (e) {
        return '';
      }
    }

    function renderHomeRecentSessions(sessions) {
      if (!recentSessionsSection || !recentSessionsList) return;
      if (!sessions || sessions.length === 0) {
        recentSessionsSection.style.display = 'none';
        return;
      }

      // Prioritize sessions with messages, or named sessions
      const nonEmpty = sessions.filter(s => (s.message_count && s.message_count > 0) || (s.name && s.name !== 'Main Session'));
      const candidates = nonEmpty.length > 0 ? nonEmpty : sessions;
      const recent = candidates.slice(0, 3);

      if (recent.length === 0) {
        recentSessionsSection.style.display = 'none';
        return;
      }

      recentSessionsSection.style.display = 'flex';
      recentSessionsList.innerHTML = recent.map(s => {
        const name = escapeHtml(s.name || s.id || 'Untitled Session');
        const dateStr = formatDateBadge(s.updated_at || s.created_at);
        const hasCost = typeof s.cost_usd === 'number' && s.cost_usd > 0;
        const badgeText = hasCost ? ('$' + s.cost_usd.toFixed(2)) : (s.message_count ? (s.message_count + ' msgs') : '$0.00');
        const msgsText = s.message_count ? (s.message_count + ' msgs') : 'Empty';
        const modelTag = s.model ? escapeHtml(s.model.split('/').pop().replace(/-/g, ' ')) : '';

        return '<div class="recent-session-card" data-action="switch-session" data-session-id="' + s.id + '">' +
          '<div class="recent-session-main">' +
            '<div class="recent-session-title">' + name + '</div>' +
            '<div class="recent-session-sub">' +
              '<span>' + msgsText + '</span>' +
              (modelTag ? '<span>· ' + modelTag + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="recent-session-side">' +
            (dateStr ? '<span class="recent-session-date">' + dateStr + '</span>' : '') +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderSessionsList(sessions, activeId) {
      allSessions = sessions || [];
      sessionDisplayLimit = 10;
      filterAndRenderSessions(sessionsSearch ? sessionsSearch.value : '');
      renderHomeRecentSessions(allSessions);
    }

    function filterAndRenderSessions(query) {
      if (!sessionsListEl) return;
      const q = (query || '').toLowerCase().trim();
      const filtered = allSessions.filter(s => (s.name || s.id || '').toLowerCase().includes(q));

      if (filtered.length === 0) {
        sessionsListEl.innerHTML = '<div style="padding:14px; text-align:center; color:var(--muted); font-size:11px;">No matching sessions</div>';
        return;
      }

      const visible = filtered.slice(0, sessionDisplayLimit);

      let html = visible.map(s => {
        const isCur = s.id === currentSessionId;
        const name = escapeHtml(s.name || s.id || 'Session');
        const msgs = s.message_count ? (s.message_count + ' msgs') : 'Empty';
        const cost = s.cost_usd ? ('$' + s.cost_usd.toFixed(3)) : '';

        return '<div class="session-item ' + (isCur ? 'active' : '') + '">' +
          '<div class="session-item-info" data-action="switch-session" data-session-id="' + s.id + '">' +
            '<div class="session-item-title">' + (isCur ? '&#x2605; ' : '') + name + '</div>' +
            '<div class="session-item-meta">' +
              '<span>' + msgs + '</span>' +
              (cost ? '<span>· ' + cost + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="session-item-actions">' +
            '<button class="session-action-icon" data-action="rename-session" data-session-id="' + s.id + '" data-session-name="' + escapeHtml(name) + '" title="Rename">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>' +
            '</button>' +
            '<button class="session-action-icon session-action-delete" data-action="delete-session" data-session-id="' + s.id + '" title="Delete">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>' +
            '</button>' +
          '</div>' +
        '</div>';
      }).join('');

      if (filtered.length > sessionDisplayLimit) {
        const remaining = filtered.length - sessionDisplayLimit;
        html += '<div class="sessions-load-more-wrap">' +
          '<button class="btn-load-more-sessions" data-action="load-more-sessions">' +
            '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
            '<span>Load More (' + remaining + ' remaining)</span>' +
          '</button>' +
        '</div>';
      }

      sessionsListEl.innerHTML = html;
    }

    function renderCronsList(crons) {
      if (!cronsListEl) return;
      if (!crons || crons.length === 0) {
        cronsListEl.innerHTML = '<div style="padding:14px; text-align:center; color:var(--muted); font-size:11.5px;">No scheduled cron jobs found.<br/><span style="font-size:10.5px; opacity:0.8;">Crons can be scheduled through prompt instructions.</span></div>';
        return;
      }
      cronsListEl.innerHTML = crons.map(c => {
        const isEnabled = c.enabled !== false;
        return '<div class="cron-card">' +
          '<div class="cron-card-top">' +
            '<span class="cron-card-schedule">' + escapeHtml(c.schedule || 'cron') + '</span>' +
            '<span class="cron-status-pill ' + (isEnabled ? 'cron-status-active' : 'cron-status-paused') + '">' + (isEnabled ? 'Active' : 'Paused') + '</span>' +
          '</div>' +
          '<div class="cron-prompt">' + escapeHtml(c.prompt || c.name || '') + '</div>' +
        '</div>';
      }).join('');
    }

    function updatePlanTracker(plan) {
      if (!planTrackerStrip) return;
      if (!plan || !plan.title) {
        planTrackerStrip.style.display = 'none';
        return;
      }
      const steps = plan.steps || plan.todos || [];
      if (steps.length === 0) {
        planTrackerStrip.style.display = 'none';
        return;
      }
      planTrackerStrip.style.display = 'flex';
      if (trackerTitle) trackerTitle.textContent = plan.title || 'Plan Tracker';

      let completed = 0;
      let activeStep = '';
      steps.forEach((s, idx) => {
        const sStatus = (typeof s === 'string' ? 'pending' : (s.status || 'pending')).toLowerCase();
        const sText = typeof s === 'string' ? s : (s.title || s.description || ('Step ' + (idx + 1)));
        if (sStatus === 'done' || sStatus === 'completed') {
          completed++;
        } else if (!activeStep && (sStatus === 'active' || sStatus === 'in_progress' || sStatus === 'running')) {
          activeStep = sText;
        }
      });

      if (!activeStep && completed < steps.length) {
        for (let i = 0; i < steps.length; i++) {
          const st = (typeof steps[i] === 'string' ? 'pending' : (steps[i].status || 'pending')).toLowerCase();
          if (st !== 'done' && st !== 'completed') {
            activeStep = typeof steps[i] === 'string' ? steps[i] : (steps[i].title || steps[i].description || ('Step ' + (i + 1)));
            break;
          }
        }
      }

      const pct = Math.round((completed / steps.length) * 100);
      if (trackerCount) trackerCount.textContent = completed + '/' + steps.length + ' (' + pct + '%)';
      if (trackerProgressBar) trackerProgressBar.style.width = pct + '%';
      if (trackerStepTitle) trackerStepTitle.textContent = activeStep ? ('Current: ' + activeStep) : (completed === steps.length ? 'All steps completed' : '');
    }

    function renderPlanPill(plan) {
      // Only render the pill inside the current active turn's div
      if (!plan || !plan.title) return;
      const targetDiv = currentTurnAssistantDiv;
      if (!targetDiv) return;  // don't show in historical turns

      let existingPill = targetDiv.querySelector('.plan-ready-pill');
      if (!existingPill) {
        existingPill = document.createElement('div');
        existingPill.className = 'plan-ready-pill';
        // Always append after everything (including the footer) so it sits at the very bottom
        targetDiv.appendChild(existingPill);
      }
      const steps = plan.steps || plan.todos || [];
      const doneCount = steps.filter(s => (s.status || '').toLowerCase() === 'done').length;
      const progressText = steps.length > 0 ? (' (' + doneCount + '/' + steps.length + ' done)') : '';
      existingPill.innerHTML =
        '<div class="pill-icon">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>' +
        '</div>' +
        '<span class="pill-title" title="' + escapeHtml(plan.title) + '">Plan: ' + escapeHtml(plan.title) + progressText + '</span>' +
        '<button class="pill-btn" data-action="open-plan-tab">' +
          '<span>Open Plan</span>' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
        '</button>';
      scrollToBottomIfNeeded();
    }

    document.getElementById('btn-prompt-mode')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'cycle_mode' });
    });

    document.getElementById('btn-model-picker')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleModelFlyout();
    });

    document.getElementById('btn-prompt-model')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleModelFlyout();
    });

    document.getElementById('btn-flyout-open-hub')?.addEventListener('click', () => {
      modelFlyout.style.display = 'none';
      vscode.postMessage({ type: 'open_model_hub' });
    });

    if (flyoutSearch) {
      flyoutSearch.addEventListener('input', (e) => {
        renderFlyoutList(e.target.value.toLowerCase().trim());
      });
    }

    document.addEventListener('click', (e) => {
      const isPicker = e.target.closest('#btn-model-picker') || e.target.closest('#btn-prompt-model');
      if (modelFlyout && !modelFlyout.contains(e.target) && !isPicker) {
        modelFlyout.style.display = 'none';
      }
      const isSessionTrigger = e.target.closest('#btn-session-picker');
      if (sessionsFlyout && !sessionsFlyout.contains(e.target) && !isSessionTrigger) {
        sessionsFlyout.style.display = 'none';
      }
      const isCronsClose = e.target.closest('#btn-crons-close');
      if (cronsFlyout && !cronsFlyout.contains(e.target) && !isCronsClose) {
        cronsFlyout.style.display = 'none';
      }
      if (slashPalette && !slashPalette.contains(e.target) && e.target !== promptInput) {
        hideSlashPalette();
      }
      if (mentionPalette && !mentionPalette.contains(e.target) && e.target !== promptInput) {
        hideMentionPalette();
      }
    });

    // Global event delegation for headers and actions (CSP compliant)
    document.addEventListener('click', (e) => {
      // 1. Thinking card toggle (works while streaming, after turn ends, and in session history)
      const thinkingHdr = e.target.closest('.thinking-header');
      if (thinkingHdr) {
        const card = thinkingHdr.closest('.thinking-card');
        if (card) {
          card.classList.toggle('expanded');
        }
        return;
      }

      // 2. Tool card toggle (works while streaming, after turn ends, and in session history)
      const toolHdr = e.target.closest('.tool-header');
      if (toolHdr) {
        const card = toolHdr.closest('.tool-card');
        if (card) {
          card.classList.toggle('expanded');
        }
        return;
      }

      // 3. Approval parameter toggle
      const argsToggle = e.target.closest('.approval-toggle-args');
      if (argsToggle) {
        const card = argsToggle.closest('.approval-card');
        if (card) {
          card.classList.toggle('show-args');
          argsToggle.textContent = card.classList.contains('show-args') ? '&#x25BE; Hide parameters' : '&#x25B8; View parameters';
        }
        return;
      }

      // 4. Action buttons
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.getAttribute('data-action');
      switch (action) {
        case 'switch-session':
          const sId = target.getAttribute('data-session-id');
          if (sId) {
            sessionsFlyout.style.display = 'none';
            vscode.postMessage({ type: 'switch_session', sessionId: sId });
          }
          break;
        case 'view-all-sessions':
          toggleSessionsFlyout();
          break;
        case 'rename-session':
          e.stopPropagation();
          const rId = target.getAttribute('data-session-id');
          const rName = target.getAttribute('data-session-name') || '';
          vscode.postMessage({ type: 'request_rename_session', sessionId: rId, currentName: rName });
          break;
        case 'delete-session':
          e.stopPropagation();
          const delId = target.getAttribute('data-session-id');
          if (delId) {
            vscode.postMessage({ type: 'delete_session', sessionId: delId });
          }
          break;
        case 'open-plan-tab':
          vscode.postMessage({ type: 'open_plan_tab' });
          break;
        case 'new-session':
          vscode.postMessage({ type: 'new_session' });
          break;
        case 'open-diff':
          vscode.postMessage({ type: 'open_diff' });
          break;
        case 'undo-turn':
          vscode.postMessage({ type: 'undo_turn' });
          break;
        case 'compact-session':
          vscode.postMessage({ type: 'compact_session' });
          break;
        case 'load-more-sessions':
          sessionDisplayLimit += 20;
          filterAndRenderSessions(sessionsSearch ? sessionsSearch.value : '');
          break;
        case 'select-slash-cmd':
          const selCmd = target.getAttribute('data-cmd');
          const foundCmd = slashCommands.find(c => c.cmd === selCmd);
          if (foundCmd) executeSlashCommand(foundCmd);
          break;
        case 'select-mention-skill': {
          const selSkill = target.getAttribute('data-skill');
          const foundSkill = allSkills.find(s => s.name === selSkill);
          if (foundSkill) executeMentionSkill(foundSkill);
          break;
        }
        case 'insert-skill-mention': {
          const sName = target.getAttribute('data-skill');
          if (sName) insertSkillIntoInput(sName);
          break;
        }
        case 'open-skills-settings':
          vscode.postMessage({ type: 'open_skills_settings' });
          break;
        case 'close-skills-card': {
          const card = target.closest('.skills-card');
          if (card) {
            card.remove();
          }
          break;
        }
        case 'open-settings':
          vscode.postMessage({ type: 'open_settings' });
          break;
        case 'send-starter':
          promptInput.value = target.getAttribute('data-prompt') || '';
          sendCurrentPrompt();
          break;
        case 'open-model-hub':
          vscode.postMessage({ type: 'open_model_hub' });
          break;
        case 'pick-model':
          pickModel(target.getAttribute('data-model-id'), target.getAttribute('data-provider'));
          break;
        case 'remove-queued':
          removeQueued(parseInt(target.getAttribute('data-idx') || '0', 10));
          break;
        case 'copy-code':
          copyCode(target);
          break;
        case 'apply-code':
          applyCode(target);
          break;
        case 'copy-message':
          copyMessageText(target);
          break;
        case 'approve-tool':
          approveTool(target.getAttribute('data-approval-id'));
          break;
        case 'reject-tool':
          rejectTool(target.getAttribute('data-approval-id'));
          break;
        case 'approve-plan':
          approvePlan();
          break;
        case 'reject-plan':
          rejectPlan();
          break;
        case 'q-prev':
          window.navigateQuestionSlide(-1);
          break;
        case 'q-next':
          window.navigateQuestionSlide(1);
          break;
        case 'submit-questions':
          submitQuestions(target.getAttribute('data-question-id'), parseInt(target.getAttribute('data-total-q') || '0', 10));
          break;
      }
    });

    // CSP-safe Enter handling for free-text question inputs (replaces inline onkeydown)
    document.addEventListener('keydown', (e) => {
      const ta = e.target.closest('.question-textarea');
      if (!ta) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (window.currentQuestionSlide < window.totalQuestionSlides - 1) {
          window.navigateQuestionSlide(1);
        } else {
          const s = document.getElementById('btn-q-submit');
          if (s) s.click();
        }
      }
    });

    function toggleModelFlyout() {
      if (!modelFlyout) return;
      const isVisible = modelFlyout.style.display === 'flex';
      if (isVisible) {
        modelFlyout.style.display = 'none';
      } else {
        modelFlyout.style.display = 'flex';
        if (flyoutSearch) flyoutSearch.value = '';
        renderFlyoutList('');
        if (flyoutSearch) setTimeout(() => flyoutSearch.focus(), 50);
      }
    }

    function renderFlyoutList(query) {
      if (!flyoutList) return;
      const modelsPool = (allModels && allModels.length > 0) ? allModels : DEFAULT_POPULAR_MODELS;
      const filtered = modelsPool.filter(m => {
        if (!query) return true;
        const hay = ((m.name || '') + ' ' + (m.id || '') + ' ' + (m.provider || '')).toLowerCase();
        return hay.includes(query);
      }).slice(0, 50);

      if (filtered.length === 0) {
        flyoutList.innerHTML = '<div style="padding:14px; text-align:center; color:var(--muted); font-size:11.5px;">No matching models found.<br><button class="prompt-pill-btn" data-action="open-model-hub" style="margin-top:8px;">Browse Model Hub</button></div>';
        return;
      }

      flyoutList.innerHTML = filtered.map(m => {
        const isActive = m.id === currentModel;
        return '<div class="flyout-item ' + (isActive ? 'active' : '') + '" data-action="pick-model" data-model-id="' + escapeHtml(m.id) + '" data-provider="' + escapeHtml(m.provider || 'openrouter') + '">' +
          '<span>' + escapeHtml(m.name || m.id) + '</span>' +
          '<span class="flyout-item-meta">' + escapeHtml(m.provider || 'openrouter') + (m.pricing ? ' · ' + escapeHtml(m.pricing) : '') + '</span>' +
        '</div>';
      }).join('');
    }

    window.pickModel = function(modelId, provider) {
      currentModel = modelId;
      if (provider) currentProvider = provider;
      updateModelBadge();
      modelFlyout.style.display = 'none';
      vscode.postMessage({ type: 'update_config', key: 'model', value: modelId });
      if (provider) {
        vscode.postMessage({ type: 'update_config', key: 'provider', value: provider });
      }
    };

    window.openModelHub = function() {
      vscode.postMessage({ type: 'open_model_hub' });
    };

    window.sendStarter = function(promptText) {
      promptInput.value = promptText;
      sendCurrentPrompt();
    };

    function formatModelDisplayName(id) {
      if (!id || id === 'Loading model...') return 'Claude 3.7 Sonnet';
      const parts = id.split('/');
      const raw = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
      return raw
        .replace(/-/g, ' ')
        .replace(/\\b\\w/g, l => l.toUpperCase())
        .replace(/Gpt/g, 'GPT')
        .replace(/Claude/g, 'Claude')
        .replace(/Gemini/g, 'Gemini');
    }

    let availableProfiles = ['builder', 'coder', 'reviewer', 'planner'];
    let availableReasoningEfforts = ['low', 'medium', 'high', 'off'];
    let attachedImages = [];

    function updateProfileBadge() {
      const lbl = document.getElementById('prompt-profile-label');
      if (lbl) {
        lbl.textContent = (currentProfile || 'builder').toUpperCase();
        if (lbl.parentElement) {
          lbl.parentElement.title = 'Active Profile: ' + (currentProfile || 'builder').toUpperCase() + ' (Click to cycle Builder, Coder, Reviewer, Planner)';
        }
      }
    }

    function updateReasoningBadge() {
      const lbl = document.getElementById('prompt-reasoning-label');
      if (lbl) {
        const val = currentReasoning || 'medium';
        const icons = { high: 'High', medium: 'Medium', low: 'Low', off: 'Off' };
        lbl.textContent = icons[val] || val.toUpperCase();
        if (lbl.parentElement) {
          lbl.parentElement.title = 'Reasoning Effort: ' + val.toUpperCase() + ' (Click to cycle High, Medium, Low, Off)';
        }
      }
    }

    function renderImageAttachments() {
      const container = document.getElementById('image-attachments-container');
      if (!container) return;
      if (!attachedImages || attachedImages.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
      }
      container.style.display = 'flex';
      container.innerHTML = attachedImages.map((imgUri, idx) => {
        const title = 'Attachment ' + (idx + 1) + (attachedImages.length > 1 ? (' of ' + attachedImages.length) : '');
        return '<div class="image-attachment-chip" data-action="preview-image" data-src="' + escapeHtml(imgUri) + '" data-title="' + escapeHtml(title) + '" title="Click to preview image">' +
          '<img class="image-attachment-thumb" src="' + imgUri + '" alt="Attachment ' + (idx + 1) + '" />' +
          '<button class="image-attachment-remove" data-action="remove-image-attachment" data-idx="' + idx + '" title="Remove image">&#x2715;</button>' +
        '</div>';
      }).join('');
    }

    function addImageAttachment(dataUri) {
      if (!dataUri) return;
      if (attachedImages.length >= 5) {
        appendSystemNote('Maximum 5 images can be attached per message.');
        return;
      }
      attachedImages.push(dataUri);
      renderImageAttachments();
    }

    function removeImageAttachment(idx) {
      if (idx >= 0 && idx < attachedImages.length) {
        attachedImages.splice(idx, 1);
        renderImageAttachments();
      }
    }

    function handlePasteImage(e) {
      const clipboardData = e.clipboardData || window.clipboardData;
      if (!clipboardData || !clipboardData.items) return;
      const items = clipboardData.items;
      let handled = false;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          if (file) {
            const reader = new FileReader();
            reader.onload = function(event) {
              if (event.target && event.target.result) {
                addImageAttachment(event.target.result);
              }
            };
            reader.readAsDataURL(file);
            handled = true;
          }
        }
      }
      if (handled) {
        e.preventDefault();
      }
    }

    promptInput.addEventListener('paste', handlePasteImage);
    window.addEventListener('paste', (e) => {
      if (e.target !== promptInput && !e.target.closest('input, textarea')) {
        handlePasteImage(e);
      }
    });

    const promptBoxEl = document.querySelector('.prompt-box');
    if (promptBoxEl) {
      promptBoxEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        promptBoxEl.style.borderColor = 'var(--accent)';
      });
      promptBoxEl.addEventListener('dragleave', () => {
        promptBoxEl.style.borderColor = '';
      });
      promptBoxEl.addEventListener('drop', (e) => {
        e.preventDefault();
        promptBoxEl.style.borderColor = '';
        if (e.dataTransfer && e.dataTransfer.files) {
          for (let i = 0; i < e.dataTransfer.files.length; i++) {
            const file = e.dataTransfer.files[i];
            if (file.type && file.type.indexOf('image') !== -1) {
              const reader = new FileReader();
              reader.onload = function(evt) {
                if (evt.target && evt.target.result) {
                  addImageAttachment(evt.target.result);
                }
              };
              reader.readAsDataURL(file);
            }
          }
        }
      });
    }

    const btnProfileEl = document.getElementById('btn-prompt-profile');
    if (btnProfileEl) {
      btnProfileEl.addEventListener('click', () => {
        const nextIdx = (availableProfiles.indexOf(currentProfile.toLowerCase()) + 1) % availableProfiles.length;
        currentProfile = availableProfiles[nextIdx];
        updateProfileBadge();
        vscode.postMessage({ type: 'update_config', key: 'profile', value: currentProfile });
      });
    }

    const btnReasoningEl = document.getElementById('btn-prompt-reasoning');
    if (btnReasoningEl) {
      btnReasoningEl.addEventListener('click', () => {
        const val = (currentReasoning || 'medium').toLowerCase();
        const nextIdx = (availableReasoningEfforts.indexOf(val) + 1) % availableReasoningEfforts.length;
        currentReasoning = availableReasoningEfforts[nextIdx];
        updateReasoningBadge();
        vscode.postMessage({ type: 'update_config', key: 'reasoningEffort', value: currentReasoning });
      });
    }

    function appendHelpCard() {
      const card = document.createElement('div');
      card.className = 'help-card';
      card.style.cssText = 'background:var(--card-bg); border:1px solid var(--border); border-radius:8px; padding:12px; margin:8px 0; font-size:12px; box-shadow: 0 4px 14px rgba(0,0,0,0.3);';

      const commandsHtml = slashCommands.map(function(c) {
        return '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 8px; border-radius:4px; transition:background 0.12s; cursor:pointer;" data-action="select-slash-cmd" data-cmd="' + escapeHtml(c.cmd) + '">' +
          '<div style="display:flex; align-items:center; gap:8px; min-width:0;">' +
            '<code style="background:rgba(6,182,212,0.15); color:var(--accent); padding:2px 6px; border-radius:4px; font-weight:600; font-family:var(--vscode-editor-font-family, monospace); font-size:11.5px;">' + escapeHtml(c.cmd) + '</code>' +
            '<span style="color:var(--fg); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(c.desc) + '</span>' +
          '</div>' +
          '<button class="prompt-pill-btn" style="padding:2px 8px; font-size:10.5px; flex-shrink:0;">Run</button>' +
        '</div>';
      }).join('');

      card.innerHTML = 
        '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid var(--border);">' +
          '<div style="display:flex; align-items:center; gap:6px; font-weight:600; color:var(--fg); font-size:12.5px;">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>' +
            '<span>Available Commands & Shortcuts</span>' +
          '</div>' +
          '<span style="font-size:10.5px; color:var(--muted);">Click command to run</span>' +
        '</div>' +
        '<div style="display:flex; flex-direction:column; gap:2px;">' +
          commandsHtml +
        '</div>' +
        '<div style="margin-top:8px; padding-top:6px; border-top:1px solid var(--border); font-size:11px; color:var(--muted); display:flex; justify-content:space-between;">' +
          '<span>Tip: Type <code>/</code> for commands, <code>@</code> for skills</span>' +
          '<span>Paste images with <code>Ctrl+V</code></span>' +
        '</div>';
      chatContainer.appendChild(card);
      scrollToBottomIfNeeded();
    }

    function appendSkillsCard() {
      const card = document.createElement('div');
      card.className = 'skills-card';
      card.style.cssText = 'background:var(--card-bg); border:1px solid var(--border); border-radius:8px; padding:12px; margin:8px 0; font-size:12px; box-shadow: 0 4px 14px rgba(0,0,0,0.3);';

      const skillsListHtml = allSkills && allSkills.length > 0
        ? allSkills.map(function(s) {
          const name = s.name || s.id || 'skill';
          const desc = s.description || 'Specialized agent skill';
          return '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 8px; border-radius:4px; transition:background 0.12s; cursor:pointer;" data-action="insert-skill-mention" data-skill="' + escapeHtml(name) + '">' +
            '<div style="display:flex; align-items:center; gap:8px; min-width:0;">' +
              '<span style="background:rgba(168,85,247,0.18); color:#c084fc; padding:2px 6px; border-radius:4px; font-weight:600; font-family:var(--vscode-editor-font-family, monospace); font-size:11.5px;">@' + escapeHtml(name) + '</span>' +
              '<span style="color:var(--fg); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(desc) + '</span>' +
            '</div>' +
            '<button class="prompt-pill-btn" style="padding:2px 8px; font-size:10.5px; flex-shrink:0;">Use</button>' +
          '</div>';
        }).join('')
        : '<div style="color:var(--muted); padding:8px 0; text-align:center;">No custom skills found. Open Settings > Skills to manage skills.</div>';

      card.innerHTML = 
        '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid var(--border);">' +
          '<div style="display:flex; align-items:center; gap:6px; font-weight:600; color:var(--fg); font-size:12.5px;">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#c084fc" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>' +
            '<span>Agent Skills (' + allSkills.length + ' active)</span>' +
          '</div>' +
          '<div style="display:flex; align-items:center; gap:6px;">' +
            '<button class="prompt-pill-btn" data-action="open-skills-settings" style="font-size:10.5px;">Browse Hub</button>' +
            '<button class="skills-card-close-btn" data-action="close-skills-card" title="Close skills panel">&times;</button>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex; flex-direction:column; gap:2px; max-height:220px; overflow-y:auto;">' +
          skillsListHtml +
        '</div>' +
        '<div style="margin-top:8px; padding-top:6px; border-top:1px solid var(--border); font-size:11px; color:var(--muted); display:flex; justify-content:space-between;">' +
          '<span>Tip: Type <code>@</code> in chat to mention any skill</span>' +
          '<span>Or click any skill to insert</span>' +
        '</div>';
      chatContainer.appendChild(card);
      scrollToBottomIfNeeded();
    }

    function updateModelBadge() {
      const found = allModels.find(m => m.id === currentModel);
      let name = found ? (found.name || found.id) : formatModelDisplayName(currentModel);
      if (!name || name === "Loading model...") {
        name = "Claude 3.7 Sonnet";
      }
      if (activeModelName) {
        activeModelName.textContent = name;
        activeModelName.title = "Model: " + currentModel + " (" + currentProvider + ")";
      }
      const promptModelLabel = document.getElementById('prompt-model-label');
      if (promptModelLabel) {
        promptModelLabel.textContent = name;
        if (promptModelLabel.parentElement) {
          promptModelLabel.parentElement.title = "Active Model: " + currentModel + " (" + currentProvider + ") - Click to switch";
        }
      }
      updateProfileBadge();
      updateReasoningBadge();
    }
    updateModelBadge();

    function sendCurrentPrompt() {
      const text = promptInput.value.trim();
      const imagesToSend = [...attachedImages];
      if (!text && imagesToSend.length === 0) return;
      promptInput.value = '';
      promptInput.style.height = 'auto';
      sendBtn.classList.remove('has-text');
      attachedImages = [];
      renderImageAttachments();

      if (isRunning) {
        promptQueue.push({ text: text || 'Please inspect attached image', images: imagesToSend });
        renderQueue();
        return;
      }
      dispatchPrompt(text || 'Please inspect attached image', true, imagesToSend);
    }

    function dispatchPrompt(text, attachContext, images) {
      try {
        console.log('[Andromity webview] dispatchPrompt sending:', text.slice(0,120));
        hideZeroState();

        // Immediate session title derivation from first user prompt (TUI parity)
        const activeSessName = document.getElementById('active-session-name');
        if (activeSessName && (activeSessName.textContent === 'Main Session' || activeSessName.textContent === 'new-session' || activeSessName.textContent.startsWith('Session '))) {
          const firstLine = text.trim().split(String.fromCharCode(10))[0].trim();
          if (firstLine) {
            let shortTitle = firstLine.slice(0, 32);
            if (firstLine.length > 32) shortTitle += '...';
            activeSessName.textContent = shortTitle;
          }
        }

        appendUserMessage(text, images);
        startAssistantTurn();
        vscode.postMessage({
          type: 'send_prompt',
          prompt: text,
          sessionId: currentSessionId,
          profile: currentProfile,
          mode: currentMode,
          model: currentModel,
          provider: currentProvider,
          reasoningEffort: currentReasoning,
          attachContext: attachContext,
          images: images || [],
        });
      } catch (e) {
        console.error('[Andromity webview] dispatchPrompt failed', e);
        appendSystemNote('Webview error: ' + (e.message||String(e)));
      }
    }

    function hideZeroState() {
      if (zeroState) zeroState.style.display = 'none';
    }

    function flushQueue() {
      if (promptQueue.length === 0) return;
      const next = promptQueue.shift();
      renderQueue();
      if (typeof next === 'object' && next !== null) {
        dispatchPrompt(next.text || '', true, next.images || []);
      } else {
        dispatchPrompt(next, true, []);
      }
    }

    function renderQueue() {
      if (promptQueue.length === 0) {
        queueContainer.style.display = 'none';
        queueContainer.innerHTML = '';
        return;
      }
      queueContainer.style.display = 'flex';
      queueContainer.innerHTML = promptQueue.map((q, i) => {
        const text = typeof q === 'object' ? (q.text || 'Image prompt') : q;
        return '<div class="queue-chip">' +
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' +
          '<span class="queue-text">' + escapeHtml(text) + '</span>' +
          '<button class="queue-remove" data-action="remove-queued" data-idx="' + i + '">&#x2715;</button>' +
        '</div>';
      }).join('');
    }

    window.removeQueued = function(idx) {
      promptQueue.splice(idx, 1);
      renderQueue();
    };

    try {
      if (typeof marked !== 'undefined') {
        const markedRenderer = {
          code(token) {
            const text = token && typeof token === 'object' ? (token.text || '') : String(token || '');
            const lang = token && typeof token === 'object' ? (token.lang || 'code') : 'code';
            const language = (lang || 'code').trim();
            const enc = encodeURIComponent(text);
            return '<div class="code-block-container">' +
              '<div class="code-block-header">' +
                '<span class="code-lang-tag">' + escapeHtml(language.toUpperCase()) + '</span>' +
                '<div class="code-block-actions">' +
                  '<button class="code-btn" data-code="' + enc + '" data-action="copy-code"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy</button>' +
                  '<button class="code-btn" data-code="' + enc + '" data-action="apply-code"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg> Insert</button>' +
                '</div>' +
              '</div>' +
              '<pre class="code-block-pre"><code>' + escapeHtml(text) + '</code></pre>' +
            '</div>';
          },
          table(token) {
            let headerHtml = '';
            let bodyHtml = '';
            const self = this;
            if (token && token.header) {
              headerHtml = '<thead><tr>' + token.header.map(cell => {
                const align = cell.align ? ' style="text-align:' + cell.align + ';"' : '';
                const content = cell.tokens && self.parser ? self.parser.parseInline(cell.tokens) : (cell.text || '');
                return '<th' + align + '>' + content + '</th>';
              }).join('') + '</tr></thead>';
            }
            if (token && token.rows) {
              bodyHtml = '<tbody>' + token.rows.map(row => {
                return '<tr>' + row.map(cell => {
                  const align = cell.align ? ' style="text-align:' + cell.align + ';"' : '';
                  const content = cell.tokens && self.parser ? self.parser.parseInline(cell.tokens) : (cell.text || '');
                  return '<td' + align + '>' + content + '</td>';
                }).join('') + '</tr>';
              }).join('') + '</tbody>';
            }
            return '<div class="table-scroll-wrapper"><table class="md-table">' + headerHtml + bodyHtml + '</table></div>';
          },
          link(token) {
            const href = token && typeof token === 'object' ? (token.href || '#') : String(token || '#');
            const title = token && typeof token === 'object' ? token.title : '';
            const text = token && typeof token === 'object' ? (token.text || href) : href;
            return '<a href="' + escapeHtml(href) + '" target="_blank" style="color:var(--accent); text-decoration:underline;"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + text + '</a>';
          },
          image(token) {
            const href = token && typeof token === 'object' ? (token.href || '') : String(token || '');
            const title = token && typeof token === 'object' ? token.title : '';
            const text = token && typeof token === 'object' ? token.text : '';
            return '<img class="md-image" src="' + escapeHtml(href) + '" alt="' + escapeHtml(text || '') + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + ' loading="lazy" />';
          }
        };
        marked.use({ renderer: markedRenderer, gfm: true, breaks: true });
      }
    } catch (e) {
      console.warn('[Andromity] marked configuration note:', e);
    }

    function renderInline(str) {
      if (!str) return '';
      var codeSpans = [];
      // 1. Protect inline code spans with tokens so code inside backticks does not break bold/italic
      var t = str.replace(/\`([^\`]+)\`/g, function(_, code) {
        codeSpans.push(code);
        return String.fromCharCode(1) + 'CODE_' + (codeSpans.length - 1) + String.fromCharCode(1);
      });
      t = escapeHtml(t);

      // 2. Images & links
      t = t.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '<img class="md-image" src="$2" alt="$1" title="$1" loading="lazy" />');
      t = t.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" style="color:var(--accent); text-decoration:underline;">$1</a>');

      // 3. Strikethrough
      t = t.replace(/~~(.*?)~~/g, '<del>$1</del>');

      // 4. Bold + Italic
      t = t.replace(/\\*\\*\\*(.*?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
      t = t.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');

      // 5. Bold
      t = t.replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>');
      t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');

      // 6. Italic
      t = t.replace(/\\*([^\\*\\n]+)\\*/g, '<em>$1</em>');
      t = t.replace(/(?:^|(?<=[\\s(\\[{\\'"]))_([^_]+)_(?=[\\s.,;:!?)}\\"\\']|$)/g, '<em>$1</em>');

      // 7. Restore inline code
      for (var i = 0; i < codeSpans.length; i++) {
        var token = String.fromCharCode(1) + 'CODE_' + i + String.fromCharCode(1);
        t = t.split(token).join('<code>' + escapeHtml(codeSpans[i]) + '</code>');
      }
      return t;
    }

    function renderMarkdown(md) {
      if (!md) return '';
      if (typeof marked !== 'undefined' && marked.parse) {
        try {
          return marked.parse(md);
        } catch (e) {
          console.warn('[Andromity] marked.parse failed, falling back:', e);
        }
      }
      var codeParts = md.split(String.fromCharCode(96, 96, 96));
      var html = '';

      for (var i = 0; i < codeParts.length; i++) {
        if (i % 2 === 1) {
          var lines = codeParts[i].split('\\n');
          var lang = lines[0].trim() || 'code';
          var code = lines.slice(1).join('\\n');
          var enc = encodeURIComponent(code);
          html += '<div class="code-block-container">' +
            '<div class="code-block-header">' +
              '<span class="code-lang-tag">' + escapeHtml(lang.toUpperCase()) + '</span>' +
              '<div class="code-block-actions">' +
                '<button class="code-btn" data-code="' + enc + '" data-action="copy-code"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy</button>' +
                '<button class="code-btn" data-code="' + enc + '" data-action="apply-code"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg> Insert</button>' +
              '</div>' +
            '</div>' +
            '<pre class="code-block-pre"><code>' + escapeHtml(code.trim()) + '</code></pre>' +
          '</div>';
        } else {
          var rawLines = codeParts[i].split('\\n');
          for (var l = 0; l < rawLines.length; l++) {
            var line = rawLines[l];
            var trimmed = line.trim();

            if (!trimmed) {
              html += '<div class="md-spacer"></div>';
              continue;
            }

            // HTML details and summary
            if (trimmed.startsWith('<details') || trimmed.startsWith('</details') || trimmed.startsWith('<summary') || trimmed.startsWith('</summary')) {
              html += trimmed;
              continue;
            }

            // Horizontal Rule: --- or *** or ___
            if (/^(?:---|\\*\\*\\*|___)\\s*$/.test(trimmed)) {
              html += '<hr class="md-hr">';
              continue;
            }

            // GFM Table parsing (with or without boundary pipes)
            var isTableSep = function(str) { return /^\\s*\\|?(?:\\s*:?-+:?\\s*\\|?)+\\s*$/.test(str) && str.indexOf('-') !== -1; };
            if (trimmed.indexOf('|') !== -1 && l + 1 < rawLines.length && isTableSep(rawLines[l+1].trim())) {
              var tableLines = [trimmed];
              var sepLine = rawLines[l+1].trim();
              l++;
              while (l + 1 < rawLines.length && rawLines[l+1].trim().indexOf('|') !== -1 && !rawLines[l+1].trim().startsWith(String.fromCharCode(96, 96, 96))) {
                l++;
                tableLines.push(rawLines[l].trim());
              }
              var rawAligns = sepLine.replace(/^\|/, '').replace(/\|$/, '').split('|');
              var aligns = [];
              for (var a = 0; a < rawAligns.length; a++) {
                var s = rawAligns[a].trim();
                if (s.startsWith(':') && s.endsWith(':')) aligns.push('center');
                else if (s.endsWith(':')) aligns.push('right');
                else aligns.push('left');
              }
              var rawHeaders = tableLines[0].replace(/^\|/, '').replace(/\|$/, '').split('|');
              var tableHtml = '<div class="table-scroll-wrapper"><table class="md-table"><thead><tr>';
              for (var h = 0; h < rawHeaders.length; h++) {
                var al = aligns[h] || 'left';
                tableHtml += '<th style="text-align:' + al + ';">' + renderInline(rawHeaders[h].trim()) + '</th>';
              }
              tableHtml += '</tr></thead><tbody>';
              for (var r = 1; r < tableLines.length; r++) {
                var cells = tableLines[r].replace(/^\|/, '').replace(/\|$/, '').split('|');
                tableHtml += '<tr>';
                for (var c = 0; c < rawHeaders.length; c++) {
                  var cellText = (cells[c] || '').trim();
                  var cal = aligns[c] || 'left';
                  tableHtml += '<td style="text-align:' + cal + ';">' + renderInline(cellText) + '</td>';
                }
                tableHtml += '</tr>';
              }
              tableHtml += '</tbody></table></div>';
              html += tableHtml;
              continue;
            }

            // Task list items: - [x] or - [ ] or * [x]
            var taskMatch = trimmed.match(/^[-*\\u2022]\\s+\\[([ xX])\\]\\s*(.*)$/);
            if (taskMatch) {
              var isChecked = taskMatch[1].toLowerCase() === 'x';
              html += '<div class="md-task-item"><input type="checkbox" class="md-checkbox" ' + (isChecked ? 'checked' : '') + ' disabled><span class="md-task-text ' + (isChecked ? 'completed' : '') + '">' + renderInline(taskMatch[2]) + '</span></div>';
              continue;
            }

            if (/^###\\s+/.test(trimmed)) {
              html += '<h5>' + renderInline(trimmed.replace(/^###\\s+/, '')) + '</h5>';
            } else if (/^##\\s+/.test(trimmed)) {
              html += '<h4>' + renderInline(trimmed.replace(/^##\\s+/, '')) + '</h4>';
            } else if (/^#\\s+/.test(trimmed)) {
              html += '<h3>' + renderInline(trimmed.replace(/^#\\s+/, '')) + '</h3>';
            } else if (/^[-*+•]\\s+/.test(trimmed)) {
              var itemText = trimmed.replace(/^[-*+•]\\s+/, '');
              html += '<div class="md-bullet"><span class="md-dot">•</span><span class="md-text">' + renderInline(itemText) + '</span></div>';
            } else if (/^\\d+\\.\\s+/.test(trimmed)) {
              var numMatch = trimmed.match(/^(\\d+)\\.\\s+(.*)$/);
              var num = numMatch ? numMatch[1] : '1';
              var itemText = numMatch ? numMatch[2] : trimmed;
              html += '<div class="md-bullet"><span class="md-num">' + num + '.</span><span class="md-text">' + renderInline(itemText) + '</span></div>';
            } else if (/^>\\s+/.test(trimmed)) {
              var quoteText = trimmed.replace(/^>\\s+/, '');
              html += '<div class="md-quote">' + renderInline(quoteText) + '</div>';
            } else {
              html += '<div class="md-line">' + renderInline(line) + '</div>';
            }
          }
        }
      }
      return html;
    }

    function copyToClipboard(text) {
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {
          fallbackCopyText(text);
        });
      } else {
        fallbackCopyText(text);
      }
      vscode.postMessage({ type: 'copy_clipboard', text: text });
    }

    function fallbackCopyText(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { document.execCommand('copy'); } catch(e) {}
      document.body.removeChild(ta);
    }

    window.copyCode = function(btn) {
      var enc = btn.getAttribute('data-code') || '';
      var code = decodeURIComponent(enc);
      copyToClipboard(code);
      var orig = btn.innerHTML;
      btn.innerHTML = '<span style="color:var(--green)">Copied!</span>';
      setTimeout(function() { btn.innerHTML = orig; }, 1500);
    };

    window.applyCode = function(btn) {
      var enc = btn.getAttribute('data-code') || '';
      var code = decodeURIComponent(enc);
      vscode.postMessage({ type: 'apply_code', code: code });
    };

    function formatTime(date) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function appendUserMessage(text, images) {
      const wrap = document.createElement('div');
      wrap.className = 'message-wrap user';

      const msgDiv = document.createElement('div');
      msgDiv.className = 'message user';

      if (images && Array.isArray(images) && images.length > 0) {
        const imgWrap = document.createElement('div');
        imgWrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px;';
        images.forEach(uri => {
          const imgEl = document.createElement('img');
          imgEl.src = uri;
          imgEl.style.cssText = 'max-width:220px; max-height:140px; border-radius:6px; object-fit:cover; border:1px solid rgba(255,255,255,0.2); cursor:pointer; transition:transform 0.15s, border-color 0.15s;';
          imgEl.title = 'Click to preview full size';
          imgEl.addEventListener('mouseenter', () => { imgEl.style.transform = 'scale(1.02)'; imgEl.style.borderColor = 'var(--vscode-focusBorder, #007fd4)'; });
          imgEl.addEventListener('mouseleave', () => { imgEl.style.transform = 'scale(1)'; imgEl.style.borderColor = 'rgba(255,255,255,0.2)'; });
          imgEl.addEventListener('click', () => {
            openImageLightbox(uri);
          });
          imgWrap.appendChild(imgEl);
        });
        msgDiv.appendChild(imgWrap);
      }

      if (text) {
        const textSpan = document.createElement('div');
        textSpan.textContent = text;
        msgDiv.appendChild(textSpan);
      }

      wrap.appendChild(msgDiv);

      const footer = document.createElement('div');
      footer.className = 'message-footer';
      footer.innerHTML = '<span>' + formatTime(new Date()) + '</span>';
      wrap.appendChild(footer);

      chatContainer.appendChild(wrap);
      scrollToBottomIfNeeded();
    }

    window.copyMessageText = function(btn) {
      const wrap = btn.closest('.message-wrap');
      if (!wrap) return;
      let text = '';
      const userMsg = wrap.querySelector('.message.user');
      const asstMsg = wrap.querySelector('.assistant-text');
      if (userMsg) text = userMsg.textContent || '';
      else if (asstMsg) text = asstMsg.innerText || asstMsg.textContent || '';
      if (text) {
        copyToClipboard(text);
        const orig = btn.innerHTML;
        btn.innerHTML = '<span style="color:var(--green)">Copied!</span>';
        setTimeout(function() { btn.innerHTML = orig; }, 1500);
      }
    };

    function playTone(kind) {
      try {
        const audio = document.getElementById('audio-done');
        if (audio) {
          audio.currentTime = 0;
          audio.play().catch(function() {});
          return;
        }
      } catch (e) {
        console.warn('Audio play failed:', e);
      }
    }

    function updateModeBadge(mode) {
      if (!mode) return;
      currentMode = mode.toLowerCase();
      if (activeModeLabel) activeModeLabel.textContent = currentMode.toUpperCase();
      const modeBtn = document.getElementById('btn-mode-cycle');
      if (modeBtn) modeBtn.className = 'mode-badge-btn mode-' + currentMode;
      const promptModeLabel = document.getElementById('prompt-mode-label');
      if (promptModeLabel) {
        promptModeLabel.textContent = currentMode.toUpperCase();
      }
      const titles = {
        safe: 'SAFE Mode: Confirms before every file edit and shell command (Click to cycle)',
        trust: 'TRUST Mode: Auto-approves file writes in workspace; prompts for commands (Click to cycle)',
        full: 'FULL Mode: Auto-approves all tool actions and logs to stream (Click to cycle)',
        yolo: 'YOLO Mode: Autonomous silent execution (Click to cycle)'
      };
      if (modeBtn) modeBtn.title = titles[currentMode] || 'Permission Governance Mode (Click to cycle)';
    }

    function removeTurnLoader() {
      const el = document.getElementById('turn-loading-indicator');
      if (el) el.remove();
    }

    function finishCurrentThinking() {
      if (currentThinkingDiv) {
        const elapsedSec = thinkingStartTime ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1) : '0.0';
        const hdr = currentThinkingDiv.querySelector('.thinking-header span');
        if (hdr) hdr.textContent = 'thought (' + elapsedSec + 's)';
        const pulse = currentThinkingDiv.querySelector('.thinking-pulse');
        if (pulse) {
          pulse.style.opacity = '0.4';
          pulse.style.animation = 'none';
          pulse.style.boxShadow = 'none';
        }
        // Auto-collapse when done (TUI parity)
        currentThinkingDiv.classList.remove('expanded');
        currentThinkingDiv = null;
        currentThinkingContent = null;
      }
    }

    function startAssistantTurn() {
      isRunning = true;
      userScrolledUp = false; // new turn always shows latest
      cancelBtn.innerHTML = CANCEL_BTN_STOP_ICON;
      cancelBtn.disabled = false;
      cancelBtn.style.opacity = '';
      cancelBtn.style.display = 'flex';
      sendBtn.style.display = 'none';
      accumulatedAssistantText = '';
      currentTurnStartTime = Date.now();
      currentToolSequence = null; toolSeqCount = 0; lastToolName = ""; lastToolRunning = false;
      planToolCalledInTurn = false;  // reset plan tool flag for the new turn
      if (toolSeqTimer) { clearInterval(toolSeqTimer); toolSeqTimer = null; }

      const wrap = document.createElement('div');
      wrap.className = 'message-wrap assistant';
      currentTurnAssistantDiv = wrap;

      const header = document.createElement('div');
      header.className = 'assistant-header';
      header.innerHTML = '<div class="assistant-avatar">' +
        '<img class="" src="' + sidebarIconUri + '" width="48" alt="Andromity" />' +
      '</div>' +
      '<span class="assistant-name">Andromity</span>';
      wrap.appendChild(header);

      const loader = document.createElement('div');
      loader.className = 'andromity-turn-loader';
      loader.id = 'turn-loading-indicator';
      loader.innerHTML = '<img class="spinning" src="' + sidebarIconUri + '" width="14" height="14" alt="Andromity" /> <span>Andromity is thinking... (0s)</span>';
      wrap.appendChild(loader);

      const loaderTimer = setInterval(() => {
        const span = loader.querySelector('span');
        if (!span || !document.getElementById('turn-loading-indicator')) {
          clearInterval(loaderTimer);
          return;
        }
        const elapsed = Math.floor((Date.now() - currentTurnStartTime) / 1000);
        if (elapsed < 6) {
          span.textContent = 'Andromity is thinking... (' + elapsed + 's)';
        } else if (elapsed < 16) {
          span.textContent = 'Contacting ' + (currentModel || 'model') + '... (' + elapsed + 's)';
        } else {
          span.textContent = 'Waiting for ' + (currentProvider || 'provider') + ' stream... (' + elapsed + 's)';
        }
      }, 1000);

      currentAssistantContent = null;
      accumulatedAssistantText = '';

      chatContainer.appendChild(wrap);
      scrollToBottomIfNeeded();
    }

    function endAssistantTurn() {
      removeTurnLoader();
      finishCurrentThinking();
      finishToolSequence();

      if (currentTurnAssistantDiv) {
        currentTurnAssistantDiv.querySelectorAll('.tool-tag').forEach(tag => {
          if (tag.textContent === 'RUNNING') {
            tag.textContent = 'DONE';
            tag.style.background = 'rgba(63, 185, 80, 0.2)';
            tag.style.color = 'var(--green)';
          }
        });
        currentTurnAssistantDiv.querySelectorAll('.subagent-status').forEach(tag => {
          if (tag.textContent === 'RUNNING') {
            tag.className = 'subagent-status done';
            tag.textContent = 'DONE';
          }
        });
      }

      isRunning = false;
      cancelBtn.innerHTML = CANCEL_BTN_STOP_ICON;
      cancelBtn.disabled = false;
      cancelBtn.style.opacity = '';
      cancelBtn.style.display = 'none';
      sendBtn.style.display = 'flex';

      if (currentTurnAssistantDiv) {
        const elapsedSec = ((Date.now() - currentTurnStartTime) / 1000).toFixed(1);
        const footer = document.createElement('div');
        footer.className = 'message-footer';
        footer.innerHTML = '<span class="turn-duration-badge">' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:2px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' +
          '<span>' + elapsedSec + 's · ' + formatTime(new Date()) + '</span>' +
        '</span>' +
        '<button class="msg-copy-btn" data-action="copy-message" title="Copy response">' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy' +
        '</button>';
        currentTurnAssistantDiv.appendChild(footer);
      }

      currentTurnAssistantDiv = null;
      currentThinkingDiv = null;
      currentThinkingContent = null;
      currentAssistantContent = null;
      accumulatedAssistantText = '';
    }

    const trustBanner = document.getElementById('trust-banner');
    document.getElementById('btn-trust-confirm')?.addEventListener('click', () => {
      trustBanner.style.display = 'none';
      vscode.postMessage({ type: 'trust_workspace' });
    });
    document.getElementById('btn-trust-dismiss')?.addEventListener('click', () => {
      trustBanner.style.display = 'none';
    });

    function clearSkeletonState() {
      try {
        document.body.classList.remove('loading');
        document.querySelectorAll('.skeleton').forEach(el => el.classList.remove('skeleton'));
        document.querySelectorAll('[aria-busy="true"]').forEach(el => el.removeAttribute('aria-busy'));
      } catch {}
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'init_state':
          clearSkeletonState();
          currentSessionId = msg.sessionId;
          allModels = msg.models || [];
          if (msg.skills) {
            allSkills = msg.skills;
          }
          if (msg.model) currentModel = msg.model;
          if (msg.provider) currentProvider = msg.provider;
          if (msg.mode) {
            updateModeBadge(msg.mode);
          }
          if (msg.profile) currentProfile = msg.profile;
          if (msg.reasoningEffort) currentReasoning = msg.reasoningEffort;
          if (msg.isTrusted === false) {
            trustBanner.style.display = 'flex';
          } else {
            trustBanner.style.display = 'none';
          }
          const curSess = (msg.sessions || []).find(s => s.id === msg.sessionId);
          const sessLabel = document.getElementById('active-session-name');
          if (sessLabel) {
            sessLabel.textContent = curSess ? (curSess.name || curSess.id) : 'Main Session';
          }
          if (msg.sessions) {
            allSessions = msg.sessions;
            renderHomeRecentSessions(allSessions);
          }
          if (msg.workspaceName && zeroWorkspaceLabel) {
            zeroWorkspaceLabel.textContent = msg.workspaceName;
          }
          if (curSess) {
            updateTokenDisplay(curSess);
          }
          if (msg.currentPlan) {
            updatePlanTracker(msg.currentPlan);
          }
          if (msg.models && msg.models.length > 0) {
            allModels = msg.models;
          }
          updateModelBadge();
          break;

        case 'trust_updated':
          if (msg.isTrusted) {
            trustBanner.style.display = 'none';
          } else {
            trustBanner.style.display = 'flex';
          }
          break;

        case 'config_updated':
          if (msg.key === 'mode') {
            updateModeBadge(msg.value);
            // If switched from SAFE to TRUST/FULL/YOLO, auto-dismiss any pending tool approval card
            if (msg.value !== 'safe') {
              const appCard = interactiveSlot.querySelector('.approval-card');
              if (appCard) {
                interactiveSlot.innerHTML = '';
                appendSystemNote('Mode switched to ' + msg.value.toUpperCase() + ' -- pending tool auto-approved.');
              }
            }
          } else if (msg.key === 'model') {
            currentModel = msg.value;
            updateModelBadge();
          } else if (msg.key === 'provider') {
            currentProvider = msg.value;
            updateModelBadge();
          } else if (msg.key === 'profile') {
            currentProfile = msg.value;
          } else if (msg.key === 'reasoningEffort') {
            currentReasoning = msg.value;
          }
          break;

        case 'session_updated':
          if (msg.name) {
            const activeSessName = document.getElementById('active-session-name');
            if (activeSessName) {
              activeSessName.textContent = msg.name;
            }
          }
          break;

        case 'session_switched':
          removeTurnLoader();
          finishCurrentThinking();
          interactiveSlot.innerHTML = '';
          break;

        case 'session_loaded':
          removeTurnLoader();
          finishCurrentThinking();
          chatContainer.innerHTML = '';
          interactiveSlot.innerHTML = '';
          const activeSessName = document.getElementById('active-session-name');
          if (activeSessName && msg.session) {
            activeSessName.textContent = msg.session.name || msg.session.id || 'Main Session';
          }
          if (msg.session && msg.session.messages && msg.session.messages.length > 0) {
            hideZeroState();
            let currentAssistantWrap = null;
            let currentAssistantTextEl = null;

            for (let i = 0; i < msg.session.messages.length; i++) {
              const m = msg.session.messages[i];
              if (m.role === 'user') {
                currentAssistantWrap = null;
                currentAssistantTextEl = null;
                appendUserMessage(m.content || '');
              } else if (m.role === 'assistant') {
                if (!currentAssistantWrap) {
                  currentAssistantWrap = document.createElement('div');
                  currentAssistantWrap.className = 'message-wrap assistant';

                  const hdr = document.createElement('div');
                  hdr.className = 'assistant-header';
                  hdr.innerHTML = '<div class="assistant-avatar">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                      '<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#38bdf8"></path>' +
                      '<circle cx="12" cy="12" r="2.5" fill="#a855f7"></circle>' +
                    '</svg>' +
                  '</div>' +
                  '<span class="assistant-name">Andromity</span>';
                  currentAssistantWrap.appendChild(hdr);

                  currentAssistantTextEl = document.createElement('div');
                  currentAssistantTextEl.className = 'assistant-text';
                  currentAssistantWrap.appendChild(currentAssistantTextEl);
                  chatContainer.appendChild(currentAssistantWrap);
                }

                // --- Grouping logic: thinking -> content (flush) -> tools, mirrors TUI load_history ---
                const _thinking = m.thinking || '';
                if (_thinking.trim()) {
                  let _tSeq = currentAssistantWrap._toolSeq;
                  if (_tSeq) {
                    const thinkInner = document.createElement('div');
                    thinkInner.className = 'thinking-card';
                    thinkInner.innerHTML = '<div class="thinking-header"><div class="thinking-pulse" style="opacity:0.4; animation:none;"></div><span>thought</span><svg class="thinking-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg></div><div class="thinking-content">' + escapeHtml(_thinking) + '</div>';
                    _tSeq.querySelector('.tool-seq-body').appendChild(thinkInner);
                  } else {
                    const thinkEl = document.createElement('div');
                    thinkEl.className = 'thinking-card';
                    thinkEl.innerHTML = '<div class="thinking-header"><div class="thinking-pulse" style="opacity:0.4; animation:none;"></div><span>thought</span><svg class="thinking-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg></div><div class="thinking-content">' + escapeHtml(_thinking) + '</div>';
                    currentAssistantWrap.insertBefore(thinkEl, currentAssistantTextEl);
                  }
                }

                // Content with flush: sequential tools before text stay in prior block, text breaks grouping
                const _content = m.content || '';
                if (_content.trim()) {
                  if (currentAssistantWrap._toolSeq) {
                    const _oldSeq = currentAssistantWrap._toolSeq;
                    _oldSeq.classList.add('collapsed');
                    currentAssistantWrap._toolSeq = null;
                    currentAssistantWrap._toolCount = 0;
                  }
                  currentAssistantTextEl.innerHTML += renderMarkdown(_content);
                }

                if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                  let seq = currentAssistantWrap._toolSeq;
                  if (!seq) {
                    seq = document.createElement('div');
                    seq.className = 'tool-sequence collapsed';
                    seq.innerHTML = '<div class="tool-seq-header"><svg class="tool-seq-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg><span class="tool-seq-title">0 tools · worked</span><svg class="tool-seq-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg><button class="tool-seq-copy" title="Copy tool log"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy</button></div><div class="tool-seq-body"></div>';
                    seq.querySelector('.tool-seq-header').addEventListener('click', (e) => {
                      if (e.target.closest('.tool-seq-copy')) return;
                      seq.classList.toggle('collapsed');
                    });
                    seq.querySelector('.tool-seq-copy').addEventListener('click', () => {
                      try {
                        const parts = [];
                        seq.querySelectorAll('.tool-card').forEach((c, idx) => {
                          const n = c.querySelector('.tool-title-group span')?.textContent || 'tool';
                          const args = c.querySelector('.tool-body')?.textContent || '';
                          parts.push((idx + 1) + '. ' + n + '\\n   Args: ' + args);
                        });
                        copyToClipboard(parts.join('\\n\\n') || seq.textContent);
                      } catch {}
                    });
                    const _hasText = currentAssistantTextEl && currentAssistantTextEl.innerHTML.trim().length > 0;
                    if (_hasText) {
                      currentAssistantWrap.appendChild(seq);
                    } else {
                      currentAssistantWrap.insertBefore(seq, currentAssistantTextEl);
                    }
                    currentAssistantWrap._toolSeq = seq;
                    currentAssistantWrap._toolCount = 0;
                  }
                  const body = seq.querySelector('.tool-seq-body');
                  for (const tc of m.tool_calls) {
                    currentAssistantWrap._toolCount++;
                    const fn = tc.function || {};
                    const tDiv = document.createElement('div');
                    tDiv.className = 'tool-card';
                    tDiv.innerHTML = '<div class="tool-header">' +
                      '<div class="tool-title-group">' +
                        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>' +
                        '<span>' + escapeHtml(fn.name || 'tool') + '</span>' +
                      '</div>' +
                      '<div style="display:flex; align-items:center;">' +
                        '<span class="tool-tag" style="background:rgba(63,185,80,0.2); color:var(--green);">DONE</span>' +
                        '<svg class="tool-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
                      '</div>' +
                    '</div>' +
                    '<div class="tool-body">' + escapeHtml(fn.arguments || '') + '</div>';
                    body.appendChild(tDiv);
                  }
                  const totalCnt = currentAssistantWrap._toolCount;
                  seq.querySelector('.tool-seq-title').textContent = totalCnt + (totalCnt === 1 ? ' tool' : ' tools') + ' · worked';
                }

                // Check if next message is NOT an assistant message (or is last message) -> append ONE footer
                const nextMsg = msg.session.messages[i + 1];
                if (!nextMsg || nextMsg.role === 'user') {
                  const footer = document.createElement('div');
                  footer.className = 'message-footer';
                  footer.innerHTML = '<button class="msg-copy-btn" data-action="copy-message" title="Copy response">' +
                    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy' +
                  '</button>';
                  currentAssistantWrap.appendChild(footer);
                  currentAssistantWrap = null;
                  currentAssistantTextEl = null;
                }
              }
            }
          } else {
            chatContainer.appendChild(zeroState);
            zeroState.style.display = 'flex';
          }
          if (msg.session) {
            currentSessionId = msg.session.id || currentSessionId;
            if (msg.session.model) {
              currentModel = msg.session.model;
              if (msg.session.provider) currentProvider = msg.session.provider;
              updateModelBadge();
            }
            updateTokenDisplay(msg.session);
          }
          break;

        case 'play_sound':
          playTone(msg.kind);
          break;

        case 'text_delta': {
          const _tdText = msg.text || '';
          const _isMeaningful = _tdText.trim().length > 0;
          removeTurnLoader();
          finishCurrentThinking();
          if (_isMeaningful && currentToolSequence) finishToolSequence();
          if (!_isMeaningful) {
            // whitespace-only deltas: preserve grouping, do not break tool block
            if (currentAssistantContent) {
              currentAssistantContent._blockText = (currentAssistantContent._blockText || '') + _tdText;
              accumulatedAssistantText += _tdText;
            }
            break;
          }
          if (!currentTurnAssistantDiv) startAssistantTurn();

          if (!currentAssistantContent) {
            currentAssistantContent = document.createElement('div');
            currentAssistantContent.className = 'assistant-text';
            currentTurnAssistantDiv.appendChild(currentAssistantContent);
            currentAssistantContent._blockText = '';
          }
          currentAssistantContent._blockText = (currentAssistantContent._blockText || '') + _tdText;
          accumulatedAssistantText += _tdText;
          currentAssistantContent.innerHTML = renderMarkdown(currentAssistantContent._blockText);
          scrollToBottomIfNeeded();
          break; }

        case 'thinking_delta':
          removeTurnLoader();
          if (!currentTurnAssistantDiv) startAssistantTurn();
          if (!currentThinkingDiv) {
            thinkingStartTime = Date.now();
            currentThinkingDiv = document.createElement('div');
            currentThinkingDiv.className = 'thinking-card expanded';
            currentThinkingDiv.innerHTML = '<div class="thinking-header">' +
              '<div class="thinking-pulse"></div>' +
              '<span>thinking...</span>' +
              '<svg class="thinking-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
            '</div>';
            currentThinkingContent = document.createElement('div');
            currentThinkingContent.className = 'thinking-content';
            currentThinkingDiv.appendChild(currentThinkingContent);
            // TUI parity: thinking between tools goes inside tool sequence
            if (currentToolSequence) {
              currentToolSequence.querySelector('.tool-seq-body').appendChild(currentThinkingDiv);
            } else {
              currentTurnAssistantDiv.appendChild(currentThinkingDiv);
            }
          }
          currentThinkingContent.textContent += msg.text;
          scrollToBottomIfNeeded();
          break;

        case 'tool_start': {
          removeTurnLoader();
          finishCurrentThinking();
          if (!currentTurnAssistantDiv) startAssistantTurn();

          // Reset assistant text block so text following this tool sequence creates a new block
          currentAssistantContent = null;

          const seq = ensureToolSequence();
          toolSeqCount++;
          lastToolName = msg.tool_name || 'tool';
          lastToolRunning = true;
          // Track if this turn uses plan tools
          if (msg.tool_name === 'write_plan' || msg.tool_name === 'update_plan_step') {
            planToolCalledInTurn = true;
          }
          updateToolSeqHeader();
          const toolDiv = document.createElement('div');
          toolDiv.className = 'tool-card expanded';
          toolDiv.id = 'tool-' + msg.tool_id;
          toolDiv.innerHTML = '<div class="tool-header">' +
            '<div class="tool-title-group">' +
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>' +
              '<span>' + escapeHtml(msg.tool_name) + '</span>' +
            '</div>' +
            '<div style="display:flex; align-items:center;">' +
              '<span class="tool-tag">RUNNING</span>' +
              '<svg class="tool-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
            '</div>' +
          '</div>' +
          '<div class="tool-body" id="args-' + msg.tool_id + '"></div>';
          seq.querySelector('.tool-seq-body').appendChild(toolDiv);
          scrollToBottomIfNeeded();
          break; }

        case 'tool_delta':
          const argsEl = document.getElementById('args-' + msg.tool_id);
          if (argsEl) argsEl.textContent += msg.chunk;
          break;

        case 'tool_result':
        case 'tool_end': {
          const targetTool = document.getElementById('tool-' + msg.tool_id);
          if (targetTool) {
            const tag = targetTool.querySelector('.tool-tag');
            if (tag) {
              tag.textContent = 'DONE';
              tag.style.background = 'rgba(63, 185, 80, 0.2)';
              tag.style.color = 'var(--green)';
            }
            targetTool.classList.remove('expanded');
          }
          if (msg.tool_id) {
            toolSeqDoneTools.add(msg.tool_id);
          }
          lastToolRunning = false;
          updateToolSeqHeader();
          break; }

        case 'tool_approval_required':
          const toolArgs = msg.args || {};
          const rawArgs = (()=>{ try{ return JSON.stringify(toolArgs, null, 2); }catch{ return String(toolArgs); } })();
          const previewPath = toolArgs.path || toolArgs.file || toolArgs.file_path || toolArgs.TargetFile || toolArgs.command || "";
          const shortPath = previewPath ? (previewPath.length>48 ? previewPath.slice(0,22)+"..."+previewPath.slice(-22) : previewPath) : "";
          const modeCls = currentMode === 'trust' ? 'green' : (currentMode === 'full' ? 'blue' : (currentMode === 'yolo' ? 'red' : 'orange'));
          const modeTxt = (currentMode || 'safe').toUpperCase();
          interactiveSlot.innerHTML = 
            '<div class="approval-card">' +
              '<div class="approval-header">' +
                '<div class="approval-icon">' +
                  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>' +
                '</div>' +
                '<div style="flex:1; min-width:0;">' +
                  '<div class="approval-kicker">Permission Request</div>' +
                  '<div class="approval-title">Allow <code>' + escapeHtml(msg.tool_name) + '</code> to run?</div>' +
                '</div>' +
                '<span class="approval-tool-pill status-pill ' + modeCls + '">' + escapeHtml(modeTxt) + '</span>' +
              '</div>' +
              '<div class="approval-tool-meta">' +
                '<span class="approval-tool-pill"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg> ' + escapeHtml(msg.tool_name) + '</span>' +
                (shortPath ? ('<span class="approval-path" title="' + escapeHtml(previewPath) + '">' + escapeHtml(shortPath) + '</span>') : '') +
              '</div>' +
              '<div class="approval-desc">The assistant is requesting permission to execute <strong>' + escapeHtml(msg.tool_name) + '</strong>.</div>' +
              (rawArgs && Object.keys(toolArgs).length ? ('<div class="approval-toggle-args"><span>&#x25B8; View parameters</span></div><div class="approval-args">' + escapeHtml(rawArgs) + '</div>') : '') +
              '<div class="approval-buttons">' +
                '<button class="btn-approve" data-action="approve-tool" data-approval-id="' + escapeHtml(msg.approval_id) + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> Allow</button>' +
                '<button class="btn-reject" data-action="reject-tool" data-approval-id="' + escapeHtml(msg.approval_id) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Deny</button>' +
              '</div>' +
            '</div>';
          break;

        case 'ask_questions': {
          const questions = msg.questions || [];
          const totalQ = questions.length;
          window.currentQuestionSlide = 0;
          window.totalQuestionSlides = totalQ;

          let slidesHtml = '';
          questions.forEach((q, idx) => {
            let optionsHtml = '';
            if (q.options && q.options.length > 0) {
              const isMulti = q.type === 'multi';
              optionsHtml = '<div class="question-options-list">';
              q.options.forEach(opt => {
                optionsHtml += '<label class="question-option-row">' +
                  '<input type="' + (isMulti ? 'checkbox' : 'radio') + '" name="q_' + idx + '" value="' + escapeHtml(opt) + '">' +
                  '<span>' + escapeHtml(opt) + '</span>' +
                '</label>';
              });
              optionsHtml += '</div>';
            } else {
              optionsHtml = '<div style="margin-top:4px;">' +
                '<textarea id="q_input_' + idx + '" class="question-textarea" data-q-idx="' + idx + '" placeholder="Type your answer..." rows="2"></textarea>' +
              '</div>';
            }

            slidesHtml += '<div class="question-slide" id="q-slide-' + idx + '" style="' + (idx === 0 ? 'display:block;' : 'display:none;') + '">' +
              '<div class="question-prompt">' +
                (totalQ > 1 ? '<span class="question-num-tag">Question ' + (idx + 1) + ':</span> ' : '') + escapeHtml(q.question) +
              '</div>' +
              optionsHtml +
            '</div>';
          });

          let qHtml = '<div class="questions-card" id="questions-carousel-card">' +
            '<div class="questions-header">' +
              '<div class="questions-title">Clarifying Questions</div>' +
              (totalQ > 1 ? '<div class="questions-step-badge" id="q-step-badge">1 of ' + totalQ + '</div>' : '') +
            '</div>' +
            '<div class="carousel-slides">' + slidesHtml + '</div>' +
            '<div class="carousel-footer">' +
              '<button class="btn-carousel-prev" id="btn-q-prev" data-action="q-prev" style="visibility:hidden;">Back</button>' +
              '<div style="display:flex; gap:6px;">' +
                (totalQ > 1 ? '<button class="btn-carousel-next" id="btn-q-next" data-action="q-next">Next</button>' : '') +
                '<button class="btn-carousel-submit" id="btn-q-submit" data-action="submit-questions" data-question-id="' + msg.question_id + '" data-total-q="' + totalQ + '" style="' + (totalQ > 1 ? 'display:none;' : '') + '">Submit ' + (totalQ > 1 ? 'Answers' : 'Answer') + '</button>' +
              '</div>' +
            '</div>' +
          '</div>';

          interactiveSlot.innerHTML = qHtml;
          break;
        }

        case 'plan_approval':
          const plan = msg.plan || {};
          let todosHtml = '';
          if (plan.todos && plan.todos.length > 0) {
            todosHtml = '<div style="margin-top:6px; display:flex; flex-direction:column; gap:3px;">' +
              plan.todos.map(t => '<div style="font-size:11px; color:var(--muted);"><span style="color:var(--accent); font-weight:600;">\u2022</span> ' + escapeHtml(t.description || t.title || t) + '</div>').join('') +
            '</div>';
          }
          interactiveSlot.innerHTML = 
            '<div class="approval-card">' +
              '<div style="font-weight:600; color:var(--purple); display:flex; align-items:center; gap:6px;">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>' +
                '<span>Plan Review: ' + escapeHtml(plan.title || 'Implementation Plan') + '</span>' +
              '</div>' +
              (plan.description ? ('<div style="margin-top:4px; font-size:11.5px; color:var(--fg);">' + escapeHtml(plan.description) + '</div>') : '') +
              todosHtml +
              '<input type="text" id="plan-feedback-input" placeholder="Optional review note or instructions..." style="width:100%; margin-top:8px; padding:5px 8px; font-size:11.5px; background:var(--input-bg); border:1px solid var(--input-border); color:var(--fg); border-radius:4px; outline:none;">' +
              '<div class="approval-buttons" style="margin-top:8px;">' +
                '<button class="btn-approve" data-action="approve-plan" style="background:var(--green); color:#fff;">Approve & Execute</button>' +
                '<button class="btn-reject" data-action="reject-plan" style="background:var(--red); color:#fff;">Reject & Revise</button>' +
              '</div>' +
            '</div>';
          break;

        case 'subagent_spawned':
          if (!currentTurnAssistantDiv) startAssistantTurn();
          appendSubagentCard(msg);
          break;

        case 'subagent_progress':
        case 'subagent_done':
        case 'subagent_failed':
          updateSubagentCard(msg);
          break;

        case 'agent_started':
          if (!currentTurnAssistantDiv) startAssistantTurn();
          break;

        case 'session_compacted':
          appendSystemNote('Context compacted: conversation history compressed to save tokens.');
          break;

        case 'turn_undone':
          appendSystemNote('Last turn undone: file changes rolled back.');
          break;

        case 'agent_busy':
          if (msg.queuedPrompt) {
            promptQueue.push(msg.queuedPrompt);
            renderQueue();
            appendSystemNote('Agent busy -- your message was queued (will send after this turn).');
          } else {
            appendSystemNote('Agent is still working -- please wait for this turn to finish.');
          }
          break;

        case 'agent_done':
          if (cancelFallbackTimer) { clearTimeout(cancelFallbackTimer); cancelFallbackTimer = null; }
          cancelBtn.disabled = false;
          cancelBtn.style.opacity = '';
          cancelBtn.innerHTML = CANCEL_BTN_STOP_ICON;
          endAssistantTurn();
          interactiveSlot.innerHTML = '';
          updateTokenDisplay({
            token_total: msg.token_total,
            context_tokens: msg.context_tokens,
            cost_usd: msg.cost_usd,
          });
          flushQueue();
          break;

        case 'agent_cancelled':
          if (cancelFallbackTimer) { clearTimeout(cancelFallbackTimer); cancelFallbackTimer = null; }
          cancelBtn.disabled = false;
          cancelBtn.style.opacity = '';
          cancelBtn.innerHTML = CANCEL_BTN_STOP_ICON;
          endAssistantTurn();
          interactiveSlot.innerHTML = '';
          appendSystemNote('Turn cancelled by user.');
          if (msg.token_total !== undefined || msg.context_tokens !== undefined) {
            updateTokenDisplay({
              token_total: msg.token_total,
              context_tokens: msg.context_tokens,
              cost_usd: msg.cost_usd,
            });
          }
          flushQueue();
          break;

        case 'agent_error':
          if (cancelFallbackTimer) { clearTimeout(cancelFallbackTimer); cancelFallbackTimer = null; }
          cancelBtn.disabled = false;
          cancelBtn.style.opacity = '';
          cancelBtn.innerHTML = CANCEL_BTN_STOP_ICON;
          // If error is just a timeout but stream already started, don't end turn abruptly
          if (msg.error && msg.error.includes('RPC timeout')) {
            appendSystemNote('Note: ' + msg.error + ' -- but agent is still streaming. Watch the footer for progress.');
            if (!currentTurnAssistantDiv) startAssistantTurn();
            break;
          }
          endAssistantTurn();
          interactiveSlot.innerHTML = '';
          appendErrorCard(msg.error || 'Unknown agent error.');
          flushQueue();
          break;

        case 'toggle_sessions':
          toggleSessionsFlyout();
          break;

        case 'toggle_crons':
          toggleCronsFlyout();
          break;

        case 'sessions_data':
          renderSessionsList(msg.sessions || [], msg.currentSessionId || currentSessionId);
          break;

        case 'crons_data':
          renderCronsList(msg.crons || []);
          break;

        case 'plan_updated':
          updatePlanTracker(msg.plan);
          // Only show the pill in the chat if a plan tool was explicitly called
          // this turn (not on session restore / disk load which fires outside a turn)
          if (msg.plan && msg.plan.title && planToolCalledInTurn) {
            renderPlanPill(msg.plan);
          }
          break;

        case 'backend_ready': {
          const card = document.getElementById('setup-guide-card');
          if (card) card.style.display = 'none';
          break;
        }

        case 'backend_offline': {
          const card = document.getElementById('setup-guide-card');
          if (card) card.style.display = 'flex';
          if (msg.message) {
            const body = document.getElementById('setup-guide-body');
            if (body) body.textContent = msg.message;
          }
          break;
        }

        case 'session_updated':
          if (msg.name) {
            const activeSessName = document.getElementById('active-session-name');
            if (activeSessName && (!msg.session_id || msg.session_id === currentSessionId)) {
              activeSessName.textContent = msg.name;
            }
            const sObj = allSessions.find(s => s.id === (msg.session_id || currentSessionId));
            if (sObj) {
              sObj.name = msg.name;
              if (msg.message_count !== undefined) sObj.message_count = msg.message_count;
              if (msg.context_tokens !== undefined) sObj.context_tokens = msg.context_tokens;
              renderHomeRecentSessions(allSessions);
            }
          }
          if (msg.context_tokens !== undefined || msg.token_total !== undefined) {
            if (!msg.session_id || msg.session_id === currentSessionId) {
              updateTokenDisplay(msg);
            }
          }
          break;

        case 'external_prompt': {
          // Sent by extension commands: Explain Code, Ask About Selection, Generate Tests
          const extPrompt = msg.prompt || '';
          const extCtx = msg.context || null;
          if (!extPrompt) break;

          // Focus the chat view and make sure chat is visible
          hideZeroState();

          // Build user message with context snippet if provided
          let fullUserMsg = extPrompt;
          if (extCtx && extCtx.selectedText) {
            const lang = extCtx.languageId || '';
            const filePath = extCtx.relativePath || extCtx.filePath || '';
            const lineInfo = extCtx.selectionRange
              ? ' (lines ' + extCtx.selectionRange.startLine + '-' + extCtx.selectionRange.endLine + ')'
              : '';
            const bt = String.fromCharCode(96); const fence = bt+bt+bt;
            const nl = String.fromCharCode(10);
            fullUserMsg = extPrompt + nl + nl + fence + lang + (filePath ? '  // ' + filePath + lineInfo : '') + nl + extCtx.selectedText + nl + fence;
          }

          // Cleanly send via dispatchPrompt (creates UI bubbles, starts turn loader, and sends send_prompt RPC)
          if (promptInput) promptInput.value = '';
          dispatchPrompt(fullUserMsg, false, []);
          break;
        }
      }
    });

    function appendErrorCard(text) {
      const errDiv = document.createElement('div');
      errDiv.className = 'error-card';
      errDiv.style.color = 'var(--red)';
      errDiv.style.fontSize = '12px';
      errDiv.textContent = 'Error: ' + text;
      chatContainer.appendChild(errDiv);
      scrollToBottomIfNeeded();
    }

    function appendSystemNote(text) {
      const note = document.createElement('div');
      note.className = 'system-note';
      note.style.fontSize = '11px';
      note.style.color = 'var(--muted)';
      note.textContent = text;
      chatContainer.appendChild(note);
      scrollToBottomIfNeeded();
    }

    function appendSubagentCard(msg) {
      const card = document.createElement('div');
      card.className = 'subagent-card';
      card.id = 'subagent-' + msg.agent_id;
      const roleStr = escapeHtml(msg.role || 'subagent');
      const modelStr = msg.model ? ('<span class="badge blue" style="font-size:9.5px; margin-left:4px;">' + escapeHtml(msg.model) + '</span>') : '';
      
      card.innerHTML =
        '<div class="subagent-header">' +
          '<div class="subagent-header-left">' +
            '<svg class="subagent-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M12 1v6m0 6v6m11-9h-6m-6 0H1"></path></svg>' +
            '<span class="subagent-role">' + roleStr + '</span>' +
            modelStr +
          '</div>' +
          '<div class="subagent-header-right">' +
            '<span class="subagent-status running">RUNNING</span>' +
            '<svg class="subagent-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
          '</div>' +
        '</div>' +
        '<div class="subagent-body">' +
          (msg.task ? ('<div class="subagent-task"><span class="subagent-task-label">Task:</span> ' + escapeHtml(msg.task) + '</div>') : '') +
          '<div class="subagent-live-status">' +
            '<span class="subagent-spinner"></span>' +
            '<span class="subagent-live-text">Working on task...</span>' +
          '</div>' +
          '<div class="subagent-result-box" style="display:none;"></div>' +
        '</div>';

      const header = card.querySelector('.subagent-header');
      if (header) {
        header.addEventListener('click', () => {
          card.classList.toggle('collapsed');
        });
      }

      if (currentToolSequence) {
        currentToolSequence.querySelector('.tool-seq-body').appendChild(card);
      } else if (currentTurnAssistantDiv) {
        currentTurnAssistantDiv.appendChild(card);
      }
      scrollToBottomIfNeeded();
    }

    function updateSubagentCard(msg) {
      let card = document.getElementById('subagent-' + msg.agent_id);
      if (!card) {
        if (!currentTurnAssistantDiv) return;
        appendSubagentCard(msg);
        card = document.getElementById('subagent-' + msg.agent_id);
        if (!card) return;
      }
      const statusEl = card.querySelector('.subagent-status');
      const liveStatusEl = card.querySelector('.subagent-live-status');
      const liveTextEl = card.querySelector('.subagent-live-text');
      const resultBox = card.querySelector('.subagent-result-box');

      // In-place live step updates (no repeated spammy bullet items)
      if (msg.detail && msg.detail !== 'running' && liveTextEl) {
        liveTextEl.textContent = msg.detail;
      }

      if (msg.error || msg.type === 'subagent_failed') {
        if (statusEl) {
          statusEl.className = 'subagent-status failed';
          statusEl.textContent = 'FAILED';
        }
        if (liveStatusEl) liveStatusEl.style.display = 'none';
        if (resultBox) {
          resultBox.style.display = 'block';
          resultBox.innerHTML = '<span style="color:var(--red); font-weight:500;">Failed:</span> ' + escapeHtml(msg.error || 'Subagent encountered an error.');
        }
      } else if (msg.type === 'subagent_done' || msg.result !== undefined || msg.status === 'completed' || msg.status === 'done') {
        if (statusEl) {
          statusEl.className = 'subagent-status done';
          statusEl.textContent = 'DONE';
        }
        if (liveStatusEl) liveStatusEl.style.display = 'none';
        if (resultBox && (msg.result || msg.output)) {
          resultBox.style.display = 'block';
          const resContent = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result, null, 2);
          resultBox.innerHTML = '<div class="subagent-result-title">Result</div>' + renderMarkdown(resContent);
        }
      }
      scrollToBottomIfNeeded();
    }

    window.approveTool = function(approvalId) {
      interactiveSlot.innerHTML = '';
      vscode.postMessage({ type: 'approve_tool', approvalId });
    };

    window.rejectTool = function(approvalId) {
      interactiveSlot.innerHTML = '';
      vscode.postMessage({ type: 'reject_tool', approvalId });
    };

    window.approvePlan = function() {
      const feedbackInput = document.getElementById('plan-feedback-input');
      const feedback = feedbackInput ? feedbackInput.value.trim() : '';
      interactiveSlot.innerHTML = '';
      vscode.postMessage({ type: 'approve_plan', feedback });
    };

    window.rejectPlan = function() {
      const feedbackInput = document.getElementById('plan-feedback-input');
      const feedback = feedbackInput ? feedbackInput.value.trim() : '';
      interactiveSlot.innerHTML = '';
      vscode.postMessage({ type: 'reject_plan', feedback });
    };

    window.currentQuestionSlide = 0;
    window.totalQuestionSlides = 1;

    window.navigateQuestionSlide = function(delta) {
      const nextIdx = window.currentQuestionSlide + delta;
      if (nextIdx < 0 || nextIdx >= window.totalQuestionSlides) return;
      const oldSlide = document.getElementById('q-slide-' + window.currentQuestionSlide);
      const newSlide = document.getElementById('q-slide-' + nextIdx);
      if (oldSlide) oldSlide.style.display = 'none';
      if (newSlide) newSlide.style.display = 'block';

      window.currentQuestionSlide = nextIdx;

      const badge = document.getElementById('q-step-badge');
      if (badge) badge.textContent = (nextIdx + 1) + ' of ' + window.totalQuestionSlides;

      const btnPrev = document.getElementById('btn-q-prev');
      if (btnPrev) btnPrev.style.visibility = (nextIdx > 0) ? 'visible' : 'hidden';

      const btnNext = document.getElementById('btn-q-next');
      const btnSubmit = document.getElementById('btn-q-submit');
      if (nextIdx === window.totalQuestionSlides - 1) {
        if (btnNext) btnNext.style.display = 'none';
        if (btnSubmit) btnSubmit.style.display = 'inline-flex';
      } else {
        if (btnNext) btnNext.style.display = 'inline-flex';
        if (btnSubmit) btnSubmit.style.display = 'none';
      }
    };

    window.handleQuestionKey = function(event, idx) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (window.currentQuestionSlide < window.totalQuestionSlides - 1) {
          window.navigateQuestionSlide(1);
        } else {
          const s = document.getElementById('btn-q-submit');
          if (s) s.click();
        }
      }
    };

    window.submitQuestions = function(questionId, totalQ) {
      const answers = [];
      for (let i = 0; i < totalQ; i++) {
        const checked = document.querySelectorAll('input[name="q_' + i + '"]:checked');
        if (checked.length > 0) {
          const vals = Array.from(checked).map(c => c.value);
          answers.push(vals.join(', '));
        } else {
          const textIn = document.getElementById('q_input_' + i);
          answers.push(textIn ? textIn.value.trim() : '');
        }
      }
      interactiveSlot.innerHTML = '';
      vscode.postMessage({ type: 'answer_question', questionId, answers: answers.join(', ') });
    };

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    window.openImageLightbox = function(uri, title) {
      const overlay = document.getElementById('image-lightbox-overlay');
      const img = document.getElementById('image-lightbox-img');
      const titleEl = document.getElementById('image-lightbox-title');
      if (overlay && img && uri) {
        img.src = uri;
        if (titleEl) titleEl.textContent = title || 'Image Preview';
        overlay.style.display = 'flex';
        void overlay.offsetWidth;
        overlay.classList.add('open');
      }
    };

    window.closeImageLightbox = function() {
      const overlay = document.getElementById('image-lightbox-overlay');
      if (overlay) {
        overlay.classList.remove('open');
        setTimeout(function() {
          if (!overlay.classList.contains('open')) {
            overlay.style.display = 'none';
            const img = document.getElementById('image-lightbox-img');
            if (img) img.src = '';
          }
        }, 200);
      }
    };

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        window.closeImageLightbox();
      }
    });

    document.addEventListener('click', function(e) {
      const closeLb = e.target.closest('#btn-lightbox-close');
      const overlayLb = e.target === document.getElementById('image-lightbox-overlay') || (e.target.classList && e.target.classList.contains('image-lightbox-container'));
      if (closeLb || overlayLb) {
        window.closeImageLightbox();
        return;
      }
      const rmImg = e.target.closest('[data-action="remove-image-attachment"]');
      if (rmImg) {
        const idx = parseInt(rmImg.getAttribute('data-idx') || '0', 10);
        removeImageAttachment(idx);
        return;
      }
      const previewImg = e.target.closest('[data-action="preview-image"]');
      if (previewImg && !e.target.closest('[data-action="remove-image-attachment"]')) {
        const src = previewImg.getAttribute('data-src') || (previewImg.querySelector('img') ? previewImg.querySelector('img').src : '');
        const title = previewImg.getAttribute('data-title') || 'Image Preview';
        if (src) {
          window.openImageLightbox(src, title);
        }
        return;
      }
      const chatImg = e.target.closest('.message img, .assistant-text img, .user-text img');
      if (chatImg && chatImg.src && !chatImg.closest('button') && !chatImg.classList.contains('avatar-img') && !chatImg.classList.contains('token-icon')) {
        window.openImageLightbox(chatImg.src, chatImg.alt || 'Image Preview');
        return;
      }
      const setupCheck = e.target.closest('[data-action="run-setup-check"]');
      if (setupCheck) {
        vscode.postMessage({ type: 'check_setup' });
        return;
      }
      const setupInstall = e.target.closest('[data-action="install-python-web"]');
      if (setupInstall) {
        vscode.postMessage({ type: 'install_python' });
        return;
      }
      const setupConfig = e.target.closest('[data-action="configure-python-path"]');
      if (setupConfig) {
        vscode.postMessage({ type: 'configure_python_path' });
        return;
      }
      const slashCmd = e.target.closest('[data-action="select-slash-cmd"]');
      if (slashCmd) {
        const cmdName = slashCmd.getAttribute('data-cmd');
        const found = slashCommands.find(c => c.cmd === cmdName);
        if (found) {
          executeSlashCommand(found);
        }
        return;
      }
    });

    function focusPrompt() {
      // VS Code webview ignores native autofocus attr; must focus via JS after visible
      try {
        if (promptInput && document.hasFocus && !document.hasFocus()) {
          // still try — webview host may delegate focus later
        }
        if (promptInput) {
          promptInput.focus({ preventScroll: true });
          // Move cursor to end if already has value
          const len = promptInput.value.length;
          try { promptInput.setSelectionRange(len, len); } catch {}
        }
      } catch {}
    }

    // Initial focus after DOM ready + after VS Code reveals the view
    // Use rAF + timeout because webview may still be hidden during first paint
    function scheduleFocus() {
      requestAnimationFrame(() => setTimeout(focusPrompt, 50));
      setTimeout(focusPrompt, 300);
    }
    scheduleFocus();
    document.addEventListener('DOMContentLoaded', scheduleFocus);
    window.addEventListener('focus', focusPrompt);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleFocus();
    });
    // Refocus after every turn ends / errors / cancels so user can type immediately
    const _origEndAssistantTurn = endAssistantTurn;
    endAssistantTurn = function() {
      _origEndAssistantTurn();
      scheduleFocus();
    };

    setRandomStatement();
    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'webview_ready' });
    // Also request host to transfer focus into webview (required on first show)
    setTimeout(() => focusPrompt(), 100);
`;
}
