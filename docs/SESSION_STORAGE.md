# Session storage

Chats, messages, usage, plans, rollback records, and session settings are stored in `andromity.db` in the Andromity configuration directory. Session saves no longer create JSON snapshots in the `sessions/` directory. The TUI, IDE server, and usage tracker read SQLite.

On the first history access after upgrading, legacy `sessions/<project>/<id>.json` files are imported once per database. Existing SQLite history takes precedence. The import and its completion marker are committed together, so a database failure can be retried without a partial migration. Unreadable snapshots are logged and preserved for manual recovery.

Legacy files remain untouched as backups. After the import, normal history queries and deletion never scan them again. `Session.load(path)` remains available for explicit legacy imports. Configuration, credentials, MCP settings, and other JSON files are unaffected.
