# Git review and rollback audit

Changes Review compares HEAD with the files on disk, including staged and unstaged edits. In a repository without commits, the base is an empty tree. Native diffs use the same base; the index is available only when explicitly requested.

Fixed issues:

- Removed the extension fallback that deleted files when Git revert failed or the daemon was disconnected.
- Revert validates workspace trust, repository boundaries, Git metadata, directories, merge conflicts, and active agent turns. Unsaved editors must be saved or closed first.
- Git status and statistics use zero-terminated paths, preserving spaces and Unicode filenames. Status badges distinguish added, deleted, renamed, untracked, modified, and conflicting files.
- Preview and line counts use the same baseline. Empty and binary files have explicit notices; omitted counts are marked rather than fabricated.
- Refresh invalidates cached diffs. Late replies cannot replace a newer file selection. Empty turn scopes stay separate from workspace changes.
- Removed a misleading Expand control that hid the gap without loading context. Open context opens the native diff.
- Turn undo keeps HEAD and the staging area intact. It restores the recorded before/after change set, checks current file hashes using Git filters, and preserves the conversation when restoration fails.
- Removed the fallback that selected an unrelated checkpoint from the shared snapshot branch. Checkpoints are matched by session turn index.
- Repository subfolder workspaces keep review and rollback inside the trusted workspace.
- Single-file Git commands use literal paths so bracketed filenames cannot match other files. Turn review includes shell-created files from the checkpoint delta.

Compatibility: older checkpoints without a recorded after-state cannot safely verify later edits. Undo refuses their file restoration and preserves the conversation. Review or discard individual files instead.

Validation: real temporary Git repositories cover staged and unstaged changes, CRLF, new/deleted files, boundaries, trust, active runs, rollback conflicts, and staging preservation. Extension tests cover refresh, stale replies, scope changes, notices, native actions, and failure behavior. The focused Python run excluded four existing asynchronous cases because this sandbox cannot create the Windows event-loop socket; synchronous RPC regressions exercise the changed restoration paths. A live VS Code Extension Host visual check remains a release check.

Release check plan:

1. Reload the extension and restart the daemon. In a temporary repository, review mixed staged/unstaged changes, a deletion, a new binary file, and a rename in both themes and diff modes.
2. Refresh after editing the selected file and switch rapidly between files. Confirm the latest preview, counts, and scope stay aligned.
3. Complete a turn, make a later manual edit, then try undo. Confirm it refuses the conflict without removing conversation messages. In a fresh turn, confirm undo preserves the staged index.
4. Exercise discard with the daemon disconnected and while another session is running. Confirm the UI reports the failure and keeps the file.
