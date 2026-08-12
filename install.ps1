# ─────────────────────────────────────────────────────────────────────────────
# Andromity — Global Installer for Windows (PowerShell)
#
# What this does:
#   1. Checks for Python 3.11+
#   2. Installs pipx if missing (pipx installs CLI tools globally in isolated
#      virtualenvs, so 'andromity' works from ANY folder in any terminal)
#   3. Installs andromity via pipx
#   4. Ensures pipx's bin dir is on the system PATH permanently
#
# Usage (run in PowerShell as normal user — no admin needed):
#   irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex
#   — or —
#   .\install.ps1
#
# If you get an execution policy error, run first:
#   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

function Write-Info    { Write-Host "[andromity] $args" -ForegroundColor Cyan }
function Write-Success { Write-Host "✓ $args" -ForegroundColor Green }
function Write-Warn    { Write-Host "⚠  $args" -ForegroundColor Yellow }
function Write-Fail    { Write-Host "✗ $args" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  ✦ Andromity Installer" -ForegroundColor Cyan -NoNewline
Write-Host " — The AI coding agent that never clocks out." -ForegroundColor White
Write-Host ""

# ── 1. Check Python ────────────────────────────────────────────────────────

$python = $null
foreach ($cmd in @("python3.12", "python3.11", "python3.13", "python3", "python")) {
    try {
        $ver = & $cmd -c "import sys; print(sys.version_info[:2])" 2>$null
        $ok  = & $cmd -c "import sys; sys.exit(0 if sys.version_info>=(3,11) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) { $python = $cmd; break }
    } catch {}
}

if (-not $python) {
    Write-Fail "Python 3.11 or newer is required but not found.`n  Download from https://python.org`n  Make sure to check 'Add Python to PATH' during install."
}

$pyVersion = & $python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
Write-Info "Found Python $pyVersion at $(where.exe $python 2>$null | Select-Object -First 1)"

# ── 2. Install pipx ────────────────────────────────────────────────────────

$pipxInstalled = $null -ne (Get-Command pipx -ErrorAction SilentlyContinue)

if (-not $pipxInstalled) {
    Write-Warn "pipx not found — installing it now..."

    # Try winget first (Windows 11 / modern Windows 10), then pip
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        try {
            winget install -e --id Python.pipx --accept-source-agreements --accept-package-agreements
            $pipxInstalled = $true
        } catch {
            Write-Warn "winget install failed, falling back to pip..."
        }
    }

    if (-not $pipxInstalled) {
        & $python -m pip install --user pipx
        # Add user Scripts dir to PATH for this session
        $userBase = & $python -c "import site; print(site.getusersitepackages())"
        $userScripts = Join-Path (Split-Path $userBase -Parent) "Scripts"
        $env:PATH = "$userScripts;$env:PATH"
    }

    # Verify
    $pipxInstalled = $null -ne (Get-Command pipx -ErrorAction SilentlyContinue)
    if (-not $pipxInstalled) {
        Write-Fail "pipx installation failed.`n  Install manually: pip install --user pipx`n  Then run: python -m pipx ensurepath"
    }
    Write-Success "pipx installed"
} else {
    Write-Info "pipx already installed at $(where.exe pipx | Select-Object -First 1)"
}

# ── 3. Install andromity ───────────────────────────────────────────────────

Write-Info "Installing andromity..."

$alreadyInstalled = (& pipx list 2>$null) -match "andromity"
if ($alreadyInstalled) {
    pipx upgrade andromity
    Write-Success "andromity upgraded to latest version"
} else {
    pipx install andromity
    Write-Success "andromity installed"
}

# ── 4. Ensure pipx bin dir is on PATH permanently ─────────────────────────

& pipx ensurepath 2>$null

# ── 5. Verify ─────────────────────────────────────────────────────────────

Write-Host ""
$andromityCmd = Get-Command andromity -ErrorAction SilentlyContinue
if ($andromityCmd) {
    Write-Success "andromity is ready at $($andromityCmd.Source)"
    Write-Host ""
    Write-Host "  Usage:" -ForegroundColor White
    Write-Host "    cd your-project" -ForegroundColor Gray
    Write-Host "    andromity" -ForegroundColor Gray
    Write-Host ""
} else {
    Write-Warn "andromity installed but not yet on PATH in this session."
    Write-Host ""
    Write-Host "  Restart your terminal, or run:" -ForegroundColor White
    Write-Host "    `$env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','User')" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Then type 'andromity' from any folder." -ForegroundColor White
    Write-Host ""
}
