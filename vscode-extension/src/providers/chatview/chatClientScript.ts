import { ChatViewState } from "./chatHtml.js";
import { scriptJson } from "../webviewSecurity.js";
import { getPromptDisplayScript } from "../promptDisplay.js";
import { getCommandRiskScript } from "../../commandRisk.js";
import { getRateLimitResetScript } from "./rateLimitReset.js";
import { getSecretScanScript } from "../../secretScan.js";
import { getUrlRiskScript } from "../../urlRisk.js";
import { getThinkingOrbsScript } from "./thinkingOrbs.js";
import { getToolTargetsScript } from "./toolTargets.js";
import { getStreamingRenderScript } from "./streamingRender.js";
import { getTurnRailScript } from "./turnRail.js";
import { DOCS } from "../../docsLinks.js";
import { SHELL_LANGUAGES } from "../../integrations/shellLanguages.js";
import { normalizeSidePanelPreferences } from "../../sidePanelPreferences.js";

export function getChatClientScript(sidebarIconUri: string, state: ChatViewState): string {
  return `
    ${getPromptDisplayScript()}
    ${getCommandRiskScript()}
    ${getRateLimitResetScript()}
    ${getSecretScanScript()}
    ${getUrlRiskScript()}
    ${getThinkingOrbsScript()}
    ${getToolTargetsScript()}
    function updateToolTarget(card, name, args) {
      const group = card?.querySelector('.tool-title-group');
      if (!group) return;
      const target = getToolTargetSummary(name, args);
      if (!target) return;
      let label = group.querySelector('.tool-target');
      if (!label) { label = document.createElement('span'); label.className = 'tool-target'; group.appendChild(label); }
      label.textContent = target;
      label.title = target;
    }
    const vscode = acquireVsCodeApi();
    window.__vscodeApi = vscode;
    const sidebarIconUri = ${scriptJson(sidebarIconUri)};
    const extensionVersion = ${scriptJson(state.extensionVersion || '0.2.15')};

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

    let workspaceFiles = new Set(${scriptJson((state.workspaceFiles || []).map(f => String(f).toLowerCase()))});
    let workspaceFolders = new Set(${scriptJson((state.workspaceFolders || []).map(d => String(d).toLowerCase()))});

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
    const reasoningPopover = document.getElementById('reasoning-popover');
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
    let isPlanTrackerCollapsed = false;
    try {
      isPlanTrackerCollapsed = localStorage.getItem('andromity_plan_tracker_collapsed') === 'true';
    } catch {}
    if (isPlanTrackerCollapsed && planTrackerStrip) {
      planTrackerStrip.classList.add('collapsed');
    }
    let isPlanTrackerDismissed = false;

    function hidePlanTracker() {
      if (planTrackerStrip) planTrackerStrip.style.display = 'none';
      document.querySelector('.composer-container')?.classList.remove('has-plan-tracker');
    }

    const bgProcessStrip = document.getElementById('bg-process-strip');
    const bgStripInfo = document.getElementById('bg-strip-info');
    const bgStripTitle = document.getElementById('bg-strip-title');
    const bgStripCount = document.getElementById('bg-strip-count');
    const bgStripTimer = document.getElementById('bg-strip-timer');
    const btnBgStopAll = document.getElementById('btn-bg-stop-all');
    const bgProcessList = document.getElementById('bg-process-list');
    let isBgStripCollapsed = false;
    const activeBgProcesses = new Map(); // procId -> { process_id, pid, command, startTime }
    let bgTimerInterval = null;

    function formatElapsedSecs(sec) {
      if (sec < 60) return sec + 's';
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m + 'm ' + s + 's';
    }

    function updateBgProcessStripUI() {
      if (!bgProcessStrip) return;
      if (activeBgProcesses.size === 0) {
        bgProcessStrip.style.display = 'none';
        document.querySelector('.composer-container')?.classList.remove('has-bg-process');
        if (bgTimerInterval) {
          clearInterval(bgTimerInterval);
          bgTimerInterval = null;
        }
        if (btnBgStopAll) {
          btnBgStopAll.disabled = false;
          btnBgStopAll.innerHTML = '<span class="codicon codicon-debug-stop"></span> Stop';
        }
        return;
      }

      bgProcessStrip.style.display = 'flex';
      document.querySelector('.composer-container')?.classList.add('has-bg-process');

      const count = activeBgProcesses.size;
      if (bgStripCount) bgStripCount.textContent = count === 1 ? '1 running' : (count + ' running');

      if (bgStripTitle) bgStripTitle.textContent = count === 1 ? 'Background task' : 'Background tasks';
      if (btnBgStopAll) btnBgStopAll.style.display = count > 1 ? '' : 'none';
      if (bgStripInfo) bgStripInfo.setAttribute('aria-expanded', String(!isBgStripCollapsed));

      if (bgProcessList) {
        let itemsHtml = '';
        let maxElapsed = 0;
        const now = Date.now();
        activeBgProcesses.forEach(function(proc, procId) {
          const el = Math.max(0, Math.floor((now - (proc.startTime || now)) / 1000));
          if (el > maxElapsed) maxElapsed = el;
          const elStr = formatElapsedSecs(el);
          const safeCmd = escapeHtml((proc.command || 'Process ' + procId).split(String.fromCharCode(10)).join(' '));
          const safeProcId = escapeHtml(procId);
          itemsHtml += '<div class="bg-process-item" data-process-id="' + safeProcId + '" title="Click to view live logs in new tab">' +
            '<button class="bg-item-left bg-item-open" data-process-id="' + safeProcId + '" aria-label="Open output for task ' + safeProcId + '">' +
              '<span class="bg-item-id">' + safeProcId + '</span>' +
              '<span class="bg-item-cmd" title="' + safeCmd + '">' + safeCmd + '</span>' +
              '<span class="bg-open-hint">Open output ↗</span>' +
            '</button>' +
            '<div class="bg-item-right">' +
              '<span class="bg-item-elapsed" id="bg-elapsed-' + safeProcId + '">' + elStr + '</span>' +
              '<button class="btn-tracker-close bg-item-stop-btn" data-process-id="' + safeProcId + '" title="Stop process" aria-label="Stop task ' + safeProcId + '">Stop</button>' +
            '</div>' +
          '</div>';
        });
        bgProcessList.innerHTML = itemsHtml;
        if (bgStripTimer) bgStripTimer.textContent = formatElapsedSecs(maxElapsed);
      }

      if (!bgTimerInterval) {
        bgTimerInterval = setInterval(function() {
          let maxElapsed = 0;
          const now = Date.now();
          activeBgProcesses.forEach(function(proc, procId) {
            const el = Math.max(0, Math.floor((now - (proc.startTime || now)) / 1000));
            if (el > maxElapsed) maxElapsed = el;
            const elSpan = document.getElementById('bg-elapsed-' + procId);
            if (elSpan) elSpan.textContent = formatElapsedSecs(el);
          });
          if (bgStripTimer) bgStripTimer.textContent = formatElapsedSecs(maxElapsed);
        }, 1000);
      }
    }

    if (bgStripInfo) {
      bgStripInfo.addEventListener('click', function() {
        isBgStripCollapsed = !isBgStripCollapsed;
        if (bgProcessStrip) bgProcessStrip.classList.toggle('collapsed', isBgStripCollapsed);
        bgStripInfo.setAttribute('aria-expanded', String(!isBgStripCollapsed));
      });
      bgStripInfo.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); bgStripInfo.click(); }
      });
    }



    if (btnBgStopAll) {
      btnBgStopAll.addEventListener('click', function(ev) {
        ev.stopPropagation();
        btnBgStopAll.disabled = true;
        btnBgStopAll.innerHTML = '<span class="codicon codicon-loading codicon-modifier-spin"></span>';
        activeBgProcesses.forEach(function(proc, procId) {
          vscode.postMessage({ type: 'kill_process', processId: procId });
        });
      });
    }

    if (bgProcessList) {
      bgProcessList.addEventListener('click', function(ev) {
        const stopBtn = ev.target.closest('.bg-item-stop-btn');
        if (stopBtn) {
          ev.stopPropagation();
          const procId = stopBtn.getAttribute('data-process-id');
          if (procId) {
            stopBtn.disabled = true;
            stopBtn.innerHTML = '<span class="codicon codicon-loading codicon-modifier-spin"></span>';
            vscode.postMessage({ type: 'kill_process', processId: procId });
          }
          return;
        }

        const item = ev.target.closest('.bg-process-item');
        if (item) {
          const procId = item.getAttribute('data-process-id');
          if (procId) {
            const proc = activeBgProcesses.get(procId);
            vscode.postMessage({
              type: 'open_bg_task_tab',
              processId: procId,
              command: proc ? proc.command : ''
            });
          }
        }
      });
    }
    const zeroWorkspaceLabel = document.getElementById('zero-workspace-label');
    const recentSessionsSection = document.getElementById('recent-sessions-section');
    const recentSessionsList = document.getElementById('recent-sessions-list');
    let allSessions = [];
    let allProviders = [];
    let sessionDisplayLimit = 10;
    const sessionsState = {};
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
    const onboardingOwnProvider = document.getElementById('onboarding-own-provider');
    const onboardingTrialSection = document.getElementById('onboarding-trial-section');
    const btnOnboardingInstantStart = document.getElementById('btn-onboarding-instant-start');
    const btnOnboardingGithubLogin = document.getElementById('btn-onboarding-github-login');
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

    // ── Collaboration Inbox State & Event Listeners ──────────────────────────
    const btnCollabInbox = document.getElementById('btn-top-collab-inbox');
    const collabInboxPopover = document.getElementById('collab-inbox-popover');
    const btnCloseCollabInbox = document.getElementById('btn-close-collab-inbox');
    const btnCollabClearAll = document.getElementById('btn-collab-clear-all');

    let collabInboxItems = [];
    let collabInboxActiveTab = 'all';
    let sessionCollabActive = false;
    let sessionCollabState = {};

    const COLLAB_ICON_PATHS = {
      question: '<circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line>',
      answer: '<polyline points="20 6 9 17 4 12"></polyline>',
      handoff: '<path d="M5 12h14"></path><path d="M12 5l7 7-7 7"></path>',
      message: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline>',
    };

    function collabTypeLabel(item) {
      if (item.type === 'question') return 'Question';
      if (item.type === 'answer') return 'Answer';
      if (item.type === 'handoff') return 'Handoff';
      if (item.messageType === 'broadcast') return 'Broadcast';
      if (item.messageType === 'shared_state') return 'Shared state';
      return 'Message';
    }

    // Shared-state writes and handoffs reach every open session; the session that made
    // them already shows the tool call, so it gets no inbox entry.
    function isOwnCollabEvent(authorName) {
      if (!authorName || !currentSessionId) return false;
      const current = (typeof allSessions !== 'undefined' ? allSessions : []).find(s => s.id === currentSessionId);
      if (current) return current.name === authorName;
      const shownName = document.getElementById('active-session-name');
      return Boolean(shownName && shownName.textContent && shownName.textContent.trim() === authorName);
    }

    function getSessionCollabInboxItems() {
      if (!currentSessionId) return collabInboxItems.slice();
      return collabInboxItems.filter(i => !i.sessionId || i.sessionId === currentSessionId);
    }

    function addCollabInboxItem(item) {
      if (!item) return;
      if (item.id && collabInboxItems.some(i => i.id === item.id)) return;
      if (!item.sessionId) item.sessionId = currentSessionId;
      collabInboxItems.unshift(item);
      updateCollabInboxBadge();
      renderCollabInbox();
    }

    function updateCollabInboxBadge() {
      const items = getSessionCollabInboxItems();
      const hasItems = items.length > 0;
      const badge = document.getElementById('collab-inbox-badge');
      const unreadCount = items.filter(i => i.unread).length;
      if (badge) {
        if (unreadCount > 0) {
          badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
          badge.style.display = 'inline-flex';
        } else {
          badge.style.display = 'none';
        }
      }
      const pill = document.getElementById('collab-inbox-status-pill');
      if (pill) {
        pill.textContent = items.length + (items.length === 1 ? ' item' : ' items');
        pill.style.display = hasItems ? '' : 'none';
      }
      const markReadBtn = document.getElementById('btn-collab-clear-all');
      if (markReadBtn) {
        markReadBtn.style.display = hasItems ? '' : 'none';
      }
      const tabsEl = document.querySelector('.collab-inbox-tabs');
      if (tabsEl) {
        tabsEl.style.display = hasItems ? '' : 'none';
      }
      if (!hasItems && collabInboxActiveTab !== 'all') {
        collabInboxActiveTab = 'all';
        document.querySelectorAll('.collab-inbox-tab').forEach(b => {
          b.classList.toggle('active', b.getAttribute('data-tab') === 'all');
        });
      }
      // The inbox entry point only exists while collaboration is happening in
      // this session: messages exchanged or an active co-agent link.
      if (btnCollabInbox) {
        const showInbox = hasItems || sessionCollabActive;
        btnCollabInbox.style.display = showInbox ? '' : 'none';
        if (!showInbox && collabInboxPopover) {
          collabInboxPopover.style.display = 'none';
        }
      }
    }

    function renderCollabInbox() {
      const listEl = document.getElementById('collab-inbox-list');
      if (!listEl) return;

      const filtered = getSessionCollabInboxItems().filter(item => {
        if (collabInboxActiveTab === 'all') return true;
        if (collabInboxActiveTab === 'questions') return item.type === 'question';
        if (collabInboxActiveTab === 'answers') return item.type === 'answer';
        if (collabInboxActiveTab === 'messages') return item.type === 'message';
        if (collabInboxActiveTab === 'handoffs') return item.type === 'handoff';
        return true;
      });

      if (filtered.length === 0) {
        listEl.innerHTML = '<div class="collab-inbox-empty">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>' +
          '<div class="empty-title">No collaboration messages</div>' +
          '<div class="empty-sub">Messages from other sessions appear here.</div>' +
          '</div>';
        return;
      }

      listEl.innerHTML = '';
      filtered.forEach(item => {
        const div = document.createElement('div');
        div.className = 'collab-inbox-item type-' + item.type + (item.unread ? ' unread' : '');
        div.id = 'inbox-item-' + item.id;

        const shortFrom = formatSessionShort(item.fromSession, 18);
        const kind = COLLAB_ICON_PATHS[item.type] ? item.type : 'message';
        const iconSvg = '<span class="collab-type-icon ' + kind + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + COLLAB_ICON_PATHS[kind] + '</svg></span>';
        const typeBadge = '<span class="collab-type-badge ' + kind + '">' + escapeHtml(collabTypeLabel(item)) + '</span>';

        let actionsHtml = '';
        if (item.fromSessionId) {
          actionsHtml += '<button class="session-card-btn session-card-jump-btn" data-action="switch-session" data-session-id="' + escapeHtml(item.fromSessionId) + '" title="Open ' + escapeHtml(item.fromSession || 'this session') + '">' +
            '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>' +
            'Open session</button>';
        }
        if (item.type === 'question' && item.questionId) {
          actionsHtml += '<button class="session-card-btn session-card-wake-btn" data-action="wake-agent-question" data-question-id="' + escapeHtml(item.questionId) + '" title="Ask this session to answer now">' +
            '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>' +
            'Answer now</button>';
        }

        const timeStr = item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

        div.innerHTML = '<div class="collab-inbox-item-header">' +
          '<div class="collab-inbox-item-title">' +
            iconSvg +
            '<span class="collab-inbox-item-from" title="' + escapeHtml(item.fromSession || 'Another session') + '">' + escapeHtml(shortFrom) + '</span>' +
            typeBadge +
          '</div>' +
          (timeStr ? '<span class="collab-inbox-item-time">' + escapeHtml(timeStr) + '</span>' : '') +
          '</div>' +
          '<div class="collab-inbox-item-body">' + renderMarkdown(item.content || '') + '</div>' +
          (actionsHtml ? '<div class="collab-inbox-item-footer">' + actionsHtml + '</div>' : '');

        listEl.appendChild(div);
      });
    }

    function toggleCollabInbox(open) {
      if (!collabInboxPopover) return;
      const shouldOpen = open !== undefined ? !!open : (collabInboxPopover.style.display === 'none');
      if (shouldOpen) {
        if (btnCollabInbox && btnCollabInbox.style.display === 'none') return;
        collabInboxPopover.style.display = 'flex';
        getSessionCollabInboxItems().forEach(i => { i.unread = false; });
        updateCollabInboxBadge();
        renderCollabInbox();
      } else {
        collabInboxPopover.style.display = 'none';
      }
    }

    btnCollabInbox?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollabInbox();
    });

    btnCloseCollabInbox?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollabInbox(false);
    });

    btnCollabClearAll?.addEventListener('click', (e) => {
      e.stopPropagation();
      getSessionCollabInboxItems().forEach(i => { i.unread = false; });
      updateCollabInboxBadge();
      renderCollabInbox();
    });

    document.querySelectorAll('.collab-inbox-tab').forEach(tabBtn => {
      tabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.collab-inbox-tab').forEach(b => b.classList.remove('active'));
        tabBtn.classList.add('active');
        collabInboxActiveTab = tabBtn.getAttribute('data-tab') || 'all';
        renderCollabInbox();
      });
    });

    document.addEventListener('click', (e) => {
      if (collabInboxPopover && collabInboxPopover.style.display !== 'none') {
        if (!collabInboxPopover.contains(e.target) && !btnCollabInbox?.contains(e.target)) {
          collabInboxPopover.style.display = 'none';
        }
      }
    });

    const sessionCollabBadgeEl = document.getElementById('session-collab-badge');
    sessionCollabBadgeEl?.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('[data-action="resume-auto-wake"]')) return;
      toggleCollabInbox(true);
    });

    let selectedOnboardingProvider = 'andromity';
    let selectedOnboardingModel = 'auto';

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
      { main: "What are we<br>building today?", sub: "Bring an idea, a bug, or a question. Let's work through it." },
      { main: "A fresh look.<br>A clear next step.", sub: "Explore your code, solve a problem, or start something new." },
      { main: "Pick up where<br>you left off.", sub: "Continue a conversation or bring your next idea to life." }
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

    // Context window display. The status bar shows the size of the latest request
    // (session.context_tokens, as reported by the provider). When no size has been
    // reported yet (new session, after compaction, providers that report none) the
    // daemon's per-category estimate from session.context fills in, marked with "~".
    let lastTokenState = { sessionId: '', contextTok: 0, estimate: 0, totalTok: 0, cost: 0 };
    let contextBreakdown = null;
    let contextBreakdownTimer = null;
    let contextBreakdownExpanded = typeof localStorage !== 'undefined' && localStorage.getItem('andromity.contextBreakdownOpen') === '1';
    const CONTEXT_COLORS = {
      system_prompt: '#94a3b8', tool_definitions: '#f59e0b', deferred_tools: '#fb923c', skills: '#22c55e',
      summary: '#a855f7', user: '#3b82f6', assistant: '#06b6d4', tool_calls: '#ec4899', tool_results: '#14b8a6', other: '#71717a'
    };

    function modelContextCapacity() {
      let matched = null;
      if (currentModel) {
        const cur = String(currentModel);
        matched = allModels.find(m => m.id === cur)
          || allModels.find(m => cur.endsWith('/' + m.id) || cur.endsWith(m.id))
          || allModels.find(m => m.id && (m.id.endsWith('/' + cur.split('/').pop()) || m.id.split('/').pop() === cur.split('/').pop()));
      }
      if (matched) {
        if (matched.context_limit) return matched.context_limit;
        if (matched.context) {
          const parsed = parseContextToTokens(matched.context);
          if (parsed) return parsed;
        }
      }
      // Fallbacks by known family — keep in sync with src/andromity/core/models.py MODEL_CATALOG
      const cm = String(currentModel).toLowerCase();
      if (cm.includes('gemini') || cm.includes('claude-opus') || cm.includes('claude-sonnet') || cm.includes('gpt-4.1') || cm.includes('deepseek-v4') || cm.includes('deepseek')) return 1310720;
      if (cm.includes('claude-haiku') || cm.includes('o3') || cm.includes('o4')) return 200000;
      return 131072;
    }

    function currentBreakdown() {
      return contextBreakdown && contextBreakdown.sessionId === currentSessionId ? contextBreakdown.data : null;
    }

    function updateTokenDisplay(sessionOrUsage) {
      // Partial updates (e.g. after compaction) keep the fields they do not carry, within one session.
      const sid = (sessionOrUsage && (sessionOrUsage.session_id || sessionOrUsage.id)) || currentSessionId || '';
      const same = sid === lastTokenState.sessionId;
      let contextTok = same ? lastTokenState.contextTok : 0;
      let totalTok = same ? lastTokenState.totalTok : 0;
      let cost = same ? lastTokenState.cost : 0;
      let estimate = 0;
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
        // A compacted context has no provider-reported size until the next request; show the estimate.
        if (sessionOrUsage.context_estimated) {
          estimate = contextTok;
          contextTok = 0;
        }
      }
      lastTokenState = { sessionId: sid, contextTok: contextTok, estimate: estimate, totalTok: totalTok, cost: cost };
      renderTokenDisplay();
      scheduleContextBreakdown();
    }

    function renderTokenDisplay() {
      const breakdown = currentBreakdown();
      let capacity = breakdown && breakdown.limit ? breakdown.limit : modelContextCapacity();
      let contextTok = lastTokenState.contextTok;
      let estimated = false;
      if (!contextTok && breakdown && breakdown.used_tokens) {
        contextTok = breakdown.used_tokens;
        estimated = breakdown.used_source === 'estimate';
      } else if (!contextTok && lastTokenState.estimate) {
        contextTok = lastTokenState.estimate;
        estimated = true;
      }
      const approx = estimated ? '~' : '';
      const pct = capacity > 0 ? Math.min(100, Math.max(0, (contextTok / capacity) * 100)) : 0;

      const miniBar = document.getElementById('token-mini-bar');
      if (miniBar) {
        miniBar.style.width = pct.toFixed(1) + '%';
        if (pct > 85) miniBar.style.background = '#ef4444';
        else if (pct > 65) miniBar.style.background = '#f59e0b';
        else miniBar.style.background = 'linear-gradient(90deg, #06b6d4, #10b981)';
      }
      if (tokenLabel) {
        tokenLabel.textContent = approx + formatTokCompact(contextTok) + (capacity > 0 ? '/' + formatTokCompact(capacity) : '') + ' tok';
      }
      if (costLabel) {
        costLabel.textContent = lastTokenState.cost > 0 ? ('$' + lastTokenState.cost.toFixed(4) + ' USD') : '$0.0000 USD';
      }
      const popoverPct = document.getElementById('context-popover-pct');
      if (popoverPct) popoverPct.textContent = Math.round(pct) + '%';
      const ringFill = document.getElementById('context-ring-fill');
      if (ringFill) {
        const circum = 87.96;
        ringFill.style.strokeDashoffset = (circum * (1 - pct / 100)).toFixed(2);
        ringFill.style.stroke = pct > 85 ? '#ef4444' : pct > 65 ? '#f59e0b' : 'var(--fg)';
      }
      const popoverRatio = document.getElementById('context-popover-ratio');
      if (popoverRatio) popoverRatio.textContent = approx + Number(contextTok).toLocaleString() + ' / ' + Number(capacity).toLocaleString();
      const popoverUsed = document.getElementById('context-popover-used');
      if (popoverUsed) popoverUsed.textContent = approx + Number(contextTok).toLocaleString();
      const popoverAvail = document.getElementById('context-popover-avail');
      if (popoverAvail) popoverAvail.textContent = Number(Math.max(0, capacity - contextTok)).toLocaleString();
      const widget = document.getElementById('token-capacity-widget');
      if (widget) widget.removeAttribute('title');
      renderContextBreakdown();
      if (typeof renderSidePanel === 'function' && sidePanelVisible()) { renderSidePanelContext(); renderSidePanelEnv(); }
    }

    function scheduleContextBreakdown() {
      if (!currentSessionId) return;
      clearTimeout(contextBreakdownTimer);
      contextBreakdownTimer = setTimeout(() => {
        vscode.postMessage({ type: 'get_context_breakdown', sessionId: currentSessionId });
      }, 300);
    }

    /** Context window numbers shared by the pop-up and the side panel. */
    function contextView(data) {
      const limit = data.limit || modelContextCapacity();
      const used = lastTokenState.contextTok || data.used_tokens || 0;
      const rows = (data.categories || []).filter(c => c.tokens > 0).map(c => ({ key: c.key, label: c.label, tokens: c.tokens }));
      const attributed = rows.reduce((sum, r) => sum + r.tokens, 0);
      // The provider's count includes request overhead Andromity cannot attribute to a category.
      if (used > attributed * 1.02 && used - attributed > 50) {
        rows.push({ key: 'other', label: 'Other (provider overhead)', tokens: used - attributed });
      }
      const pctOf = (n) => limit > 0 ? (n / limit) * 100 : 0;
      const threshold = typeof data.compact_threshold === 'number' ? data.compact_threshold : 0.8;
      const compactAt = data.compact_at_tokens || Math.round(limit * threshold);
      const free = Math.max(0, limit - Math.max(used, attributed));
      const buffer = data.auto_compact ? Math.max(0, limit - compactAt) : 0;
      const note = !data.auto_compact ? 'Auto-compact is off'
        : used < compactAt ? formatTokCompact(compactAt - used) + ' until auto-compact'
        : 'Compacts before the next turn';
      const foot = data.used_source === 'estimate'
        ? 'Estimated until the next model reply. Category sizes are always estimates.'
        : 'Total is the size the provider reported for the last request; categories are estimates.';
      return {
        limit, used, rows, free, buffer, threshold, autoCompact: !!data.auto_compact, note, foot,
        pctOf, fmtPct: (n) => { const p = pctOf(n); return p > 0 && p < 0.1 ? '<0.1%' : p.toFixed(1) + '%'; },
        compactDisabled: isRunning || (data.message_count || 0) < 4,
      };
    }

    function contextStackHtml(view) {
      return view.rows.map(r =>
        '<span class="context-stack-seg" style="width:' + Math.max(0.4, view.pctOf(r.tokens)).toFixed(2) + '%;background:' + (CONTEXT_COLORS[r.key] || CONTEXT_COLORS.other) + '"></span>'
      ).join('') + (view.autoCompact ? '<span class="context-stack-mark" style="left:' + (view.threshold * 100).toFixed(1) + '%"></span>' : '');
    }

    function contextRowsHtml(view) {
      const row = (color, label, tokens, extraClass) =>
        '<div class="context-cat-row' + (extraClass ? ' ' + extraClass : '') + '">' +
          '<span class="context-cat-swatch" style="background:' + color + '"></span>' +
          '<span class="context-cat-label">' + escapeHtml(label) + '</span>' +
          '<span class="context-cat-val">' + formatTokCompact(tokens) + '</span>' +
          '<span class="context-cat-pct">' + view.fmtPct(tokens) + '</span>' +
        '</div>';
      return view.rows.map(r => row(CONTEXT_COLORS[r.key] || CONTEXT_COLORS.other, r.label, r.tokens)).join('') +
        row('transparent', 'Free space', view.free, 'free') +
        (view.buffer ? row('transparent', 'Auto-compact buffer', view.buffer, 'buffer') : '');
    }

    function renderContextBreakdown() {
      const panel = document.getElementById('context-breakdown');
      const toggle = document.getElementById('context-breakdown-toggle');
      const popover = document.getElementById('context-popover');
      const data = currentBreakdown();
      if (toggle) {
        toggle.hidden = !data;
        toggle.setAttribute('aria-expanded', String(!!(data && contextBreakdownExpanded)));
        toggle.classList.toggle('open', !!(data && contextBreakdownExpanded));
      }
      if (popover) popover.classList.toggle('expanded', !!(data && contextBreakdownExpanded));
      if (!panel) return;
      panel.hidden = !(data && contextBreakdownExpanded);
      if (!data || panel.hidden) return;

      const view = contextView(data);
      const stack = document.getElementById('context-stack');
      if (stack) stack.innerHTML = contextStackHtml(view);
      const list = document.getElementById('context-cat-list');
      if (list) list.innerHTML = contextRowsHtml(view);
      const note = document.getElementById('context-compact-note');
      if (note) note.textContent = view.note;
      const compactBtn = document.getElementById('context-compact-btn');
      if (compactBtn) compactBtn.disabled = view.compactDisabled;
      const foot = document.getElementById('context-breakdown-note');
      if (foot) foot.textContent = view.foot;
    }

    // Context Window Popover click toggle support
    const tokenWidgetEl = document.getElementById('token-capacity-widget');
    if (tokenWidgetEl) {
      tokenWidgetEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target.closest && e.target.closest('#context-popover')) return;
        tokenWidgetEl.classList.toggle('active');
        if (tokenWidgetEl.classList.contains('active')) scheduleContextBreakdown();
      });
      tokenWidgetEl.addEventListener('mouseenter', scheduleContextBreakdown);
      tokenWidgetEl.addEventListener('keydown', (e) => {
        if (e.target !== tokenWidgetEl) return;
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
      const breakdownToggle = document.getElementById('context-breakdown-toggle');
      if (breakdownToggle) {
        breakdownToggle.hidden = true;
        breakdownToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          contextBreakdownExpanded = !contextBreakdownExpanded;
          if (typeof localStorage !== 'undefined') localStorage.setItem('andromity.contextBreakdownOpen', contextBreakdownExpanded ? '1' : '0');
          tokenWidgetEl.classList.add('active');
          if (contextBreakdownExpanded) {
            vscode.postMessage({ type: 'telemetry_feature', feature: 'context_breakdown', once: true });
            scheduleContextBreakdown();
          }
          renderContextBreakdown();
        });
      }
      const compactBtn = document.getElementById('context-compact-btn');
      if (compactBtn) {
        compactBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (compactBtn.disabled) return;
          compactBtn.disabled = true;
          vscode.postMessage({ type: 'compact_session' });
        });
      }
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

    let currentSessionId = ${scriptJson(state.currentSessionId || "")};
    let currentModel = ${scriptJson(state.currentModel || "auto")};
    let currentProvider = ${scriptJson(state.currentProvider || "andromity")};
    let currentMode = ${scriptJson(state.currentMode || "safe")};
    let currentProfile = ${scriptJson(state.currentProfile || "builder")};
    let currentReasoning = ${scriptJson(state.currentReasoning || "medium")};
    let isAndromityActive = false;
    let lastAuthState = null;
    const DEFAULT_POPULAR_MODELS = [
      { id: 'auto', name: 'Andromity Auto (Smart Router)', provider: 'andromity', pricing: 'Free' },
      { id: 'qwen/qwen-2.5-coder-32b-instruct:free', name: 'Qwen 2.5 Coder 32B Free', provider: 'openrouter', pricing: 'Free' },
      { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1 Free', provider: 'openrouter', pricing: 'Free' },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Free', provider: 'openrouter', pricing: 'Free' },
      { id: 'openrouter/auto', name: 'OpenRouter Auto (Frontier)', provider: 'openrouter', pricing: 'Free' }
    ];
    let allModels = [...DEFAULT_POPULAR_MODELS];
    let pinnedModels = ${scriptJson(state.pinnedModels || [])};
    let isRunning = false;
    const promptQueue = [];
    const serverQueues = {};
    const appliedInputIds = new Set();
    let queueSupported = false;
    let pendingInputDraft = null;

    function requestQueueSnapshot() {
      if (currentSessionId) vscode.postMessage({ type: 'queue_snapshot', sessionId: currentSessionId });
    }
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
    let _scrollRafId = null;
    let _ignoreScrollUntil = 0; // timestamp: suppress scroll events from programmatic scrolls
    let _lastScrollTop = 0;
    let _isUserActivelyScrolling = false;
    let _userScrollDebounceTimer = null;
    let _lastUserScrollTime = 0;
    let _scrollIntentVersion = 0;

    function markUserScrollActive() {
      _scrollIntentVersion++;
      _lastUserScrollTime = Date.now();
      _isUserActivelyScrolling = true;
      _ignoreScrollUntil = 0;
      isProgrammaticScroll = false;
      if (programmaticScrollTimer) clearTimeout(programmaticScrollTimer);
      if (_scrollRafId) {
        cancelAnimationFrame(_scrollRafId);
        _scrollRafId = null;
      }
      if (_userScrollDebounceTimer) clearTimeout(_userScrollDebounceTimer);
      _userScrollDebounceTimer = setTimeout(() => {
        _isUserActivelyScrolling = false;
        if (!userScrolledUp) scrollToBottomIfNeeded();
      }, 500);
    }

    function isAtBottom(threshold = 64) {
      if (!chatContainer) return true;
      return (chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight) <= threshold;
    }

    function scrollToBottom(smooth = false) {
      if (!chatContainer) return;
      userScrolledUp = false;
      _isUserActivelyScrolling = false;
      _lastUserScrollTime = 0;
      if (btnScrollBottom) {
        btnScrollBottom.classList.remove('visible');
        if (scrollUnreadBadge) scrollUnreadBadge.classList.remove('has-unread');
      }

      isProgrammaticScroll = true;
      if (programmaticScrollTimer) clearTimeout(programmaticScrollTimer);

      const doScroll = () => {
        if (!chatContainer) return;
        chatContainer.scrollTop = chatContainer.scrollHeight;
      };

      if (smooth) {
        chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
        programmaticScrollTimer = setTimeout(() => {
          isProgrammaticScroll = false;
          _ignoreScrollUntil = 0;
          if (chatContainer) _lastScrollTop = chatContainer.scrollTop;
        }, 350);
        _ignoreScrollUntil = Date.now() + 350;
      } else {
        _ignoreScrollUntil = Date.now() + 200;
        doScroll();
        _lastScrollTop = chatContainer.scrollTop;
        programmaticScrollTimer = setTimeout(() => {
          isProgrammaticScroll = false;
        }, 120);
      }
    }

    function scrollToBottomIfNeeded() {
      if (!chatContainer) return;
      // If user has scrolled up to inspect previous content, NEVER auto-scroll! Protect user intention.
      if (userScrolledUp) {
        if (scrollUnreadBadge) scrollUnreadBadge.classList.add('has-unread');
        return;
      }
      if (_isUserActivelyScrolling) return;

      if (_scrollRafId) return; // Coalesce within current frame to eliminate jitter
      const scrollSessionId = currentSessionId;
      _scrollRafId = requestAnimationFrame(() => {
        _scrollRafId = null;
        if (currentSessionId !== scrollSessionId) return;
        if (_isUserActivelyScrolling) return;
        if (!chatContainer || userScrolledUp) {
          if (scrollUnreadBadge) scrollUnreadBadge.classList.add('has-unread');
          return;
        }
        isProgrammaticScroll = true;
        if (programmaticScrollTimer) clearTimeout(programmaticScrollTimer);
        _ignoreScrollUntil = Date.now() + 200;
        chatContainer.scrollTop = chatContainer.scrollHeight;
        _lastScrollTop = chatContainer.scrollTop;
        programmaticScrollTimer = setTimeout(() => {
          isProgrammaticScroll = false;
        }, 120);
      });
    }

    function settleSessionScroll() {
      const sessionId = currentSessionId;
      const intentVersion = _scrollIntentVersion;
      const followLatest = () => {
        if (currentSessionId !== sessionId || _scrollIntentVersion !== intentVersion) return;
        scrollToBottomIfNeeded();
      };
      requestAnimationFrame(() => {
        followLatest();
        setTimeout(followLatest, 60);
        setTimeout(followLatest, 180);
      });
    }

    if (chatContainer) {
      _lastScrollTop = chatContainer.scrollTop;

      chatContainer.addEventListener('wheel', (e) => {
        if (e.deltaY < 0) {
          // User scrolled UP: immediately halt auto-scroll and cancel pending RAF scroll
          userScrolledUp = true;
          markUserScrollActive();
          _ignoreScrollUntil = 0;
          isProgrammaticScroll = false;
          if (_scrollRafId) {
            cancelAnimationFrame(_scrollRafId);
            _scrollRafId = null;
          }
          if (btnScrollBottom) btnScrollBottom.classList.add('visible');
        } else if (e.deltaY > 0) {
          markUserScrollActive();
          // Resume only at the bottom; a threshold would fight native wheel momentum.
          if (isAtBottom(2)) {
            userScrolledUp = false;
            _isUserActivelyScrolling = false;
            _lastUserScrollTime = 0;
            if (btnScrollBottom) {
              btnScrollBottom.classList.remove('visible');
              if (scrollUnreadBadge) scrollUnreadBadge.classList.remove('has-unread');
            }
          }
        }
      }, { passive: true });

      chatContainer.addEventListener('touchmove', () => {
        markUserScrollActive();
        _ignoreScrollUntil = 0;
        isProgrammaticScroll = false;
      }, { passive: true });

      chatContainer.addEventListener('pointerdown', () => {
        // User clicked or grabbed the scrollbar: mark active user interaction
        markUserScrollActive();
        _ignoreScrollUntil = 0;
        isProgrammaticScroll = false;
      }, { passive: true });

      chatContainer.addEventListener('keydown', (e) => {
        if (e.target?.closest('input, textarea, [contenteditable="true"]')) return;
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
          markUserScrollActive();
          _ignoreScrollUntil = 0;
          isProgrammaticScroll = false;
        }
      });

      chatContainer.addEventListener('load', (e) => {
        if (e.target && e.target.tagName === 'IMG') {
          scrollToBottomIfNeeded();
        }
      }, true);

      chatContainer.addEventListener('scroll', () => {
        // Suppress scroll events caused by our own programmatic auto-scrolls
        if (isProgrammaticScroll || Date.now() < _ignoreScrollUntil) {
          _lastScrollTop = chatContainer.scrollTop;
          return;
        }

        const currentScrollTop = chatContainer.scrollTop;
        const delta = currentScrollTop - _lastScrollTop;
        _lastScrollTop = currentScrollTop;

        const atBottom = isAtBottom(2);

        if (atBottom && !(_isUserActivelyScrolling && userScrolledUp && delta <= 0)) {
          // User reached or is at bottom: auto-scroll resumes
          userScrolledUp = false;
          _isUserActivelyScrolling = false;
          _lastUserScrollTime = 0;
        } else if (!atBottom && delta !== 0 && _isUserActivelyScrolling) {
          // Layout changes can also reduce scrollTop when a permission card closes.
          userScrolledUp = true;
          markUserScrollActive();
          if (_scrollRafId) {
            cancelAnimationFrame(_scrollRafId);
            _scrollRafId = null;
          }
        }

        if (btnScrollBottom) {
          if (userScrolledUp) {
            btnScrollBottom.classList.add('visible');
          } else {
            btnScrollBottom.classList.remove('visible');
            if (scrollUnreadBadge) scrollUnreadBadge.classList.remove('has-unread');
          }
        }
      });

      // Follow viewport changes from permission cards, trackers, and composer resizing.
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          if (!userScrolledUp) {
            scrollToBottomIfNeeded();
          }
        });
        if (planTrackerStrip) {
          ro.observe(planTrackerStrip);
        }
        if (interactiveSlot) {
          ro.observe(interactiveSlot);
        }
        ro.observe(chatContainer);
      }
    }

    btnScrollBottom?.addEventListener('click', () => {
      scrollToBottom(false);
      settleSessionScroll();
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
      currentToolSequence.querySelectorAll('.tool-card[data-start-ts]:not(.awaiting-approval), .activity-row.running[data-start-ts]:not(.awaiting-approval)').forEach(card => {
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
      } else if (awaitingApprovalRow && awaitingApprovalRow.isConnected) {
        el.textContent = label + ' · waiting for your approval';
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
          // Only auto-collapse if user is at bottom. If user scrolled up to read earlier responses
          // or active tools, do NOT auto-collapse it, preventing viewport jumping.
          if (!userScrolledUp) {
            seqToCollapse.classList.add('collapsed');
            scrollToBottomIfNeeded();
          }
        }
        currentToolSequence = null;
      }
    }

    // The prompt box is the combobox for both palettes: it points at the open
    // list and the highlighted option so screen readers announce navigation.
    function syncPaletteA11y(paletteId, open, activeOptionId) {
      if (!promptInput) return;
      if (open) {
        promptInput.setAttribute('aria-expanded', 'true');
        promptInput.setAttribute('aria-controls', paletteId);
        if (activeOptionId) promptInput.setAttribute('aria-activedescendant', activeOptionId);
        else promptInput.removeAttribute('aria-activedescendant');
      } else if (promptInput.getAttribute('aria-controls') === paletteId) {
        promptInput.setAttribute('aria-expanded', 'false');
        promptInput.removeAttribute('aria-controls');
        promptInput.removeAttribute('aria-activedescendant');
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
      syncPaletteA11y('slash-palette', false);
    }

    function renderSlashPalette() {
      if (!slashPaletteList) return;
      slashPaletteList.innerHTML = currentSlashMatches.map((c, idx) => {
        const isSel = idx === activeSlashIdx;
        return '<div class="slash-item ' + (isSel ? 'active' : '') + '" id="slash-opt-' + idx + '" data-action="select-slash-cmd" data-cmd="' + escapeHtml(c.cmd) + '" data-idx="' + idx + '" role="option" aria-selected="' + isSel + '">' +
          '<span class="slash-cmd">' + escapeHtml(c.cmd) + '</span>' +
          '<span class="slash-desc">' + escapeHtml(c.desc) + '</span>' +
        '</div>';
      }).join('');
      syncPaletteA11y('slash-palette', true, currentSlashMatches.length ? 'slash-opt-' + activeSlashIdx : '');
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

    function showMentionEmptyState() {
      if (!mentionPalette || !mentionPaletteList) return;
      hideSlashPalette();
      currentMentionMatches = [];
      activeMentionIdx = 0;
      mentionPalette.style.display = 'flex';
      mentionPaletteList.innerHTML = '<div class="slash-item mention-empty" role="option" aria-disabled="true">' +
        '<span class="slash-desc">No skills installed yet.</span>' +
        '<button class="btn-card-action" data-action="open-skills-settings">Browse skills</button>' +
      '</div>';
      syncPaletteA11y('mention-palette', true, '');
    }

    function hideMentionPalette() {
      if (mentionPalette) mentionPalette.style.display = 'none';
      currentMentionMatches = [];
      activeMentionIdx = 0;
      syncPaletteA11y('mention-palette', false);
    }

    function renderMentionPalette() {
      if (!mentionPaletteList) return;
      mentionPaletteList.innerHTML = currentMentionMatches.map((s, idx) => {
        const isSel = idx === activeMentionIdx;
        const name = s.name || s.id || 'skill';
        const desc = s.description || 'Agent skill';
        return '<div class="slash-item ' + (isSel ? 'active' : '') + '" id="mention-opt-' + idx + '" data-action="select-mention-skill" data-skill="' + escapeHtml(name) + '" data-idx="' + idx + '" role="option" aria-selected="' + isSel + '">' +
          '<span class="slash-cmd">@' + escapeHtml(name) + '</span>' +
          '<span class="slash-desc">' + escapeHtml(desc) + '</span>' +
        '</div>';
      }).join('');
      syncPaletteA11y('mention-palette', true, currentMentionMatches.length ? 'mention-opt-' + activeMentionIdx : '');
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
      vscode.postMessage({ type: 'telemetry_feature', feature: 'skill_mentioned', once: true });
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
      if (cmdObj.cmd) vscode.postMessage({ type: 'telemetry_feature', feature: 'slash_' + String(cmdObj.cmd).replace('/', ''), once: true });
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
      sendBtn.addEventListener('click', () => sendCurrentPrompt());
    }

    // Quick tooltip for composer actions marked data-tip (send, stop).
    const actionTip = document.createElement('div');
    actionTip.className = 'action-tip';
    actionTip.setAttribute('role', 'tooltip');
    actionTip.hidden = true;
    if (document.body) document.body.appendChild(actionTip);
    function showActionTip(el) {
      const text = el && el.getAttribute('data-tip');
      if (!text) return;
      actionTip.textContent = text;
      actionTip.hidden = false;
      const r = el.getBoundingClientRect();
      const tip = actionTip.getBoundingClientRect();
      actionTip.style.left = Math.max(6, Math.min(window.innerWidth - tip.width - 6, r.right - tip.width)) + 'px';
      actionTip.style.top = Math.max(6, r.top - tip.height - 6) + 'px';
    }
    function hideActionTip() { actionTip.hidden = true; }
    [sendBtn, cancelBtn].forEach((btn) => {
      if (!btn) return;
      btn.addEventListener('mouseenter', () => showActionTip(btn));
      btn.addEventListener('focus', () => showActionTip(btn));
      btn.addEventListener('mouseleave', hideActionTip);
      btn.addEventListener('blur', hideActionTip);
      btn.addEventListener('click', hideActionTip);
    });

    // While a turn runs, the placeholder says how to queue or steer, and the
    // send button stays next to Stop once there is text (CSS: .is-generating).
    const promptBaseEl = document.querySelector('.prompt-box');
    if (promptInput && promptBaseEl && typeof MutationObserver !== 'undefined') {
      const isMacPlatform = /Mac|iPhone|iPad/.test(navigator.platform || '');
      let runningHintShown = '';
      let placeholderBeforeHint = '';
      const syncRunningHint = () => {
        const generating = promptBaseEl.classList.contains('is-generating');
        if (generating && !runningHintShown) {
          placeholderBeforeHint = promptInput.getAttribute('placeholder') || '';
          runningHintShown = queueSupported
            ? 'Queue a follow-up (Enter) · ' + (isMacPlatform ? '⌘Enter' : 'Ctrl+Enter') + ' to steer now'
            : 'Queue a follow-up (Enter)';
          promptInput.setAttribute('placeholder', runningHintShown);
          if (sendBtn) {
            sendBtn.setAttribute('data-tip', queueSupported
              ? 'Queue follow-up (Enter)' + String.fromCharCode(10) + (isMacPlatform ? '⌘Enter' : 'Ctrl+Enter') + ' to steer now'
              : 'Queue follow-up (Enter)');
            sendBtn.setAttribute('aria-label', 'Queue follow-up message');
          }
        } else if (!generating && runningHintShown) {
          if (promptInput.getAttribute('placeholder') === runningHintShown) promptInput.setAttribute('placeholder', placeholderBeforeHint);
          runningHintShown = '';
          if (sendBtn) { sendBtn.setAttribute('data-tip', 'Send (Enter)'); sendBtn.setAttribute('aria-label', 'Send message'); }
        }
      };
      new MutationObserver(syncRunningHint).observe(promptBaseEl, { attributes: true, attributeFilter: ['class'] });
    }

    if (promptInput) {
      promptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
          e.preventDefault();
          if (queueSupported) sendCurrentPrompt('steer');
          else appendSystemNote('Update the Andromity server to use safe steering.');
          return;
        }
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

        // A suggested next step owns Tab and Esc only while the input is empty and its card is showing.
        if ((e.key === 'Tab' || e.key === 'Escape') && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey &&
            promptInput.value === '' && document.getElementById('next-step-card')) {
          e.preventDefault();
          if (e.key === 'Tab') acceptNextStepIntoInput();
          else dismissNextStep('dismissed');
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
          const isAtEnd = promptInput.selectionStart === promptInput.value.length && promptInput.selectionEnd === promptInput.value.length;
          if (isAtEnd && promptHistoryIndex < sentPromptsHistory.length) {
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
            if (!allSkills || allSkills.length === 0) {
              showMentionEmptyState();
              return;
            }
            const matches = allSkills.filter(s => {
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
            appendSystemNote('Stopping is taking longer than usual. Your next message will wait until the current step ends.');
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
      isPlanTrackerCollapsed = Boolean(planTrackerStrip?.classList.toggle('collapsed'));
      try {
        localStorage.setItem('andromity_plan_tracker_collapsed', isPlanTrackerCollapsed ? 'true' : 'false');
      } catch {}
    });

    document.getElementById('btn-tracker-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      isPlanTrackerDismissed = true;
      hidePlanTracker();
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

    let userDismissedOnboarding = false;

    function toggleOnboarding(forceShow) {
      if (!onboardingSection || !readyHeroSection) return;
      const willShow = (typeof forceShow === 'boolean') ? forceShow : (onboardingSection.style.display === 'none');
      if (willShow) {
        userDismissedOnboarding = false;
        onboardingSection.style.display = 'flex';
        readyHeroSection.style.display = 'none';
        showOnboardingKeyStep();
      } else {
        userDismissedOnboarding = true;
        onboardingSection.style.display = 'none';
        readyHeroSection.style.display = 'flex';
      }
    }

    function updateOnboardingVisibility() {
      if (!onboardingSection || !readyHeroSection) return;
      const isChatActive = isRunning || (chatContainer && chatContainer.querySelectorAll('.message').length > 0);
      if (isChatActive) {
        onboardingSection.style.display = 'none';
        readyHeroSection.style.display = 'none';
        return;
      }
      if (userDismissedOnboarding) {
        onboardingSection.style.display = 'none';
        readyHeroSection.style.display = 'flex';
        return;
      }
      const hasAnyKey = (allProviders || []).some(p => p.has_key && p.id !== 'ollama' && p.id !== 'andromity');
      const isOllamaActive = currentProvider === 'ollama';
      const isAndromityActive = currentProvider === 'andromity';
      if (!hasAnyKey && !isOllamaActive && !isAndromityActive) {
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
        selectedOnboardingProvider = chip.dataset.provider || 'andromity';
        selectedOnboardingModel = chip.dataset.model || 'auto';
        vscode.postMessage({ type: 'telemetry_feature', feature: 'onboard_prov_' + selectedOnboardingProvider });
        const name = chip.dataset.name || 'AI Provider';
        const portal = chip.dataset.portal || '';

        if (onboardingKeyLabel) onboardingKeyLabel.textContent = 'Paste your ' + name + ' API key';
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

    function handleActivateAndromityFree(btn) {
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span>Activating Free Trial...</span>';
      }
      vscode.postMessage({ type: 'activate_andromity_free' });
    }

    btnOnboardingInstantStart?.addEventListener('click', () => {
      handleActivateAndromityFree(btnOnboardingInstantStart);
    });


    btnOnboardingGithubLogin?.addEventListener('click', () => {
      vscode.postMessage({ type: 'open_github_login' });
    });


    const btnTopAccount = document.getElementById('btn-top-account');
    const accountPillDot = document.getElementById('account-pill-dot');
    const accountPillText = document.getElementById('account-pill-text');
    const accountPopover = document.getElementById('account-popover');
    const btnAccountPopoverClose = document.getElementById('btn-account-popover-close');
    const accountAvatar = document.getElementById('account-avatar');
    const accountUsername = document.getElementById('account-username');
    const accountPlanBadge = document.getElementById('account-plan-badge');
    const accountQuotaVal = document.getElementById('account-quota-val');
    const accountQuotaBar = document.getElementById('account-quota-bar');
    const accountQuotaTrack = document.getElementById('account-quota-track');
    const accountResetTimer = document.getElementById('account-reset-timer');
    const accountLatencyText = document.getElementById('account-latency-text');
    const btnAccountLogin = document.getElementById('btn-account-login');
    const btnAccountLogout = document.getElementById('btn-account-logout');
    const btnAccountRefresh = document.getElementById('btn-account-refresh');

    function renderCloudAccountUsage(msg) {
      const isAuthed = msg.plan === 'authenticated';
      const known = msg.status === 'active' || msg.status === 'limit_reached' || msg.status === 'blocked';
      const hasLimit = known && Number.isFinite(msg.limit_today) && msg.limit_today > 0;
      const hasRemaining = Number.isFinite(msg.turns_remaining) && msg.turns_remaining >= 0;
      const remaining = hasLimit && hasRemaining ? Math.min(msg.limit_today, msg.turns_remaining) : null;
      const reached = msg.status === 'limit_reached' || (hasLimit && remaining === 0);
      const blocked = msg.status === 'blocked';
      const username = msg.username && !/^anonymous$/i.test(msg.username) ? msg.username : (isAuthed ? 'Developer' : 'Guest');
      if (accountUsername) accountUsername.textContent = username;
      if (accountPlanBadge) accountPlanBadge.textContent = isAuthed ? 'Signed in' : 'Cloud trial';
      if (accountAvatar) accountAvatar.textContent = username.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || 'AM';
      if (accountPillDot) {
        accountPillDot.classList.toggle('authed', isAuthed);
        accountPillDot.classList.toggle('limit', reached || blocked);
      }
      if (accountPillText) accountPillText.textContent = isAuthed ? 'Signed in' : 'Guest';
      if (btnTopAccount) btnTopAccount.setAttribute('title', 'Cloud account — usage and daily allowance');
      if (accountQuotaVal) {
        accountQuotaVal.textContent = blocked ? 'Access blocked' : reached ? 'Daily limit reached' : known ? 'Available' : msg.status === 'checking' ? 'Checking…' : 'Usage unavailable';
        accountQuotaVal.style.color = blocked || reached ? 'var(--vscode-errorForeground, #f85149)' : known ? 'var(--cloud-success, #3fb950)' : 'var(--muted)';
      }
      if (accountQuotaTrack) {
        accountQuotaTrack.style.display = remaining !== null ? 'block' : 'none';
        if (remaining !== null) {
          accountQuotaTrack.setAttribute('aria-valuemax', '100');
          accountQuotaTrack.setAttribute('aria-valuenow', String(Math.round(remaining / msg.limit_today * 100)));
        }
      }
      if (accountQuotaBar && remaining !== null) {
        const pct = Math.round(remaining / msg.limit_today * 100);
        accountQuotaBar.style.width = pct + '%';
        accountQuotaBar.style.background = pct <= 20 ? 'var(--vscode-errorForeground, #f85149)' : pct <= 50 ? 'var(--vscode-editorWarning-foreground, #d29922)' : 'var(--cloud-success, #3fb950)';
      }
      if (accountResetTimer) {
        accountResetTimer.textContent = '';
        if (hasLimit) {
          const now = new Date();
          const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
          accountResetTimer.textContent = 'Daily allowance resets at ' + reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
        }
      }
      if (btnAccountLogin) btnAccountLogin.style.display = isAuthed ? 'none' : 'block';
      if (btnAccountLogout) btnAccountLogout.style.display = isAuthed ? 'block' : 'none';
    }

    btnTopAccount?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!accountPopover) return;
      const isOpen = accountPopover.style.display !== 'none';
      accountPopover.style.display = isOpen ? 'none' : 'flex';
      if (!isOpen) {
        vscode.postMessage({ type: 'refresh_usage' });
      }
    });

    btnAccountPopoverClose?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (accountPopover) accountPopover.style.display = 'none';
    });

    document.addEventListener('click', (e) => {
      if (accountPopover && accountPopover.style.display !== 'none' && !accountPopover.contains(e.target) && e.target !== btnTopAccount && !btnTopAccount?.contains(e.target)) {
        accountPopover.style.display = 'none';
      }
    });

    btnAccountLogin?.addEventListener('click', () => {
      vscode.postMessage({ type: 'open_login' });
      if (accountPopover) accountPopover.style.display = 'none';
    });

    btnAccountLogout?.addEventListener('click', () => {
      vscode.postMessage({ type: 'logout_account' });
      if (accountPopover) accountPopover.style.display = 'none';
    });

    btnAccountRefresh?.addEventListener('click', () => {
      btnAccountRefresh.style.transform = 'rotate(180deg)';
      setTimeout(() => { if (btnAccountRefresh) btnAccountRefresh.style.transform = ''; }, 300);
      vscode.postMessage({ type: 'refresh_usage' });
    });

    document.getElementById('btn-onboarding-dismiss')?.addEventListener('click', () => {
      toggleOnboarding(false);
    });

    document.getElementById('btn-top-onboarding')?.addEventListener('click', () => {
      toggleOnboarding();
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
      if (!currentOllamaStatus?.running || !currentOllamaStatus.models?.length) return;
      btnOnboardingOllamaSave.disabled = true;
      btnOnboardingOllamaSave.innerHTML = '<span>Activating Ollama...</span>';
      const bestModel = currentOllamaStatus.bestModel || currentOllamaStatus.models[0];
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
          if (btnOnboardingOllamaSave) btnOnboardingOllamaSave.style.display = 'none';
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
      if (onboardingOwnProvider) onboardingOwnProvider.style.display = 'none';
      if (onboardingTrialSection) onboardingTrialSection.style.display = 'none';
      if (onboardingStep2) onboardingStep2.style.display = 'flex';
      if (onboardingStepText) onboardingStepText.textContent = 'Choose a starting model';

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
      if (onboardingOwnProvider) onboardingOwnProvider.style.display = 'block';
      if (onboardingTrialSection) onboardingTrialSection.style.display = 'flex';
      if (onboardingStepText) onboardingStepText.textContent = 'Choose how to connect';

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
        const diffSecs = Math.max(0, Math.floor(diffMs / 1000));
        const diffMins = Math.floor(diffSecs / 60);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffMins < 1 || diffSecs < 60) return 'now';
        if (diffMins < 60) return diffMins + 'm ago';
        if (diffHours < 24) return diffHours + 'h ago';
        if (diffDays === 1) return '1d ago';
        if (diffDays < 7) return diffDays + 'd ago';
        if (diffDays < 30) {
          const weeks = Math.floor(diffDays / 7);
          return weeks + 'w ago';
        }
        if (diffDays < 365) {
          const months = Math.floor(diffDays / 30);
          return months + 'mo ago';
        }
        const years = Math.floor(diffDays / 365);
        return years + 'y ago';
      } catch (e) {
        return '';
      }
    }

    function formatFullTimeTooltip(dateStr) {
      if (!dateStr) return '';
      try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleString();
      } catch (e) {
        return '';
      }
    }

    // The system prompt is stored as a message but is not part of the conversation.
    function sessionMessageCount(s) {
      return typeof s.conversation_count === 'number' ? s.conversation_count : (s.message_count || 0);
    }

    function renderHomeRecentSessions(sessions) {
      if (!recentSessionsSection || !recentSessionsList) return;
      if (!sessions || sessions.length === 0) {
        recentSessionsSection.style.display = 'none';
        return;
      }

      const pastSessionsWithHistory = sessions.filter(s => s.id !== currentSessionId && sessionMessageCount(s) > 0);

      if (pastSessionsWithHistory.length === 0) {
        recentSessionsSection.style.display = 'none';
        return;
      }

      recentSessionsSection.style.display = 'flex';
      const recent = pastSessionsWithHistory.slice(0, 3);
      recentSessionsList.innerHTML = recent.map(s => {
        const name = escapeHtml(cleanPromptForDisplay(s.name) || s.id || 'Untitled Session');
        const dateStr = formatDateBadge(s.updated_at || s.created_at);
        const count = sessionMessageCount(s);
        const msgsText = count + (count === 1 ? ' msg' : ' msgs');
        const modelTag = s.model ? escapeHtml(s.model.split('/').pop().replace(/-/g, ' ')) : '';

        return '<div class="recent-session-card" data-action="switch-session" data-session-id="' + escapeHtml(s.id) + '">' +
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

    function renderRunningLabel() {
      return '<span class="session-badge-status session-status-running status-shimmer">Running</span>';
    }

    function renderSessionItemHtml(s, opts) {
      opts = opts || {};
      const isSubsession = !!opts.isSubsession;
      const isLastChild = !!opts.isLastChild;
      const childrenCount = opts.childrenCount || 0;
      const isExpanded = !!opts.isExpanded;
      const parentName = opts.parentName || '';

      const isCur = s.id === currentSessionId;
      const name = escapeHtml(cleanPromptForDisplay(s.name) || s.id || (isSubsession ? 'Subagent Task' : 'Session'));
      const count = typeof s.conversation_count === 'number' ? s.conversation_count : (s.message_count || 0);
      const msgs = count ? (count + (count === 1 ? ' msg' : ' msgs')) : 'Empty';
      const cost = (s.cost_usd && Number(s.cost_usd) > 0) ? ('$' + Number(s.cost_usd).toFixed(3)) : '';
      const timeStr = formatDateBadge(s.updated_at || s.created_at);
      const timeTooltip = formatFullTimeTooltip(s.updated_at || s.created_at);
      const sessState = sessionsState[s.id];
      const isRunningSess = !!((sessState && sessState.isRunning) || s.status === 'running');

      const runningLabel = isRunningSess ? renderRunningLabel() : '';

      let statusBadge = '';
      if (sessState && sessState.hasUnread && !isCur) {
        statusBadge = '<span class="session-badge-status session-status-unread">New</span>';
      } else if (s.status && s.status !== 'idle' && s.status !== 'running') {
        const rawStatus = String(s.status);
        if (rawStatus === 'watching') {
          statusBadge = '<span class="session-badge-status session-status-watching status-shimmer status-shimmer-slow" title="Watching for events/replies">Watching</span>';
        } else if (rawStatus === 'paused' || rawStatus === 'paused_limit_reached') {
          statusBadge = '<span class="session-badge-status session-status-paused" title="Paused">Paused</span>';
        } else if (rawStatus === 'interrupted') {
          statusBadge = '<span class="session-badge-status session-status-interrupted" title="Andromity stopped before this reply finished, for example because VS Code was closed. Open the chat and send a message to continue.">' +
            '<span>Interrupted</span>' +
          '</span>';
        } else if (rawStatus === 'approval_required') {
          statusBadge = '<span class="session-badge-status session-status-approval_required" title="Action Approval Required">Approval</span>';
        } else {
          const displayLabel = rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1).replace(/_/g, ' ');
          statusBadge = '<span class="session-badge-status session-status-' + escapeHtml(rawStatus) + '">' + escapeHtml(displayLabel) + '</span>';
        }
      }

      const subTag = isSubsession ? '<span class="subsession-tag">Subagent</span>' : '';
      const branchSymbol = isSubsession ? ('<span class="subsession-branch-symbol">' + (isLastChild ? '└' : '├') + '</span>') : '';

      let toggleBtn = '';
      if (!isSubsession && childrenCount > 0) {
        toggleBtn = '<button class="subsession-toggle-btn" data-action="toggle-subsessions" data-parent-id="' + escapeHtml(s.id) + '" title="' + (isExpanded ? 'Collapse' : 'Expand') + ' ' + childrenCount + ' subagent(s)">' +
          '<svg class="subsession-chevron' + (isExpanded ? ' expanded' : '') + '" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
          '<span>' + childrenCount + ' subtask' + (childrenCount === 1 ? '' : 's') + '</span>' +
        '</button>';
      }

      const parentRef = (!isSubsession && parentName) ? ('<span>· Parent: ' + escapeHtml(parentName) + '</span>') : '';
      const itemClass = 'session-item ' + (isSubsession ? 'session-subsession-item ' : '') + (isCur ? 'active' : '');

      return '<div class="' + itemClass + '" data-action="switch-session" data-session-id="' + escapeHtml(s.id) + '" tabindex="0" role="button" aria-label="Open session ' + name + '"' + (isCur ? ' aria-current="true"' : '') + '>' +
        '<div class="session-item-info" data-session-id="' + escapeHtml(s.id) + '">' +
          '<div class="session-item-title">' +
            branchSymbol +
            subTag +
            '<span class="session-title-text" title="' + name + '">' + name + '</span>' +
            runningLabel +
            statusBadge +
          '</div>' +
          '<div class="session-item-meta">' +
            '<span>' + msgs + '</span>' +
            (timeStr ? '<span class="session-item-time" title="' + escapeHtml(timeTooltip) + '">· ' + timeStr + '</span>' : '') +
            (cost ? '<span>· ' + cost + '</span>' : '') +
            parentRef +
            toggleBtn +
          '</div>' +
        '</div>' +
        '<div class="session-item-actions">' +
          '<button class="session-action-icon" data-action="open-session-tab" data-session-id="' + escapeHtml(s.id) + '" data-session-name="' + name + '" title="Open in New Editor Tab (Side-by-Side)">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>' +
          '</button>' +
          '<button class="session-action-icon" data-action="rename-session" data-session-id="' + escapeHtml(s.id) + '" data-session-name="' + name + '" title="Rename">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>' +
          '</button>' +
          '<button class="session-action-icon session-action-delete" data-action="delete-session" data-session-id="' + escapeHtml(s.id) + '" data-session-name="' + name + '" title="Delete">' +
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
            '<div class="session-subsessions-list' + (isExpanded ? '' : ' collapsed') + '" id="subsessions-' + escapeHtml(s.id) + '">' +
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
      if (isPlanTrackerDismissed) return;
      if (!plan || (!plan.title && (!plan.steps || plan.steps.length === 0) && (!plan.todos || plan.todos.length === 0))) {
        hidePlanTracker();
        return;
      }
      const steps = plan.steps || plan.todos || [];
      if (steps.length === 0 && !plan.title) {
        hidePlanTracker();
        return;
      }
      planTrackerStrip.style.display = 'flex';
      document.querySelector('.composer-container')?.classList.add('has-plan-tracker');
      if (isPlanTrackerCollapsed) {
        planTrackerStrip.classList.add('collapsed');
      } else {
        planTrackerStrip.classList.remove('collapsed');
      }
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
          userScrolledUp = true;
          markUserScrollActive();
          btnScrollBottom?.classList.add('visible');
          uWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
          uWrap.style.transition = 'outline 0.15s ease';
          uWrap.style.outline = '1px solid rgba(var(--tint), 0.25)';
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
        userScrolledUp = true;
        markUserScrollActive();
        btnScrollBottom?.classList.add('visible');
        firstWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (timelineFlyout) timelineFlyout.style.display = 'none';
      }
    });
    document.getElementById('btn-timeline-jump-latest')?.addEventListener('click', () => {
      scrollToBottom();
      if (timelineFlyout) timelineFlyout.style.display = 'none';
    });

    const modePopover = document.getElementById('mode-popover');
    const btnPromptMode = document.getElementById('btn-prompt-mode');

    function positionChoiceMenu(menu) {
      menu.style.transform = '';
      const rect = menu.getBoundingClientRect();
      const shift = rect.right > innerWidth - 12 ? innerWidth - 12 - rect.right : rect.left < 12 ? 12 - rect.left : 0;
      menu.style.transform = 'translateX(' + shift + 'px)';
      menu.style.maxHeight = Math.max(80, Math.min(innerHeight - 24, rect.bottom - 12)) + 'px';
    }
    const DOCS_LINKS = ${scriptJson(DOCS)};
    const docsLink = (url, label) => ' <a href="#" class="menu-docs-link" data-action="open-docs" data-url="' + escapeHtml(url) + '">' + label + '</a>';
    function prepareChoiceMenu(menu, trigger, note) {
      if (!menu) return;
      menu.insertAdjacentHTML?.('beforeend', '<div class="menu-popover-note">' + note + '</div>');
      menu.addEventListener('keydown', (event) => {
        const items = [...menu.querySelectorAll('.menu-popover-item')];
        const index = items.indexOf(document.activeElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        } else if (event.key === 'Escape') {
          event.preventDefault(); menu.style.display = 'none';
          trigger?.setAttribute('aria-expanded', 'false'); trigger?.classList.remove('active'); trigger?.focus();
        }
      });
    }
    prepareChoiceMenu(modePopover, btnPromptMode, 'Workspace trust and profile restrictions apply. Full/YOLO share approval rules. Changes apply next turn.' + docsLink(DOCS_LINKS.permissionModes, 'How modes work'));
    window.addEventListener('resize', () => {
      document.querySelectorAll('.mode-popover, .profile-popover').forEach(menu => {
        if (menu.style.display !== 'none') positionChoiceMenu(menu);
      });
    });

    function toggleModePopover(forceState) {
      if (!modePopover) return;
      const isVisible = modePopover.style.display !== 'none';
      const show = typeof forceState === 'boolean' ? forceState : !isVisible;
      if (show) {
        if (reasoningPopover) {
          reasoningPopover.style.display = 'none';
          document.getElementById('btn-prompt-reasoning')?.classList.remove('active');
          document.getElementById('btn-prompt-reasoning')?.setAttribute('aria-expanded', 'false');
        }
        const profPop = document.getElementById('profile-popover');
        if (profPop) {
          profPop.style.display = 'none';
          document.getElementById('btn-prompt-profile')?.classList.remove('active');
          document.getElementById('btn-prompt-profile')?.setAttribute('aria-expanded', 'false');
        }
        if (modelFlyout) modelFlyout.style.display = 'none';
      }
      modePopover.style.display = show ? 'flex' : 'none';
      if (show) { positionChoiceMenu(modePopover); modePopover.querySelector('.menu-popover-item.active')?.focus(); }
      if (btnPromptMode) {
        btnPromptMode.setAttribute('aria-expanded', show ? 'true' : 'false');
        btnPromptMode.classList.toggle('active', show);
      }
    }

    btnPromptMode?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleModePopover();
    });

    document.querySelectorAll('.mode-popover .menu-popover-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const selectedMode = item.getAttribute('data-mode');
        if (selectedMode) {
          vscode.postMessage({ type: 'cycle_mode', nextMode: selectedMode });
        }
        toggleModePopover(false);
      });
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
      const isModeTrigger = e.target.closest('#btn-prompt-mode');
      if (modePopover && !modePopover.contains(e.target) && !isModeTrigger) {
        modePopover.style.display = 'none';
        btnPromptMode?.classList.remove('active');
        btnPromptMode?.setAttribute('aria-expanded', 'false');
      }
      const isProfileTrigger = e.target.closest('#btn-prompt-profile');
      const profilePopover = document.getElementById('profile-popover');
      if (profilePopover && !profilePopover.contains(e.target) && !isProfileTrigger) {
        profilePopover.style.display = 'none';
        document.getElementById('btn-prompt-profile')?.classList.remove('active');
        document.getElementById('btn-prompt-profile')?.setAttribute('aria-expanded', 'false');
      }
      const isReasoningTrigger = e.target.closest('#btn-prompt-reasoning');
      if (reasoningPopover && !reasoningPopover.contains(e.target) && !isReasoningTrigger) {
        reasoningPopover.style.display = 'none';
        const btnReasoningEl = document.getElementById('btn-prompt-reasoning');
        if (btnReasoningEl) {
          btnReasoningEl.setAttribute('aria-expanded', 'false');
          btnReasoningEl.classList.remove('active');
        }
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

    // Collapsible card headers are focusable buttons; Enter/Space reaches them
    // through the role="button" activation in the global keydown handler.
    const TOGGLE_HEADERS = [
      { header: '.thinking-header', card: '.thinking-card', open: (c) => c.classList.contains('expanded') },
      { header: '.tool-header', card: '.tool-card', open: (c) => c.classList.contains('expanded') },
      { header: '.tool-seq-header', card: '.tool-sequence', open: (c) => !c.classList.contains('collapsed') },
    ];
    function syncToggleHeader(header) {
      for (const kind of TOGGLE_HEADERS) {
        if (!header.matches(kind.header)) continue;
        if (!header.hasAttribute('tabindex')) header.setAttribute('tabindex', '0');
        if (!header.hasAttribute('role')) header.setAttribute('role', 'button');
        const card = header.closest(kind.card);
        if (card) header.setAttribute('aria-expanded', kind.open(card) ? 'true' : 'false');
        return;
      }
    }
    function decorateToggleHeaders(root) {
      if (!root || root.nodeType !== 1) return;
      if (root.matches(TOGGLE_HEADERS.map(k => k.header).join(','))) syncToggleHeader(root);
      root.querySelectorAll(TOGGLE_HEADERS.map(k => k.header).join(',')).forEach(syncToggleHeader);
    }
    if (chatContainer && typeof MutationObserver !== 'undefined') {
      const cardSelector = TOGGLE_HEADERS.map(k => k.card).join(',');
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === 'childList') r.addedNodes.forEach(decorateToggleHeaders);
          else if (r.target.matches && r.target.matches(cardSelector)) decorateToggleHeaders(r.target);
        }
      }).observe(chatContainer, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }

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
          const sId = target.getAttribute('data-session-id') || target.closest('[data-session-id]')?.getAttribute('data-session-id');
          if (sId) {
            sessionsFlyout.style.display = 'none';
            if (collabInboxPopover) collabInboxPopover.style.display = 'none';
            hidePlanTracker();
            isPlanTrackerDismissed = false;
            if (sId === currentSessionId) {
              userScrolledUp = false;
              scrollToBottom(false);
              settleSessionScroll();
              break;
            }
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
            vscode.postMessage({ type: 'delete_session', sessionId: delId, sessionName: target.getAttribute('data-session-name') || '' });
          }
          break;
        case 'dismiss-questions':
          e.stopPropagation();
          window.dismissQuestions(target.getAttribute('data-question-id') || '');
          break;
        case 'wake-agent-question': {
          e.stopPropagation();
          if (collabInboxPopover) collabInboxPopover.style.display = 'none';
          const qId = target.getAttribute('data-question-id') || '';
          if (qId && currentSessionId) {
            vscode.postMessage({ type: 'wake_for_question', sessionId: currentSessionId, questionId: qId });
          }
          break;
        }
        case 'resume-auto-wake': {
          e.stopPropagation();
          vscode.postMessage({
            type: 'reset_auto_wake',
            sessionId: currentSessionId,
          });
          break;
        }
        case 'next-step-run':
          runNextStep(target.getAttribute('data-opt-idx'));
          break;
        case 'secret-redact-send': {
          const delivery = secretWarningDelivery;
          promptInput.value = redactSecrets(promptInput.value, findSecrets(promptInput.value));
          hideSecretWarning();
          sendCurrentPrompt(delivery);
          break;
        }
        case 'secret-send-anyway': {
          const delivery = secretWarningDelivery;
          secretWarningAcceptedFor = promptInput.value.trim();
          hideSecretWarning();
          sendCurrentPrompt(delivery);
          break;
        }
        case 'secret-edit':
          hideSecretWarning();
          promptInput.focus();
          break;
        case 'next-step-new-session':
          startNextStepInNewSession();
          break;
        case 'next-step-dismiss':
          dismissNextStep('dismissed');
          promptInput.focus();
          break;
        case 'feature-tip-run':
        case 'feature-tip-menu':
        case 'feature-tip-hide':
        case 'feature-tip-off':
          featureTipAction(action);
          break;
        case 'checkin-sentiment':
        case 'checkin-chip':
        case 'checkin-send':
        case 'checkin-skip':
        case 'checkin-review':
        case 'checkin-never':
        case 'checkin-close':
          checkInAction(action, target);
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
          if (e.preventDefault) e.preventDefault();
          const fPath = target.getAttribute('data-file-path') || target.closest('[data-file-path]')?.getAttribute('data-file-path');
          const lineStr = target.getAttribute('data-line') || target.closest('[data-line]')?.getAttribute('data-line');
          if (fPath) {
            vscode.postMessage({ type: 'open_file', filePath: fPath, line: lineStr ? parseInt(lineStr, 10) : undefined });
          }
          break;
        }
        case 'open-file-diff': {
          const fPath = target.getAttribute('data-file-path') || target.closest('[data-file-path]')?.getAttribute('data-file-path') || target.closest('.file-edited-chip')?.getAttribute('data-file-path') || target.closest('.activity-diff-btn')?.getAttribute('data-file-path') || target.closest('.activity-stats')?.getAttribute('data-file-path');
          if (fPath) {
            vscode.postMessage({ type: 'open_review_tab', filePath: fPath });
          }
          break;
        }
        case 'open-review-tab':
        case 'open-changes-review': {
          let card = target.closest('.files-changed-card');
          let turnFiles = undefined;
          if (!card && target.closest('.activity-row-file')) {
            // Scope an edit row to its own turn. While the turn is still running it
            // has no card yet; null stops the host substituting the previous turn.
            const turnWrap = target.closest('.message-wrap');
            card = turnWrap ? turnWrap.querySelector('.files-changed-card[data-turn-files]') : null;
            turnFiles = null;
          }
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
          e.stopPropagation();
          const idx = parseInt(target.getAttribute('data-idx') || '0', 10);
          removeAttachedFile(idx);
          break;
        }
        case 'clear-all-attached-files': {
          e.stopPropagation();
          attachedFiles = [];
          renderAttachedFiles();
          break;
        }
        case 'open-attached-file': {
          e.stopPropagation();
          const filePath = target.getAttribute('data-path') || '';
          if (filePath) {
            vscode.postMessage({ type: 'open_file', filePath: filePath });
          }
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
        case 'edit-prompt':
          openPromptEditor(target.closest('.message-wrap.user'));
          break;
        case 'cancel-edit-prompt':
          closePromptEditor(target.closest('.message-wrap.user'));
          break;
        case 'resend-prompt':
          resendEditedPrompt(target.closest('.message-wrap.user'));
          break;
        case 'undo-turn': {
          vscode.postMessage(Object.assign({ type: 'undo_turn' }, undoRequestFor(target.closest('.message-wrap.user'))));
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
        case 'open-link': {
          e.preventDefault?.();
          const url = target.getAttribute('data-url');
          if (url) vscode.postMessage({ type: 'open_link', url });
          break;
        }
        case 'open-docs': {
          e.preventDefault?.();
          const url = target.getAttribute('data-url');
          if (url) vscode.postMessage({ type: 'open_external_url', url });
          break;
        }
        case 'retry-turn': {
          const errCard = target.closest('.andromity-error-card, .error-card');
          if (errCard?.dataset.retryPending === 'true') break;
          if (errCard) {
            errCard.style.opacity = '0.5';
            errCard.dataset.retryPending = 'true';
            const btn = errCard.querySelector('.btn-error-retry');
            if (btn && btn.dataset.action === 'retry-turn') btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19"/></svg>Retrying...';
          }
          vscode.postMessage({
            type: 'retry_turn',
            sessionId: currentSessionId,
            stripImages: false, model: currentModel, provider: currentProvider, reasoningEffort: currentReasoning,
          });
          break;
        }
        case 'retry-without-image': {
          const errCard = target.closest('.andromity-error-card, .error-card');
          if (errCard?.dataset.retryPending === 'true') break;
          if (errCard) {
            errCard.style.opacity = '0.5';
            errCard.dataset.retryPending = 'true';
            const btn = errCard.querySelector('.btn-error-retry');
            if (btn && btn.dataset.action === 'retry-without-image') btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19"/></svg>Retrying without image...';
          }
          vscode.postMessage({
            type: 'retry_turn',
            sessionId: currentSessionId,
            stripImages: true, model: currentModel, provider: currentProvider, reasoningEffort: currentReasoning,
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
        case 'open-account-login': {
          vscode.postMessage({ type: 'open_login' });
          break;
        }
        case 'use-without-sign-in': {
          const errCard = target.closest('.andromity-error-card, .error-card');
          if (errCard?.dataset.retryPending === 'true') break;
          if (errCard) {
            errCard.style.opacity = '0.5';
            errCard.dataset.retryPending = 'true';
          }
          vscode.postMessage({
            type: 'sign_out_and_retry',
            sessionId: currentSessionId,
            stripImages: false, model: currentModel, provider: currentProvider, reasoningEffort: currentReasoning,
          });
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
          hideMentionPalette();
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
        case 'open-onboarding':
          toggleOnboarding(true);
          break;
        case 'dismiss-onboarding':
          toggleOnboarding(false);
          break;
        case 'toggle-onboarding':
          toggleOnboarding();
          break;
        case 'open-github-login':
          vscode.postMessage({ type: 'open_github_login' });
          break;
        case 'pick-model':
          pickModel(target.getAttribute('data-model-id'), target.getAttribute('data-provider'));
          break;
        case 'toggle-pin': {
          const mId = target.getAttribute('data-model-id') || target.getAttribute('data-id');
          const pId = target.getAttribute('data-provider');
          const mName = target.getAttribute('data-name');
          if (mId && window.togglePinModel) {
            window.togglePinModel(mId, pId, mName);
          }
          break;
        }
        case 'remove-queued':
          if (queueSupported) vscode.postMessage({ type: 'queue_remove', sessionId: currentSessionId, inputId: target.getAttribute('data-input-id') });
          else removeQueued(parseInt(target.getAttribute('data-idx') || '0', 10));
          break;
        case 'steer-queued':
          vscode.postMessage({ type: 'queue_promote', sessionId: currentSessionId, inputId: target.getAttribute('data-input-id') });
          break;
        case 'resume-queue':
          vscode.postMessage({ type: 'queue_resume', sessionId: currentSessionId });
          break;
        case 'copy-code':
          copyCode(target);
          break;
        case 'apply-code':
          applyCode(target);
          break;
        case 'run-code':
          runCodeInTerminal(target);
          break;
        case 'fix-run':
          fixFailedRun(target);
          break;
        case 'open-mcp-settings':
          vscode.postMessage({ type: 'open_settings', tab: 'mcp' });
          break;
        case 'hide-side-panel':
          closeSidePanelMenu();
          setSidePanelOff(true);
          break;
        case 'sp-toggle-breakdown':
          sidePanelPrefs.breakdown = !sidePanelPrefs.breakdown;
          saveSidePanelPrefs();
          renderSidePanel();
          if (sidePanelPrefs.breakdown) revealSidePanelCard('context');
          break;
        case 'sp-toggle-card':
          setSidePanelCardCollapsed(target.getAttribute('data-card') || '');
          break;
        case 'sp-toggle-hidden':
          closeSidePanelMenu();
          setSidePanelCardHidden(target.getAttribute('data-card') || '');
          break;
        case 'sp-expand-all':
          closeSidePanelMenu();
          sidePanelPrefs.collapsed = [];
          saveSidePanelPrefs();
          renderSidePanel();
          break;
        case 'sp-collapse-all':
          closeSidePanelMenu();
          sidePanelPrefs.collapsed = SIDE_PANEL_CARDS.map(c => c.id);
          saveSidePanelPrefs();
          renderSidePanel();
          break;
        case 'sp-reset-order':
          closeSidePanelMenu();
          sidePanelPrefs.order = SIDE_PANEL_CARDS.map(c => c.id);
          saveSidePanelPrefs();
          applySidePanelOrder();
          break;
        case 'sp-open-menu': {
          const rect = target.getBoundingClientRect();
          openSidePanelMenu(rect.right - 180, rect.bottom + 4);
          break;
        }
        case 'sp-show-all':
          sidePanelPrefs.hidden = [];
          saveSidePanelPrefs();
          renderSidePanel();
          break;
        case 'show-side-panel':
          setSidePanelOff(false);
          break;
        case 'sp-open-diff':
          vscode.postMessage({ type: 'open_diff', filePath: target.getAttribute('data-path') || '' });
          break;
        case 'sp-env':
          openEnvironmentControl(target.getAttribute('data-env') || '');
          break;
        case 'sp-review-all':
          vscode.postMessage({ type: 'open_changes_review' });
          break;
        case 'copy-chat-markdown':
          vscode.postMessage({ type: 'copy_chat_markdown', sessionId: currentSessionId });
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

    // A single-choice question takes either a listed option or the typed answer, not both.
    document.addEventListener('input', (e) => {
      const other = e.target && e.target.closest ? e.target.closest('.question-other-input') : null;
      if (!other || other.getAttribute('data-q-multi') || !other.value.trim()) return;
      document.querySelectorAll('input[name="q_' + other.getAttribute('data-q-idx') + '"]:checked').forEach(r => { r.checked = false; });
    });
    document.addEventListener('change', (e) => {
      const choice = e.target;
      if (!choice || choice.type !== 'radio' || !String(choice.name || '').startsWith('q_') || !choice.checked) return;
      const other = document.getElementById('q_other_' + choice.name.slice(2));
      if (other) other.value = '';
    });

    // CSP-safe Enter handling for free-text question inputs (replaces inline onkeydown)
    document.addEventListener('keydown', (e) => {
      const ta = e.target.closest('.question-textarea, .question-other-input');
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
        const promptBoxEl = document.querySelector('.prompt-box');
        if (promptBoxEl) {
          const pbRect = promptBoxEl.getBoundingClientRect();
          if (pbRect.width > 0) {
            modelFlyout.style.width = Math.round(pbRect.width) + 'px';
            modelFlyout.style.maxWidth = Math.round(pbRect.width) + 'px';
          }
        }
        modelFlyout.style.display = 'flex';
        if (flyoutSearch) flyoutSearch.value = '';
        renderFlyoutList('');
        if (flyoutList) flyoutList.scrollTop = 0;
        if (flyoutSearch) setTimeout(() => flyoutSearch.focus(), 50);
      }
    }

    window.addEventListener('resize', () => {
      if (modelFlyout && modelFlyout.style.display === 'flex') {
        const promptBoxEl = document.querySelector('.prompt-box');
        if (promptBoxEl) {
          const pbRect = promptBoxEl.getBoundingClientRect();
          if (pbRect.width > 0) {
            modelFlyout.style.width = Math.round(pbRect.width) + 'px';
            modelFlyout.style.maxWidth = Math.round(pbRect.width) + 'px';
          }
        }
      }
    });

    function isModelPinned(modelId, provider) {
      if (!pinnedModels || !Array.isArray(pinnedModels)) return false;
      return pinnedModels.some(p => p.id === modelId && (!provider || !p.provider || p.provider === provider));
    }

    window.togglePinModel = function(modelId, provider, name) {
      if (!modelId) return;
      if (!pinnedModels || !Array.isArray(pinnedModels)) pinnedModels = [];
      const idx = pinnedModels.findIndex(p => p.id === modelId && (!provider || !p.provider || p.provider === provider));
      let isPinned = false;
      if (idx >= 0) {
        pinnedModels.splice(idx, 1);
        isPinned = false;
      } else {
        pinnedModels.push({ id: modelId, provider: provider || 'openrouter', name: name || modelId });
        isPinned = true;
      }
      vscode.postMessage({ type: 'toggle_pin', modelId, provider, name, isPinned });
      renderFlyoutList(flyoutSearch ? flyoutSearch.value.toLowerCase().trim() : '');
    };

    /** The one model the session is using: same provider and ID, else same ID, else the bare ID. */
    function activeFlyoutModel(pool) {
      return pool.find(m => m.id === currentModel && (m.provider || 'openrouter') === currentProvider)
        || pool.find(m => m.id === currentModel)
        || { id: currentModel, name: formatModelDisplayName(currentModel), provider: currentProvider };
    }

    function renderFlyoutList(query) {
      if (!flyoutList) return;
      const modelsPool = (allModels && allModels.length > 0) ? allModels : DEFAULT_POPULAR_MODELS;
      const filtered = modelsPool.filter(m => {
        if (!query) return true;
        const hay = ((m.name || '') + ' ' + (m.id || '') + ' ' + (m.provider || '')).toLowerCase();
        return hay.includes(query);
      });

      if (filtered.length === 0) {
        flyoutList.innerHTML = '<div style="padding:14px; text-align:center; color:var(--muted); font-size:11.5px;">No matching models found.<br><button class="prompt-pill-btn" data-action="open-model-hub" style="margin-top:8px;">Browse Model Hub</button></div>';
        return;
      }

      const active = activeFlyoutModel(modelsPool);
      const isActiveModel = m => m.id === active.id && (m.provider || 'openrouter') === (active.provider || 'openrouter');

      function renderFlyoutItem(m) {
        const isActive = isActiveModel(m);
        const isPinned = isModelPinned(m.id, m.provider);
        return '<div class="flyout-item ' + (isActive ? 'active' : '') + '"' + (isActive ? ' aria-current="true"' : '') + ' data-action="pick-model" data-model-id="' + escapeHtml(m.id) + '" data-provider="' + escapeHtml(m.provider || 'openrouter') + '">' +
          '<div class="flyout-item-info">' +
            (isActive ? '<span class="flyout-active-dot"></span>' : '') +
            '<span class="flyout-item-name">' + escapeHtml(m.name || m.id) + '</span>' +
          '</div>' +
          '<div class="flyout-item-actions">' +
            (isActive ? '<span class="flyout-active-label">Active</span>' : '') +
            '<span class="flyout-item-meta">' + escapeHtml(m.provider || 'openrouter') + (m.pricing ? ' · ' + escapeHtml(m.pricing) : '') + '</span>' +
            '<button class="flyout-pin-btn ' + (isPinned ? 'pinned' : '') + '" data-action="toggle-pin" data-model-id="' + escapeHtml(m.id) + '" data-provider="' + escapeHtml(m.provider || 'openrouter') + '" data-name="' + escapeHtml(m.name || m.id) + '" title="' + (isPinned ? 'Unpin model' : 'Pin to top of picker') + '">' +
              '<svg width="11" height="11" viewBox="0 0 24 24" fill="' + (isPinned ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
                '<line x1="12" y1="17" x2="12" y2="22"></line>' +
                '<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>' +
              '</svg>' +
            '</button>' +
          '</div>' +
        '</div>';
      }

      if (!query) {
        const rest = filtered.filter(m => !isActiveModel(m));
        const pinnedItems = rest.filter(m => isModelPinned(m.id, m.provider));
        const otherItems = rest.filter(m => !isModelPinned(m.id, m.provider)).slice(0, 45);

        let html = '<div class="flyout-section-title"><span>CURRENT</span></div>' + renderFlyoutItem(active);
        if (pinnedItems.length > 0) {
          html += '<div class="flyout-section-title"><span>PINNED</span><span class="flyout-section-count">' + pinnedItems.length + '</span></div>';
          html += pinnedItems.map(renderFlyoutItem).join('');
        }
        if (otherItems.length > 0) {
          html += '<div class="flyout-section-title"><span>ALL MODELS</span></div>';
          html += otherItems.map(renderFlyoutItem).join('');
        }
        flyoutList.innerHTML = html;
      } else {
        const rank = m => (isActiveModel(m) ? 2 : 0) + (isModelPinned(m.id, m.provider) ? 1 : 0);
        const sorted = [...filtered].sort((a, b) => rank(b) - rank(a)).slice(0, 50);
        flyoutList.innerHTML = sorted.map(renderFlyoutItem).join('');
      }
    }

    window.pickModel = function(modelId, provider) {
      currentModel = modelId;
      if (provider) currentProvider = provider;
      // Invalidate capability of previous model so UI does not stay locked in stale state
      currentModelReasoningCapability = null;
      const newCap = getActiveModelReasoningCapability();
      if (newCap.mode !== 'none' && (!currentReasoning || currentReasoning === 'off')) {
        currentReasoning = newCap.default_effort || 'medium';
      }
      updateModelBadge();
      modelFlyout.style.display = 'none';
      vscode.postMessage({ type: 'update_config', key: 'model', value: modelId, provider: provider || currentProvider });
    };

    window.openModelHub = function() {
      vscode.postMessage({ type: 'open_model_hub' });
    };

    window.sendStarter = function(promptText) {
      promptInput.value = promptText;
      sendCurrentPrompt();
    };

    function formatModelDisplayName(id) {
      if (!id || id === 'Loading model...') return 'Choose a model';
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
    let REASONING_LEVELS = [];
    let currentModelReasoningCapability = null;

    function getActiveModelReasoningCapability() {
      if (currentModelReasoningCapability && currentModelReasoningCapability._modelId === currentModel &&
          currentModelReasoningCapability._providerId === currentProvider) {
        return currentModelReasoningCapability;
      }
      const found = (allModels || []).find(m => m.id === currentModel && m.provider === currentProvider);
      return found?.reasoning || { mode: 'unknown', supported_efforts: [], default_effort: 'auto' };
    }

    function getReasoningChoices(cap) {
      const ids = ['auto'];
      (cap.supported_efforts || []).forEach(value => {
        if (typeof value !== 'string') return;
        const id = value === 'none' ? 'off' : value;
        if (cap.is_mandatory && id === 'off') return;
        if (!ids.includes(id)) ids.push(id);
      });
      const ascending = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'on'];
      const rank = id => ascending.includes(id) ? ascending.indexOf(id) : ascending.length;
      ids.sort((a, b) => rank(a) - rank(b));
      return ids.map((id, idx) => ({
        id, label: id === 'auto' ? 'Auto' : id.charAt(0).toUpperCase() + id.slice(1),
        pct: ids.length > 1 ? idx * 100 / (ids.length - 1) : 0,
      }));
    }

    function hasReasoningControls(cap) {
      return (Array.isArray(cap.supported_efforts) && cap.supported_efforts.length > 0) ||
        (cap.supports_max_tokens === true && Number.isInteger(cap.budget_min) && Number.isInteger(cap.budget_max));
    }

    function validReasoningBudget(cap, value) {
      if (!cap.supports_max_tokens || !['google_budget', 'anthropic_budget'].includes(cap.request_format)) return false;
      if (!/^budget:[0-9]+$/.test(value || '')) return false;
      const budget = Number(value.slice(7));
      return Number.isInteger(cap.budget_min) && Number.isInteger(cap.budget_max) &&
        budget >= cap.budget_min && budget <= cap.budget_max && (budget !== 0 || cap.supported_efforts.includes('off'));
    }
    let attachedImages = [];
    let attachedFiles = [];
    let currentActiveEditorContext = null;

    const BINARY_FILE_EXTENSIONS = new Set([
      'exe', 'dll', 'bin', 'so', 'dylib', 'zip', 'tar', 'gz', '7z', 'rar', 'iso',
      'dmg', 'class', 'pyc', 'pyo', 'o', 'obj', 'wasm', 'db', 'sqlite', 'parquet'
    ]);

    function getFileIconBadge(fileName) {
      const ext = (fileName || '').split('.').pop().toLowerCase();
      // Returns { badge: '<i class="codicon ..."></i>', color: string, isHtml: true }
      // Callers must use innerHTML (not textContent) when isHtml is true.
      const icon = (cls, color) => ({
        badge: '<i class="codicon ' + cls + '" aria-hidden="true"></i>',
        color,
        isHtml: true,
      });
      switch (ext) {
        case 'ts':
          return icon('codicon-file-code', 'var(--vscode-charts-blue, #38bdf8)');
        case 'tsx':
        case 'jsx':
          return icon('codicon-file-code', 'var(--vscode-charts-blue, #61dafb)');
        case 'js':
        case 'mjs':
        case 'cjs':
          return icon('codicon-file-code', 'var(--vscode-charts-yellow, #f7df1e)');
        case 'py':
          return icon('codicon-file-code', 'var(--vscode-charts-green, #4ade80)');
        case 'rs':
          return icon('codicon-file-code', 'var(--vscode-charts-orange, #f97316)');
        case 'go':
          return icon('codicon-file-code', 'var(--vscode-charts-blue, #38bdf8)');
        case 'java':
        case 'kt':
          return icon('codicon-file-code', 'var(--vscode-charts-red, #f87171)');
        case 'cpp':
        case 'c':
        case 'h':
        case 'cs':
          return icon('codicon-file-code', 'var(--vscode-charts-purple, #a78bfa)');
        case 'rb':
        case 'php':
        case 'swift':
          return icon('codicon-file-code', 'var(--vscode-charts-orange, #fb923c)');
        case 'html':
        case 'htm':
          return icon('codicon-file-code', 'var(--vscode-charts-orange, #fb923c)');
        case 'css':
        case 'scss':
        case 'less':
          return icon('codicon-file-code', 'var(--vscode-charts-purple, #c084fc)');
        case 'json':
        case 'jsonc':
          return icon('codicon-json', 'var(--vscode-charts-yellow, #facc15)');
        case 'md':
        case 'markdown':
          return icon('codicon-markdown', 'var(--vscode-charts-blue, #93c5fd)');
        case 'yml':
        case 'yaml':
        case 'toml':
        case 'ini':
        case 'env':
          return icon('codicon-settings-gear', 'var(--vscode-charts-green, #a3e635)');
        case 'sql':
        case 'db':
        case 'sqlite':
          return icon('codicon-database', 'var(--vscode-charts-purple, #a78bfa)');
        case 'png':
        case 'jpg':
        case 'jpeg':
        case 'gif':
        case 'svg':
        case 'webp':
        case 'ico':
          return icon('codicon-file-media', 'var(--vscode-charts-green, #4ade80)');
        case 'zip':
        case 'tar':
        case 'gz':
        case '7z':
        case 'rar':
          return icon('codicon-file-zip', 'var(--vscode-charts-orange, #f97316)');
        case 'pdf':
          return icon('codicon-file-pdf', 'var(--vscode-errorForeground, #f87171)');
        case 'txt':
        case 'log':
          return icon('codicon-file-text', 'var(--vscode-descriptionForeground, #94a3b8)');
        default:
          return icon('codicon-file', 'var(--vscode-descriptionForeground, #94a3b8)');
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
      const chipsHtml = attachedFiles.map((file, idx) => {
        const iconInfo = getFileIconBadge(file.name);
        return '<span class="dropped-file-chip" data-action="open-attached-file" data-path="' + escapeHtml(file.path || file.name) + '" title="Click to open in editor (' + escapeHtml(file.path || file.name) + ')">' +
          '<span class="chip-icon" style="color:' + iconInfo.color + ';">' + iconInfo.badge + '</span>' +
          '<span class="chip-name">' + escapeHtml(file.name) + '</span>' +
          '<button class="chip-remove-btn" data-action="remove-attached-file" data-idx="' + idx + '" title="Remove file" aria-label="Remove ' + escapeHtml(file.name) + '">&#x2715;</button>' +
        '</span>';
      }).join('');

      const clearAllHtml = attachedFiles.length >= 2
        ? '<button class="attached-files-clear-btn" data-action="clear-all-attached-files" title="Remove all attached files">Clear all (' + attachedFiles.length + ')</button>'
        : '';

      container.innerHTML = '<div class="attached-files-list">' + chipsHtml + '</div>' + clearAllHtml;
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

    const PROFILE_ICONS = {
      builder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.34a1 1 0 0 0 0 1.4l1.56 1.56a1 1 0 0 0 1.4 0l3.08-3.08a4.5 4.5 0 0 1-5.78 5.78l-7.22 7.22a2 2 0 0 1-2.83 0l-.88-.88a2 2 0 0 1 0-2.83l7.22-7.22a4.5 4.5 0 0 1 5.78-5.78l-3.08 3.08Z"></path></svg>',
      coder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>',
      planner: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"></line><line x1="10" y1="12" x2="21" y2="12"></line><line x1="10" y1="18" x2="21" y2="18"></line><polyline points="3 6 4 7 6 5"></polyline><polyline points="3 12 4 13 6 11"></polyline><polyline points="3 18 4 19 6 17"></polyline></svg>',
      reviewer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><path d="m8 11 2 2 4-4"></path></svg>'
    };

    function updateProfileBadge() {
      if (typeof scheduleSidePanelEnv === 'function') scheduleSidePanelEnv();
      const lbl = document.getElementById('prompt-profile-label');
      const iconEl = document.getElementById('prompt-profile-icon');
      const p = (currentProfile || 'builder').toLowerCase();
      const display = p.charAt(0).toUpperCase() + p.slice(1);

      if (lbl) {
        lbl.textContent = display.toUpperCase();
        if (typeof lbl.removeAttribute === 'function') {
          if (typeof lbl.removeAttribute === 'function') lbl.removeAttribute('aria-busy');
        }
        if (lbl.classList && typeof lbl.classList.remove === 'function') {
          lbl.classList.remove('skeleton', 'skeleton-text');
        }
        if (lbl.parentElement) {
          lbl.parentElement.title = 'Profile: ' + display + ' (Click to choose)';
        }
      }
      if (iconEl && PROFILE_ICONS[p]) {
        iconEl.innerHTML = PROFILE_ICONS[p];
      }
      document.querySelectorAll('.profile-popover .menu-popover-item').forEach(item => {
        const itemProf = item.getAttribute('data-profile');
        item.classList.toggle('active', itemProf === p);
      });
    }

    function getReasoningLevelIndex(val) {
      const idx = REASONING_LEVELS.findIndex(l => l.id === val);
      return idx >= 0 ? idx : 0;
    }

    function setReasoningLevel(levelId, notifyExtension) {
      const cap = getActiveModelReasoningCapability();
      if (!hasReasoningControls(cap)) return;
      const choices = getReasoningChoices(cap);
      if (!choices.some(level => level.id === levelId) && !validReasoningBudget(cap, levelId)) return;
      currentReasoning = levelId;
      updateReasoningUI();
      if (notifyExtension) {
        vscode.postMessage({ type: 'update_config', key: 'reasoningEffort', value: currentReasoning });
      }
    }

    function updateReasoningUI() {
      const cap = getActiveModelReasoningCapability();
      const controlsAvailable = hasReasoningControls(cap);
      REASONING_LEVELS = getReasoningChoices(cap);
      if (!REASONING_LEVELS.some(level => level.id === currentReasoning) && !validReasoningBudget(cap, currentReasoning)) {
        currentReasoning = cap.default_effort && REASONING_LEVELS.some(level => level.id === cap.default_effort)
          ? cap.default_effort : 'auto';
      }
      const idx = getReasoningLevelIndex(currentReasoning);
      const lvl = REASONING_LEVELS[idx];
      const isBudget = validReasoningBudget(cap, currentReasoning);
      const label = controlsAvailable
        ? (isBudget ? currentReasoning.slice(7) + ' tokens' : lvl.label)
        : 'N/A';
      const btn = document.getElementById('btn-prompt-reasoning');
      if (btn) {
        btn.classList.toggle('is-unsupported', !controlsAvailable);
        btn.disabled = !controlsAvailable;
        btn.setAttribute('aria-disabled', controlsAvailable ? 'false' : 'true');
        btn.title = controlsAvailable
          ? (cap.description || 'Thinking effort: ' + label)
          : 'Thinking controls are unavailable for this model';
      }
      const activeReasoningPopover = document.getElementById('reasoning-popover');
      if (!controlsAvailable && activeReasoningPopover) {
        activeReasoningPopover.style.display = 'none';
        if (btn) {
          btn.classList.remove('active');
          btn.setAttribute('aria-expanded', 'false');
        }
      }
      const lbl = document.getElementById('prompt-reasoning-label');
      if (lbl) {
        lbl.textContent = label;
        if (typeof lbl.removeAttribute === 'function') lbl.removeAttribute('aria-busy');
        lbl.classList.remove('skeleton', 'skeleton-text');
      }
      const slider = document.getElementById('reasoning-slider-range');
      if (slider) {
        slider.min = '0';
        slider.max = String(REASONING_LEVELS.length - 1);
        slider.value = String(idx);
        slider.disabled = REASONING_LEVELS.length < 2;
      }
      const fill = document.getElementById('reasoning-slider-fill');
      if (fill) {
        fill.style.width = lvl.pct + '%';
        fill.className = 'reasoning-slider-fill';
      }
      const labels = document.getElementById('reasoning-slider-labels');
      const ticks = document.getElementById('reasoning-slider-ticks');
      if (labels) labels.innerHTML = "";
      if (ticks) ticks.innerHTML = "";
      REASONING_LEVELS.forEach((level, levelIdx) => {
        if (labels) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'reasoning-step-btn' + (currentReasoning === level.id ? ' active' : '');
          button.setAttribute("data-level", level.id);
          button.textContent = level.label;
          if (typeof button.addEventListener === 'function') button.addEventListener('click', () => setReasoningLevel(level.id, true));
          labels.appendChild(button);
        }
        if (ticks) {
          const tick = document.createElement('span');
          tick.className = 'reasoning-tick-point' + (levelIdx <= idx ? ' active' : '');
          tick.title = level.label;
          if (typeof tick.addEventListener === 'function') tick.addEventListener('click', () => setReasoningLevel(level.id, true));
          ticks.appendChild(tick);
        }
      });
      const budgetInput = document.getElementById('reasoning-budget-input');
      const budgetRow = document.getElementById('reasoning-budget-row');
      const hasBudget = cap.supports_max_tokens && Number.isInteger(cap.budget_min) && Number.isInteger(cap.budget_max);
      if (budgetRow) budgetRow.hidden = !hasBudget;
      if (budgetInput && hasBudget) {
        budgetInput.min = String(cap.budget_min);
        budgetInput.max = String(cap.budget_max);
        budgetInput.value = isBudget ? currentReasoning.slice(7) : '';
        budgetInput.placeholder = cap.budget_min + '–' + cap.budget_max;
      }
    }

    function updateReasoningBadge() {
      if (typeof scheduleSidePanelEnv === 'function') scheduleSidePanelEnv();
      updateReasoningUI();
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
          '<img class="image-attachment-thumb" src="' + escapeHtml(imgUri) + '" alt="Attachment ' + (idx + 1) + '" />' +
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
    const profilePopover = document.getElementById('profile-popover');
    prepareChoiceMenu(profilePopover, document.getElementById('btn-prompt-profile'), 'Choose how the agent approaches the task. Changes apply to subsequent turns.' + docsLink(DOCS_LINKS.profiles, 'Compare profiles'));

    function toggleProfilePopover(forceState) {
      if (!profilePopover) return;
      const isVisible = profilePopover.style.display !== 'none';
      const show = typeof forceState === 'boolean' ? forceState : !isVisible;
      if (show) {
        if (reasoningPopover) {
          reasoningPopover.style.display = 'none';
          document.getElementById('btn-prompt-reasoning')?.classList.remove('active');
          document.getElementById('btn-prompt-reasoning')?.setAttribute('aria-expanded', 'false');
        }
        if (modePopover) {
          modePopover.style.display = 'none';
          document.getElementById('btn-prompt-mode')?.classList.remove('active');
          document.getElementById('btn-prompt-mode')?.setAttribute('aria-expanded', 'false');
        }
        if (modelFlyout) modelFlyout.style.display = 'none';
      }
      profilePopover.style.display = show ? 'flex' : 'none';
      if (show) { positionChoiceMenu(profilePopover); profilePopover.querySelector('.menu-popover-item.active')?.focus(); }
      if (btnProfileEl) {
        btnProfileEl.setAttribute('aria-expanded', show ? 'true' : 'false');
        btnProfileEl.classList.toggle('active', show);
      }
    }

    if (btnProfileEl) {
      btnProfileEl.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleProfilePopover();
      });
    }

    document.querySelectorAll('.profile-popover .menu-popover-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const selectedProfile = item.getAttribute('data-profile');
        if (selectedProfile && availableProfiles.includes(selectedProfile.toLowerCase())) {
          currentProfile = selectedProfile.toLowerCase();
          updateProfileBadge();
          vscode.postMessage({ type: 'update_profile', value: currentProfile });
          vscode.postMessage({ type: 'update_config', key: 'profile', value: currentProfile });
        }
        toggleProfilePopover(false);
      });
    });

    const btnReasoningEl = document.getElementById('btn-prompt-reasoning');
    const btnReasoningClose = document.getElementById('btn-reasoning-close');
    const reasoningSlider = document.getElementById('reasoning-slider-range');

    function toggleReasoningPopover(forceState) {
      if (!reasoningPopover) return;
      if (!hasReasoningControls(getActiveModelReasoningCapability())) {
        reasoningPopover.style.display = 'none';
        if (btnReasoningEl) {
          btnReasoningEl.classList.remove('active');
          btnReasoningEl.setAttribute('aria-expanded', 'false');
        }
        return;
      }
      const isVisible = reasoningPopover.style.display !== 'none';
      const show = typeof forceState === 'boolean' ? forceState : !isVisible;
      reasoningPopover.style.display = show ? 'flex' : 'none';
      if (btnReasoningEl) {
        btnReasoningEl.setAttribute('aria-expanded', show ? 'true' : 'false');
        btnReasoningEl.classList.toggle('active', show);
      }
      if (show) {
        updateReasoningUI();
        if (reasoningSlider) {
          reasoningSlider.focus();
        }
      }
    }

    if (btnReasoningEl) {
      btnReasoningEl.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleReasoningPopover();
      });
    }

    if (btnReasoningClose) {
      btnReasoningClose.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleReasoningPopover(false);
      });
    }

    if (reasoningSlider) {
      reasoningSlider.addEventListener('input', (e) => {
        const valIdx = parseInt(e.target.value, 10);
        const lvl = REASONING_LEVELS[valIdx];
        if (lvl) setReasoningLevel(lvl.id, true);
      });
    }

    document.getElementById('reasoning-budget-apply')?.addEventListener('click', () => {
      const input = document.getElementById('reasoning-budget-input');
      if (input && input.value && input.checkValidity()) setReasoningLevel('budget:' + String(Number(input.value)), true);
    });

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
            '<span style="color:var(--muted); font-size:11px; border:1px solid var(--border); padding:1px 5px; border-radius:3px; margin-left:4px;">v' + extensionVersion + '</span>' +
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

    /** Chip label: catalogs name models "Vendor: Model (free)"; the vendor and
     *  suffix are already in the tooltip and only push the model name off the chip. */
    function compactModelName(name) {
      const withoutVendor = String(name || '').replace(/^[^:]{1,40}:[ ]+/, '');
      const withoutSuffix = withoutVendor.replace(/[ ]+[(][^)]*[)]$/, '');
      return withoutSuffix || withoutVendor || String(name || '');
    }

    function updateModelBadge() {
      if (typeof scheduleSidePanelEnv === 'function') scheduleSidePanelEnv();
      const found = allModels.find(m => m.id === currentModel);
      let name = found ? (found.name || found.id) : formatModelDisplayName(currentModel);
      if (!name || name === "Loading model...") {
        name = "Choose a model";
      }
      if (activeModelName) {
        activeModelName.textContent = name;
        activeModelName.title = "Model: " + currentModel + " (" + currentProvider + ")";
      }
      const promptModelLabel = document.getElementById('prompt-model-label');
      if (promptModelLabel) {
        // The label starts as an 11px-high loading skeleton; leaving those
        // classes on clipped the bottom of the real model name.
        promptModelLabel.classList.remove('skeleton', 'skeleton-text');
        promptModelLabel.removeAttribute('aria-busy');
        promptModelLabel.style.minWidth = '';
        promptModelLabel.textContent = compactModelName(name);
        if (promptModelLabel.parentElement) {
          promptModelLabel.parentElement.title = "Active Model: " + currentModel + " (" + currentProvider + ") - Click to switch";
        }
      }
      updateProfileBadge();
      updateReasoningBadge();
    }
    updateModelBadge();

    let secretWarningAcceptedFor = null;
    let secretWarningDelivery = undefined;

    function hideSecretWarning() {
      const box = document.getElementById('secret-warning');
      if (box) box.remove();
    }

    // Local models keep text on this machine; anything else goes to a provider and into session history.
    function showSecretWarning(secrets, delivery) {
      hideSecretWarning();
      secretWarningDelivery = delivery;
      const box = document.createElement('div');
      box.id = 'secret-warning';
      box.className = 'secret-warning';
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-labelledby', 'secret-warning-title');
      const kinds = Array.from(new Set(secrets.map(s => s.label)));
      const what = secrets.length === 1 ? 'a ' + kinds[0] : secrets.length + ' secrets (' + kinds.join(', ') + ')';
      box.innerHTML = '<div class="secret-warning-title" id="secret-warning-title">This message looks like it contains ' + escapeHtml(what) + '</div>' +
        '<div class="secret-warning-body">Sending it shares it with the model provider and saves it in this session. ' +
          secrets.map(s => '<code>' + escapeHtml(s.preview) + '</code>').join(' ') + '</div>' +
        '<div class="secret-warning-actions">' +
          '<button class="secret-warning-btn primary" data-action="secret-redact-send">Redact and send</button>' +
          '<button class="secret-warning-btn" data-action="secret-send-anyway">Send anyway</button>' +
          '<button class="secret-warning-btn" data-action="secret-edit">Edit message</button>' +
        '</div>';
      const promptBox = document.querySelector('.prompt-box');
      if (promptBox && promptBox.parentElement) promptBox.parentElement.insertBefore(box, promptBox);
      const primary = box.querySelector('[data-action="secret-redact-send"]');
      if (primary) primary.focus();
    }

    function sendCurrentPrompt(delivery) {
      if (pendingInputDraft) return;
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

      if (text && currentProvider !== 'ollama' && secretWarningAcceptedFor !== text) {
        const secrets = findSecrets(text);
        if (secrets.length) {
          showSecretWarning(secrets, delivery);
          return;
        }
      }
      secretWarningAcceptedFor = null;
      hideSecretWarning();

      if (text) {
        if (sentPromptsHistory.length === 0 || sentPromptsHistory[sentPromptsHistory.length - 1] !== text) {
          sentPromptsHistory.push(text);
        }
        promptHistoryIndex = sentPromptsHistory.length;
        tempPromptDraft = '';
      }

      if (!queueSupported) {
      promptInput.value = '';
      promptInput.style.height = 'auto';
      sendBtn.classList.remove('has-text');
      attachedImages = [];
      renderImageAttachments();
      attachedFiles = [];
      renderAttachedFiles();
      }

      let fullText = text;
      if (filesToSend.length > 0) {
        const filePrefix = filesToSend.map(function(f) {
          return '[Attached File: ' + (f.path || f.name) + ']';
        }).join(String.fromCharCode(10));
        fullText = filePrefix + (fullText ? String.fromCharCode(10) + fullText : '');
      }

      const promptPayload = fullText || (imagesToSend.length > 0 ? 'Please inspect attached image' : 'Please inspect attached files');

      if (queueSupported) {
        const requestId = 'input-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        pendingInputDraft = { requestId, text, images: imagesToSend, files: filesToSend, sessionId: currentSessionId };
        dispatchPrompt(promptPayload, true, imagesToSend, delivery === 'steer' ? 'steer' : 'queue', requestId);
        return;
      }

      if (isRunning) {
        promptQueue.push({ text: promptPayload, images: imagesToSend, sessionId: currentSessionId });
        renderQueue();
        return;
      }
      dispatchPrompt(promptPayload, true, imagesToSend);
    }

    function dispatchPrompt(text, attachContext, images, delivery, requestId) {
      try {
        setNextStep(currentSessionId, null);
        if (queueSupported) {
          vscode.postMessage({
            type: 'submit_input', requestId: requestId || ('input-' + Date.now() + '-' + Math.random().toString(36).slice(2)),
            prompt: text, sessionId: currentSessionId, images: images || [],
            delivery: delivery || 'queue', attachContext,
            profile: currentProfile, mode: currentMode, model: currentModel,
            provider: currentProvider, reasoningEffort: currentReasoning,
          });
          return;
        }
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
      if (queueSupported) return;
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
      if (queueSupported) {
        const state = serverQueues[currentSessionId];
        const items = state ? state.items : [];
        queueContainer.style.display = items.length ? 'flex' : 'none';
        const steerIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20v-7a4 4 0 0 1 4-4h12"/><path d="m15 4 5 5-5 5"/></svg>';
        const removeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
        const playIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>';
        queueContainer.innerHTML = '<div class="queue-header"><span>Queued <span class="queue-count">' + items.length + '</span></span>' +
          (state && state.paused ? '<button class="queue-resume" data-action="resume-queue" title="Resume pending messages">' + playIcon + 'Resume</button>' : '') + '</div><div class="queue-items">' +
          items.map(function(item, index) {
            const id = escapeHtml(item.id);
            const steering = item.delivery === 'steer';
            const text = escapeHtml(parseUserPromptDisplay(item.prompt).userText || 'Image message');
            return '<div class="queue-chip' + (steering ? ' is-steering' : '') + '"><span class="queue-index">' + (index + 1) + '</span>' +
              '<span class="queue-text" title="' + text + '">' + text + '</span>' +
              (item.image_count ? '<span class="queue-attachment" title="Attached images">' + item.image_count + ' img</span>' : '') +
              (steering ? '<span class="queue-status" title="Waiting for the current response and tool operations to finish">Next safe point</span>' : '') +
              '<div class="queue-actions"><button class="queue-action queue-steer" data-action="steer-queued" data-input-id="' + id + '"' + (steering ? ' disabled' : '') +
              ' title="Steer at the next safe point" aria-label="Steer queued message at the next safe point">' + steerIcon + '</button>' +
              '<button class="queue-action queue-remove" data-action="remove-queued" data-input-id="' + id + '" title="Remove from queue" aria-label="Remove queued message">' + removeIcon + '</button></div></div>';
          }).join('') + '</div>';
        return;
      }
      const sessionQueue = promptQueue.filter(q => !q.sessionId || q.sessionId === currentSessionId);
      if (sessionQueue.length === 0) {
        queueContainer.style.display = 'none';
        queueContainer.innerHTML = '';
        return;
      }
      queueContainer.style.display = 'flex';
      queueContainer.innerHTML = promptQueue.map((q, i) => {
        if (q.sessionId && q.sessionId !== currentSessionId) return '';
        const rawText = typeof q === 'object' ? q.text : q;
        const text = parseUserPromptDisplay(rawText).userText || 'Image prompt';
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

    const RUNNABLE_SHELL_LANGS = ${scriptJson(Object.keys(SHELL_LANGUAGES))};

    function renderCodeBlockHeader(lang, code) {
      var language = String(lang || 'code').trim() || 'code';
      var enc = encodeURIComponent(code || '');
      var runnable = RUNNABLE_SHELL_LANGS.indexOf(language.toLowerCase()) !== -1 && String(code || '').trim() !== '';
      var runBtn = runnable
        ? '<button class="code-btn code-run-btn" data-code="' + enc + '" data-lang="' + escapeHtml(language.toLowerCase()) + '" data-action="run-code" title="Run in a new terminal" aria-label="Run in a new terminal"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg> Run</button>'
        : '';
      return '<div class="code-block-header">' +
        '<span class="code-lang-tag">' + escapeHtml(language.toUpperCase()) + '</span>' +
        '<div class="code-block-toolbar">' +
          '<div class="code-block-actions">' +
            '<button class="code-btn" data-code="' + enc + '" data-action="copy-code"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy</button>' +
            '<button class="code-btn" data-code="' + enc + '" data-action="apply-code"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg> Insert</button>' +
          '</div>' +
          runBtn +
        '</div>' +
      '</div>';
    }

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

    function detectPathType(text) {
      if (!text || typeof text !== 'string') return null;
      var str = text.trim();
      if (!str || str.length > 250 || str.indexOf('\\n') !== -1 || str.indexOf('\\r') !== -1) return null;
      if (str.indexOf('*') !== -1 || str.indexOf('?') !== -1) return null;
      if (/^\\.[a-zA-Z0-9]+$/.test(str)) return null;
      if (/^[a-zA-Z0-9_-]+\\s*\\(.*?\\)$/.test(str)) return null;
      if (/[;{}<>=!|&]/.test(str)) return null;
      if (str.startsWith('-') || str.startsWith('--')) return null;
      if (str.indexOf(' ') !== -1 && !str.startsWith('/') && !str.startsWith('./') && !/^[a-zA-Z]:[\\\\/]/.test(str)) {
        return null;
      }

      var clean = str.replace(/[?#].*$/, '');
      var lower = clean.toLowerCase();

      if (clean.endsWith('/') || clean.endsWith('\\\\')) {
        return { type: 'folder', path: clean.replace(/[\\\\/]+$/, '') };
      }

      if (typeof workspaceFolders !== 'undefined' && workspaceFolders && workspaceFolders.has(lower)) {
        return { type: 'folder', path: clean };
      }

      if (typeof workspaceFiles !== 'undefined' && workspaceFiles && workspaceFiles.has(lower)) {
        return { type: 'file', path: clean };
      }

      var commonFolders = new Set([
        '_internal', 'test', 'tests', 'walkthroughs', 'media', 'assets', 'src', 'bin',
        'dist', 'build', 'scripts', 'docs', 'components', 'utils', 'lib', 'packages',
        'pages', 'styles', 'public', 'views', 'panels', 'providers', 'integrations'
      ]);
      if (commonFolders.has(lower)) {
        return { type: 'folder', path: clean };
      }

      var fileExtRegex = /\\.(tsx?|jsx?|mjs|cjs|py|pyw|html?|css|scss|sass|less|json|md|markdown|rs|go|c|cpp|h|hpp|java|kt|kts|sql|sh|bash|ps1|bat|cmd|yml|yaml|toml|ini|cfg|env|lock|svg|png|jpg|jpeg|gif|webp|ico|spec|dockerfile|gitignore)$/i;
      if (fileExtRegex.test(clean)) {
        return { type: 'file', path: clean };
      }

      var genericExtMatch = clean.match(/^([a-zA-Z0-9_\\-\\.\\/\\\\~]+)\\.([a-zA-Z0-9]{1,6})(:\\d+)?$/);
      if (genericExtMatch && !clean.startsWith('http://') && !clean.startsWith('https://')) {
        var ext = genericExtMatch[2].toLowerCase();
        if ((!/^\\d+$/.test(ext) && ['com', 'org', 'net', 'io', 'dev', 'app', 'ai'].indexOf(ext) === -1) || clean.indexOf('/') !== -1 || clean.indexOf('\\\\') !== -1) {
          return { type: 'file', path: clean };
        }
      }

      if (clean.indexOf('/') !== -1 || clean.indexOf('\\\\') !== -1) {
        var lastSeg = clean.split(/[\\\\/]/).pop() || '';
        if (lastSeg.indexOf('.') !== -1 && !lastSeg.startsWith('.')) {
          return { type: 'file', path: clean };
        }
        return { type: 'folder', path: clean };
      }

      return null;
    }

    function renderFileOrFolderChip(detected, originalText) {
      var isDir = detected.type === 'folder';
      var cleanPath = detected.path;
      var safePath = escapeHtml(cleanPath);
      var safeDisplay = escapeHtml(originalText || cleanPath);

      if (isDir) {
        var folderSvg = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.85; flex-shrink:0;"><path d="M1.5 13.5v-9a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"></path><path d="M1.5 7h13"></path></svg>';
        return '<span class="md-file-pill is-dir" data-action="open-file" data-file-path="' + safePath + '" title="Click to reveal folder in Explorer sidebar (' + safePath + ')">' +
          '<span class="pill-icon folder-icon">' + folderSvg + '</span>' +
          '<span class="pill-name">' + safeDisplay + '</span>' +
        '</span>';
      }

      var badgeInfo = typeof getFileIconBadge === 'function' ? getFileIconBadge(cleanPath) : { badge: '<i class="codicon codicon-file" aria-hidden="true"></i>', color: '#94a3b8', isHtml: true };
      var badgeHtml = '<span class="pill-icon file-icon" style="color:' + badgeInfo.color + ';">' + badgeInfo.badge + '</span>';

      return '<span class="md-file-pill is-file" data-action="open-file" data-file-path="' + safePath + '" title="Click to open file in new tab (' + safePath + ')">' +
        badgeHtml +
        '<span class="pill-name">' + safeDisplay + '</span>' +
      '</span>';
    }

    try {
      if (typeof marked !== 'undefined') {
        const markedRenderer = {
          codespan(token) {
            const text = token && typeof token === 'object' ? (token.text || '') : String(token || '');
            const detected = detectPathType(text);
            if (detected) {
              return renderFileOrFolderChip(detected, text);
            }
            return '<code>' + escapeHtml(text) + '</code>';
          },
          code(token) {
            const text = token && typeof token === 'object' ? (token.text || '') : String(token || '');
            const lang = token && typeof token === 'object' ? (token.lang || 'code') : 'code';
            const language = (lang || 'code').trim();
            const highlighted = highlightCode(text, language);
            return '<div class="code-block-container">' +
              renderCodeBlockHeader(language, text) +
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
          // Model output can carry prompt-injected markup (fake action buttons, overlays), so raw HTML renders as text.
          html(token) {
            const raw = token && typeof token === 'object' ? (token.text || token.raw || '') : String(token || '');
            return escapeHtml(raw);
          },
          link(token) {
            const href = token && typeof token === 'object' ? (token.href || '#') : String(token || '#');
            const title = token && typeof token === 'object' ? token.title : '';
            const text = token && typeof token === 'object' && token.tokens && this.parser
              ? this.parser.parseInline(token.tokens)
              : escapeHtml(token && typeof token === 'object' ? (token.text || href) : href);
            if (href.startsWith('file://')) {
              var fpath = href.startsWith('file:///') ? href.slice(8) : href.slice(7);
              var line = 0;
              var hashMatch = href.match(/#L(\d+)/i);
              if (hashMatch) line = parseInt(hashMatch[1], 10);
              return '<a href="#" class="md-file-link" data-action="open-file" data-file-path="' + escapeHtml(fpath) + '"' + (line ? (' data-line="' + line + '"') : '') + ' style="color:var(--accent); text-decoration:underline;"' + (title ? (' title="' + escapeHtml(title) + '"') : '') + '>' + text + '</a>';
            }
            if (!href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('mailto:') && !href.startsWith('#')) {
              return '<a href="#" class="md-file-link" data-action="open-file" data-file-path="' + escapeHtml(href) + '" style="color:var(--accent); text-decoration:underline;"' + (title ? (' title="' + escapeHtml(title) + '"') : '') + '>' + text + '</a>';
            }
            if (href.startsWith('#')) return '<a href="' + escapeHtml(href) + '" style="color:var(--accent); text-decoration:underline;">' + text + '</a>';
            return externalLinkHtml(href, text, title);
          },
          image(token) {
            const href = token && typeof token === 'object' ? (token.href || '') : String(token || '');
            const title = token && typeof token === 'object' ? token.title : '';
            const text = token && typeof token === 'object' ? token.text : '';
            // Remote images would load without a click and can carry data out in the URL; show them as links instead.
            if (!href.startsWith('data:image/')) {
              const label = escapeHtml(text || href);
              if (href.startsWith('http://') || href.startsWith('https://')) return externalLinkHtml(href, label, '');
              return label;
            }
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
      t = t.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, function(_, label, href) {
        return /^https?:\\/\\//i.test(href) ? externalLinkHtml(href.replace(/&amp;/g, '&'), label, '') : label;
      });

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
        var rawCode = codeSpans[i];
        var detected = detectPathType(rawCode);
        var repl = detected ? renderFileOrFolderChip(detected, rawCode) : ('<code>' + escapeHtml(rawCode) + '</code>');
        t = t.split(token).join(repl);
      }
      return t;
    }

    // Provider errors arrive from the backend as an andromity-error-card HTML block inside the reply text.
    // Raw HTML renders as text, so a card that starts a line outside a code fence is rebuilt from its
    // plain text and allowlisted actions instead of being trusted as markup.
    const ERROR_CARD_OPEN = '<div class="andromity-error-card"';
    function renderMarkdown(md) {
      if (!md || md.indexOf(ERROR_CARD_OPEN) === -1) return renderMarkdownText(md);
      let html = '';
      let from = 0;
      let start;
      while ((start = md.indexOf(ERROR_CARD_OPEN, from)) !== -1) {
        const end = errorCardMarkupEnd(md, start);
        const card = end !== -1 && startsLineOutsideFence(md, start) ? errorCardFromMarkup(md.slice(start, end)) : '';
        if (card) {
          html += renderMarkdownText(md.slice(0, start)) + card;
          md = md.slice(end);
          from = 0;
        } else {
          from = start + ERROR_CARD_OPEN.length;
        }
      }
      return html + renderMarkdownText(md);
    }

    function renderMarkdownText(md) {
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
          html += '<div class="code-block-container">' +
            renderCodeBlockHeader(lang, code) +
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

            // Raw HTML in model output renders as text, matching the marked renderer.
            if (trimmed.startsWith('<')) {
              html += '<p>' + escapeHtml(trimmed) + '</p>';
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

    /** Shared "Copied" affordance for message actions; restores the idle label after 1.6s. */
    function flashCopied(btn, label) {
      if (!btn || !btn.classList) return;
      if (!btn._idleHtml) btn._idleHtml = btn.innerHTML;
      btn.classList.add('copied');
      const labelEl = document.createElement('span');
      labelEl.className = 'msg-action-label';
      labelEl.textContent = label || 'Copied';
      btn.innerHTML = FOOTER_CHECK_ICON;
      btn.appendChild(labelEl);
      setTimeout(function() {
        btn.classList.remove('copied');
        if (btn._idleHtml) btn.innerHTML = btn._idleHtml;
      }, 1600);
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

    // ── Wide-mode session panel (Context, Changes, MCP, Environment) ────────
    // var, not let/const: the token counter can render before this block runs.
    var sidePanelData = { mcp: null, changes: undefined, folder: '' };
    var sidePanelRequestedAt = 0;
    var SIDE_PANEL_WIDE = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1100px)') : null;
    var SIDE_PANEL_CARDS = [
      { id: 'context', title: 'Context window', icon: '<path d="M12 3a9 9 0 1 0 9 9"></path><path d="M12 3v9h9"></path>' },
      { id: 'changes', title: 'Changes', icon: '<path d="M6 3v12"></path><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path>' },
      { id: 'mcp', title: 'MCP servers', icon: '<path d="M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0V8zM12 17v5"></path>' },
      { id: 'env', title: 'Environment', icon: '<rect x="3" y="4" width="18" height="12" rx="2"></rect><path d="M8 20h8M12 16v4"></path>' },
    ];
    var normalizeSidePanelPreferences = ${normalizeSidePanelPreferences.toString()};
    var sidePanelDragId = null;
    var sidePanelPrefs = normalizeSidePanelPreferences(${scriptJson(state.sidePanelPreferences ?? null)});
    try {
      const saved = localStorage.getItem('andromity.sidePanel');
      if (${state.sidePanelPreferences === undefined} && typeof saved === 'string' && saved) {
        sidePanelPrefs = normalizeSidePanelPreferences(JSON.parse(saved));
        vscode.postMessage({ type: 'side_panel_preferences', preferences: sidePanelPrefs });
      }
    } catch (e) {}

    /** Fades the panel's top or bottom edge only while there is more to scroll that way. */
    function updateSidePanelScrollEdges() {
      const panel = document.getElementById('side-panel-body');
      if (!panel || !panel.classList) return;
      const max = panel.scrollHeight - panel.clientHeight;
      panel.classList.toggle('can-scroll-up', panel.scrollTop > 2);
      panel.classList.toggle('can-scroll-down', max - panel.scrollTop > 2);
    }

    function saveSidePanelPrefs() {
      try { localStorage.setItem('andromity.sidePanel', JSON.stringify(sidePanelPrefs)); } catch (e) {}
      vscode.postMessage({ type: 'side_panel_preferences', preferences: sidePanelPrefs });
    }

    function applySidePanelOrder() {
      const panel = document.getElementById('side-panel-body');
      if (!panel) return;
      const current = Array.from(panel.children || []).filter(el => el.classList.contains('sp-card')).map(el => el.id.slice(3));
      if (current.join(',') === sidePanelPrefs.order.join(',')) return;
      sidePanelPrefs.order.forEach(id => {
        const card = document.getElementById('sp-' + id);
        if (card) panel.appendChild(card);
      });
    }

    function focusSidePanelHandle(id) {
      const card = document.getElementById('sp-' + id);
      const handle = card && card.querySelector('.sp-drag-handle');
      if (handle) handle.focus({ preventScroll: true });
    }

    function moveSidePanelCard(id, targetId, after) {
      if (id === targetId || !sidePanelPrefs.order.includes(id) || !sidePanelPrefs.order.includes(targetId)) return;
      const order = sidePanelPrefs.order.filter(item => item !== id);
      order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, id);
      if (order.join(',') === sidePanelPrefs.order.join(',')) return;
      sidePanelPrefs.order = order;
      applySidePanelOrder();
      saveSidePanelPrefs();
      const status = document.getElementById('sp-reorder-status');
      const card = SIDE_PANEL_CARDS.find(c => c.id === id);
      if (status) status.textContent = card.title + ' moved to position ' + (order.indexOf(id) + 1) + ' of ' + order.length + '.';
      updateSidePanelScrollEdges();
    }

    function clearSidePanelDrag() {
      sidePanelDragId = null;
      SIDE_PANEL_CARDS.forEach(c => {
        const el = document.getElementById('sp-' + c.id);
        if (el) el.classList.remove('sp-dragging', 'sp-drop-before', 'sp-drop-after');
      });
    }

    function sidePanelVisible() {
      return !!(SIDE_PANEL_WIDE && SIDE_PANEL_WIDE.matches) && !document.body.classList.contains('side-panel-off');
    }

    function requestSidePanelData() {
      if (!sidePanelVisible() || Date.now() - sidePanelRequestedAt < 5000) return;
      sidePanelRequestedAt = Date.now();
      vscode.postMessage({ type: 'side_panel_refresh' });
    }

    function setSidePanelOff(off, persist = true) {
      document.body.classList.toggle('side-panel-off', off);
      try { localStorage.setItem('andromity.sidePanelOff', off ? '1' : '0'); } catch (e) {}
      if (persist) vscode.postMessage({ type: 'side_panel_visibility', off: off });
      if (!off) { requestSidePanelData(); renderSidePanel(); }
    }

    function toggleListValue(list, value) {
      const i = list.indexOf(value);
      if (i === -1) list.push(value); else list.splice(i, 1);
    }

    function setSidePanelCardCollapsed(id) {
      toggleListValue(sidePanelPrefs.collapsed, id);
      saveSidePanelPrefs();
      renderSidePanel();
      if (sidePanelPrefs.collapsed.indexOf(id) === -1) revealSidePanelCard(id);
    }

    /** After a card opens, bring all of it into view inside the panel, without moving the chat. */
    function revealSidePanelCard(id) {
      const panel = document.getElementById('side-panel-body');
      const card = document.getElementById('sp-' + id);
      if (!panel || !card || typeof card.getBoundingClientRect !== 'function') return;
      const top = panel.getBoundingClientRect().top;
      const bottom = panel.getBoundingClientRect().bottom;
      const rect = card.getBoundingClientRect();
      let delta = 0;
      if (rect.bottom > bottom - 12) delta = rect.bottom - bottom + 12;
      if (rect.top - delta < top + 4) delta = rect.top - top - 4;
      if (delta && typeof panel.scrollBy === 'function') panel.scrollBy({ top: delta, behavior: 'smooth' });
    }

    function setSidePanelCardHidden(id) {
      toggleListValue(sidePanelPrefs.hidden, id);
      saveSidePanelPrefs();
      renderSidePanel();
    }

    function spRow(tag, attrs, inner) {
      return '<' + tag + ' class="sp-row"' + (tag === 'button' ? ' type="button"' : '') + (attrs || '') + '>' + inner + '</' + tag + '>';
    }

    /** One card: a header that collapses it (with a one-line summary) and its body. */
    function renderSidePanelCard(id, summaryHtml, bodyHtml) {
      if (sidePanelDragId) return;
      const el = document.getElementById('sp-' + id);
      if (!el) return;
      const card = SIDE_PANEL_CARDS.find(c => c.id === id);
      if (!card || sidePanelPrefs.hidden.indexOf(id) !== -1 || bodyHtml === null) {
        el.innerHTML = '';
        el.hidden = true;
        return;
      }
      const collapsed = sidePanelPrefs.collapsed.indexOf(id) !== -1;
      el.hidden = false;
      el.classList.toggle('collapsed', collapsed);
      el.innerHTML =
        '<div class="sp-card-header">' +
        '<button type="button" class="sp-drag-handle" draggable="true" data-card="' + id + '" aria-label="Reorder ' + card.title + '" aria-describedby="sp-reorder-help" title="Drag to reorder · Up/Down to move">' +
          '<svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true"><circle cx="4" cy="4" r="1"></circle><circle cx="8" cy="4" r="1"></circle><circle cx="4" cy="8" r="1"></circle><circle cx="8" cy="8" r="1"></circle><circle cx="4" cy="12" r="1"></circle><circle cx="8" cy="12" r="1"></circle></svg></button>' +
        '<button type="button" class="sp-head" data-action="sp-toggle-card" data-card="' + id + '" aria-expanded="' + !collapsed + '" aria-controls="sp-body-' + id + '">' +
          '<svg class="sp-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + card.icon + '</svg>' +
          '<span class="sp-head-title">' + card.title + '</span>' +
          '<span class="sp-head-summary">' + (summaryHtml || '') + '</span>' +
          '<svg class="sp-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
        '</button></div>' +
        '<div class="sp-body" id="sp-body-' + id + '"' + (collapsed ? ' hidden' : '') + '>' + bodyHtml + '</div>';
    }

    function renderSidePanelContext() {
      const data = currentBreakdown();
      const fallbackLimit = modelContextCapacity();
      if (!data && !fallbackLimit) { renderSidePanelCard('context', '', null); return; }
      const view = data ? contextView(data) : {
        limit: fallbackLimit, used: lastTokenState.contextTok || lastTokenState.estimate || 0,
        rows: [], free: 0, buffer: 0, autoCompact: false, note: '', foot: '', compactDisabled: true,
        pctOf: (n) => (n / fallbackLimit) * 100, fmtPct: () => '',
      };
      const pct = view.limit ? Math.min(100, Math.max(0, view.used / view.limit * 100)) : 0;
      const ringColor = pct > 85 ? 'var(--vscode-errorForeground, #f85149)' : pct > 65 ? 'var(--vscode-editorWarning-foreground, #d29922)' : 'var(--vscode-textLink-foreground, #3794ff)';
      const tone = pct > 85 ? ' full' : pct > 65 ? ' warn' : '';
      renderSidePanelCard('context', '<span class="sp-pill' + tone + '">' + Math.round(pct) + '%</span>',
        '<div class="context-popover-top">' +
          '<div class="context-ring-wrap">' +
            '<svg class="context-ring-svg" width="36" height="36" viewBox="0 0 36 36">' +
              '<circle cx="18" cy="18" r="14" fill="none" style="stroke: rgba(var(--tint), 0.1)" stroke-width="3.5"></circle>' +
              '<circle cx="18" cy="18" r="14" fill="none" stroke="' + ringColor + '" stroke-width="3.5" stroke-dasharray="87.96" stroke-dashoffset="' + (87.96 * (1 - pct / 100)).toFixed(2) + '" stroke-linecap="round" transform="rotate(-90 18 18)"></circle>' +
            '</svg>' +
            '<span class="context-ring-text">' + Math.round(pct) + '%</span>' +
          '</div>' +
          '<div class="context-popover-header-info">' +
            '<div class="context-popover-title">Session tokens</div>' +
            '<div class="context-popover-subtitle">' + Number(view.used).toLocaleString() + ' / ' + Number(view.limit).toLocaleString() + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="sp-description">Token usage and space for the next steps.</div>' +
        '<div class="context-popover-rows">' +
          '<div class="context-popover-row"><div class="context-row-label"><span class="context-dot dot-used"></span><span>Used tokens</span></div><span class="context-row-val">' + Number(view.used).toLocaleString() + '</span></div>' +
          '<div class="context-popover-row"><div class="context-row-label"><span class="context-dot dot-avail"></span><span>Available</span></div><span class="context-row-val">' + Number(Math.max(0, view.limit - view.used)).toLocaleString() + '</span></div>' +
        '</div>' +
        (data ? '<button type="button" class="sp-breakdown-toggle" data-action="sp-toggle-breakdown" aria-expanded="' + sidePanelPrefs.breakdown + '">' +
            '<span>Breakdown</span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg></button>' +
          '<div class="context-stack" aria-hidden="true">' + contextStackHtml(view) + '</div>' +
          (sidePanelPrefs.breakdown ? '<div class="context-cat-list">' + contextRowsHtml(view) + '</div>' : '') +
          '<div class="context-breakdown-foot sp-context-foot"><span>' + escapeHtml(view.note) + '</span>' +
            '<button class="context-compact-btn" type="button" data-action="compact-session"' + (view.compactDisabled ? ' disabled' : '') + '>Compact now</button></div>' +
          '<div class="context-breakdown-note">' + escapeHtml(view.foot) + '</div>' : ''));
    }

    /** GitHub-style five-block bar showing the share of added and removed lines. */
    function diffBlocks(additions, deletions) {
      const total = additions + deletions;
      if (!total) return '';
      const filled = Math.min(5, Math.max(1, Math.round(Math.log10(total + 1) * 2)));
      const green = Math.round(filled * additions / total);
      let html = '';
      for (let i = 0; i < 5; i++) html += '<i class="' + (i < green ? 'add' : i < filled ? 'del' : '') + '"></i>';
      return '<span class="sp-diffbar" aria-hidden="true">' + html + '</span>';
    }

    function renderSidePanelChanges() {
      const changes = sidePanelData.changes;
      if (changes === undefined) { renderSidePanelCard('changes', '', null); return; }
      if (changes === null) { renderSidePanelCard('changes', '', '<div class="sp-empty">This folder is not a git repository.</div>'); return; }
      const files = changes.files || [];
      if (!files.length) {
        renderSidePanelCard('changes', '<span class="sp-muted">Clean</span>',
          '<div class="sp-clean"><i class="codicon codicon-check" aria-hidden="true"></i> No uncommitted changes' + (changes.branch ? ' on <strong>' + escapeHtml(changes.branch) + '</strong>' : '') + '</div>');
        return;
      }
      const visibleFiles = files.slice(0, 5);
      const remaining = files.length - visibleFiles.length;
      const rows = visibleFiles.map(f => {
        const name = f.path.split('/').pop() || f.path;
        const dir = f.path.slice(0, f.path.length - name.length).replace(/\\/$/, '');
        const isNew = f.status === 'U' || f.status === '??' || f.status === 'A';
        const isDel = f.status === 'D';
        const icon = typeof getFileIconBadge === 'function' ? getFileIconBadge(name) : null;
        const counts = f.additions === null
          ? '<span class="sp-meta">' + (isNew ? 'new file' : 'binary') + '</span>'
          : '<span class="sp-counts"><span class="sp-add">+' + f.additions + '</span><span class="sp-del">&minus;' + f.deletions + '</span></span>' + diffBlocks(f.additions, f.deletions);
        return '<button type="button" class="sp-file' + (isDel ? ' deleted' : '') + '" data-action="sp-open-diff" data-path="' + escapeHtml(f.path) + '" title="Open the diff for ' + escapeHtml(f.path) + '" aria-label="' + escapeHtml(f.path) + ', ' + (isNew ? 'new file' : isDel ? 'deleted' : 'modified') + ', open diff">' +
          '<span class="sp-file-icon"' + (icon ? ' style="color:' + icon.color + '"' : '') + '>' + (icon ? icon.badge : '') + '</span>' +
          '<span class="sp-file-text"><span class="sp-file-name">' + escapeHtml(name) + '</span>' +
            '<span class="sp-file-dir">' + escapeHtml(dir || 'Workspace root') + '</span></span>' +
          '<span class="sp-file-stats"><span class="sp-status ' + (isNew ? 'new' : isDel ? 'del' : 'mod') + '" title="' + (isNew ? 'New' : isDel ? 'Deleted' : 'Modified') + '">' + (isNew ? 'U' : isDel ? 'D' : 'M') + '</span>' + counts + '</span>' +
        '</button>';
      }).join('');
      renderSidePanelCard('changes',
        '<span class="sp-add">+' + changes.additions + '</span>&nbsp;<span class="sp-del">&minus;' + changes.deletions + '</span>',
        '<div class="sp-changes-summary">' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' changed' + (changes.branch ? ' on <strong>' + escapeHtml(changes.branch) + '</strong>' : '') + '</div>' +
        '<div class="sp-files">' + rows + '</div>' +
        (remaining ? '<button type="button" class="sp-link sp-more" data-action="sp-review-all">View ' + remaining + ' more changed file' + (remaining === 1 ? '' : 's') + '</button>' : '') +
        '<div class="sp-buttons"><button type="button" class="context-compact-btn" data-action="sp-review-all">Review changes</button></div>');
    }

    function mcpStatusView(status) {
      if (status === 'running') return { tone: 'running status-shimmer', label: 'Running' };
      if (status === 'needs_auth') return { tone: 'warn', label: 'Sign in' };
      if (status === 'needs_trust') return { tone: 'warn', label: 'Trust folder' };
      if (status === 'initializing') return { tone: 'status-shimmer', label: 'Starting…' };
      if (status === 'disabled') return { tone: '', label: 'Off' };
      if (status === 'error') return { tone: 'error', label: 'Error' };
      return { tone: '', label: status };
    }

    function renderSidePanelMcp() {
      const servers = sidePanelData.mcp;
      if (!servers) { renderSidePanelCard('mcp', '', null); return; }
      const running = servers.filter(s => s.status === 'running').length;
      const attention = servers.filter(s => s.status === 'needs_auth' || s.status === 'error' || s.status === 'needs_trust').length;
      const tools = servers.reduce((sum, s) => sum + (s.status === 'running' ? s.tools : 0), 0);
      const rows = servers.map(s => {
        const view = mcpStatusView(s.status);
        return '<button type="button" class="sp-server" data-action="open-mcp-settings" title="Manage ' + escapeHtml(s.name) + ' in MCP settings">' +
          '<span class="sp-server-text"><span class="sp-server-name">' + escapeHtml(s.name) + '</span>' +
            '<span class="sp-server-kind">' + (s.remote ? 'Remote' : 'Local') + (s.status === 'running' ? ' · ' + s.tools + ' tool' + (s.tools === 1 ? '' : 's') : '') + '</span></span>' +
          '<span class="sp-server-status ' + view.tone + '">' + escapeHtml(view.label) + '</span>' +
        '</button>';
      }).join('');
      const summary = servers.length
        ? (attention ? '<span class="sp-pill warn">' + attention + ' need' + (attention === 1 ? 's' : '') + ' attention</span>' : '<span class="sp-muted">' + running + '/' + servers.length + ' running</span>')
        : '';
      renderSidePanelCard('mcp', summary,
        (servers.length ? '<div class="sp-description">Connected tools for this session.</div><div class="sp-server-list">' + rows + '</div><div class="sp-server-total">' + tools + ' tool' + (tools === 1 ? '' : 's') + ' available from running servers</div>'
          : '<div class="sp-empty">No MCP servers yet. They let the agent use tools like databases, issue trackers and docs.</div>') +
        '<div class="sp-buttons"><button type="button" class="context-compact-btn" data-action="open-mcp-settings">' + (servers.length ? 'Manage servers' : 'Add a server') + '</button></div>');
    }

    var sidePanelEnvTimer = null;
    function scheduleSidePanelEnv() {
      if (sidePanelEnvTimer) clearTimeout(sidePanelEnvTimer);
      sidePanelEnvTimer = setTimeout(() => { sidePanelEnvTimer = null; if (sidePanelVisible()) renderSidePanelEnv(); }, 0);
    }

    function envLabel(id) {
      const el = document.getElementById(id);
      return el ? String(el.textContent || '').trim() : '';
    }

    function renderSidePanelEnv() {
      const pill = document.getElementById('airgap-pill');
      const branch = sidePanelData.changes && sidePanelData.changes.branch;
      const model = envLabel('prompt-model-label') || (currentModel ? String(currentModel).split('/').pop() : '');
      const mode = envLabel('prompt-mode-label') || (currentMode ? String(currentMode).toUpperCase() : '');
      const rows = [
        { id: 'model', icon: 'sparkle', label: 'Model', value: model, hint: 'Change model' },
        { id: 'mode', icon: 'shield', label: 'Mode', value: mode, hint: 'Change permission mode' },
        { id: 'profile', icon: 'person', label: 'Profile', value: envLabel('prompt-profile-label'), hint: 'Change working profile' },
        { id: 'reasoning', icon: 'lightbulb', label: 'Reasoning', value: envLabel('prompt-reasoning-label'), hint: 'Change reasoning effort' },
        { id: 'branch', icon: 'git-branch', label: 'Branch', value: branch || '', hint: 'Switch branch' },
        { id: 'folder', icon: 'folder', label: 'Folder', value: sidePanelData.folder || '', hint: 'Show in Explorer' },
        { id: 'network', icon: pill && !pill.hidden ? 'lock' : 'globe', label: 'Network', value: pill && !pill.hidden ? 'Air-gap' : 'Online', hint: pill && !pill.hidden ? 'Air-gap mode settings' : 'Turn on air-gap mode' },
      ].filter(r => r.value);
      renderSidePanelCard('env', branch ? '<span class="sp-muted" title="Branch: ' + escapeHtml(branch) + '"><i class="codicon codicon-git-branch" aria-hidden="true"></i> ' + escapeHtml(branch) + '</span>' : '',
        rows.length ? '<div class="sp-description">Select a setting to change it.</div>' + rows.map(r =>
          '<button type="button" class="sp-env-row' + (r.id === 'branch' ? ' sp-env-divider' : '') + '" data-action="sp-env" data-env="' + r.id + '" title="' + r.hint + ': ' + escapeHtml(r.value) + '">' +
            '<i class="codicon codicon-' + r.icon + ' sp-env-icon" aria-hidden="true"></i>' +
            '<span class="sp-env-label">' + r.label + '</span>' +
            '<span class="sp-env-value' + (r.id === 'mode' ? ' mode-' + escapeHtml(String(currentMode || '').toLowerCase()) : '') + (r.id === 'network' && r.value === 'Air-gap' ? ' airgap' : '') + '">' + escapeHtml(r.value) + '</span>' +
            '<i class="codicon codicon-chevron-right sp-env-go" aria-hidden="true"></i>' +
          '</button>').join('') : null);
    }

    /** Opens the control behind an Environment row: the prompt bar's pickers, or a VS Code command. */
    function openEnvironmentControl(id) {
      const pickers = { model: 'btn-prompt-model', mode: 'btn-prompt-mode', profile: 'btn-prompt-profile', reasoning: 'btn-prompt-reasoning' };
      if (pickers[id]) {
        // After this click finishes, so the picker's outside-click handler does not close it at once.
        setTimeout(() => {
          const button = document.getElementById(pickers[id]);
          if (button) { button.click(); if (typeof button.focus === 'function') button.focus(); }
        }, 0);
        return;
      }
      const commands = { branch: 'git.checkout', folder: 'workbench.view.explorer', network: 'andromity.toggleAirGap' };
      if (commands[id]) vscode.postMessage({ type: 'side_panel_command', command: commands[id] });
    }

    function renderSidePanel() {
      const mcpBtn = document.getElementById('btn-mcp-status');
      if (mcpBtn && sidePanelData.mcpTooltip) {
        mcpBtn.title = sidePanelData.mcpTooltip;
        mcpBtn.setAttribute('aria-label', sidePanelData.mcpTooltip);
      }
      if (!sidePanelVisible()) return;
      renderSidePanelContext();
      renderSidePanelChanges();
      renderSidePanelMcp();
      renderSidePanelEnv();
      applySidePanelOrder();
      const empty = document.getElementById('sp-empty-all');
      if (empty) empty.hidden = sidePanelPrefs.hidden.length < SIDE_PANEL_CARDS.length;
      updateSidePanelScrollEdges();
    }

    // ── Choose which cards show: right-click the panel, or its ⋯ button ──
    function closeSidePanelMenu() {
      const menu = document.getElementById('sp-menu');
      if (menu) menu.hidden = true;
    }

    function openSidePanelMenu(x, y) {
      const menu = document.getElementById('sp-menu');
      if (!menu) return;
      menu.innerHTML = '<div class="sp-menu-label">Show in panel</div>' +
        SIDE_PANEL_CARDS.map(c => {
          const shown = sidePanelPrefs.hidden.indexOf(c.id) === -1;
          return '<button type="button" class="sp-menu-item" role="menuitemcheckbox" aria-checked="' + shown + '" data-action="sp-toggle-hidden" data-card="' + c.id + '">' +
            '<span class="sp-check">' + (shown ? '&#10003;' : '') + '</span>' + c.title + '</button>';
        }).join('') +
        '<div class="sp-menu-sep"></div>' +
        '<button type="button" class="sp-menu-item" role="menuitem" data-action="sp-expand-all"><span class="sp-check"></span>Expand all</button>' +
        '<button type="button" class="sp-menu-item" role="menuitem" data-action="sp-collapse-all"><span class="sp-check"></span>Collapse all</button>' +
        '<button type="button" class="sp-menu-item" role="menuitem" data-action="sp-reset-order"><span class="sp-check"></span>Reset section order</button>' +
        '<button type="button" class="sp-menu-item" role="menuitem" data-action="hide-side-panel"><span class="sp-check"></span>Hide panel</button>';
      menu.hidden = false;
      const rect = menu.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, x)) + 'px';
      menu.style.top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, y)) + 'px';
      const first = menu.querySelector('.sp-menu-item');
      if (first && typeof first.focus === 'function') first.focus();
    }

    const sidePanelEl = document.getElementById('side-panel');
    const sidePanelBodyEl = document.getElementById('side-panel-body');
    if (sidePanelBodyEl && typeof sidePanelBodyEl.addEventListener === 'function') {
      sidePanelBodyEl.addEventListener('dragstart', (e) => {
        const handle = e.target.closest('.sp-drag-handle');
        if (!handle || !e.dataTransfer) return;
        sidePanelDragId = handle.getAttribute('data-card');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-andromity-section', sidePanelDragId);
        document.getElementById('sp-' + sidePanelDragId).classList.add('sp-dragging');
        closeSidePanelMenu();
      });
      sidePanelBodyEl.addEventListener('dragover', (e) => {
        if (!sidePanelDragId) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        SIDE_PANEL_CARDS.forEach(c => document.getElementById('sp-' + c.id)?.classList.remove('sp-drop-before', 'sp-drop-after'));
        const card = e.target.closest('.sp-card');
        if (card && card.id !== 'sp-' + sidePanelDragId) {
          const rect = card.getBoundingClientRect();
          card.classList.add(e.clientY < rect.top + rect.height / 2 ? 'sp-drop-before' : 'sp-drop-after');
        }
        const rect = sidePanelBodyEl.getBoundingClientRect();
        if (e.clientY < rect.top + 36) sidePanelBodyEl.scrollBy({ top: -18, behavior: 'auto' });
        else if (e.clientY > rect.bottom - 36) sidePanelBodyEl.scrollBy({ top: 18, behavior: 'auto' });
      });
      sidePanelBodyEl.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && sidePanelBodyEl.contains(e.relatedTarget)) return;
        SIDE_PANEL_CARDS.forEach(c => document.getElementById('sp-' + c.id)?.classList.remove('sp-drop-before', 'sp-drop-after'));
      });
      sidePanelBodyEl.addEventListener('drop', (e) => {
        if (!sidePanelDragId) return;
        e.preventDefault();
        e.stopPropagation();
        const id = sidePanelDragId;
        const card = e.target.closest('.sp-card');
        const rect = card && card.getBoundingClientRect();
        clearSidePanelDrag();
        if (card) moveSidePanelCard(id, card.id.slice(3), e.clientY >= rect.top + rect.height / 2);
        renderSidePanel();
        focusSidePanelHandle(id);
      });
      sidePanelBodyEl.addEventListener('dragend', () => {
        if (!sidePanelDragId) return;
        const id = sidePanelDragId;
        clearSidePanelDrag();
        renderSidePanel();
        focusSidePanelHandle(id);
      });
      sidePanelBodyEl.addEventListener('keydown', (e) => {
        const handle = e.target.closest('.sp-drag-handle');
        if (!handle || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const id = handle.getAttribute('data-card');
        const visible = sidePanelPrefs.order.filter(item => !document.getElementById('sp-' + item)?.hidden);
        const index = visible.indexOf(id);
        const target = e.key === 'Home' ? visible[0] : e.key === 'End' ? visible[visible.length - 1] : visible[index + (e.key === 'ArrowUp' ? -1 : 1)];
        if (target) moveSidePanelCard(id, target, e.key === 'ArrowDown' || e.key === 'End');
        focusSidePanelHandle(id);
        revealSidePanelCard(id);
      });
      sidePanelBodyEl.addEventListener('scroll', updateSidePanelScrollEdges, { passive: true });
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updateSidePanelScrollEdges).observe(sidePanelBodyEl);
    }
    if (sidePanelEl && typeof sidePanelEl.addEventListener === 'function') {
      sidePanelEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openSidePanelMenu(e.clientX, e.clientY);
      });
    }
    const sidePanelMenuEl = document.getElementById('sp-menu');
    if (sidePanelMenuEl && typeof sidePanelMenuEl.addEventListener === 'function') {
      sidePanelMenuEl.addEventListener('keydown', (e) => {
        const items = Array.from(sidePanelMenuEl.querySelectorAll('.sp-menu-item'));
        const index = items.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); closeSidePanelMenu(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const next = items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
          if (next) next.focus();
        }
      });
    }
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('sp-menu');
      if (menu && !menu.hidden && e.target && typeof e.target.closest === 'function' && !e.target.closest('#sp-menu') && !e.target.closest('[data-action="sp-open-menu"]')) {
        closeSidePanelMenu();
      }
    });

    const savedSidePanelOff = ${scriptJson(state.sidePanelOff ?? null)};
    if (typeof savedSidePanelOff === 'boolean') {
      document.body.classList.toggle('side-panel-off', savedSidePanelOff);
    } else {
      try {
        const legacyOff = localStorage.getItem('andromity.sidePanelOff');
        if (legacyOff === '1' || legacyOff === '0') {
          document.body.classList.toggle('side-panel-off', legacyOff === '1');
          vscode.postMessage({ type: 'side_panel_visibility', off: legacyOff === '1' });
        }
      } catch (e) {}
    }
    if (SIDE_PANEL_WIDE && typeof SIDE_PANEL_WIDE.addEventListener === 'function') {
      SIDE_PANEL_WIDE.addEventListener('change', () => { closeSidePanelMenu(); requestSidePanelData(); renderSidePanel(); });
    }

    // Run buttons waiting on a terminal result, keyed by run id. A failed run
    // keeps its output here (in the editor only) until the user asks for a fix.
    var trackedRuns = new Map();
    var runSeq = 0;

    function removeFixButton(btn) {
      var next = btn.nextElementSibling;
      if (next && next.classList && next.classList.contains('code-fix-btn')) next.remove();
    }

    window.runCodeInTerminal = function(btn) {
      if (btn.getAttribute('data-run-state') === 'running') return;
      var code = decodeURIComponent(btn.getAttribute('data-code') || '');
      var lang = btn.getAttribute('data-lang') || '';
      if (!btn.hasAttribute('data-idle-html')) btn.setAttribute('data-idle-html', btn.innerHTML);
      var previous = btn.getAttribute('data-run-id');
      if (previous) trackedRuns.delete(previous);
      removeFixButton(btn);
      var runId = 'run-' + Date.now() + '-' + (++runSeq);
      btn.setAttribute('data-run-id', runId);
      trackedRuns.set(runId, { btn: btn, lang: lang });
      vscode.postMessage({ type: 'run_in_terminal', code: code, lang: lang, runId: runId });
    };

    function applyRunStatus(msg) {
      var entry = trackedRuns.get(msg.runId);
      if (!entry) return;
      var btn = entry.btn;
      if (!btn.isConnected) { trackedRuns.delete(msg.runId); return; }
      removeFixButton(btn);
      btn.setAttribute('data-run-state', msg.state);
      if (msg.state === 'running') {
        btn.innerHTML = '<i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i> Running…';
        btn.title = 'Running in the terminal';
        return;
      }
      trackedRuns.delete(msg.runId);
      if (msg.state === 'succeeded') {
        btn.innerHTML = '<i class="codicon codicon-check" aria-hidden="true"></i> Done';
        btn.title = 'Finished with exit code 0. Click to run again.';
      } else if (msg.state === 'failed') {
        var exitCode = Number(msg.exitCode);
        btn.innerHTML = '<i class="codicon codicon-error" aria-hidden="true"></i> Exit ' + escapeHtml(String(exitCode));
        btn.title = 'Failed with exit code ' + exitCode + '. Click to run again.';
        trackedRuns.set(msg.runId, { btn: btn, lang: entry.lang, failure: { command: String(msg.command || ''), exitCode: exitCode, outputTail: String(msg.outputTail || '') } });
        btn.insertAdjacentHTML('afterend', '<button class="code-btn code-fix-btn" data-action="fix-run" data-run-id="' + escapeHtml(msg.runId) + '" title="Ask Andromity to fix this failure" aria-label="Ask Andromity to fix this failure"><i class="codicon codicon-wand" aria-hidden="true"></i> Fix</button>');
      } else {
        btn.innerHTML = btn.getAttribute('data-idle-html') || btn.innerHTML;
        btn.title = 'Run in a new terminal';
        btn.removeAttribute('data-run-state');
      }
    }

    function buildFixPrompt(failure, lang) {
      var NL = String.fromCharCode(10);
      var fence = String.fromCharCode(96, 96, 96, 96);
      var prompt = 'This command failed with exit code ' + failure.exitCode + '. Find the cause and fix it.' + NL + NL +
        fence + (lang || 'bash') + NL + failure.command + NL + fence;
      if (failure.outputTail) prompt += NL + NL + 'Last lines of output:' + NL + fence + 'text' + NL + failure.outputTail + NL + fence;
      return prompt;
    }

    window.fixFailedRun = function(btn) {
      var entry = trackedRuns.get(btn.getAttribute('data-run-id') || '');
      if (!entry || !entry.failure) return;
      var prompt = buildFixPrompt(entry.failure, entry.lang);
      var NL = String.fromCharCode(10);
      // Send straight away only when nothing else is in the composer; otherwise
      // add it to the draft so nothing the user typed or attached is sent with it.
      if (!promptInput.value.trim() && attachedImages.length === 0 && attachedFiles.length === 0) {
        promptInput.value = prompt;
        sendCurrentPrompt();
      } else {
        promptInput.value = promptInput.value.replace(/\\s+$/, '') + NL + NL + prompt;
        promptInput.dispatchEvent(new Event('input', { bubbles: true }));
        promptInput.focus();
      }
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
    // Humanized turn duration: 0.4s / 42.7s / 5m 44s / 1h 05m
    // Exact seconds stay available for the tooltip, so precision is not lost.
    function formatDuration(seconds) {
      var total = Number(seconds);
      if (!isFinite(total) || total < 0) return '';
      if (total < 9.95) return (Math.round(total * 10) / 10).toFixed(1) + 's';
      var rounded = Math.round(total);
      if (rounded < 60) return rounded + 's';
      var hours = Math.floor(rounded / 3600);
      var minutes = Math.floor((rounded % 3600) / 60);
      var secs = rounded % 60;
      if (hours > 0) return hours + 'h ' + (minutes < 10 ? '0' + minutes : String(minutes)) + 'm';
      return secs > 0 ? minutes + 'm ' + secs + 's' : minutes + 'm';
    }

    var FOOTER_CLOCK_ICON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
    var FOOTER_COPY_ICON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    var FOOTER_CHECK_ICON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

    /**
     * Single source of truth for the post-response meta strip:
     *   [clock] 5m 44s · 04:43 PM   [Copy]
     * Keeps duration + timestamp legible on one quiet line, with the exact
     * elapsed seconds preserved in the tooltip.
     */
    function buildMessageFooter(opts) {
      opts = opts || {};
      var footer = document.createElement('div');
      footer.className = 'message-footer';

      var hasDuration = typeof opts.durationSeconds === 'number' && isFinite(opts.durationSeconds) && opts.durationSeconds >= 0;
      var durationSeconds = hasDuration ? opts.durationSeconds : null;
      var timeStr = opts.timestamp ? formatTime(new Date(opts.timestamp)) : formatTime(new Date());
      var durationLabel = durationSeconds !== null ? formatDuration(durationSeconds) : '';

      var titleParts = [];
      if (durationSeconds !== null) titleParts.push('Took ' + durationSeconds.toFixed(1) + 's');
      titleParts.push('Answered at ' + timeStr);

      var metaHtml = '<span class="message-meta" title="' + titleParts.join(' · ') + '">';
      if (durationLabel) {
        metaHtml += '<span class="turn-duration-badge">' + FOOTER_CLOCK_ICON + '<span>' + durationLabel + '</span></span>' +
          '<span class="message-meta-sep">·</span>';
      }
      metaHtml += '<span class="message-time">' + timeStr + '</span></span>';

      var actionsHtml = '';
      if (opts.copyAction) {
        var copyTitle = opts.copyTitle || 'Copy';
        actionsHtml = '<span class="message-actions">' +
          '<button type="button" class="msg-copy-btn" data-action="' + opts.copyAction + '" title="' + copyTitle + '" aria-label="' + copyTitle + '">' +
          FOOTER_COPY_ICON + '<span class="msg-action-label">Copy</span>' +
          '</button></span>';
      }

      footer.innerHTML = metaHtml + actionsHtml;
      return footer;
    }

    /** Pins the meta strip of the newest turn; every older strip stays hover-only. */
    function pinLatestMessageFooter() {
      var footers = document.querySelectorAll('.message-footer');
      for (var i = 0; i < footers.length; i++) {
        footers[i].classList.toggle('visible', i === footers.length - 1);
      }
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
      const ambientSepMatch = text.match(/\\r?\\n\\s*---\\s*\\r?\\n(?=\\[(?:Active Document|Active Diagnostics|Selection in|Other Open Documents|Started from session|Background sessions))/);
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

    // Edit and resend: an inline editor on a past prompt. Resending rewinds the
    // session to that turn (the host confirms and rolls back file changes),
    // then sends the edited text.
    function openPromptEditor(wrap) {
      if (!wrap || wrap.querySelector('.prompt-edit-box')) return;
      if (isRunning) {
        appendSystemNote('Stop the current turn before editing an earlier message.');
        return;
      }
      const card = wrap.querySelector('.message.user');
      if (card) card.style.display = 'none';
      const box = document.createElement('div');
      box.className = 'prompt-edit-box';
      box.innerHTML = '<textarea class="prompt-edit-input" rows="3" aria-label="Edit this message"></textarea>' +
        '<div class="prompt-edit-footer">' +
          '<span class="prompt-edit-note">Resending undoes this turn and everything after it, including file changes.</span>' +
          '<div class="prompt-edit-actions">' +
            '<button type="button" class="prompt-edit-cancel" data-action="cancel-edit-prompt">Cancel</button>' +
            '<button type="button" class="prompt-edit-send" data-action="resend-prompt">Undo &amp; resend</button>' +
          '</div>' +
        '</div>';
      (card ? card.parentNode : wrap).insertBefore(box, card ? card.nextSibling : null);
      const input = box.querySelector('.prompt-edit-input');
      input.value = wrap._promptText || (card ? card.innerText : '');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closePromptEditor(wrap); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); resendEditedPrompt(wrap); }
      });
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }

    function closePromptEditor(wrap) {
      if (!wrap) return;
      const box = wrap.querySelector('.prompt-edit-box');
      if (box) box.remove();
      const card = wrap.querySelector('.message.user');
      if (card) card.style.display = '';
    }

    function resendEditedPrompt(wrap) {
      if (!wrap) return;
      const input = wrap.querySelector('.prompt-edit-input');
      const text = input ? input.value.trim() : '';
      if (!text) { if (input) input.focus(); return; }
      if (isRunning) {
        appendSystemNote('Stop the current turn before editing an earlier message.');
        return;
      }
      const request = undoRequestFor(wrap);
      if (request.turnIndex === undefined) return;
      vscode.postMessage(Object.assign({ type: 'undo_turn', resendPrompt: text }, request));
    }

    /** Undo for the turn a prompt belongs to, counted the way the engine counts: from the newest prompt back,
     *  where a message sent while a turn was running is part of that turn, not a turn of its own. */
    function undoRequestFor(wrap) {
      const isTurnPrompt = (el) => el && el.matches && el.matches('.message-wrap.user:not([data-steering])');
      let prompt = wrap;
      while (prompt && !isTurnPrompt(prompt)) prompt = prompt.previousElementSibling;
      const prompts = Array.from(chatContainer.querySelectorAll('.message-wrap.user:not([data-steering])'));
      const turnIndex = prompt ? prompts.indexOf(prompt) : -1;
      return {
        turnIndex: turnIndex >= 0 ? turnIndex : undefined,
        totalTurns: prompts.length,
        turnsToUndo: turnIndex >= 0 ? prompts.length - turnIndex : 1,
      };
    }

    // Empty-chat starters: two generic buttons become specific when there is something to act on.
    function applySmartStarter(chip, smart) {
      if (!chip) return;
      const titleEl = chip.querySelector('.starter-title');
      const descEl = chip.querySelector('.starter-description');
      if (!chip.hasAttribute('data-default-prompt')) {
        chip.setAttribute('data-default-prompt', chip.getAttribute('data-prompt') || '');
        chip.setAttribute('data-default-title', titleEl ? titleEl.textContent : '');
        chip.setAttribute('data-default-description', descEl ? descEl.textContent : '');
        chip.setAttribute('data-default-label', chip.getAttribute('aria-label') || '');
      }
      const next = smart || {
        prompt: chip.getAttribute('data-default-prompt'), title: chip.getAttribute('data-default-title'),
        description: chip.getAttribute('data-default-description'), label: chip.getAttribute('data-default-label'),
      };
      chip.setAttribute('data-prompt', next.prompt);
      if (titleEl) titleEl.textContent = next.title;
      if (descEl) descEl.textContent = next.description;
      chip.setAttribute('aria-label', next.label || (next.title + ', ' + next.description));
      chip.classList.toggle('is-smart', !!smart);
    }

    function renderSmartStarters(context) {
      const row = document.querySelector('.minimal-starters-row');
      if (!row) return;
      const chips = row.querySelectorAll('.starter-chip[data-action="send-starter"]');
      const errors = context && context.errors;
      applySmartStarter(chips[1], errors && errors.count ? {
        title: 'Fix ' + errors.count + ' error' + (errors.count === 1 ? '' : 's'),
        description: 'in ' + errors.file,
        prompt: 'Fix the ' + errors.count + ' error' + (errors.count === 1 ? '' : 's') + ' reported in ' + errors.path + '. Explain each fix briefly.',
      } : null);
      const changed = context && context.changedFiles;
      applySmartStarter(chips[2], changed ? {
        title: 'Review my changes',
        description: changed + ' changed file' + (changed === 1 ? '' : 's'),
        prompt: 'Review my uncommitted changes for bugs and risky edits, then suggest a commit message.',
      } : null);
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
      const normalUserCount = chatContainer.querySelectorAll('.message-wrap.user:not([data-steering])').length;
      const existingUserCount = opts && opts.turnIndex !== undefined ? opts.turnIndex : (opts && opts.steering ? Math.max(0, normalUserCount - 1) : normalUserCount);
      if (opts && opts.steering) wrap.setAttribute('data-steering', 'true');
      wrap.setAttribute('data-turn-index', String(existingUserCount));

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'user-prompt-actions';
      actionsDiv.innerHTML = '<button class="prompt-undo-btn" data-action="undo-turn" data-turn-index="' + existingUserCount + '" title="Undo to here">' +
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">' +
          '<path d="M3 7v6h6"></path>' +
          '<path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path>' +
        '</svg>' +
        '<span>Undo to here</span>' +
      '</button>' +
      '<button class="prompt-undo-btn prompt-edit-btn" data-action="edit-prompt" title="Edit and resend from here">' +
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">' +
          '<path d="M12 20h9"></path>' +
          '<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>' +
        '</svg>' +
        '<span>Edit</span>' +
      '</button>';
      wrap.appendChild(actionsDiv);
      wrap._promptText = parsed.userText || rawText;

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
          iconSpan.style.color = badgeInfo.color;
          iconSpan.innerHTML = badgeInfo.badge; // badge is an HTML string (<i class="codicon ...">)
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

      // A turn started by another session's question or handoff shows who asked and what,
      // not the instructions written for the model.
      const collabWake = parseCollabWakePrompt(rawText);
      const displayText = collabWake ? collabWake.body : parsed.userText;
      if (collabWake) {
        msgDiv.classList.add('collab-wake-prompt');
        const wakeHead = document.createElement('div');
        wakeHead.className = 'collab-wake-head';
        wakeHead.textContent = (collabWake.kind === 'question' ? 'Question from ' : 'Handoff from ') + (collabWake.from || 'another session');
        msgDiv.appendChild(wakeHead);
      }

      if (displayText) {
        const textWrapper = document.createElement('div');
        textWrapper.className = 'prompt-text-wrapper';

        const textContent = document.createElement('div');
        textContent.className = 'prompt-text-content';
        textContent.textContent = displayText;
        textWrapper.appendChild(textContent);

        const isLong = displayText.length > 220 || displayText.split(/\\r?\\n/).length > 3;
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

      wrap.appendChild(buildMessageFooter({
        timestamp: ts || Date.now(),
        copyAction: 'copy-prompt',
        copyTitle: 'Copy prompt',
      }));

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

    function formatSessionShort(name, maxLen) {
      if (!name) return 'Another session';
      maxLen = maxLen || 20;
      return name.length > maxLen ? name.slice(0, maxLen - 1) + '…' : name;
    }

    // ── Next-step suggestion ─────────────────────────────────────────────────
    // One follow-up the agent offered at the end of a turn (suggest_next_step): a card
    // under the reply, the input placeholder, and Tab to put its prompt in the input.
    const nextStepBySession = {};
    const nextStepDismissed = new Set();
    let nextStepDefaultPlaceholder = null;

    function normalizeNextStepOption(raw) {
      if (!raw || typeof raw !== 'object') return null;
      let title = String(raw.title || '').trim().split(/\\s+/).join(' ');
      const prompt = String(raw.prompt || '').trim();
      if (!title || !prompt) return null;
      if (title.length > 60) title = title.slice(0, 59).trim() + '…';
      return { title, prompt: prompt.slice(0, 2000), new_session: raw.new_session === true };
    }

    // One step, or a short question with 2-3 options; title/prompt/new_session are the first option.
    function normalizeNextStep(raw) {
      if (!raw || typeof raw !== 'object') return null;
      let options = Array.isArray(raw.options) ? raw.options.map(normalizeNextStepOption).filter(Boolean).slice(0, 3) : [];
      if (!options.length) {
        const single = normalizeNextStepOption(raw);
        options = single ? [single] : [];
      }
      if (!options.length) return null;
      const question = options.length > 1 ? String(raw.question || '').trim().split(/\\s+/).join(' ').slice(0, 120) : '';
      return Object.assign({}, options[0], {
        question, options,
        key: question + '|' + options.map(o => o.title + '|' + o.prompt).join('|'),
      });
    }

    // A suggestion made after the last user message is still open after a reload or session switch.
    function nextStepFromHistory(messages) {
      if (!Array.isArray(messages)) return null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m) continue;
        if (m.role === 'user') return null;
        if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
        let step = null;
        for (const tc of m.tool_calls) {
          const fn = tc && tc.function;
          if (!fn || fn.name !== 'suggest_next_step') continue;
          let args = fn.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch (_) { args = null; }
          }
          step = normalizeNextStep(args) || step;
        }
        if (step) return step;
      }
      return null;
    }

    function isNextStepCall(tc) {
      return Boolean(tc && tc.function && tc.function.name === 'suggest_next_step');
    }

    function withoutNextStepCalls(messages) {
      const hiddenIds = new Set();
      const out = [];
      for (const m of messages) {
        if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some(isNextStepCall)) {
          m.tool_calls.forEach(tc => { if (isNextStepCall(tc) && tc.id) hiddenIds.add(tc.id); });
          const kept = m.tool_calls.filter(tc => !isNextStepCall(tc));
          if (!kept.length && !extractMessageText(m.content).trim()) continue;
          const copy = Object.assign({}, m);
          if (kept.length) copy.tool_calls = kept;
          else delete copy.tool_calls;
          out.push(copy);
          continue;
        }
        if (m && m.role === 'tool' && hiddenIds.has(m.tool_call_id)) continue;
        out.push(m);
      }
      return out;
    }

    function currentNextStep() {
      return currentSessionId ? nextStepBySession[currentSessionId] || null : null;
    }

    function setNextStep(sessionId, step) {
      if (!sessionId) return;
      if (step) nextStepBySession[sessionId] = step;
      else delete nextStepBySession[sessionId];
      if (sessionId === currentSessionId) renderNextStep();
    }

    // A new turn's suggestion always shows, even when it repeats one dismissed earlier;
    // dismissals only keep an old suggestion from coming back out of history.
    function receiveNextStep(sessionId, raw) {
      const step = normalizeNextStep(raw);
      if (!sessionId || !step) return;
      nextStepDismissed.delete(step.key);
      setNextStep(sessionId, step);
    }

    function dismissNextStep(event) {
      const step = currentNextStep();
      if (!step) return;
      nextStepDismissed.add(step.key);
      setNextStep(currentSessionId, null);
      vscode.postMessage({ type: 'next_step_event', event: event || 'dismissed', sessionId: currentSessionId });
    }

    function renderNextStep() {
      const existing = document.getElementById('next-step-card');
      if (existing) existing.remove();
      const input = document.getElementById('prompt-input');
      if (input && nextStepDefaultPlaceholder === null) nextStepDefaultPlaceholder = input.getAttribute('placeholder') || '';
      const step = currentNextStep();
      const busy = Boolean(currentSessionId && sessionsState[currentSessionId] && sessionsState[currentSessionId].isRunning);
      if (!step || busy) {
        if (input) input.setAttribute('placeholder', nextStepDefaultPlaceholder || '');
        return;
      }
      const card = document.createElement('div');
      card.id = 'next-step-card';
      card.className = 'next-step-card';
      card.setAttribute('role', 'group');
      card.setAttribute('aria-label', 'Suggested next step');
      const choices = step.options.length > 1;
      if (choices) card.classList.add('has-choices');
      // One step reads "Do it"; a choice shows each option as its own button, the recommended one first.
      const buttons = choices
        ? step.options.map((o, i) => '<button class="next-step-btn' + (i === 0 ? ' primary' : '') + '" data-action="next-step-run" data-opt-idx="' + i + '"' +
            ' title="' + escapeHtml(o.prompt) + (o.new_session ? ' (runs in a new session)' : '') + '">' + escapeHtml(o.title) +
            (o.new_session ? '<span class="next-step-new-tag">new session</span>' : '') + '</button>').join('')
        : '<button class="next-step-btn primary" data-action="next-step-run">Do it</button>' +
          (step.new_session ? '<button class="next-step-btn" data-action="next-step-new-session" title="Start this in a new session">New session</button>' : '');
      // The buttons send these prompts as if typed, so the exact text is one click away before sending.
      const requestHtml = choices
        ? step.options.map(o => '<div class="next-step-request-item"><span class="next-step-request-name">' + escapeHtml(o.title) + '</span>' + escapeHtml(o.prompt) + '</div>').join('')
        : escapeHtml(step.prompt);
      card.innerHTML = '<div class="next-step-text">' +
          '<div class="next-step-label">Suggested next step</div>' +
          '<div class="next-step-title" title="' + escapeHtml(choices ? step.question || step.title : step.prompt) + '">' +
            escapeHtml(choices ? step.question || 'Choose what to do next' : step.title) + '</div>' +
          '<details class="next-step-request"><summary>See the exact request</summary><div class="next-step-request-body">' + requestHtml + '</div></details>' +
        '</div>' +
        '<div class="next-step-actions">' + buttons +
          '<button class="next-step-dismiss" data-action="next-step-dismiss" aria-label="Dismiss suggestion" title="Dismiss (Esc)">&times;</button>' +
        '</div>';
      const tipCard = document.getElementById('feature-tip-card');
      if (tipCard) chatContainer.insertBefore(card, tipCard);
      else chatContainer.appendChild(card);
      if (input) input.setAttribute('placeholder', step.title + '  ·  Tab to use');
      if (!step.reported) {
        step.reported = true;
        vscode.postMessage({ type: 'next_step_event', event: 'shown', sessionId: currentSessionId });
      }
      scrollToBottomIfNeeded();
    }

    function runNextStep(index) {
      const step = currentNextStep();
      if (!step) return;
      const option = step.options[Number(index) || 0] || step.options[0];
      if (step.options.length > 1 && option.new_session) {
        startNextStepInNewSession(index);
        return;
      }
      vscode.postMessage({ type: 'next_step_event', event: 'run', sessionId: currentSessionId });
      setNextStep(currentSessionId, null);
      // Same delivery as the send button, without touching whatever is typed in the input.
      if (queueSupported) {
        dispatchPrompt(option.prompt, true, [], 'queue');
      } else if (isRunning) {
        promptQueue.push({ text: option.prompt, images: [], sessionId: currentSessionId });
        renderQueue();
      } else {
        dispatchPrompt(option.prompt, true, []);
      }
    }

    function startNextStepInNewSession(index) {
      const step = currentNextStep();
      if (!step) return;
      const option = step.options[Number(index) || 0] || step.options[0];
      nextStepDismissed.add(step.key);
      setNextStep(currentSessionId, null);
      vscode.postMessage({ type: 'start_next_step_session', title: option.title, prompt: option.prompt, sessionId: currentSessionId });
    }

    function acceptNextStepIntoInput() {
      const step = currentNextStep();
      if (!step) return false;
      promptInput.value = step.prompt;
      promptInput.style.height = 'auto';
      promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + 'px';
      promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
      if (sendBtn) sendBtn.classList.add('has-text');
      sessionsState[currentSessionId] = sessionsState[currentSessionId] || {};
      sessionsState[currentSessionId].draftInput = promptInput.value;
      dismissNextStep('tab');
      return true;
    }
    // ── Background sessions ──────────────────────────────────────────────────
    // "New session" on a suggestion runs it in a session of its own while this one stays
    // open. The session it came from shows one line that follows the run to its end.
    const backgroundRuns = {};

    const BACKGROUND_LABELS = {
      running: 'Running in background',
      waiting: 'Needs your input',
      finished: 'Background session finished',
      cancelled: 'Background session was cancelled',
      error: "Background session couldn't finish",
    };

    function backgroundRunHtml(run) {
      const status = BACKGROUND_LABELS[run.status] ? run.status : 'running';
      return '<span class="bg-run-text"><span class="bg-run-label' + (status === 'running' ? ' status-shimmer' : '') + '">' + BACKGROUND_LABELS[status] + '</span> ' +
          '<span class="bg-run-title">' + escapeHtml(run.title || 'New session') + '</span>' +
          (run.summary && status !== 'running' && status !== 'waiting' ? '<span class="bg-run-summary">' + escapeHtml(run.summary) + '</span>' : '') +
        '</span>' +
        '<button class="bg-run-open" data-action="switch-session" data-session-id="' + escapeHtml(run.session_id) + '" title="Open this session">Open</button>';
    }

    function renderBackgroundRun(run, beforeEl) {
      if (!run || run.parent_session_id !== currentSessionId) return;
      let row = document.getElementById('bg-run-' + run.session_id);
      if (!row) {
        row = document.createElement('div');
        row.id = 'bg-run-' + run.session_id;
        if (beforeEl && beforeEl.parentNode === chatContainer) chatContainer.insertBefore(row, beforeEl);
        else chatContainer.appendChild(row);
      }
      row.className = 'bg-run-row status-' + (BACKGROUND_LABELS[run.status] ? run.status : 'running');
      row.setAttribute('role', 'status');
      row.innerHTML = backgroundRunHtml(run);
    }

    function trackBackgroundRun(parentId, run) {
      if (!parentId || !run || !run.session_id) return;
      const known = backgroundRuns[run.session_id] || {};
      backgroundRuns[run.session_id] = Object.assign({}, known, run, { parent_session_id: parentId });
      renderBackgroundRun(backgroundRuns[run.session_id]);
    }

    function setBackgroundRunWaiting(sessionId, waiting) {
      const run = backgroundRuns[sessionId];
      if (!run || (run.status !== 'running' && run.status !== 'waiting')) return;
      run.status = waiting ? 'waiting' : 'running';
      renderBackgroundRun(run);
    }

    // Rows from a saved session go back where they were started: after the turn that offered them.
    function restoreBackgroundRuns(session) {
      const runs = Array.isArray(session && session.background_runs) ? session.background_runs : [];
      const userTurns = chatContainer.querySelectorAll('.message-wrap.user:not([data-steering])');
      for (const saved of runs) {
        const live = backgroundRuns[saved.session_id];
        const run = Object.assign({}, saved, live && live.status === 'waiting' && saved.status === 'running' ? { status: 'waiting' } : {}, { parent_session_id: session.id });
        backgroundRuns[saved.session_id] = run;
        const nextTurn = userTurns[Number(saved.turn_index) || 0];
        renderBackgroundRun(run, nextTurn || null);
      }
    }

    function renderBackgroundOrigin(session) {
      const origin = session && session.started_from;
      if (!origin || !origin.session_id) return;
      const line = document.createElement('div');
      line.className = 'bg-origin-row';
      line.innerHTML = 'Started from <button class="bg-run-open" data-action="switch-session" data-session-id="' +
        escapeHtml(origin.session_id) + '" title="Open the session this was started from">' + escapeHtml(origin.name || 'another session') + '</button>';
      chatContainer.insertBefore(line, chatContainer.firstChild);
    }
    // ── End next-step suggestion ─────────────────────────────────────────────

    // ── Feature tips ─────────────────────────────────────────────────────────
    // After a reply, the extension may pick one tip about a feature this user has not
    // used yet. The webview only reports what the turn did and draws the card.
    const FEATURE_TIP_COPY = {
      fingerprint: {
        html: '<strong>Fingerprint</strong> shows every file this turn touched and what else depends on them, so you can see the blast radius before you commit.',
        action: () => 'Open Fingerprint',
      },
      commit_message: {
        html: 'Ready to commit? Andromity can <strong>write the commit message</strong> for these changes from the Source Control panel.',
        action: () => 'Write commit message',
      },
      inline_edit: {
        html: 'For small changes like this, select the code and press <kbd>Ctrl</kbd>+<kbd>I</kbd> to <strong>edit it in place</strong> without leaving the editor.',
        action: (file) => file ? 'Open ' + file.split(/[\\\\/]/).pop() : '',
      },
      cron_jobs: {
        html: 'Want this to run on its own? <strong>Cron Jobs</strong> can run a prompt on a schedule and keep the results in a session.',
        action: () => 'Open Cron Jobs',
      },
      generate_tests: {
        html: 'This change has no tests yet. Right-click a file and choose <strong>Andromity › Generate Unit Tests</strong>, or press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd> in the editor.',
        action: (file) => file ? 'Write tests for ' + file.split(/[\\\\/]/).pop() : '',
      },
      fix_terminal_error: {
        html: 'When a command fails in your own terminal, right-click the output and choose <strong>Fix Terminal Error</strong>. Andromity reads the error and fixes the cause.',
        action: () => 'Got it',
      },
      air_gap: {
        html: 'You are on a local model. With <strong>air-gap mode</strong> on, Andromity connects only to this machine and hosts you allow: no cloud models, telemetry or remote MCP servers.',
        action: () => 'How air-gap works',
      },
      mcp_servers: {
        html: '<strong>MCP servers</strong> let the agent use tools like GitHub, Jira or your database. Add one from Settings.',
        action: () => 'Browse MCP servers',
      },
    };

    function finishedTurnFacts(msg) {
      const prompts = chatContainer.querySelectorAll('.message-wrap.user:not([data-steering])');
      const lastPrompt = prompts[prompts.length - 1];
      if (!lastPrompt) return null;
      let toolCalls = 0;
      let shellCommands = 0;
      for (let el = lastPrompt.nextElementSibling; el; el = el.nextElementSibling) {
        toolCalls += (el.matches('.tool-card, .activity-row') ? 1 : 0) + el.querySelectorAll('.tool-card, .activity-row').length;
        shellCommands += (el.matches('.activity-row-command') ? 1 : 0) + el.querySelectorAll('.activity-row-command').length;
      }
      return {
        type: 'turn_finished',
        sessionId: msg.session_id || currentSessionId,
        editedFiles: Array.from(turnEditedFiles).slice(0, 50),
        toolCalls,
        shellCommands,
        scheduled: Boolean(msg.scheduled || (sessionsState[currentSessionId] && sessionsState[currentSessionId].scheduledRun)),
      };
    }

    function removeFeatureTip() {
      const existing = document.getElementById('feature-tip-card');
      if (existing) existing.remove();
    }

    function renderFeatureTip(id, file) {
      const copy = FEATURE_TIP_COPY[id];
      if (!copy || document.getElementById('checkin-card')) return;
      removeFeatureTip();
      const label = copy.action(file || '');
      const card = document.createElement('div');
      card.id = 'feature-tip-card';
      card.className = 'feature-tip-card';
      card.setAttribute('role', 'note');
      card.dataset.tip = id;
      card.dataset.file = file || '';
      card.innerHTML = '<svg class="feature-tip-bulb" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>' +
        '<div class="feature-tip-text"><span class="feature-tip-label">Did you know</span>' + copy.html + '</div>' +
        (label ? '<button class="next-step-btn" data-action="feature-tip-run">' + escapeHtml(label) + '</button>' : '') +
        '<button class="next-step-dismiss" data-action="feature-tip-menu" aria-label="Dismiss tip" aria-haspopup="menu" aria-expanded="false" title="Dismiss">&times;</button>' +
        '<div class="feature-tip-menu" role="menu" hidden>' +
          '<button role="menuitem" data-action="feature-tip-hide">Hide this tip</button>' +
          '<button role="menuitem" data-action="feature-tip-off">Don\\'t show tips</button>' +
        '</div>';
      chatContainer.appendChild(card);
      scrollToBottomIfNeeded();
    }

    function setFeatureTipMenu(open) {
      const card = document.getElementById('feature-tip-card');
      if (!card) return;
      card.querySelector('.feature-tip-menu').hidden = !open;
      card.querySelector('[data-action="feature-tip-menu"]').setAttribute('aria-expanded', String(open));
    }

    function featureTipAction(action) {
      const card = document.getElementById('feature-tip-card');
      if (!card) return;
      const tip = card.dataset.tip;
      if (action === 'feature-tip-menu') {
        setFeatureTipMenu(card.querySelector('.feature-tip-menu').hidden);
        return;
      }
      if (action === 'feature-tip-run') vscode.postMessage({ type: 'feature_tip_run', tip, file: card.dataset.file });
      else if (action === 'feature-tip-hide') vscode.postMessage({ type: 'feature_tip_hide', tip });
      else if (action === 'feature-tip-off') vscode.postMessage({ type: 'feature_tip_off' });
      card.remove();
    }

    document.addEventListener('click', (event) => {
      if (!event.target.closest || !event.target.closest('#feature-tip-card')) setFeatureTipMenu(false);
    });
    // ── End feature tips ─────────────────────────────────────────────────────

    // ── Feedback check-in: how it feels first, then what gets in the way ────
    const CHECKIN_FACES = [
      { id: 'love', face: '😍', label: 'Love it' },
      { id: 'ok', face: '😐', label: 'It\\'s OK' },
      { id: 'bad', face: '😞', label: 'Not great' },
    ];
    let checkIn = null;

    function startCheckIn(msg) {
      if (msg.session_id !== currentSessionId || isRunning) return;
      removeFeatureTip();
      const previous = document.getElementById('checkin-card');
      if (previous) previous.remove();
      const choices = Array.isArray(msg.annoyances) ? msg.annoyances : [];
      checkIn = {
        step: 'ask', sentiment: '', picked: new Set(), note: '', sending: false, error: '',
        annoyances: choices.filter(a => a && typeof a.id === 'string' && typeof a.label === 'string').slice(0, 10),
      };
      const card = document.createElement('div');
      card.id = 'checkin-card';
      card.className = 'checkin-card';
      card.setAttribute('role', 'group');
      card.setAttribute('aria-labelledby', 'checkin-title');
      chatContainer.appendChild(card);
      renderCheckIn();
      scrollToBottomIfNeeded();
    }

    function renderCheckIn() {
      const card = document.getElementById('checkin-card');
      if (!card || !checkIn) return;
      const typed = document.getElementById('checkin-note');
      if (typed) checkIn.note = typed.value;
      const disabled = checkIn.sending ? ' disabled' : '';
      const error = checkIn.error ? '<div class="checkin-error" role="alert">' + escapeHtml(checkIn.error) + '</div>' : '';
      const review = '<button class="checkin-link" data-action="checkin-review">Leave a review</button>';
      let body = '';
      if (checkIn.step === 'ask') {
        body = '<div class="checkin-title" id="checkin-title">How\\'s Andromity working for you?</div>' +
          '<div class="checkin-faces">' +
            CHECKIN_FACES.map(f => '<button class="checkin-face" data-action="checkin-sentiment" data-sentiment="' + f.id + '"' + disabled + '>' +
              '<span class="checkin-emoji" aria-hidden="true">' + f.face + '</span>' + escapeHtml(f.label) + '</button>').join('') +
          '</div>' + error +
          '<div class="checkin-foot"><span>Your answer goes to the Andromity team and isn\\'t linked to your usage data.</span>' +
            '<button class="checkin-link" data-action="checkin-never">Don\\'t ask again</button></div>';
      } else if (checkIn.step === 'details') {
        const lead = checkIn.sentiment === 'bad' ? 'Sorry it\\'s been frustrating. What gets in the way most?' : 'Thanks. What would make it better?';
        body = '<div class="checkin-title" id="checkin-title">' + lead + '</div>' +
          '<div class="checkin-chips" role="group" aria-label="What gets in the way">' +
            checkIn.annoyances.map(a => '<button class="checkin-chip" data-action="checkin-chip" data-id="' + escapeHtml(a.id) + '" aria-pressed="' +
              (checkIn.picked.has(a.id) ? 'true' : 'false') + '"' + disabled + '>' + escapeHtml(a.label) + '</button>').join('') +
          '</div>' +
          '<textarea class="checkin-note" id="checkin-note" rows="2" maxlength="2000" aria-label="Anything else (optional)" placeholder="Anything else? Add your email if you\\'d like a reply. (optional)"' + disabled + '></textarea>' +
          error +
          '<div class="checkin-actions">' +
            '<button class="next-step-btn primary" data-action="checkin-send"' + disabled + '>' + (checkIn.sending ? 'Sending…' : 'Send') + '</button>' +
            '<button class="next-step-btn" data-action="checkin-skip"' + disabled + '>Skip</button>' + review +
          '</div>';
      } else if (checkIn.sentiment === 'love') {
        body = '<div class="checkin-title" id="checkin-title">Thanks, that means a lot!</div>' +
          '<div class="checkin-text">Would you leave a quick review? It helps other developers find Andromity.</div>' +
          '<div class="checkin-actions"><button class="next-step-btn primary" data-action="checkin-review">Write a review</button>' +
          '<button class="next-step-btn" data-action="checkin-close">Not now</button></div>';
      } else {
        body = '<div class="checkin-title" id="checkin-title">Thanks, this goes straight to the Andromity team.</div>' +
          '<div class="checkin-actions">' + review + '</div>';
      }
      card.innerHTML = '<button class="next-step-dismiss checkin-close" data-action="checkin-close" aria-label="Close" title="Close">&times;</button>' + body;
      const note = document.getElementById('checkin-note');
      if (note) note.value = checkIn.note;
      // Later steps are taller; keep the whole card, including Send, above the prompt box.
      if (checkIn.step !== 'ask' && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' });
    }

    function sendCheckIn(withDetails) {
      if (!checkIn || checkIn.sending) return;
      const note = document.getElementById('checkin-note');
      if (note) checkIn.note = note.value;
      vscode.postMessage({
        type: 'checkin_send',
        sentiment: checkIn.sentiment,
        annoyances: withDetails ? Array.from(checkIn.picked) : [],
        message: withDetails ? checkIn.note : '',
      });
      checkIn.sending = true;
      checkIn.error = '';
      renderCheckIn();
    }

    function closeCheckIn() {
      const card = document.getElementById('checkin-card');
      if (card) card.remove();
      checkIn = null;
    }

    function checkInAction(action, target) {
      if (!checkIn || !document.getElementById('checkin-card')) return;
      if (action === 'checkin-sentiment') {
        const sentiment = target.getAttribute('data-sentiment');
        if (!CHECKIN_FACES.some(f => f.id === sentiment) || checkIn.sending) return;
        checkIn.sentiment = sentiment;
        if (sentiment === 'love') {
          sendCheckIn(false);
          return;
        }
        checkIn.step = 'details';
        renderCheckIn();
        const firstChip = document.querySelector('#checkin-card .checkin-chip');
        if (firstChip) firstChip.focus({ preventScroll: true });
      } else if (action === 'checkin-chip') {
        const id = target.getAttribute('data-id');
        if (!checkIn.annoyances.some(a => a.id === id)) return;
        if (checkIn.picked.has(id)) checkIn.picked.delete(id);
        else checkIn.picked.add(id);
        target.setAttribute('aria-pressed', checkIn.picked.has(id) ? 'true' : 'false');
      } else if (action === 'checkin-send') {
        sendCheckIn(true);
      } else if (action === 'checkin-skip') {
        sendCheckIn(false);
      } else if (action === 'checkin-review') {
        vscode.postMessage({ type: 'checkin_review' });
        closeCheckIn();
      } else if (action === 'checkin-never') {
        vscode.postMessage({ type: 'checkin_dismiss', never: true });
        closeCheckIn();
      } else if (action === 'checkin-close') {
        // A face was already chosen: closing the follow-up still keeps that answer.
        if (checkIn.step === 'ask' && !checkIn.sending) vscode.postMessage({ type: 'checkin_dismiss', never: false });
        else if (checkIn.step === 'details' && !checkIn.sending) {
          vscode.postMessage({ type: 'checkin_send', sentiment: checkIn.sentiment, annoyances: [], message: '' });
        }
        closeCheckIn();
      }
    }

    function finishCheckIn(msg) {
      if (!checkIn) return;
      checkIn.sending = false;
      if (msg.ok) {
        checkIn.step = 'thanks';
        checkIn.error = '';
      } else {
        checkIn.error = String(msg.error || 'Your answer couldn\\'t be sent.');
      }
      renderCheckIn();
    }
    // ── End feedback check-in ────────────────────────────────────────────────

    function updateSessionActivityIndicator() {
      const dot = document.getElementById('session-activity-dot');
      if (!dot) return;
      const anyUnreadOrRunning = Object.keys(sessionsState).some(id => {
        return id !== currentSessionId && (sessionsState[id]?.hasUnread || sessionsState[id]?.isRunning);
      });
      dot.style.display = anyUnreadOrRunning ? 'inline-block' : 'none';
    }

    function updateSessionCollabBadge(data) {
      const badge = document.getElementById('session-collab-badge');

      // Most session updates carry only some fields (a rename, a token count), so keep the
      // last known collaboration state instead of hiding the badge on every partial update.
      const status = data && data.status !== undefined ? data.status : sessionCollabState.status;
      const collabs = data && Array.isArray(data.collaborators) ? data.collaborators : (sessionCollabState.collaborators || []);
      const watchingFor = data && data.watching_for !== undefined ? data.watching_for : sessionCollabState.watching_for;
      sessionCollabState = { status, collaborators: collabs, watching_for: watchingFor };
      sessionCollabActive = status === 'watching' || status === 'paused_limit_reached' || collabs.length > 0;

      if (!badge) {
        updateCollabInboxBadge();
        return;
      }

      if (status === 'watching') {
        const target = watchingFor && watchingFor.target_session ? String(watchingFor.target_session) : '';
        badge.style.display = 'inline-flex';
        badge.className = 'session-collab-badge watching';
        badge.title = 'This session wakes up when ' + (target || 'another session') + ' sends it a question or handoff';
        badge.innerHTML = '<span class="collab-badge-dot"></span>' +
          '<span>' + (target ? 'Waiting on ' + escapeHtml(target) : 'Waiting for other sessions') + '</span>';
      } else if (status === 'paused_limit_reached') {
        badge.style.display = 'inline-flex';
        badge.className = 'session-collab-badge paused';
        badge.title = 'This session replied to other sessions several times in a row without you, so it paused to avoid a loop';
        badge.innerHTML = '<span>Auto-replies paused</span>' +
          '<button class="session-card-btn collab-resume-btn" data-action="resume-auto-wake" title="Let other sessions wake this one again">Resume</button>';
      } else if (collabs.length > 0) {
        badge.style.display = 'inline-flex';
        badge.className = 'session-collab-badge';
        badge.title = 'Working with ' + collabs.join(', ');
        badge.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>' +
          '<span>' + escapeHtml(collabs[0]) + (collabs.length > 1 ? ' +' + (collabs.length - 1) : '') + '</span>';
      } else {
        badge.style.display = 'none';
      }

      updateCollabInboxBadge();
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
        flashCopied(btn, 'Copied');
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
      if (typeof scheduleSidePanelEnv === 'function') scheduleSidePanelEnv();
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
        safe: 'Safe: Ask before edits, commands, and external actions',
        trust: 'Trust: Allow ordinary edits and approved commands; ask for other actions',
        full: 'Full: Automatically approve tools within existing restrictions',
        yolo: 'YOLO: Automatically approve tools within existing restrictions'
      };
      const title = titles[currentMode] || 'Choose permissions';
      if (promptModeBtn) promptModeBtn.title = title;

      document.querySelectorAll('.mode-popover .menu-popover-item').forEach(item => {
        const itemMode = item.getAttribute('data-mode');
        item.classList.toggle('active', itemMode === currentMode);
      });

      const modeBtn = document.getElementById('btn-mode-cycle');
      if (modeBtn) {
        modeBtn.className = 'mode-badge-btn mode-' + currentMode;
        modeBtn.title = title;
      }
    }

    ${getStreamingRenderScript()}
    ${getTurnRailScript()}

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
        currentThinkingDiv.querySelector('.agent-thinking-orb')?.remove();
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
      removeFeatureTip();
      // Only stick to bottom if user was already at the bottom; do not steal scroll if user is reading history
      if (!userScrolledUp && !_isUserActivelyScrolling && isAtBottom(2)) {
        userScrolledUp = false;
      }
      document.querySelector('.prompt-box')?.classList.add('is-generating');
      if (promptInput) { promptInput.setAttribute('aria-busy','true'); }
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
      loader.innerHTML = orbMarkup('connecting') + ' <span class="thinking-text">Waiting for ' + escapeHtml(currentModel || 'model') + '... (0s)</span>';
      wrap.appendChild(loader);

      const loaderTimer = setInterval(() => {
        const textSpan = loader.querySelector('.thinking-text');
        if (!textSpan || !document.getElementById('turn-loading-indicator')) {
          clearInterval(loaderTimer);
          return;
        }
        const elapsed = Math.floor((Date.now() - currentTurnStartTime) / 1000);
        textSpan.textContent = 'Waiting for ' + (currentModel || 'model') + '... (' + elapsed + 's)';
      }, 1000);

      currentAssistantContent = null;
      accumulatedAssistantText = '';

      chatContainer.appendChild(wrap);
      scrollToBottomIfNeeded();
    }

    // A turn still running when its session is loaded continues in the reply drawn from history.
    // A fresh wrapper would look like a second turn with no prompt before it.
    function resumeAssistantTurn(startedAtMs) {
      const last = chatContainer.lastElementChild;
      const previous = last && last.classList.contains('message-wrap') && last.classList.contains('assistant') ? last : null;
      startAssistantTurn();
      if (startedAtMs) currentTurnStartTime = startedAtMs;
      if (!previous) return;
      const fresh = currentTurnAssistantDiv;
      previous.querySelectorAll(':scope > .message-footer').forEach((footer) => footer.remove());
      const loader = fresh.querySelector('#turn-loading-indicator');
      if (loader) previous.appendChild(loader);
      fresh.remove();
      currentTurnAssistantDiv = previous;
      accumulatedAssistantText = previous._rawMarkdown ? previous._rawMarkdown + String.fromCharCode(10, 10) : '';
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
      setTurnOrb(null);
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

        const elapsedSec = (Date.now() - currentTurnStartTime) / 1000;
        currentTurnAssistantDiv._rawMarkdown = accumulatedAssistantText;
        currentTurnAssistantDiv.appendChild(buildMessageFooter({
          durationSeconds: elapsedSec,
          timestamp: Date.now(),
          copyAction: 'copy-message',
          copyTitle: 'Copy response',
        }));
        pinLatestMessageFooter();
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
      scheduleTurnRail();
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
        // The skeleton size classes fix a placeholder height, which clips real labels.
        const skeletonClasses = ['skeleton', 'skeleton-text', 'skeleton-pill', 'skeleton-session', 'skeleton-card'];
        document.querySelectorAll(skeletonClasses.map(c => '.' + c).join(', ')).forEach(el => el.classList.remove(...skeletonClasses));
        document.querySelectorAll('[aria-busy="true"]').forEach(el => el.removeAttribute('aria-busy'));
      } catch {}
    }

    window.addEventListener('message', event => handleBackendMessage(event.data));

    function rememberInteraction(msg) {
      const sid = msg.session_id || currentSessionId;
      const state = sessionsState[sid] = sessionsState[sid] || {};
      state.interactions = state.interactions || Object.create(null);
      const id = msg.approval_id || msg.question_id || 'plan';
      state.interactions[id] = msg;
      if (sid === currentSessionId) {
        interactiveSlot.dataset.interactionId = id;
        delete interactiveSlot.dataset.submitting;
      }
      setBackgroundRunWaiting(sid, true);
    }

    // Web links open only through the extension, which shows the full address and asks first.
    function externalLinkHtml(href, labelHtml, title) {
      const safeHref = escapeHtml(href);
      return '<a href="#" class="md-ext-link" data-action="open-link" data-url="' + safeHref + '" title="' + (title ? escapeHtml(title) + ' · ' : '') + safeHref + '" style="color:var(--accent); text-decoration:underline;">' + labelHtml + '</a>';
    }

    // Back and forward through the sessions shown in this view, like a browser's history.
    const sessionNavBack = document.getElementById('btn-session-back');
    const sessionNavForward = document.getElementById('btn-session-forward');
    const SESSION_HISTORY_LIMIT = 50;
    const sessionHistory = { entries: [], index: -1, pending: null };

    function syncSessionNav() {
      const busy = !!sessionHistory.pending;
      if (sessionNavBack) sessionNavBack.disabled = busy || sessionHistory.index <= 0;
      if (sessionNavForward) sessionNavForward.disabled = busy || sessionHistory.index >= sessionHistory.entries.length - 1;
    }

    function noteSessionShown(sessionId) {
      if (!sessionId) return;
      const history = sessionHistory;
      if (history.pending && history.pending.id === sessionId) {
        history.index = history.pending.index;
        history.pending = null;
      } else if (history.entries[history.index] !== sessionId) {
        history.entries = history.entries.slice(0, history.index + 1);
        history.entries.push(sessionId);
        if (history.entries.length > SESSION_HISTORY_LIMIT) history.entries.shift();
        history.index = history.entries.length - 1;
      }
      syncSessionNav();
    }

    function navigateSession(step) {
      const history = sessionHistory;
      const index = history.index + step;
      if (history.pending || index < 0 || index >= history.entries.length) return;
      history.pending = { id: history.entries[index], index };
      syncSessionNav();
      vscode.postMessage({ type: 'navigate_session', sessionId: history.pending.id });
    }

    function clearSessionNavPending(sessionId) {
      if (sessionHistory.pending && sessionHistory.pending.id === sessionId) {
        sessionHistory.pending = null;
        syncSessionNav();
      }
    }

    function forgetSession(sessionId) {
      const history = sessionHistory;
      const entries = [];
      let index = -1;
      history.entries.forEach((id, i) => {
        if (id === sessionId || id === entries[entries.length - 1]) {
          if (i === history.index) index = entries.length - 1;
          return;
        }
        entries.push(id);
        if (i === history.index) index = entries.length - 1;
      });
      history.entries = entries;
      history.index = Math.max(Math.min(index, entries.length - 1), entries.length ? 0 : -1);
    }

    function handleSessionNavResult(msg) {
      if (!sessionHistory.pending || sessionHistory.pending.id !== msg.sessionId) return;
      if (msg.status === 'ok') return;
      sessionHistory.pending = null;
      if (msg.status === 'missing') {
        forgetSession(msg.sessionId);
        appendSystemNote('Session not found. It may have been deleted.');
      } else {
        appendSystemNote('Could not open that session. Reconnect and try again.');
      }
      syncSessionNav();
    }

    if (sessionNavBack) sessionNavBack.addEventListener('click', () => navigateSession(-1));
    if (sessionNavForward) sessionNavForward.addEventListener('click', () => navigateSession(1));
    document.addEventListener('keydown', (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ''))) return;
      event.preventDefault();
      navigateSession(event.key === 'ArrowLeft' ? -1 : 1);
    });
    noteSessionShown(currentSessionId);

    const feedbackDockBtn = document.getElementById('btn-feedback-dock');
    const feedbackPopover = document.getElementById('feedback-popover');
    const feedbackText = document.getElementById('feedback-text');
    const feedbackStatus = document.getElementById('feedback-status');
    const feedbackCount = document.getElementById('feedback-count');
    const feedbackSendBtn = document.getElementById('btn-feedback-send');
    const feedbackIssueBtn = document.getElementById('btn-feedback-issue');
    const feedbackCancelBtn = document.getElementById('btn-feedback-cancel');
    let feedbackSending = false;
    let feedbackCloseTimer = null;

    function setFeedbackStatus(text, tone) {
      feedbackStatus.textContent = text || '';
      feedbackStatus.className = 'feedback-status' + (tone ? ' ' + tone : '');
    }

    function syncFeedbackForm() {
      feedbackCount.textContent = feedbackText.value.length + '/2000';
      feedbackSendBtn.disabled = feedbackSending || !feedbackText.value.trim();
    }

    function toggleFeedback(open) {
      clearTimeout(feedbackCloseTimer);
      const focusWasInside = feedbackPopover.contains(document.activeElement);
      feedbackPopover.hidden = !open;
      feedbackDockBtn.setAttribute('aria-expanded', String(open));
      if (open) {
        feedbackIssueBtn.hidden = true;
        setFeedbackStatus('');
        syncFeedbackForm();
        feedbackText.focus();
      } else if (focusWasInside) {
        feedbackDockBtn.focus();
      }
    }

    function sendFeedback() {
      if (feedbackSendBtn.disabled) return;
      feedbackSending = true;
      feedbackIssueBtn.hidden = true;
      syncFeedbackForm();
      setFeedbackStatus('Sending…');
      vscode.postMessage({ type: 'submit_feedback', message: feedbackText.value });
    }

    function handleFeedbackResult(msg) {
      feedbackSending = false;
      if (msg.ok) {
        feedbackText.value = '';
        syncFeedbackForm();
        setFeedbackStatus('Thanks! Your feedback reached the Andromity team.', 'ok');
        feedbackCloseTimer = setTimeout(() => toggleFeedback(false), 2500);
        return;
      }
      syncFeedbackForm();
      setFeedbackStatus(msg.error || 'Your feedback could not be sent.', 'error');
      feedbackIssueBtn.hidden = !msg.canOpenIssue;
    }

    if (feedbackDockBtn && feedbackPopover) {
      feedbackDockBtn.addEventListener('click', () => toggleFeedback(feedbackPopover.hidden));
      feedbackCancelBtn.addEventListener('click', () => toggleFeedback(false));
      feedbackSendBtn.addEventListener('click', sendFeedback);
      feedbackIssueBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'feedback_issue', message: feedbackText.value });
        toggleFeedback(false);
      });
      feedbackText.addEventListener('input', () => {
        if (!feedbackSending) setFeedbackStatus('');
        feedbackIssueBtn.hidden = true;
        syncFeedbackForm();
      });
      feedbackText.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          sendFeedback();
        }
      });
      feedbackPopover.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          toggleFeedback(false);
        }
      });
      document.addEventListener('mousedown', (event) => {
        if (!feedbackPopover.hidden && !(event.target && event.target.closest && event.target.closest('#feedback-dock'))) toggleFeedback(false);
      });
    }

    function handleBackendMessage(msg) {
      if (!msg) return;
      if (needsStreamSettle(msg.type)) settleStreamingRender();
      dispatchBackendMessage(msg);
    }

    function dispatchBackendMessage(msg) {
      switch (msg.type) {
        case 'workspace_files_updated': {
          if (Array.isArray(msg.files)) {
            workspaceFiles = new Set(msg.files.map(f => String(f).toLowerCase()));
          }
          if (Array.isArray(msg.dirs)) {
            workspaceFolders = new Set(msg.dirs.map(d => String(d).toLowerCase()));
          }
          break;
        }
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
          noteSessionShown(currentSessionId);
          requestQueueSnapshot();
          allModels = msg.models || [];
          if (msg.pinnedModels) {
            pinnedModels = msg.pinnedModels;
          }
          if (msg.skills) {
            allSkills = msg.skills;
          }
          if (msg.model) currentModel = msg.model;
          if (msg.provider) currentProvider = msg.provider;
          if (msg.mode) {
            updateModeBadge(msg.mode);
          }
          if (msg.profile) {
            currentProfile = msg.profile;
            updateProfileBadge();
          }
          if (msg.modelReasoningCapability) {
            currentModelReasoningCapability = {
              ...msg.modelReasoningCapability,
              _modelId: msg.model || currentModel,
              _providerId: msg.provider || currentProvider,
            };
          } else {
            currentModelReasoningCapability = null;
          }
          if (msg.reasoningEffort) {
            currentReasoning = msg.reasoningEffort;
          }
          updateReasoningBadge();
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
            sessLabel.textContent = curSess ? (cleanPromptForDisplay(curSess.name) || curSess.id) : 'Main Session';
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
          } else {
            hidePlanTracker();
          }
          if (msg.models && msg.models.length > 0) {
            allModels = msg.models;
          }
          if (msg.providers) {
            allProviders = msg.providers;
          }
          updateModelBadge();
          updateOnboardingVisibility();
          const btnSignInInit = document.getElementById('zero-gateway-signin-btn');
          const badgeActiveInit = document.getElementById('zero-gateway-active-badge');
          const gatewaySubInit = document.getElementById('zero-gateway-sub');
          let isInitialAuthed = isAndromityActive;
          try {
            if (typeof localStorage !== 'undefined' && localStorage.getItem('andromity_active_status') === 'true') {
              isInitialAuthed = true;
            }
          } catch {}
          if (btnSignInInit) {
            btnSignInInit.style.display = isInitialAuthed ? 'none' : 'inline-flex';
          }
          if (badgeActiveInit) {
            badgeActiveInit.style.display = isInitialAuthed ? 'inline-flex' : 'none';
          }
          if (gatewaySubInit && isInitialAuthed) {
            gatewaySubInit.innerHTML = '&bull; Active Gateway';
          }
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

        case 'ollama_detected': {
          if (Array.isArray(msg.models) && msg.models.length > 0) {
            allModels = msg.models;
            updateModelBadge();
          }
          if (msg.model) showOllamaBanner(msg.model);
          if (msg.status) updateOllamaStatusUI(msg.status);
          break;
        }

        case 'auth_state_changed': {
          const isAuthed = !!msg.isAuthenticated;
          const authChanged = lastAuthState !== null && lastAuthState !== isAuthed;
          lastAuthState = isAuthed;
          isAndromityActive = isAuthed;
          try {
            localStorage.setItem('andromity_active_status', isAuthed ? 'true' : 'false');
            localStorage.setItem('andromity_plan', msg.plan || (isAuthed ? 'authenticated' : 'anonymous'));
          } catch {}
          updateOnboardingVisibility();
          const btnSignIn = document.getElementById('zero-gateway-signin-btn');
          const badgeActive = document.getElementById('zero-gateway-active-badge');
          const gatewaySub = document.getElementById('zero-gateway-sub');
          if (btnSignIn) {
            btnSignIn.style.display = isAuthed ? 'none' : 'inline-flex';
          }
          if (badgeActive) {
            badgeActive.style.display = isAuthed ? 'inline-flex' : 'none';
          }
          if (gatewaySub) {
            gatewaySub.innerHTML = isAuthed
              ? 'Edge Gateway Active'
              : 'Multi-cloud edge fallback &bull; Instant free trial';
          }
          renderCloudAccountUsage({ plan: isAuthed ? 'authenticated' : 'anonymous', username: msg.username, status: 'checking' });
          if (authChanged) {
            appendSystemNote(isAuthed
              ? 'Signed in with AgenticMarket account. Authenticated access is now active.'
              : 'Signed out of AgenticMarket. Switched to anonymous free tier.');
          }
          break;
        }

        case 'usage_updated': {
          renderCloudAccountUsage(msg);
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
          if (msg.key === 'airgap') {
            const pill = document.getElementById('airgap-pill');
            if (pill) {
              pill.hidden = !msg.value;
              pill.title = msg.title || '';
              pill.setAttribute('aria-label', msg.title || 'Air-gap mode is on');
            }
          } else if (msg.key === 'mode') {
            updateModeBadge(msg.value);
            if (msg.appliesNextTurn && msg.notice) {
              appendSystemNote(msg.notice);
              const modeButton = document.getElementById('btn-prompt-mode');
              if (modeButton) modeButton.title += ' — Applies from the next turn';
            }
          } else if (msg.key === 'model') {
            currentModel = msg.value;
            if (msg.provider) currentProvider = msg.provider;
            // The window size depends on the model; the daemon's limit is refreshed too.
            contextBreakdown = null;
            renderTokenDisplay();
            scheduleContextBreakdown();
            if (msg.reasoningCapability) {
              currentModelReasoningCapability = {
                ...msg.reasoningCapability,
                _modelId: msg.value,
                _providerId: msg.provider || currentProvider,
              };
            } else {
              currentModelReasoningCapability = null;
            }
            updateModelBadge();
            updateReasoningBadge();
          } else if (msg.key === 'provider') {
            currentProvider = msg.value;
            currentModelReasoningCapability = null;
            updateReasoningBadge();
            updateModelBadge();
          } else if (msg.key === 'profile') {
            currentProfile = msg.value;
            updateProfileBadge();
          } else if (msg.key === 'reasoningEffort') {
            currentReasoning = msg.value;
            updateReasoningBadge();
          }
          break;

        case 'run_status':
          applyRunStatus(msg);
          break;

        case 'starter_context':
          renderSmartStarters(msg);
          break;

        case 'side_panel_preferences':
          if (msg.preferences && typeof msg.preferences === 'object' && !Array.isArray(msg.preferences)) {
            const next = normalizeSidePanelPreferences(msg.preferences);
            if (JSON.stringify(next) === JSON.stringify(sidePanelPrefs)) break;
            sidePanelPrefs = next;
            clearSidePanelDrag();
            try { localStorage.setItem('andromity.sidePanel', JSON.stringify(sidePanelPrefs)); } catch (e) {}
            applySidePanelOrder();
            renderSidePanel();
          }
          break;
        case 'side_panel_visibility':
          if (typeof msg.off === 'boolean') setSidePanelOff(msg.off, false);
          break;
        case 'side_panel_data':
          if (msg.mcp !== undefined) sidePanelData.mcp = msg.mcp;
          if (msg.changes !== undefined) sidePanelData.changes = msg.changes;
          if (msg.folder) sidePanelData.folder = msg.folder;
          if (msg.mcpTooltip) sidePanelData.mcpTooltip = msg.mcpTooltip;
          renderSidePanel();
          break;

        case 'session_switched':
          userScrolledUp = false;
          _isUserActivelyScrolling = false;
          _lastUserScrollTime = 0;
          _ignoreScrollUntil = Date.now() + 300;
          if (_scrollRafId) {
            cancelAnimationFrame(_scrollRafId);
            _scrollRafId = null;
          }
          if (currentSessionId) {
            sessionsState[currentSessionId] = sessionsState[currentSessionId] || {};
            sessionsState[currentSessionId].draftInput = promptInput ? promptInput.value : '';
            // Detach live turn state — next session must not reuse previous turn divs
            currentTurnAssistantDiv = null;
            currentThinkingDiv = null;
            currentThinkingContent = null;
            currentAssistantContent = null;
            currentToolSequence = null;
          }
          // Clear per-session diff state so it doesn't leak into the target session
          turnEditedFiles.clear();
          globalDiffStats = {};
          activeBgProcesses.clear();
          updateBgProcessStripUI();
          if (msg.sessionId) {
            currentSessionId = msg.sessionId;
            noteSessionShown(currentSessionId);
          }
          if (sessionsState[currentSessionId]) {
            sessionsState[currentSessionId].hasUnread = false;
          }
          updateSessionActivityIndicator();
          removeTurnLoader();
          finishCurrentThinking();
          sessionCollabActive = false;
          sessionCollabState = {};
          const collabBadgeOnSwitch = document.getElementById('session-collab-badge');
          if (collabBadgeOnSwitch) collabBadgeOnSwitch.style.display = 'none';
          if (collabInboxPopover) collabInboxPopover.style.display = 'none';
          updateCollabInboxBadge();
          renderCollabInbox();
          interactiveSlot.innerHTML = '';
          delete interactiveSlot.dataset.interactionId;
          delete interactiveSlot.dataset.submitting;
          activePendingApprovalId = null;
          activePendingToolName = '';
          activePendingPlan = false;
          hidePlanTracker();
          isPlanTrackerDismissed = false;
          {
            const sessState = sessionsState[currentSessionId];
            const pending = Object.values(sessState?.interactions || {})[0];
            if (pending) handleBackendMessage(pending);
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
          if (msg.session?.id && currentSessionId && msg.session.id !== currentSessionId) break;
          userScrolledUp = false;
          _isUserActivelyScrolling = false;
          _lastUserScrollTime = 0;
          _ignoreScrollUntil = Date.now() + 300;
          if (_scrollRafId) {
            cancelAnimationFrame(_scrollRafId);
            _scrollRafId = null;
          }
          removeTurnLoader();
          finishCurrentThinking();
          awaitingApprovalRow = null;
          chatContainer.innerHTML = '';
          interactiveSlot.innerHTML = '';
          delete interactiveSlot.dataset.interactionId;
          activePendingApprovalId = null;
          activePendingToolName = '';
          activePendingPlan = false;
          currentTurnAssistantDiv = null;
          currentAssistantContent = null;
          currentThinkingDiv = null;
          currentThinkingContent = null;
          currentToolSequence = null;
          const runtime = msg.session?.runtime;
          if (runtime) sessionLiveBuffer.delete(currentSessionId);
          const liveToolIds = new Set((runtime?.tools || []).map(tool => tool.tool_id));
          activeBgProcesses.clear();
          updateBgProcessStripUI();
          // Reset diff stats — they belong to the previous session's history and must not
          // accumulate into the newly loaded session's tool call replay.
          globalDiffStats = {};
          turnEditedFiles.clear();
          if (msg.session && msg.session.id) {
            currentSessionId = msg.session.id;
            noteSessionShown(currentSessionId);
            requestQueueSnapshot();
          }
          if (msg.session) {
            updateSessionCollabBadge(msg.session);
          }
          updateCollabInboxBadge();
          renderCollabInbox();
          const sessionIsRunning = runtime ? runtime.is_running === true : Boolean(
            (msg.session && (msg.session.status === 'running' || msg.session.is_running)) ||
            (sessionsState[currentSessionId] && sessionsState[currentSessionId].isRunning)
          );
          const runningTurnPrompt = ((msg.session && msg.session.messages) || []).filter((m) => m && m.role === 'user').pop();
          const runningTurnStart = runningTurnPrompt && runningTurnPrompt.ts ? Date.parse(runningTurnPrompt.ts) || 0 : 0;
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
          sessionsState[currentSessionId].scheduledRun = (msg.session && msg.session.scheduled_run) || null;
          updateScheduledRunNotice(sessionsState[currentSessionId].scheduledRun, sessionIsRunning);
          if (promptInput && !msg.draft) {
            promptInput.value = (sessionsState[currentSessionId] && sessionsState[currentSessionId].draftInput) || '';
            promptInput.style.height = 'auto';
          }
          const activeSessName = document.getElementById('active-session-name');
          if (activeSessName && msg.session) {
            activeSessName.textContent = cleanPromptForDisplay(msg.session.name) || msg.session.id || 'Main Session';
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
          // A suggestion shows as the next-step card, not as a tool call in the transcript.
          const historyNextStep = nextStepFromHistory(allMessages);
          allMessages = withoutNextStepCalls(allMessages);

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
            const toolResultsForLoad = new Map();
            for (const hm of allMessages) {
              if (hm && hm.role === 'tool' && hm.tool_call_id) toolResultsForLoad.set(hm.tool_call_id, extractMessageText(hm.content));
            }

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
                    appendUserMessage(uContent, m.images || [], m.ts, { skipDedupe: true, steering: Boolean(m.steering) });
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
                if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.some(tc => !liveToolIds.has(tc.id))) {
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
                    const seqWrap = document.createElement('div');
                    seqWrap.className = 'tool-sequence-wrap';
                    seqWrap.appendChild(seqEl);
                    const mascotPerch = document.createElement('div');
                    mascotPerch.className = 'tool-seq-mascot-perch';
                    seqWrap.appendChild(mascotPerch);
                    currentAssistantWrap.appendChild(seqWrap);
                  }

                  for (const tc of m.tool_calls) {
                    if (liveToolIds.has(tc.id)) continue;
                    currentTurnToolCount++;
                    const fn = tc.function || {};
                    const toolName = fn.name || 'tool';
                    const toolArgs = fn.arguments || '';

                    const isWriteTool = /^(write_file|write_to_file|edit_file|edit_file_multi|multi_replace_file_content|replace_file_content|patch_file|create_file|delete_file|move_file|rename_file|save_file)$/.test(toolName);
                    const loadedEditStatus = typeof window.classifyFileEditResult === 'function'
                      ? window.classifyFileEditResult(toolResultsForLoad.get(tc.id), undefined)
                      : 'done';
                    if (isWriteTool && loadedEditStatus !== 'error') {
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
                      renderedActivity = window.renderAntigravityActivityRow(toolName, toolArgs, loadedEditStatus);
                    }
                    if (!renderedActivity && typeof window.renderBackgroundProcessActivityRow === 'function' && /^shell_bg$/i.test(toolName)) {
                      // History only says the process started; it is running only if the daemon still lists it.
                      const bgResult = toolResultsForLoad.get(tc.id) || '';
                      const bgIdMatch = /with id '([^']+)'/.exec(String(bgResult));
                      const bgRunning = !!bgIdMatch && (runtime?.processes || []).some(p => p.process_id === bgIdMatch[1]);
                      const bgStatus = window.bgStatusFromResult(bgResult) || (bgRunning ? 'running_bg' : 'ended');
                      renderedActivity = window.renderBackgroundProcessActivityRow(toolName, toolArgs, bgStatus, bgResult);
                    } else if (!renderedActivity && typeof window.renderCommandActivityRow === 'function' && /^(shell_exec|run_command|bash|exec|cmd)$/i.test(toolName)) {
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
                      updateToolTarget(tDiv, toolName, toolArgs);
                      if (typeof window.markExternalToolCard === 'function') window.markExternalToolCard(tDiv, toolResultsForLoad.get(tc.id));
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

                  let elapsedSec = m.duration ? Number(m.duration) : null;
                  if (elapsedSec === null && m.ts && lastUserMsgTs) {
                    const delta = (new Date(m.ts).getTime() - new Date(lastUserMsgTs).getTime()) / 1000;
                    if (delta > 0 && delta < 3600) {
                      elapsedSec = delta;
                    }
                  }
                  currentAssistantWrap.appendChild(buildMessageFooter({
                    durationSeconds: elapsedSec,
                    timestamp: m.ts || Date.now(),
                    copyAction: 'copy-message',
                    copyTitle: 'Copy response',
                  }));
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
            noteSessionShown(currentSessionId);
            if (msg.session.model) {
              currentModel = msg.session.model;
              if (msg.session.provider) currentProvider = msg.session.provider;
              updateModelBadge();
            }
            updateTokenDisplay(msg.session);
            if (msg.session && msg.session.plan && msg.session.plan.steps && msg.session.plan.steps.length > 0) {
              updatePlanTracker(msg.session.plan);
            } else {
              hidePlanTracker();
              // Anchor the newest answer's meta strip; older ones stay hover-only
              pinLatestMessageFooter();
            }
          }
          // Replay any live buffered deltas that arrived while this session was in background
          {
            const buffered = sessionLiveBuffer.get(currentSessionId);
            if (buffered && buffered.length > 0) {
              // Ensure a live turn wrapper exists to append into
              const needTurn = !currentTurnAssistantDiv || !chatContainer.contains(currentTurnAssistantDiv);
              if (needTurn) resumeAssistantTurn(runningTurnStart);
              for (const ev of buffered) {
                if (ev.t === 'thinking_delta') {
                  removeTurnLoader(); setTurnOrb(null);
                  if (!currentThinkingDiv) {
                    thinkingStartTime = Date.now();
                    currentThinkingDiv = document.createElement('div');
                    currentThinkingDiv.className = 'thinking-card expanded';
                    currentThinkingDiv.innerHTML = '<div class="thinking-header">' + orbMarkup('weaving') + '<span>thinking...</span><svg class="thinking-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg></div>';
                    currentThinkingContent = document.createElement('div');
                    currentThinkingContent.className = 'thinking-content';
                    currentThinkingDiv.appendChild(currentThinkingContent);
                    if (currentToolSequence) currentToolSequence.querySelector('.tool-seq-body').appendChild(currentThinkingDiv);
                    else if (currentTurnAssistantDiv) currentTurnAssistantDiv.appendChild(currentThinkingDiv);
                  }
                  if (currentThinkingContent) appendStreamText(currentThinkingContent, ev.text);
                } else if (ev.t === 'text_delta') {
                  removeTurnLoader(); finishCurrentThinking(); if (currentToolSequence) finishToolSequence();
                  if (!currentAssistantContent) {
                    currentAssistantContent = document.createElement('div');
                    currentAssistantContent.className = 'assistant-text';
                    currentAssistantContent._blockText = '';
                    if (currentTurnAssistantDiv) currentTurnAssistantDiv.appendChild(currentAssistantContent);
                  }
                  currentAssistantContent._blockText = (currentAssistantContent._blockText||'') + ev.text;
                  queueTextRender(currentAssistantContent);
                  setTurnOrb(null);
                } else if (ev.t === 'tool_start') {
                  setTurnOrb(null);
                  removeTurnLoader(); finishCurrentThinking(); currentAssistantContent = null;
                  const seq = ensureToolSequence(); toolSeqCount++; lastToolName = ev.tool_name||'tool'; lastToolRunning=true; updateToolSeqHeader();
                  const td = document.createElement('div'); td.className='tool-card expanded'; td.id='tool-'+ev.tool_id; td.setAttribute('data-tool-name', ev.tool_name||'');
                  td.innerHTML = '<div class="tool-header"><div class="tool-title-group"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg><span>'+escapeHtml(ev.tool_name)+'</span></div><div style="display:flex; align-items:center;"><span class="tool-tag">RUNNING</span><svg class="tool-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg></div></div><div class="tool-body" id="args-'+escapeHtml(ev.tool_id)+'"></div>';
                  seq.querySelector('.tool-seq-body').appendChild(td);
                } else if (ev.t === 'tool_delta') {
                  const ae = document.getElementById('args-'+ev.tool_id); if (ae) { appendStreamText(ae, ev.chunk); const card = document.getElementById('tool-'+ev.tool_id); updateToolTarget(card, card?.querySelector('.tool-title-group span')?.textContent || '', ae.textContent); }
                } else if (ev.t === 'tool_result') {
                  const tt = document.getElementById('tool-'+ev.tool_id);
                  if (tt) { const tag=tt.querySelector('.tool-tag'); if(tag){tag.textContent='DONE'; tag.style.background='rgba(63,185,80,0.2)'; tag.style.color='var(--green)';} tt.classList.remove('expanded'); }
                }
              }
              sessionLiveBuffer.delete(currentSessionId);
              settleStreamingRender();
              scrollToBottomIfNeeded();
            }
          }
          if (sessionIsRunning && (!currentTurnAssistantDiv || !chatContainer.contains(currentTurnAssistantDiv))) {
            resumeAssistantTurn(runningTurnStart);
          }
          if (runtime) handleBackendMessage({ type: 'session_runtime', session_id: currentSessionId, runtime });
          if (currentSessionId && !nextStepBySession[currentSessionId] && !sessionIsRunning &&
              historyNextStep && !nextStepDismissed.has(historyNextStep.key)) {
            nextStepBySession[currentSessionId] = historyNextStep;
          }
          if (msg.session) {
            renderBackgroundOrigin(msg.session);
            restoreBackgroundRuns(msg.session);
          }
          renderNextStep();
          renderConversationTimeline();
          userScrolledUp = false;
          scrollToBottom(false);
          settleSessionScroll();
          break;

        case 'session_runtime': {
          if (msg.session_id !== currentSessionId) break;
          const state = sessionsState[currentSessionId] = sessionsState[currentSessionId] || {};
          state.interactions = Object.create(null);
          delete state.pendingApproval;
          delete state.pendingQuestions;
          delete state.pendingPlanApproval;
          state.isRunning = msg.runtime.is_running === true;
          isRunning = state.isRunning;
          cancelBtn.style.display = isRunning ? 'flex' : 'none';
          sendBtn.style.display = isRunning ? 'none' : 'flex';
          document.querySelector('.prompt-box')?.classList.toggle('is-generating', isRunning);
          if (!isRunning) removeTurnLoader();
          if (msg.runtime.thinking) handleBackendMessage({ type: 'thinking_delta', text: msg.runtime.thinking });
          if (msg.runtime.text) handleBackendMessage({ type: 'text_delta', text: msg.runtime.text });
          for (const tool of msg.runtime.tools || []) {
            handleBackendMessage({ type: 'tool_start', ...tool });
            handleBackendMessage({ type: 'tool_delta', tool_id: tool.tool_id, chunk: tool.args_json });
          }
          activeBgProcesses.clear();
          for (const process of msg.runtime.processes || []) handleBackendMessage({ type: 'process_started', ...process });
          updateBgProcessStripUI();
          for (const interaction of msg.runtime.interactions || []) handleBackendMessage(interaction);
          break;
        }
        case 'session_load_failed':
          clearSessionNavPending(msg.session_id);
          if (msg.session_id === currentSessionId) appendSystemNote('Could not load this session. Reconnect and try again.');
          clearSkeletonState();
          break;
        case 'action_failed':
          if (msg.session_id === currentSessionId) appendSystemNote(msg.error);
          break;
        case 'interaction_resolved': {
          const sid = msg.session_id || currentSessionId;
          const state = sessionsState[sid];
          if (state?.interactions) delete state.interactions[msg.interaction_id];
          if (!state?.interactions || !Object.keys(state.interactions).length) setBackgroundRunWaiting(sid, false);
          if (sid !== currentSessionId || interactiveSlot.dataset.interactionId !== msg.interaction_id) break;
          clearAwaitingApproval();
          interactiveSlot.innerHTML = '';
          delete interactiveSlot.dataset.interactionId;
          delete interactiveSlot.dataset.submitting;
          activePendingApprovalId = null;
          activePendingToolName = '';
          activePendingPlan = false;
          const next = Object.values(state?.interactions || {})[0];
          if (next) handleBackendMessage(next);
          break;
        }
        case 'interaction_failed':
          if (msg.session_id !== currentSessionId) break;
          delete interactiveSlot.dataset.submitting;
          interactiveSlot.querySelectorAll('button, input, textarea').forEach(control => { control.disabled = false; });
          appendSystemNote(msg.error);
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
            bufferLiveEvent(msg.session_id, { t:'text_delta', text: msg.text });
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
          queueTextRender(currentAssistantContent);
          setTurnOrb(null);
          break; }

        case 'thinking_delta': {
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            sessionsState[msg.session_id].hasUnread = true;
            updateSessionActivityIndicator();
            bufferLiveEvent(msg.session_id, { t:'thinking_delta', text: msg.text });
            break;
          }
          removeTurnLoader();
          if (!currentTurnAssistantDiv) startAssistantTurn();
          removeTurnLoader();
          setTurnOrb(null);
          if (!currentThinkingDiv) {
            thinkingStartTime = Date.now();
            currentThinkingDiv = document.createElement('div');
            currentThinkingDiv.className = 'thinking-card expanded';
            currentThinkingDiv.innerHTML = '<div class="thinking-header">' +
              orbMarkup('weaving') +
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
          appendStreamText(currentThinkingContent, msg.text);
          const thinkingEl = currentThinkingContent;
          queueStreamTask(thinkingEl, () => { thinkingEl.scrollTop = thinkingEl.scrollHeight; });
          break; }

        case 'tool_start': {
          // Shown as the next-step card when the turn ends, not as a tool call.
          if (msg.tool_name === 'suggest_next_step') break;
          if (!msg.session_id || !currentSessionId || msg.session_id === currentSessionId) setTurnOrb(null);
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            sessionsState[msg.session_id].hasUnread = true;
            updateSessionActivityIndicator();
            bufferLiveEvent(msg.session_id, { t:'tool_start', tool_id: msg.tool_id, tool_name: msg.tool_name });
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
              '<span class="activity-filename" id="label-' + escapeHtml(msg.tool_id) + '">' + escapeHtml(msg.tool_name) + '…</span>' +
              '<span class="tool-elapsed" id="elapsed-' + escapeHtml(msg.tool_id) + '">0s</span>' +
              '<span class="activity-running-dot"></span>' +
              '<div class="tool-body" id="args-' + escapeHtml(msg.tool_id) + '" style="display:none;"></div>';
          } else {
            toolDiv.className = 'tool-card expanded';
            toolDiv.setAttribute('data-start-ts', String(Date.now()));
            toolDiv.innerHTML = '<div class="tool-header">' +
              '<div class="tool-title-group">' +
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>' +
                '<span>' + escapeHtml(msg.tool_name) + '</span>' +
              '</div>' +
              '<div style="display:flex; align-items:center; gap:6px;">' +
                '<span class="tool-elapsed" id="elapsed-' + escapeHtml(msg.tool_id) + '">0s</span>' +
                '<span class="tool-tag">RUNNING</span>' +
                '<svg class="tool-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>' +
              '</div>' +
            '</div>' +
            '<div class="tool-body" id="args-' + escapeHtml(msg.tool_id) + '"></div>';
          }
          seq.querySelector('.tool-seq-body').appendChild(toolDiv);
          scrollToBottomIfNeeded();
          break; }

        case 'tool_delta': {
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            bufferLiveEvent(msg.session_id, { t:'tool_delta', tool_id: msg.tool_id, chunk: msg.chunk });
            break;
          }
          const argsEl = document.getElementById('args-' + msg.tool_id);
          if (argsEl) {
            appendStreamText(argsEl, msg.chunk);
            const toolId = msg.tool_id;
            queueStreamTask('tool-label:' + toolId, () => resolveStreamingToolLabel(toolId, argsEl));
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
            bufferLiveEvent(msg.session_id, { t:'tool_result', tool_id: msg.tool_id, result: msg.result });
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
              const editStatus = typeof window.classifyFileEditResult === 'function'
                ? window.classifyFileEditResult(msg.result, msg.success)
                : (msg.success === false ? 'error' : 'done');
              if (isWriteTool && editStatus !== 'error') {
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
                activityEl = window.renderAntigravityActivityRow(toolName, rawArgs, editStatus);
              }
              if (!activityEl && typeof window.renderBackgroundProcessActivityRow === 'function' && /^shell_bg$/i.test(toolName)) {
                activityEl = window.renderBackgroundProcessActivityRow(toolName, rawArgs,
                  msg.success === false ? 'error' : (window.bgStatusFromResult(msg.result) || 'running_bg'), msg.result);
              } else if (!activityEl && typeof window.renderCommandActivityRow === 'function' && /^(shell_exec|run_command|bash|exec|cmd)$/i.test(toolName)) {
                activityEl = window.renderCommandActivityRow(toolName, rawArgs, msg.success === false ? 'error' : 'done', msg.result);
              }

              if (activityEl) {
                activityEl.id = 'tool-' + msg.tool_id;
                targetTool.removeAttribute('data-start-ts');
                targetTool.replaceWith(activityEl);
              } else {
                const isBg = /^shell_bg$/i.test(toolName);
                let procId = '';
                if (isBg && msg.result) {
                  const m = String(msg.result).match(/with id '([^']+)'/);
                  if (m) procId = m[1];
                }
                const tag = targetTool.querySelector('.tool-tag');
                if (tag) {
                  if (isBg && msg.success !== false) {
                    tag.textContent = 'RUNNING (BG)';
                    tag.style.background = 'rgba(88, 166, 255, 0.2)';
                    tag.style.color = 'var(--accent, #58a6ff)';
                    if (procId) {
                      targetTool.setAttribute('data-process-id', procId);
                      if (!activeBgProcesses.has(procId)) {
                        activeBgProcesses.set(procId, {
                          process_id: procId,
                          pid: '',
                          command: targetTool.getAttribute('data-tool-args') || '',
                          startTime: Date.now()
                        });
                        updateBgProcessStripUI();
                      }
                      const hdr = targetTool.querySelector('.tool-header');
                      if (hdr && !hdr.querySelector('.bg-proc-stop-btn')) {
                        const sBtn = document.createElement('button');
                        sBtn.className = 'bg-proc-stop-btn';
                        sBtn.setAttribute('data-process-id', procId);
                        sBtn.title = 'Stop background process';
                        sBtn.innerHTML = '<span class="codicon codicon-debug-stop"></span> Stop';
                        sBtn.onclick = function(ev) {
                          ev.stopPropagation();
                          sBtn.disabled = true;
                          sBtn.textContent = 'Stopping...';
                          vscode.postMessage({ type: 'kill_process', processId: procId });
                        };
                        hdr.appendChild(sBtn);
                      }
                    }
                  } else {
                    tag.textContent = msg.success === false ? 'FAILED' : 'DONE';
                    tag.style.background = msg.success === false ? 'rgba(248, 81, 73, 0.2)' : 'rgba(63, 185, 80, 0.2)';
                    tag.style.color = msg.success === false ? 'var(--red)' : 'var(--green)';
                    if (typeof window.markExternalToolCard === 'function') window.markExternalToolCard(targetTool, msg.result);
                  }

                  if ((msg.tool_name === 'shell_kill') && msg.success !== false) {
                    let kPid = '';
                    const km = String(msg.result || '').match(/Process '([^']+)'/);
                    if (km) kPid = km[1];
                    if (!kPid && targetTool) {
                      try {
                        const rawArgs = targetTool.getAttribute('data-tool-args');
                        const parsed = JSON.parse(rawArgs || '{}');
                        if (parsed.process_id) kPid = parsed.process_id;
                      } catch (e) {}
                    }
                    if (kPid && activeBgProcesses.has(kPid)) {
                      activeBgProcesses.delete(kPid);
                      updateBgProcessStripUI();
                    } else if (!kPid && activeBgProcesses.size === 1) {
                      activeBgProcesses.clear();
                      updateBgProcessStripUI();
                    }
                    if (typeof window.handleProcessExitedUI === 'function') {
                      window.handleProcessExitedUI({ process_id: kPid, exit_code: 0 });
                    }
                  }
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
          rememberInteraction(msg);
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            sessionsState[msg.session_id].pendingApproval = msg;
            break;
          }
          interactiveSlot.innerHTML = renderPermissionCard(msg);
          markAwaitingApproval(msg.tool_name);
          scrollToBottomIfNeeded();
          break; }

        case 'ask_questions': {
          rememberInteraction(msg);
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            sessionsState[msg.session_id].pendingQuestions = msg;
            break;
          }
          activePendingApprovalId = null;
          activePendingToolName = '';
          activePendingPlan = false;
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
              optionsHtml = '<div class="permission-options-group question-options-group">';
              q.options.forEach((opt, optIdx) => {
                const optNum = optIdx + 1;
                const numBadge = optNum <= 9 ? ('<kbd class="perm-kbd">' + optNum + '</kbd>') : '';
                optionsHtml += '<label class="permission-option-row question-option-row" data-opt-idx="' + optIdx + '">' +
                  '<div class="question-radio-custom' + (isMulti ? ' question-checkbox-custom' : '') + '">' +
                    '<input type="' + (isMulti ? 'checkbox' : 'radio') + '" name="q_' + idx + '" value="' + escapeHtml(opt) + '">' +
                    '<span class="custom-radio-indicator"></span>' +
                  '</div>' +
                  '<div class="option-row-main">' +
                    '<div class="option-row-title">' + escapeHtml(opt) + '</div>' +
                  '</div>' +
                  (numBadge ? '<div class="option-row-badge">' + numBadge + '</div>' : '') +
                '</label>';
              });
              // Never force the user into the listed choices.
              optionsHtml += '<input type="text" class="question-other-input" id="q_other_' + idx + '" data-q-idx="' + idx + '"' +
                ' data-q-multi="' + (isMulti ? '1' : '') + '" placeholder="Something else…" aria-label="Answer in your own words" autocomplete="off">';
              optionsHtml += '</div>';
            } else {
              optionsHtml = '<div class="question-input-wrapper">' +
                '<textarea id="q_input_' + idx + '" class="question-textarea" data-q-idx="' + idx + '" placeholder="Type your answer..." rows="3"></textarea>' +
              '</div>';
            }

            slidesHtml += '<div class="question-slide" id="q-slide-' + idx + '" style="' + (idx === 0 ? 'display:block;' : 'display:none;') + '">' +
              '<div class="permission-code-box question-prompt-box">' +
                (totalQ > 1 ? '<span class="question-num-tag">Question ' + (idx + 1) + ':</span>' : '') +
                '<span class="question-prompt-text">' + escapeHtml(q.question) + '</span>' +
              '</div>' +
              optionsHtml +
            '</div>';
          });

          let qHtml = '<div class="permission-card questions-card" id="questions-carousel-card">' +
            '<div class="permission-header">' +
              '<div class="permission-title-row">' +
                '<div class="permission-icon-title">' +
                  '<span class="permission-icon-box question">' +
                    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>' +
                  '</span>' +
                  '<span class="permission-title">Clarifying Questions</span>' +
                '</div>' +
                '<div class="questions-header-right">' +
                  (totalQ > 1 ? '<div class="questions-step-badge" id="q-step-badge">1 of ' + totalQ + '</div>' : '') +
                  '<button class="questions-close-btn" data-action="dismiss-questions" data-question-id="' + escapeHtml(msg.question_id) + '" aria-label="Close without answering" title="Close without answering (Esc)">&times;</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="carousel-slides">' + slidesHtml + '</div>' +
            '<div class="carousel-footer">' +
              '<button class="btn-carousel-prev" id="btn-q-prev" data-action="q-prev" style="visibility:hidden;">Back</button>' +
              '<div style="display:flex; gap:8px;">' +
                (totalQ > 1 ? '<button class="btn-carousel-next" id="btn-q-next" data-action="q-next">Next</button>' : '') +
                '<button class="btn-carousel-submit" id="btn-q-submit" data-action="submit-questions" data-question-id="' + escapeHtml(msg.question_id) + '" data-total-q="' + totalQ + '" style="' + (totalQ > 1 ? 'display:none;' : '') + '">Submit ' + (totalQ > 1 ? 'Answers' : 'Answer') + '</button>' +
              '</div>' +
            '</div>' +
          '</div>';

          interactiveSlot.innerHTML = qHtml;
          break;
        }

        case 'plan_approval':
          rememberInteraction(msg);
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
          addCollabInboxItem({
            sessionId: msg.to_session_id || undefined,
            id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            type: 'message',
            fromSession: msg.from_session,
            fromSessionId: msg.from_session_id,
            toSession: msg.to_session,
            content: msg.content,
            messageType: msg.message_type,
            timestamp: msg.timestamp || new Date().toISOString(),
            unread: true
          });
          break;

        case 'session_question_received':
          addCollabInboxItem({
            sessionId: msg.to_session_id || undefined,
            id: 'q_' + (msg.question_id || Date.now()),
            type: 'question',
            fromSession: msg.from_session,
            fromSessionId: msg.from_session_id,
            toSession: msg.to_session,
            content: msg.question,
            questionId: msg.question_id,
            timestamp: msg.timestamp || new Date().toISOString(),
            unread: true
          });
          break;

        case 'session_answer_received':
          addCollabInboxItem({
            sessionId: msg.to_session_id || undefined,
            id: 'ans_' + (msg.question_id || Date.now()),
            type: 'answer',
            fromSession: msg.from_session,
            fromSessionId: msg.from_session_id,
            toSession: msg.to_session,
            content: msg.answer,
            questionId: msg.question_id,
            timestamp: msg.timestamp || new Date().toISOString(),
            unread: true
          });
          break;

        case 'session_shared_state_changed': {
          if (isOwnCollabEvent(msg.author_session)) break;
          const stateTs = msg.timestamp || new Date().toISOString();
          let stateValue = typeof msg.value === 'string' ? msg.value : JSON.stringify(msg.value);
          if (stateValue && stateValue.length > 200) stateValue = stateValue.slice(0, 199) + '…';
          const tick = String.fromCharCode(96);
          addCollabInboxItem({
            id: 'state_' + (msg.key || '') + '_' + stateTs,
            type: 'message',
            fromSession: msg.author_session,
            content: 'Updated ' + tick + (msg.key || '') + tick + ': ' + (stateValue || ''),
            messageType: 'shared_state',
            timestamp: stateTs,
            unread: true
          });
          break;
        }

        case 'next_step_suggested': {
          receiveNextStep(msg.session_id, msg);
          break;
        }

        case 'background_session_started':
          trackBackgroundRun(msg.parent_session_id, { session_id: msg.child_session_id, title: msg.title, status: 'running' });
          break;

        case 'background_session_finished':
          trackBackgroundRun(msg.parent_session_id, {
            session_id: msg.child_session_id, title: msg.title, status: msg.status || 'finished', summary: msg.summary || '',
          });
          break;

        case 'session_handoff_written': {
          // A handoff sent to one session goes to that session's inbox; a project-wide one
          // goes to the open session unless that session wrote it.
          if (!msg.to_session_id && isOwnCollabEvent(msg.from_session)) break;
          const handoffTs = msg.timestamp || new Date().toISOString();
          const phaseLine = msg.phase ? 'Phase ' + msg.phase + (msg.status ? ' marked ' + msg.status : '') : '';
          addCollabInboxItem({
            sessionId: msg.to_session_id || undefined,
            id: 'handoff_' + (msg.phase || msg.handoff_id || '') + '_' + handoffTs,
            type: 'handoff',
            fromSession: msg.from_session,
            fromSessionId: msg.from_session_id || undefined,
            content: msg.task_summary || msg.summary || phaseLine,
            timestamp: handoffTs,
            unread: true
          });
          break;
        }

        case 'process_started': {
          if (msg.session_id && msg.session_id !== currentSessionId) break;
          const procId = msg.process_id;
          if (procId) {
            activeBgProcesses.set(procId, {
              process_id: procId,
              pid: msg.pid,
              command: msg.command || '',
              startTime: (msg.started ? msg.started * 1000 : Date.now())
            });
            updateBgProcessStripUI();
          }
          break;
        }

        case 'process_exited': {
          if (msg.session_id && msg.session_id !== currentSessionId) break;
          const procId = msg.process_id;
          if (procId) {
            activeBgProcesses.delete(procId);
            updateBgProcessStripUI();
          } else {
            activeBgProcesses.clear();
            updateBgProcessStripUI();
          }
          if (typeof window.handleProcessExitedUI === 'function') {
            window.handleProcessExitedUI(msg);
          }
          break;
        }

        case 'session_nav_result':
          handleSessionNavResult(msg);
          break;

        case 'feedback_result':
          if (feedbackPopover) handleFeedbackResult(msg);
          break;

        case 'retry_result': {
          if (msg.session_id && msg.session_id !== currentSessionId) break;
          document.querySelectorAll('[data-retry-pending="true"]').forEach(card => {
            delete card.dataset.retryPending;
            card.style.opacity = '';
            const button = card.querySelector('.btn-error-retry');
            if (button && (button.dataset.action === 'retry-turn' || button.dataset.action === 'retry-without-image')) {
              button.textContent = button.dataset.action === 'retry-without-image' ? 'Retry without Image' : 'Retry';
            }
          });
          if (!msg.success) appendSystemNote(msg.error || 'Retry could not start. Try again.');
          break;
        }
        case 'input_session':
          currentSessionId = msg.session_id;
          break;
        case 'queue_state': {
          queueSupported = true;
          const previous = serverQueues[msg.session_id];
          if (!previous || msg.epoch !== previous.epoch || msg.revision >= previous.revision) serverQueues[msg.session_id] = msg;
          renderQueue();
          break;
        }
        case 'queue_unavailable':
          if (msg.unsupported) queueSupported = false;
          break;
        case 'input_accepted':
          if (pendingInputDraft && msg.request_id === pendingInputDraft.requestId) {
            if (currentSessionId === pendingInputDraft.sessionId && promptInput.value.trim() === pendingInputDraft.text &&
                JSON.stringify(attachedImages) === JSON.stringify(pendingInputDraft.images) &&
                JSON.stringify(attachedFiles) === JSON.stringify(pendingInputDraft.files)) {
              promptInput.value = '';
              promptInput.style.height = 'auto';
              attachedImages = []; attachedFiles = [];
              renderImageAttachments(); renderAttachedFiles();
              sendBtn.classList.remove('has-text');
            }
            pendingInputDraft = null;
          }
          break;
        case 'input_rejected':
          if (pendingInputDraft && msg.request_id === pendingInputDraft.requestId) pendingInputDraft = null;
          appendSystemNote(msg.error || 'Message was not accepted. Your draft is preserved.');
          break;
        case 'input_applied':
          if (msg.session_id !== currentSessionId || appliedInputIds.has(msg.input_id)) break;
          appliedInputIds.add(msg.input_id);
          endAssistantTurn();
          interactiveSlot.innerHTML = '';
          activePendingApprovalId = null;
          activePendingToolName = '';
          activePendingPlan = false;
          appendUserMessage(msg.prompt, msg.image_uris || [], Date.now(), { skipDedupe: true, steering: true, turnIndex: msg.turn_index });
          startAssistantTurn();
          break;
        case 'init_queue':
          if (queueSupported) { requestQueueSnapshot(); break; }
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
                appendUserMessage(extractMessageText(m.content), m.images || [], m.ts, { skipDedupe: true, steering: Boolean(m.steering) });
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
            setNextStep(msg.session_id, null);
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = true;
            if (msg.session_id !== currentSessionId) {
              sessionsState[msg.session_id].hasUnread = true;
            }
            updateSessionActivityIndicator();
          }
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) break;
          if (msg.input_id && !appliedInputIds.has(msg.input_id)) {
            appliedInputIds.add(msg.input_id);
            hideZeroState();
            appendUserMessage(msg.prompt, msg.image_uris || [], Date.now(), { skipDedupe: true });
            startAssistantTurn();
            break;
          }
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
          if (!msg.skipped && !msg.error && (!msg.session_id || msg.session_id === currentSessionId)) {
            // The pre-compaction size is stale now; show the estimate until the next reply reports the real one.
            contextBreakdown = null;
            updateTokenDisplay({ session_id: currentSessionId, context_tokens: msg.context_estimated ? (msg.context_tokens || 0) : 0, context_estimated: true });
          } else {
            scheduleContextBreakdown();
          }
          break;

        case 'context_breakdown': {
          if (msg.data && msg.session_id && msg.session_id === currentSessionId) {
            contextBreakdown = { sessionId: msg.session_id, data: msg.data };
            renderTokenDisplay();
          }
          break;
        }

        case 'turn_undone': {
          const undoneCount = msg.turnsUndone || 1;
          appendSystemNote(undoneCount > 1
            ? (undoneCount + ' turns undone: file changes rolled back.')
            : 'Last turn undone: file changes rolled back.');
          if (typeof msg.resendPrompt === 'string' && msg.resendPrompt.trim()) {
            const resend = msg.resendPrompt.trim();
            if (sentPromptsHistory[sentPromptsHistory.length - 1] !== resend) sentPromptsHistory.push(resend);
            promptHistoryIndex = sentPromptsHistory.length;
            dispatchPrompt(resend, true, [], 'queue');
          }
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
            sessionLiveBuffer.delete(msg.session_id);
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
          const finishedTurn = finishedTurnFacts(msg);
          endAssistantTurn();
          interactiveSlot.innerHTML = '';
          activePendingApprovalId = null;
          activePendingToolName = '';
          activePendingPlan = false;
          updateScheduledRunNotice(sessionsState[currentSessionId]?.scheduledRun, false);
          updateTokenDisplay({
            token_total: msg.token_total,
            context_tokens: msg.context_tokens,
            cost_usd: msg.cost_usd,
          });
          const pendingPlan = sessionsState[currentSessionId]?.interactions?.plan;
          if (pendingPlan) handleBackendMessage(pendingPlan);
          flushQueue();
          renderNextStep();
          if (finishedTurn) vscode.postMessage(finishedTurn);
          break; }

        case 'feature_tip':
          if (msg.session_id === currentSessionId && !isRunning) renderFeatureTip(msg.tip, msg.file);
          break;

        case 'feedback_checkin':
          startCheckIn(msg);
          break;

        case 'checkin_result':
          finishCheckIn(msg);
          break;

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
          updateScheduledRunNotice(sessionsState[currentSessionId]?.scheduledRun, false);
          appendSystemNote(sessionsState[currentSessionId]?.scheduledRun ? 'Scheduled run stopped.' : 'Turn cancelled by user.');
          if (msg.token_total !== undefined || msg.context_tokens !== undefined) {
            updateTokenDisplay({
              token_total: msg.token_total,
              context_tokens: msg.context_tokens,
              cost_usd: msg.cost_usd,
            });
          }
          break;
        }

        case 'agent_error': {
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            sessionsState[msg.session_id] = sessionsState[msg.session_id] || {};
            sessionsState[msg.session_id].isRunning = false;
            break;
          }
          if (msg.scheduled_busy) { appendSystemNote(msg.error); break; }
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
          appendErrorCard(msg.error || 'Unknown agent error.', undefined, undefined, msg.provider);
          updateScheduledRunNotice(sessionsState[currentSessionId]?.scheduledRun, false);
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
          if (msg.plan?.status !== 'pending') handleBackendMessage({ type: 'interaction_resolved', session_id: msg.session_id, interaction_id: 'plan' });
          if (msg.session_id && currentSessionId && msg.session_id !== currentSessionId) {
            break;
          }
          if (msg.plan && msg.plan.steps && msg.plan.steps.length > 0) {
            updatePlanTracker(msg.plan);
          } else {
            hidePlanTracker();
          }
          // Only show the pill in the chat if a plan tool was explicitly called
          // this turn (not on session restore / disk load which fires outside a turn)
          if (msg.plan && msg.plan.title && planToolCalledInTurn) {
            renderPlanPill(msg.plan);
          }
          break;

        case 'update_pinned_models':
          pinnedModels = msg.pinnedModels || [];
          renderFlyoutList(flyoutSearch ? flyoutSearch.value.toLowerCase().trim() : '');
          break;

        case 'show_onboarding_guide':
          toggleOnboarding(true);
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
              activeSessName.textContent = cleanPromptForDisplay(msg.name);
            }
            const sObj = allSessions.find(s => s.id === (msg.session_id || currentSessionId));
            if (sObj) {
              sObj.name = msg.name;
              if (msg.message_count !== undefined) {
                sObj.message_count = msg.message_count;
                delete sObj.conversation_count;
              }
              if (msg.context_tokens !== undefined) sObj.context_tokens = msg.context_tokens;
              renderHomeRecentSessions(allSessions);
            }
          }
          if (msg.context_tokens !== undefined || msg.token_total !== undefined) {
            if (!msg.session_id || msg.session_id === currentSessionId) {
              updateTokenDisplay(msg);
            }
          }
          if (!msg.session_id || msg.session_id === currentSessionId) {
            updateSessionCollabBadge(msg);
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
    }

    function extractCleanErrorMessage(raw) {
      if (!raw) return '';
      let str = String(raw).trim();
      const firstBrace = str.indexOf('{');
      const lastBrace = str.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
          const parsed = JSON.parse(str.slice(firstBrace, lastBrace + 1));
          if (parsed) {
            if (parsed.error && typeof parsed.error === 'object' && parsed.error.message) {
              return String(parsed.error.message).trim();
            }
            if (parsed.error && typeof parsed.error === 'string') {
              return String(parsed.error).trim();
            }
            if (parsed.message && typeof parsed.message === 'string') {
              return String(parsed.message).trim();
            }
            if (parsed.detail && typeof parsed.detail === 'string') {
              return String(parsed.detail).trim();
            }
          }
        } catch (e) {}
      }
      str = str.replace(/^(?:litellm\.)?[a-zA-Z]*(?:Error|Exception):\s*/gi, '')
               .replace(/^[a-zA-Z]*(?:Error|Exception):\s*/gi, '')
               .replace(/^[a-zA-Z]+Exception\s*[-:]\s*/gi, '')
               .trim();
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        str = (str.slice(0, firstBrace) + str.slice(lastBrace + 1)).trim();
      }
      const uIdIdx = str.toLowerCase().indexOf('"user_id"');
      if (uIdIdx !== -1) str = str.slice(0, uIdIdx).trim();
      str = str.replace(/^[- :]+/, '').trim();
      const firstLine = str.split(String.fromCharCode(10))[0].replace(String.fromCharCode(13), '');
      return (firstLine && firstLine.trim()) || str;
    }

    const iconRetry = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19"/></svg>';
    const iconModel = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>';
    const iconCompact = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';
    const iconPlus = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
    const iconSettings = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83-2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
    const iconAccount = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';

    const iconSignOut = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px;"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>';

    const ERROR_CARD_ACTION_ICONS = {
      'retry-turn': iconRetry,
      'retry-without-image': iconRetry,
      'switch-model-flyout': iconModel,
      'trigger-compact': iconCompact,
      'new-session': iconPlus,
      'open-settings': iconSettings,
      'open-account-login': iconAccount,
      'use-without-sign-in': iconSignOut,
    };

    function errorCardMarkupEnd(text, start) {
      const tag = /<(\\/?)div\\b[^>]*>/gi;
      tag.lastIndex = start;
      let depth = 0;
      let match;
      while ((match = tag.exec(text))) {
        depth += match[1] ? -1 : 1;
        if (depth === 0) return tag.lastIndex;
      }
      return -1;
    }

    function startsLineOutsideFence(text, index) {
      if (index > 0 && text.charAt(index - 1) !== String.fromCharCode(10)) return false;
      const fence = String.fromCharCode(96, 96, 96);
      let inFence = false;
      text.slice(0, index).split(String.fromCharCode(10)).forEach((line) => {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith(fence) || trimmedLine.startsWith('~~~')) inFence = !inFence;
      });
      return !inFence;
    }

    // Reads the card through an inert DOMParser document and keeps only text, inline emphasis,
    // the quota timer, and buttons whose data-action the click handler already supports.
    function errorCardFromMarkup(markup) {
      if (typeof DOMParser === 'undefined') return '';
      const source = new DOMParser().parseFromString(markup, 'text/html').querySelector('.andromity-error-card');
      if (!source) return '';
      const textOf = (selector) => {
        const node = source.querySelector(selector);
        return node ? node.textContent.replace(/\\s+/g, ' ').trim() : '';
      };
      const errorType = (source.getAttribute('data-error-type') || 'generic').replace(/[^a-z_]/gi, '') || 'generic';
      const errorAction = (source.getAttribute('data-error-action') || '').replace(/[^a-z0-9_]/gi, '').slice(0, 64);
      let bodyHtml = '';
      let timerText = '';
      const body = source.querySelector('.error-card-body');
      if (body) {
        body.childNodes.forEach((node) => {
          const nodeText = node.textContent || '';
          if (node.nodeType !== 1) {
            bodyHtml += escapeHtml(nodeText);
          } else if (['STRONG', 'B', 'EM', 'CODE'].includes(node.tagName)) {
            const tagName = node.tagName.toLowerCase();
            bodyHtml += '<' + tagName + '>' + escapeHtml(nodeText) + '</' + tagName + '>';
          } else if (node.tagName === 'BR') {
            bodyHtml += '<br>';
          } else if (node.classList.contains('error-card-timer') || nodeText.trim().startsWith('Quota resets in')) {
            timerText = nodeText.trim();
          } else {
            bodyHtml += escapeHtml(nodeText);
          }
        });
      }
      const timerHtml = timerText
        ? '<br><div style="display:inline-flex;align-items:center;gap:6px;font-size:11px;font-family:var(--font-mono,monospace);color:#10b981;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.22);padding:3px 9px;border-radius:4px;margin-top:8px;">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' +
          escapeHtml(timerText) +
          '</div>'
        : '';
      const seenActions = new Set();
      let actionsHtml = '';
      source.querySelectorAll('.error-card-actions [data-action]').forEach((button) => {
        const action = button.getAttribute('data-action') || '';
        if (!Object.prototype.hasOwnProperty.call(ERROR_CARD_ACTION_ICONS, action) || seenActions.has(action)) return;
        const label = (button.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!label) return;
        actionsHtml += '<button class="' + (seenActions.size === 0 ? 'btn-error-retry' : 'btn-error-secondary') + '" data-action="' + action + '" title="' + escapeHtml(button.getAttribute('title') || label) + '">' +
          ERROR_CARD_ACTION_ICONS[action] + escapeHtml(label) + '</button>';
        seenActions.add(action);
      });
      const detailsNode = source.querySelector('.error-details .error-code');
      const detailsText = detailsNode ? detailsNode.textContent.trim() : '';
      const iconAlert = '<span class="error-header-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg></span>';
      return '<div class="andromity-error-card" data-error-type="' + errorType + '"' +
          (errorAction ? ' data-error-action="' + errorAction + '"' : '') + ' data-retryable="true">' +
          '<div class="error-card-header">' +
            '<div class="error-header-left">' +
              iconAlert +
              '<span class="error-badge">' + escapeHtml(textOf('.error-badge') || 'ERROR') + '</span>' +
              '<span class="error-title">' + escapeHtml(textOf('.error-title') || 'Turn Interrupted') + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="error-card-body">' + bodyHtml.trim() + timerHtml + '</div>' +
          (detailsText
            ? '<details class="error-details">' +
                '<summary>' + escapeHtml(textOf('.error-details summary') || 'Technical Details') + '</summary>' +
                '<pre class="error-code"><code>' + escapeHtml(detailsText) + '</code></pre>' +
              '</details>'
            : '') +
          (actionsHtml ? '<div class="error-card-actions">' + actionsHtml + '</div>' : '') +
        '</div>';
    }

    const ERROR_PROVIDER_NAMES = {
      openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google Gemini', deepseek: 'DeepSeek',
      groq: 'Groq', nvidia: 'NVIDIA NIM', ollama: 'Ollama', lmstudio: 'LM Studio', llamacpp: 'llama.cpp', opencode: 'OpenCode',
    };
    const LOCAL_ERROR_PROVIDERS = ['ollama', 'lmstudio', 'llamacpp'];
    const NETWORK_ERROR_WORDS = [
      'connection error', 'connection refused', 'connection reset', 'connection aborted', 'failed to connect',
      'cannot connect to host', 'could not connect', 'unable to connect', 'actively refused', 'refused the network connection',
      'name or service not known', 'nodename nor servname', 'getaddrinfo', 'name resolution', 'network is unreachable',
      'no route to host', 'broken pipe', 'remote end closed connection', 'server disconnected', 'certificate verify failed',
      'econnrefused', 'econnreset', 'enotfound',
    ];
    const CREDIT_ERROR_WORDS = [
      'insufficient_quota', 'insufficient quota', 'insufficient credit', 'insufficient balance', 'insufficient funds',
      'requires more credits', 'credit balance is too low', 'out of credits', 'payment required',
    ];
    const OUTAGE_ERROR_WORDS = [
      'service unavailable', 'serviceunavailable', 'service_unavailable', 'bad gateway', 'badgateway', 'gateway timeout',
      'overloaded', 'upstream error', 'internal server error', 'temporarily unavailable',
    ];
    const DAILY_LIMIT_WORDS = ['per day', 'per-day', 'perday', 'daily', '(rpd)', '(tpd)'];

    function errorProviderKey(id) {
      return String(id || '').toLowerCase().replace(/[\\s._-]+/g, '');
    }

    function isLoopbackUrl(url) {
      const match = /^[a-z][a-z0-9+.-]*:\\/\\/(?:[^@\\/?#]*@)?(\\[[^\\]]*\\]|[^:\\/?#]*)/i.exec(String(url || '').trim());
      const host = match ? match[1].toLowerCase().replace(/^\\[|\\]$/g, '') : '';
      return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\\.\\d{1,3}){3}$/.test(host);
    }

    function errorProviderInfo(providerId) {
      const id = String(providerId || '').trim().toLowerCase();
      const entry = (allProviders || []).find(p => p && String(p.id || '').toLowerCase() === id) || null;
      let name = 'Andromity Cloud';
      if (id !== 'andromity') {
        name = String((entry && entry.name) || '').trim();
        if (!name || name.toLowerCase() === id) name = ERROR_PROVIDER_NAMES[errorProviderKey(id)] || '';
        name = name.replace(/\\s*\\([^)]*\\)\\s*$/, '').trim();
        if (!name) name = id.split(/[\\s_-]+/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
      }
      return {
        name: (name || 'the provider').slice(0, 48),
        gateway: id === 'andromity',
        local: id !== 'andromity' && (LOCAL_ERROR_PROVIDERS.includes(errorProviderKey(id)) || isLoopbackUrl(entry && entry.base_url)),
      };
    }

    function redactErrorDetails(text) {
      const value = String(text || '')
        .replace(/"user_id"\\s*:\\s*"[^"]+"/gi, '"user_id":"[redacted]"')
        .replace(/andromity_[0-9a-f]{32,}/gi, '[REDACTED Andromity sign-in token]')
        .replace(/(bearer\\s+)[A-Za-z0-9._~+\\/=-]{8,}/gi, '$1[REDACTED]');
      return redactSecrets(value, findSecrets(value));
    }

    function appendErrorCard(text, rawError, errorType, providerId) {
      if (!text) text = 'An unexpected agent error occurred.';
      const trimmed = String(text).trim();
      const wrap = document.createElement('div');

      if (trimmed.includes('andromity-error-card')) {
        const start = trimmed.indexOf(ERROR_CARD_OPEN);
        const end = start === -1 ? -1 : errorCardMarkupEnd(trimmed, start);
        const card = end === -1 ? '' : errorCardFromMarkup(trimmed.slice(start, end));
        if (card) {
          wrap.innerHTML = card;
          chatContainer.appendChild(wrap.firstElementChild || wrap);
          scrollToBottomIfNeeded();
          return;
        }
      }

      const provider = errorProviderInfo(providerId || currentProvider);
      const name = provider.name;
      const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1);
      const cleanMsg = extractCleanErrorMessage(trimmed);
      const low = trimmed.toLowerCase();
      // Status codes as whole numbers: timestamps and IDs in the text often contain "404" or "500".
      const hasCode = (code) => new RegExp('(^|[^0-9])' + code + '([^0-9]|$)').test(low);
      const mentions = (words) => words.some(word => low.includes(word));
      const button = (primary, action, title, icon, label) =>
        '<button class="' + (primary ? 'btn-error-retry' : 'btn-error-secondary') + '" data-action="' + action + '" title="' + title + '">' + icon + label + '</button>';
      const retryButton = (primary) => button(primary, 'retry-turn', 'Retry this turn', iconRetry, 'Retry Turn');
      const switchButton = (primary) => button(primary, 'switch-model-flyout', 'Switch to another model', iconModel, 'Switch Model');
      let badge = 'ERROR';
      let title = 'Turn Interrupted';
      let desc = cleanMsg || trimmed;
      let timerHtml = '';
      let eType = errorType || 'generic';
      let actionsHtml = retryButton(true);

      if (provider.gateway && (low.includes('daily limit') || low.includes('daily_limit') || low.includes('free trial limit') || low.includes('quota limit') || low.includes('quota resets in'))) {
        badge = 'QUOTA LIMIT';
        title = 'Daily Limit Reached';
        const isUserAuthed = isAndromityActive ||
          (typeof localStorage !== 'undefined' && localStorage.getItem('andromity_active_status') === 'true') ||
          low.includes('daily gateway limit');

        desc = isUserAuthed
          ? 'You have reached your daily gateway limit. Add your BYOK key in Settings for unlimited requests, or adjust your quota in the panel.'
          : 'You have reached your daily free trial limit. Sign in with your AgenticMarket account to activate your account, or add a BYOK key in Settings.';

        const timerMatch = text.match(/Quota resets in [^\\r\\n\\)]+\\)/i);
        if (timerMatch) {
          timerHtml = '<br><div style="display:inline-flex;align-items:center;gap:6px;font-size:11px;font-family:var(--font-mono,monospace);color:#10b981;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.22);padding:3px 9px;border-radius:4px;margin-top:8px;">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>' +
            escapeHtml(timerMatch[0]) +
            '</div>';
        }
        eType = 'quota_exceeded';
        if (isUserAuthed) {
          actionsHtml = '<button class="btn-error-retry" data-action="open-settings" title="Configure BYOK">' + iconSettings + 'Open Settings</button>' +
            '<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch to another model">' + iconModel + 'Switch Model</button>';
        } else {
          actionsHtml = '<button class="btn-error-retry" data-action="open-account-login" title="Sign in with AgenticMarket">' + iconAccount + 'Sign In</button>' +
            '<button class="btn-error-secondary" data-action="open-settings" title="Configure BYOK">' + iconSettings + 'Open Settings</button>' +
            '<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch to another model">' + iconModel + 'Switch Model</button>';
        }
      } else if (provider.gateway && (low.includes('authentication token') || low.includes('sign in again'))) {
        badge = 'SIGN IN REQUIRED';
        title = "Your Andromity sign-in isn't valid anymore";
        desc = 'Sign in again, or keep using Andromity without signing in.';
        eType = 'sign_in_invalid';
        actionsHtml = button(true, 'open-account-login', 'Sign in with AgenticMarket again', iconAccount, 'Sign in again') +
          button(false, 'use-without-sign-in', 'Sign out and retry this turn without an account', iconSignOut, 'Use without signing in');
      } else if (mentions(NETWORK_ERROR_WORDS)) {
        if (provider.local) {
          badge = 'OFFLINE';
          title = name === 'Ollama' ? 'Local Ollama Not Running' : name + " isn't running";
          desc = 'Could not connect to ' + name + '. Start the local model server, then retry.';
          eType = 'ollama_offline';
        } else {
          badge = 'CONNECTION';
          title = "Couldn't reach " + name;
          desc = "Couldn't connect to " + name + '. Check your internet connection, VPN or proxy, then retry.';
          eType = 'network_error';
        }
        actionsHtml = retryButton(true) + switchButton(false);
      } else if (low.includes('notfound') || low.includes('not found') || low.includes('no endpoints found') || low.includes('model_not_found') || (hasCode('404') && (low.includes('model') || low.includes('endpoint')))) {
        badge = 'NOT FOUND';
        title = provider.gateway ? 'Model Not Available' : 'Model not found at ' + name;
        desc = (cleanMsg || 'The requested model was not found or has no active endpoints.') + ' Please switch to another model.';
        eType = 'model_not_found';
        actionsHtml = switchButton(true) + retryButton(false);
      } else if (low.includes('image') || low.includes('vision') || low.includes('multimodal') || low.includes('does not support')) {
        badge = 'IMAGE NOT SUPPORTED';
        title = 'Model Does Not Support Images';
        desc = 'The active model does not accept image attachments. Switch to a model that accepts images, or retry with text only.';
        eType = 'vision_unsupported';
        actionsHtml = '<button class="btn-error-retry" data-action="retry-without-image" title="Retry without image">' + iconRetry + 'Retry without Image</button>' +
          '<button class="btn-error-secondary" data-action="switch-model-flyout" title="Switch to a vision model">' + iconModel + 'Switch Model</button>';
      } else if (!provider.gateway && (hasCode('402') || mentions(CREDIT_ERROR_WORDS))) {
        badge = 'CREDITS';
        title = 'Out of credits at ' + name;
        desc = capitalize(name + " says your account doesn't have enough credits for this request. Add credits there, or pick another model.");
        eType = 'insufficient_credits';
        actionsHtml = switchButton(true) + retryButton(false);
      } else if (hasCode('429') || low.includes('rate limit') || low.includes('quota')) {
        badge = 'RATE LIMIT';
        const daily = !provider.gateway && mentions(DAILY_LIMIT_WORDS);
        title = (daily ? 'Daily limit reached at ' : 'Rate limit at ') + name;
        eType = 'rate_limit';
        const reason = (cleanMsg || 'Rate limit or quota threshold reached for the model provider.').trim();
        const sentence = /[.!?]$/.test(reason) ? reason : reason + '.';
        const resetAt = rateLimitResetAt(trimmed, Date.now());
        const waitMs = resetAt === null ? 0 : resetAt - Date.now();
        const longWait = waitMs > 2 * 60 * 1000 || (daily && resetAt === null);
        if (resetAt === null) {
          desc = sentence + (daily
            ? ' Wait for the limit to reset, add credits at ' + name + ', or switch to another model.'
            : ' Please wait a moment and click Retry.');
        } else {
          const at = new Date(resetAt);
          const sameDay = at.toDateString() === new Date().toDateString();
          const clock = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          const when = waitMs < 60 * 1000
            ? 'in under a minute'
            : waitMs < 90 * 60 * 1000
              ? 'in about ' + Math.ceil(waitMs / 60000) + ' min (' + clock + ')'
              : 'at ' + (sameDay ? clock : at.toLocaleDateString([], { weekday: 'short' }) + ' ' + clock);
          desc = sentence + ' The limit resets ' + when + '.' + (longWait ? ' Switch to another model to keep working now.' : ' Retry after that.');
        }
        const retryBtn = '<button class="' + (longWait ? 'btn-error-secondary' : 'btn-error-retry') + '" data-action="retry-turn" title="Retry turn">' + iconRetry + 'Retry Turn</button>';
        const switchBtn = '<button class="' + (longWait ? 'btn-error-retry' : 'btn-error-secondary') + '" data-action="switch-model-flyout" title="Switch model">' + iconModel + 'Switch Model</button>';
        actionsHtml = longWait ? switchBtn + retryBtn : retryBtn + switchBtn;
      } else if (mentions(OUTAGE_ERROR_WORDS)) {
        if (provider.gateway) {
          badge = 'UNAVAILABLE';
          title = 'Andromity Cloud is having trouble right now';
          desc = 'Try again in a moment.';
          eType = 'service_unavailable';
        } else {
          badge = 'SERVICE DISRUPTED';
          title = 'Service disruption at ' + name;
          desc = capitalize(name + ' had a problem on its side. This usually clears up quickly. Retry in a moment, or pick another model.');
          eType = 'provider_unavailable';
        }
        actionsHtml = retryButton(true) + switchButton(false);
      } else if (low.includes('context') || low.includes('token limit') || low.includes('maximum context')) {
        badge = 'CONTEXT LIMIT';
        title = 'Context Window Limit Reached';
        desc = 'This conversation has reached the maximum context length for the current model. Compact context or start a new session.';
        eType = 'context_exceeded';
        actionsHtml = '<button class="btn-error-retry" data-action="trigger-compact" title="Compact context">' + iconCompact + 'Compact Context</button>' +
          '<button class="btn-error-secondary" data-action="new-session" title="New session">' + iconPlus + 'New Session</button>';
      } else if (hasCode('401') || hasCode('403') || low.includes('unauthorized') || low.includes('api key') || low.includes('missing credentials') || low.includes('pass an api_key') || low.includes('no api key')) {
        if (provider.gateway) {
          badge = 'UNAVAILABLE';
          title = "Andromity Cloud couldn't verify this request";
          desc = "This is a problem on Andromity's side, not with your account or API key. Try again later.";
          eType = 'gateway_auth_error';
          actionsHtml = retryButton(true) + button(false, 'open-settings', 'Use your own API key', iconSettings, 'Use Your Own Key');
        } else {
          badge = 'AUTHENTICATION';
          title = 'API key rejected by ' + name;
          desc = capitalize(name + " didn't accept your API key. Check it under API keys in Settings; it may be mistyped, revoked or expired.");
          eType = 'auth_error';
          actionsHtml = button(true, 'open-settings', 'Open API keys in Settings', iconSettings, 'Check API Key') + switchButton(false);
        }
      } else {
        desc = cleanMsg || trimmed;
        actionsHtml = retryButton(true) + switchButton(false);
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
          '<div class="error-card-body">' + escapeHtml(redactErrorDetails(desc)) + timerHtml + '</div>' +
          '<details class="error-details">' +
            '<summary>Technical Details</summary>' +
            '<pre class="error-code"><code>' + escapeHtml(redactErrorDetails(rawError || text)) + '</code></pre>' +
          '</details>' +
          '<div class="error-card-actions">' +
            actionsHtml +
          '</div>' +
        '</div>';

      wrap.innerHTML = cardHtml;
      chatContainer.appendChild(wrap.firstElementChild || wrap);
      scrollToBottomIfNeeded();
    }

    // A scheduled (cron) run's chat says which job ran it and in which mode, and that it
    // cannot take messages until the run ends.
    function updateScheduledRunNotice(info, running) {
      let el = document.getElementById('scheduled-run-notice');
      if (!info) {
        if (el) el.remove();
        return;
      }
      if (!el) {
        const box = document.querySelector('.prompt-box');
        if (!box || !box.parentNode) return;
        el = document.createElement('div');
        el.id = 'scheduled-run-notice';
        el.className = 'scheduled-run-notice';
        el.setAttribute('role', 'status');
        box.parentNode.insertBefore(el, box);
      }
      const mode = String(info.mode || 'safe').toUpperCase();
      const name = info.job_name || 'scheduled job';
      el.textContent = running
        ? 'Scheduled run of ' + name + ' in ' + mode + ' mode. It is still in progress; you can continue the chat when it finishes.'
        : 'Scheduled run of ' + name + ', which ran in ' + mode + ' mode. Messages you send now use your own permission mode.';
      el.classList.toggle('running', !!running);
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
    let activePendingCanRemember = false;
    let activePendingDangerous = false;

    let awaitingApprovalRow = null;

    // The call is parked until the user answers, so its row must not read as running or stuck.
    function markAwaitingApproval(toolName) {
      clearAwaitingApproval();
      if (!toolName) return;
      const rows = Array.from(chatContainer.querySelectorAll('[data-tool-name][data-start-ts]'))
        .filter(el => el.getAttribute('data-tool-name') === toolName);
      const row = rows[rows.length - 1];
      if (!row) return;
      awaitingApprovalRow = row;
      row.classList.add('awaiting-approval');
      row.classList.remove('stuck');
      const action = row.querySelector('.activity-action');
      if (action) { row.dataset.actionText = action.textContent; action.textContent = 'Needs approval'; }
      const tag = row.querySelector('.tool-tag');
      if (tag) { row.dataset.tagText = tag.textContent; tag.textContent = 'APPROVAL'; }
      const elapsed = row.querySelector('.tool-elapsed');
      if (elapsed) elapsed.textContent = '';
      updateToolSeqHeader();
    }

    function clearAwaitingApproval() {
      const row = awaitingApprovalRow;
      awaitingApprovalRow = null;
      if (!row) return;
      row.classList.remove('awaiting-approval');
      const action = row.querySelector('.activity-action');
      if (action && row.dataset.actionText) action.textContent = row.dataset.actionText;
      const tag = row.querySelector('.tool-tag');
      if (tag && row.dataset.tagText) tag.textContent = row.dataset.tagText;
      delete row.dataset.actionText;
      delete row.dataset.tagText;
      if (row.hasAttribute('data-start-ts')) row.setAttribute('data-start-ts', String(Date.now()));
      updateToolSeqHeader();
    }

    function renderPermissionCard(msg) {
      activePendingPlan = false;
      const toolName = msg.tool_name || 'tool';
      const approvalId = msg.approval_id || '';
      activePendingApprovalId = approvalId;
      activePendingToolName = toolName;
      const toolArgs = msg.args || {};

      let actionTitle = 'Approve action';
      let iconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
      let iconClass = 'command';
      let codeDisplay = '';
      let editPreviewHtml = '';
      let subPath = '';
      let risks = [];
      let rememberNote = '';

      const lowerTool = toolName.toLowerCase();
      let canRemember = /^(shell_exec|shell_bg|fetch_url)$/.test(lowerTool);
      if (lowerTool === 'shell_exec' || lowerTool === 'shell_bg' || lowerTool === 'run_command' || lowerTool === 'bash' || lowerTool === 'exec' || lowerTool === 'cmd') {
        actionTitle = 'Run command';
        iconClass = 'command';
        iconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>';
        const cmd = String(toolArgs.command || toolArgs.cmd || toolArgs.CommandLine || '');
        const isWin = typeof navigator !== 'undefined' && ((navigator.platform && navigator.platform.indexOf('Win') > -1) || (navigator.userAgent && /win/i.test(navigator.userAgent)));
        const shellName = isWin ? 'powershell' : 'bash';
        codeDisplay = (shellName + ': ' + cmd).trim();
        subPath = cmd;
        risks = describeCommandRisks(cmd);
        if (canRemember) {
          if (risks.some(r => r.level === 'danger')) {
            canRemember = false;
            rememberNote = 'Commands with this kind of risk are approved one run at a time.';
          } else if (!canRememberCommand(cmd)) {
            canRemember = false;
            rememberNote = 'Commands that use shell operators such as &&, | or $( ) are approved one run at a time.';
          }
        }
      } else if (/^(edit_file|edit_file_multi|write_file|write_to_file|replace_file_content|multi_replace_file_content|create_file)$/.test(lowerTool)) {
        const isWholeFileWrite = lowerTool === 'write_file' || lowerTool === 'write_to_file' || lowerTool === 'create_file';
        actionTitle = isWholeFileWrite ? 'Write file' : 'Edit file';
        iconClass = 'file';
        iconSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
        const filePath = toolArgs.path || toolArgs.file || toolArgs.TargetFile || '';
        const preview = typeof window.renderEditApprovalPreview === 'function' ? window.renderEditApprovalPreview(toolName, toolArgs) : null;
        codeDisplay = 'file: ' + filePath;
        if (preview) {
          codeDisplay += '  (+' + preview.additions + ' -' + preview.deletions +
            (preview.editCount > 1 ? ', ' + preview.editCount + ' edits' : '') + ')';
          if (isWholeFileWrite) codeDisplay += '\\nCreates the file or replaces its entire content.';
          editPreviewHtml = preview.html;
        }
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
        try { subPath = new URL(toolArgs.url || '').hostname; } catch { subPath = toolArgs.url || ''; }
        risks = describeUrlRisks(String(toolArgs.url || toolArgs.Url || ''));
        if (canRemember && risks.some(r => r.level === 'danger')) {
          canRemember = false;
          rememberNote = 'Addresses with this kind of risk are approved one fetch at a time.';
        }
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

      activePendingCanRemember = canRemember;
      activePendingDangerous = risks.some(r => r.level === 'danger');
      const riskHtml = risks.length
        ? '<ul class="permission-risks" aria-label="Things to check before allowing">' +
            risks.map(r => '<li class="permission-risk risk-' + escapeHtml(r.level) + '">' + escapeHtml(r.label) + '</li>').join('') +
          '</ul>'
        : '';

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
          riskHtml +
          editPreviewHtml +
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

          '<div class="permission-option-row" data-action="approve-tool-session" data-approval-id="' + escapeHtml(approvalId) + '" data-tool="' + escapeHtml(toolName) + '" tabindex="0" role="button"' + (canRemember ? '' : ' style="display:none;"') + '>' +
            '<div class="option-row-main">' +
              '<div class="option-row-title">Allow for remainder of this session</div>' +
              '<div class="option-row-sub">' + (lowerTool === 'fetch_url' ? 'domain: ' : 'command: ') + escapeHtml(subPath) + '</div>' +
            '</div>' +
            '<div class="option-row-badge">' +
              '<kbd class="perm-kbd">Ctrl</kbd> <kbd class="perm-kbd">Alt</kbd> <kbd class="perm-kbd">Y</kbd>' +
            '</div>' +
          '</div>' +

          '<div class="permission-option-row" data-action="approve-tool-always" data-approval-id="' + escapeHtml(approvalId) + '" data-tool="' + escapeHtml(toolName) + '" tabindex="0" role="button"' + (canRemember ? '' : ' style="display:none;"') + '>' +
            '<div class="option-row-main">' +
              '<div class="option-row-title">Always allow</div>' +
              '<div class="option-row-sub">' + (lowerTool === 'fetch_url' ? 'domain: ' : 'command: ') + escapeHtml(subPath) + '</div>' +
            '</div>' +
            '<div class="option-row-badge">' +
              '<kbd class="perm-kbd">Ctrl</kbd> <kbd class="perm-kbd">Shift</kbd> <kbd class="perm-kbd">Y</kbd>' +
            '</div>' +
          '</div>' +
          (rememberNote ? '<div class="permission-remember-note">' + escapeHtml(rememberNote) + '</div>' : '') +

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

    function isShownElement(el) {
      return !!el && !el.hidden && window.getComputedStyle(el).display !== 'none';
    }

    function hasOpenOverlay() {
      const lightbox = document.getElementById('image-lightbox-overlay');
      if (lightbox && lightbox.classList.contains('open')) return true;
      return ['reasoning-popover', 'collab-inbox-popover', 'mode-popover', 'profile-popover', 'slash-palette', 'mention-palette', 'sp-menu']
        .some(function(id) { return isShownElement(document.getElementById(id)); });
    }

    // A focused control owns Enter/Space; the card-level shortcuts must not
    // override it (Enter on a focused "Deny" row denies, it does not approve).
    function focusedControl(e) {
      const t = e.target;
      if (!t || t === document.body || typeof t.closest !== 'function') return null;
      return t.closest('button, a[href], select, summary, [role="button"], [role="option"], [role="menuitem"], [role="checkbox"], [role="radio"]');
    }

    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape' && hasOpenOverlay()) return;
      const control = (e.key === 'Enter' || e.key === ' ') ? focusedControl(e) : null;
      if (control) {
        if (control.tagName !== 'BUTTON' && control.tagName !== 'A' && control.tagName !== 'SELECT' && control.tagName !== 'SUMMARY' && control.getAttribute('role') === 'button') {
          e.preventDefault();
          control.click();
        }
        return;
      }
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

      // ── Questions Card Keyboard Handling ──
      const questionsCard = document.getElementById('questions-carousel-card');
      if (questionsCard) {
        if (e.key === 'Escape') {
          e.preventDefault();
          const closeBtn = questionsCard.querySelector('[data-action="dismiss-questions"]');
          window.dismissQuestions(closeBtn ? closeBtn.getAttribute('data-question-id') || '' : '');
          return;
        }
        if (!isInput && e.key >= '1' && e.key <= '9') {
          const optIdx = parseInt(e.key, 10) - 1;
          const currSlide = document.getElementById('q-slide-' + (window.currentQuestionSlide || 0));
          if (currSlide) {
            const row = currSlide.querySelector('.question-option-row[data-opt-idx="' + optIdx + '"]');
            if (row) {
              const inp = row.querySelector('input');
              if (inp) {
                if (inp.type === 'checkbox') {
                  inp.checked = !inp.checked;
                } else {
                  inp.checked = true;
                }
                inp.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
          }
          return;
        }

        if (!isInput && e.key === 'Enter') {
          e.preventDefault();
          const btnNext = document.getElementById('btn-q-next');
          const btnSubmit = document.getElementById('btn-q-submit');
          if (btnNext && btnNext.style.display !== 'none' && window.getComputedStyle(btnNext).display !== 'none') {
            btnNext.click();
          } else if (btnSubmit) {
            btnSubmit.click();
          }
          return;
        }
      }

      if (!activePendingApprovalId) return;
      const isToolInput = isInput;

      // 1. Allow Once: Ctrl+Y, or Enter (when not inside input, and never for a destructive command)
      if ((e.ctrlKey && (e.key === 'y' || e.key === 'Y') && !e.altKey && !e.shiftKey) || (!isToolInput && e.key === 'Enter' && !activePendingDangerous)) {
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
      if (scope && scope !== 'once' && (!activePendingCanRemember || !/^(shell_exec|shell_bg|fetch_url)$/.test(toolName || activePendingToolName))) return;
      if (interactiveSlot.dataset.submitting) return;
      interactiveSlot.dataset.submitting = 'true';
      interactiveSlot.querySelectorAll('button').forEach(button => { button.disabled = true; });
      vscode.postMessage({ type: 'approve_tool', approvalId, scope: scope || 'once', toolName });
    };

    window.rejectTool = function(approvalId) {
      if (interactiveSlot.dataset.submitting) return;
      interactiveSlot.dataset.submitting = 'true';
      interactiveSlot.querySelectorAll('button').forEach(button => { button.disabled = true; });
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
      if (interactiveSlot.dataset.submitting) return;
      interactiveSlot.dataset.submitting = 'true';
      const lines = [];
      for (let i = 0; i < totalQ; i++) {
        const vals = Array.from(document.querySelectorAll('input[name="q_' + i + '"]:checked')).map(c => c.value);
        const other = document.getElementById('q_other_' + i);
        const otherText = other ? other.value.trim() : '';
        // Typed text replaces a single choice and joins a multiple choice.
        if (otherText) {
          if (other.getAttribute('data-q-multi')) vals.push(otherText);
          else vals.splice(0, vals.length, otherText);
        }
        const textIn = document.getElementById('q_input_' + i);
        const answer = vals.length ? vals.join(', ') : (textIn ? textIn.value.trim() : '');
        if (!answer) continue;
        const promptEl = document.querySelector('#q-slide-' + i + ' .question-prompt-text');
        lines.push((i + 1) + '. ' + (promptEl ? promptEl.textContent.trim() : 'Question ' + (i + 1)) + ': ' + answer);
      }
      interactiveSlot.querySelectorAll('button, input, textarea').forEach(control => { control.disabled = true; });
      vscode.postMessage({
        type: 'answer_question', questionId,
        answers: lines.length ? 'User answers:' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) : '',
        dismissed: lines.length === 0,
      });
    };

    window.dismissQuestions = function(questionId) {
      if (interactiveSlot.dataset.submitting) return;
      interactiveSlot.dataset.submitting = 'true';
      interactiveSlot.querySelectorAll('button, input, textarea').forEach(control => { control.disabled = true; });
      vscode.postMessage({ type: 'answer_question', questionId, answers: '', dismissed: true });
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
        if (collabInboxPopover && collabInboxPopover.style.display !== 'none') {
          collabInboxPopover.style.display = 'none';
        }
        if (reasoningPopover && reasoningPopover.style.display !== 'none') {
          reasoningPopover.style.display = 'none';
          const btnReasoningEl = document.getElementById('btn-prompt-reasoning');
          if (btnReasoningEl) {
            btnReasoningEl.setAttribute('aria-expanded', 'false');
            btnReasoningEl.classList.remove('active');
          }
        }
        if (modePopover && modePopover.style.display !== 'none') {
          modePopover.style.display = 'none';
          btnPromptMode?.setAttribute('aria-expanded', 'false');
          btnPromptMode?.classList.remove('active');
        }
        const profPopover = document.getElementById('profile-popover');
        if (profPopover && profPopover.style.display !== 'none') {
          profPopover.style.display = 'none';
          const btnProf = document.getElementById('btn-prompt-profile');
          if (btnProf) {
            btnProf.setAttribute('aria-expanded', 'false');
            btnProf.classList.remove('active');
          }
        }
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
      clearAwaitingApproval();
      scheduleFocus();
    };

    setInterval(function() {
      document.querySelectorAll('[data-start-ts]:not(.awaiting-approval)').forEach(function(el) {
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
    updateModeBadge(${scriptJson(state.currentMode || 'safe')});
    vscode.postMessage({ type: 'ready' });
    // Also request host to transfer focus into webview (required on first show)
    setTimeout(() => focusPrompt(), 100);
`;
}
