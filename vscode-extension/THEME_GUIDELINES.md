# Andromity Design System & Theme Guidelines

> **Philosophy**: *"Design is how it works, not just how it looks. Form follows function."*

The Andromity interface for VS Code is engineered to feel exceptionally fast, responsive, and distraction-free. It avoids generic "AI slop" — no decorative rainbow gradients, no distracting shimmer loops, and no oversized cartoonish cards. Every pixel, margin, and micro-animation serves a functional purpose for developers doing serious engineering.

---

## 1. Visual Identity & Core Values

1. **Information-Dense, Never Cluttered**: Developers value line economy. Every element has tight, consistent margins. Metadata is subtle and legible.
2. **True Native Dark Mode**: Integrates deeply with VS Code theme CSS variables (`--vscode-*`), enhanced with dark zinc/slate surfaces (`#18181b`, `#1e1e1e`, `#27272a`).
3. **Restrained Color Hierarchy**:
   - **Signature Brand Accent**: `#09f994` (Emerald Glow) — represents agent readiness, completed work, active execution.
   - **System Accent**: `#38bdf8` / `#007fd4` (Electric Sky Blue) — active focus, hyperlinks, tool sequences.
   - **Reasoning / Cognitive**: `#bc8cff` (Muted Violet) — model thinking phases, skills, subagents.
   - **Warning / Alert**: `#d29922` / `#e3b341` (Warm Amber) — permission prompts, caution banners.
   - **Danger / Destructive**: `#f85149` (Coral Crimson) — cancel, errors, rollbacks.
   - **Muted Foreground**: `#888888` / `#71717a` — timestamps, token costs, secondary labels.
4. **No "AI Slop"**:
   - No gratuitous glitter icons or decorative particle effects.
   - No low-contrast text on bright backgrounds.
   - Modals and permission prompts present explicit file paths, shell commands, and risk levels without euphemisms.

---

## 2. Color Palette & Token System

| Token | Hex / Fallback | Usage |
| :--- | :--- | :--- |
| `--bg` | `var(--vscode-sideBar-background, #18181b)` | Primary panel background |
| `--card-bg` | `var(--vscode-editor-background, #1e1e1e)` | Cards, tool containers, code blocks |
| `--input-bg` | `var(--vscode-input-background, #252526)` | Textarea and input controls |
| `--input-border` | `var(--vscode-input-border, #3c3c3c)` | Idle input borders |
| `--border` | `rgba(255, 255, 255, 0.08)` | Subtle dividing borders |
| `--border-strong` | `rgba(255, 255, 255, 0.16)` | Focused or elevated borders |
| `--accent-green` | `#09f994` | Andromity green, success badges, active glow |
| `--accent-cyan` | `#38bdf8` | Tool execution, links, navigation highlights |
| `--accent-purple` | `#bc8cff` | Thinking blocks, skills, subagent cards |
| `--accent-warn` | `#d29922` | Safe mode approvals, warnings |
| `--accent-danger` | `#f85149` | Stop button, failure tags, destructive alerts |

---

## 3. Typography & Spacing Scale

- **UI Font**: `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', sans-serif`
- **Code & Mono Font**: `'JetBrains Mono', 'Geist Mono', Consolas, monospace`
- **Scale**:
  - `10px - 10.5px`: Micro tags, tool call counts, duration badges (`letter-spacing: 0.2px`)
  - `11.5px - 12px`: Secondary labels, thinking text, metadata timestamps
  - `12.5px - 13px`: Standard body, chat prompts, assistant response markdown
  - `14px - 16px`: Section headers, modal titles
  - `24px - 28px`: Hero headlines (zero-state only)
- **Line Heights**:
  - Headings: `1.2`
  - Body: `1.55 - 1.6`
  - Code blocks: `1.5`

---

## 4. Component Design Patterns

### 4.1. Textarea & Ambient Generation Aura
- The `.prompt-box` sits at the base of the panel with a subtle border and high-contrast control pills.
- **Ambient Generation Aura (`.is-generating`)**:
  - When the active session is executing or streaming, `.prompt-box` displays a gentle, breathing aura:
    ```css
    .prompt-box.is-generating {
      border-color: rgba(9, 249, 148, 0.45);
      box-shadow: 0 0 16px rgba(9, 249, 148, 0.12), inset 0 0 10px rgba(9, 249, 148, 0.04);
      animation: promptAuraGlow 2.4s ease-in-out infinite alternate;
    }
    ```
  - The aura terminates immediately when the turn ends, is cancelled, or when the user switches to an idle session.

### 4.2. Thinking Blocks
- Collapsible inline thought container with a dashed violet left border (`rgba(188, 140, 255, 0.25)`).
- **Auto-scroll behavior**: As thinking deltas stream in, the inner box smoothly auto-scrolls to the newest thoughts.
- **Scrollbar**: Completely hidden via `scrollbar-width: none; ::-webkit-scrollbar { display: none; }` to maintain a distraction-free, fluid reading experience.

### 4.3. Tool Sequences & Reload Ordering
- Consecutive tool calls are grouped into a collapsible sequence card (`[wrench] N tools · worked`).
- When reloading history, tool sequences retain their exact chronological position between text blocks rather than being pushed to the end.

### 4.4. Action Pills & File Edit Badges
- Displayed immediately below the assistant's written answer (prior to the footer).
- **File Edited Chip (`.file-edited-chip`)**:
  - Shows file path with a subtle pencil icon and a "Diff" badge.
  - Clicking opens the interactive diff in VS Code.
- **Plan Status Pill (`.plan-ready-pill`)**:
  - Shows plan title and completed steps count `(N/Total done)`.
  - Clicking opens the full Plan editor tab.

### 4.5. Floating "Scroll to Bottom" (FAB)
- Floats at the bottom center of the chat viewport (`bottom: 12px`).
- Appears with a smooth fade-in when user scrolls up > 120px.
- Features a clean downward chevron and an unread dot badge when new streaming chunks arrive while scrolled up.

### 4.6. Tool Approval & Permission Governance Cards
- Clear, unambiguous layout:
  - Header: Mode badge (`SAFE MODE`), risk tag.
  - Body: Exact command or target file path formatted in a crisp monospace container.
  - Actions: High-contrast "Approve" (green) and "Deny" (muted/danger) buttons.
  - No deceptive language; always disclose full command line and potential side effects.

### 4.7. Conversation Timeline
- A clean timeline flyout providing an interactive turn outline:
  - User query summary.
  - Milestones (tools executed, files modified, plan progress).
  - 1-click jump to any turn in long conversations.
