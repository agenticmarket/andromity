/** Client-side streaming render scheduler for the chat webview. It is injected
 *  into the chat script's scope and relies on renderMarkdown,
 *  scrollToBottomIfNeeded, updateToolTarget and sessionLiveBuffer from there. */
export function getStreamingRenderScript(): string {
  return `
    // ── Streaming render scheduling ─────────────────────────────────────────
    // Deltas only append to buffers; DOM work runs at most once per animation
    // frame. Assistant text re-parses only its unfinished tail: top-level
    // blocks closed by a blank line outside a code fence are rendered once and
    // kept. Any non-delta message first settles everything with one full
    // render, so handlers see the same DOM as rendering the whole text at once.
    const NEWLINE = String.fromCharCode(10);
    const STREAM_DELTA_TYPES = new Set(['text_delta', 'thinking_delta', 'tool_delta']);
    // Status updates that never touch the conversation DOM, so they need not
    // settle a streaming reply (active_editor_context fires on every cursor move).
    const STREAM_PASSIVE_TYPES = new Set([
      'active_editor_context', 'usage_updated', 'ollama_status_updated', 'workspace_files_updated',
      'set_mascot_enabled', 'wallpaper_config_changed', 'play_sound', 'sessions_data', 'crons_data',
    ]);
    function needsStreamSettle(type) {
      return !STREAM_DELTA_TYPES.has(type) && !STREAM_PASSIVE_TYPES.has(type);
    }
    const _incrementalTextBlocks = new Set();
    const _pendingTextBlocks = new Set();
    const _pendingStreamTasks = new Map();
    let _streamFrame = null;

    function renderStreamingTextIncrementally(el) {
      const text = el._blockText || '';
      if (!el._streamStable || el._streamStable.parentNode !== el) {
        el.textContent = '';
        el._streamStable = document.createElement('div');
        el._streamStable.className = 'md-stream-part';
        el._streamTail = document.createElement('div');
        el._streamTail.className = 'md-stream-part';
        el.appendChild(el._streamStable);
        el.appendChild(el._streamTail);
        el._stableLen = 0;
        el._scanPos = 0;
        el._inFence = false;
      }
      let lineStart = el._scanPos;
      let lineEnd;
      let boundary = el._stableLen;
      while ((lineEnd = text.indexOf(NEWLINE, lineStart)) !== -1) {
        const trimmed = text.slice(lineStart, lineEnd).trim();
        if (trimmed.startsWith('${"```"}') || trimmed.startsWith('~~~')) el._inFence = !el._inFence;
        else if (!el._inFence && trimmed === '') boundary = lineEnd + 1;
        lineStart = lineEnd + 1;
      }
      el._scanPos = lineStart;
      if (boundary > el._stableLen) {
        el._streamStable.insertAdjacentHTML('beforeend', renderMarkdown(text.slice(el._stableLen, boundary)));
        el._stableLen = boundary;
      }
      el._streamTail.innerHTML = renderMarkdown(text.slice(el._stableLen));
      _incrementalTextBlocks.add(el);
    }

    function renderStreamingTextFully(el) {
      _incrementalTextBlocks.delete(el);
      el._streamStable = null;
      el._streamTail = null;
      if (el.isConnected) el.innerHTML = renderMarkdown(el._blockText || '');
    }

    function requestStreamFrame() {
      if (_streamFrame === null) _streamFrame = requestAnimationFrame(flushStreamFrame);
    }

    function queueTextRender(el) {
      _pendingTextBlocks.add(el);
      requestStreamFrame();
    }

    /** One task per key per frame; later queues for the same key replace earlier ones. */
    function queueStreamTask(key, task) {
      _pendingStreamTasks.set(key, task);
      requestStreamFrame();
    }

    function runStreamTasks() {
      const tasks = Array.from(_pendingStreamTasks.values());
      _pendingStreamTasks.clear();
      for (const task of tasks) {
        try { task(); } catch (e) { console.warn('[Andromity] Stream update failed:', e); }
      }
    }

    function flushStreamFrame() {
      _streamFrame = null;
      const blocks = Array.from(_pendingTextBlocks);
      _pendingTextBlocks.clear();
      for (const el of blocks) {
        if (el.isConnected) renderStreamingTextIncrementally(el);
      }
      runStreamTasks();
      scrollToBottomIfNeeded();
    }

    function settleStreamingRender() {
      if (_streamFrame !== null) {
        cancelAnimationFrame(_streamFrame);
        _streamFrame = null;
      }
      for (const el of _pendingTextBlocks) _incrementalTextBlocks.add(el);
      _pendingTextBlocks.clear();
      for (const el of Array.from(_incrementalTextBlocks)) renderStreamingTextFully(el);
      runStreamTasks();
    }

    /** Append streamed text through a text node instead of textContent +=, which re-serialises everything. */
    function appendStreamText(el, text) {
      if (!text) return;
      if (!el._streamTextNode || el._streamTextNode.parentNode !== el) {
        el._streamTextNode = document.createTextNode('');
        el.appendChild(el._streamTextNode);
      }
      el._streamTextNode.appendData(text);
    }

    const STREAM_FILE_ARG_RE = /"(?:TargetFile|file_path|target_file|path)"\\s*:\\s*"([^"]+)"/;
    const STREAM_CMD_ARG_RE = /"(?:CommandLine|command|cmd)"\\s*:\\s*"([^"]+)"/;
    const LIVE_BUFFER_MAX_EVENTS = 5000;
    /** Buffer a background session's event, merging consecutive deltas so a
     *  switch replays a handful of events instead of every token. */
    function bufferLiveEvent(sessionId, ev) {
      const buf = sessionLiveBuffer.get(sessionId) || [];
      const last = buf[buf.length - 1];
      if (last && last.t === ev.t && (ev.t === 'text_delta' || ev.t === 'thinking_delta')) {
        last.text = (last.text || '') + (ev.text || '');
      } else if (last && last.t === 'tool_delta' && ev.t === 'tool_delta' && last.tool_id === ev.tool_id) {
        last.chunk = (last.chunk || '') + (ev.chunk || '');
      } else {
        buf.push(ev);
        if (buf.length > LIVE_BUFFER_MAX_EVENTS) buf.splice(0, buf.length - LIVE_BUFFER_MAX_EVENTS);
      }
      sessionLiveBuffer.set(sessionId, buf);
    }

    function resolveStreamingToolLabel(toolId, argsEl) {
      const toolRow = document.getElementById('tool-' + toolId);
      if (!toolRow) return;
      const partial = argsEl.textContent;
      if (!toolRow.querySelector('.tool-title-group .tool-target')) {
        updateToolTarget(toolRow, toolRow.getAttribute('data-tool-name') || '', partial);
      }
      if (toolRow.getAttribute('data-label-resolved') !== '0') return;
      const labelEl = document.getElementById('label-' + toolId);
      if (!labelEl) return;
      const fileMatch = partial.match(STREAM_FILE_ARG_RE);
      const cmdMatch = partial.match(STREAM_CMD_ARG_RE);
      if (fileMatch && fileMatch[1]) {
        labelEl.textContent = fileMatch[1].split(String.fromCharCode(92)).join('/').split('/').pop() || fileMatch[1];
        labelEl.title = fileMatch[1];
        toolRow.setAttribute('data-label-resolved', '1');
      } else if (cmdMatch && cmdMatch[1] && cmdMatch[1].length > 3) {
        labelEl.textContent = cmdMatch[1];
        labelEl.title = cmdMatch[1];
        toolRow.setAttribute('data-label-resolved', '1');
      }
    }

  `;
}
