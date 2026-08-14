#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Andromity — Global Installer for Linux & macOS
#
# What this does:
#   1. Checks for Python 3.11+
#   2. Installs pipx if missing (pipx installs CLI tools globally in isolated
#      virtualenvs, so 'andromity' works from ANY folder without activating
#      a venv or worrying about dependency conflicts)
#   3. Installs andromity via pipx
#   4. Ensures ~/.local/bin is on PATH
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/agenticmarket/andromity/main/install.sh | bash
#   — or —
#   bash install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BOLD="\033[1m"
CYAN="\033[36m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

info()    { echo -e "${CYAN}${BOLD}[andromity]${RESET} $*"; }
success() { echo -e "${GREEN}${BOLD}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}${BOLD}⚠${RESET}  $*"; }
error()   { echo -e "${RED}${BOLD}✗${RESET} $*" >&2; exit 1; }

echo ""
echo -e "${CYAN}${BOLD}  ✦ Andromity Installer${RESET}"
echo -e "  ${BOLD}The AI coding agent that never clocks out.${RESET}"
echo ""

# ── 1. Check Python ────────────────────────────────────────────────────────

PYTHON=""
for py in python3.12 python3.11 python3.13 python3; do
    if command -v "$py" &>/dev/null; then
        ver=$("$py" -c 'import sys; print(sys.version_info[:2])')
        if "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' 2>/dev/null; then
            PYTHON="$py"
            break
        fi
    fi
done

if [ -z "$PYTHON" ]; then
    error "Python 3.11 or newer is required but not found.\n  Install it from https://python.org or via your package manager:\n    Ubuntu/Debian: sudo apt install python3.12\n    macOS:         brew install python@3.12"
fi

PY_VERSION=$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
info "Found Python $PY_VERSION at $(which "$PYTHON")"

# ── 2. Install pipx ────────────────────────────────────────────────────────

if ! command -v pipx &>/dev/null; then
    warn "pipx not found — installing it now..."

    OS="$(uname -s)"
    if [ "$OS" = "Darwin" ] && command -v brew &>/dev/null; then
        brew install pipx
    elif command -v apt-get &>/dev/null; then
        sudo apt-get install -y pipx 2>/dev/null || "$PYTHON" -m pip install --user pipx
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y pipx 2>/dev/null || "$PYTHON" -m pip install --user pipx
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm python-pipx 2>/dev/null || "$PYTHON" -m pip install --user pipx
    else
        "$PYTHON" -m pip install --user pipx
    fi

    # Ensure pipx itself is on PATH
    "$PYTHON" -m pipx ensurepath --force 2>/dev/null || true
    export PATH="$HOME/.local/bin:$PATH"

    if ! command -v pipx &>/dev/null; then
        error "pipx installation failed. Please install it manually:\n  pip install --user pipx\n  python3 -m pipx ensurepath"
    fi

    success "pipx installed"
else
    info "pipx already installed at $(which pipx)"
fi

# ── 3. Install andromity ───────────────────────────────────────────────────

info "Installing andromity..."

# Upgrade if already installed, otherwise fresh install
if pipx list 2>/dev/null | grep -q "andromity"; then
    pipx upgrade andromity
    success "andromity upgraded to latest version"
else
    pipx install andromity
    success "andromity installed"
fi

# ── 4. Ensure ~/.local/bin is on PATH permanently ─────────────────────────

SHELL_NAME="$(basename "${SHELL:-bash}")"
PROFILE_FILE=""
case "$SHELL_NAME" in
    bash)
        [ -f "$HOME/.bashrc" ]            && PROFILE_FILE="$HOME/.bashrc"
        [ -f "$HOME/.bash_profile" ]      && PROFILE_FILE="$HOME/.bash_profile"
        ;;
    zsh)
        PROFILE_FILE="$HOME/.zshrc"
        ;;
    fish)
        PROFILE_FILE="$HOME/.config/fish/config.fish"
        ;;
esac

PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
if [ -n "$PROFILE_FILE" ] && ! grep -qF '.local/bin' "$PROFILE_FILE" 2>/dev/null; then
    echo "" >> "$PROFILE_FILE"
    echo "# Added by Andromity installer" >> "$PROFILE_FILE"
    echo "$PATH_LINE" >> "$PROFILE_FILE"
    warn "Added ~/.local/bin to PATH in $PROFILE_FILE"
    warn "Run: source $PROFILE_FILE  (or open a new terminal)"
fi

export PATH="$HOME/.local/bin:$PATH"

# ── 5. Verify & Launch ──────────────────────────────────────────────────────

echo ""
if command -v andromity &>/dev/null; then
    success "andromity is ready at $(which andromity)"
    echo ""
    info "Starting Andromity automatically..."
    sleep 1
    exec andromity
else
    warn "andromity installed but not yet on PATH in this shell session."
    echo ""
    echo -e "  Run one of:"
    echo -e "    source ~/.bashrc           # bash"
    echo -e "    source ~/.zshrc            # zsh"
    echo -e "    exec \$SHELL               # reload current shell"
    echo ""
fi
