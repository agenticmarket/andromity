import { ChatViewState } from "./chatHtml.js";

export function getChatClientScript(sidebarIconUri: string, state: ChatViewState): string {
  return `
    const vscode = acquireVsCodeApi();
    window.__vscodeApi = vscode;
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
    const trackerTodosList = document.getElementById('tracker-todos-list');
    const zeroWorkspaceLabel = document.getElementById('zero-workspace-label');
    const recentSessionsSection = document.getElementById('recent-sessions-section');
    const recentSessionsList = document.getElementById('recent-sessions-list');
    let allSessions = [];
    let allProviders = [];
    let sessionDisplayLimit = 10;
    const sessionsState = {};
    const sessionDomCache = new Map(); // sessionId -> { html:string, isRunning:boolean }
    const sessionLiveBuffer = new Map(); // sessionId -> Array<raw msg> for replay when switching to a live session
    let turnEditedFiles = new Set();
    let globalDiffStats = {};
    let lastTurnPrompt = null;
    const btnScrollBottom = document.getElementById('btn-scroll-bottom');
    const scrollUnreadBadge = document.getElementById('scroll-unread-badge');
    const timelineFlyout = document.getElementById('timeline-flyout');
    const timelineList = document.getElementById('timeline-list');
    const btnTopTimeline = document.getElementById('btn-top-timeline');
    const btnTimelineClose = document.getElementById('btn-timeline-close');

    const onboardingSection = document.getElementById('onboarding-guide-section');
    const readyHeroSection = document.getElementById('ready-hero-section');
    const onboardingProvidersGrid = document.getElementById('onboarding-providers-grid');
    const onboardingKeyForm = document.getElementById('onboarding-key-form');
    const onboardingOllamaForm = document.getElementById('onboarding-ollama-form');
    const onboardingKeyInput = document.getElementById('onboarding-key-input');
    const onboardingKeyLabel = document.getElementById('onboarding-key-label');
    const onboardingPortalLink = document.getElementById('onboarding-portal-link');
    const btnOnboardingSave = document.getElementById('btn-onboarding-save');
    const btnOnboardingOllamaSave = document.getElementById('btn-onboarding-ollama-save');
    const btnToggleKeyVis = document.getElementById('btn-toggle-key-vis');

    const wfCallout = document.getElementById('waterfall-callout-popover');
    const btnWfTop = document.getElementById('btn-top-waterfall');
    const btnDismissWfCallout = document.getElementById('btn-dismiss-wf-callout');
    const btnActionWfCallout = document.getElementById('btn-action-wf-callout');

    function checkWaterfallOnboarding(alreadyShownServer) {
      try {
        if (alreadyShownServer === true) {
          dismissWaterfallOnboarding();
          return;
        }
        const shown = localStorage.getItem('andromity_waterfall_callout_shown');
        if (!shown && wfCallout && btnWfTop) {
          wfCallout.style.display = 'block';
          btnWfTop.classList.add('waterfall-highlight');
        }
      } catch (e) {}
    }

    function dismissWaterfallOnboarding() {
      try {
        if (wfCallout) wfCallout.style.display = 'none';
        if (btnWfTop) btnWfTop.classList.remove('waterfall-highlight');
        localStorage.setItem('andromity_waterfall_callout_shown', 'true');
      } catch (e) {}
    }

    btnDismissWfCallout?.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissWaterfallOnboarding();
    });

    btnActionWfCallout?.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissWaterfallOnboarding();
      const sNameEl = document.getElementById('active-session-name');
      vscode.postMessage({
        type: 'open_waterfall',
        sessionId: currentSessionId,
        sessionName: sNameEl?.textContent?.trim() || 'Session'
      });
    });

    let selectedOnboardingProvider = 'anthropic';
    let selectedOnboardingModel = 'claude-sonnet-4-6';

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
      { cmd: '/trust', desc: 'Trust workspace folder (enable file writes & commands)', action: 'trust' },
      { cmd: '/untrust', desc: 'Revoke workspace trust (block file writes & commands)', action: 'untrust' },
      { cmd: '/mode', desc: 'Cycle permission mode (safe / trust / full / yolo)', action: 'mode' },
      { cmd: '/model', desc: 'Switch AI model', action: 'model' },
      { cmd: '/plan', desc: 'Open Implementation Plan editor tab', action: 'plan' },
      { cmd: '/diff', desc: 'View git diff of current changes', action: 'diff' },
      { cmd: '/undo', desc: 'Undo last turn & rollback file modifications', action: 'undo' },
      { cmd: '/compact', desc: 'Compress conversation context to save tokens', action: 'compact' },
      { cmd: '/new', desc: 'Start a fresh conversation session', action: 'new' },
      { cmd: '/clear', desc: 'Clear current chat history view', action: 'clear' },
      { cmd: '/sessions', desc: 'Open sessions browser', action: 'sessions' },
      { cmd: '/cron', desc: 'Manage scheduled background cron jobs', action: 'cron' },
      { cmd: '/settings', desc: 'Open Settings, Model Catalog & MCP Hub', action: 'settings' },
      { cmd: '/personalisation', desc: 'Open Personalisation & Wallpaper Atmosphere settings', action: 'personalisation' },
      { cmd: '/pet', desc: 'Toggle or interact with Andro-Pet companion', action: 'pet' },
      { cmd: '/play', desc: 'Perform a trick with Andro-Pet companion', action: 'play' },
      { cmd: '/fetch', desc: 'Recall Andro-Pet companion home', action: 'fetch' },
      { cmd: '/about', desc: 'About Andromity, license & repository information', action: 'about' },
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
      tokenWidgetEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          tokenWidgetEl.classList.toggle('active');
        }
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
        updateOnboardingVisibility();
        setRandomStatement();
        if (Array.isArray(allSessions) && allSessions.length > 0) {
          renderHomeRecentSessions(allSessions.filter(s => !s.parent_session));
        }
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
    const sentPromptsHistory = [];
    let promptHistoryIndex = 0;
    let tempPromptDraft = '';
    let lastAppendedUserText = '';
    let lastAppendedUserTime = 0;
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
    let isProgrammaticScroll = false;
    let programmaticScrollTimer = null;

    function isAtBottom(threshold = 120) {
      if (!chatContainer) return true;
      return (chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight) <= threshold;
    }

    function scrollToBottom(smooth = false) {
      if (!chatContainer) return;
      userScrolledUp = false;
      if (btnScrollBottom) {
        btnScrollBottom.classList.remove('visible');
        if (scrollUnreadBadge) scrollUnreadBadge.classList.remove('has-unread');
      }

      isProgrammaticScroll = true;
      if (programmaticScrollTimer) clearTimeout(programmaticScrollTimer);

      const doScroll = () => {
        if (!chatContainer) return;
        chatContainer.scrollTop = chatContainer.scrollHeight;
        const lastEl = chatContainer.lastElementChild;
        if (lastEl && typeof lastEl.scrollIntoView === 'function') {
          lastEl.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'auto' });
        }
      };

      if (smooth) {
        chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
        programmaticScrollTimer = setTimeout(() => {
          isProgrammaticScroll = false;
        }, 300);
      } else {
        doScroll();
        requestAnimationFrame(doScroll);
        setTimeout(doScroll, 50);
        setTimeout(doScroll, 180);
        programmaticScrollTimer = setTimeout(() => {
          doScroll();
          isProgrammaticScroll = false;
        }, 350);
      }
    }

    function scrollToBottomIfNeeded() {
      if (!chatContainer) return;
      if (!userScrolledUp) {
        isProgrammaticScroll = true;
        if (programmaticScrollTimer) clearTimeout(programmaticScrollTimer);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        programmaticScrollTimer = setTimeout(() => {
          isProgrammaticScroll = false;
        }, 80);
      } else if (scrollUnreadBadge) {
        scrollUnreadBadge.classList.add('has-unread');
      }
    }

    if (chatContainer) {
      chatContainer.addEventListener('wheel', (e) => {
        if (e.deltaY < 0) {
          isProgrammaticScroll = false;
          userScrolledUp = true;
          if (btnScrollBottom) btnScrollBottom.classList.add('visible');
        } else if (e.deltaY > 0) {
          if (isAtBottom(80)) {
            userScrolledUp = false;
            if (btnScrollBottom) {
              btnScrollBottom.classList.remove('visible');
              if (scrollUnreadBadge) scrollUnreadBadge.classList.remove('has-unread');
            }
          }
        }
      }, { passive: true });

      chatContainer.addEventListener('touchmove', () => {
        isProgrammaticScroll = false;
      }, { passive: true });

      chatContainer.addEventListener('pointerdown', () => {
        isProgrammaticScroll = false;
      }, { passive: true });

      chatContainer.addEventListener('load', (e) => {
        if (e.target && e.target.tagName === 'IMG') {
          scrollToBottomIfNeeded();
        }
      }, true);

      chatContainer.addEventListener('scroll', () => {
        if (isProgrammaticScroll) return;
        const atBottom = isAtBottom(80);
        userScrolledUp = !atBottom;
        if (btnScrollBottom) {
          if (userScrolledUp) {
            btnScrollBottom.classList.add('visible');
          } else {
            btnScrollBottom.classList.remove('visible');
            if (scrollUnreadBadge) scrollUnreadBadge.classList.remove('has-unread');
          }
        }
      });
    }

    btnScrollBottom?.addEventListener('click', () => {
      scrollToBottom(true);
    });

    let toolSeqDoneTools = new Set();
    let toolSeqUserToggled = false;
    let toolSeqFinished = false;
    // Per-agent counter so a subagent calling the same tool multiple times renders
    // one item per invocation instead of collapsing into a single line.
    const subToolSeqCounts = {};

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
      const copyBtn = thisSeq.querySelector('.tool-seq-copy');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
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
      }

      const seqWrap = document.createElement('div');
      seqWrap.className = 'tool-sequence-wrap';
      seqWrap.appendChild(thisSeq);

      const mascotPerch = document.createElement('div');
      mascotPerch.className = 'tool-seq-mascot-perch';
      seqWrap.appendChild(mascotPerch);

      if (currentTurnAssistantDiv) {
        currentTurnAssistantDiv.appendChild(seqWrap);
      }

      if (typeof interruptMascotToWork === 'function') {
        interruptMascotToWork();
      }
      if (typeof hopMascotTo === 'function') {
        hopMascotTo(mascotPerch);
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

      // Update live elapsed counter on each active tool card
      currentToolSequence.querySelectorAll('.tool-card[data-start-ts], .activity-row.running[data-start-ts]').forEach(card => {
        const startTs = parseInt(card.getAttribute('data-start-ts') || '0', 10);
        const toolId = card.id ? card.id.replace('tool-', '') : '';
        const elapsedEl = card.querySelector('#elapsed-' + toolId) || card.querySelector('.tool-elapsed');
        if (elapsedEl && startTs > 0) {
          const s = Math.max(0, Math.floor((Date.now() - startTs) / 1000));
          elapsedEl.textContent = s + 's';
        }
      });

      if (toolSeqFinished) {
        el.textContent = label + ' · ' + (elapsed < 1 ? 'complete' : 'worked for ' + elapsed + 's');
      } else if (doneCount > 0 && doneCount >= toolSeqCount) {
        el.textContent = label + ' · all done · waiting for model... (' + elapsed + 's)';
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
          '<span class="slash-cmd">@' + escapeHtml(name) + '</span>' +
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
        case 'trust':
          appendSystemNote('Requesting workspace trust...');
          vscode.postMessage({ type: 'trust_workspace' });
          break;
        case 'untrust':
          appendSystemNote('Revoking workspace trust...');
          vscode.postMessage({ type: 'untrust_workspace' });
          break;
        case 'undo':
          vscode.postMessage({ type: 'undo_turn' });
          break;
        case 'compact':
          showCompactionBanner('Compacting conversation context to reduce token usage...');
          vscode.postMessage({ type: 'compact_session' });
          break;
        case 'new':
          vscode.postMessage({ type: 'new_session' });
          break;
        case 'clear':
          chatContainer.innerHTML = '';
          showZeroState();
          break;
        case 'sessions':
          toggleSessionsFlyout();
          break;
        case 'settings':
          vscode.postMessage({ type: 'open_settings' });
          break;
        case 'about':
          appendAboutCard();
          break;
        case 'personalisation':
        case 'wallpaper':
          vscode.postMessage({ type: 'open_personalisation' });
          break;
        case 'pet':
        case 'companion':
          toggleOrInteractMascot();
          break;
        case 'play':
          mascotZoomies();
          break;
        case 'fetch':
          recallMascotHome(true);
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
          vscode.postMessage({ type: 'open_review_tab' });
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

        // CJK IME composition guard (Postel's Law): do not intercept Enter while user is actively composing characters
        if (e.isComposing || e.keyCode === 229) {
          return;
        }

        // Prompt history navigation (Jakob's Law)
        if (e.key === 'ArrowUp') {
          const isAtStart = promptInput.selectionStart === 0 && promptInput.selectionEnd === 0;
          if (isAtStart && sentPromptsHistory.length > 0 && promptHistoryIndex > 0) {
            e.preventDefault();
            if (promptHistoryIndex === sentPromptsHistory.length) {
              tempPromptDraft = promptInput.value;
            }
            promptHistoryIndex--;
            promptInput.value = sentPromptsHistory[promptHistoryIndex];
            promptInput.style.height = 'auto';
            promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + 'px';
            promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
            if (sendBtn) {
              sendBtn.classList.toggle('has-text', promptInput.value.trim().length > 0);
            }
            return;
          }
        }

        if (e.key === 'ArrowDown') {
          if (promptHistoryIndex < sentPromptsHistory.length) {
            e.preventDefault();
            promptHistoryIndex++;
            if (promptHistoryIndex === sentPromptsHistory.length) {
              promptInput.value = tempPromptDraft;
            } else {
              promptInput.value = sentPromptsHistory[promptHistoryIndex];
            }
            promptInput.style.height = 'auto';
            promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + 'px';
            promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
            if (sendBtn) {
              sendBtn.classList.toggle('has-text', promptInput.value.trim().length > 0);
            }
            return;
          }
        }

        if (e.key === 'Backspace' && promptInput.value === '' && attachedFiles.length > 0) {
          e.preventDefault();
          attachedFiles.pop();
          renderAttachedFiles();
          return;
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
        if (currentSessionId) {
          sessionsState[currentSessionId] = sessionsState[currentSessionId] || {};
          sessionsState[currentSessionId].draftInput = val;
        }
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
        vscode.postMessage({ type: 'cancel_turn', sessionId: currentSessionId });
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

    const sessionPickerBtn = document.getElementById('btn-session-picker');
    if (sessionPickerBtn) {
      sessionPickerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSessionsFlyout();
      });
      sessionPickerBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          toggleSessionsFlyout();
        }
      });
    }

    sessionsSearch?.addEventListener('input', (e) => {
      sessionDisplayLimit = 10;
      filterAndRenderSessions(e.target.value);
    });

    document.getElementById('btn-sessions-new')?.addEventListener('click', () => {
      sessionsFlyout.style.display = 'none';
      vscode.postMessage({ type: 'new_session' });
    });

    document.getElementById('btn-top-crons')?.addEventListener('click', () => {
      toggleCronsFlyout();
    });

    document.getElementById('btn-crons-manage')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'open_cron_settings' });
      if (cronsFlyout) cronsFlyout.style.display = 'none';
    });

    if (cronsListEl) {
      cronsListEl.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-cron-action]');
        if (!btn) return;
        const action = btn.dataset.cronAction;
        if (action === 'create') {
          vscode.postMessage({ type: 'open_cron_settings' });
          if (cronsFlyout) cronsFlyout.style.display = 'none';
          return;
        }
        const id = btn.dataset.id;
        const name = btn.dataset.name || '';
        if (action === 'run') {
          btn.disabled = true;
          btn.innerHTML = '<span>⟳ Running...</span>';
          vscode.postMessage({ type: 'cron_run_now', id, name });
          setTimeout(() => { if (btn) { btn.disabled = false; btn.innerHTML = '▶ Run'; } }, 4000);
        } else if (action === 'toggle') {
          vscode.postMessage({ type: 'cron_toggle', id });
        }
      });
    }

    document.getElementById('btn-crons-close')?.addEventListener('click', () => {
      cronsFlyout.style.display = 'none';
    });

    document.getElementById('btn-slash-close')?.addEventListener('click', () => {
      hideSlashPalette();
    });

    document.getElementById('btn-mention-close')?.addEventListener('click', () => {
      hideMentionPalette();
    });

    document.getElementById('btn-tracker-open')?.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'open_plan_tab' });
    });

    document.getElementById('tracker-header-row')?.addEventListener('click', (e) => {
      if (e.target && (e.target.closest('#btn-tracker-open') || e.target.closest('#btn-tracker-close'))) {
        return;
      }
      planTrackerStrip?.classList.toggle('collapsed');
    });

    document.getElementById('btn-tracker-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (planTrackerStrip) planTrackerStrip.style.display = 'none';
    });

    // ─── Mascot Companion Controller ("Andro-Pet") ─────────────────────────────
    const chatMascotEl = document.getElementById('chat-mascot');
    const mascotBubbleEl = document.getElementById('mascot-bubble');
    let mascotBubbleTimer = null;
    let mascotIdleTimer = null;
    let mascotTypingTimer = null;
    let isMascotOnTurn = false;
    let mascotTargetWrap = null;

    function getMascotEnabled() {
      try {
        return localStorage.getItem('andromity_mascot_enabled') !== 'false';
      } catch {
        return true;
      }
    }

    function setMascotEnabled(enabled) {
      try {
        localStorage.setItem('andromity_mascot_enabled', enabled ? 'true' : 'false');
      } catch {}
      if (chatMascotEl) {
        if (enabled) {
          chatMascotEl.classList.remove('hidden');
        } else {
          chatMascotEl.classList.add('hidden');
          if (typeof recallMascotHome === 'function') recallMascotHome(false);
          if (typeof releaseAllMascotParticles === 'function') releaseAllMascotParticles();
          chatMascotEl.classList.remove('is-sleeping', 'is-peeking', 'is-petted', 'is-jumping', 'is-walking', 'is-working', 'is-celebrating', 'is-grabbed', 'is-dragging', 'is-flying', 'is-landing', 'is-crouch', 'is-dizzy', 'is-zooming', 'is-resting');
          if (mascotBubbleEl) {
            mascotBubbleEl.style.display = 'none';
          }
          if (mascotBubbleTimer) {
            clearTimeout(mascotBubbleTimer);
            mascotBubbleTimer = null;
          }
          const homeSlot = document.getElementById('chat-mascot-home-slot');
          if (homeSlot && chatMascotEl.parentElement !== homeSlot) {
            homeSlot.appendChild(chatMascotEl);
          }
          isMascotRoaming = false;
          isMascotOnTurn = false;
        }
      }
    }

    function toggleOrInteractMascot(forceState) {
      if (!chatMascotEl) return;
      const isCurrentlyHidden = chatMascotEl.classList.contains('hidden');
      const newState = typeof forceState === 'boolean' ? forceState : isCurrentlyHidden;
      setMascotEnabled(newState);
      vscode.postMessage({ type: 'update_mascot_setting', enabled: newState });
      if (newState) {
        showMascotBubble('👋 Hello!', 2000);
        petMascot();
      }
    }

    function showMascotBubble(text, durationMs) {
      if (!chatMascotEl || !mascotBubbleEl || chatMascotEl.classList.contains('hidden')) return;
      durationMs = durationMs || 2200;
      if (mascotBubbleTimer) {
        clearTimeout(mascotBubbleTimer);
        mascotBubbleTimer = null;
      }
      mascotBubbleEl.textContent = text;
      mascotBubbleEl.style.display = 'flex';
      mascotBubbleTimer = setTimeout(() => {
        if (mascotBubbleEl) mascotBubbleEl.style.display = 'none';
        mascotBubbleTimer = null;
      }, durationMs);
    }

    function petMascot() {
      if (!chatMascotEl || chatMascotEl.classList.contains('hidden')) return;
      try {
        vscode.postMessage({ type: 'telemetry_feature', feature: 'mascot_petted' });
      } catch (e) {}
      lastMascotActivityTime = Date.now();
      const wasSleeping = chatMascotEl.classList.contains('is-sleeping');
      const wasPeeking = chatMascotEl.classList.contains('is-peeking');
      chatMascotEl.classList.remove('is-sleeping', 'is-peeking', 'is-petted', 'is-jumping');
      void chatMascotEl.offsetWidth; // trigger reflow
      chatMascotEl.classList.add('is-petted');
      
      if (wasSleeping) {
        showMascotBubble('! ^o^', 2000);
      } else if (wasPeeking) {
        showMascotBubble('👋 Heehee!', 2000);
      } else {
        const reactions = ['❤️', '✨', '⚡', '^o^', '👀', '🤖', '👾'];
        const pick = reactions[Math.floor(Math.random() * reactions.length)];
        showMascotBubble(pick, 1800);
      }
      
      if (isMascotFreeFloating()) {
        // Petting a landed pet keeps it playing where it is and resets its return timer.
        cancelMascotHomeTimer();
        scheduleMascotReturnHome();
        const petRect = chatMascotEl.getBoundingClientRect();
        spawnMascotParticles('heart', petRect.left + 16, petRect.top, 4);
      }

      setTimeout(() => {
        chatMascotEl?.classList.remove('is-petted');
      }, 500);
    }

    let lastMascotActivityTime = Date.now();
    let mascotRoamStep = 0;
    let isMascotRoaming = false;

    function interruptMascotToWork() {
      lastMascotActivityTime = Date.now();
      if (!chatMascotEl || chatMascotEl.classList.contains('hidden')) return;
      if (isMascotFreeFloating()) {
        if (mascotPlayState === 'grabbed' || mascotPlayState === 'dragging') return;
        recallMascotHome(false);
        return;
      }
      chatMascotEl.classList.remove('is-sleeping', 'is-peeking', 'is-walking');
      const homeSlot = document.getElementById('chat-mascot-home-slot');
      if (isMascotRoaming && chatMascotEl.parentElement !== homeSlot && !isMascotOnTurn) {
        isMascotRoaming = false;
        returnMascotHome();
      } else {
        isMascotRoaming = false;
      }
    }

    function hopMascotTo(targetPerchEl) {
      if (!chatMascotEl || chatMascotEl.classList.contains('hidden') || !targetPerchEl) return;
      if (chatMascotEl.parentElement === targetPerchEl) return;
      if (mascotPlayState === 'grabbed' || mascotPlayState === 'dragging') return;

      const fromPlayground = isMascotFreeFloating();
      if (fromPlayground) {
        stopMascotPhysics();
        cancelMascotHomeTimer();
        mascotPlayState = 'idle';
        mascotVel = { x: 0, y: 0 };
        mascotMoveSamples = [];
        chatMascotEl.classList.remove('is-flying', 'is-resting', 'is-dizzy', 'is-zooming', 'is-crouch', 'is-landing');
      }

      const firstRect = chatMascotEl.getBoundingClientRect();
      targetPerchEl.appendChild(chatMascotEl);
      chatMascotEl.style.transition = 'none';
      chatMascotEl.style.transform = 'none';
      if (fromPlayground) {
        // Free-play coordinates belong to the fixed layer: drop them once docked again.
        chatMascotEl.style.left = '';
        chatMascotEl.style.top = '';
      }
      const lastRect = chatMascotEl.getBoundingClientRect();

      const deltaX = firstRect.left - lastRect.left;
      const deltaY = firstRect.top - lastRect.top;

      chatMascotEl.classList.remove('is-walking', 'looking-down');
      chatMascotEl.classList.add('is-jumping', 'is-working');
      chatMascotEl.style.transition = 'none';
      chatMascotEl.style.transform = 'translate3d(' + Math.round(deltaX) + 'px, ' + Math.round(deltaY) + 'px, 0)';

      void chatMascotEl.offsetWidth; // Force reflow

      chatMascotEl.style.transition = 'transform 0.45s cubic-bezier(0.34, 1.25, 0.64, 1)';
      chatMascotEl.style.transform = 'translate3d(0, 0, 0)';

      setTimeout(() => {
        if (chatMascotEl) {
          chatMascotEl.classList.remove('is-jumping');
          // A grab, throw or free-play rest may have taken over mid-hop: never clobber it.
          if (mascotPlayState === 'idle') {
            chatMascotEl.style.transition = '';
            chatMascotEl.style.transform = '';
          }
          const homeSlot = document.getElementById('chat-mascot-home-slot');
          isMascotOnTurn = (chatMascotEl.parentElement !== homeSlot);
          if (!isMascotOnTurn) {
            chatMascotEl.classList.remove('is-working', 'on-turn');
          } else {
            chatMascotEl.classList.add('on-turn');
          }
        }
      }, 460);
    }

    function returnMascotHome() {
      const homeSlot = document.getElementById('chat-mascot-home-slot');
      if (!homeSlot || !chatMascotEl) return;
      hopMascotTo(homeSlot);
    }

    function hopMascotToTurn(wrapEl) {
      if (!wrapEl) return;
      const perch = wrapEl.querySelector('.tool-seq-mascot-perch') || wrapEl.querySelector('.assistant-mascot-perch');
      if (perch) {
        hopMascotTo(perch);
      }
    }

    function celebrateMascot() {
      if (!chatMascotEl || chatMascotEl.classList.contains('hidden')) return;
      chatMascotEl.classList.remove('is-working');
      chatMascotEl.classList.add('is-celebrating');
      showMascotBubble('✨ Done!', 2000);
      
      setTimeout(() => {
        chatMascotEl?.classList.remove('is-celebrating');
        returnMascotHome();
      }, 850);
    }

    function runMascotIdleRoam() {
      // Free-play physics owns the pet: never roam or nap while it is airborne, held or resting away.
      if (mascotPlayState === 'grabbed' || mascotPlayState === 'dragging' || mascotPlayState === 'flying') return;
      if (isMascotFreeFloating()) return;
      const homeSlot = document.getElementById('chat-mascot-home-slot');
      if (!chatMascotEl || isRunning || isMascotOnTurn || chatMascotEl.classList.contains('hidden')) {
        return;
      }

      const idleSeconds = (Date.now() - lastMascotActivityTime) / 1000;
      
      // Catnap if inactive for over 70s
      if (idleSeconds > 70 && !chatMascotEl.classList.contains('is-sleeping')) {
        chatMascotEl.classList.add('is-sleeping');
        showMascotBubble('💤', 2500);
        return;
      }
      if (chatMascotEl.classList.contains('is-sleeping')) {
        return;
      }

      // If mascot was out roaming on an exploration perch, hop back home
      if (isMascotRoaming && chatMascotEl.parentElement !== homeSlot) {
        isMascotRoaming = false;
        chatMascotEl.classList.remove('is-peeking');
        returnMascotHome();
        return;
      }

      mascotRoamStep = (mascotRoamStep + 1) % 4;
      const profilePerch = document.getElementById('profile-mascot-perch');
      const edgePerch = document.getElementById('edge-mascot-perch');
      const topPerch = document.getElementById('top-header-mascot-perch');

      if (mascotRoamStep === 1 && profilePerch) {
        // 1. Visit BUILDER profile pill
        isMascotRoaming = true;
        hopMascotTo(profilePerch);
        showMascotBubble('🛠️', 1800);
        setTimeout(() => {
          if (!isRunning && !isMascotOnTurn && isMascotRoaming) {
            isMascotRoaming = false;
            returnMascotHome();
          }
        }, 3000);
      } else if (mascotRoamStep === 2 && edgePerch) {
        // 2. Peek playfully from screen edge
        isMascotRoaming = true;
        hopMascotTo(edgePerch);
        chatMascotEl.classList.add('is-peeking');
        showMascotBubble('👀', 2000);
        setTimeout(() => {
          if (!isRunning && !isMascotOnTurn && isMascotRoaming) {
            isMascotRoaming = false;
            chatMascotEl.classList.remove('is-peeking');
            returnMascotHome();
          }
        }, 3200);
      } else if (mascotRoamStep === 3 && topPerch) {
        // 3. Jump to top view header
        isMascotRoaming = true;
        hopMascotTo(topPerch);
        showMascotBubble('✨', 1800);
        setTimeout(() => {
          if (!isRunning && !isMascotOnTurn && isMascotRoaming) {
            isMascotRoaming = false;
            returnMascotHome();
          }
        }, 3000);
      } else {
        // 0. Prompt ledge patrol
        const randomOffset = Math.floor(Math.random() * 25) + 12; // 12px to 37px
        chatMascotEl.classList.add('is-walking');
        chatMascotEl.style.transition = 'transform 0.35s ease';
        chatMascotEl.style.transform = 'translate3d(' + randomOffset + 'px, 0, 0)';
        
        setTimeout(() => {
          chatMascotEl?.classList.remove('is-walking');
          setTimeout(() => {
            if (!isRunning && !isMascotOnTurn && chatMascotEl && (!homeSlot || chatMascotEl.parentElement === homeSlot)) {
              chatMascotEl.classList.add('is-walking');
              chatMascotEl.style.transform = 'translate3d(0, 0, 0)';
              setTimeout(() => {
                chatMascotEl?.classList.remove('is-walking');
                chatMascotEl.style.transition = '';
              }, 350);
            }
          }, 1800);
        }, 350);
      }
    }

    function initChatMascot() {
      if (!chatMascotEl) return;
      if (!getMascotEnabled()) {
        chatMascotEl.classList.add('hidden');
      } else {
        chatMascotEl.classList.remove('hidden');
      }

      attachMascotPlayPhysics();

      if (promptInput) {
        promptInput.addEventListener('focus', interruptMascotToWork);
        promptInput.addEventListener('input', () => {
          interruptMascotToWork();
          if (isMascotOnTurn || isRunning || chatMascotEl.classList.contains('hidden')) return;
          chatMascotEl.classList.add('looking-down');
          if (mascotTypingTimer) clearTimeout(mascotTypingTimer);
          mascotTypingTimer = setTimeout(() => {
            chatMascotEl?.classList.remove('looking-down');
          }, 1500);
        });
      }

      if (mascotIdleTimer) clearInterval(mascotIdleTimer);
      mascotIdleTimer = setInterval(runMascotIdleRoam, 16000);
    }

    // ─── Playful Drag, Throw, Bounce & Jump Physics ("Andro-Pet Playground") ───
    const MASCOT_SIZE = 32;
    const MASCOT_PHYSICS = {
      gravity: 1550,
      bounce: 0.38,
      wallBounce: 0.65,
      ceilingBounce: 0.40,
      airDrag: 0.12,
      groundFriction: 0.88,
      stopSpeed: 28,
      throwScale: 1.0,
      maxSpeed: 1350,
      jumpImpulse: 820,
      grabThreshold: 4,
      dizzySpeed: 850,
      restHoldMs: 30000,
      maxParticles: 24
    };
    const MASCOT_LAYER = document.getElementById('mascot-drag-layer');
    let mascotPlayState = 'idle';
    let mascotPointerId = null;
    let mascotGrabOrigin = null;
    let mascotGrabOffset = { x: MASCOT_SIZE / 2, y: MASCOT_SIZE / 2 };
    let mascotPointerAt = { x: 0, y: 0 };
    let mascotPos = { x: 0, y: 0 };
    let mascotVel = { x: 0, y: 0 };
    let mascotMoveSamples = [];
    let mascotRafId = null;
    let mascotLastFrameTs = 0;
    let mascotHomeTimer = null;
    let mascotLean = 0;
    let mascotDragRafId = null;
    let mascotPendingPointer = null;
    let mascotDragField = null;
    let mascotLastSparkleAt = 0;
    let mascotBounceCount = 0;
    let mascotLedgeRoamTimer = null;
    let mascotLedgeStepTimer = null;
    let mascotJumpTimer = null;
    let lastMascotTapTime = 0;
    const mascotParticles = [];
    let mascotFieldCache = null;
    let mascotFieldStamp = 0;

    function prefersReducedMotion() {
      try {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch (err) {
        return false;
      }
    }

    function pickMascotRandom(list) {
      return list[Math.floor(Math.random() * list.length)];
    }

    // The playable world: viewport walls, top bar ceiling, and the input card ledge as ground.
    function getMascotPlayField() {
      const now = Date.now();
      if (mascotFieldCache && (now - mascotFieldStamp) < 250) return mascotFieldCache;
      const vw = window.innerWidth || document.documentElement.clientWidth || 400;
      const vh = window.innerHeight || document.documentElement.clientHeight || 600;

      let ceilingY = 6;
      const topBar = document.querySelector('.top-bar');
      if (topBar) {
        const topRect = topBar.getBoundingClientRect();
        if (topRect.height > 0) ceilingY = Math.round(topRect.bottom) + 2;
      }

      let groundY = vh - MASCOT_SIZE;
      const inputSection = document.querySelector('.input-section');
      if (inputSection) {
        const inputRect = inputSection.getBoundingClientRect();
        if (inputRect.height > 0 && inputRect.top > ceilingY + MASCOT_SIZE) {
          groundY = Math.round(inputRect.top) - MASCOT_SIZE;
        }
      }

      mascotFieldCache = {
        width: vw,
        height: vh,
        minX: 0,
        maxX: Math.max(0, vw - MASCOT_SIZE),
        ceilingY: ceilingY,
        groundY: Math.max(ceilingY + MASCOT_SIZE, groundY)
      };
      mascotFieldStamp = now;
      return mascotFieldCache;
    }

    function isMascotFreeFloating() {
      return !!(chatMascotEl && MASCOT_LAYER && chatMascotEl.parentElement === MASCOT_LAYER);
    }

    // Sub-pixel friendly formatting: rounding every frame quantises slow drags into visible 1px steps.
    function formatMascotPx(value) {
      return (Math.round(value * 100) / 100) + 'px';
    }

    // Smooth the body lean so the sprite hangs behind the motion instead of snapping per event.
    function updateMascotLean(target) {
      const clamped = Math.max(-20, Math.min(20, target));
      mascotLean += (clamped - mascotLean) * 0.28;
      if (Math.abs(mascotLean) < 0.05) mascotLean = 0;
    }

    function paintMascotFrame() {
      if (!chatMascotEl) return;
      let angle = 0;
      if (!prefersReducedMotion() && (mascotPlayState === 'flying' || mascotPlayState === 'dragging')) {
        angle = mascotLean;
      }
      const spin = angle ? ' rotate(' + angle.toFixed(2) + 'deg)' : '';
      chatMascotEl.style.transform =
        'translate3d(' + formatMascotPx(mascotPos.x) + ', ' + formatMascotPx(mascotPos.y) + ', 0)' + spin;
    }

    function parkMascotInLayer(x, y) {
      if (!chatMascotEl || !MASCOT_LAYER) return false;
      if (chatMascotEl.parentElement !== MASCOT_LAYER) MASCOT_LAYER.appendChild(chatMascotEl);
      // Playground motion must track the pointer 1:1: never inherit a dock/patrol easing transition.
      chatMascotEl.style.transition = 'none';
      mascotPos.x = x;
      mascotPos.y = y;
      paintMascotFrame();
      return true;
    }

    function cancelMascotDragFrame() {
      mascotPendingPointer = null;
      if (mascotDragRafId !== null) {
        cancelAnimationFrame(mascotDragRafId);
        mascotDragRafId = null;
      }
    }

    // Coalesces high-frequency pointer events into exactly one paint per frame.
    function commitMascotDragPaint() {
      mascotDragRafId = null;
      const pointer = mascotPendingPointer;
      mascotPendingPointer = null;
      if (!pointer || !chatMascotEl || mascotPlayState !== 'dragging') return;

      const field = mascotDragField || getMascotPlayField();
      const nx = pointer.x - mascotGrabOffset.x;
      const ny = pointer.y - mascotGrabOffset.y;
      mascotPos.x = Math.max(field.minX, Math.min(field.maxX, nx));
      mascotPos.y = Math.max(field.ceilingY, Math.min(field.groundY + 12, ny));

      const now = Date.now();
      mascotMoveSamples.push({ x: pointer.x, y: pointer.y, t: now });
      while (mascotMoveSamples.length > 8 || (mascotMoveSamples.length > 1 && (now - mascotMoveSamples[0].t) > 150)) {
        mascotMoveSamples.shift();
      }

      // Time-normalised velocity (px/s) keeps the lean identical at any pointer polling rate.
      const travel = computeMascotThrowVelocity();
      updateMascotLean(travel.x * 0.007);
      paintMascotFrame();

      if ((Math.abs(travel.x) + Math.abs(travel.y)) > 260 && (now - mascotLastSparkleAt) > 75) {
        mascotLastSparkleAt = now;
        spawnMascotParticles('sparkle', mascotPos.x + MASCOT_SIZE / 2, mascotPos.y + MASCOT_SIZE - 4, 1);
      }
    }

    function clearMascotFreeStyles() {
      if (!chatMascotEl) return;
      chatMascotEl.style.left = '';
      chatMascotEl.style.top = '';
      chatMascotEl.style.transform = '';
      chatMascotEl.style.transition = '';
    }

    function flashMascotClass(cls, ms) {
      if (!chatMascotEl) return;
      chatMascotEl.classList.add(cls);
      setTimeout(() => {
        if (chatMascotEl) chatMascotEl.classList.remove(cls);
      }, ms);
    }

    function acquireMascotParticle(kind) {
      if (!MASCOT_LAYER) return null;
      for (let i = 0; i < mascotParticles.length; i++) {
        const pooled = mascotParticles[i];
        if (pooled.__mascotFree) {
          pooled.__mascotFree = false;
          pooled.__mascotKind = kind;
          pooled.className = 'mascot-particle ' + kind;
          return pooled;
        }
      }
      if (mascotParticles.length >= MASCOT_PHYSICS.maxParticles) return null;
      const node = document.createElement('div');
      node.className = 'mascot-particle ' + kind;
      node.setAttribute('aria-hidden', 'true');
      node.__mascotKind = kind;
      node.__mascotFree = false;
      MASCOT_LAYER.appendChild(node);
      mascotParticles.push(node);
      return node;
    }

    function releaseMascotParticle(node) {
      if (!node || node.__mascotFree) return;
      node.__mascotFree = true;
      node.__mascotKind = '';
      node.className = 'mascot-particle';
    }

    function releaseAllMascotParticles() {
      for (let i = 0; i < mascotParticles.length; i++) releaseMascotParticle(mascotParticles[i]);
    }

    // Pooled reaction particles: reusing nodes keeps the drag path completely free of DOM churn.
    function spawnMascotParticles(kind, x, y, count) {
      if (!MASCOT_LAYER || prefersReducedMotion()) return;
      const total = Math.max(1, Math.min(6, count || 3));
      for (let i = 0; i < total; i++) {
        const node = acquireMascotParticle(kind);
        if (!node) break;
        node.style.left = Math.round(x) + 'px';
        node.style.top = Math.round(y) + 'px';
        node.style.setProperty('--px', Math.round((Math.random() - 0.5) * 34) + 'px');
        node.style.setProperty('--py', Math.round(-6 - Math.random() * 16) + 'px');
        // Guaranteed release even if animationend never fires (e.g. animations disabled).
        setTimeout(() => releaseMascotParticle(node), 1200);
      }
    }

    function stopMascotPhysics() {
      if (mascotRafId !== null) {
        cancelAnimationFrame(mascotRafId);
        mascotRafId = null;
      }
      mascotLastFrameTs = 0;
    }

    function cancelMascotHomeTimer() {
      if (mascotHomeTimer) {
        clearTimeout(mascotHomeTimer);
        mascotHomeTimer = null;
      }
    }

    function scheduleMascotReturnHome() {
      cancelMascotHomeTimer();
      mascotHomeTimer = setTimeout(() => {
        mascotHomeTimer = null;
        recallMascotHome(true);
      }, MASCOT_PHYSICS.restHoldMs);
    }

    // Window listeners ensure the pet NEVER loses track of the cursor during fast movements.
    function onWindowMascotMove(e) {
      updateMascotGrab(e);
    }
    function onWindowMascotUp(e) {
      endMascotGrab(e);
    }
    function onWindowMascotCancel() {
      cancelMascotGrab();
    }

    function detachWindowMascotListeners() {
      window.removeEventListener('pointermove', onWindowMascotMove);
      window.removeEventListener('pointerup', onWindowMascotUp);
      window.removeEventListener('pointercancel', onWindowMascotCancel);
    }

    function beginMascotGrab(e) {
      if (!chatMascotEl || chatMascotEl.classList.contains('hidden')) return;
      if (typeof e.button === 'number' && e.button !== 0) return;
      if (mascotPlayState === 'grabbed' || mascotPlayState === 'dragging') return;

      const rect = chatMascotEl.getBoundingClientRect();
      mascotPointerId = e.pointerId;
      try { chatMascotEl.setPointerCapture(e.pointerId); } catch (err) {}
      stopMascotPhysics();
      cancelMascotHomeTimer();
      cancelMascotDragFrame();
      stopLedgeRoam();
      if (mascotJumpTimer) {
        clearTimeout(mascotJumpTimer);
        mascotJumpTimer = null;
      }
      lastMascotActivityTime = Date.now();
      chatMascotEl.style.transition = 'none';
      mascotDragField = null;
      mascotLean = 0;
      mascotLastSparkleAt = 0;
      mascotBounceCount = 0;
      mascotGrabOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      mascotPointerAt = { x: e.clientX, y: e.clientY };
      mascotPos = { x: rect.left, y: rect.top };
      mascotVel = { x: 0, y: 0 };
      mascotMoveSamples = [{ x: e.clientX, y: e.clientY, t: Date.now() }];
      mascotGrabOrigin = { x: rect.left, y: rect.top, parent: chatMascotEl.parentElement };
      mascotPlayState = 'grabbed';
      chatMascotEl.classList.remove('is-flying', 'is-falling', 'is-bouncing', 'is-resting', 'is-sleeping', 'is-peeking', 'is-walking', 'is-dizzy', 'is-zooming', 'is-crouch', 'is-celebrating', 'is-petted', 'is-jumping', 'is-landing');
      chatMascotEl.classList.add('is-grabbed');

      window.addEventListener('pointermove', onWindowMascotMove, { passive: false });
      window.addEventListener('pointerup', onWindowMascotUp);
      window.addEventListener('pointercancel', onWindowMascotCancel);

      if (e.cancelable && e.preventDefault) e.preventDefault();
    }

    function updateMascotGrab(e) {
      if (!chatMascotEl || mascotPointerId === null || e.pointerId !== mascotPointerId) return;
      if (mascotPlayState !== 'grabbed' && mascotPlayState !== 'dragging') return;

      if (mascotPlayState === 'grabbed') {
        const travel = Math.hypot(e.clientX - mascotPointerAt.x, e.clientY - mascotPointerAt.y);
        if (travel < MASCOT_PHYSICS.grabThreshold) return;
        if (!parkMascotInLayer(mascotPos.x, mascotPos.y)) return;
        try { chatMascotEl.setPointerCapture(mascotPointerId); } catch (err) {}
        mascotPlayState = 'dragging';
        mascotDragField = getMascotPlayField();
        mascotMoveSamples = [{ x: e.clientX, y: e.clientY, t: Date.now() }];
        chatMascotEl.classList.remove('is-grabbed', 'is-sleeping', 'is-peeking', 'is-resting');
        chatMascotEl.classList.add('is-dragging');
      }

      if (e.cancelable && e.preventDefault) e.preventDefault();

      // Record the sample and paint once per animation frame instead of once per pointer event.
      mascotPointerAt = { x: e.clientX, y: e.clientY };
      mascotPendingPointer = { x: e.clientX, y: e.clientY };
      if (mascotDragRafId === null) mascotDragRafId = requestAnimationFrame(commitMascotDragPaint);
    }

    function endMascotGrab(e) {
      if (mascotPointerId === null) return;
      if (e && typeof e.pointerId === 'number' && e.pointerId !== mascotPointerId) return;
      if (chatMascotEl) {
        try { chatMascotEl.releasePointerCapture(mascotPointerId); } catch (err) {}
      }
      detachWindowMascotListeners();
      mascotPointerId = null;
      if (!chatMascotEl) return;

      // Commit the final pointer sample so the throw matches the last on-screen position.
      if (mascotPendingPointer && mascotPlayState === 'dragging') {
        if (mascotDragRafId !== null) {
          cancelAnimationFrame(mascotDragRafId);
          mascotDragRafId = null;
        }
        commitMascotDragPaint();
      } else {
        cancelMascotDragFrame();
      }
      mascotDragField = null;

      const wasDragging = mascotPlayState === 'dragging';
      chatMascotEl.classList.remove('is-grabbed', 'is-dragging');
      if (!wasDragging) {
        const now = Date.now();
        if (now - lastMascotTapTime < 340) {
          lastMascotTapTime = 0;
          mascotJump();
          return;
        }
        lastMascotTapTime = now;
        if (isMascotFreeFloating()) {
          mascotPlayState = 'resting';
          chatMascotEl.classList.add('is-resting');
          paintMascotFrame();
          scheduleMascotReturnHome();
        } else {
          mascotPlayState = 'idle';
        }
        petMascot();
        return;
      }
      lastMascotTapTime = 0;
      throwMascot();
    }

    function cancelMascotGrab() {
      if (chatMascotEl && mascotPointerId !== null) {
        try { chatMascotEl.releasePointerCapture(mascotPointerId); } catch (err) {}
      }
      detachWindowMascotListeners();
      stopLedgeRoam();
      if (mascotJumpTimer) {
        clearTimeout(mascotJumpTimer);
        mascotJumpTimer = null;
      }
      if (mascotPlayState !== 'grabbed' && mascotPlayState !== 'dragging') return;
      const wasDragging = mascotPlayState === 'dragging';
      cancelMascotDragFrame();
      mascotDragField = null;
      mascotPointerId = null;
      if (!chatMascotEl) return;
      chatMascotEl.classList.remove('is-grabbed', 'is-dragging');

      const origin = mascotGrabOrigin;
      mascotGrabOrigin = null;
      const originParent = origin && origin.parent;
      if (wasDragging && originParent && originParent !== MASCOT_LAYER && originParent.parentNode) {
        mascotPlayState = 'idle';
        hopMascotTo(originParent);
        return;
      }
      if (wasDragging) {
        mascotPlayState = 'resting';
        chatMascotEl.classList.add('is-resting');
        paintMascotFrame();
        scheduleMascotReturnHome();
        startLedgeRoam();
        return;
      }
      mascotPlayState = 'idle';
    }

    function computeMascotThrowVelocity() {
      const samples = mascotMoveSamples;
      if (!samples.length) return { x: 0, y: 0 };
      const now = Date.now();
      const last = samples[samples.length - 1];

      if (now - last.t > 80) {
        return { x: 0, y: 0 };
      }

      let first = samples[0];
      for (let i = 0; i < samples.length; i++) {
        if (last.t - samples[i].t <= 120) {
          first = samples[i];
          break;
        }
      }
      const dt = Math.max(16, last.t - first.t) / 1000;
      return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
    }

    function throwMascot() {
      if (!chatMascotEl) return;
      try {
        vscode.postMessage({ type: 'telemetry_feature', feature: 'mascot_tossed' });
      } catch (e) {}
      const launch = computeMascotThrowVelocity();
      mascotMoveSamples = [];
      mascotBounceCount = 0;
      const speed = Math.hypot(launch.x, launch.y);
      const isGentleAirDrop = speed < 80;

      if (prefersReducedMotion()) {
        const field = getMascotPlayField();
        mascotPos.y = field.groundY;
        finishMascotRest();
        return;
      }

      if (isGentleAirDrop) {
        mascotVel.x = 0;
        mascotVel.y = 40;
        mascotPlayState = 'flying';
        chatMascotEl.classList.add('is-flying', 'is-falling');
        showMascotBubble(pickMascotRandom(['Wheee!', 'Whoa!', 'Down we go!', 'Catch me! ✨']), 1100);
        startMascotPhysics();
        return;
      }

      let vx = launch.x * MASCOT_PHYSICS.throwScale;
      let vy = launch.y * MASCOT_PHYSICS.throwScale;
      const throwSpeed = Math.hypot(vx, vy);
      if (throwSpeed > MASCOT_PHYSICS.maxSpeed) {
        const clamp = MASCOT_PHYSICS.maxSpeed / throwSpeed;
        vx *= clamp;
        vy *= clamp;
      }
      mascotVel.x = vx;
      mascotVel.y = vy;

      mascotPlayState = 'flying';
      chatMascotEl.classList.add('is-flying');
      if (throwSpeed > 600) {
        showMascotBubble(pickMascotRandom(['Wheee!!', 'Woohoo!', 'Nyoom!', 'Boing!']), 1200);
      }
      startMascotPhysics();
    }

    function startMascotPhysics() {
      if (mascotRafId !== null) return;
      mascotLastFrameTs = 0;
      mascotRafId = requestAnimationFrame(mascotPhysicsStep);
    }

    function mascotPhysicsStep(ts) {
      mascotRafId = null;
      if (!chatMascotEl || mascotPlayState !== 'flying') return;
      if (!mascotLastFrameTs) mascotLastFrameTs = ts;
      let dt = (ts - mascotLastFrameTs) / 1000;
      mascotLastFrameTs = ts;
      if (!(dt > 0)) dt = 1 / 60;
      if (dt > 0.032) dt = 0.032;

      const p = MASCOT_PHYSICS;
      const field = getMascotPlayField();
      const airDamp = Math.pow(Math.max(0.001, 1 - p.airDrag), dt * 60);
      mascotVel.x *= airDamp;
      mascotVel.y += p.gravity * dt;
      mascotPos.x += mascotVel.x * dt;
      mascotPos.y += mascotVel.y * dt;

      let hitGround = false;
      let impactVy = 0;

      if (mascotPos.x <= field.minX) {
        mascotPos.x = field.minX;
        mascotVel.x = Math.abs(mascotVel.x) * p.wallBounce;
        spawnMascotParticles('sparkle', field.minX + 4, mascotPos.y + MASCOT_SIZE / 2, 2);
      } else if (mascotPos.x >= field.maxX) {
        mascotPos.x = field.maxX;
        mascotVel.x = -Math.abs(mascotVel.x) * p.wallBounce;
        spawnMascotParticles('sparkle', field.maxX + MASCOT_SIZE - 4, mascotPos.y + MASCOT_SIZE / 2, 2);
      }

      if (mascotPos.y <= field.ceilingY) {
        mascotPos.y = field.ceilingY;
        mascotVel.y = Math.abs(mascotVel.y) * p.ceilingBounce;
      }

      if (mascotPos.y >= field.groundY) {
        mascotPos.y = field.groundY;
        hitGround = true;
        impactVy = mascotVel.y;

        if (mascotVel.y > 0) {
          mascotBounceCount++;
          if (mascotBounceCount >= 2 || mascotVel.y < 130) {
            mascotVel.y = 0;
          } else {
            mascotVel.y = -mascotVel.y * p.bounce;
          }
        }

        mascotVel.x *= Math.pow(p.groundFriction, dt * 60);
        if (Math.abs(mascotVel.x) < 14) mascotVel.x = 0;
      }

      updateMascotLean(mascotVel.x * 0.009);

      if (hitGround && impactVy > 110) {
        onMascotBounceImpact(impactVy, mascotBounceCount);
      }

      paintMascotFrame();

      const speed = Math.hypot(mascotVel.x, mascotVel.y);
      if (hitGround && mascotVel.y === 0 && speed < p.stopSpeed) {
        finishMascotRest();
        return;
      }

      mascotRafId = requestAnimationFrame(mascotPhysicsStep);
    }

    function onMascotBounceImpact(impactVy, bounceNum) {
      if (!chatMascotEl || prefersReducedMotion()) return;
      const centerX = mascotPos.x + MASCOT_SIZE / 2;
      const feetY = mascotPos.y + MASCOT_SIZE - 2;

      chatMascotEl.classList.remove('is-falling');

      if (bounceNum === 1) {
        flashMascotClass('is-landing', 220);
        spawnMascotParticles('dust', centerX, feetY, impactVy > 600 ? 4 : 2);
        showMascotBubble(pickMascotRandom(['Boing!', 'Ta-da!', 'Oof! 😄', 'Bounce!', 'Hehe!']), 900);
      }

      if (impactVy > MASCOT_PHYSICS.dizzySpeed) {
        spawnMascotParticles('star', centerX, mascotPos.y, 4);
        flashMascotClass('is-dizzy', 1400);
        showMascotBubble('😵 Whoa...', 1200);
      }
    }

    function finishMascotRest() {
      stopMascotPhysics();
      if (!chatMascotEl) return;
      cancelMascotDragFrame();
      mascotVel = { x: 0, y: 0 };
      mascotLean = 0;
      mascotBounceCount = 0;
      chatMascotEl.classList.remove('is-flying', 'is-falling', 'is-bouncing', 'is-dizzy', 'is-zooming', 'is-crouch', 'is-landing');
      mascotPlayState = 'resting';
      chatMascotEl.classList.add('is-resting');
      paintMascotFrame();

      const centerX = mascotPos.x + MASCOT_SIZE / 2;
      spawnMascotParticles('heart', centerX, mascotPos.y + 2, 3);
      showMascotBubble(pickMascotRandom(['Ta-da! ✨', 'Safe landing! 🐾', 'Hehe! ✨', 'Resting here!']), 1800);

      scheduleMascotReturnHome();
      startLedgeRoam();
    }

    function stopLedgeRoam() {
      if (mascotLedgeRoamTimer) {
        clearTimeout(mascotLedgeRoamTimer);
        mascotLedgeRoamTimer = null;
      }
      if (mascotLedgeStepTimer) {
        clearTimeout(mascotLedgeStepTimer);
        mascotLedgeStepTimer = null;
      }
      if (chatMascotEl) {
        chatMascotEl.classList.remove('is-walking');
        chatMascotEl.style.transition = '';
      }
    }

    function startLedgeRoam() {
      stopLedgeRoam();
      if (!chatMascotEl || prefersReducedMotion() || mascotPlayState !== 'resting') return;
      mascotLedgeRoamTimer = setTimeout(stepLedgeRoam, 2600 + Math.random() * 2200);
    }

    function stepLedgeRoam() {
      mascotLedgeRoamTimer = null;
      if (!chatMascotEl || mascotPlayState !== 'resting' || prefersReducedMotion()) return;
      const field = getMascotPlayField();
      const dir = Math.random() < 0.5 ? -1 : 1;
      const stepDist = 12 + Math.random() * 16;
      let nextX = mascotPos.x + dir * stepDist;
      if (nextX < field.minX + 6) nextX = mascotPos.x + stepDist;
      if (nextX > field.maxX - 6) nextX = mascotPos.x - stepDist;
      nextX = Math.max(field.minX, Math.min(field.maxX, nextX));

      chatMascotEl.classList.add('is-walking');
      chatMascotEl.style.transition = 'transform 0.45s ease-out';
      mascotPos.x = nextX;
      paintMascotFrame();

      mascotLedgeStepTimer = setTimeout(() => {
        mascotLedgeStepTimer = null;
        if (!chatMascotEl) return;
        chatMascotEl.classList.remove('is-walking');
        chatMascotEl.style.transition = '';
        if (mascotPlayState === 'resting') {
          mascotLedgeRoamTimer = setTimeout(stepLedgeRoam, 3200 + Math.random() * 2600);
        }
      }, 460);
    }

    function mascotJump(scale, lateral, silent) {
      if (!chatMascotEl || chatMascotEl.classList.contains('hidden')) return;
      if (mascotPlayState === 'grabbed' || mascotPlayState === 'dragging' || mascotPlayState === 'flying') return;

      if (prefersReducedMotion()) {
        if (!silent) showMascotBubble(pickMascotRandom(['Hop!', 'Yip!']), 900);
        return;
      }

      stopLedgeRoam();

      if (!isMascotFreeFloating()) {
        const rect = chatMascotEl.getBoundingClientRect();
        if (!parkMascotInLayer(rect.left, rect.top)) return;
        isMascotRoaming = false;
        isMascotOnTurn = false;
        cancelMascotHomeTimer();
      }
      chatMascotEl.classList.remove('is-sleeping', 'is-peeking', 'is-walking', 'is-resting', 'is-dizzy');
      lastMascotActivityTime = Date.now();

      const power = typeof scale === 'number' ? scale : 1;
      const side = typeof lateral === 'number' ? lateral : (Math.random() < 0.5 ? -1 : 1) * 30;

      flashMascotClass('is-crouch', 130);
      if (!silent) showMascotBubble(pickMascotRandom(['Hop!', 'Wheee!', 'Yip!', 'Boing!']), 900);

      if (mascotJumpTimer) {
        clearTimeout(mascotJumpTimer);
        mascotJumpTimer = null;
      }
      mascotJumpTimer = setTimeout(() => {
        mascotJumpTimer = null;
        if (!chatMascotEl || mascotPlayState === 'grabbed' || mascotPlayState === 'dragging') return;
        chatMascotEl.classList.remove('is-crouch', 'is-resting');
        mascotPlayState = 'flying';
        chatMascotEl.classList.add('is-flying');
        mascotVel.x = side;
        mascotVel.y = -MASCOT_PHYSICS.jumpImpulse * power;
        startMascotPhysics();
      }, 120);
    }

    function nudgeMascot(dx) {
      if (!chatMascotEl || mascotPlayState === 'grabbed' || mascotPlayState === 'dragging' || mascotPlayState === 'flying') return;
      if (prefersReducedMotion()) return;
      const rect = chatMascotEl.getBoundingClientRect();
      const field = getMascotPlayField();
      const nx = Math.max(field.minX, Math.min(field.maxX, rect.left + dx));
      if (!parkMascotInLayer(nx, rect.top)) return;
      stopMascotPhysics();
      stopLedgeRoam();
      cancelMascotHomeTimer();
      isMascotRoaming = false;
      isMascotOnTurn = false;
      mascotPlayState = 'resting';
      chatMascotEl.classList.remove('is-flying', 'is-dizzy', 'is-sleeping', 'is-peeking', 'is-walking');
      chatMascotEl.classList.add('is-resting');
      paintMascotFrame();
      flashMascotClass('is-walking', 420);
      lastMascotActivityTime = Date.now();
      scheduleMascotReturnHome();
      startLedgeRoam();
    }

    function mascotZoomies() {
      if (!chatMascotEl || chatMascotEl.classList.contains('hidden')) return;
      if (mascotPlayState === 'grabbed' || mascotPlayState === 'dragging') return;

      if (prefersReducedMotion()) {
        showMascotBubble(pickMascotRandom(['Zoomies!', 'Ta-da!']), 1200);
        return;
      }

      stopLedgeRoam();

      if (!isMascotFreeFloating()) {
        const rect = chatMascotEl.getBoundingClientRect();
        if (!parkMascotInLayer(rect.left, rect.top)) return;
        isMascotRoaming = false;
        isMascotOnTurn = false;
      }

      const field = getMascotPlayField();
      stopMascotPhysics();
      cancelMascotHomeTimer();
      chatMascotEl.classList.remove('is-sleeping', 'is-peeking', 'is-resting', 'is-dizzy', 'is-crouch');
      mascotPlayState = 'flying';
      chatMascotEl.classList.add('is-flying');
      const dir = mascotPos.x > field.width / 2 ? -1 : 1;
      mascotVel.x = dir * 900;
      mascotVel.y = -280;
      flashMascotClass('is-zooming', 900);
      spawnMascotParticles('sparkle', mascotPos.x + MASCOT_SIZE / 2, mascotPos.y + MASCOT_SIZE - 4, 5);
      showMascotBubble(pickMascotRandom(['Zoomies!', 'Weeee!', '⚡⚡', 'Ta-da!']), 1400);
      lastMascotActivityTime = Date.now();
      startMascotPhysics();
    }

    function recallMascotHome(playful) {
      stopLedgeRoam();
      cancelMascotHomeTimer();
      stopMascotPhysics();
      cancelMascotDragFrame();
      if (mascotJumpTimer) {
        clearTimeout(mascotJumpTimer);
        mascotJumpTimer = null;
      }
      if (!chatMascotEl) return;
      const wasFloating = isMascotFreeFloating();
      mascotPlayState = 'idle';
      mascotVel = { x: 0, y: 0 };
      mascotLean = 0;
      mascotDragField = null;
      mascotMoveSamples = [];
      mascotGrabOrigin = null;
      mascotBounceCount = 0;
      chatMascotEl.classList.remove('is-flying', 'is-falling', 'is-bouncing', 'is-resting', 'is-dizzy', 'is-zooming', 'is-crouch', 'is-landing', 'is-grabbed', 'is-dragging', 'is-sleeping', 'is-peeking');
      isMascotOnTurn = false;
      isMascotRoaming = false;

      const homeSlot = document.getElementById('chat-mascot-home-slot');
      if (!homeSlot) return;
      if (chatMascotEl.parentElement === homeSlot) {
        clearMascotFreeStyles();
        return;
      }
      if (playful && wasFloating) showMascotBubble('🏠 Back home!', 1300);
      hopMascotTo(homeSlot);
    }

    function clampMascotToField() {
      if (!chatMascotEl || !isMascotFreeFloating()) return;
      if (mascotPlayState === 'flying' || mascotPlayState === 'dragging') return;
      const field = getMascotPlayField();
      mascotPos.x = Math.max(field.minX, Math.min(field.maxX, mascotPos.x));
      mascotPos.y = Math.max(field.ceilingY, Math.min(field.groundY, mascotPos.y));
      paintMascotFrame();
    }

    function attachMascotPlayPhysics() {
      if (!chatMascotEl) return;

      chatMascotEl.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        beginMascotGrab(e);
      });
      chatMascotEl.addEventListener('pointermove', (e) => {
        updateMascotGrab(e);
      });
      chatMascotEl.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        endMascotGrab(e);
      });
      chatMascotEl.addEventListener('pointercancel', () => {
        cancelMascotGrab();
      });
      chatMascotEl.addEventListener('lostpointercapture', () => {
        if (mascotPointerId === null) cancelMascotGrab();
      });
      chatMascotEl.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        mascotJump();
      });
      chatMascotEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        recallMascotHome(true);
      });
      chatMascotEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          petMascot();
        } else if (e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          mascotJump();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          nudgeMascot(-16);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          nudgeMascot(16);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelMascotGrab();
        }
      });

      window.addEventListener('blur', () => {
        if (mascotPlayState === 'grabbed' || mascotPlayState === 'dragging') endMascotGrab();
      });
      window.addEventListener('focus', () => {
        mascotLastFrameTs = 0;
      });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          if (mascotPlayState === 'grabbed' || mascotPlayState === 'dragging') endMascotGrab();
        } else {
          mascotLastFrameTs = 0;
        }
      });
      window.addEventListener('resize', () => {
        mascotFieldCache = null;
        mascotDragField = null;
        clampMascotToField();
      });
    }

    function updateOnboardingVisibility() {
      if (!onboardingSection || !readyHeroSection) return;
      const isChatActive = isRunning || (chatContainer && chatContainer.querySelectorAll('.message').length > 0);
      if (isChatActive) {
        onboardingSection.style.display = 'none';
        readyHeroSection.style.display = 'none';
        return;
      }
      const hasAnyKey = (allProviders || []).some(p => p.has_key && p.id !== 'ollama');
      const isOllamaActive = currentProvider === 'ollama';
      if (!hasAnyKey && !isOllamaActive) {
        onboardingSection.style.display = 'flex';
        readyHeroSection.style.display = 'none';
        if (!window.__onboarding_viewed_tracked) {
          window.__onboarding_viewed_tracked = true;
          vscode.postMessage({ type: 'telemetry_feature', feature: 'onboarding_viewed' });
        }
      } else {
        onboardingSection.style.display = 'none';
        readyHeroSection.style.display = 'flex';
      }
    }

    onboardingProvidersGrid?.querySelectorAll('.onboarding-provider-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        onboardingProvidersGrid.querySelectorAll('.onboarding-provider-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        selectedOnboardingProvider = chip.dataset.provider || 'anthropic';
        selectedOnboardingModel = chip.dataset.model || '';
        vscode.postMessage({ type: 'telemetry_feature', feature: 'onboard_prov_' + selectedOnboardingProvider });
        const name = chip.dataset.name || 'AI Provider';
        const portal = chip.dataset.portal || '';

        if (onboardingKeyLabel) onboardingKeyLabel.textContent = '2. Paste ' + name + ' API Key';
        if (onboardingKeyInput) onboardingKeyInput.placeholder = 'Paste your ' + name + ' API key...';
        if (onboardingPortalLink) {
          onboardingPortalLink.dataset.url = portal;
          const textSpan = onboardingPortalLink.querySelector('span');
          if (textSpan) textSpan.textContent = 'Get ' + (chip.querySelector('.provider-chip-name')?.textContent || name) + ' API Key';
        }

        if (selectedOnboardingProvider === 'ollama') {
          if (onboardingKeyForm) onboardingKeyForm.style.display = 'none';
          if (onboardingOllamaForm) onboardingOllamaForm.style.display = 'flex';
          vscode.postMessage({ type: 'check_ollama_status' });
        } else {
          if (onboardingKeyForm) onboardingKeyForm.style.display = 'flex';
          if (onboardingOllamaForm) onboardingOllamaForm.style.display = 'none';
          if (onboardingKeyInput) setTimeout(() => onboardingKeyInput.focus(), 50);
        }
      });
    });

    btnToggleKeyVis?.addEventListener('click', () => {
      if (!onboardingKeyInput) return;
      onboardingKeyInput.type = onboardingKeyInput.type === 'password' ? 'text' : 'password';
    });

    btnOnboardingSave?.addEventListener('click', () => {
      if (!onboardingKeyInput) return;
      const keyVal = onboardingKeyInput.value.trim();
      if (!keyVal) {
        onboardingKeyInput.style.borderColor = '#ef4444';
        onboardingKeyInput.focus();
        setTimeout(() => { onboardingKeyInput.style.borderColor = ''; }, 2000);
        return;
      }
      btnOnboardingSave.disabled = true;
      btnOnboardingSave.innerHTML = '<span>Connecting...</span>';
      vscode.postMessage({
        type: 'set_api_key',
        provider: selectedOnboardingProvider,
        apiKey: keyVal,
        modelId: selectedOnboardingModel,
      });
    });

    onboardingKeyInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        btnOnboardingSave?.click();
      }
    });

    let currentOllamaStatus = null;
    const btnOnboardingOllamaStart = document.getElementById('btn-onboarding-ollama-start');
    const btnOnboardingOllamaPull = document.getElementById('btn-onboarding-ollama-pull');
    const btnOnboardingOllamaDownload = document.getElementById('btn-onboarding-ollama-download');
    const onboardingOllamaStatusChip = document.getElementById('onboarding-ollama-status-chip');
    const onboardingOllamaStatusDot = document.getElementById('onboarding-ollama-status-dot');
    const onboardingOllamaStatusText = document.getElementById('onboarding-ollama-status-text');

    btnOnboardingOllamaSave?.addEventListener('click', () => {
      btnOnboardingOllamaSave.disabled = true;
      btnOnboardingOllamaSave.innerHTML = '<span>Activating Ollama...</span>';
      const bestModel = currentOllamaStatus?.bestModel || (currentOllamaStatus?.models?.[0]) || 'llama3.2:latest';
      vscode.postMessage({
        type: 'set_api_key',
        provider: 'ollama',
        apiKey: '',
        modelId: bestModel,
      });
    });

    btnOnboardingOllamaStart?.addEventListener('click', () => {
      if (btnOnboardingOllamaStart) {
        btnOnboardingOllamaStart.disabled = true;
        btnOnboardingOllamaStart.innerHTML = '<span>Starting server...</span>';
      }
      vscode.postMessage({ type: 'start_ollama_server' });
    });

    btnOnboardingOllamaPull?.addEventListener('click', () => {
      const model = btnOnboardingOllamaPull.dataset.model || 'qwen2.5-coder:7b';
      if (btnOnboardingOllamaPull) {
        btnOnboardingOllamaPull.disabled = true;
        btnOnboardingOllamaPull.innerHTML = '<span>Pulling ' + model + '...</span>';
      }
      vscode.postMessage({ type: 'pull_ollama_model', model: model });
    });

    function updateOllamaStatusUI(status) {
      if (!status) return;
      currentOllamaStatus = status;
      if (!onboardingOllamaStatusDot || !onboardingOllamaStatusText) return;

      if (status.running) {
        if (status.models && status.models.length > 0) {
          const activeModelName = status.bestModel || status.models[0] || 'ready';
          onboardingOllamaStatusDot.className = 'ollama-status-dot online';
          onboardingOllamaStatusText.textContent = 'Ollama running · ' + status.models.length + ' model' + (status.models.length > 1 ? 's' : '') + ' ready (' + activeModelName + ')';
          if (btnOnboardingOllamaSave) btnOnboardingOllamaSave.style.display = 'flex';
          if (btnOnboardingOllamaStart) btnOnboardingOllamaStart.style.display = 'none';
          if (btnOnboardingOllamaPull) btnOnboardingOllamaPull.style.display = 'none';
          if (btnOnboardingOllamaDownload) btnOnboardingOllamaDownload.style.display = 'none';
        } else {
          onboardingOllamaStatusDot.className = 'ollama-status-dot warning';
          onboardingOllamaStatusText.textContent = 'Ollama running · 0 models installed';
          if (btnOnboardingOllamaPull) btnOnboardingOllamaPull.style.display = 'flex';
          if (btnOnboardingOllamaSave) btnOnboardingOllamaSave.style.display = 'flex';
          if (btnOnboardingOllamaStart) btnOnboardingOllamaStart.style.display = 'none';
          if (btnOnboardingOllamaDownload) btnOnboardingOllamaDownload.style.display = 'none';
        }
      } else if (status.installed) {
        onboardingOllamaStatusDot.className = 'ollama-status-dot warning';
        onboardingOllamaStatusText.textContent = 'Ollama installed · Server stopped';
        if (btnOnboardingOllamaStart) {
          btnOnboardingOllamaStart.style.display = 'flex';
          btnOnboardingOllamaStart.disabled = false;
          btnOnboardingOllamaStart.innerHTML = '<span>Start Ollama Server</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
        }
        if (btnOnboardingOllamaSave) btnOnboardingOllamaSave.style.display = 'flex';
        if (btnOnboardingOllamaPull) btnOnboardingOllamaPull.style.display = 'none';
        if (btnOnboardingOllamaDownload) btnOnboardingOllamaDownload.style.display = 'none';
      } else {
        onboardingOllamaStatusDot.className = 'ollama-status-dot offline';
        onboardingOllamaStatusText.textContent = 'Ollama not detected on machine';
        if (btnOnboardingOllamaDownload) btnOnboardingOllamaDownload.style.display = 'flex';
        if (btnOnboardingOllamaSave) btnOnboardingOllamaSave.style.display = 'flex';
        if (btnOnboardingOllamaStart) btnOnboardingOllamaStart.style.display = 'none';
        if (btnOnboardingOllamaPull) btnOnboardingOllamaPull.style.display = 'none';
      }
    }

    let onboardingPendingProvider = '';
    let onboardingSelectedLiveModel = '';
    let onboardingLiveModelsList = [];

    const onboardingStep1 = document.getElementById('onboarding-step-1');
    const onboardingStep2 = document.getElementById('onboarding-step-2');
    const onboardingStepPill = document.getElementById('onboarding-step-pill');
    const onboardingStepText = document.getElementById('onboarding-step-text');

    const onboardingStep2Badge = document.getElementById('onboarding-step2-badge');
    const btnOnboardingStep2Back = document.getElementById('btn-onboarding-step2-back');
    const onboardingStep2Search = document.getElementById('onboarding-step2-search');
    const onboardingStep2ModelsList = document.getElementById('onboarding-step2-models-list');
    const btnStep2Skip = document.getElementById('btn-step2-skip');
    const btnStep2Confirm = document.getElementById('btn-step2-confirm');

    const ONBOARDING_MODEL_PRIORITIES = [
      /claude-3[.-]7-sonnet/i,
      /claude-3[.-]5-sonnet/i,
      /gpt-4o(?!-mini)/i,
      /deepseek[/-]r1/i,
      /deepseek-reasoner/i,
      /deepseek[/-](chat|v3)/i,
      /gemini-2[.-]5-flash/i,
      /gemini-2[.-]5-pro/i,
      /gemini-2[.-]0-flash/i,
      /claude-sonnet/i,
      /gpt-4o-mini/i,
      /o3-mini/i,
      /o1(?!-mini)/i,
      /qwen.*coder/i,
      /llama-3[.-]3-70b/i,
      /llama3[.-]2/i,
    ];

    function getOnboardingModelScore(modelId, modelName) {
      const target = ((modelId || '') + ' ' + (modelName || '')).toLowerCase();
      for (let i = 0; i < ONBOARDING_MODEL_PRIORITIES.length; i++) {
        if (ONBOARDING_MODEL_PRIORITIES[i].test(target)) {
          return 1000 - i * 10;
        }
      }
      return 0;
    }

    function showOnboardingModelStep(provider, models, defaultModel) {
      onboardingPendingProvider = provider || selectedOnboardingProvider || 'anthropic';
      
      const rawList = Array.isArray(models) ? models.slice() : [];
      rawList.sort((a, b) => {
        if (defaultModel) {
          if (a.id === defaultModel) return -1;
          if (b.id === defaultModel) return 1;
        }
        const scoreA = getOnboardingModelScore(a.id, a.name);
        const scoreB = getOnboardingModelScore(b.id, b.name);
        if (scoreA !== scoreB) return scoreB - scoreA;
        return (a.name || a.id).localeCompare(b.name || b.id);
      });

      onboardingLiveModelsList = rawList;
      onboardingSelectedLiveModel = defaultModel || (onboardingLiveModelsList[0]?.id) || '';

      if (onboardingStep1) onboardingStep1.style.display = 'none';
      if (onboardingStep2) onboardingStep2.style.display = 'flex';
      if (onboardingStepText) onboardingStepText.textContent = 'Step 2 of 2 · Choose Starting Model';

      if (onboardingStep2Badge) {
        const provName = provider ? (provider.charAt(0).toUpperCase() + provider.slice(1)) : 'AI';
        onboardingStep2Badge.textContent = provName + ' connected';
      }

      if (onboardingStep2Search) onboardingStep2Search.value = '';
      renderOnboardingStep2Models('');
      if (onboardingStep2Search) setTimeout(() => onboardingStep2Search.focus(), 60);
    }

    function showOnboardingKeyStep() {
      if (onboardingStep2) onboardingStep2.style.display = 'none';
      if (onboardingStep1) onboardingStep1.style.display = 'flex';
      if (onboardingStepText) onboardingStepText.textContent = 'Step 1 of 2 · Quick Setup';

      if (btnOnboardingSave) {
        btnOnboardingSave.disabled = false;
        btnOnboardingSave.innerHTML = '<span>Connect & Continue</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>';
      }
      if (btnOnboardingOllamaSave) {
        btnOnboardingOllamaSave.disabled = false;
        btnOnboardingOllamaSave.innerHTML = '<span>Activate Local Ollama</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>';
      }
      if (btnStep2Confirm) {
        btnStep2Confirm.disabled = false;
        btnStep2Confirm.innerHTML = '<span>Start Coding</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>';
      }
    }

    function renderOnboardingStep2Models(filterQuery) {
      if (!onboardingStep2ModelsList) return;
      const q = (filterQuery || '').trim().toLowerCase();
      const filtered = onboardingLiveModelsList.filter(m => {
        if (!q) return true;
        const name = (m.name || '').toLowerCase();
        const id = (m.id || '').toLowerCase();
        const desc = (m.desc || '').toLowerCase();
        return name.includes(q) || id.includes(q) || desc.includes(q);
      });

      if (filtered.length === 0) {
        onboardingStep2ModelsList.innerHTML = '<div style="padding:16px; text-align:center; color:var(--muted); font-size:11px;">No matching models found.</div>';
        return;
      }

      onboardingStep2ModelsList.innerHTML = filtered.map(m => {
        const isSelected = m.id === onboardingSelectedLiveModel;
        const isPopular = getOnboardingModelScore(m.id, m.name) >= 800;
        const popBadge = isPopular ? '<span class="model-badge-rec">· Popular</span>' : '';
        return '<div class="onboarding-model-item ' + (isSelected ? 'active' : '') + '" data-action="select-live-model" data-model-id="' + escapeHtml(m.id) + '" role="option" aria-selected="' + (isSelected ? 'true' : 'false') + '">' +
          '<div class="onboarding-model-item-info">' +
            '<div class="onboarding-model-item-name">' + escapeHtml(m.name || m.id) + popBadge + '</div>' +
            (m.desc ? '<div class="onboarding-model-item-desc">' + escapeHtml(m.desc) + '</div>' : '') +
          '</div>' +
          '<div class="onboarding-model-item-meta">' +
            (m.context ? '<span class="onboarding-model-ctx-pill">' + escapeHtml(m.context) + '</span>' : '') +
            (m.pricing ? '<span class="onboarding-model-pricing-pill">' + escapeHtml(m.pricing) + '</span>' : '') +
          '</div>' +
        '</div>';
      }).join('');
    }

    function confirmOnboardingModel(chosenModel) {
      const modelToUse = chosenModel || onboardingSelectedLiveModel || onboardingLiveModelsList[0]?.id;
      if (btnStep2Confirm) {
        btnStep2Confirm.disabled = true;
        btnStep2Confirm.innerHTML = '<span>Saving...</span>';
      }
      vscode.postMessage({
        type: 'finish_onboarding_model',
        provider: onboardingPendingProvider,
        modelId: modelToUse,
      });
    }

    onboardingStep2ModelsList?.addEventListener('click', (e) => {
      const item = e.target.closest('.onboarding-model-item');
      if (!item) return;
      onboardingSelectedLiveModel = item.dataset.modelId || '';
      onboardingStep2ModelsList.querySelectorAll('.onboarding-model-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    });

    onboardingStep2ModelsList?.addEventListener('dblclick', (e) => {
      const item = e.target.closest('.onboarding-model-item');
      if (!item) return;
      confirmOnboardingModel(item.dataset.modelId);
    });

    onboardingStep2Search?.addEventListener('input', () => {
      renderOnboardingStep2Models(onboardingStep2Search.value);
    });

    onboardingStep2Search?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = onboardingStep2ModelsList?.querySelector('.onboarding-model-item');
        if (first) {
          confirmOnboardingModel(first.dataset.modelId);
        }
      }
    });

    btnStep2Confirm?.addEventListener('click', () => {
      confirmOnboardingModel();
    });

    btnStep2Skip?.addEventListener('click', () => {
      confirmOnboardingModel(onboardingLiveModelsList[0]?.id);
    });

    btnOnboardingStep2Back?.addEventListener('click', () => {
      showOnboardingKeyStep();
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

      // Only show past sessions that have actual messages (message_count > 0) and are NOT the current active session
      const pastSessionsWithHistory = sessions.filter(s => 
        s.id !== currentSessionId && 
        s.message_count && 
        s.message_count > 0
      );

      if (pastSessionsWithHistory.length === 0) {
        recentSessionsSection.style.display = 'none';
        return;
      }

      recentSessionsSection.style.display = 'flex';
      const recent = pastSessionsWithHistory.slice(0, 3);
      recentSessionsList.innerHTML = recent.map(s => {
        const name = escapeHtml(s.name || s.id || 'Untitled Session');
        const dateStr = formatDateBadge(s.updated_at || s.created_at);
        const msgsText = s.message_count + (s.message_count === 1 ? ' msg' : ' msgs');
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

    let activeSessionFilter = 'tree';
    const expandedSessionIds = new Set();

    document.querySelectorAll('.sessions-filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.sessions-filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeSessionFilter = tab.dataset.filter || 'tree';
        sessionDisplayLimit = 10;
        filterAndRenderSessions(sessionsSearch ? sessionsSearch.value : '');
      });
    });

    function renderSessionsList(sessions, activeId) {
      allSessions = sessions || [];
      sessionDisplayLimit = 10;
      
      const mainCount = allSessions.filter(s => !s.parent_session).length;
      const subagentCount = allSessions.filter(s => !!s.parent_session).length;
      const countMainEl = document.getElementById('count-main-sessions');
      const countSubEl = document.getElementById('count-subagent-sessions');
      if (countMainEl) countMainEl.textContent = String(mainCount);
      if (countSubEl) countSubEl.textContent = String(subagentCount);

      // Automatically expand parent of the current session or any running subagent
      if (activeId) {
        const activeSess = allSessions.find(s => s.id === activeId);
        if (activeSess && activeSess.parent_session) {
          expandedSessionIds.add(activeSess.parent_session);
        }
      }
      allSessions.forEach(s => {
        if (s.parent_session) {
          const st = sessionsState[s.id];
          if ((st && st.isRunning) || s.status === 'running') {
            expandedSessionIds.add(s.parent_session);
          }
        }
      });

      filterAndRenderSessions(sessionsSearch ? sessionsSearch.value : '');
      renderHomeRecentSessions(allSessions.filter(s => !s.parent_session));
    }

    function renderRunningArc() {
      return '<svg class="session-running-arc" viewBox="0 0 24 24" fill="none" title="Running">' +
        '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-opacity="0.25"></circle>' +
        '<path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"></path>' +
      '</svg>';
    }

    function renderSessionItemHtml(s, opts) {
      opts = opts || {};
      const isSubsession = !!opts.isSubsession;
      const isLastChild = !!opts.isLastChild;
      const childrenCount = opts.childrenCount || 0;
      const isExpanded = !!opts.isExpanded;
      const parentName = opts.parentName || '';

      const isCur = s.id === currentSessionId;
      const name = escapeHtml(s.name || s.id || (isSubsession ? 'Subagent Task' : 'Session'));
      const msgs = s.message_count ? (s.message_count + ' msgs') : 'Empty';
      const cost = (s.cost_usd && Number(s.cost_usd) > 0) ? ('$' + Number(s.cost_usd).toFixed(3)) : '';
      const sessState = sessionsState[s.id];
      const isRunningSess = !!((sessState && sessState.isRunning) || s.status === 'running');

      // Sleek minimalist spinning circular arc icon when running (No bulky RUNNING text badge)
      const runningArc = isRunningSess ? renderRunningArc() : '';

      let statusBadge = '';
      if (sessState && sessState.hasUnread && !isCur) {
        statusBadge = '<span class="session-badge-status session-status-unread">NEW</span>';
      } else if (s.status && s.status !== 'idle' && s.status !== 'running') {
        statusBadge = '<span class="session-badge-status session-status-' + escapeHtml(s.status) + '">' + escapeHtml(s.status) + '</span>';
      }

      const activeDot = isCur ? '<span class="session-active-dot" title="Active session"></span>' : '';
      const subTag = isSubsession ? '<span class="subsession-tag">Subagent</span>' : '';
      const branchSymbol = isSubsession ? ('<span class="subsession-branch-symbol">' + (isLastChild ? '└' : '├') + '</span>') : '';

      let toggleBtn = '';
      if (!isSubsession && childrenCount > 0) {
        toggleBtn = '<button class="subsession-toggle-btn" data-action="toggle-subsessions" data-parent-id="' + s.id + '" title="' + (isExpanded ? 'Collapse' : 'Expand') + ' ' + childrenCount + ' subagent(s)">' +
          '<svg class="subsession-chevron' + (isExpanded ? ' expanded' : '') + '" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
          '<span>' + childrenCount + ' subtask' + (childrenCount === 1 ? '' : 's') + '</span>' +
        '</button>';
      }

      const parentRef = (!isSubsession && parentName) ? ('<span>· Parent: ' + escapeHtml(parentName) + '</span>') : '';
      const itemClass = 'session-item ' + (isSubsession ? 'session-subsession-item ' : '') + (isCur ? 'active' : '');

      return '<div class="' + itemClass + '" data-session-id="' + s.id + '">' +
        '<div class="session-item-info" data-action="switch-session" data-session-id="' + s.id + '">' +
          '<div class="session-item-title">' +
            branchSymbol +
            activeDot +
            subTag +
            '<span class="session-title-text" title="' + name + '">' + name + '</span>' +
            runningArc +
            statusBadge +
          '</div>' +
          '<div class="session-item-meta">' +
            '<span>' + msgs + '</span>' +
            (cost ? '<span>· ' + cost + '</span>' : '') +
            parentRef +
            toggleBtn +
          '</div>' +
        '</div>' +
        '<div class="session-item-actions">' +
          '<button class="session-action-icon" data-action="open-session-tab" data-session-id="' + s.id + '" data-session-name="' + name + '" title="Open in New Editor Tab (Side-by-Side)">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>' +
          '</button>' +
          '<button class="session-action-icon" data-action="rename-session" data-session-id="' + s.id + '" data-session-name="' + name + '" title="Rename">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>' +
          '</button>' +
          '<button class="session-action-icon session-action-delete" data-action="delete-session" data-session-id="' + s.id + '" title="Delete">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>' +
          '</button>' +
        '</div>' +
      '</div>';
    }

    function filterAndRenderSessions(query) {
      if (!sessionsListEl) return;
      const q = (query || '').toLowerCase().trim();

      // Build session map and parent-to-subagents map
      const allSessionMap = new Map();
      const subagentMap = new Map();
      const mainSessions = [];

      allSessions.forEach(s => {
        allSessionMap.set(s.id, s);
        if (s.parent_session) {
          if (!subagentMap.has(s.parent_session)) {
            subagentMap.set(s.parent_session, []);
          }
          subagentMap.get(s.parent_session).push(s);
        } else {
          mainSessions.push(s);
        }
      });

      // Catch orphaned subagents whose parent is missing from mainSessions
      const mainSessionIdSet = new Set(mainSessions.map(s => s.id));
      const orphanedSubagents = [];
      for (const [pId, subs] of subagentMap.entries()) {
        if (!mainSessionIdSet.has(pId)) {
          orphanedSubagents.push(...subs);
        }
      }

      if (activeSessionFilter === 'subagents') {
        // Flat focused view of subagents
        const allSubs = allSessions.filter(s => !!s.parent_session);
        const filteredSubs = allSubs.filter(s => {
          const parentObj = allSessionMap.get(s.parent_session);
          const pName = parentObj ? (parentObj.name || '') : '';
          return (s.name || s.id || '').toLowerCase().includes(q) || pName.toLowerCase().includes(q);
        });

        if (filteredSubs.length === 0) {
          sessionsListEl.innerHTML = '<div style="padding:16px 14px; text-align:center; color:var(--muted); font-size:11px;">No subagent tasks found</div>';
          return;
        }

        const visibleSubs = filteredSubs.slice(0, sessionDisplayLimit);
        let html = visibleSubs.map((sub, idx) => {
          const parentObj = allSessionMap.get(sub.parent_session);
          const parentName = parentObj ? (parentObj.name || sub.parent_session.slice(0, 8)) : (sub.parent_session ? sub.parent_session.slice(0, 8) : '');
          return renderSessionItemHtml(sub, {
            isSubsession: true,
            isLastChild: idx === visibleSubs.length - 1,
            parentName: parentName
          });
        }).join('');

        if (filteredSubs.length > sessionDisplayLimit) {
          const remaining = filteredSubs.length - sessionDisplayLimit;
          html += '<div class="sessions-load-more-wrap">' +
            '<button class="btn-load-more-sessions" data-action="load-more-sessions">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
              '<span>Load More (' + remaining + ' remaining)</span>' +
            '</button>' +
          '</div>';
        }
        sessionsListEl.innerHTML = html;
        return;
      }

      // Hierarchical tree view (default)
      // Filter main sessions: include if main session matches query OR if any of its child subagents match
      const filteredMains = [];
      mainSessions.forEach(m => {
        const subs = subagentMap.get(m.id) || [];
        const mMatches = (m.name || m.id || '').toLowerCase().includes(q);
        const matchingSubs = q ? subs.filter(sub => (sub.name || sub.id || '').toLowerCase().includes(q)) : subs;

        if (!q || mMatches || matchingSubs.length > 0) {
          if (q && matchingSubs.length > 0) {
            // Auto-expand if subagent matches query
            expandedSessionIds.add(m.id);
          }
          filteredMains.push({
            session: m,
            children: subs
          });
        }
      });

      // Also include any orphaned subagents if matching
      orphanedSubagents.forEach(orphan => {
        if (!q || (orphan.name || orphan.id || '').toLowerCase().includes(q)) {
          filteredMains.push({
            session: orphan,
            children: [],
            isOrphan: true
          });
        }
      });

      if (filteredMains.length === 0) {
        sessionsListEl.innerHTML = '<div style="padding:16px 14px; text-align:center; color:var(--muted); font-size:11px;">No matching sessions found</div>';
        return;
      }

      const visible = filteredMains.slice(0, sessionDisplayLimit);

      try {
        let html = visible.map(entry => {
          const s = entry.session;
          const children = entry.children || [];
          const isExpanded = expandedSessionIds.has(s.id);
          const parentHtml = renderSessionItemHtml(s, {
            isSubsession: !!entry.isOrphan,
            childrenCount: children.length,
            isExpanded: isExpanded
          });

          if (children.length === 0) {
            return '<div class="session-tree-group">' + parentHtml + '</div>';
          }

          const childrenHtml = children.map((sub, idx) => {
            return renderSessionItemHtml(sub, {
              isSubsession: true,
              isLastChild: idx === children.length - 1
            });
          }).join('');

          return '<div class="session-tree-group">' +
            parentHtml +
            '<div class="session-subsessions-list' + (isExpanded ? '' : ' collapsed') + '" id="subsessions-' + s.id + '">' +
              childrenHtml +
            '</div>' +
          '</div>';
        }).join('');

        if (filteredMains.length > sessionDisplayLimit) {
          const remaining = filteredMains.length - sessionDisplayLimit;
          html += '<div class="sessions-load-more-wrap">' +
            '<button class="btn-load-more-sessions" data-action="load-more-sessions">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
              '<span>Load More (' + remaining + ' remaining)</span>' +
            '</button>' +
          '</div>';
        }

        sessionsListEl.innerHTML = html;
      } catch (renderErr) {
        console.error('[Andromity] Failed to render sessions list:', renderErr);
        sessionsListEl.innerHTML = '<div style="padding:16px 14px; text-align:center; color:var(--red); font-size:11px;">Error loading sessions</div>';
      }
    }

    function renderCronsList(crons) {
      if (!cronsListEl) return;
      if (!crons || crons.length === 0) {
        cronsListEl.innerHTML = '<div style="padding:16px 12px; text-align:center; color:var(--muted); font-size:11.5px;">No scheduled tasks active.<br/><button class="cron-btn-action" data-cron-action="create" style="margin:8px auto 0 auto; padding:4px 10px;">+ Create New Task</button></div>';
        return;
      }
      cronsListEl.innerHTML = crons.map(c => {
        const isEnabled = c.enabled !== false;
        const isRunning = c.last_status === 'running';
        const statusLabel = isRunning ? 'Running' : (isEnabled ? 'Active' : 'Paused');
        const statusPillClass = isRunning ? 'cron-status-running' : (isEnabled ? 'cron-status-active' : 'cron-status-paused');

        let lastStatusText = '○ Never run';
        let lastStatusColor = 'var(--muted)';
        if (c.last_status === 'success') {
          lastStatusText = '✓ Success';
          lastStatusColor = 'var(--green)';
        } else if (c.last_status === 'failed') {
          lastStatusText = '✗ Failed';
          lastStatusColor = 'var(--red)';
        } else if (c.last_status === 'timeout') {
          lastStatusText = 'Timeout';
          lastStatusColor = '#eab308';
        }
        const nextRun = isEnabled ? (c.next_run_in ? ('Next: ' + c.next_run_in) : 'Next: soon') : 'Paused';

        return '<div class="cron-card">' +
          '<div class="cron-card-top">' +
            '<div class="cron-card-title-group">' +
              '<span class="cron-card-name" title="' + escapeHtml(c.name || 'Task') + '">' + escapeHtml(c.name || 'Task') + '</span>' +
              '<span class="cron-card-schedule">' + escapeHtml(c.schedule || 'every 1h') + '</span>' +
            '</div>' +
            '<span class="cron-status-pill ' + statusPillClass + '">' + statusLabel + '</span>' +
          '</div>' +
          '<div class="cron-prompt">' + escapeHtml(c.prompt || '') + '</div>' +
          '<div class="cron-card-meta">' +
            '<div>' +
              '<span style="color:' + lastStatusColor + '; font-weight:600;">' + lastStatusText + '</span>' +
              '<span style="opacity:0.6; margin-left:6px;">• ' + escapeHtml(nextRun) + '</span>' +
            '</div>' +
            '<div class="cron-card-actions">' +
              '<button class="cron-btn-action run-btn" data-cron-action="run" data-id="' + escapeHtml(c.id) + '" data-name="' + escapeHtml(c.name || '') + '" title="Trigger immediately"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="margin-right:3px;vertical-align:-1px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>Run</button>' +
              '<button class="cron-btn-action" data-cron-action="toggle" data-id="' + escapeHtml(c.id) + '" title="' + (isEnabled ? 'Pause schedule' : 'Activate schedule') + '">' + (isEnabled ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="margin-right:3px;vertical-align:-1px;"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>Pause' : '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="margin-right:3px;vertical-align:-1px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>Enable') + '</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function renderCronEventCard(job, run) {
      if (!chatContainer) return;
      const isSuccess = run.status === 'success';
      const durSec = run.duration_ms ? (run.duration_ms / 1000).toFixed(1) : '0';
      const outPreview = run.output_preview || (isSuccess ? 'Scheduled run completed without output.' : (run.error || 'Execution failed.'));

      const card = document.createElement('div');
      card.className = 'cron-event-card ' + (isSuccess ? 'success' : 'failed');
      card.innerHTML =
        '<div class="cron-event-hdr">' +
          '<span style="display:flex; align-items:center; gap:5px;">' +
            '<span style="color:' + (isSuccess ? 'var(--green)' : 'var(--red)') + '; display:inline-flex; align-items:center;">' + (isSuccess ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>' : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>') + '</span>' +
            '<span>Scheduled Task: <strong>' + escapeHtml(job?.name || run.job_name || 'Task') + '</strong></span>' +
          '</span>' +
          '<span style="font-size:10px; color:var(--muted); font-weight:normal;">' + durSec + 's</span>' +
        '</div>' +
        '<div class="cron-event-body">' + escapeHtml(outPreview) + '</div>';

      chatContainer.appendChild(card);
      scrollToBottomIfNeeded();
    }

    function updatePlanTracker(plan) {
      if (!planTrackerStrip) return;
      if (!plan || (!plan.title && (!plan.steps || plan.steps.length === 0) && (!plan.todos || plan.todos.length === 0))) {
        planTrackerStrip.style.display = 'none';
        return;
      }
      const steps = plan.steps || plan.todos || [];
      if (steps.length === 0 && !plan.title) {
        planTrackerStrip.style.display = 'none';
        return;
      }
      planTrackerStrip.style.display = 'flex';
      if (trackerTitle) trackerTitle.textContent = plan.title || 'Plan Tasks';

      let completed = 0;
      let activeIdx = -1;
      const stepItemsHtml = steps.map((s, idx) => {
        const sStatus = (typeof s === 'string' ? 'pending' : (s.status || 'pending')).toLowerCase();
        const sText = typeof s === 'string' ? s : (s.title || s.description || ('Step ' + (idx + 1)));
        const isDone = (sStatus === 'done' || sStatus === 'completed');
        const isActive = (sStatus === 'active' || sStatus === 'in_progress' || sStatus === 'running');
        const isFailed = (sStatus === 'failed' || sStatus === 'error');

        if (isDone) completed++;
        if (isActive && activeIdx === -1) activeIdx = idx;

        let iconSvg = '';
        let itemClass = 'tracker-todo-item';

        if (isDone) {
          itemClass += ' is-done';
          iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        } else if (isActive) {
          itemClass += ' is-active';
          iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
        } else if (isFailed) {
          itemClass += ' is-failed';
          iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        } else {
          itemClass += ' is-pending';
          iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect></svg>';
        }

        return '<div class="' + itemClass + '">' +
          '<div class="tracker-todo-icon-wrap">' + iconSvg + '</div>' +
          '<span class="tracker-todo-text">' + escapeHtml(sText) + '</span>' +
        '</div>';
      }).join('');

      const totalSteps = steps.length;
      const pct = totalSteps > 0 ? Math.round((completed / totalSteps) * 100) : 0;
      const isAllDone = totalSteps > 0 && completed === totalSteps;
      if (trackerCount) {
        trackerCount.textContent = totalSteps > 0 ? (completed + '/' + totalSteps + ' done') : 'in progress';
      }
      if (trackerProgressBar) {
        trackerProgressBar.style.width = pct + '%';
      }
      if (planTrackerStrip) {
        if (isAllDone) {
          planTrackerStrip.classList.add('is-complete');
        } else {
          planTrackerStrip.classList.remove('is-complete');
        }
      }
      if (trackerTodosList) {
        trackerTodosList.innerHTML = stepItemsHtml || '<div style="color:var(--muted);font-size:11px;padding:2px 0;">No steps listed.</div>';
      }
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
      const progressHtml = steps.length > 0 ? ('<span class="pill-progress">(' + doneCount + '/' + steps.length + ' done)</span>') : '';
      existingPill.innerHTML =
        '<span class="pill-icon">' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>' +
        '</span>' +
        '<span class="pill-title" title="' + escapeHtml(plan.title) + '">Plan: ' + escapeHtml(plan.title) + progressHtml + '</span>' +
        '<button class="pill-btn" data-action="open-plan-tab" title="Open full plan tab">' +
          '<span>Open Plan</span>' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
        '</button>';
      scrollToBottomIfNeeded();
    }

    function renderConversationTimeline(filterQuery) {
      if (!timelineList) return;
      timelineList.innerHTML = '';
      const userWraps = chatContainer.querySelectorAll('.message-wrap.user');
      const countEl = document.getElementById('timeline-turn-count');
      if (countEl) {
        countEl.textContent = (userWraps ? userWraps.length : 0) + ' ' + (userWraps.length === 1 ? 'turn' : 'turns');
      }

      if (!userWraps || userWraps.length === 0) {
        timelineList.innerHTML = '<div style="padding:24px 16px; text-align:center; color:var(--muted); font-size:11.5px;">No conversation turns recorded yet.</div>';
        return;
      }

      const q = (filterQuery || '').toLowerCase().trim();
      let visibleCount = 0;

      userWraps.forEach((uWrap, idx) => {
        const uText = uWrap.querySelector('.message.user')?.textContent || ('Turn #' + (idx + 1));
        const cleanPrompt = uText.trim().replace(/\\s+/g, ' ');
        const timeText = uWrap.querySelector('.message-footer span')?.textContent || '';

        let asstWrap = uWrap.nextElementSibling;
        while (asstWrap && !asstWrap.classList.contains('message-wrap')) {
          asstWrap = asstWrap.nextElementSibling;
        }

        const isTurnRunning = (idx === userWraps.length - 1) && isRunning;
        const toolCards = asstWrap ? asstWrap.querySelectorAll('.tool-card') : [];
        const fileChips = asstWrap ? asstWrap.querySelectorAll('.file-edited-chip') : [];
        const asstTextEl = asstWrap ? asstWrap.querySelector('.assistant-text') : null;
        let responsePreview = '';
        if (asstTextEl) {
          const rawAsst = (asstTextEl.textContent || '').trim().replace(/\\s+/g, ' ');
          if (rawAsst) responsePreview = rawAsst.length > 70 ? (rawAsst.slice(0, 70) + '…') : rawAsst;
        }

        const toolNames = [];
        toolCards.forEach(tc => {
          const tn = tc.querySelector('.tool-title-group span')?.textContent?.trim();
          if (tn && !toolNames.includes(tn) && toolNames.length < 3) {
            toolNames.push(tn);
          }
        });

        if (q) {
          const matchPrompt = cleanPrompt.toLowerCase().includes(q);
          const matchResponse = responsePreview.toLowerCase().includes(q);
          const matchTools = toolNames.some(t => t.toLowerCase().includes(q));
          if (!matchPrompt && !matchResponse && !matchTools) {
            return;
          }
        }

        visibleCount++;
        const node = document.createElement('div');
        node.className = 'timeline-node' + (isTurnRunning ? ' active' : '');
        node.innerHTML = '<div class="timeline-dot"></div>' +
          '<div class="timeline-node-card">' +
            '<div class="timeline-node-top">' +
              '<span class="timeline-node-turn">Turn #' + (idx + 1) + '</span>' +
              (timeText ? ('<span class="timeline-node-time">' + escapeHtml(timeText) + '</span>') : '') +
            '</div>' +
            '<div class="timeline-node-title" title="' + escapeHtml(cleanPrompt) + '">' + escapeHtml(cleanPrompt) + '</div>' +
            (responsePreview ? ('<div class="timeline-node-response-preview">' + escapeHtml(responsePreview) + '</div>') : '') +
            '<div class="timeline-node-badges">' +
              (toolCards.length > 0 ? ('<span class="timeline-mini-badge tools"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>' + toolCards.length + ' tool' + (toolCards.length > 1 ? 's' : '') + '</span>') : '') +
              (fileChips.length > 0 ? ('<span class="timeline-mini-badge files"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>' + fileChips.length + ' file' + (fileChips.length > 1 ? 's' : '') + '</span>') : '') +
              toolNames.map(tn => '<span class="timeline-mini-badge tool-tag">' + escapeHtml(tn) + '</span>').join('') +
            '</div>' +
          '</div>';

        node.addEventListener('click', () => {
          if (timelineFlyout) timelineFlyout.style.display = 'none';
          uWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
          uWrap.style.transition = 'outline 0.15s ease';
          uWrap.style.outline = '1px solid rgba(255, 255, 255, 0.25)';
          setTimeout(() => { uWrap.style.outline = 'none'; }, 1800);
        });

        timelineList.appendChild(node);
      });

      if (q && visibleCount === 0) {
        timelineList.innerHTML = '<div style="padding:20px 16px; text-align:center; color:var(--muted); font-size:11.5px;">No turns matching "' + escapeHtml(q) + '"</div>';
      }
    }

    const timelineSearchInput = document.getElementById('timeline-search');
    if (timelineSearchInput) {
      timelineSearchInput.addEventListener('input', (e) => {
        renderConversationTimeline(e.target.value);
      });
    }
    document.getElementById('btn-timeline-close')?.addEventListener('click', () => {
      if (timelineFlyout) timelineFlyout.style.display = 'none';
    });
    document.getElementById('btn-timeline-jump-first')?.addEventListener('click', () => {
      const firstWrap = chatContainer.querySelector('.message-wrap.user');
      if (firstWrap) {
        firstWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (timelineFlyout) timelineFlyout.style.display = 'none';
      }
    });
    document.getElementById('btn-timeline-jump-latest')?.addEventListener('click', () => {
      scrollToBottom();
      if (timelineFlyout) timelineFlyout.style.display = 'none';
    });

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
      const isTimelineTrigger = e.target.closest('#btn-top-timeline');
      if (timelineFlyout && !timelineFlyout.contains(e.target) && !isTimelineTrigger) {
        timelineFlyout.style.display = 'none';
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

      // 2b. Tool sequence header toggle
      const toolSeqHdr = e.target.closest('.tool-seq-header');
      if (toolSeqHdr) {
        if (e.target.closest('.tool-seq-copy')) return;
        const seq = toolSeqHdr.closest('.tool-sequence');
        if (seq) {
          seq.classList.toggle('collapsed');
          if (typeof toolSeqUserToggled !== 'undefined') toolSeqUserToggled = true;
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
        case 'toggle-subsessions': {
          e.stopPropagation();
          const pId = target.getAttribute('data-parent-id') || target.getAttribute('data-session-id');
          if (pId) {
            if (expandedSessionIds.has(pId)) {
              expandedSessionIds.delete(pId);
            } else {
              expandedSessionIds.add(pId);
            }
            filterAndRenderSessions(sessionsSearch ? sessionsSearch.value : '');
          }
          break;
        }
        case 'switch-session':
          const sId = target.getAttribute('data-session-id');
          if (sId) {
            sessionsFlyout.style.display = 'none';
            if (sId === currentSessionId) {
              break;
            }
            if (planTrackerStrip) planTrackerStrip.style.display = 'none';
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
        case 'open-session-tab': {
          e.stopPropagation();
          const tabSid = target.getAttribute('data-session-id') || target.closest('[data-session-id]')?.getAttribute('data-session-id');
          const tabSname = target.getAttribute('data-session-name') || target.closest('[data-session-name]')?.getAttribute('data-session-name') || '';
          if (tabSid) {
            if (sessionsFlyout) sessionsFlyout.style.display = 'none';
            const isCurrent = tabSid === currentSessionId;
            const tabPayload = collectOpenTabPayload(isCurrent);
            if (isCurrent) {
              promptQueue.length = 0;
              renderQueue();
            }
            vscode.postMessage({ type: 'open_session_tab', sessionId: tabSid, sessionName: tabSname, ...tabPayload });
          }
          break;
        }
        case 'open-current-tab': {
          const sNameEl = document.getElementById('active-session-name');
          const tabPayload = collectOpenTabPayload(true);
          promptQueue.length = 0;
          renderQueue();
          vscode.postMessage({ type: 'open_session_tab', sessionId: currentSessionId, sessionName: sNameEl?.textContent?.trim() || '', ...tabPayload });
          break;
        }
        case 'open-plan-tab':
          vscode.postMessage({ type: 'open_plan_tab' });
          break;
        case 'open-waterfall': {
          dismissWaterfallOnboarding();
          const sNameEl = document.getElementById('active-session-name');
          vscode.postMessage({
            type: 'open_waterfall',
            sessionId: currentSessionId,
            sessionName: sNameEl?.textContent?.trim() || 'Session'
          });
          break;
        }
        case 'open-file': {
          const fPath = target.getAttribute('data-file-path') || target.closest('[data-file-path]')?.getAttribute('data-file-path');
          const lineStr = target.getAttribute('data-line') || target.closest('[data-line]')?.getAttribute('data-line');
          if (fPath) {
            vscode.postMessage({ type: 'open_file', filePath: fPath, line: lineStr ? parseInt(lineStr, 10) : undefined });
          }
          break;
        }
        case 'open-file-diff': {
          const fPath = target.getAttribute('data-file-path') || target.closest('[data-file-path]')?.getAttribute('data-file-path') || target.closest('.file-edited-chip')?.getAttribute('data-file-path') || target.closest('.activity-diff-btn')?.getAttribute('data-file-path');
          if (fPath) {
            vscode.postMessage({ type: 'open_file_diff', filePath: fPath });
          }
          break;
        }
        case 'open-review-tab':
        case 'open-changes-review': {
          const card = target.closest('.files-changed-card');
          let turnFiles = undefined;
          if (card && card.getAttribute('data-turn-files')) {
            try {
              turnFiles = JSON.parse(card.getAttribute('data-turn-files'));
            } catch (err) {}
          }
          const fPath = target.getAttribute('data-file-path') || target.closest('[data-file-path]')?.getAttribute('data-file-path');
          vscode.postMessage({ type: 'open_review_tab', filePath: fPath, turnFiles: turnFiles });
          break;
        }
        case 'toggle-timeline':
          if (timelineFlyout) {
            const isVis = timelineFlyout.style.display !== 'none';
            if (!isVis) {
              renderConversationTimeline();
              timelineFlyout.style.display = 'flex';
            } else {
              timelineFlyout.style.display = 'none';
            }
          }
          break;
        case 'copy-prompt':
          window.copyMessageText(target);
          break;
        case 'new-session':
          vscode.postMessage({ type: 'new_session' });
          break;
        case 'open-diff':
          vscode.postMessage({ type: 'open_review_tab' });
          break;
        case 'remove-attached-file': {
          const idx = parseInt(target.getAttribute('data-idx') || '0', 10);
          removeAttachedFile(idx);
          break;
        }
        case 'dismiss-ollama-banner': {
          const b = document.getElementById('ollama-detected-banner');
          if (b) b.remove();
          break;
        }
        case 'toggle-more-files': {
          e.stopPropagation();
          const card = target.closest('.files-changed-card');
          if (card) {
            const isExpanded = card.getAttribute('data-expanded') === 'true';
            card.setAttribute('data-expanded', isExpanded ? 'false' : 'true');
            const extras = card.querySelectorAll('.files-changed-extra');
            extras.forEach(el => { el.style.display = isExpanded ? 'none' : 'flex'; });
            target.textContent = isExpanded ? ('... Show ' + extras.length + ' more') : 'Show less ▴';
          }
          break;
        }
        case 'undo-turn': {
          const userWrap = target.closest('.message-wrap.user');
          const allUserWraps = Array.from(chatContainer.querySelectorAll('.message-wrap.user'));
          const totalTurns = allUserWraps.length;
          let turnIndex = -1;
          if (userWrap) {
            turnIndex = allUserWraps.indexOf(userWrap);
          }
          if (turnIndex < 0 && target.hasAttribute && target.hasAttribute('data-turn-index')) {
            turnIndex = parseInt(target.getAttribute('data-turn-index'), 10);
          }
          const turnsToUndo = (turnIndex >= 0 && totalTurns > 0) ? (totalTurns - turnIndex) : 1;
          vscode.postMessage({
            type: 'undo_turn',
            turnIndex: turnIndex >= 0 ? turnIndex : undefined,
            totalTurns: totalTurns,
            turnsToUndo: turnsToUndo,
          });
          break;
        }
        case 'carousel-prev': {
          const cWrap = target.closest('.prompt-images-container');
          const carousel = cWrap ? cWrap.querySelector('.prompt-image-carousel') : null;
          if (carousel) carousel.scrollBy({ left: -140, behavior: 'smooth' });
          break;
        }
        case 'carousel-next': {
          const cWrap = target.closest('.prompt-images-container');
          const carousel = cWrap ? cWrap.querySelector('.prompt-image-carousel') : null;
          if (carousel) carousel.scrollBy({ left: 140, behavior: 'smooth' });
          break;
        }
        case 'toggle-prompt-expand': {
          const pWrap = target.closest('.prompt-text-wrapper');
          const pContent = pWrap ? pWrap.querySelector('.prompt-text-content') : null;
          if (pContent) {
            const isClamped = pContent.classList.toggle('clamped');
            target.textContent = isClamped ? 'Show more ▾' : 'Show less ▴';
          }
          break;
        }
        case 'retry-turn': {
          const errCard = target.closest('.andromity-error-card, .error-card');
          if (errCard) {
            errCard.style.opacity = '0.5';
            errCard.style.pointerEvents = 'none';
            const btn = errCard.querySelector('.btn-error-retry');
            if (btn) btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19"/></svg>Retrying...';
          }
          vscode.postMessage({
            type: 'retry_turn',
            sessionId: currentSessionId,
            stripImages: false,
          });
          break;
        }
        case 'retry-without-image': {
          const errCard = target.closest('.andromity-error-card, .error-card');
          if (errCard) {
            errCard.style.opacity = '0.5';
            errCard.style.pointerEvents = 'none';
            const btn = errCard.querySelector('.btn-error-retry');
            if (btn) btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19"/></svg>Retrying without image...';
          }
          vscode.postMessage({
            type: 'retry_turn',
            sessionId: currentSessionId,
            stripImages: true,
          });
          break;
        }
        case 'switch-model-flyout': {
          toggleModelFlyout();
          break;
        }
        case 'trigger-compact': {
          showCompactionBanner('Compacting conversation context to reduce token usage...');
          vscode.postMessage({ type: 'compact_session' });
          break;
        }
        case 'open-settings': {
          vscode.postMessage({ type: 'open_settings' });
          break;
        }
        case 'compact-session':
          showCompactionBanner('Compacting conversation context to reduce token usage...');
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
        case 'close-help-card': {
          const card = target.closest('.help-card');
          if (card) {
            card.remove();
          }
          break;
        }
        case 'close-about-card': {
          const card = target.closest('.about-card');
          if (card) {
            card.remove();
          }
          break;
        }
        case 'open-about-tab':
          vscode.postMessage({ type: 'open_about' });
          break;
        case 'open-settings':
        case 'open-full-settings':
          vscode.postMessage({ type: 'open_settings' });
          break;
        case 'open-portal': {
          const portalUrl = target.getAttribute('data-url') || target.closest('[data-url]')?.getAttribute('data-url');
          if (portalUrl) {
            vscode.postMessage({ type: 'open_external_url', url: portalUrl });
          }
          break;
        }
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
        case 'approve-tool-once':
          window.approveTool(target.getAttribute('data-approval-id'), 'once', target.getAttribute('data-tool'));
          break;
        case 'approve-tool-session':
          window.approveTool(target.getAttribute('data-approval-id'), 'session', target.getAttribute('data-tool'));
          break;
        case 'approve-tool-always':
          window.approveTool(target.getAttribute('data-approval-id'), 'always', target.getAttribute('data-tool'));
          break;
        case 'reject-tool':
          window.rejectTool(target.getAttribute('data-approval-id'));
          break;
        case 'toggle-perm-params': {
          const card = target.closest('.permission-card');
          if (card) {
            const body = card.querySelector('.permission-params-body');
            const chev = card.querySelector('.params-chevron');
            if (body) {
              const isHidden = body.style.display === 'none';
              body.style.display = isHidden ? 'block' : 'none';
              if (chev) chev.innerHTML = isHidden ? '&#x25BE;' : '&#x25B8;';
            }
          }
          break;
        }
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
          '<div class="flyout-item-info">' +
            (isActive ? '<span class="flyout-active-dot"></span>' : '') +
            '<span class="flyout-item-name">' + escapeHtml(m.name || m.id) + '</span>' +
          '</div>' +
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
    let attachedFiles = [];
    let currentActiveEditorContext = null;

    const BINARY_FILE_EXTENSIONS = new Set([
      'exe', 'dll', 'bin', 'so', 'dylib', 'zip', 'tar', 'gz', '7z', 'rar', 'iso',
      'dmg', 'class', 'pyc', 'pyo', 'o', 'obj', 'wasm', 'db', 'sqlite', 'parquet'
    ]);

    function getFileIconBadge(fileName) {
      const ext = (fileName || '').split('.').pop().toLowerCase();
      switch (ext) {
        case 'tsx':
        case 'jsx':
          return { badge: 'JSX', color: '#61dafb' };
        case 'ts':
          return { badge: 'TS', color: '#38bdf8' };
        case 'js':
        case 'mjs':
        case 'cjs':
          return { badge: 'JS', color: '#f7df1e' };
        case 'py':
          return { badge: 'PY', color: '#4ade80' };
        case 'html':
        case 'htm':
          return { badge: 'HTML', color: '#fb923c' };
        case 'css':
        case 'scss':
        case 'less':
          return { badge: 'CSS', color: '#c084fc' };
        case 'json':
          return { badge: '{}', color: '#facc15' };
        case 'md':
        case 'markdown':
          return { badge: 'MD', color: '#93c5fd' };
        case 'rs':
          return { badge: 'RS', color: '#f97316' };
        case 'go':
          return { badge: 'GO', color: '#38bdf8' };
        case 'java':
        case 'kt':
          return { badge: 'JAVA', color: '#f87171' };
        case 'sql':
          return { badge: 'SQL', color: '#a78bfa' };
        default:
          return { badge: 'FILE', color: '#94a3b8' };
      }
    }

    function renderAttachedFiles() {
      const container = document.getElementById('drag-dropped-files-bar');
      if (!container) return;
      if (!attachedFiles || attachedFiles.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
      }
      container.style.display = 'flex';
      container.innerHTML = attachedFiles.map((file, idx) => {
        const iconInfo = getFileIconBadge(file.name);
        return '<span class="dropped-file-chip" title="' + escapeHtml(file.path || file.name) + '">' +
          '<span class="chip-icon" style="color:' + iconInfo.color + ';">' + iconInfo.badge + '</span>' +
          '<span class="chip-name">' + escapeHtml(file.name) + '</span>' +
          '<button class="chip-remove-btn" data-action="remove-attached-file" data-idx="' + idx + '" title="Remove file">&#x2715;</button>' +
        '</span>';
      }).join('');
    }

    function addDroppedFileAttachment(fileInfo) {
      if (!fileInfo || !fileInfo.name) return;
      const ext = (fileInfo.name || '').split('.').pop().toLowerCase();
      if (BINARY_FILE_EXTENSIONS.has(ext)) {
        appendSystemNote('Binary file skipped: "' + escapeHtml(fileInfo.name) + '" (binary files cannot be added as code context).');
        return;
      }
      if (attachedFiles.some(f => f.path === fileInfo.path || f.name === fileInfo.name)) {
        return;
      }
      if (attachedFiles.length >= 8) {
        appendSystemNote('Maximum 8 files can be attached per message.');
        return;
      }
      attachedFiles.push(fileInfo);
      renderAttachedFiles();
    }

    function removeAttachedFile(idx) {
      if (idx >= 0 && idx < attachedFiles.length) {
        attachedFiles.splice(idx, 1);
        renderAttachedFiles();
      }
    }

    function showOllamaBanner(modelName) {
      const existing = document.getElementById('ollama-detected-banner');
      if (existing) existing.remove();
      const banner = document.createElement('div');
      banner.className = 'ollama-detected-banner';
      banner.id = 'ollama-detected-banner';
      banner.innerHTML = '<span><strong>Local Ollama detected</strong> (' + escapeHtml(modelName) + ')! Ready to code with 0 API keys &amp; 100% privacy.</span>' +
        '<button class="banner-dismiss" data-action="dismiss-ollama-banner" title="Dismiss banner">&times;</button>';
      const promptBox = document.querySelector('.prompt-box');
      if (promptBox && promptBox.parentElement) {
        promptBox.parentElement.insertBefore(banner, promptBox);
      }
    }

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

    function getPathBasename(p) {
      if (!p || typeof p !== 'string') return '';
      const lastSlash = Math.max(p.lastIndexOf('/'), p.lastIndexOf(String.fromCharCode(92)));
      return lastSlash !== -1 ? p.slice(lastSlash + 1) : p;
    }

    const btnAttachFileEl = document.getElementById('btn-attach-file');
    if (btnAttachFileEl) {
      btnAttachFileEl.addEventListener('click', () => {
        vscode.postMessage({ type: 'pick_file_attachment' });
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

      const commandsHtml = slashCommands.map(function(c) {
        return '<div class="help-item-row" data-action="select-slash-cmd" data-cmd="' + escapeHtml(c.cmd) + '">' +
          '<div style="display:flex; align-items:center; gap:8px; min-width:0;">' +
            '<span class="help-item-tag">' + escapeHtml(c.cmd) + '</span>' +
            '<span style="color:var(--fg); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(c.desc) + '</span>' +
          '</div>' +
          '<button class="btn-card-action">Run</button>' +
        '</div>';
      }).join('');

      card.innerHTML = 
        '<div class="help-card-header">' +
          '<div class="help-card-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>' +
            '<span>Available Commands &amp; Shortcuts</span>' +
          '</div>' +
          '<div style="display:flex; align-items:center; gap:6px;">' +
            '<span style="font-size:10.5px; color:var(--muted);">Click to run</span>' +
            '<button class="palette-close-btn" data-action="close-help-card" title="Close commands panel"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex; flex-direction:column; gap:2px;">' +
          commandsHtml +
        '</div>' +
        '<div style="margin-top:8px; padding-top:6px; border-top:1px solid var(--vscode-widget-border, var(--border)); font-size:11px; color:var(--muted); display:flex; justify-content:space-between;">' +
          '<span>Tip: Type <code>/</code> for commands, <code>@</code> for skills</span>' +
          '<span>Paste images with <code>Ctrl+V</code></span>' +
        '</div>';
      chatContainer.appendChild(card);
      scrollToBottomIfNeeded();
    }

    function appendAboutCard() {
      const card = document.createElement('div');
      card.className = 'about-card';

      card.innerHTML = 
        '<div class="skills-card-header">' +
          '<div class="skills-card-title">' +
            '<span style="font-weight:600;">Andromity AI Coding Agent</span>' +
            '<span style="color:var(--muted); font-size:11px; border:1px solid var(--border); padding:1px 5px; border-radius:3px; margin-left:4px;">v0.2.9</span>' +
          '</div>' +
          '<button class="palette-close-btn" data-action="close-about-card" title="Close"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>' +
        '</div>' +
        '<div style="font-size:11.5px; color:var(--muted); line-height:1.4; margin-bottom:8px;">' +
          'Autonomous AI coding agent with subagents, live plans &amp; diffs. Free and open-source software under the MIT License.' +
        '</div>' +
        '<div style="display:flex; flex-direction:column; gap:4px; margin-bottom:10px; font-size:11.5px;">' +
          '<div style="display:flex; justify-content:space-between;">' +
            '<span style="color:var(--muted);">License:</span>' +
            '<span style="font-weight:600; color:var(--fg);">MIT License (Open Source)</span>' +
          '</div>' +
          '<div style="display:flex; justify-content:space-between;">' +
            '<span style="color:var(--muted);">Repository:</span>' +
            '<a href="#" style="color:var(--vscode-textLink-foreground, #38bdf8); text-decoration:none;" data-action="open-portal" data-url="https://github.com/agenticmarket/andromity">github.com/agenticmarket/andromity</a>' +
          '</div>' +
          '<div style="display:flex; justify-content:space-between;">' +
            '<span style="color:var(--muted);">Publisher:</span>' +
            '<span style="color:var(--fg);">AgenticMarket</span>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
          '<button class="btn-card-action" data-action="open-about-tab">Open Diagnostics</button>' +
          '<button class="btn-card-action" data-action="open-portal" data-url="https://github.com/agenticmarket/andromity">GitHub</button>' +
          '<button class="btn-card-action" data-action="open-portal" data-url="https://github.com/agenticmarket/andromity/issues">Report Issue</button>' +
        '</div>';
      chatContainer.appendChild(card);
      scrollToBottomIfNeeded();
    }

    function appendSkillsCard() {
      const card = document.createElement('div');
      card.className = 'skills-card';

      const skillsListHtml = allSkills && allSkills.length > 0
        ? allSkills.map(function(s) {
          const name = s.name || s.id || 'skill';
          const desc = s.description || 'Specialized agent skill';
          return '<div class="skill-item-row" data-action="insert-skill-mention" data-skill="' + escapeHtml(name) + '">' +
            '<div style="display:flex; align-items:center; gap:8px; min-width:0;">' +
              '<span class="skill-item-tag">@' + escapeHtml(name) + '</span>' +
              '<span style="color:var(--fg); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(desc) + '</span>' +
            '</div>' +
            '<button class="btn-card-action">Use</button>' +
          '</div>';
        }).join('')
        : '<div style="color:var(--muted); padding:8px 0; text-align:center;">No custom skills found. Open Settings > Skills to manage skills.</div>';

      card.innerHTML = 
        '<div class="skills-card-header">' +
          '<div class="skills-card-title">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>' +
            '<span>Agent Skills (' + allSkills.length + ' active)</span>' +
          '</div>' +
          '<div style="display:flex; align-items:center; gap:6px;">' +
            '<button class="btn-card-action" data-action="open-skills-settings">Browse Hub</button>' +
            '<button class="palette-close-btn" data-action="close-skills-card" title="Close skills panel"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex; flex-direction:column; gap:2px; max-height:220px; overflow-y:auto;">' +
          skillsListHtml +
        '</div>' +
        '<div style="margin-top:8px; padding-top:6px; border-top:1px solid var(--vscode-widget-border, var(--border)); font-size:11px; color:var(--muted); display:flex; justify-content:space-between;">' +
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
      const filesToSend = [...attachedFiles];
      if (!text && imagesToSend.length === 0 && filesToSend.length === 0) return;

      if (text && text.startsWith('/')) {
        const cmdPart = text.split(/\s+/)[0].toLowerCase();
        let found = slashCommands.find(c => c.cmd.toLowerCase() === cmdPart);
        if (!found) {
          if (cmdPart === '/companion' || cmdPart === '/play' || cmdPart === '/fetch') {
            found = { cmd: cmdPart, action: cmdPart.slice(1) };
          } else if (cmdPart === '/wallpaper') {
            found = { cmd: '/wallpaper', action: 'personalisation' };
          }
        }
        if (found) {
          promptInput.value = '';
          promptInput.style.height = 'auto';
          sendBtn.classList.remove('has-text');
          executeSlashCommand(found);
          return;
        }
      }

      if (text) {
        if (sentPromptsHistory.length === 0 || sentPromptsHistory[sentPromptsHistory.length - 1] !== text) {
          sentPromptsHistory.push(text);
        }
        promptHistoryIndex = sentPromptsHistory.length;
        tempPromptDraft = '';
      }

      promptInput.value = '';
      promptInput.style.height = 'auto';
      sendBtn.classList.remove('has-text');
      attachedImages = [];
      renderImageAttachments();
      attachedFiles = [];
      renderAttachedFiles();

      let fullText = text;
      if (filesToSend.length > 0) {
        const filePrefix = filesToSend.map(function(f) {
          return '[Attached File: ' + (f.path || f.name) + ']';
        }).join(String.fromCharCode(10));
        fullText = filePrefix + (fullText ? String.fromCharCode(10) + fullText : '');
      }

      const promptPayload = fullText || (imagesToSend.length > 0 ? 'Please inspect attached image' : 'Please inspect attached files');

      if (isRunning) {
        promptQueue.push({ text: promptPayload, images: imagesToSend, sessionId: currentSessionId });
        renderQueue();
        return;
      }
      dispatchPrompt(promptPayload, true, imagesToSend);
    }

    function dispatchPrompt(text, attachContext, images) {
      try {
        console.log('[Andromity webview] dispatchPrompt sending:', text.slice(0,120));
        lastTurnPrompt = {
          text: text,
          attachContext: attachContext,
          images: images || [],
          sessionId: currentSessionId,
        };
        hideZeroState();

        const activeSessName = document.getElementById('active-session-name');
        if (activeSessName && (activeSessName.textContent === 'Main Session' || activeSessName.textContent === 'new-session' || activeSessName.textContent.startsWith('Session '))) {
          const cleanFirstLine = text.replace(/\\[Attached File:[^\\]\\r\\n]+\\]/g, '').trim().split(String.fromCharCode(10))[0].trim();
          if (cleanFirstLine) {
            let shortTitle = cleanFirstLine.slice(0, 32);
            if (cleanFirstLine.length > 32) shortTitle += '...';
            activeSessName.textContent = shortTitle;
          }
        }

        userScrolledUp = false;
        appendUserMessage(text, images, new Date().toISOString());
        startAssistantTurn();
        scrollToBottom(false);
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

    function flushQueue() {
      if (promptQueue.length === 0) return;
      const idx = promptQueue.findIndex(q => !q.sessionId || q.sessionId === currentSessionId);
      if (idx === -1) return;
      const next = promptQueue.splice(idx, 1)[0];
      renderQueue();
      if (typeof next === 'object' && next !== null) {
        dispatchPrompt(next.text || '', true, next.images || []);
      } else {
        dispatchPrompt(next, true, []);
      }
    }

    function renderQueue() {
      const sessionQueue = promptQueue.filter(q => !q.sessionId || q.sessionId === currentSessionId);
      if (sessionQueue.length === 0) {
        queueContainer.style.display = 'none';
        queueContainer.innerHTML = '';
        return;
      }
      queueContainer.style.display = 'flex';
      queueContainer.innerHTML = promptQueue.map((q, i) => {
        if (q.sessionId && q.sessionId !== currentSessionId) return '';
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

    function highlightCode(code, lang) {
      if (!code) return '';
      const language = (lang || '').toLowerCase().trim();
      let escaped = String(code)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      const jsKw = '\\\\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|yield|null|undefined|true|false)\\\\b';
      const pyKw = '\\\\b(def|class|return|if|elif|else|for|while|try|except|finally|raise|import|from|as|with|lambda|yield|pass|break|continue|None|True|False|is|not|in|and|or|async|await)\\\\b';
      const shKw = '\\\\b(echo|cd|ls|cat|mkdir|rm|cp|mv|git|npm|uv|pip|python|node|npx|chmod|chown|curl|wget|grep|sed|awk|if|then|fi|elif|else|for|do|done|while|case|esac)\\\\b';
      const jsonKw = '\\\\b(true|false|null)\\\\b';

      let kw = jsKw;
      if (language === 'py' || language === 'python') kw = pyKw;
      else if (language === 'sh' || language === 'bash' || language === 'shell' || language === 'zsh') kw = shKw;
      else if (language === 'json') kw = jsonKw;

      const salt = Math.random().toString(36).slice(2, 8);
      const placeholders = [];
      const saveToken = function(cls, text) {
        const id = '___TOK_' + salt + '_' + placeholders.length + '___';
        placeholders.push('<span class="' + cls + '">' + text + '</span>');
        return id;
      };

      escaped = escaped.replace(/("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\x60(?:[^\\x60\\\\]|\\\\.)*\\x60)/g, function(str) { return saveToken('tok-string', str); });
      escaped = escaped.replace(/(\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)/g, function(cmt) { return saveToken('tok-comment', cmt); });
      escaped = escaped.replace(/\\b(\\d+(?:\\.\\d+)?)\\b/g, function(num) { return saveToken('tok-number', num); });
      escaped = escaped.replace(new RegExp(kw, 'g'), function(k) { return saveToken('tok-keyword', k); });
      escaped = escaped.replace(/\\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\\s*\\()/g, function(fn) { return saveToken('tok-fn', fn); });

      for (let i = 0; i < placeholders.length; i++) {
        escaped = escaped.split('___TOK_' + salt + '_' + i + '___').join(placeholders[i]);
      }
      return escaped;
    }

    try {
      if (typeof marked !== 'undefined') {
        const markedRenderer = {
          code(token) {
            const text = token && typeof token === 'object' ? (token.text || '') : String(token || '');
            const lang = token && typeof token === 'object' ? (token.lang || 'code') : 'code';
            const language = (lang || 'code').trim();
            const enc = encodeURIComponent(text);
            const highlighted = highlightCode(text, language);
            return '<div class="code-block-container">' +
              '<div class="code-block-header">' +
                '<span class="code-lang-tag">' + escapeHtml(language.toUpperCase()) + '</span>' +
                '<div class="code-block-actions">' +
                  '<button class="code-btn" data-code="' + enc + '" data-action="copy-code"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy</button>' +
                  '<button class="code-btn" data-code="' + enc + '" data-action="apply-code"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg> Insert</button>' +
                '</div>' +
              '</div>' +
              '<pre class="code-block-pre"><code>' + highlighted + '</code></pre>' +
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
            if (href.startsWith('file://')) {
              var fpath = href.startsWith('file:///') ? href.slice(8) : href.slice(7);
              var line = 0;
              var hashMatch = href.match(/#L(\d+)/i);
              if (hashMatch) line = parseInt(hashMatch[1], 10);
              return '<a href="#" class="md-file-link" data-action="open-file" data-file-path="' + escapeHtml(fpath) + '"' + (line ? (' data-line="' + line + '"') : '') + ' style="color:var(--accent); text-decoration:underline;"' + (title ? (' title="' + escapeHtml(title) + '"') : '') + '>' + text + '</a>';
            }
            return '<a href="' + escapeHtml(href) + '" target="_blank" style="color:var(--accent); text-decoration:underline;"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + text + '</a>';
          },
          image(token) {
            const href = token && typeof token === 'object' ? (token.href || '') : String(token || '');
            const title = token && typeof token === 'object' ? token.title : '';
            const text = token && typeof token === 'object' ? token.text : '';
            return '<img class="md-image" src="' + escapeHtml(href) + '" alt="' + escapeHtml(text || '') + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + ' loading="lazy" />';
          },
          checkbox(token) {
            const isChecked = Boolean(token && token.checked);
            return '<input type="checkbox" class="md-checkbox" ' + (isChecked ? 'checked ' : '') + 'disabled /> ';
          },
          listitem(token) {
            const isTask = Boolean(token && token.task);
            const isChecked = Boolean(token && token.checked);
            const self = this;
            const content = token && token.tokens && self.parser ? self.parser.parse(token.tokens) : (token && token.text ? renderInline(token.text) : '');
            if (isTask) {
              return '<li class="md-task-item' + (isChecked ? ' completed' : '') + '">' + content + '</li>';
            }
            return '<li>' + content + '</li>';
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
      t = t.replace(/\\*([^*\\n]+)\\*/g, '<em>$1</em>');
      t = t.replace(/(?:^|(?<=[\\s(\\[{\\'"]))_([^_]+)_(?=[\\s.,;:!?)}\\'"]|$)/g, '<em>$1</em>');

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
            '<pre class="code-block-pre"><code>' + highlightCode(code.trim(), lang) + '</code></pre>' +
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

            // HTML details, summary, and custom error card elements
            if (trimmed.startsWith('<details') || trimmed.startsWith('</details') || trimmed.startsWith('<summary') || trimmed.startsWith('</summary') || trimmed.startsWith('<div') || trimmed.startsWith('</div') || trimmed.startsWith('<span') || trimmed.startsWith('</span') || trimmed.startsWith('<button') || trimmed.startsWith('</button') || trimmed.startsWith('<code') || trimmed.startsWith('</code') || trimmed.startsWith('<pre') || trimmed.startsWith('</pre')) {
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
              var rawAligns = sepLine.replace(/^\\|/, '').replace(/\\|$/, '').split('|');
              var aligns = [];
              for (var a = 0; a < rawAligns.length; a++) {
                var s = rawAligns[a].trim();
                if (s.startsWith(':') && s.endsWith(':')) aligns.push('center');
                else if (s.endsWith(':')) aligns.push('right');
                else aligns.push('left');
              }
              var rawHeaders = tableLines[0].replace(/^\\|/, '').replace(/\\|$/, '').split('|');
              var tableHtml = '<div class="table-scroll-wrapper"><table class="md-table"><thead><tr>';
              for (var h = 0; h < rawHeaders.length; h++) {
                var al = aligns[h] || 'left';
                tableHtml += '<th style="text-align:' + al + ';">' + renderInline(rawHeaders[h].trim()) + '</th>';
              }
              tableHtml += '</tr></thead><tbody>';
              for (var r = 1; r < tableLines.length; r++) {
                var cells = tableLines[r].replace(/^\\|/, '').replace(/\\|$/, '').split('|');
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
              html += '<div class="md-task-item' + (isChecked ? ' completed' : '') + '"><input type="checkbox" class="md-checkbox" ' + (isChecked ? 'checked' : '') + ' disabled><span class="md-task-text ' + (isChecked ? 'completed' : '') + '">' + renderInline(taskMatch[2]) + '</span></div>';
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
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
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

    function extractMessageText(content) {
      if (content == null) return '';
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map(function(part) {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
          return '';
        }).join('');
      }
      if (typeof content === 'object' && typeof content.text === 'string') return content.text;
      try { return String(content); } catch (e) { return ''; }
    }

    function transcriptHasUserPrompt(messages) {
      return (messages || []).some(function(m) {
        if (!m || m.role !== 'user') return false;
        const text = extractMessageText(m.content).trim();
        if (!text) return false;
        if (text.startsWith('[Conversation summary') || text.startsWith('[Previous context summary')) return false;
        return true;
      });
    }

    function captureTranscriptForTab() {
      const out = [];
      if (!chatContainer) return out;
      const children = chatContainer.children;
      for (let i = 0; i < children.length; i++) {
        const el = children[i];
        if (el.classList.contains('message-wrap') && el.classList.contains('user')) {
          const textEl = el.querySelector('.prompt-text-content');
          const images = Array.prototype.map.call(el.querySelectorAll('.prompt-image-thumb'), function(img) { return img.src; }).filter(Boolean);
          out.push({ role: 'user', content: (textEl && textEl.textContent) || '', images: images });
        } else if (el.classList.contains('message-wrap') && el.classList.contains('assistant')) {
          const thinkEl = el.querySelector('.thinking-content');
          const textNodes = el.querySelectorAll('.assistant-text');
          let asstText = '';
          for (let t = 0; t < textNodes.length; t++) {
            if (t) asstText += '\\n\\n';
            asstText += textNodes[t].textContent || '';
          }
          out.push({ role: 'assistant', content: asstText, thinking: (thinkEl && thinkEl.textContent) || '' });
        }
      }
      return out;
    }

    function collectOpenTabPayload(includeTranscript) {
      return {
        queue: [...promptQueue],
        draft: promptInput ? promptInput.value : '',
        images: [...attachedImages],
        seedMessages: includeTranscript ? captureTranscriptForTab() : [],
      };
    }

    function applyTabComposerState(draft, images) {
      if (promptInput && typeof draft === 'string' && draft) {
        promptInput.value = draft;
        promptInput.style.height = 'auto';
        promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + 'px';
        if (sendBtn) sendBtn.classList.add('has-text');
      }
      if (Array.isArray(images) && images.length > 0) {
        attachedImages = [...images];
        renderImageAttachments();
      }
    }

    function formatTime(date) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function normalizePromptText(str) {
      if (typeof str !== 'string') return '';
      return str.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n').trim();
    }

    function parseUserPromptDisplay(rawText) {
      if (!rawText || typeof rawText !== 'string') {
        return { userText: '', files: [] };
      }

      let text = rawText.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
      const files = [];
      const seenFiles = new Set();

      function addFile(name, path) {
        const key = (path || name || '').toLowerCase();
        if (!key || seenFiles.has(key)) return;
        seenFiles.add(key);
        files.push({ name, path });
      }

      // 1. Separate ambient context block if present:
      const ambientSepMatch = text.match(/\\r?\\n\\s*---\\s*\\r?\\n(?=\\[(?:Active Document|Active Diagnostics|Selection in|Other Open Documents))/);
      let userPart = text;
      if (ambientSepMatch && typeof ambientSepMatch.index === 'number') {
        userPart = text.slice(0, ambientSepMatch.index);
      }

      // 2. Extract ONLY user-attached files: [Attached File: <path>]
      const attachedFileRegex = /\\[Attached File:\\s*([^\\]\\r\\n]+)\\]/g;
      let m;
      while ((m = attachedFileRegex.exec(userPart)) !== null) {
        const fullPath = m[1].trim();
        const fName = getPathBasename(fullPath);
        addFile(fName, fullPath);
      }
      userPart = userPart.replace(attachedFileRegex, '').trim();

      // 3. Strip any leaked ambient tags from user text without creating file pills
      userPart = userPart.replace(/\\[Active Document:[^\\]\\r\\n]+\\]/g, '').trim();
      userPart = userPart.replace(/\\[(?:Other Open Documents|Active Diagnostics|Selection in)[^\\]]*\\]/gs, '').trim();

      return { userText: userPart, files };
    }

    function appendUserMessage(text, images, ts, opts) {
      const rawText = typeof text === 'string' ? text : extractMessageText(text);
      const parsed = parseUserPromptDisplay(rawText);

      const trimmed = normalizePromptText(parsed.userText || '');
      const rawTrimmed = normalizePromptText(rawText);
      const now = Date.now();
      if (!opts || !opts.skipDedupe) {
        if ((trimmed && trimmed === lastAppendedUserText) || (rawTrimmed && rawTrimmed === lastAppendedUserText)) {
          if ((now - lastAppendedUserTime) < 5000) {
            return;
          }
        }
      }
      if (trimmed) {
        lastAppendedUserText = trimmed;
        lastAppendedUserTime = now;
      } else if (rawTrimmed) {
        lastAppendedUserText = rawTrimmed;
        lastAppendedUserTime = now;
      }

      const wrap = document.createElement('div');
      wrap.className = 'message-wrap user';
      const existingUserCount = chatContainer.querySelectorAll('.message-wrap.user').length;
      wrap.setAttribute('data-turn-index', String(existingUserCount));

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'user-prompt-actions';
      actionsDiv.innerHTML = '<button class="prompt-undo-btn" data-action="undo-turn" data-turn-index="' + existingUserCount + '" title="Undo to here">' +
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">' +
          '<path d="M3 7v6h6"></path>' +
          '<path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path>' +
        '</svg>' +
        '<span>Undo to here</span>' +
      '</button>';
      wrap.appendChild(actionsDiv);

      const msgDiv = document.createElement('div');
      msgDiv.className = 'message user prompt-card';

      if (images && Array.isArray(images) && images.length > 0) {
        const imgContainer = document.createElement('div');
        imgContainer.className = 'prompt-images-container';

        const prevBtn = document.createElement('button');
        prevBtn.className = 'carousel-nav-btn prev';
        prevBtn.setAttribute('data-action', 'carousel-prev');
        prevBtn.setAttribute('title', 'Scroll left');
        prevBtn.setAttribute('aria-label', 'Previous image');
        prevBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>';

        const nextBtn = document.createElement('button');
        nextBtn.className = 'carousel-nav-btn next';
        nextBtn.setAttribute('data-action', 'carousel-next');
        nextBtn.setAttribute('title', 'Scroll right');
        nextBtn.setAttribute('aria-label', 'Next image');
        nextBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>';

        const carousel = document.createElement('div');
        carousel.className = 'prompt-image-carousel';

        images.forEach(uri => {
          const imgEl = document.createElement('img');
          imgEl.src = uri;
          imgEl.className = 'prompt-image-thumb';
          imgEl.title = 'Click to preview full size';
          imgEl.addEventListener('click', (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            openImageLightbox(uri);
          });
          carousel.appendChild(imgEl);
        });

        imgContainer.appendChild(prevBtn);
        imgContainer.appendChild(carousel);
        imgContainer.appendChild(nextBtn);

        setTimeout(() => {
          if (carousel.scrollWidth > carousel.clientWidth + 4) {
            imgContainer.classList.add('has-overflow');
          }
        }, 50);

        msgDiv.appendChild(imgContainer);
      }

      if (parsed.files && parsed.files.length > 0) {
        const chipsContainer = document.createElement('div');
        chipsContainer.className = 'user-attached-chips';
        parsed.files.forEach(f => {
          const badgeInfo = getFileIconBadge(f.name || f.path);
          const chip = document.createElement('span');
          chip.className = 'user-file-chip';
          chip.setAttribute('data-action', 'open-file');
          chip.setAttribute('data-file-path', f.path || f.name);
          if (f.line) {
            chip.setAttribute('data-line', String(f.line));
          }
          chip.style.setProperty('--chip-color', badgeInfo.color);
          chip.title = (f.path || f.name) + (f.line ? ' (Line ' + f.line + ')' : '') + ' · Click to open file';

          const iconSpan = document.createElement('span');
          iconSpan.className = 'chip-icon';
          iconSpan.textContent = badgeInfo.badge;
          chip.appendChild(iconSpan);

          const nameSpan = document.createElement('span');
          nameSpan.className = 'chip-name';
          nameSpan.textContent = f.name;
          chip.appendChild(nameSpan);

          if (f.line) {
            const lineSpan = document.createElement('span');
            lineSpan.className = 'chip-line';
            lineSpan.textContent = ':' + f.line;
            chip.appendChild(lineSpan);
          }

          chipsContainer.appendChild(chip);
        });
        msgDiv.appendChild(chipsContainer);
      }

      if (parsed.userText) {
        const textWrapper = document.createElement('div');
        textWrapper.className = 'prompt-text-wrapper';

        const textContent = document.createElement('div');
        textContent.className = 'prompt-text-content';
        textContent.textContent = parsed.userText;
        textWrapper.appendChild(textContent);

        const isLong = parsed.userText.length > 220 || parsed.userText.split(/\\r?\\n/).length > 3;
        if (isLong) {
          textContent.classList.add('clamped');
          const expandBtn = document.createElement('button');
          expandBtn.className = 'prompt-expand-btn';
          expandBtn.setAttribute('data-action', 'toggle-prompt-expand');
          expandBtn.textContent = 'Show more ▾';
          textWrapper.appendChild(expandBtn);
        }

        msgDiv.appendChild(textWrapper);
      }

      wrap.appendChild(msgDiv);

      const footer = document.createElement('div');
      footer.className = 'message-footer';
      const timeStr = ts ? formatTime(new Date(ts)) : formatTime(new Date());
      footer.innerHTML = '<span>' + timeStr + '</span>' +
        '<button class="msg-copy-btn" data-action="copy-prompt" title="Copy prompt">' +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy' +
        '</button>';
      wrap.appendChild(footer);

      chatContainer.appendChild(wrap);
      scrollToBottom(false);
    }

    function appendCompactionSummaryCard(rawText) {
      const card = document.createElement('div');
      card.className = 'compaction-summary-card';

      let headerText = 'Earlier Conversation Turns Compacted';
      let bodyText = rawText || '';
      const firstLineEnd = rawText.indexOf('\\n');
      if (firstLineEnd !== -1) {
        const firstLine = rawText.substring(0, firstLineEnd).trim();
        headerText = firstLine.replace(/^\[|\]:?$/g, '').trim() || headerText;
        bodyText = rawText.substring(firstLineEnd + 1).trim();
      }

      card.innerHTML = '<div class="compaction-summary-header">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>' +
        '<span>' + escapeHtml(headerText) + '</span>' +
        '<span class="compaction-summary-tag">MEMORY</span>' +
        '<svg class="compaction-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
      '</div>' +
      '<div class="compaction-summary-body">' + renderMarkdown(bodyText) + '</div>';

      card.querySelector('.compaction-summary-header').addEventListener('click', () => {
        card.classList.toggle('expanded');
      });

      chatContainer.appendChild(card);
      scrollToBottomIfNeeded();
    }

    function appendCompactedHistoryBanner(count) {
      const banner = document.createElement('div');
      banner.className = 'compacted-history-banner';
      banner.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' +
        '<span>Previous conversation history (' + count + ' earlier messages preserved)</span>';
      chatContainer.appendChild(banner);
    }

    function showCompactionBanner(reason) {
      appendSystemNote(reason || 'Compacting conversation context to reduce token usage...');
    }

    function hideCompactionBannerWithSuccess(msg) {
      if (msg && msg.skipped) {
        appendSystemNote('Context is already compact: ' + (msg.reason || ''));
      } else if (msg && !msg.error) {
        appendSystemNote('Context compacted successfully: earlier turns summarized.');
      }
    }

    function appendSessionMessageCard(fromSession, content, messageType) {
      hideZeroState();
      const card = document.createElement('div');
      card.className = 'session-coagent-card';
      card.innerHTML = '<div class="session-card-header">' +
        '<span class="session-card-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg></span>' +
        '<span class="session-card-sender">Co-Agent [' + escapeHtml(fromSession || 'Agent') + ']</span>' +
        '<span class="session-card-badge">' + escapeHtml(messageType || 'message') + '</span>' +
        '</div>' +
        '<div class="session-card-content">' + renderMarkdown(content || '') + '</div>';
      chatContainer.appendChild(card);
      scrollToBottomIfNeeded();
    }

    function appendSessionQuestionCard(fromSession, question, questionId) {
      hideZeroState();
      const card = document.createElement('div');
      card.className = 'session-question-card';
      card.id = 'session-q-' + (questionId || '');
      card.innerHTML = '<div class="session-card-header question">' +
        '<span class="session-card-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg></span>' +
        '<span class="session-card-sender">Question from [' + escapeHtml(fromSession || 'Agent') + ']</span>' +
        (questionId ? '<span class="session-card-badge">ID: ' + escapeHtml(questionId) + '</span>' : '') +
        '</div>' +
        '<div class="session-card-content">' + renderMarkdown(question || '') + '</div>';
      chatContainer.appendChild(card);
      scrollToBottomIfNeeded();
    }

    function appendSessionAnswerCard(fromSession, answer, questionId) {
      hideZeroState();
      const card = document.createElement('div');
      card.className = 'session-answer-card';
      card.innerHTML = '<div class="session-card-header answer">' +
        '<span class="session-card-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' +
        '<span class="session-card-sender">Answer from [' + escapeHtml(fromSession || 'Agent') + ']</span>' +
        (questionId ? '<span class="session-card-badge">for ' + escapeHtml(questionId) + '</span>' : '') +
        '</div>' +
        '<div class="session-card-content">' + renderMarkdown(answer || '') + '</div>';
      chatContainer.appendChild(card);
      scrollToBottomIfNeeded();
    }

    function appendSharedStateCard(authorSession, key, value) {
      hideZeroState();
      const card = document.createElement('div');
      card.className = 'session-state-card';
      const valStr = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      card.innerHTML = '<div class="session-card-header">' +
        '<span class="session-card-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg></span>' +
        '<span class="session-card-sender">Shared State [' + escapeHtml(authorSession || 'Agent') + ']</span>' +
        '<span class="session-card-badge">' + escapeHtml(key || '') + '</span>' +
        '</div>' +
        '<div class="session-card-content"><code>' + escapeHtml(valStr) + '</code></div>';
      chatContainer.appendChild(card);
      scrollToBottomIfNeeded();
    }

    function appendHandoffCard(fromSession, toSession, taskSummary, handoffId) {
      hideZeroState();
      const card = document.createElement('div');
      card.className = 'session-coagent-card';
      card.innerHTML = '<div class="session-card-header">' +
        '<span class="session-card-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg></span>' +
        '<span class="session-card-sender">Handoff: ' + escapeHtml(fromSession || 'Agent') + ' → ' + escapeHtml(toSession || 'Agent') + '</span>' +
        (handoffId ? '<span class="session-card-badge">ID: ' + escapeHtml(handoffId) + '</span>' : '') +
        '</div>' +
        '<div class="session-card-content">' + renderMarkdown(taskSummary || '') + '</div>';
      chatContainer.appendChild(card);
      scrollToBottomIfNeeded();
    }

    function updateSessionActivityIndicator() {
      const dot = document.getElementById('session-activity-dot');
      if (!dot) return;
      const anyUnreadOrRunning = Object.keys(sessionsState).some(id => {
        return id !== currentSessionId && (sessionsState[id]?.hasUnread || sessionsState[id]?.isRunning);
      });
      dot.style.display = anyUnreadOrRunning ? 'inline-block' : 'none';
    }

    function copyMessageText(btn) {
      const wrap = btn.closest('.message-wrap');
      if (!wrap) return;
      let text = '';
      const promptTextEl = wrap.querySelector('.prompt-text-content');
      const userMsg = wrap.querySelector('.message.user');
      if (promptTextEl) {
        text = promptTextEl.textContent || '';
      } else if (userMsg) {
        text = userMsg.textContent || '';
      } else {
        if (wrap._rawMarkdown) {
          text = wrap._rawMarkdown;
        } else {
          const asstBlocks = wrap.querySelectorAll('.assistant-text');
          if (asstBlocks && asstBlocks.length > 0) {
            const parts = [];
            asstBlocks.forEach(function(block) {
              if (block._blockText) {
                parts.push(block._blockText);
              } else if (block._rawMarkdown) {
                parts.push(block._rawMarkdown);
              } else {
                try {
                  const clone = block.cloneNode(true);
                  clone.querySelectorAll('.code-block-header, .code-copy-btn, button').forEach(function(el) {
                    if (el.remove) el.remove();
                    else if (el.parentElement) el.parentElement.removeChild(el);
                  });
                  const bText = (clone.innerText || clone.textContent || '').trim();
                  if (bText) parts.push(bText);
                } catch (e) {
                  const bText = (block.innerText || block.textContent || '').trim();
                  if (bText) parts.push(bText);
                }
              }
            });
            text = parts.join('\\n\\n');
          }
        }
      }
      if (text) {
        copyToClipboard(text);
        const orig = btn.innerHTML;
        btn.innerHTML = '<span style="color:var(--green)">Copied!</span>';
        setTimeout(function() { btn.innerHTML = orig; }, 1500);
      }
    }
    window.copyMessageText = copyMessageText;

    let lastSoundPlayedAt = 0;
    function playSyntheticChime(kind) {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        if (kind === 'attention') {
          osc.frequency.setValueAtTime(659.25, now);
          osc.frequency.setValueAtTime(880.00, now + 0.12);
        } else {
          osc.frequency.setValueAtTime(880.00, now);
          osc.frequency.setValueAtTime(1174.66, now + 0.12);
        }

        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.35);
        setTimeout(function() { try { ctx.close(); } catch (_) {} }, 400);
      } catch (e) {
        console.warn('Synthetic chime failed:', e);
      }
    }

    function playTone(kind) {
      const now = Date.now();
      if (now - lastSoundPlayedAt < 1200) {
        return; // Prevent duplicate sound triggers in quick succession
      }
      lastSoundPlayedAt = now;
      try {
        const audio = document.getElementById('audio-done');
        if (audio) {
          audio.currentTime = 0;
          const p = audio.play();
          if (p && typeof p.catch === 'function') {
            p.catch(function(err) {
              console.warn('Audio element play failed, falling back to AudioContext synth:', err);
              playSyntheticChime(kind);
            });
          }
        } else {
          playSyntheticChime(kind);
        }
      } catch (e) {
        console.warn('Audio play failed:', e);
        playSyntheticChime(kind);
      }
    }

    let compactionBannerTimer = null;
    let compactionSafetyTimeout = null;

    function showCompactionBanner(reason) {
      const banner = document.getElementById('compaction-banner');
      const topCompactBtn = document.getElementById('btn-top-compact');
      if (topCompactBtn) {
        topCompactBtn.classList.add('compacting');
        topCompactBtn.title = 'Compacting context window in progress...';
      }
      if (compactionBannerTimer) {
        clearTimeout(compactionBannerTimer);
        compactionBannerTimer = null;
      }
      if (compactionSafetyTimeout) {
        clearTimeout(compactionSafetyTimeout);
        compactionSafetyTimeout = null;
      }
      if (banner) {
        banner.className = 'compaction-banner';
        banner.style.display = 'flex';
        const titleEl = document.getElementById('compaction-title');
        const detailEl = document.getElementById('compaction-detail');
        if (titleEl) titleEl.textContent = 'Compacting Conversation Context...';
        if (detailEl) detailEl.textContent = reason || 'Summarizing message history into dense semantic memory';
      }
      // Also append an inline working card in the chat messages stream if not already present
      let inlineCard = document.getElementById('inline-compaction-note');
      if (!inlineCard && chatContainer) {
        inlineCard = document.createElement('div');
        inlineCard.id = 'inline-compaction-note';
        inlineCard.className = 'inline-compaction-card';
        inlineCard.innerHTML = '<svg class="compaction-spin-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>' +
          '<span><strong>Context compaction in progress:</strong> ' + escapeHtml(reason || 'Summarizing history to free token window...') + '</span>';
        chatContainer.appendChild(inlineCard);
        scrollToBottomIfNeeded();
      }

      // Safety timeout: if daemon does not reply within 18 seconds, dismiss spinner
      compactionSafetyTimeout = setTimeout(() => {
        hideCompactionBannerWithSuccess({ error: 'Compaction timed out' });
      }, 18000);
    }

    function hideCompactionBannerWithSuccess(msg) {
      if (compactionSafetyTimeout) {
        clearTimeout(compactionSafetyTimeout);
        compactionSafetyTimeout = null;
      }
      if (compactionBannerTimer) {
        clearTimeout(compactionBannerTimer);
        compactionBannerTimer = null;
      }

      const banner = document.getElementById('compaction-banner');
      const topCompactBtn = document.getElementById('btn-top-compact');
      if (topCompactBtn) {
        topCompactBtn.classList.remove('compacting');
        topCompactBtn.title = 'Compact context window';
      }
      // Remove inline spinner card
      const inlineCard = document.getElementById('inline-compaction-note');
      if (inlineCard) {
        inlineCard.remove();
      }

      if (msg && msg.error) {
        if (banner) {
          banner.className = 'compaction-banner';
          const titleEl = document.getElementById('compaction-title');
          const detailEl = document.getElementById('compaction-detail');
          if (titleEl) titleEl.textContent = 'Compaction Skipped';
          if (detailEl) detailEl.textContent = msg.error;
          compactionBannerTimer = setTimeout(() => {
            banner.style.display = 'none';
          }, 3000);
        }
        appendSystemNote('Notice: ' + msg.error);
        return;
      }

      if (msg && msg.skipped) {
        const skippedReason = msg.reason || 'Conversation is already short — no compaction needed.';
        if (banner) {
          banner.className = 'compaction-banner success';
          const titleEl = document.getElementById('compaction-title');
          const detailEl = document.getElementById('compaction-detail');
          if (titleEl) titleEl.textContent = 'Context Already Clean';
          if (detailEl) detailEl.textContent = skippedReason;
          compactionBannerTimer = setTimeout(() => {
            banner.style.display = 'none';
            banner.className = 'compaction-banner';
          }, 2500);
        }
        appendSystemNote(skippedReason);
        return;
      }

      const oldCount = msg && msg.old_count !== undefined ? msg.old_count : (msg && msg.oldCount);
      const newCount = msg && msg.message_count !== undefined ? msg.message_count : (msg && msg.messageCount);
      let summaryText = 'Context compacted: conversation history compressed to save tokens.';
      if (oldCount && newCount && oldCount > newCount) {
        summaryText = 'Context compacted: ' + oldCount + ' messages compressed to ' + newCount + ' messages.';
      } else if (newCount) {
        summaryText = 'Context is already compact (' + newCount + ' messages).';
      }

      if (banner) {
        banner.className = 'compaction-banner success';
        const titleEl = document.getElementById('compaction-title');
        const detailEl = document.getElementById('compaction-detail');
        if (titleEl) titleEl.textContent = 'Compaction Complete';
        if (detailEl) detailEl.textContent = summaryText;

        compactionBannerTimer = setTimeout(() => {
          banner.style.display = 'none';
          banner.className = 'compaction-banner';
        }, 3000);
      }

      appendSystemNote(summaryText);
    }

    const MODE_ICONS = {
      safe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="m9 12 2 2 4-4"></path></svg>',
      trust: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path><path d="m9 13 2 2 4-4"></path></svg>',
      full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>',
      yolo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3z"></path></svg>'
    };

    function updateModeBadge(mode) {
      if (!mode) return;
      currentMode = mode.toLowerCase();
      if (activeModeLabel) activeModeLabel.textContent = currentMode.toUpperCase();
      
      const promptModeBtn = document.getElementById('btn-prompt-mode');
      const promptModeIcon = document.getElementById('prompt-mode-icon');
      const promptModeLabel = document.getElementById('prompt-mode-label');
      
      if (promptModeBtn) {
        promptModeBtn.className = 'prompt-btn mode-' + currentMode;
      }
      if (promptModeIcon && MODE_ICONS[currentMode]) {
        promptModeIcon.innerHTML = MODE_ICONS[currentMode];
      }
      if (promptModeLabel) {
        promptModeLabel.textContent = currentMode.toUpperCase();
        promptModeLabel.classList?.remove?.('skeleton', 'skeleton-text');
        if (typeof promptModeLabel.removeAttribute === 'function') {
          promptModeLabel.removeAttribute('aria-busy');
        }
      }

      const titles = {
        safe: 'SAFE Mode: Confirms before every file edit and shell command (Click to cycle)',
        trust: 'TRUST Mode: Auto-approves file writes in workspace; prompts for commands (Click to cycle)',
        full: 'FULL Mode: Auto-approves all tool actions and logs to stream (Click to cycle)',
        yolo: 'YOLO Mode: Autonomous silent execution (Click to cycle)'
      };
      const title = titles[currentMode] || 'Permission Governance Mode (Click to cycle)';
      if (promptModeBtn) promptModeBtn.title = title;

      const modeBtn = document.getElementById('btn-mode-cycle');
      if (modeBtn) {
        modeBtn.className = 'mode-badge-btn mode-' + currentMode;
        modeBtn.title = title;
      }
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
      document.querySelector('.prompt-box')?.classList.add('is-generating');
      if (promptInput) { promptInput.setAttribute('aria-busy','true'); }
      if (sendBtn) sendBtn.setAttribute('disabled','true');
      if (currentSessionId) {
        sessionsState[currentSessionId] = sessionsState[currentSessionId] || {};
        sessionsState[currentSessionId].isRunning = true;
      }
      turnEditedFiles.clear();
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
        '<img src="' + sidebarIconUri + '" width="14" height="14" alt="Andromity" />' +
      '</div>' +
      '<span class="assistant-name">Andromity</span>';
      wrap.appendChild(header);

      if (typeof interruptMascotToWork === 'function') {
        interruptMascotToWork();
      }

      const loader = document.createElement('div');
      loader.className = 'andromity-turn-loader';
      loader.id = 'turn-loading-indicator';
      loader.innerHTML = '<span class="thinking-spinner"></span> <span class="thinking-text">Andromity is thinking... (0s)</span>';
      wrap.appendChild(loader);

      const loaderTimer = setInterval(() => {
        const textSpan = loader.querySelector('.thinking-text');
        if (!textSpan || !document.getElementById('turn-loading-indicator')) {
          clearInterval(loaderTimer);
          return;
        }
        const elapsed = Math.floor((Date.now() - currentTurnStartTime) / 1000);
        if (elapsed < 6) {
          textSpan.textContent = 'Andromity is thinking... (' + elapsed + 's)';
        } else if (elapsed < 16) {
          textSpan.textContent = 'Contacting ' + (currentModel || 'model') + '... (' + elapsed + 's)';
        } else {
          textSpan.textContent = 'Waiting for ' + (currentProvider || 'provider') + ' stream... (' + elapsed + 's)';
        }
      }, 1000);

      currentAssistantContent = null;
      accumulatedAssistantText = '';

      chatContainer.appendChild(wrap);
      scrollToBottomIfNeeded();
    }

    function getLangBadgeHtml(filePath) {
      const parts = filePath.split('.');
      const ext = parts.length > 1 ? parts.pop().toLowerCase().trim() : '';
      const displayExt = ext ? (ext.length <= 4 ? ext : ext.substring(0, 4)) : 'file';
      const safeClass = ext ? 'lang-' + escapeHtml(ext) : 'lang-default';
      return '<span class="files-changed-lang-tag ' + safeClass + '">' + escapeHtml(displayExt) + '</span>';
    }

    function createFilesChangedCard(filePathsSet) {
      if (!filePathsSet) return null;
      const seen = new Map();
      Array.from(filePathsSet).forEach(filePath => {
        if (!filePath || typeof filePath !== 'string') return;
        const norm = filePath.replace(/\\\\/g, '/').trim();
        const base = norm.split('/').pop().toLowerCase();
        if (!seen.has(base) || norm.length > seen.get(base).length) {
          seen.set(base, norm);
        }
      });
      const files = Array.from(seen.values());
      if (files.length === 0) return null;

      const card = document.createElement('div');
      card.className = 'files-changed-card';
      try {
        card.setAttribute('data-turn-files', JSON.stringify(files));
      } catch (err) {}

      const header = document.createElement('div');
      header.className = 'files-changed-header';
      header.innerHTML = '<span class="files-changed-title">' + files.length + ' File' + (files.length > 1 ? 's' : '') + ' Changed</span>' +
        '<button class="files-changed-review-btn" data-action="open-review-tab" title="Review All Changes in Git Diff">Review</button>';
      card.appendChild(header);

      const list = document.createElement('div');
      list.className = 'files-changed-list';

      const MAX_PREVIEW = 4;
      files.forEach((filePath, idx) => {
        const row = document.createElement('div');
        row.className = 'files-changed-row' + (idx >= MAX_PREVIEW ? ' files-changed-extra' : '');
        if (idx >= MAX_PREVIEW) row.style.display = 'none';
        row.setAttribute('data-action', 'open-review-tab');
        row.setAttribute('data-file-path', filePath);
        row.setAttribute('title', 'Click to review diff for ' + filePath);

        const normalizedKey = filePath.replace(/\\\\/g, '/').trim();
        const filename = normalizedKey.split('/').pop() || filePath;

        let stat = globalDiffStats[normalizedKey];
        if (!stat) {
          for (const k in globalDiffStats) {
            const normK = k.replace(/\\\\/g, '/');
            if (normalizedKey.endsWith(normK) || normK.endsWith(normalizedKey) || normalizedKey.endsWith('/' + normK) || normK.endsWith('/' + normalizedKey)) {
              stat = globalDiffStats[k];
              break;
            }
          }
        }

        let statsHtml = '';
        if (stat && (stat.additions > 0 || stat.deletions > 0)) {
          if (stat.additions > 0) statsHtml += '<span class="files-stat-add">+' + stat.additions + '</span>';
          if (stat.deletions > 0) statsHtml += '<span class="files-stat-del">-' + stat.deletions + '</span>';
          statsHtml += '<span class="chip-diff-label" style="margin-left:4px;">Diff</span>';
        } else {
          statsHtml = '<span class="chip-diff-label">Diff</span>';
        }

        row.innerHTML = '<div class="files-changed-row-left">' +
          getLangBadgeHtml(filename) +
          '<span class="files-changed-name">' + escapeHtml(filename) + '</span>' +
        '</div>' +
        '<div class="files-changed-row-stats">' + statsHtml + '</div>';

        list.appendChild(row);
      });

      card.appendChild(list);

      if (files.length > MAX_PREVIEW) {
        const moreBtn = document.createElement('button');
        moreBtn.className = 'files-changed-more-btn';
        moreBtn.setAttribute('data-action', 'toggle-more-files');
        moreBtn.textContent = '... Show ' + (files.length - MAX_PREVIEW) + ' more';
        card.appendChild(moreBtn);
      }

      try {
        vscode.postMessage({ type: 'get_file_diff_stats' });
      } catch {}

      return card;
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
      document.querySelector('.prompt-box')?.classList.remove('is-generating');
      if (promptInput) promptInput.removeAttribute('aria-busy');
      if (sendBtn) sendBtn.removeAttribute('disabled');
      if (currentSessionId && sessionsState[currentSessionId]) {
        sessionsState[currentSessionId].isRunning = false;
      }
      cancelBtn.innerHTML = CANCEL_BTN_STOP_ICON;
      cancelBtn.disabled = false;
      cancelBtn.style.opacity = '';
      cancelBtn.style.display = 'none';
      sendBtn.style.display = 'flex';

      if (currentTurnAssistantDiv) {
        if (turnEditedFiles.size > 0) {
          const card = createFilesChangedCard(turnEditedFiles);
          if (card) currentTurnAssistantDiv.appendChild(card);
        }
        turnEditedFiles.clear();

        const elapsedSec = ((Date.now() - currentTurnStartTime) / 1000).toFixed(1);
        currentTurnAssistantDiv._rawMarkdown = accumulatedAssistantText;
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
        scrollToBottomIfNeeded();
      }

      currentTurnAssistantDiv = null;
      currentThinkingDiv = null;
      currentThinkingContent = null;
      currentAssistantContent = null;
      accumulatedAssistantText = '';
      if (typeof celebrateMascot === 'function') {
        celebrateMascot();
      }
      renderConversationTimeline();
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
        case 'file_attached': {
          if (msg.file) {
            addDroppedFileAttachment(msg.file);
          }
          break;
        }
        case 'set_mascot_enabled': {
          setMascotEnabled(msg.enabled !== false);
          break;
        }
        case 'file_diff_stats_result': {
          if (msg.stats) {
            globalDiffStats = Object.assign(globalDiffStats || {}, msg.stats);
            document.querySelectorAll('.files-changed-row').forEach(row => {
              const fPath = row.getAttribute('data-file-path');
              if (!fPath) return;
              const normalized = fPath.replace(/\\\\/g, '/').trim();
              let s = globalDiffStats[normalized];
              if (!s) {
                for (const k in globalDiffStats) {
                  const normK = k.replace(/\\\\/g, '/');
                  if (normalized.endsWith(normK) || normK.endsWith(normalized) || normalized.endsWith('/' + normK) || normK.endsWith('/' + normalized)) {
                    s = globalDiffStats[k];
                    break;
                  }
                }
              }
              if (s) {
                const statsEl = row.querySelector('.files-changed-row-stats');
                if (statsEl) {
                  let html = '';
                  if (s.additions > 0) html += '<span class="files-stat-add">+' + s.additions + '</span>';
                  if (s.deletions > 0) html += '<span class="files-stat-del">-' + s.deletions + '</span>';
                  if (s.additions > 0 || s.deletions > 0) {
                    html += '<span class="chip-diff-label" style="margin-left:4px;">Diff</span>';
                  } else {
                    html += '<span class="chip-diff-label">Diff</span>';
                  }
                  if (html) statsEl.innerHTML = html;
                }
              }
            });
          }
          break;
        }
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
          if (typeof msg.mascotEnabled === 'boolean') {
            setMascotEnabled(msg.mascotEnabled);
          }
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
          if (msg.currentPlan && msg.currentPlan.steps && msg.currentPlan.steps.length > 0) {
            updatePlanTracker(msg.currentPlan);
          } else if (planTrackerStrip) {
            planTrackerStrip.style.display = 'none';
          }
          if (msg.models && msg.models.length > 0) {
            allModels = msg.models;
          }
          if (msg.providers) {
            allProviders = msg.providers;
          }
          updateModelBadge();
          updateOnboardingVisibility();
          if (msg.ollamaDetectedModel) {
            showOllamaBanner(msg.ollamaDetectedModel);
          }
          if (msg.ollamaStatus) {
            updateOllamaStatusUI(msg.ollamaStatus);
          }
          if (msg.waterfallFirstSessionShown) {
            dismissWaterfallOnboarding();
          } else {
            checkWaterfallOnboarding(msg.waterfallFirstSessionShown);
          }
          break;

        case 'ollama_status_updated': {
          updateOllamaStatusUI(msg.status);
          break;
        }

        case 'dismiss_waterfall_callout':
          dismissWaterfallOnboarding();
          break;

        case 'show_waterfall_tooltip':
          checkWaterfallOnboarding(false);
          break;

        case 'trust_updated':
          if (msg.isTrusted) {
            trustBanner.style.display = 'none';
            appendSystemNote('Workspace trusted — file editing and shell execution enabled.');
          } else {
            trustBanner.style.display = 'flex';
            appendSystemNote('Workspace untrusted — file editing and shell execution restricted.');
          }
          break;

        case 'config_updated':
          if (msg.key === 'mode') {
            updateModeBadge(msg.value);
            if (msg.value !== 'safe') {
              const appCard = interactiveSlot.querySelector('.permission-card, .approval-card');
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
          if (currentSessionId) {
            sessionsState[currentSessionId] = sessionsState[currentSessionId] || {};
            sessionsState[currentSessionId].draftInput = promptInput ? promptInput.value : '';
            try { sessionDomCache.set(currentSessionId, { html: chatContainer.innerHTML, isRunning: isRunning }); } catch {}
            // Detach live turn state — next session must not reuse previous turn divs
            currentTurnAssistantDiv = null;
            currentThinkingDiv = null;
            currentThinkingContent = null;
            currentAssistantContent = null;
            currentToolSequence = null;
          }
          if (msg.sessionId) {
            currentSessionId = msg.sessionId;
          }
          if (sessionsState[currentSessionId]) {
            sessionsState[currentSessionId].hasUnread = false;
          }
          updateSessionActivityIndicator();
          removeTurnLoader();
          finishCurrentThinking();
          interactiveSlot.innerHTML = '';
          if (planTrackerStrip) planTrackerStrip.style.display = 'none';
          {
            const sessState = sessionsState[currentSessionId];
            if (sessState && sessState.pendingApproval) {
              interactiveSlot.innerHTML = renderPermissionCard(sessState.pendingApproval);
            } else if (sessState && sessState.pendingPlanApproval) {
              interactiveSlot.innerHTML = renderPlanApprovalCard(sessState.pendingPlanApproval);
            }
            if (sessState && sessState.isRunning) {
              isRunning = true;
              cancelBtn.style.display = 'flex';
              sendBtn.style.display = 'none';
              document.querySelector('.prompt-box')?.classList.add('is-generating');
            } else {
              isRunning = false;
              cancelBtn.style.display = 'none';
              sendBtn.style.display = 'flex';
              document.querySelector('.prompt-box')?.classList.remove('is-generating');
            }
            if (promptInput) {
              promptInput.value = (sessState && sessState.draftInput) || '';
              promptInput.style.height = 'auto';
            }
            renderQueue();
            scrollToBottom(false);
          }
          break;

        case 'session_loaded':
          removeTurnLoader();
          finishCurrentThinking();
          chatContainer.innerHTML = '';
          interactiveSlot.innerHTML = '';
          if (msg.session && msg.session.id) {
            currentSessionId = msg.session.id;
          }
          const sessionIsRunning = Boolean(
            (msg.session && (msg.session.status === 'running' || msg.session.is_running)) ||
            (sessionsState[currentSessionId] && sessionsState[currentSessionId].isRunning)
          );
          sessionsState[currentSessionId] = sessionsState[currentSessionId] || {};
          sessionsState[currentSessionId].isRunning = sessionIsRunning;
          if (sessionIsRunning) {
            isRunning = true;
            cancelBtn.style.display = 'flex';
            sendBtn.style.display = 'none';
            document.querySelector('.prompt-box')?.classList.add('is-generating');
          } else {
            isRunning = false;
            cancelBtn.style.display = 'none';
            sendBtn.style.display = 'flex';
            document.querySelector('.prompt-box')?.classList.remove('is-generating');
          }
          if (promptInput && !msg.draft) {
            promptInput.value = (sessionsState[currentSessionId] && sessionsState[currentSessionId].draftInput) || '';
            promptInput.style.height = 'auto';
          }
          const activeSessName = document.getElementById('active-session-name');
          if (activeSessName && msg.session) {
            activeSessName.textContent = msg.session.name || msg.session.id || 'Main Session';
          }
          const hasCompactedHistory = msg.session && Array.isArray(msg.session.compacted_history) && msg.session.compacted_history.length > 0;
          let allMessages = [];
          if (hasCompactedHistory) {
            allMessages = allMessages.concat(msg.session.compacted_history.filter(m => m.role !== 'system'));
          }
          if (msg.session && Array.isArray(msg.session.messages) && msg.session.messages.length > 0) {
            allMessages = allMessages.concat(msg.session.messages.filter(m => {
              if (m.role === 'system') return false;
              if (m.role === 'assistant' && extractMessageText(m.content).trim() === 'Understood. I have the context of our earlier discussion and will continue from here.') {
                return false;
              }
              return true;
            }));
          }
          if (!transcriptHasUserPrompt(allMessages) && Array.isArray(msg.seedMessages) && msg.seedMessages.length > 0) {
            allMessages = msg.seedMessages;
          }

          lastAppendedUserText = '';
          lastAppendedUserTime = 0;

          if (allMessages.length > 0 || sessionIsRunning) {
            hideZeroState();
            if (hasCompactedHistory) {
              appendCompactedHistoryBanner(msg.session.compacted_history.length);
            }
            let lastUserMsgTs = null;
            let currentAssistantWrap = null;
            let currentTurnToolSeq = null;
            let currentTurnToolBody = null;
            let currentTurnToolCount = 0;
            let turnEditedFilesForLoad = new Set();

            for (let i = 0; i < allMessages.length; i++) {
              try {
              const m = allMessages[i];
              if (m.role === 'user') {
                lastUserMsgTs = m.ts || null;
                currentAssistantWrap = null;
                currentTurnToolSeq = null;
                currentTurnToolBody = null;
                currentTurnToolCount = 0;
                turnEditedFilesForLoad = new Set();

                const uContent = extractMessageText(m.content).trim();
                if (uContent.startsWith('[Conversation summary') || uContent.startsWith('[Previous context summary')) {
                  appendCompactionSummaryCard(uContent);
                } else {
                  try {
                    appendUserMessage(uContent, m.images || [], m.ts, { skipDedupe: true });
                  } catch (userRenderErr) {
                    console.error('[Andromity webview] Failed to render user prompt', userRenderErr);
                  }
                }
              } else if (m.role === 'assistant') {
                if (!currentAssistantWrap) {
                  currentAssistantWrap = document.createElement('div');
                  currentAssistantWrap.className = 'message-wrap assistant';

                  const hdr = document.createElement('div');
                  hdr.className = 'assistant-header';
                  hdr.innerHTML = '<div class="assistant-avatar">' +
                    '<img src="' + sidebarIconUri + '" width="14" height="14" alt="Andromity" />' +
                  '</div>' +
                  '<span class="assistant-name">Andromity</span>';
                  currentAssistantWrap.appendChild(hdr);
                  chatContainer.appendChild(currentAssistantWrap);
                }

                // 1. Thinking block (if any)
                const _thinking = m.thinking || '';
                if (_thinking.trim()) {
                  let thinkDuration = m.duration ? Number(m.duration).toFixed(1) : null;
                  if (!thinkDuration && m.ts && lastUserMsgTs) {
                    const delta = (new Date(m.ts).getTime() - new Date(lastUserMsgTs).getTime()) / 1000;
                    if (delta > 0 && delta < 3600) thinkDuration = delta.toFixed(1);
                  }
                  const thinkEl = document.createElement('div');
                  thinkEl.className = 'thinking-card';
                  const thinkLabel = thinkDuration ? ('thought (' + thinkDuration + 's)') : 'thought';
                  thinkEl.innerHTML = '<div class="thinking-header"><div class="thinking-pulse" style="opacity:0.4; animation:none;"></div><span>' + thinkLabel + '</span><svg class="thinking-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg></div><div class="thinking-content">' + escapeHtml(_thinking) + '</div>';
                  // Delegated listener handles header toggle without double-toggling
                  if (currentTurnToolBody) {
                    currentTurnToolBody.appendChild(thinkEl);
                  } else {
                    currentAssistantWrap.appendChild(thinkEl);
                  }
                }

                // 2. Tool calls (grouped into a single unified sector per turn)
                if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
                  if (!currentTurnToolSeq) {
                    currentTurnToolSeq = document.createElement('div');
                    currentTurnToolSeq.className = 'tool-sequence collapsed';
                    currentTurnToolSeq.innerHTML = '<div class="tool-seq-header">' +
                      '<svg class="tool-seq-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>' +
                      '<span class="tool-seq-title">0 tools · worked</span>' +
                      '<svg class="tool-seq-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
                      '<button class="tool-seq-copy" title="Copy tool log"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy</button>' +
                    '</div>' +
                    '<div class="tool-seq-body"></div>';

                    const seqEl = currentTurnToolSeq;
                    const copyBtn = seqEl.querySelector('.tool-seq-copy');
                    if (copyBtn) {
                      copyBtn.addEventListener('click', () => {
                        try {
                          const parts = [];
                          seqEl.querySelectorAll('.tool-card').forEach((c, idx) => {
                            const n = c.querySelector('.tool-title-group span')?.textContent || 'tool';
                            const args = c.querySelector('.tool-body')?.textContent || '';
                            parts.push((idx + 1) + '. ' + n + '\\n   Args: ' + args);
                          });
                          copyToClipboard(parts.join('\\n\\n') || seqEl.textContent);
                        } catch {}
                      });
                    }

                    currentTurnToolBody = seqEl.querySelector('.tool-seq-body');
                    if (!currentTurnToolBody) {
                      currentTurnToolBody = document.createElement('div');
                      currentTurnToolBody.className = 'tool-seq-body';
                      seqEl.appendChild(currentTurnToolBody);
                    }
                    currentAssistantWrap.appendChild(seqEl);
                  }

                  for (const tc of m.tool_calls) {
                    currentTurnToolCount++;
                    const fn = tc.function || {};
                    const toolName = fn.name || 'tool';
                    const toolArgs = fn.arguments || '';

                    const isWriteTool = /^(write_file|write_to_file|edit_file|edit_file_multi|multi_replace_file_content|replace_file_content|patch_file|create_file|delete_file|move_file|rename_file|save_file)$/.test(toolName);
                    if (isWriteTool) {
                      try {
                        const parsedArgs = typeof toolArgs === 'object' && toolArgs !== null ? toolArgs : JSON.parse(toolArgs);
                        const p = parsedArgs.path || parsedArgs.target_path || parsedArgs.target_file || parsedArgs.file_path || parsedArgs.TargetFile;
                        if (p) turnEditedFilesForLoad.add(p);
                        if (Array.isArray(parsedArgs.edits)) {
                          for (const e of parsedArgs.edits) {
                            const ep = e.path || e.target_path || e.file_path || e.TargetFile;
                            if (ep) turnEditedFilesForLoad.add(ep);
                          }
                        }
                      } catch {
                        const rawStr = String(toolArgs);
                        const m = rawStr.match(/"(?:TargetFile|file_path|target_file|target_path|path)"\s*:\s*"([^"]+)"/);
                        if (m && m[1]) {
                          turnEditedFilesForLoad.add(m[1]);
                        }
                      }
                      if (typeof window.parseFileEditStats === 'function') {
                        const es = window.parseFileEditStats(toolName, toolArgs);
                        if (es && es.filePath) {
                          const nKey = es.filePath.replace(/\\\\/g, '/').trim();
                          if (!globalDiffStats[nKey]) {
                            globalDiffStats[nKey] = { additions: 0, deletions: 0 };
                          }
                          globalDiffStats[nKey].additions += (es.additions || 0);
                          globalDiffStats[nKey].deletions += (es.deletions || 0);
                        }
                      }
                    }

                    var renderedActivity = null;
                    if (typeof window.renderAntigravityActivityRow === 'function') {
                      renderedActivity = window.renderAntigravityActivityRow(toolName, toolArgs, 'done');
                    }
                    if (!renderedActivity && typeof window.renderCommandActivityRow === 'function' && /^(shell_exec|run_command|bash|exec|cmd)$/i.test(toolName)) {
                      renderedActivity = window.renderCommandActivityRow(toolName, toolArgs, 'done');
                    }

                    if (renderedActivity) {
                      currentTurnToolBody.appendChild(renderedActivity);
                    } else {
                      const tDiv = document.createElement('div');
                      tDiv.className = 'tool-card';
                      tDiv.innerHTML = '<div class="tool-header">' +
                        '<div class="tool-title-group">' +
                          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>' +
                          '<span>' + escapeHtml(toolName) + '</span>' +
                        '</div>' +
                        '<div style="display:flex; align-items:center;">' +
                          '<span class="tool-tag" style="background:rgba(63,185,80,0.2); color:var(--green);">DONE</span>' +
                          '<svg class="tool-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
                        '</div>' +
                      '</div>' +
                      '<div class="tool-body">' + escapeHtml(toolArgs) + '</div>';
                      // Delegated listener handles tool-header click without double toggle
                      currentTurnToolBody.appendChild(tDiv);
                    }
                  }

                  const titleSpan = currentTurnToolSeq.querySelector('.tool-seq-title');
                  if (titleSpan) {
                    let toolDuration = m.duration ? Number(m.duration).toFixed(1) : null;
                    if (!toolDuration && m.ts && lastUserMsgTs) {
                      const delta = (new Date(m.ts).getTime() - new Date(lastUserMsgTs).getTime()) / 1000;
                      if (delta > 0 && delta < 3600) toolDuration = delta.toFixed(1);
                    }
                    const toolWord = currentTurnToolCount + (currentTurnToolCount === 1 ? ' tool' : ' tools');
                    titleSpan.textContent = toolWord + (toolDuration ? ' · worked for ' + toolDuration + 's' : ' · worked');
                  }
                }

                // 3. Text content in chronological order
                const _content = extractMessageText(m.content);
                if (_content.trim()) {
                  const textEl = document.createElement('div');
                  textEl.className = 'assistant-text';
                  textEl.innerHTML = renderMarkdown(_content);
                  textEl._rawMarkdown = _content;
                  currentAssistantWrap._rawMarkdown = (currentAssistantWrap._rawMarkdown ? (currentAssistantWrap._rawMarkdown + '\\n\\n') : '') + _content;
                  currentAssistantWrap.appendChild(textEl);
                  // Reset tool sequence pointer so subsequent tools create a new sequence after text
                  currentTurnToolSeq = null;
                  currentTurnToolBody = null;
                  currentTurnToolCount = 0;
                }

                // 4. End of assistant turn check (only close when no more assistant messages exist in this turn)
                let hasMoreAssistantInTurn = false;
                for (let j = i + 1; j < allMessages.length; j++) {
                  if (allMessages[j].role === 'user') break;
                  if (allMessages[j].role === 'assistant') {
                    hasMoreAssistantInTurn = true;
                    break;
                  }
                }

                if (!hasMoreAssistantInTurn) {
                  currentTurnToolSeq = null;
                  currentTurnToolBody = null;
                  currentTurnToolCount = 0;
                  if (turnEditedFilesForLoad.size > 0) {
                    const card = createFilesChangedCard(turnEditedFilesForLoad);
                    if (card) currentAssistantWrap.appendChild(card);
                  }

                  let elapsedSec = m.duration ? Number(m.duration).toFixed(1) : null;
                  if (!elapsedSec && m.ts && lastUserMsgTs) {
                    const delta = (new Date(m.ts).getTime() - new Date(lastUserMsgTs).getTime()) / 1000;
                    if (delta > 0 && delta < 3600) {
                      elapsedSec = delta.toFixed(1);
                    }
                  }
                  const timeStr = m.ts ? formatTime(new Date(m.ts)) : formatTime(new Date());
                  const badgeText = elapsedSec ? (elapsedSec + 's · ' + timeStr) : timeStr;

                  const footer = document.createElement('div');
                  footer.className = 'message-footer';
                  footer.innerHTML = '<span class="turn-duration-badge">' +
                    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:2px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' +
                    '<span>' + badgeText + '</span>' +
                  '</span>' +
                  '<button class="msg-copy-btn" data-action="copy-message" title="Copy response">' +
                    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy' +
                  '</button>';
                  currentAssistantWrap.appendChild(footer);
                  currentAssistantWrap = null;
                }
              }
              } catch (replayErr) {
                console.error('[Andromity webview] Failed to replay history message', replayErr);
              }
            }
          } else {
            showZeroState();
          }
          applyTabComposerState(msg.draft, msg.images);
          if (msg.session) {
            currentSessionId = msg.session.id || currentSessionId;
            if (msg.session.model) {
              currentModel = msg.session.model;
              if (msg.session.provider) currentProvider = msg.session.provider;
              updateModelBadge();
            }
            updateTokenDisplay(msg.session);
            if (msg.session && msg.session.plan && msg.session.plan.steps && msg.session.plan.steps.length > 0) {
              updatePlanTracker(msg.session.plan);
            } else if (planTrackerStrip) {
              planTrackerStrip.style.display = 'none';
            }
          }
          // Replay any live buffered deltas that arrived while this session was in background
          {
            const buffered = sessionLiveBuffer.get(currentSessionId);
            if (buffered && buffered.length > 0) {
              // Ensure a live turn wrapper exists to append into
              const needTurn = !currentTurnAssistantDiv || !chatContainer.contains(currentTurnAssistantDiv);
              if (needTurn) {
                // Create a continuation wrapper that visually continues the last assistant turn
                // If chat already ends with an assistant wrap, reuse it; else start a new turn
                const lastWrap = chatContainer.querySelector('.message-wrap.assistant:last-of-type');
                if (lastWrap && buffered.some(e => e.t==='text_delta' || e.t==='tool_start')) {
                  currentTurnAssistantDiv = lastWrap;
                  // find or create assistant-text slot
                  let found = lastWrap.querySelector('.assistant-text');
                  if (found) { currentAssistantContent = found; }
                }
                if (!currentTurnAssistantDiv || !chatContainer.contains(currentTurnAssistantDiv)) {
                  startAssistantTurn();
                } else {
                  // mark as running so prompt aura matches background session state
                  const st = sessionsState[currentSessionId];
                  if (st && st.isRunning) { isRunning = true; document.querySelector('.prompt-box')?.classList.add('is-generating'); cancelBtn.style.display='flex'; sendBtn.style.display='none'; }
                }
              }
              for (const ev of buffered) {
                if (ev.t === 'thinking_delta') {
                  if (!currentThinkingDiv) {
                    thinkingStartTime = Date.now();
                    currentThinkingDiv = document.createElement('div');
                    currentThinkingDiv.className = 'thinking-card expanded';
                    currentThinkingDiv.innerHTML = '<div class="thinking-header"><div class="thinking-pulse"></div><span>thinking...</span><svg class="thinking-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg></div>';
                    currentThinkingContent = document.createElement('div');
                    currentThinkingContent.className = 'thinking-content';
                    currentThinkingDiv.appendChild(currentThinkingContent);
                    if (currentToolSequence) currentToolSequence.querySelector('.tool-seq-body').appendChild(currentThinkingDiv);
                    else if (currentTurnAssistantDiv) currentTurnAssistantDiv.appendChild(currentThinkingDiv);
                  }
                  if (currentThinkingContent) { currentThinkingContent.textContent += ev.text; currentThinkingContent.scrollTop = currentThinkingContent.scrollHeight; }
                } else if (ev.t === 'text_delta') {
                  removeTurnLoader(); finishCurrentThinking(); if (currentToolSequence) finishToolSequence();
                  if (!currentAssistantContent) {
                    currentAssistantContent = document.createElement('div');
                    currentAssistantContent.className = 'assistant-text';
                    currentAssistantContent._blockText = '';
                    if (currentTurnAssistantDiv) currentTurnAssistantDiv.appendChild(currentAssistantContent);
                  }
                  currentAssistantContent._blockText = (currentAssistantContent._blockText||'') + ev.text;
                  currentAssistantContent.innerHTML = renderMarkdown(currentAssistantContent._blockText);
                } else if (ev.t === 'tool_start') {
                  removeTurnLoader(); finishCurrentThinking(); currentAssistantContent = null;
                  const seq = ensureToolSequence(); toolSeqCount++; lastToolName = ev.tool_name||'tool'; lastToolRunning=true; updateToolSeqHeader();
                  const td = document.createElement('div'); td.className='tool-card expanded'; td.id='tool-'+ev.tool_id;
                  td.innerHTML = '<div class="tool-header"><div class="tool-title-group"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg><span>'+escapeHtml(ev.tool_name)+'</span></div><div style="display:flex; align-items:center;"><span class="tool-tag">RUNNING</span><svg class="tool-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg></div></div><div class="tool-body" id="args-'+ev.tool_id+'"></div>';
                  seq.querySelector('.tool-seq-body').appendChild(td);
                } else if (ev.t === 'tool_delta') {
                  const ae = document.getElementById('args-'+ev.tool_id); if (ae) ae.textContent += ev.chunk;
                } else if (ev.t === 'tool_result') {
                  const tt = document.getElementById('tool-'+ev.tool_id);
                  if (tt) { const tag=tt.querySelector('.tool-tag'); if(tag){tag.textContent='DONE'; tag.style.background='rgba(63,185,80,0.2)'; tag.style.color='var(--green)';} tt.classList.remove('expanded'); }
                }
              }
              sessionLiveBuffer.delete(currentSessionId);
              scrollToBottomIfNeeded();
            }
          }
          if (sessionIsRunning && (!currentTurnAssistantDiv || !chatContainer.contains(currentTurnAssistantDiv))) {
            startAssistantTurn();
          }
          renderConversationTimeline();
          scrollToBottom(false);
          requestAnimationFrame(() => {
            scrollToBottom(false);
          });
          break;

        case 'play_sound':
          playTone(msg.kind);
          break;

        case 'text_delta': {
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            sessionsState[msg.session_id].hasUnread = true;
            updateSessionActivityIndicator();
            const buf = sessionLiveBuffer.get(msg.session_id) || [];
            buf.push({ t:'text_delta', text: msg.text });
            sessionLiveBuffer.set(msg.session_id, buf);
            // keep DOM cache html if we have snapshot
            try {
              const c = sessionDomCache.get(msg.session_id);
              if (c && c.html !== undefined) { /* buffer is replayed on switch */ }
            } catch {}
            break;
          }
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

        case 'thinking_delta': {
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            sessionsState[msg.session_id].hasUnread = true;
            updateSessionActivityIndicator();
            const buf = sessionLiveBuffer.get(msg.session_id) || [];
            buf.push({ t:'thinking_delta', text: msg.text });
            sessionLiveBuffer.set(msg.session_id, buf);
            break;
          }
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
          currentThinkingContent.scrollTop = currentThinkingContent.scrollHeight;
          scrollToBottomIfNeeded();
          break; }

        case 'tool_start': {
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            sessionsState[msg.session_id].hasUnread = true;
            updateSessionActivityIndicator();
            const buf = sessionLiveBuffer.get(msg.session_id) || [];
            buf.push({ t:'tool_start', tool_id: msg.tool_id, tool_name: msg.tool_name });
            sessionLiveBuffer.set(msg.session_id, buf);
            break;
          }
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
          const isWriteOrCmd = /^(write_file|write_to_file|edit_file|edit_file_multi|multi_replace_file_content|replace_file_content|patch_file|create_file|shell_exec|run_command|bash|exec|cmd)$/i.test(msg.tool_name);
          const toolDiv = document.createElement('div');
          toolDiv.id = 'tool-' + msg.tool_id;
          toolDiv.setAttribute('data-tool-name', msg.tool_name);

          if (isWriteOrCmd && typeof window.renderAntigravityActivityRow === 'function') {
            const isCmd = /^(shell_exec|run_command|bash|exec|cmd)$/i.test(msg.tool_name);
            toolDiv.className = 'activity-row running';
            toolDiv.setAttribute('data-start-ts', String(Date.now()));
            toolDiv.setAttribute('data-label-resolved', '0');
            toolDiv.innerHTML = '<span class="activity-action">' + (isCmd ? 'Running' : 'Editing') + '</span>' +
              '<span class="activity-filename" id="label-' + msg.tool_id + '">' + escapeHtml(msg.tool_name) + '…</span>' +
              '<span class="tool-elapsed" id="elapsed-' + msg.tool_id + '">0s</span>' +
              '<span class="activity-running-dot"></span>' +
              '<div class="tool-body" id="args-' + msg.tool_id + '" style="display:none;"></div>';
          } else {
            toolDiv.className = 'tool-card expanded';
            toolDiv.setAttribute('data-start-ts', String(Date.now()));
            toolDiv.innerHTML = '<div class="tool-header">' +
              '<div class="tool-title-group">' +
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>' +
                '<span>' + escapeHtml(msg.tool_name) + '</span>' +
              '</div>' +
              '<div style="display:flex; align-items:center; gap:6px;">' +
                '<span class="tool-elapsed" id="elapsed-' + msg.tool_id + '">0s</span>' +
                '<span class="tool-tag">RUNNING</span>' +
                '<svg class="tool-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
              '</div>' +
            '</div>' +
            '<div class="tool-body" id="args-' + msg.tool_id + '"></div>';
          }
          seq.querySelector('.tool-seq-body').appendChild(toolDiv);
          scrollToBottomIfNeeded();
          break; }

        case 'tool_delta': {
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            const buf = sessionLiveBuffer.get(msg.session_id) || [];
            buf.push({ t:'tool_delta', tool_id: msg.tool_id, chunk: msg.chunk });
            sessionLiveBuffer.set(msg.session_id, buf);
            break;
          }
          const argsEl = document.getElementById('args-' + msg.tool_id);
          if (argsEl) {
            argsEl.textContent += msg.chunk;
            const toolRow = document.getElementById('tool-' + msg.tool_id);
            if (toolRow && toolRow.getAttribute('data-label-resolved') === '0') {
              const partial = argsEl.textContent;
              const fileMatch = partial.match(/"(?:TargetFile|file_path|target_file|path)"\\s*:\\s*"([^"]+)"/);
              const cmdMatch = partial.match(/"(?:CommandLine|command|cmd)"\\s*:\\s*"([^"]+)"/);
              const labelEl = document.getElementById('label-' + msg.tool_id);
              if (labelEl) {
                if (fileMatch && fileMatch[1]) {
                  const fname = fileMatch[1].replace(/\\\\/g, '/').split('/').pop() || fileMatch[1];
                  labelEl.textContent = fname;
                  labelEl.title = fileMatch[1];
                  toolRow.setAttribute('data-label-resolved', '1');
                } else if (cmdMatch && cmdMatch[1] && cmdMatch[1].length > 3) {
                  labelEl.textContent = cmdMatch[1];
                  labelEl.title = cmdMatch[1];
                  toolRow.setAttribute('data-label-resolved', '1');
                }
              }
            }
            scrollToBottomIfNeeded();
          }
          break; }

        case 'tool_end': {
          // tool_end arrives when the LLM finishes generating argument chunks.
          // The tool has NOT finished executing yet — it is now running in the backend.
          // Keep status as RUNNING, do not mark as DONE.
          const targetTool = document.getElementById('tool-' + msg.tool_id);
          if (targetTool) {
            const argsEl = document.getElementById('args-' + msg.tool_id);
            const rawArgs = argsEl ? argsEl.textContent : '';
            if (rawArgs && targetTool.getAttribute('data-label-resolved') === '0') {
              try {
                const parsed = typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : JSON.parse(rawArgs);
                const p = parsed.path || parsed.target_path || parsed.target_file || parsed.file_path || parsed.TargetFile;
                const c = parsed.CommandLine || parsed.command || parsed.cmd || parsed.query;
                const labelEl = document.getElementById('label-' + msg.tool_id);
                if (labelEl) {
                  if (p) {
                    labelEl.textContent = p.split(String.fromCharCode(92)).join('/').split('/').pop() || p;
                    labelEl.title = p;
                    targetTool.setAttribute('data-label-resolved', '1');
                  } else if (c) {
                    labelEl.textContent = c;
                    labelEl.title = c;
                    targetTool.setAttribute('data-label-resolved', '1');
                  }
                }
              } catch {
                const rawStr = String(rawArgs);
                const fileMatch = rawStr.match(/"(?:TargetFile|file_path|target_file|target_path|path)"\s*:\s*"([^"]+)"/);
                const cmdMatch = rawStr.match(/"(?:CommandLine|command|cmd)"\s*:\s*"([^"]+)"/);
                const labelEl = document.getElementById('label-' + msg.tool_id);
                if (labelEl) {
                  if (fileMatch && fileMatch[1]) {
                    const fname = fileMatch[1].split(String.fromCharCode(92)).join('/').split('/').pop() || fileMatch[1];
                    labelEl.textContent = fname;
                    labelEl.title = fileMatch[1];
                    targetTool.setAttribute('data-label-resolved', '1');
                  } else if (cmdMatch && cmdMatch[1]) {
                    labelEl.textContent = cmdMatch[1];
                    labelEl.title = cmdMatch[1];
                    targetTool.setAttribute('data-label-resolved', '1');
                  }
                }
              }
            }
            scrollToBottomIfNeeded();
          }
          break; }

        case 'tool_result': {
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            const buf = sessionLiveBuffer.get(msg.session_id) || [];
            buf.push({ t:'tool_result', tool_id: msg.tool_id, result: msg.result });
            sessionLiveBuffer.set(msg.session_id, buf);
            break;
          }
          const targetTool = document.getElementById('tool-' + msg.tool_id);
          if (targetTool) {
            const argsEl = document.getElementById('args-' + msg.tool_id);
            const toolNameEl = targetTool.querySelector('.tool-title-group span');
            const toolName = (toolNameEl ? toolNameEl.textContent.trim() : '') || targetTool.getAttribute('data-tool-name') || '';
            const rawArgs = argsEl ? argsEl.textContent : '';

            // Update duration display with actual execution time
            const elapsedEl = document.getElementById('elapsed-' + msg.tool_id) || targetTool.querySelector('.tool-elapsed');
            if (elapsedEl) {
              if (typeof msg.duration_ms === 'number' && msg.duration_ms > 0) {
                elapsedEl.textContent = (msg.duration_ms / 1000).toFixed(1) + 's';
              } else {
                const startTs = parseInt(targetTool.getAttribute('data-start-ts') || '0', 10);
                if (startTs > 0) {
                  elapsedEl.textContent = Math.max(0, Math.floor((Date.now() - startTs) / 1000)) + 's';
                }
              }
            }

            if (rawArgs) {
              const isWriteTool = /^(write_file|write_to_file|edit_file|edit_file_multi|multi_replace_file_content|replace_file_content|patch_file|create_file|delete_file|move_file|rename_file|save_file)$/.test(toolName);
              if (isWriteTool) {
                try {
                  const parsed = typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : JSON.parse(rawArgs);
                  const p = parsed.path || parsed.target_path || parsed.target_file || parsed.file_path || parsed.TargetFile;
                  if (p) turnEditedFiles.add(p);
                  if (Array.isArray(parsed.edits)) {
                    for (const e of parsed.edits) {
                      const ep = e.path || e.target_path || e.file_path || e.TargetFile;
                      if (ep) turnEditedFiles.add(ep);
                    }
                  }
                } catch {
                  const rawStr = String(rawArgs);
                  const m = rawStr.match(/"(?:TargetFile|file_path|target_file|target_path|path)"\s*:\s*"([^"]+)"/);
                  if (m && m[1]) {
                    turnEditedFiles.add(m[1]);
                  }
                }
                if (typeof window.parseFileEditStats === 'function') {
                  const es = window.parseFileEditStats(toolName, rawArgs);
                  if (es && es.filePath) {
                    const nKey = es.filePath.replace(/\\\\/g, '/').trim();
                    if (!globalDiffStats[nKey]) {
                      globalDiffStats[nKey] = { additions: 0, deletions: 0 };
                    }
                    globalDiffStats[nKey].additions += (es.additions || 0);
                    globalDiffStats[nKey].deletions += (es.deletions || 0);
                  }
                }
              }

              let activityEl = null;
              if (typeof window.renderAntigravityActivityRow === 'function') {
                activityEl = window.renderAntigravityActivityRow(toolName, rawArgs, msg.success === false ? 'error' : 'done');
              }
              if (!activityEl && typeof window.renderCommandActivityRow === 'function' && /^(shell_exec|run_command|bash|exec|cmd)$/i.test(toolName)) {
                activityEl = window.renderCommandActivityRow(toolName, rawArgs, msg.success === false ? 'error' : 'done', msg.result);
              }

              if (activityEl) {
                activityEl.id = 'tool-' + msg.tool_id;
                targetTool.removeAttribute('data-start-ts');
                targetTool.replaceWith(activityEl);
              } else {
                const tag = targetTool.querySelector('.tool-tag');
                if (tag) {
                  tag.textContent = msg.success === false ? 'FAILED' : 'DONE';
                  tag.style.background = msg.success === false ? 'rgba(248, 81, 73, 0.2)' : 'rgba(63, 185, 80, 0.2)';
                  tag.style.color = msg.success === false ? 'var(--red)' : 'var(--green)';
                }
                targetTool.removeAttribute('data-start-ts');
                targetTool.classList.remove('expanded', 'stuck');
              }
            } else {
              const tag = targetTool.querySelector('.tool-tag');
              if (tag) {
                tag.textContent = msg.success === false ? 'FAILED' : 'DONE';
                tag.style.background = msg.success === false ? 'rgba(248, 81, 73, 0.2)' : 'rgba(63, 185, 80, 0.2)';
                tag.style.color = msg.success === false ? 'var(--red)' : 'var(--green)';
              }
              targetTool.removeAttribute('data-start-ts');
              targetTool.classList.remove('expanded', 'stuck');
            }
          }
          if (msg.tool_id) {
            toolSeqDoneTools.add(msg.tool_id);
          }
          if (toolSeqDoneTools.size >= toolSeqCount) {
            lastToolRunning = false;
          }
          updateToolSeqHeader();
          // Tool-path spawns never emit subagent/done (orchestrator.spawn doesn't
          // use run_stream). The tool result IS the SubAgentResult JSON — use it as
          // the backstop to flip the matching subagent card to DONE/FAILED.
          if (msg.result) {
            try {
              const parsed = JSON.parse(msg.result);
              if (parsed && parsed.agent_id && parsed.status) {
                const finished = parsed.status === 'completed';
                updateSubagentCard({
                  type: finished ? 'subagent_done' : 'subagent_failed',
                  agent_id: parsed.agent_id,
                  status: parsed.status,
                  result: parsed.summary || parsed.error || '',
                  error: parsed.error || undefined,
                });
              }
            } catch (e) { /* not a JSON subagent result */ }
          }
          scrollToBottomIfNeeded();
          break; }

        case 'tool_approval_required': {
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            sessionsState[msg.session_id].pendingApproval = msg;
            break;
          }
          interactiveSlot.innerHTML = renderPermissionCard(msg);
          scrollToBottomIfNeeded();
          break; }

        case 'ask_questions': {
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            sessionsState[msg.session_id].pendingQuestions = msg;
            break;
          }
          let questions = msg.questions || [];
          if (typeof questions === 'string') {
            try {
              questions = JSON.parse(questions);
            } catch {
              questions = [{ question: questions, type: 'text', options: [] }];
            }
          }
          if (!Array.isArray(questions)) {
            questions = [questions];
          }
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
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            sessionsState[msg.session_id].pendingPlanApproval = msg;
            break;
          }
          interactiveSlot.innerHTML = renderPlanApprovalCard(msg);
          scrollToBottomIfNeeded();
          break;

        case 'subagent_spawned': {
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            break;
          }
          if (!currentTurnAssistantDiv) startAssistantTurn();
          appendSubagentCard(msg);
          break; }

        case 'subagent_progress':
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) break;
          // Tool-path spawns arrive as subagent_progress with event_type 'spawned'
          // (they never emit subagent_spawned). Lazily create the card here too so a
          // genuinely parallel set of spawns renders one card per agent_id.
          if (msg.event_type === 'spawned') {
            if (!currentTurnAssistantDiv) startAssistantTurn();
            appendSubagentCard(msg);
          }
          updateSubagentCard(msg);
          break;

        case 'subagent_done':
        case 'subagent_failed': {
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) break;
          updateSubagentCard(msg);
          break; }

        case 'session_message_received':
          if (!currentSessionId || msg.to_session_id === currentSessionId || msg.to_session === currentSessionId || msg.to_session === 'all' || msg.to_session === '*') {
            appendSessionMessageCard(msg.from_session, msg.content, msg.message_type);
          }
          break;

        case 'session_question_received':
          if (!currentSessionId || msg.to_session_id === currentSessionId || msg.to_session === currentSessionId || msg.to_session === 'all' || msg.to_session === '*') {
            appendSessionQuestionCard(msg.from_session, msg.question, msg.question_id);
          }
          break;

        case 'session_answer_received':
          if (!currentSessionId || msg.to_session_id === currentSessionId || msg.to_session === currentSessionId || msg.to_session === 'all' || msg.to_session === '*') {
            appendSessionAnswerCard(msg.from_session, msg.answer, msg.question_id);
          }
          break;

        case 'session_shared_state_changed':
          appendSharedStateCard(msg.author_session, msg.key, msg.value);
          break;

        case 'session_handoff_written':
          if (msg.to_session === currentSessionId || msg.from_session === currentSessionId || msg.to_session === 'all' || !currentSessionId) {
            appendHandoffCard(msg.from_session, msg.to_session, msg.task_summary, msg.handoff_id);
          }
          break;

        case 'init_queue':
          if (Array.isArray(msg.queue) && msg.queue.length > 0) {
            promptQueue.push(...msg.queue);
            renderQueue();
          }
          break;

        case 'init_tab_state':
          if (Array.isArray(msg.queue) && msg.queue.length > 0) {
            promptQueue.push(...msg.queue);
            renderQueue();
          }
          if (!chatContainer.querySelector('.message-wrap.user') && Array.isArray(msg.seedMessages) && msg.seedMessages.length > 0) {
            hideZeroState();
            lastAppendedUserText = '';
            lastAppendedUserTime = 0;
            msg.seedMessages.forEach(function(m) {
              if (!m) return;
              if (m.role === 'user') {
                appendUserMessage(extractMessageText(m.content), m.images || [], m.ts, { skipDedupe: true });
              } else if (m.role === 'assistant' && extractMessageText(m.content).trim()) {
                const wrap = document.createElement('div');
                wrap.className = 'message-wrap assistant';
                wrap.innerHTML = '<div class="assistant-header"><div class="assistant-avatar"><img src="' + sidebarIconUri + '" width="14" height="14" alt="Andromity" /></div><span class="assistant-name">Andromity</span></div>';
                const textEl = document.createElement('div');
                textEl.className = 'assistant-text';
                textEl.innerHTML = renderMarkdown(extractMessageText(m.content));
                wrap.appendChild(textEl);
                chatContainer.appendChild(wrap);
              }
            });
          }
          applyTabComposerState(msg.draft, msg.images);
          break;

        case 'agent_started':
          turnEditedFiles.clear();
          if (msg.session_id) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            if (msg.session_id !== currentSessionId) {
              sessionsState[msg.session_id].hasUnread = true;
            }
            updateSessionActivityIndicator();
          }
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) break;
          if (msg.prompt) {
            const parsed = parseUserPromptDisplay(msg.prompt);
            const cleanText = normalizePromptText(parsed.userText || '');
            const rawPromptNorm = normalizePromptText(msg.prompt);

            const isMatchLast = Boolean(
              lastAppendedUserText &&
              (lastAppendedUserText === cleanText ||
               lastAppendedUserText === rawPromptNorm ||
               (cleanText && (lastAppendedUserText.includes(cleanText) || cleanText.includes(lastAppendedUserText))))
            );

            let domHasMatchingPrompt = false;
            const userWraps = chatContainer.querySelectorAll('.message-wrap.user');
            if (userWraps.length > 0) {
              const lastUserWrap = userWraps[userWraps.length - 1];
              const textEl = lastUserWrap.querySelector('.prompt-text-content');
              const domText = normalizePromptText(textEl ? textEl.textContent : lastUserWrap.textContent || '');
              if (domText && (
                domText === cleanText ||
                domText === rawPromptNorm ||
                (cleanText && (domText.includes(cleanText) || cleanText.includes(domText)))
              )) {
                domHasMatchingPrompt = true;
              }
            }

            const isTurnAlreadyActive = Boolean(currentTurnAssistantDiv && chatContainer.contains(currentTurnAssistantDiv));

            if (!isMatchLast && !domHasMatchingPrompt && !isTurnAlreadyActive) {
              hideZeroState();
              appendUserMessage(msg.prompt, msg.images || [], Date.now(), { skipDedupe: true });
            }
          }
          if (!currentTurnAssistantDiv || !chatContainer.contains(currentTurnAssistantDiv)) {
            startAssistantTurn();
          }
          break;

        case 'session_compacting':
          showCompactionBanner(msg.reason || 'Compacting conversation context to reduce token usage...');
          break;

        case 'session_compacted':
          hideCompactionBannerWithSuccess(msg);
          break;

        case 'turn_undone': {
          const undoneCount = msg.turnsUndone || 1;
          appendSystemNote(undoneCount > 1
            ? (undoneCount + ' turns undone: file changes rolled back.')
            : 'Last turn undone: file changes rolled back.');
          break;
        }

        case 'agent_busy':
          if (msg.queuedPrompt) {
            promptQueue.push(msg.queuedPrompt);
            renderQueue();
            appendSystemNote('Agent busy -- your message was queued (will send after this turn).');
          } else {
            appendSystemNote('Agent is still working -- please wait for this turn to finish.');
          }
          break;

        case 'agent_done': {
          if (msg.session_id) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = false;
            if (msg.session_id !== currentSessionId) {
              sessionsState[msg.session_id].hasUnread = true;
            }
            updateSessionActivityIndicator();
            try { sessionDomCache.delete(msg.session_id); sessionLiveBuffer.delete(msg.session_id); } catch {}
          }
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) break;
          if (cancelFallbackTimer) { clearTimeout(cancelFallbackTimer); cancelFallbackTimer = null; }
          cancelBtn.disabled = false;
          cancelBtn.style.opacity = '';
          cancelBtn.innerHTML = CANCEL_BTN_STOP_ICON;
          if (Array.isArray(msg.turn_files)) {
            for (const tf of msg.turn_files) {
              if (tf) turnEditedFiles.add(tf);
            }
          }
          endAssistantTurn();
          interactiveSlot.innerHTML = '';
          activePendingApprovalId = null;
          activePendingToolName = '';
          activePendingPlan = false;
          updateTokenDisplay({
            token_total: msg.token_total,
            context_tokens: msg.context_tokens,
            cost_usd: msg.cost_usd,
          });
          flushQueue();
          break; }

        case 'agent_cancelled': {
          if (msg.session_id) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = false;
          }
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) break;
          if (cancelFallbackTimer) { clearTimeout(cancelFallbackTimer); cancelFallbackTimer = null; }
          cancelBtn.disabled = false;
          cancelBtn.style.opacity = '';
          cancelBtn.innerHTML = CANCEL_BTN_STOP_ICON;
          endAssistantTurn();
          interactiveSlot.innerHTML = '';
          activePendingApprovalId = null;
          activePendingToolName = '';
          activePendingPlan = false;
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
        }

        case 'agent_error': {
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = false;
            break;
          }
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
        }

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

        case 'cron_event':
          // Cron completion notifications are delivered via VS Code toast notification;
          // do not inject event cards into the active conversation chat.
          break;

        case 'plan_updated':
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            break;
          }
          if (msg.plan && msg.plan.steps && msg.plan.steps.length > 0) {
            updatePlanTracker(msg.plan);
          } else if (planTrackerStrip) {
            planTrackerStrip.style.display = 'none';
          }
          // Only show the pill in the chat if a plan tool was explicitly called
          // this turn (not on session restore / disk load which fires outside a turn)
          if (msg.plan && msg.plan.title && planToolCalledInTurn) {
            renderPlanPill(msg.plan);
          }
          break;

        case 'key_configured_select_model': {
          showOnboardingModelStep(msg.provider, msg.models, msg.defaultModel);
          break;
        }

        case 'key_configured_success': {
          showOnboardingKeyStep();
          if (btnOnboardingSave) {
            btnOnboardingSave.disabled = false;
            btnOnboardingSave.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:4px;vertical-align:-1px;"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Connected!</span>';
          }
          if (btnOnboardingOllamaSave) {
            btnOnboardingOllamaSave.disabled = false;
            btnOnboardingOllamaSave.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:4px;vertical-align:-1px;"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Activated!</span>';
          }
          if (msg.provider) currentProvider = msg.provider;
          if (msg.model) currentModel = msg.model;
          updateModelBadge();
          setTimeout(() => {
            updateOnboardingVisibility();
            if (promptInput) promptInput.focus();
          }, 350);
          break;
        }

        case 'key_configure_failed': {
          showOnboardingKeyStep();
          if (btnOnboardingSave) {
            btnOnboardingSave.disabled = false;
            btnOnboardingSave.innerHTML = '<span>Connect & Continue</span>';
          }
          if (btnOnboardingOllamaSave) {
            btnOnboardingOllamaSave.disabled = false;
            btnOnboardingOllamaSave.innerHTML = '<span>Activate Local Ollama</span>';
          }
          break;
        }

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
          const extPrompt = msg.prompt || '';
          const extCtx = msg.context || null;
          const targetSid = msg.sessionId || currentSessionId;
          if (!extPrompt) break;

          hideZeroState();

          let fullUserMsg = extPrompt;
          const codeSnippet = extCtx ? (extCtx.selectedText || extCtx.fileText) : null;
          if (codeSnippet) {
            const lang = extCtx.languageId || '';
            const filePath = extCtx.relativePath || extCtx.filePath || '';
            const lineInfo = extCtx.selectedText && extCtx.selectionRange
              ? ' (lines ' + extCtx.selectionRange.startLine + '-' + extCtx.selectionRange.endLine + ')'
              : (extCtx.selectedText ? '' : ' (entire file)');
            const bt = String.fromCharCode(96); const fence = bt+bt+bt;
            const nl = String.fromCharCode(10);
            fullUserMsg = extPrompt + nl + nl + fence + lang + (filePath ? '  // ' + filePath + lineInfo : '') + nl + codeSnippet + nl + fence;
          }

          if (promptInput) promptInput.value = '';
          if (isRunning) {
            promptQueue.push({ text: fullUserMsg, images: [], sessionId: targetSid });
            renderQueue();
            break;
          }
          dispatchPrompt(fullUserMsg, false, []);
          break;
        }

        case 'active_editor_context': {
          const actCtx = msg.context;
          currentActiveEditorContext = actCtx;
          const chip = document.getElementById('active-file-chip');
          const nameSpan = document.getElementById('active-file-name');
          const diagSpan = document.getElementById('active-file-diag');
          if (chip && nameSpan) {
            if (actCtx && actCtx.fileName) {
              chip.style.display = 'inline-flex';
              const lineStr = actCtx.cursorLine ? ':' + actCtx.cursorLine : '';
              nameSpan.textContent = actCtx.fileName + lineStr;
              chip.title = 'Active: ' + (actCtx.relativePath || actCtx.fileName) + (actCtx.cursorLine ? ' (line ' + actCtx.cursorLine + ')' : '') + ' · Ambient IDE context included';
              if (diagSpan) {
                if (actCtx.errorCount > 0) {
                  diagSpan.style.display = 'inline';
                  diagSpan.textContent = actCtx.errorCount + ' err';
                  diagSpan.style.background = 'rgba(239, 68, 68, 0.25)';
                  diagSpan.style.color = '#f87171';
                } else if (actCtx.warningCount > 0) {
                  diagSpan.style.display = 'inline';
                  diagSpan.textContent = actCtx.warningCount + ' warn';
                  diagSpan.style.background = 'rgba(245, 158, 11, 0.25)';
                  diagSpan.style.color = '#fbbf24';
                } else {
                  diagSpan.style.display = 'none';
                }
              }
            } else {
              chip.style.display = 'none';
            }
          }
          break;
        }
      }
    });

    function appendErrorCard(text, rawError, errorType) {
      if (!text) text = 'An unexpected agent error occurred.';
      const trimmed = String(text).trim();
      const wrap = document.createElement('div');

      if (trimmed.includes('andromity-error-card')) {
        wrap.innerHTML = trimmed;
        chatContainer.appendChild(wrap.firstElementChild || wrap);
        scrollToBottomIfNeeded();
        return;
      }

      const low = trimmed.toLowerCase();
      let badge = 'ERROR';
      let title = 'Turn Interrupted';
      let desc = trimmed;
      let eType = errorType || 'generic';

      const iconRetry = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19"/></svg>';
      const iconModel = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>';
      const iconCompact = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';
      const iconPlus = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
      const iconSettings = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';

      let actionsHtml = '<button class="btn-error-retry" data-action="retry-turn" title="Retry this turn">' + iconRetry + 'Retry Turn</button>';

      if (low.includes('image') || low.includes('vision') || low.includes('multimodal') || low.includes('does not support')) {
        badge = 'IMAGE NOT SUPPORTED';
        title = 'Model Does Not Support Images';
        desc = 'The active model does not accept image attachments. Switch to a vision model (e.g. Claude 3.7 Sonnet, GPT-4o, Gemini 2.0 Flash) or retry with text only.';
        eType = 'vision_unsupported';
        actionsHtml = '<button class="btn-error-retry" data-action="retry-without-image" title="Retry without image">' + iconRetry + 'Retry without Image</button>' +
          '<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch to a vision model">' + iconModel + 'Switch Model</button>';
      } else if (low.includes('429') || low.includes('rate limit') || low.includes('quota')) {
        badge = 'RATE LIMIT';
        title = 'Rate Limit Reached';
        desc = 'Rate limit or quota threshold reached for the model provider. Please wait a moment and click Retry.';
        eType = 'rate_limit';
        actionsHtml = '<button class="btn-error-retry" data-action="retry-turn" title="Retry turn">' + iconRetry + 'Retry Turn</button>' +
          '<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch model">' + iconModel + 'Switch Model</button>';
      } else if (low.includes('midstream') || low.includes('503') || low.includes('502') || low.includes('500') || low.includes('serviceunavailable') || low.includes('service unavailable') || low.includes('bad gateway') || low.includes('upstream error')) {
        badge = 'SERVICE DISRUPTED';
        title = 'Upstream Service Interruption';
        desc = 'The upstream provider experienced a temporary service disruption or disconnect. This is usually transient—click Retry to continue.';
        eType = 'provider_unavailable';
        actionsHtml = '<button class="btn-error-retry" data-action="retry-turn" title="Retry turn">' + iconRetry + 'Retry Turn</button>' +
          '<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch model">' + iconModel + 'Switch Model</button>';
      } else if (low.includes('context') || low.includes('token limit') || low.includes('maximum context')) {
        badge = 'CONTEXT LIMIT';
        title = 'Context Window Limit Reached';
        desc = 'This conversation has reached the maximum context length for the current model. Compact context or start a new session.';
        eType = 'context_exceeded';
        actionsHtml = '<button class="btn-error-retry" data-action="trigger-compact" title="Compact context">' + iconCompact + 'Compact Context</button>' +
          '<button class="btn-error-secondary" data-action="new-session" title="New session">' + iconPlus + 'New Session</button>';
      } else if (low.includes('401') || low.includes('403') || low.includes('unauthorized') || low.includes('api key')) {
        badge = 'AUTHENTICATION';
        title = 'Authentication Error';
        desc = 'Invalid or missing API key. Please check your provider settings.';
        eType = 'auth_error';
        actionsHtml = '<button class="btn-error-retry" data-action="open-settings" title="Open settings">' + iconSettings + 'Open Settings</button>';
      }

      const iconAlert = '<span class="error-header-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg></span>';

      const cardHtml =
        '<div class="andromity-error-card" data-error-type="' + eType + '" data-retryable="true">' +
          '<div class="error-card-header">' +
            '<div class="error-header-left">' +
              iconAlert +
              '<span class="error-badge">' + badge + '</span>' +
              '<span class="error-title">' + escapeHtml(title) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="error-card-body">' + escapeHtml(desc) + '</div>' +
          '<details class="error-details">' +
            '<summary>Technical Details</summary>' +
            '<pre class="error-code"><code>' + escapeHtml(rawError || text) + '</code></pre>' +
          '</details>' +
          '<div class="error-card-actions">' +
            actionsHtml +
          '</div>' +
        '</div>';

      wrap.innerHTML = cardHtml;
      chatContainer.appendChild(wrap.firstElementChild || wrap);
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
      if (!msg || !msg.agent_id) return;
      if (document.getElementById('subagent-' + msg.agent_id)) return;

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
            '<span class="subagent-live-text">' + escapeHtml(msg.detail || 'Working on task...') + '</span>' +
          '</div>' +
          '<div class="subagent-tools-container"></div>' +
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
      if (!msg || !msg.agent_id) return;
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
      const toolsContainer = card.querySelector('.subagent-tools-container');
      const resultBox = card.querySelector('.subagent-result-box');

      // Live step updates
      if (msg.detail && msg.detail !== 'running' && liveTextEl) {
        liveTextEl.textContent = msg.detail;
      }

      // Record inspectable tool action
      if (msg.tool_name && toolsContainer) {
        const tNameKey = msg.tool_name.replace(/[^a-zA-Z0-9_]/g, '_');
        if (!subToolSeqCounts[msg.agent_id]) subToolSeqCounts[msg.agent_id] = {};
        const seqCount = subToolSeqCounts[msg.agent_id][tNameKey] || 0;
        subToolSeqCounts[msg.agent_id][tNameKey] = seqCount + 1;
        const itemKey = 'subtool-' + msg.agent_id + '-' + tNameKey + (seqCount > 0 ? '-' + seqCount : '');
        let toolItem = card.querySelector('#' + itemKey);
        const actDesc = msg.detail || msg.tool_name;
        
        let argsContent = '';
        if (msg.tool_args) {
          try {
            const parsed = typeof msg.tool_args === 'string' ? JSON.parse(msg.tool_args) : msg.tool_args;
            argsContent = JSON.stringify(parsed, null, 2);
          } catch(e) {
            argsContent = String(msg.tool_args);
          }
        }
        const resultText = msg.tool_result ? ('\\n\\n[Output]:\\n' + String(msg.tool_result)) : '';

        if (!toolItem) {
          toolItem = document.createElement('div');
          toolItem.className = 'subagent-tool-item';
          toolItem.id = itemKey;
          toolItem.innerHTML =
            '<div class="subagent-tool-item-header">' +
              '<span class="subagent-tool-name">' +
                '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>' +
                escapeHtml(msg.tool_name) +
              '</span>' +
              '<span class="subagent-tool-desc">' + escapeHtml(actDesc) + '</span>' +
            '</div>' +
            '<div class="subagent-tool-item-body">' + escapeHtml(argsContent + resultText) + '</div>';

          const itemHeader = toolItem.querySelector('.subagent-tool-item-header');
          if (itemHeader) {
            itemHeader.addEventListener('click', (e) => {
              e.stopPropagation();
              toolItem.classList.toggle('expanded');
            });
          }
          toolsContainer.appendChild(toolItem);
        } else {
          const descEl = toolItem.querySelector('.subagent-tool-desc');
          if (descEl) descEl.textContent = actDesc;
          const bodyEl = toolItem.querySelector('.subagent-tool-item-body');
          if (bodyEl && (argsContent || resultText)) {
            bodyEl.textContent = argsContent + resultText;
          }
        }
      }

      const TERMINAL_FAILED = ['failed', 'timeout', 'killed', 'error', 'cancelled'];
      if (msg.error || msg.type === 'subagent_failed' || TERMINAL_FAILED.includes(msg.status)) {
        if (statusEl) {
          statusEl.className = 'subagent-status failed';
          statusEl.textContent = msg.status === 'failed' ? 'FAILED' : (msg.status || 'FAILED').toUpperCase();
        }
        if (liveStatusEl) liveStatusEl.style.display = 'none';
        if (resultBox && (msg.error || msg.detail || (msg.result && typeof msg.result === 'string'))) {
          resultBox.style.display = 'block';
          const failMsg = msg.error || msg.detail || (typeof msg.result === 'string' ? msg.result : '');
          resultBox.innerHTML = '<span style="color:var(--red); font-weight:500;">' + escapeHtml((msg.status || 'failed').toUpperCase()) + ':</span> ' + escapeHtml(failMsg);
        }
      } else if (msg.type === 'subagent_done' || msg.result !== undefined || msg.status === 'completed' || msg.status === 'done') {
        if (statusEl) {
          statusEl.className = 'subagent-status done';
          statusEl.textContent = 'DONE';
        }
        if (liveStatusEl) liveStatusEl.style.display = 'none';
        if (resultBox && (msg.result || msg.output || (msg.status === 'completed' && msg.detail))) {
          resultBox.style.display = 'block';
          const resContent = typeof msg.result === 'string' ? msg.result : (msg.output || msg.detail || JSON.stringify(msg.result, null, 2));
          resultBox.innerHTML = '<div class="subagent-result-title">Result</div>' + renderMarkdown(resContent);
        }
      }
      scrollToBottomIfNeeded();
    }

    let activePendingApprovalId = null;
    let activePendingToolName = '';
    let activePendingPlan = false;

    function renderPermissionCard(msg) {
      activePendingPlan = false;
      const toolName = msg.tool_name || 'tool';
      const approvalId = msg.approval_id || '';
      activePendingApprovalId = approvalId;
      activePendingToolName = toolName;
      const toolArgs = msg.args || {};

      let actionTitle = 'Running action';
      let iconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
      let iconClass = 'command';
      let codeDisplay = '';
      let subPath = '';

      const lowerTool = toolName.toLowerCase();
      if (lowerTool === 'shell_exec' || lowerTool === 'run_command' || lowerTool === 'bash' || lowerTool === 'exec' || lowerTool === 'cmd') {
        actionTitle = 'Running command';
        iconClass = 'command';
        iconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>';
        const cmd = toolArgs.command || toolArgs.cmd || toolArgs.CommandLine || '';
        const isWin = typeof navigator !== 'undefined' && ((navigator.platform && navigator.platform.indexOf('Win') > -1) || (navigator.userAgent && /win/i.test(navigator.userAgent)));
        const shellName = isWin ? 'powershell' : 'bash';
        codeDisplay = (shellName + ': ' + cmd).trim();
        subPath = toolArgs.cwd || toolArgs.Cwd || (zeroWorkspaceLabel ? zeroWorkspaceLabel.textContent : '') || '';
      } else if (lowerTool === 'edit_file' || lowerTool === 'write_to_file' || lowerTool === 'replace_file_content' || lowerTool === 'multi_replace_file_content' || lowerTool === 'create_file') {
        actionTitle = 'Edit file';
        iconClass = 'file';
        iconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
        const filePath = toolArgs.path || toolArgs.file || toolArgs.TargetFile || '';
        codeDisplay = 'file: ' + filePath;
        if (toolArgs.Instruction || toolArgs.Description) {
          codeDisplay += '\\n' + (toolArgs.Instruction || toolArgs.Description);
        }
        subPath = filePath;
      } else if (lowerTool === 'read_file' || lowerTool === 'view_file') {
        actionTitle = 'Read file';
        iconClass = 'file';
        iconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
        const filePath = toolArgs.path || toolArgs.file || toolArgs.AbsolutePath || '';
        codeDisplay = 'read: ' + filePath;
        subPath = filePath;
      } else if (lowerTool === 'web_search' || lowerTool === 'search_web') {
        actionTitle = 'Web search';
        iconClass = 'web';
        iconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
        codeDisplay = 'query: "' + (toolArgs.query || toolArgs.q || '') + '"';
        subPath = 'domain: ' + (toolArgs.domain || 'web');
      } else if (lowerTool === 'fetch_url' || lowerTool === 'read_url_content') {
        actionTitle = 'Fetch URL';
        iconClass = 'web';
        iconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>';
        codeDisplay = 'url: ' + (toolArgs.url || toolArgs.Url || '');
        subPath = toolArgs.url || '';
      } else {
        actionTitle = 'Execute ' + toolName;
        iconClass = 'command';
        try {
          codeDisplay = JSON.stringify(toolArgs, null, 2);
        } catch {
          codeDisplay = String(toolArgs);
        }
        subPath = 'tool: ' + toolName;
      }

      if (!subPath) {
        subPath = (zeroWorkspaceLabel ? zeroWorkspaceLabel.textContent : '') || 'workspace';
      }
      if (subPath.length > 48) {
        subPath = subPath.slice(0, 22) + '...' + subPath.slice(-22);
      }

      let rawParams = '';
      try {
        if (Object.keys(toolArgs).length > 1 || (lowerTool !== 'shell_exec' && lowerTool !== 'run_command')) {
          rawParams = JSON.stringify(toolArgs, null, 2);
        }
      } catch {}

      return '<div class="permission-card" id="permission-card-' + escapeHtml(approvalId) + '">' +
        '<div class="permission-header">' +
          '<div class="permission-title-row">' +
            '<div class="permission-icon-title">' +
              '<span class="permission-icon-box ' + iconClass + '">' + iconSvg + '</span>' +
              '<span class="permission-title">' + escapeHtml(actionTitle) + '</span>' +
            '</div>' +
            '<button class="permission-close-btn" data-action="reject-tool" data-approval-id="' + escapeHtml(approvalId) + '" title="Deny (Esc)">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
            '</button>' +
          '</div>' +
          '<div class="permission-code-box">' + escapeHtml(codeDisplay) + '</div>' +
          (rawParams ? (
            '<div class="permission-params-toggle" data-action="toggle-perm-params">' +
              '<span class="params-chevron">&#x25B8;</span> ' +
              '<span>View full parameters</span>' +
            '</div>' +
            '<div class="permission-params-body" style="display:none;">' +
              '<pre style="margin:0; font-family:var(--font-mono);">' + escapeHtml(rawParams) + '</pre>' +
            '</div>'
          ) : '') +
        '</div>' +

        '<div class="permission-options-group">' +
          '<div class="permission-option-row" data-action="approve-tool-once" data-approval-id="' + escapeHtml(approvalId) + '" data-tool="' + escapeHtml(toolName) + '" tabindex="0" role="button">' +
            '<div class="option-row-main">' +
              '<div class="option-row-title">Allow once</div>' +
            '</div>' +
            '<div class="option-row-badge">' +
              '<kbd class="perm-kbd">Ctrl</kbd> <kbd class="perm-kbd">Y</kbd>' +
            '</div>' +
          '</div>' +

          '<div class="permission-option-row" data-action="approve-tool-session" data-approval-id="' + escapeHtml(approvalId) + '" data-tool="' + escapeHtml(toolName) + '" tabindex="0" role="button">' +
            '<div class="option-row-main">' +
              '<div class="option-row-title">Allow for remainder of this session</div>' +
              '<div class="option-row-sub">path: ' + escapeHtml(subPath) + '</div>' +
            '</div>' +
            '<div class="option-row-badge">' +
              '<kbd class="perm-kbd">Ctrl</kbd> <kbd class="perm-kbd">Alt</kbd> <kbd class="perm-kbd">Y</kbd>' +
            '</div>' +
          '</div>' +

          '<div class="permission-option-row" data-action="approve-tool-always" data-approval-id="' + escapeHtml(approvalId) + '" data-tool="' + escapeHtml(toolName) + '" tabindex="0" role="button">' +
            '<div class="option-row-main">' +
              '<div class="option-row-title">Always allow</div>' +
              '<div class="option-row-sub">path: ' + escapeHtml(subPath) + '</div>' +
            '</div>' +
            '<div class="option-row-badge">' +
              '<kbd class="perm-kbd">Ctrl</kbd> <kbd class="perm-kbd">Shift</kbd> <kbd class="perm-kbd">Y</kbd>' +
            '</div>' +
          '</div>' +

          '<div class="permission-option-row option-deny" data-action="reject-tool" data-approval-id="' + escapeHtml(approvalId) + '" tabindex="0" role="button">' +
            '<div class="option-row-main">' +
              '<div class="option-row-title deny-text">Deny</div>' +
            '</div>' +
            '<div class="option-row-badge">' +
              '<kbd class="perm-kbd">Ctrl</kbd> <kbd class="perm-kbd">Alt</kbd> <kbd class="perm-kbd">N</kbd>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function renderPlanApprovalCard(msg) {
      activePendingPlan = true;
      activePendingApprovalId = null;
      activePendingToolName = '';
      const plan = msg.plan || {};
      const title = plan.title || 'Implementation Plan';
      const desc = plan.description || '';
      const steps = plan.steps || plan.todos || [];
      const planMd = plan.plan_md || plan.body || '';

      let stepsHtml = '';
      if (steps.length > 0) {
        stepsHtml = '<div class="plan-steps-preview">' +
          steps.map(function(s, idx) {
            const txt = typeof s === 'string' ? s : (s.title || s.description || s.text || ('Step ' + (idx + 1)));
            const sStatus = (typeof s === 'string' ? 'pending' : (s.status || 'pending')).toLowerCase();
            const isDone = (sStatus === 'done' || sStatus === 'completed');
            const isActive = (sStatus === 'active' || sStatus === 'in_progress' || sStatus === 'running');
            const isFailed = (sStatus === 'failed' || sStatus === 'error');

            let iconSvg = '';
            let itemClass = 'plan-step-item';

            if (isDone) {
              itemClass += ' is-done';
              iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            } else if (isActive) {
              itemClass += ' is-active';
              iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
            } else if (isFailed) {
              itemClass += ' is-failed';
              iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
            } else {
              itemClass += ' is-pending';
              iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"></rect></svg>';
            }

            return '<div class="' + itemClass + '">' +
              '<div class="plan-step-icon-wrap">' + iconSvg + '</div>' +
              '<span class="plan-step-txt">' + escapeHtml(txt) + '</span>' +
            '</div>';
          }).join('') +
        '</div>';
      }

      let fullPlanToggle = '';
      if (planMd && planMd.trim()) {
        fullPlanToggle =
          '<div class="permission-params-toggle" data-action="toggle-perm-params">' +
            '<span class="params-chevron">&#x25B8;</span> ' +
            '<span>View full plan markdown</span>' +
          '</div>' +
          '<div class="permission-params-body" style="display:none;">' +
            '<pre style="margin:0; font-family:var(--font-mono); white-space:pre-wrap; word-break:break-word;">' + escapeHtml(planMd) + '</pre>' +
          '</div>';
      }

      return '<div class="permission-card plan-approval-card" id="plan-approval-card">' +
        '<div class="permission-header">' +
          '<div class="permission-title-row">' +
            '<div class="permission-icon-title">' +
              '<span class="permission-icon-box plan">' +
                '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>' +
              '</span>' +
              '<span class="permission-title">Plan Review: ' + escapeHtml(title) + '</span>' +
            '</div>' +
            '<button class="permission-close-btn" data-action="reject-plan" title="Deny / Reject (Esc)">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
            '</button>' +
          '</div>' +
          (desc ? ('<div class="plan-desc-text">' + escapeHtml(desc) + '</div>') : '') +
          (stepsHtml ? ('<div class="permission-code-box plan-code-box">' + stepsHtml + '</div>') : '') +
          fullPlanToggle +
          '<div class="plan-feedback-wrapper">' +
            '<input type="text" id="plan-feedback-input" class="plan-feedback-field" placeholder="Optional review note or instruction..." autocomplete="off">' +
          '</div>' +
        '</div>' +

        '<div class="permission-options-group">' +
          '<div class="permission-option-row" data-action="approve-plan" tabindex="0" role="button">' +
            '<div class="option-row-main">' +
              '<div class="option-row-title">Approve & Execute</div>' +
              '<div class="option-row-sub">Proceed with planned implementation</div>' +
            '</div>' +
            '<div class="option-row-badge">' +
              '<kbd class="perm-kbd">Ctrl</kbd> <kbd class="perm-kbd">Y</kbd>' +
            '</div>' +
          '</div>' +

          '<div class="permission-option-row" data-action="open-plan-tab" tabindex="0" role="button">' +
            '<div class="option-row-main">' +
              '<div class="option-row-title">View full plan in editor tab</div>' +
              '<div class="option-row-sub">Open interactive side-by-side plan viewer</div>' +
            '</div>' +
            '<div class="option-row-badge">' +
              '<kbd class="perm-kbd">/plan</kbd>' +
            '</div>' +
          '</div>' +

          '<div class="permission-option-row option-deny" data-action="reject-plan" tabindex="0" role="button">' +
            '<div class="option-row-main">' +
              '<div class="option-row-title deny-text">Reject & Revise</div>' +
              '<div class="option-row-sub">Send review feedback to agent</div>' +
            '</div>' +
            '<div class="option-row-badge">' +
              '<kbd class="perm-kbd">Esc</kbd>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    document.addEventListener('keydown', (e) => {
      const isInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');

      // ── Plan Approval Keyboard Handling ──
      if (activePendingPlan) {
        if (isInput && e.target.id === 'plan-feedback-input') {
          if (e.key === 'Enter') {
            e.preventDefault();
            window.approvePlan();
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            window.rejectPlan();
            return;
          }
        } else if (!isInput) {
          if (e.key === 'Enter' || (e.ctrlKey && (e.key === 'y' || e.key === 'Y'))) {
            e.preventDefault();
            window.approvePlan();
            return;
          }
          if (e.key === 'Escape' || (e.ctrlKey && (e.key === 'n' || e.key === 'N'))) {
            e.preventDefault();
            window.rejectPlan();
            return;
          }
        }
      }

      if (!activePendingApprovalId) return;
      const isToolInput = isInput;

      // 1. Allow Once: Ctrl+Y, or Enter (when not inside input)
      if ((e.ctrlKey && (e.key === 'y' || e.key === 'Y') && !e.altKey && !e.shiftKey) || (!isToolInput && e.key === 'Enter')) {
        e.preventDefault();
        window.approveTool(activePendingApprovalId, 'once', activePendingToolName);
        return;
      }

      // 2. Allow for remainder of session: Ctrl+Alt+Y or Alt+Y
      if ((e.ctrlKey && e.altKey && (e.key === 'y' || e.key === 'Y')) || (e.altKey && (e.key === 'y' || e.key === 'Y'))) {
        e.preventDefault();
        window.approveTool(activePendingApprovalId, 'session', activePendingToolName);
        return;
      }

      // 3. Always allow: Ctrl+Shift+Y
      if (e.ctrlKey && e.shiftKey && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        window.approveTool(activePendingApprovalId, 'always', activePendingToolName);
        return;
      }

      // 4. Deny: Escape or Ctrl+Alt+N or Ctrl+N
      if (e.key === 'Escape' || (e.ctrlKey && e.altKey && (e.key === 'n' || e.key === 'N')) || (e.ctrlKey && (e.key === 'n' || e.key === 'N'))) {
        e.preventDefault();
        window.rejectTool(activePendingApprovalId);
        return;
      }
    });

    window.approveTool = function(approvalId, scope, toolName) {
      interactiveSlot.innerHTML = '';
      activePendingApprovalId = null;
      activePendingToolName = '';
      vscode.postMessage({ type: 'approve_tool', approvalId, scope: scope || 'once', toolName });
    };

    window.rejectTool = function(approvalId) {
      interactiveSlot.innerHTML = '';
      activePendingApprovalId = null;
      activePendingToolName = '';
      vscode.postMessage({ type: 'reject_tool', approvalId });
    };

    window.approvePlan = function() {
      activePendingPlan = false;
      const feedbackInput = document.getElementById('plan-feedback-input');
      const feedback = feedbackInput ? feedbackInput.value.trim() : '';
      interactiveSlot.innerHTML = '';
      vscode.postMessage({ type: 'approve_plan', feedback });
    };

    window.rejectPlan = function() {
      activePendingPlan = false;
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
      const rmFile = e.target.closest('[data-action="remove-attached-file"]');
      if (rmFile) {
        const idx = parseInt(rmFile.getAttribute('data-idx') || '0', 10);
        removeAttachedFile(idx);
        return;
      }
      const rmOllama = e.target.closest('[data-action="dismiss-ollama-banner"]');
      if (rmOllama) {
        const b = document.getElementById('ollama-detected-banner');
        if (b) b.remove();
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

    setInterval(function() {
      document.querySelectorAll('[data-start-ts]').forEach(function(el) {
        var ts = parseInt(el.getAttribute('data-start-ts') || '0', 10);
        if (!ts) return;
        var elapsed = Math.floor((Date.now() - ts) / 1000);
        var elapsedEl = el.querySelector('.tool-elapsed');
        if (elapsedEl) elapsedEl.textContent = elapsed + 's';
        if (elapsed >= 45 && !el.classList.contains('stuck')) {
          el.classList.add('stuck');
          el.classList.remove('running');
        }
      });
    }, 1000);

    initChatMascot();
    setRandomStatement();
    updateModeBadge("${state.currentMode || 'safe'}");
    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'webview_ready' });
    // Also request host to transfer focus into webview (required on first show)
    setTimeout(() => focusPrompt(), 100);
`;
}
