#!/bin/sh
set -e

# If no arguments provided, launch the default interactive TUI
if [ $# -eq 0 ]; then
    exec /usr/bin/tini -- andromity
fi

# If first argument is a known subcommand or CLI flag, run andromity with those arguments
case "$1" in
    run|tui|server|update|--help|-h|--version|-v)
        exec /usr/bin/tini -- andromity "$@"
        ;;
    andromity|andromity-ci)
        exec /usr/bin/tini -- "$@"
        ;;
    *)
        # Allow passing arbitrary commands (e.g., bash, sh, python)
        exec /usr/bin/tini -- "$@"
        ;;
esac
