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
        var normalizedKey = filePath.split('\\\\').join('/');
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

      window.renderAntigravityActivityRow = function(toolName, toolArgs, status) {
        var stat = window.parseFileEditStats(toolName, toolArgs);
        if (!stat) return null;

        var isRunning = status === 'running';
        var safeFile = escapeHtml(stat.filename);
        var safePath = escapeHtml(stat.filePath);
        var safeBadge = escapeHtml(stat.badgeText);
        var badgeCls = escapeHtml(stat.badgeClass);

        var statsHtml = '';
        if (isRunning) {
          statsHtml = '<span class="activity-running-dot" title="Editing file..."></span>';
        } else {
          if (stat.additions > 0 || stat.deletions > 0) {
            statsHtml = '<span class="activity-stats">' +
              (stat.additions > 0 ? ('<span class="activity-stat-add">+' + stat.additions + '</span>') : '') +
              (stat.deletions > 0 ? ('<span class="activity-stat-del">-' + stat.deletions + '</span>') : '') +
            '</span>';
          } else {
            statsHtml = '<span class="activity-stats"><span class="activity-stat-add">+0</span> <span class="activity-stat-del">-0</span></span>';
          }
        }

        var diffIconSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M16 3h5v5"></path><path d="M4 20L21 3"></path><path d="M21 16v5h-5"></path><path d="M15 15l6 6"></path><path d="M4 4l5 5"></path></svg>';

        var row = document.createElement('div');
        row.className = 'activity-row activity-row-file activity-row-clickable' + (isRunning ? ' running' : '');
        row.setAttribute('data-action', 'open-file');
        row.setAttribute('data-file-path', stat.filePath);
        row.setAttribute('title', 'Click to open ' + safePath + ' in editor');

        row.innerHTML = '<span class="activity-action">' + (isRunning ? 'Editing' : 'Edited') + '</span>' +
          '<span class="activity-badge ' + badgeCls + '">' + safeBadge + '</span>' +
          '<span class="activity-filename" title="' + safePath + '">' + safeFile + '</span>' +
          statsHtml +
          (!isRunning ? (
            '<button class="activity-diff-btn" data-action="open-file-diff" data-file-path="' + safePath + '" title="Open Side-by-Side Diff">' +
              diffIconSvg +
            '</button>'
          ) : '');

        return row;
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

      // Document click delegation for activity rows
      document.addEventListener('click', function(e) {
        var diffBtn = e.target.closest('.activity-diff-btn');
        if (diffBtn) {
          e.stopPropagation();
          var p = diffBtn.getAttribute('data-file-path');
          if (p) {
            postToVsCode({ type: 'open_file_diff', filePath: p });
          }
          return;
        }

        var fileRow = e.target.closest('.activity-row-file');
        if (fileRow) {
          var p = fileRow.getAttribute('data-file-path');
          if (p) {
            postToVsCode({ type: 'open_file', filePath: p });
          }
          return;
        }

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
