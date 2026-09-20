/**
 * chatActivityStyles.ts
 * Strictly adheres to THEME_GUIDELINES.md:
 * - Functional, information-dense, distraction-free
 * - Deep VS Code theme integration (--vscode-*)
 * - Brand accents: #09f994 (additions / emerald), #f85149 (deletions / coral crimson)
 * - Typography: Inter for UI labels, JetBrains Mono for code / filenames / diff counters
 */

export function getChatActivityStyles(): string {
  return `
    /* ── Antigravity Activity Row (File Edits & Commands) ── */
    .activity-row {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 4px 8px;
      margin: 2px 0;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 11.5px;
      line-height: 1.4;
      color: var(--fg, #e4e4e7);
      transition: background 0.12s ease, border-color 0.12s ease;
      user-select: none;
      box-sizing: border-box;
      width: 100%;
      overflow: hidden;
      min-width: 0;
    }

    .activity-row:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.12);
    }

    .activity-row-clickable {
      cursor: pointer;
    }

    /* Action verb (Edited, Ran, Read) */
    .activity-action {
      font-family: var(--font-sans, 'Inter', -apple-system, sans-serif);
      font-size: 11.5px;
      font-weight: 500;
      color: var(--muted, #888888);
      flex-shrink: 0;
    }

    /* Language badge (TS, PY, MD, JS, etc.) */
    .activity-badge {
      font-family: var(--font-mono, 'JetBrains Mono', Consolas, monospace);
      font-size: 9.5px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.2px;
      flex-shrink: 0;
      line-height: 1.2;
    }

    .activity-badge.badge-ts, .activity-badge.badge-tsx {
      background: rgba(56, 189, 248, 0.14);
      color: #38bdf8;
    }
    .activity-badge.badge-js, .activity-badge.badge-jsx {
      background: rgba(250, 204, 21, 0.14);
      color: #facc15;
    }
    .activity-badge.badge-py {
      background: rgba(96, 165, 250, 0.14);
      color: #60a5fa;
    }
    .activity-badge.badge-json {
      background: rgba(192, 132, 252, 0.14);
      color: #c084fc;
    }
    .activity-badge.badge-md, .activity-badge.badge-markdown {
      background: rgba(203, 213, 225, 0.14);
      color: #cbd5e1;
    }
    .activity-badge.badge-css, .activity-badge.badge-scss {
      background: rgba(244, 114, 182, 0.14);
      color: #f472b6;
    }
    .activity-badge.badge-html {
      background: rgba(251, 146, 60, 0.14);
      color: #fb923c;
    }
    .activity-badge.badge-rs {
      background: rgba(249, 115, 22, 0.14);
      color: #f97316;
    }
    .activity-badge.badge-go {
      background: rgba(34, 211, 238, 0.14);
      color: #22d3ee;
    }
    .activity-badge.badge-sh, .activity-badge.badge-bash {
      background: rgba(74, 222, 128, 0.14);
      color: #4ade80;
    }
    .activity-badge.badge-generic {
      background: rgba(161, 161, 170, 0.14);
      color: #a1a1aa;
    }

    /* Filename text */
    .activity-filename {
      font-family: var(--font-mono, 'JetBrains Mono', Consolas, monospace);
      font-size: 11.5px;
      font-weight: 500;
      color: var(--fg, #e4e4e7);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
    }

    .activity-row:hover .activity-filename {
      color: #ffffff;
      text-decoration: underline;
      text-decoration-color: rgba(255, 255, 255, 0.35);
    }

    /* Diff Stats (+71 -0) */
    .activity-stats {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-family: var(--font-mono, 'JetBrains Mono', Consolas, monospace);
      font-size: 10.5px;
      font-weight: 600;
      flex-shrink: 0;
    }

    .activity-stat-add {
      color: #09f994; /* Signature Andromity Emerald */
    }

    .activity-stat-del {
      color: #f85149; /* Restrained Coral Crimson */
    }

    /* Quick Diff Icon Button */
    .activity-diff-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 4px;
      background: transparent;
      border: 1px solid transparent;
      color: var(--muted, #888888);
      cursor: pointer;
      padding: 0;
      flex-shrink: 0;
      opacity: 0.5;
      transition: all 0.12s ease;
    }

    .activity-row:hover .activity-diff-btn {
      opacity: 0.9;
    }

    .activity-diff-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.14);
      color: #38bdf8;
      opacity: 1;
    }

    .tool-elapsed {
      font-family: var(--font-mono, 'JetBrains Mono', Consolas, monospace);
      font-size: 10px;
      color: var(--muted, #71717a);
      flex-shrink: 0;
      min-width: 22px;
      text-align: right;
    }

    .activity-row.running {
      border-color: rgba(56, 189, 248, 0.25);
      background: rgba(56, 189, 248, 0.03);
    }

    .activity-row.running .activity-action {
      color: #38bdf8;
    }

    .activity-running-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #38bdf8;
      display: inline-block;
      flex-shrink: 0;
      animation: activityPulse 1.4s ease-in-out infinite;
    }

    .activity-row.stuck {
      border-color: rgba(251, 191, 36, 0.35);
      background: rgba(251, 191, 36, 0.04);
    }

    .activity-row.stuck .activity-action {
      color: #fbbf24;
    }

    .activity-row.stuck .activity-running-dot {
      background: #fbbf24;
      animation: stuckPulse 2s ease-in-out infinite;
    }

    .activity-row.stuck .tool-elapsed::before {
      content: '';
      display: inline-block;
      width: 11px;
      height: 11px;
      margin-right: 3px;
      vertical-align: -1px;
      background: currentColor;
      mask: url("data:image/svg+xml;utf8,<svg viewBox='0 0 24 24' fill='black' xmlns='http://www.w3.org/2000/svg'><path d='M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'/></svg>") center/contain no-repeat;
      -webkit-mask: url("data:image/svg+xml;utf8,<svg viewBox='0 0 24 24' fill='black' xmlns='http://www.w3.org/2000/svg'><path d='M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'/></svg>") center/contain no-repeat;
      color: #fbbf24;
    }

    .activity-row.stuck .tool-elapsed {
      color: #fbbf24;
    }

    @keyframes activityPulse {
      0%, 100% { opacity: 0.3; transform: scale(0.85); }
      50% { opacity: 1; transform: scale(1.15); }
    }

    @keyframes stuckPulse {
      0%, 100% { opacity: 0.2; transform: scale(0.8); }
      50% { opacity: 1; transform: scale(1.2); }
    }

    /* ── Command Activity Row (Ran <cmd> ›) ── */
    .activity-cmd-wrap {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      margin: 2px 0;
      box-sizing: border-box;
      overflow: hidden;
    }

    .activity-cmd-text {
      font-family: var(--font-mono, 'JetBrains Mono', Consolas, monospace);
      font-size: 11px;
      color: var(--fg, #e4e4e7);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1 1 0%;
      min-width: 0;
      max-width: 100%;
      display: block;
    }

    .activity-chevron {
      color: var(--muted, #71717a);
      font-size: 13px;
      flex-shrink: 0;
      transition: transform 0.12s ease;
      line-height: 1;
    }

    .activity-row.expanded .activity-chevron {
      transform: rotate(90deg);
      color: var(--fg, #ffffff);
    }

    /* Expandable Command Output Body */
    .activity-cmd-output {
      margin: 0;
      padding: 7px 10px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-top: none;
      border-radius: 0 0 5px 5px;
      font-family: var(--font-mono, 'JetBrains Mono', Consolas, monospace);
      font-size: 10.5px;
      color: #d4d4d8;
      max-height: 200px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
  `;
}
