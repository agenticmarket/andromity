# Session UI reliability

Opening a session in an editor tab now installs saved history and a server snapshot of active tools, partial output, pending permissions/questions/plans, and running background commands. Notifications carry a session sequence; events newer than the snapshot are replayed after loading. An older response cannot replace a newer session selection.

Both chat surfaces share approval/question transport. Successful responses dismiss the matching card everywhere; failed transport preserves the card and answer for retry. Approving a command for a session or permanently does not grant workspace trust or switch permission mode. Remembered commands include their arguments rather than granting every command from the executable. Controls only offer remembered scopes that the server supports.

The tab now handles New, model/provider selection, questions, command logs/stop, model pins, rename, file attachment, trust, and provider onboarding. The session picker is bounded to 560 pixels and the viewport height. Process actions include the owning session and respect trust. Process lookup from core tools no longer falls back into another project when a session is attached.

The system prompt now requires completion within authorized scope, preserving unrelated changes, regression tests for logic changes, appropriate builds/type checks, working accessible controls, and accurate reporting of verification. Required trust and approval boundaries still apply.

Verification covers snapshot isolation, prompt resolution, stale loads, command ownership, approval scope, tab actions, generated webview behavior, provider credential isolation, and queue state transitions. Live VS Code Extension Host testing and real provider calls remain release checks; they are not implied by unit tests.

Release check plan:

1. With a tool permission or question pending, pop out the chat, switch away/back, and answer from either surface. Verify one execution/answer and dismissal in both surfaces.
2. Repeat during streaming, parallel tool execution, and plan approval. Switch rapidly between two active sessions and confirm no prompts or tools cross sessions.
3. Start background commands in two sessions. Open their logs, pop out, stop one, and confirm only its task changes. Repeat with duplicate process labels in separate projects.
4. Use New, rename, model/provider selection, pins, attachment, and provider setup from the tab in narrow/wide layouts and both themes. Verify the next request uses the selected provider and model.
5. Disconnect while answering, reconnect, and retry. Confirm the unanswered card and draft remain available. Validate queue/steer delivery at a completed tool batch and cancellation without a partially written file.

Follow-up audit: legacy process RPC calls without a session retain compatibility and may resolve duplicate labels ambiguously. Plan: migrate remaining clients to session-qualified calls, add deprecation diagnostics without command contents, then reject ambiguous legacy labels once compatibility requirements permit. New extension calls are session-qualified.
