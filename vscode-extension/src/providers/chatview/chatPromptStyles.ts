export function getPromptStyles(): string {
  return `
    /* User Prompt Card -- Modern IDE Layout matching Theme Guidelines */
    .message-wrap.user {
      align-items: stretch;
      width: 100%;
      max-width: 100%;
      margin-bottom: 12px;
    }

    .user-prompt-actions {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
      padding: 0 2px;
    }

    .prompt-undo-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: transparent;
      border: 1px solid transparent;
      color: var(--muted, #888);
      font-size: 11px;
      font-weight: 500;
      padding: 2px 7px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
      opacity: 0.85;
      user-select: none;
    }

    .prompt-undo-btn:hover {
      background: rgba(var(--tint), 0.06);
      border-color: var(--border);
      color: var(--fg);
      opacity: 1;
    }

    .prompt-undo-btn svg {
      flex-shrink: 0;
    }

    .prompt-edit-box {
      border: 1px solid var(--vscode-focusBorder, var(--accent));
      border-radius: 10px;
      background: var(--input-bg);
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .prompt-edit-input {
      width: 100%;
      box-sizing: border-box;
      resize: vertical;
      min-height: 54px;
      max-height: 240px;
      background: transparent;
      color: var(--fg);
      border: none;
      outline: none;
      font: inherit;
      font-size: 13px;
      line-height: 1.5;
    }
    .prompt-edit-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .prompt-edit-note {
      font-size: 11px;
      color: var(--muted);
    }
    .prompt-edit-actions {
      display: flex;
      gap: 6px;
      margin-left: auto;
    }
    .prompt-edit-cancel, .prompt-edit-send {
      font: inherit;
      font-size: 11.5px;
      padding: 3px 10px;
      border-radius: 4px;
      cursor: pointer;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--fg);
    }
    .prompt-edit-send {
      background: var(--vscode-button-background, #007fd4);
      color: var(--vscode-button-foreground, #fff);
      border-color: transparent;
    }
    .prompt-edit-send:hover { background: var(--vscode-button-hoverBackground, #026ec1); }
    .prompt-edit-images { padding: 2px 0 0 0; }

    .undo-note-action {
      margin-left: 8px;
      padding: 1px 8px;
      font: inherit;
      font-size: 11px;
      color: var(--vscode-textLink-foreground, var(--accent));
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
    }
    .undo-note-action:hover { color: var(--fg); background: rgba(var(--tint), 0.06); }

    .message.user.prompt-card {
      background: var(--card-bg, #18181b);
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 10px 14px;
      border-radius: 10px;
      width: 100%;
      max-width: 100%;
      font-size: 13px;
      line-height: 1.5;
      word-break: break-word;
      box-sizing: border-box;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
      transition: border-color 0.15s ease;
    }

    .message.user.prompt-card:hover {
      border-color: rgba(var(--tint), 0.14);
    }

    /* Editor tabs use the editor background for --card-bg, which can hide prompt text.
       Keep user prompts on the sidebar surface so they stay readable. */
    body.andromity-session-tab .message.user.prompt-card {
      background: var(--vscode-sideBar-background, #18181b);
      border-color: var(--vscode-widget-border, rgba(var(--tint), 0.14));
    }

    /* Prompt Attached Image Gallery / Carousel */
    .prompt-images-container {
      position: relative;
      width: 100%;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
    }

    .prompt-image-carousel {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      scrollbar-width: none;
      -ms-overflow-style: none;
      scroll-behavior: smooth;
      width: 100%;
      padding: 2px 0;
    }

    .prompt-image-carousel::-webkit-scrollbar {
      display: none;
    }

    .carousel-nav-btn {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: rgba(24, 24, 27, 0.9);
      border: 1px solid rgba(var(--tint), 0.2);
      color: var(--fg);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 5;
      backdrop-filter: blur(4px);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s, background 0.15s, border-color 0.15s;
    }

    .prompt-images-container.has-overflow:hover .carousel-nav-btn {
      opacity: 1;
      pointer-events: auto;
    }

    .carousel-nav-btn.prev {
      left: -6px;
    }

    .carousel-nav-btn.next {
      right: -6px;
    }

    .carousel-nav-btn:hover {
      background: rgba(45, 45, 50, 0.95);
      border-color: var(--accent);
    }

    .prompt-image-thumb {
      max-width: 180px;
      max-height: 110px;
      object-fit: cover;
      border-radius: 6px;
      border: 1px solid rgba(var(--tint), 0.12);
      flex-shrink: 0;
      cursor: pointer;
      transition: transform 0.15s, border-color 0.15s;
    }

    .prompt-image-thumb:hover {
      transform: scale(1.02);
      border-color: var(--accent);
    }

    .prompt-image-thumb:focus-visible {
      outline: 2px solid var(--vscode-focusBorder, var(--accent));
      outline-offset: -2px;
    }

    /* Prompt Text & Expand / Collapse Clamping */
    .prompt-text-wrapper {
      position: relative;
      width: 100%;
    }

    .prompt-text-content {
      white-space: pre-wrap;
      font-family: inherit;
      font-size: 13px;
      line-height: 1.5;
      color: var(--fg);
    }

    .prompt-text-content.clamped {
      max-height: 90px;
      overflow: hidden;
      -webkit-mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
      mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
    }

    .prompt-expand-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: transparent;
      border: none;
      color: var(--accent, #007fd4);
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      padding: 4px 0 0 0;
      margin-top: 2px;
      user-select: none;
      transition: opacity 0.15s;
    }

    .prompt-expand-btn:hover {
      text-decoration: underline;
      opacity: 0.9;
    }
  `;
}
