/**
 * chatActivityRow.ts
 * Implements Antigravity-style activity rows for tool calls (file edits, command executions)
 * in the Andromity VS Code extension webview.
 *
 * Adheres strictly to THEME_GUIDELINES.md:
 * - Information-dense, distraction-free
 * - Full support for live streaming (running -> done transition) and historical reload
 * - Clean event delegation for open_file and open_file_diff
 */

export interface ParsedFileEditStats {
  filePath: string;
  filename: string;
  additions: number;
  deletions: number;
  badgeText: string;
  badgeClass: string;
}

/**
 * Pure helper to calculate additions and deletions from tool execution arguments.
 */
export function parseFileEditStats(toolName: string, args: Record<string, any> | string): ParsedFileEditStats | null {
  const lowerTool = (toolName || "").toLowerCase();
  let parsedArgs: Record<string, any> = {};

  if (typeof args === "string") {
    try {
      parsedArgs = JSON.parse(args);
    } catch {
      parsedArgs = {};
    }
  } else if (args && typeof args === "object") {
    parsedArgs = args;
  }

  const isWriteTool = /^(write_file|write_to_file|edit_file|edit_file_multi|multi_replace_file_content|replace_file_content|patch_file|create_file)$/.test(lowerTool);
  if (!isWriteTool) {
    return null;
  }

  const filePath = parsedArgs.TargetFile || parsedArgs.path || parsedArgs.file || parsedArgs.target_file || parsedArgs.filePath || "";
  const normalizedKey = filePath.split("\\").join("/");
  const filename = normalizedKey.split("/").pop() || filePath || "file";

  // Determine badge text and class based on file extension
  const extMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : "";
  let badgeText = ext ? ext.toUpperCase().slice(0, 4) : "FILE";
  let badgeClass = "badge-generic";

  if (ext === "ts" || ext === "tsx") {
    badgeText = ext.toUpperCase();
    badgeClass = "badge-ts";
  } else if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") {
    badgeText = ext.toUpperCase();
    badgeClass = "badge-js";
  } else if (ext === "py") {
    badgeText = "PY";
    badgeClass = "badge-py";
  } else if (ext === "json") {
    badgeText = "JSON";
    badgeClass = "badge-json";
  } else if (ext === "md" || ext === "markdown") {
    badgeText = "MD";
    badgeClass = "badge-md";
  } else if (ext === "css" || ext === "scss" || ext === "less") {
    badgeText = ext.toUpperCase();
    badgeClass = "badge-css";
  } else if (ext === "html" || ext === "htm") {
    badgeText = "HTML";
    badgeClass = "badge-html";
  } else if (ext === "rs") {
    badgeText = "RS";
    badgeClass = "badge-rs";
  } else if (ext === "go") {
    badgeText = "GO";
    badgeClass = "badge-go";
  } else if (ext === "sh" || ext === "bash" || ext === "zsh") {
    badgeText = "SH";
    badgeClass = "badge-sh";
  }

  let additions = 0;
  let deletions = 0;

  const countLines = (str: any): number => {
    if (typeof str !== "string" || !str) return 0;
    return str.split(/\r?\n/).length;
  };

  if (lowerTool === "replace_file_content") {
    deletions = countLines(parsedArgs.TargetContent);
    additions = countLines(parsedArgs.ReplacementContent);
  } else if (lowerTool === "multi_replace_file_content") {
    const chunks = parsedArgs.ReplacementChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) {
        if (c) {
          deletions += countLines(c.TargetContent);
          additions += countLines(c.ReplacementContent);
        }
      }
    }
  } else if (lowerTool === "edit_file_multi" || Array.isArray(parsedArgs.edits)) {
    const edits = parsedArgs.edits;
    if (Array.isArray(edits)) {
      for (const e of edits) {
        if (e) {
          deletions += countLines(e.old_str || e.old_string || e.target_content || e.TargetContent);
          additions += countLines(e.new_str || e.new_string || e.replacement_content || e.ReplacementContent);
        }
      }
    }
  } else if (lowerTool === "write_to_file" || lowerTool === "write_file" || lowerTool === "create_file") {
    const content = parsedArgs.CodeContent || parsedArgs.content || parsedArgs.text || "";
    additions = countLines(content);
    deletions = 0;
  } else if (lowerTool === "edit_file" || lowerTool === "patch_file") {
    if (parsedArgs.old_str || parsedArgs.target_content) {
      deletions = countLines(parsedArgs.old_str || parsedArgs.target_content);
    }
    if (parsedArgs.new_str || parsedArgs.replacement_content) {
      additions = countLines(parsedArgs.new_str || parsedArgs.replacement_content);
    }
    if (additions === 0 && deletions === 0 && parsedArgs.diff) {
      const diffLines = String(parsedArgs.diff).split(/\r?\n/);
      for (const l of diffLines) {
        if (l.startsWith("+") && !l.startsWith("+++")) additions++;
        if (l.startsWith("-") && !l.startsWith("---")) deletions++;
      }
    }
  }

  return {
    filePath,
    filename,
    additions,
    deletions,
    badgeText,
    badgeClass,
  };
}

/**
 * Returns the client-side JavaScript that injects Antigravity-style activity rows
 * and registers click handlers for opening files and diffs.
 */
export function getChatActivityScript(): string {
  return `
    // ─── Antigravity Activity Row Helpers ─────────────────────────────────────
    (function() {
      function escapeHtml(str) {
        if (typeof str !== 'string') return '';
        return str
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }

      function postToVsCode(msg) {
        var api = window.__vscodeApi || (typeof vscode !== 'undefined' ? vscode : null);
        if (api && typeof api.postMessage === 'function') {
          api.postMessage(msg);
        }
      }

      window.parseFileEditStats = function(toolName, args) {
        var lowerTool = (toolName || '').toLowerCase();
        var parsedArgs = {};
        if (typeof args === 'string') {
          try { parsedArgs = JSON.parse(args); } catch(e) { parsedArgs = {}; }
        } else if (args && typeof args === 'object') {
          parsedArgs = args;
        }

        var isWrite = /^(write_file|write_to_file|edit_file|edit_file_multi|multi_replace_file_content|replace_file_content|patch_file|create_file)$/.test(lowerTool);
        if (!isWrite) return null;

        var filePath = parsedArgs.TargetFile || parsedArgs.path || parsedArgs.file || parsedArgs.target_file || parsedArgs.filePath || '';
        var normalizedKey = filePath.replace(/\\\\/g, '/');
        var filename = normalizedKey.split('/').pop() || filePath || 'file';

        var extMatch = filename.match(/\\.([a-zA-Z0-9]+)$/);
        var ext = extMatch ? extMatch[1].toLowerCase() : '';
        var badgeText = ext ? ext.toUpperCase().slice(0, 4) : 'FILE';
        var badgeClass = 'badge-generic';

        if (ext === 'ts' || ext === 'tsx') { badgeText = ext.toUpperCase(); badgeClass = 'badge-ts'; }
        else if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') { badgeText = ext.toUpperCase(); badgeClass = 'badge-js'; }
        else if (ext === 'py') { badgeText = 'PY'; badgeClass = 'badge-py'; }
        else if (ext === 'json') { badgeText = 'JSON'; badgeClass = 'badge-json'; }
        else if (ext === 'md' || ext === 'markdown') { badgeText = 'MD'; badgeClass = 'badge-md'; }
        else if (ext === 'css' || ext === 'scss' || ext === 'less') { badgeText = ext.toUpperCase(); badgeClass = 'badge-css'; }
        else if (ext === 'html' || ext === 'htm') { badgeText = 'HTML'; badgeClass = 'badge-html'; }
        else if (ext === 'rs') { badgeText = 'RS'; badgeClass = 'badge-rs'; }
        else if (ext === 'go') { badgeText = 'GO'; badgeClass = 'badge-go'; }
        else if (ext === 'sh' || ext === 'bash' || ext === 'zsh') { badgeText = 'SH'; badgeClass = 'badge-sh'; }

        function countL(str) {
          if (typeof str !== 'string' || !str) return 0;
          return str.split(/\\r?\\n/).length;
        }

        var additions = 0;
        var deletions = 0;

        if (lowerTool === 'replace_file_content') {
          deletions = countL(parsedArgs.TargetContent);
          additions = countL(parsedArgs.ReplacementContent);
        } else if (lowerTool === 'multi_replace_file_content') {
          var chunks = parsedArgs.ReplacementChunks;
          if (Array.isArray(chunks)) {
            for (var i = 0; i < chunks.length; i++) {
              if (chunks[i]) {
                deletions += countL(chunks[i].TargetContent);
                additions += countL(chunks[i].ReplacementContent);
              }
            }
          }
        } else if (lowerTool === 'edit_file_multi' || Array.isArray(parsedArgs.edits)) {
          var edits = parsedArgs.edits;
          if (Array.isArray(edits)) {
            for (var i = 0; i < edits.length; i++) {
              if (edits[i]) {
                deletions += countL(edits[i].old_str || edits[i].old_string || edits[i].target_content || edits[i].TargetContent);
                additions += countL(edits[i].new_str || edits[i].new_string || edits[i].replacement_content || edits[i].ReplacementContent);
              }
            }
          }
        } else if (lowerTool === 'write_to_file' || lowerTool === 'write_file' || lowerTool === 'create_file') {
          var content = parsedArgs.CodeContent || parsedArgs.content || parsedArgs.text || '';
          additions = countL(content);
          deletions = 0;
        } else if (lowerTool === 'edit_file' || lowerTool === 'patch_file') {
          if (parsedArgs.old_str || parsedArgs.target_content) deletions = countL(parsedArgs.old_str || parsedArgs.target_content);
          if (parsedArgs.new_str || parsedArgs.replacement_content) additions = countL(parsedArgs.new_str || parsedArgs.replacement_content);
        }

        return {
          filePath: filePath,
          filename: filename,
          additions: additions,
          deletions: deletions,
          badgeText: badgeText,
          badgeClass: badgeClass
        };
      };

      // File tools report failure in their result text ("Error: ...") while the
      // tool call itself still completes, so success alone cannot be trusted.
      window.classifyFileEditResult = function(result, success) {
        if (success === false) return 'error';
        var text = typeof result === 'string' ? result.trim() : '';
        if (/^Error\\b/.test(text)) return 'error';
        if (/^Applied \\d+ edits successfully, but \\d+ edits failed/.test(text)) return 'partial';
        return 'done';
      };

      window.renderAntigravityActivityRow = function(toolName, toolArgs, status) {
        var stat = window.parseFileEditStats(toolName, toolArgs);
        if (!stat) return null;

        var isRunning = status === 'running';
        var isFailed = status === 'error';
        var safeFile = escapeHtml(stat.filename);
        var safePath = escapeHtml(stat.filePath);
        var safeBadge = escapeHtml(stat.badgeText);
        var badgeCls = escapeHtml(stat.badgeClass);
        var actionLabel = isRunning ? 'Editing' : (isFailed ? 'Edit failed' : (status === 'partial' ? 'Partly edited' : 'Edited'));

        var statsHtml = '';
        if (isFailed) {
          statsHtml = '';
        } else if (isRunning) {
          statsHtml = '<span class="activity-running-dot" title="Editing file..."></span>';
        } else {
          if (stat.additions > 0 || stat.deletions > 0) {
            statsHtml = '<span class="activity-stats" data-action="open-review-tab" data-file-path="' + safePath + '" title="Review diff for ' + safeFile + '">' +
              (stat.additions > 0 ? ('<span class="activity-stat-add">+' + stat.additions + '</span>') : '') +
              (stat.deletions > 0 ? ('<span class="activity-stat-del">-' + stat.deletions + '</span>') : '') +
            '</span>';
          } else {
            statsHtml = '<span class="activity-stats" data-action="open-review-tab" data-file-path="' + safePath + '" title="Review diff for ' + safeFile + '"><span class="activity-stat-add">+0</span> <span class="activity-stat-del">-0</span></span>';
          }
        }

        var diffIconSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M16 3h5v5"></path><path d="M4 20L21 3"></path><path d="M21 16v5h-5"></path><path d="M15 15l6 6"></path><path d="M4 4l5 5"></path></svg>';

        var row = document.createElement('div');
        row.className = 'activity-row activity-row-file activity-row-clickable' + (isRunning ? ' running' : '') + (isFailed ? ' activity-row-failed' : '');
        row.setAttribute('data-action', 'open-file');
        row.setAttribute('data-file-path', stat.filePath);
        row.setAttribute('title', (isFailed ? 'Edit failed. ' : '') + 'Click to open ' + safePath + ' in editor');

        row.innerHTML = '<span class="activity-action">' + actionLabel + '</span>' +
          '<span class="activity-badge ' + badgeCls + '">' + safeBadge + '</span>' +
          '<span class="activity-filename" title="' + safePath + '">' + safeFile + '</span>' +
          statsHtml +
          (!isRunning && !isFailed ? (
            '<button class="activity-diff-btn" data-action="open-review-tab" data-file-path="' + safePath + '" title="Review diff for ' + safeFile + '">' +
              diffIconSvg +
            '</button>'
          ) : '');

        return row;
      };

      // Compact, height-capped preview of what a write/edit approval will change,
      // so SAFE-mode users see the content they are approving without large
      // edits taking over the chat. Returns null for non-file tools.
      window.renderEditApprovalPreview = function(toolName, toolArgs) {
        var MAX_LINES = 200;
        var MAX_LINE_CHARS = 400;
        var lowerTool = (toolName || '').toLowerCase();
        var parsedArgs = {};
        if (typeof toolArgs === 'string') {
          try { parsedArgs = JSON.parse(toolArgs); } catch(e) { parsedArgs = {}; }
        } else if (toolArgs && typeof toolArgs === 'object') {
          parsedArgs = toolArgs;
        }

        var hunks = [];
        if (lowerTool === 'write_file') {
          hunks.push({ del: '', add: parsedArgs.content });
        } else if (lowerTool === 'edit_file') {
          hunks.push({ del: parsedArgs.old_str, add: parsedArgs.new_str });
        } else if (lowerTool === 'edit_file_multi') {
          var edits = Array.isArray(parsedArgs.edits) ? parsedArgs.edits : [];
          for (var i = 0; i < edits.length; i++) {
            if (edits[i]) hunks.push({ del: edits[i].old_str, add: edits[i].new_str });
          }
        } else {
          return null;
        }

        function splitLines(str) {
          if (typeof str !== 'string' || !str) return [];
          var parts = str.split(/\\r?\\n/);
          if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
          return parts;
        }

        var lines = [];
        var additions = 0;
        var deletions = 0;
        for (var h = 0; h < hunks.length; h++) {
          if (hunks.length > 1) lines.push({ cls: 'hunk', text: '@@ edit ' + (h + 1) + ' of ' + hunks.length + ' @@' });
          var delLines = splitLines(hunks[h].del);
          var addLines = splitLines(hunks[h].add);
          deletions += delLines.length;
          additions += addLines.length;
          for (var d = 0; d < delLines.length; d++) lines.push({ cls: 'del', text: '- ' + delLines[d] });
          for (var a = 0; a < addLines.length; a++) lines.push({ cls: 'add', text: '+ ' + addLines[a] });
        }

        var html = '';
        var shown = Math.min(lines.length, MAX_LINES);
        for (var k = 0; k < shown; k++) {
          var text = lines[k].text;
          if (text.length > MAX_LINE_CHARS) text = text.slice(0, MAX_LINE_CHARS) + ' …';
          html += '<div class="perm-diff-line perm-diff-' + lines[k].cls + '">' + escapeHtml(text) + '</div>';
        }
        if (lines.length > MAX_LINES) {
          html += '<div class="perm-diff-more">' + (lines.length - MAX_LINES) + ' more lines not shown. Open "View full parameters" for the complete change.</div>';
        }
        if (!html) {
          html = '<div class="perm-diff-line perm-diff-hunk">(empty content)</div>';
        }

        return {
          html: '<div class="permission-diff-box"><div class="perm-diff-lines">' + html + '</div></div>',
          additions: additions,
          deletions: deletions,
          editCount: hunks.length
        };
      };

      window.renderCommandActivityRow = function(toolName, toolArgs, status, toolResult) {
        var parsedArgs = {};
        if (typeof toolArgs === 'string') {
          try { parsedArgs = JSON.parse(toolArgs); } catch(e) { parsedArgs = {}; }
        } else if (toolArgs && typeof toolArgs === 'object') {
          parsedArgs = toolArgs;
        }

        var cmd = parsedArgs.CommandLine || parsedArgs.command || parsedArgs.cmd || '';
        if (!cmd) return null;

        var isRunning = status === 'running';
        var wrap = document.createElement('div');
        wrap.className = 'activity-cmd-wrap';

        var row = document.createElement('div');
        row.className = 'activity-row activity-row-command activity-row-clickable' + (isRunning ? ' running' : '');
        row.setAttribute('data-action', 'toggle-cmd-output');

        var safeCmd = escapeHtml(cmd);
        row.innerHTML = '<span class="activity-action">' + (isRunning ? 'Running' : 'Ran') + '</span>' +
          '<span class="activity-cmd-text" title="' + safeCmd + '">' + safeCmd + '</span>' +
          (isRunning ? '<span class="activity-running-dot" title="Running command..."></span>' : '<span class="activity-chevron">&#x203A;</span>');

        wrap.appendChild(row);

        if (!isRunning) {
          var outputText = '';
          if (typeof toolResult === 'string' && toolResult.trim()) {
            outputText = toolResult.trim();
          }
          var outputBox = document.createElement('div');
          outputBox.className = 'activity-cmd-output';
          outputBox.style.display = 'none';
          outputBox.textContent = outputText || '(No output)';
          wrap.appendChild(outputBox);
        }

        return wrap;
      };

      window.renderBackgroundProcessActivityRow = function(toolName, toolArgs, status, toolResult, processId) {
        var parsedArgs = {};
        if (typeof toolArgs === 'string') {
          try { parsedArgs = JSON.parse(toolArgs); } catch(e) { parsedArgs = {}; }
        } else if (toolArgs && typeof toolArgs === 'object') {
          parsedArgs = toolArgs;
        }

        var cmd = parsedArgs.CommandLine || parsedArgs.command || parsedArgs.cmd || '';
        var procId = processId || parsedArgs.process_id || '';
        if (!procId && typeof toolResult === 'string') {
          var m = toolResult.match(/with id '([^']+)'/);
          if (m) procId = m[1];
        }

        var isRunning = (status === 'running' || status === 'running_bg');
        var wrap = document.createElement('div');
        wrap.className = 'activity-cmd-wrap bg-proc-wrap';
        if (procId) wrap.setAttribute('data-process-id', procId);

        var row = document.createElement('div');
        row.className = 'activity-row activity-row-command activity-row-clickable bg-proc-row' + (isRunning ? ' running' : '');
        row.setAttribute('data-action', 'toggle-cmd-output');

        var safeCmd = escapeHtml(cmd || 'background command');
        var safeProcId = escapeHtml(procId || 'bg');

        var stopBtnHtml = (isRunning && procId) ?
          '<button class="bg-proc-stop-btn" data-process-id="' + safeProcId + '" title="Stop background process">' +
            '<span class="codicon codicon-debug-stop"></span> Stop' +
          '</button>' : '';

        var tagHtml = isRunning ?
          '<span class="bg-proc-badge running"><span class="activity-running-dot"></span> RUNNING (BG)</span>' :
          ('<span class="bg-proc-badge ' + (status === 'error' ? 'stopped' : (status === 'stopped' ? 'stopped' : 'done')) + '">' +
            (status === 'error' ? 'FAILED' : (status === 'stopped' ? 'STOPPED' : 'DONE')) +
          '</span>');

        row.innerHTML =
          '<span class="activity-action" style="color:var(--accent,#58a6ff); font-weight:600;">BG</span>' +
          '<span class="activity-cmd-text" title="' + safeCmd + ' (' + safeProcId + ')">' + safeCmd + '</span>' +
          '<div style="display:flex; align-items:center; gap:6px; margin-left:auto;">' +
            tagHtml +
            stopBtnHtml +
            '<span class="activity-chevron">&#x203A;</span>' +
          '</div>';

        wrap.appendChild(row);

        var outputText = '';
        if (typeof toolResult === 'string' && toolResult.trim()) {
          outputText = toolResult.trim();
        }
        var outputBox = document.createElement('div');
        outputBox.className = 'activity-cmd-output';
        outputBox.style.display = 'none';
        outputBox.textContent = outputText || '(Background process started)';
        wrap.appendChild(outputBox);

        return wrap;
      };

      window.handleProcessExitedUI = function(msg) {
        var procId = msg.process_id;
        var wraps = procId ? document.querySelectorAll('[data-process-id="' + procId + '"]') : [];
        if (!wraps || wraps.length === 0) {
          wraps = document.querySelectorAll('.bg-proc-wrap:has(.bg-proc-badge.running), .bg-proc-wrap.running');
        }
        wraps.forEach(function(wrap) {
          var badge = wrap.querySelector('.bg-proc-badge');
          if (badge) {
            badge.className = 'bg-proc-badge ' + (msg.exit_code === 0 ? 'done' : 'stopped');
            badge.textContent = msg.exit_code === 0 ? 'DONE (BG)' : ('STOPPED (' + (msg.exit_code !== undefined ? msg.exit_code : '') + ')');
          }
          var stopBtn = wrap.querySelector('.bg-proc-stop-btn');
          if (stopBtn) {
            stopBtn.remove();
          }
          var row = wrap.querySelector('.bg-proc-row') || wrap;
          row.classList.remove('running');
          var out = wrap.querySelector('.activity-cmd-output');
          if (out) {
            var dur = typeof msg.duration === 'number' ? (' in ' + msg.duration + 's') : '';
            out.textContent = (out.textContent ? (out.textContent + String.fromCharCode(10)) : '') +
              '[Process finished with exit code ' + (msg.exit_code !== undefined ? msg.exit_code : 0) + dur + ']';
          }
        });

        var toolCards = procId ? document.querySelectorAll('.tool-card[data-process-id="' + procId + '"]') : [];
        if (!toolCards || toolCards.length === 0) {
          toolCards = document.querySelectorAll('.tool-card[data-tool-name="shell_bg"]');
        }
        toolCards.forEach(function(tc) {
          var tag = tc.querySelector('.tool-tag');
          if (tag) {
            tag.textContent = msg.exit_code === 0 ? 'DONE' : 'STOPPED';
            tag.style.background = msg.exit_code === 0 ? 'rgba(63, 185, 80, 0.2)' : 'rgba(248, 81, 73, 0.2)';
            tag.style.color = msg.exit_code === 0 ? 'var(--green)' : 'var(--red)';
          }
          var sBtn = tc.querySelector('.bg-proc-stop-btn');
          if (sBtn) sBtn.remove();
        });
      };

      // Document click delegation for activity rows
      document.addEventListener('click', function(e) {
        var stopBtn = e.target.closest('.bg-proc-stop-btn');
        if (stopBtn) {
          e.stopPropagation();
          e.preventDefault();
          var pId = stopBtn.getAttribute('data-process-id');
          if (pId) {
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopping...';
            postToVsCode({ type: 'kill_process', processId: pId });
          }
          return;
        }

        // File edit rows (open-file / open-review-tab) are handled only by the
        // main client script's data-action delegation, so each click posts once.

        var cmdRow = e.target.closest('.activity-row-command');
        if (cmdRow) {
          var wrap = cmdRow.closest('.activity-cmd-wrap');
          if (wrap) {
            var out = wrap.querySelector('.activity-cmd-output');
            if (out) {
              var isHidden = out.style.display === 'none';
              out.style.display = isHidden ? 'block' : 'none';
              if (isHidden) {
                cmdRow.classList.add('expanded');
              } else {
                cmdRow.classList.remove('expanded');
              }
            }
          }
          return;
        }
      });
    })();
  `;
}
