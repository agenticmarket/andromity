/**
 * Client-side script for the Andromity Changes Review Webview.
 * Handles tree rendering, interactive diff parsing, folding, and postMessage RPC.
 */
export function getReviewClientScript(): string {
  return `
  (function () {
    const vscode = acquireVsCodeApi();

    // ── State ──────────────────────────────────────────────────
    let state = {
      branch: 'main',
      files: [],
      turnFiles: null,
      scope: 'turn',
      activeFilePath: null,
      fileDiffs: {},
      viewMode: 'unified',
      searchQuery: '',
      collapsedFolders: {},
      expandedBlocks: {}, // key: filePath + ":" + blockIndex -> boolean
    };

    // Restore previous state if any
    const previousState = vscode.getState();
    if (previousState) {
      state = { ...state, ...previousState };
    }

    function saveState() {
      vscode.setState(state);
    }

    // ── DOM References ─────────────────────────────────────────
    const branchLabelEl = document.getElementById('branch-label');
    const totalFilesEl = document.getElementById('total-files');
    const totalAdditionsEl = document.getElementById('total-additions');
    const totalDeletionsEl = document.getElementById('total-deletions');
    const scopeTogglesEl = document.getElementById('scope-toggles');
    const btnScopeTurn = document.getElementById('btn-scope-turn');
    const btnScopeAll = document.getElementById('btn-scope-all');
    const turnFilesCountEl = document.getElementById('turn-files-count');
    const allFilesCountEl = document.getElementById('all-files-count');
    const treeScrollArea = document.getElementById('tree-scroll-area');
    const searchInput = document.getElementById('search-input');
    const diffContainer = document.getElementById('diff-container');
    const refreshBtn = document.getElementById('refresh-btn');
    const btnUnified = document.getElementById('btn-unified');
    const btnSplit = document.getElementById('btn-split');
    const sidebar = document.getElementById('review-sidebar');
    const resizer = document.getElementById('sidebar-resizer');

    // ── Sidebar Resizer ────────────────────────────────────────
    let isResizing = false;
    resizer.addEventListener('mousedown', function (e) {
      isResizing = true;
      resizer.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });

    window.addEventListener('mousemove', function (e) {
      if (!isResizing) return;
      const newWidth = Math.max(180, Math.min(e.clientX, 600));
      sidebar.style.width = newWidth + 'px';
    });

    window.addEventListener('mouseup', function () {
      if (isResizing) {
        isResizing = false;
        resizer.classList.remove('resizing');
        document.body.style.cursor = '';
      }
    });

    // ── Scope Switching ─────────────────────────────────────────
    if (btnScopeTurn) {
      btnScopeTurn.addEventListener('click', function () {
        state.scope = 'turn';
        saveState();
        updateMetrics();
        const visible = getActiveFileList();
        if (!visible.some(function (f) { return f.path === state.activeFilePath; }) && visible.length > 0) {
          selectFile(visible[0].path);
        } else {
          renderTree();
          renderActiveDiff();
        }
      });
    }

    if (btnScopeAll) {
      btnScopeAll.addEventListener('click', function () {
        state.scope = 'all';
        saveState();
        updateMetrics();
        renderTree();
        renderActiveDiff();
      });
    }

    // ── View Mode Switching ────────────────────────────────────
    btnUnified.addEventListener('click', function () {
      state.viewMode = 'unified';
      btnUnified.classList.add('active');
      btnSplit.classList.remove('active');
      saveState();
      renderActiveDiff();
    });

    btnSplit.addEventListener('click', function () {
      state.viewMode = 'split';
      btnSplit.classList.add('active');
      btnUnified.classList.remove('active');
      saveState();
      renderActiveDiff();
    });

    // ── Search Filtering ───────────────────────────────────────
    searchInput.addEventListener('input', function (e) {
      state.searchQuery = e.target.value.toLowerCase().trim();
      renderTree();
    });

    refreshBtn.addEventListener('click', function () {
      refreshBtn.disabled = true;
      refreshBtn.innerHTML = '<span class="codicon codicon-loading codicon-modifier-spin"></span> Refreshing...';
      vscode.postMessage({ type: 'refresh' });
    });

    // ── HTML Escape Helper ─────────────────────────────────────
    function escapeHtml(text) {
      if (!text) return '';
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // ── Get File Icon ──────────────────────────────────────────
    function getFileIcon(fileName) {
      const ext = fileName.split('.').pop().toLowerCase();
      switch (ext) {
        case 'ts':
        case 'tsx':
          return 'symbol-interface';
        case 'js':
        case 'jsx':
          return 'symbol-keyword';
        case 'py':
          return 'symbol-method';
        case 'json':
          return 'symbol-constant';
        case 'md':
          return 'markdown';
        case 'css':
        case 'scss':
          return 'symbol-color';
        case 'html':
          return 'code';
        case 'svg':
        case 'png':
        case 'jpg':
          return 'file-media';
        default:
          return 'file';
      }
    }

    // ── Build Hierarchical Tree ────────────────────────────────
    function buildTree(files) {
      const root = { name: '', isDir: true, children: {}, files: [] };
      files.forEach(function (f) {
        const parts = f.path.split('/');
        let curr = root;
        for (let i = 0; i < parts.length - 1; i++) {
          const folder = parts[i];
          if (!curr.children[folder]) {
            curr.children[folder] = {
              name: folder,
              path: parts.slice(0, i + 1).join('/'),
              isDir: true,
              children: {},
              files: [],
            };
          }
          curr = curr.children[folder];
        }
        curr.files.push(f);
      });
      return root;
    }

    // ── Scope Helpers ──────────────────────────────────────────
    function isTurnFile(filePath, turnFiles) {
      if (!turnFiles || turnFiles.length === 0) return true;
      const normTarget = (filePath || '').replace(/\\\\/g, '/').toLowerCase().trim();
      return turnFiles.some(function (tf) {
        const normTf = (tf || '').replace(/\\\\/g, '/').toLowerCase().trim();
        if (normTarget === normTf) return true;
        if (normTarget.endsWith('/' + normTf) || normTf.endsWith('/' + normTarget)) return true;
        // Only allow bare basename match if the reference turn path had no directory prefix
        if (!normTf.includes('/') && normTarget.split('/').pop() === normTf) return true;
        return false;
      });
    }

    function getActiveFileList() {
      let list = state.files;
      if (state.scope === 'turn' && state.turnFiles && state.turnFiles.length > 0) {
        list = list.filter(function (f) {
          return isTurnFile(f.path, state.turnFiles);
        });
      }
      return list;
    }

    function updateMetrics() {
      const activeList = getActiveFileList();
      let adds = 0;
      let dels = 0;
      activeList.forEach(function (f) {
        adds += (f.additions || 0);
        dels += (f.deletions || 0);
      });
      totalFilesEl.textContent = activeList.length + ' File' + (activeList.length === 1 ? '' : 's') + ' Changed';
      totalAdditionsEl.textContent = '+' + adds;
      totalDeletionsEl.textContent = '-' + dels;

      if (state.turnFiles && state.turnFiles.length > 0 && scopeTogglesEl) {
        scopeTogglesEl.style.display = 'inline-flex';
        const turnCount = state.files.filter(function (f) {
          return isTurnFile(f.path, state.turnFiles);
        }).length;
        if (turnFilesCountEl) turnFilesCountEl.textContent = turnCount || state.turnFiles.length;
        if (allFilesCountEl) allFilesCountEl.textContent = state.files.length;
        if (state.scope === 'turn') {
          if (btnScopeTurn) btnScopeTurn.classList.add('active');
          if (btnScopeAll) btnScopeAll.classList.remove('active');
        } else {
          if (btnScopeAll) btnScopeAll.classList.add('active');
          if (btnScopeTurn) btnScopeTurn.classList.remove('active');
        }
      } else if (scopeTogglesEl) {
        scopeTogglesEl.style.display = 'none';
      }
    }

    // ── Render Tree ────────────────────────────────────────────
    function renderTree() {
      treeScrollArea.innerHTML = '';
      const activeFiles = getActiveFileList();
      const filtered = activeFiles.filter(function (f) {
        if (!state.searchQuery) return true;
        return f.path.toLowerCase().includes(state.searchQuery);
      });

      if (filtered.length === 0) {
        treeScrollArea.innerHTML = '<div style="padding: 16px; color: var(--vscode-descriptionForeground); font-size: 12px; text-align: center;">No changed files match filter</div>';
        return;
      }

      const tree = buildTree(filtered);

      function renderNode(node, depth) {
        // Folders
        Object.keys(node.children).sort().forEach(function (folderName) {
          const childNode = node.children[folderName];
          const isCollapsed = !!state.collapsedFolders[childNode.path];

          const folderRow = document.createElement('div');
          folderRow.className = 'tree-folder-row';
          folderRow.style.paddingLeft = (depth * 14 + 6) + 'px';
          folderRow.innerHTML =
            '<span class="folder-chevron codicon codicon-chevron-down ' + (isCollapsed ? 'collapsed' : '') + '"></span>' +
            '<span class="codicon codicon-folder" style="color: #64b5f6; font-size: 13px;"></span>' +
            '<span class="folder-name">' + escapeHtml(folderName) + '</span>';

          folderRow.addEventListener('click', function (e) {
            e.stopPropagation();
            state.collapsedFolders[childNode.path] = !isCollapsed;
            saveState();
            renderTree();
          });

          treeScrollArea.appendChild(folderRow);

          if (!isCollapsed) {
            renderNode(childNode, depth + 1);
          }
        });

        // Files
        node.files.sort(function (a, b) {
          return a.name.localeCompare(b.name);
        }).forEach(function (file) {
          const isActive = file.path === state.activeFilePath;
          const fileRow = document.createElement('div');
          fileRow.className = 'tree-file-row ' + (isActive ? 'active' : '');
          fileRow.style.paddingLeft = (depth * 14 + 18) + 'px';

          const iconName = getFileIcon(file.name);
          const addStr = file.additions > 0 ? '<span class="stat-add">+' + file.additions + '</span>' : '';
          const delStr = file.deletions > 0 ? '<span class="stat-del">-' + file.deletions + '</span>' : '';

          fileRow.innerHTML =
            '<span class="file-status-badge ' + file.status + '">' + file.status + '</span>' +
            '<span class="codicon codicon-' + iconName + '" style="font-size: 13px; opacity: 0.85;"></span>' +
            '<span class="file-name" title="' + escapeHtml(file.path) + '">' + escapeHtml(file.name) + '</span>' +
            '<span class="file-diff-pill">' + addStr + ' ' + delStr + '</span>';

          fileRow.addEventListener('click', function () {
            selectFile(file.path);
          });

          treeScrollArea.appendChild(fileRow);
        });
      }

      renderNode(tree, 0);
    }

    // ── Select File ────────────────────────────────────────────
    function selectFile(filePath) {
      state.activeFilePath = filePath;
      saveState();
      renderTree();

      // If diff is not loaded yet, request from backend
      if (!state.fileDiffs[filePath]) {
        showLoadingDiff(filePath);
        vscode.postMessage({ type: 'get_file_diff', filePath: filePath });
      } else {
        renderActiveDiff();
      }
    }

    function showLoadingDiff(filePath) {
      diffContainer.innerHTML =
        '<div class="empty-state">' +
          '<div class="codicon codicon-loading codicon-modifier-spin empty-state-icon"></div>' +
          '<h3>Loading diff for ' + escapeHtml(filePath) + '...</h3>' +
        '</div>';
    }

    // ── Parse Unified Diff ─────────────────────────────────────
    function parseUnifiedDiff(diffText) {
      if (!diffText || !diffText.trim()) return [];

      const lines = diffText.split(/\\r?\\n/);
      const hunks = [];
      let currentHunk = null;
      let oldLine = 0;
      let newLine = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Match hunk header: @@ -oldStart,oldLen +newStart,newLen @@
        const hunkMatch = line.match(/^@@\\s+-(\\d+)(?:,(\\d+))?\\s+\\+(\\d+)(?:,(\\d+))?\\s+@@(.*)$/);
        if (hunkMatch) {
          currentHunk = {
            oldStart: parseInt(hunkMatch[1], 10),
            oldLen: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
            newStart: parseInt(hunkMatch[3], 10),
            newLen: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
            header: hunkMatch[5] || '',
            lines: [],
          };
          oldLine = currentHunk.oldStart;
          newLine = currentHunk.newStart;
          hunks.push(currentHunk);
          continue;
        }

        if (!currentHunk) continue;

        if (line.startsWith('+')) {
          currentHunk.lines.push({
            type: 'add',
            oldLine: null,
            newLine: newLine++,
            text: line.substring(1),
          });
        } else if (line.startsWith('-')) {
          currentHunk.lines.push({
            type: 'del',
            oldLine: oldLine++,
            newLine: null,
            text: line.substring(1),
          });
        } else if (line.startsWith(' ') || line === '') {
          currentHunk.lines.push({
            type: 'context',
            oldLine: oldLine++,
            newLine: newLine++,
            text: line.startsWith(' ') ? line.substring(1) : '',
          });
        }
      }

      return hunks;
    }

    // ── Build Split Hunk Rows (Side-by-Side) ───────────────────
    function buildSplitHunkRows(hunk) {
      const rows = [];
      let i = 0;
      while (i < hunk.lines.length) {
        const l = hunk.lines[i];
        if (l.type === 'context') {
          rows.push({
            left: { type: 'context', lineNo: l.oldLine, marker: ' ', text: l.text },
            right: { type: 'context', lineNo: l.newLine, marker: ' ', text: l.text },
          });
          i++;
        } else {
          const dels = [];
          const adds = [];
          while (i < hunk.lines.length && hunk.lines[i].type === 'del') {
            dels.push(hunk.lines[i]);
            i++;
          }
          while (i < hunk.lines.length && hunk.lines[i].type === 'add') {
            adds.push(hunk.lines[i]);
            i++;
          }
          const maxLen = Math.max(dels.length, adds.length);
          for (let j = 0; j < maxLen; j++) {
            const d = j < dels.length ? dels[j] : null;
            const a = j < adds.length ? adds[j] : null;
            rows.push({
              left: d ? { type: 'del', lineNo: d.oldLine, marker: '-', text: d.text } : { type: 'empty' },
              right: a ? { type: 'add', lineNo: a.newLine, marker: '+', text: a.text } : { type: 'empty' },
            });
          }
        }
      }
      return rows;
    }

    // ── Render Active Diff View ────────────────────────────────
    function renderActiveDiff() {
      if (!state.activeFilePath) {
        diffContainer.innerHTML =
          '<div class="empty-state">' +
            '<div class="codicon codicon-diff empty-state-icon"></div>' +
            '<h3>Select a file from the sidebar to review its changes</h3>' +
            '<p>Choose any modified or untracked file to view line-by-line diffs.</p>' +
          '</div>';
        return;
      }

      const fileObj = state.files.find(function (f) { return f.path === state.activeFilePath; });
      const diffData = state.fileDiffs[state.activeFilePath] || '';

      // Build Header
      const headerHtml =
        '<div class="diff-file-header">' +
          '<div class="diff-file-title">' +
            '<span class="file-status-badge ' + (fileObj ? fileObj.status : 'M') + '">' + (fileObj ? fileObj.status : 'M') + '</span>' +
            '<span>' + escapeHtml(state.activeFilePath) + '</span>' +
            (fileObj ? '<span class="file-diff-pill"><span class="stat-add">+' + fileObj.additions + '</span> <span class="stat-del">-' + fileObj.deletions + '</span></span>' : '') +
          '</div>' +
          '<div class="diff-file-actions">' +
            '<button class="icon-btn" id="action-open-editor" title="Open file in VS Code editor">' +
              '<span class="codicon codicon-go-to-file"></span>' +
            '</button>' +
            '<button class="icon-btn" id="action-native-diff" title="Open in native VS Code diff editor">' +
              '<span class="codicon codicon-diff-single"></span>' +
            '</button>' +
            '<button class="icon-btn" id="action-revert-file" title="Revert changes in this file">' +
              '<span class="codicon codicon-discard"></span>' +
            '</button>' +
          '</div>' +
        '</div>';

      const hunks = parseUnifiedDiff(diffData);

      let diffContentHtml = '';

      if (hunks.length === 0) {
        if (diffData.trim()) {
          // Plain text fallback (e.g. untracked file or raw text)
          const rawLines = diffData.split(/\\r?\\n/);
          if (state.viewMode === 'split') {
            diffContentHtml =
              '<div class="diff-scroll-area">' +
                '<div class="split-diff-header">' +
                  '<div class="split-pane-header left-pane-header">Base (Empty / Untracked)</div>' +
                  '<div class="split-pane-header right-pane-header">Working Tree (New)</div>' +
                '</div>';
            rawLines.forEach(function (rl, idx) {
              diffContentHtml +=
                '<div class="split-row">' +
                  '<div class="split-pane left-pane empty">' +
                    '<span class="gutter-old"></span>' +
                    '<span class="gutter-marker"></span>' +
                    '<span class="line-content"></span>' +
                  '</div>' +
                  '<div class="split-pane right-pane add">' +
                    '<span class="gutter-new">' + (idx + 1) + '</span>' +
                    '<span class="gutter-marker">+</span>' +
                    '<span class="line-content">' + escapeHtml(rl) + '</span>' +
                  '</div>' +
                '</div>';
            });
            diffContentHtml += '</div>';
          } else {
            diffContentHtml = '<div class="diff-scroll-area"><table class="diff-table">';
            rawLines.forEach(function (rl, idx) {
              diffContentHtml +=
                '<tr class="diff-line add">' +
                  '<td class="gutter-old"></td>' +
                  '<td class="gutter-new">' + (idx + 1) + '</td>' +
                  '<td class="gutter-marker">+</td>' +
                  '<td class="line-content">' + escapeHtml(rl) + '</td>' +
                '</tr>';
            });
            diffContentHtml += '</table></div>';
          }
        } else {
          diffContentHtml =
            '<div class="empty-state">' +
              '<div class="codicon codicon-check-all empty-state-icon" style="color: #3fb950;"></div>' +
              '<h3>No differences found</h3>' +
              '<p>This file is identical to the base version.</p>' +
            '</div>';
        }
      } else if (state.viewMode === 'split') {
        // ── True Split (Side-by-Side) View ───────────────────────
        diffContentHtml =
          '<div class="diff-scroll-area">' +
            '<div class="split-diff-header">' +
              '<div class="split-pane-header left-pane-header">Base (HEAD)</div>' +
              '<div class="split-pane-header right-pane-header">Working Tree (Modified)</div>' +
            '</div>';

        hunks.forEach(function (hunk, hIdx) {
          if (hIdx === 0 && hunk.oldStart > 1) {
            const gap = hunk.oldStart - 1;
            const blockKey = state.activeFilePath + ':hunk_start';
            const isExpanded = !!state.expandedBlocks[blockKey];
            if (!isExpanded) {
              diffContentHtml +=
                '<div class="unmodified-banner" data-block="' + blockKey + '">' +
                  '<span><span class="codicon codicon-unfold" style="margin-right: 6px;"></span>' + gap + ' unmodified lines</span>' +
                  '<div class="unmodified-controls">' +
                    '<button class="expand-btn" data-block="' + blockKey + '">Expand</button>' +
                  '</div>' +
                '</div>';
            }
          } else if (hIdx > 0) {
            const prevHunk = hunks[hIdx - 1];
            const prevEnd = prevHunk.oldStart + prevHunk.oldLen;
            const gap = hunk.oldStart - prevEnd;
            if (gap > 0) {
              const blockKey = state.activeFilePath + ':gap_' + hIdx;
              const isExpanded = !!state.expandedBlocks[blockKey];
              if (!isExpanded) {
                diffContentHtml +=
                  '<div class="unmodified-banner" data-block="' + blockKey + '">' +
                    '<span><span class="codicon codicon-unfold" style="margin-right: 6px;"></span>' + gap + ' unmodified lines</span>' +
                    '<div class="unmodified-controls">' +
                      '<button class="expand-btn" data-block="' + blockKey + '">Expand</button>' +
                    '</div>' +
                  '</div>';
              }
            }
          }

          const splitRows = buildSplitHunkRows(hunk);
          splitRows.forEach(function (sr) {
            const left = sr.left;
            const right = sr.right;
            diffContentHtml +=
              '<div class="split-row">' +
                '<div class="split-pane left-pane ' + left.type + '">' +
                  '<span class="gutter-old">' + (left.lineNo !== undefined && left.lineNo !== null ? left.lineNo : '') + '</span>' +
                  '<span class="gutter-marker">' + (left.marker || '') + '</span>' +
                  '<span class="line-content">' + escapeHtml(left.text || '') + '</span>' +
                '</div>' +
                '<div class="split-pane right-pane ' + right.type + '">' +
                  '<span class="gutter-new">' + (right.lineNo !== undefined && right.lineNo !== null ? right.lineNo : '') + '</span>' +
                  '<span class="gutter-marker">' + (right.marker || '') + '</span>' +
                  '<span class="line-content">' + escapeHtml(right.text || '') + '</span>' +
                '</div>' +
              '</div>';
          });
        });

        diffContentHtml += '</div>';
      } else {
        // ── Unified View ────────────────────────────────────────
        diffContentHtml = '<div class="diff-scroll-area"><table class="diff-table">';

        hunks.forEach(function (hunk, hIdx) {
          if (hIdx === 0 && hunk.oldStart > 1) {
            const gap = hunk.oldStart - 1;
            const blockKey = state.activeFilePath + ':hunk_start';
            const isExpanded = !!state.expandedBlocks[blockKey];

            if (!isExpanded) {
              diffContentHtml +=
                '<tr><td colspan="4">' +
                  '<div class="unmodified-banner" data-block="' + blockKey + '">' +
                    '<span><span class="codicon codicon-unfold" style="margin-right: 6px;"></span>' + gap + ' unmodified lines</span>' +
                    '<div class="unmodified-controls">' +
                      '<button class="expand-btn" data-block="' + blockKey + '">Expand</button>' +
                    '</div>' +
                  '</div>' +
                '</td></tr>';
            }
          } else if (hIdx > 0) {
            const prevHunk = hunks[hIdx - 1];
            const prevEnd = prevHunk.oldStart + prevHunk.oldLen;
            const gap = hunk.oldStart - prevEnd;
            if (gap > 0) {
              const blockKey = state.activeFilePath + ':gap_' + hIdx;
              const isExpanded = !!state.expandedBlocks[blockKey];

              if (!isExpanded) {
                diffContentHtml +=
                  '<tr><td colspan="4">' +
                    '<div class="unmodified-banner" data-block="' + blockKey + '">' +
                      '<span><span class="codicon codicon-unfold" style="margin-right: 6px;"></span>' + gap + ' unmodified lines</span>' +
                      '<div class="unmodified-controls">' +
                        '<button class="expand-btn" data-block="' + blockKey + '">Expand</button>' +
                      '</div>' +
                    '</div>' +
                  '</td></tr>';
              }
            }
          }

          hunk.lines.forEach(function (dl) {
            const cls = dl.type === 'add' ? 'add' : dl.type === 'del' ? 'del' : 'context';
            const marker = dl.type === 'add' ? '+' : dl.type === 'del' ? '-' : ' ';
            const oldNo = dl.oldLine !== null && dl.oldLine !== undefined ? dl.oldLine : '';
            const newNo = dl.newLine !== null && dl.newLine !== undefined ? dl.newLine : '';

            diffContentHtml +=
              '<tr class="diff-line ' + cls + '">' +
                '<td class="gutter-old">' + oldNo + '</td>' +
                '<td class="gutter-new">' + newNo + '</td>' +
                '<td class="gutter-marker">' + marker + '</td>' +
                '<td class="line-content">' + escapeHtml(dl.text) + '</td>' +
              '</tr>';
          });
        });

        diffContentHtml += '</table></div>';
      }

      diffContainer.innerHTML = headerHtml + diffContentHtml;

      // Wire Actions
      const openEditorBtn = document.getElementById('action-open-editor');
      if (openEditorBtn) {
        openEditorBtn.addEventListener('click', function () {
          vscode.postMessage({ type: 'open_file', filePath: state.activeFilePath });
        });
      }

      const nativeDiffBtn = document.getElementById('action-native-diff');
      if (nativeDiffBtn) {
        nativeDiffBtn.addEventListener('click', function () {
          const isUntracked = fileObj ? fileObj.status === 'U' : false;
          vscode.postMessage({ type: 'open_native_diff', filePath: state.activeFilePath, isUntracked: isUntracked });
        });
      }

      const revertFileBtn = document.getElementById('action-revert-file');
      if (revertFileBtn) {
        revertFileBtn.addEventListener('click', function () {
          vscode.postMessage({ type: 'revert_file', filePath: state.activeFilePath });
        });
      }

      // Wire Unmodified Banners Click
      const banners = diffContainer.querySelectorAll('.unmodified-banner, .expand-btn');
      banners.forEach(function (b) {
        b.addEventListener('click', function (e) {
          const blockKey = b.getAttribute('data-block');
          if (blockKey) {
            state.expandedBlocks[blockKey] = true;
            saveState();
            renderActiveDiff();
          }
        });
      });
    }

    // ── Handle Incoming Messages ───────────────────────────────
    window.addEventListener('message', function (event) {
      const msg = event.data;
      switch (msg.type) {
        case 'set_changes':
          refreshBtn.disabled = false;
          refreshBtn.innerHTML = '<span class="codicon codicon-refresh"></span> Refresh';

          state.branch = msg.branch || 'main';
          state.files = msg.files || [];
          if (msg.turnFiles !== undefined) {
            state.turnFiles = (Array.isArray(msg.turnFiles) && msg.turnFiles.length > 0) ? msg.turnFiles : null;
            if (state.turnFiles) {
              state.scope = 'turn';
            } else if (state.scope === 'turn') {
              state.scope = 'all';
            }
          }

          branchLabelEl.textContent = state.branch;
          updateMetrics();

          const currentVisible = getActiveFileList();
          if (msg.selectFile) {
            const normTarget = msg.selectFile.replace(/\\\\/g, '/');
            const matched = currentVisible.find(function (f) {
              return f.path === normTarget || normTarget.endsWith('/' + f.path) || f.path.endsWith('/' + normTarget) || f.name === normTarget;
            }) || state.files.find(function (f) {
              return f.path === normTarget || normTarget.endsWith('/' + f.path) || f.path.endsWith('/' + normTarget) || f.name === normTarget;
            });
            if (matched) {
              state.activeFilePath = matched.path;
            } else if (!state.activeFilePath && currentVisible.length > 0) {
              state.activeFilePath = currentVisible[0].path;
            }
          } else if ((!state.activeFilePath || !currentVisible.some(function (f) { return f.path === state.activeFilePath; })) && currentVisible.length > 0) {
            state.activeFilePath = currentVisible[0].path;
          } else if (currentVisible.length === 0) {
            state.activeFilePath = null;
          }

          saveState();
          renderTree();

          if (state.activeFilePath) {
            selectFile(state.activeFilePath);
          } else {
            renderActiveDiff();
          }
          break;

        case 'set_file_diff':
          state.fileDiffs[msg.filePath] = msg.diff || '';
          saveState();
          if (state.activeFilePath === msg.filePath) {
            renderActiveDiff();
          }
          break;

        case 'refresh_done':
          refreshBtn.disabled = false;
          refreshBtn.innerHTML = '<span class="codicon codicon-refresh"></span> Refresh';
          break;
      }
    });

    // Notify extension host that webview is ready
    vscode.postMessage({ type: 'webview_ready' });
  })();
  `;
}
