# ─────────────────────────────────────────────────────────────────────────────
# Andromity -- Global Installer for Windows (PowerShell)
#
# What this does:
#   1. Checks for Python 3.11+
#   2. Installs pipx if missing (pipx installs CLI tools globally in isolated
#      virtualenvs, so 'andromity' works from ANY folder in any terminal)
#   3. Installs andromity via pipx (falls back to pip --user if pipx fails)
#   4. Ensures the install directory is on the system PATH permanently
#
# Usage (run in PowerShell as normal user -- no admin needed):
#   irm https://raw.githubusercontent.com/agenticmarket/andromity/main/install.ps1 | iex
#   -- or --
#   .\install.ps1
#
# If you get an execution policy error, run first:
#   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
# ─────────────────────────────────────────────────────────────────────────────

# Use Continue (not Stop) so native command stderr never crashes the script.
# We handle errors explicitly where needed.
$ErrorActionPreference = "Continue"

function Write-Info    { Write-Host "[andromity] $args" -ForegroundColor Cyan }
function Write-Success { Write-Host "[OK] $args" -ForegroundColor Green }
function Write-Warn    { Write-Host "[WARN] $args" -ForegroundColor Yellow }
function Write-Fail    { Write-Host "[FAIL] $args" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  Andromity Installer" -ForegroundColor Cyan -NoNewline
Write-Host " -- The AI coding agent that never clocks out." -ForegroundColor White
Write-Host ""

# ── 1. Check Python ────────────────────────────────────────────────────────

$python = $null
foreach ($cmd in @("python3.12", "python3.11", "python3.13", "python3", "python")) {
    try {
        $null = & $cmd -c "import sys; sys.exit(0 if sys.version_info>=(3,11) else 1)" 2>$null
        if ($LASTEXITCODE -eq 0) { $python = $cmd; break }
    } catch {}
}

if (-not $python) {
    Write-Fail "Python 3.11 or newer is required but not found.`n  Download from https://python.org`n  Make sure to check 'Add Python to PATH' during install."
}

$pyVersion = & $python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
$pyPath = (& $python -c "import sys; print(sys.executable)")
Write-Info "Found Python $pyVersion at $pyPath"

# ── 2. Install pipx ────────────────────────────────────────────────────────

$pipxCmd = Get-Command pipx -ErrorAction SilentlyContinue

if (-not $pipxCmd) {
    Write-Warn "pipx not found -- installing it now..."

    # Try winget first (Windows 11 / modern Windows 10), then pip
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    $pipxInstalled = $false

    if ($winget) {
        try {
            $null = winget install -e --id Python.pipx --accept-source-agreements --accept-package-agreements 2>&1
            if ($LASTEXITCODE -eq 0) { $pipxInstalled = $true }
        } catch {}
    }

    if (-not $pipxInstalled) {
        Write-Info "Installing pipx via pip..."
        & $python -m pip install --user pipx --quiet
        # Add the user Scripts directory to PATH for this session
        $userScripts = & $python -c "import site, os; print(os.path.join(os.path.dirname(site.getusersitepackages()), 'Scripts'))"
        if ($userScripts -and (Test-Path $userScripts)) {
            $env:PATH = "$userScripts;$env:PATH"
        }
        # Also try the pipx default bin dir
        $pipxBin = "$env:USERPROFILE\.local\bin"
        if (Test-Path $pipxBin) { $env:PATH = "$pipxBin;$env:PATH" }
    }

    # Verify pipx is now reachable
    $pipxCmd = Get-Command pipx -ErrorAction SilentlyContinue
    if (-not $pipxCmd) {
        Write-Warn "pipx not found on PATH after install -- will use pip as fallback."
    } else {
        Write-Success "pipx installed"
    }
} else {
    Write-Info "pipx found at $($pipxCmd.Source)"
}

# ── 3. Install andromity ───────────────────────────────────────────────────

Write-Info "Installing andromity..."

$installedViaPipx = $false

# Try pipx first (preferred: isolated environment, cleaner upgrades)
$pipxNow = Get-Command pipx -ErrorAction SilentlyContinue
if ($pipxNow) {
    # Check if already installed; pipx list may write to stderr if nothing installed -- capture both streams
    $pipxList = & pipx list 2>&1 | Out-String
    $alreadyInstalled = $pipxList -match "andromity"

    if ($alreadyInstalled) {
        Write-Info "Upgrading existing andromity installation..."
        $null = & pipx upgrade andromity 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Success "andromity upgraded to latest version"
            $installedViaPipx = $true
        } else {
            Write-Warn "pipx upgrade failed, trying reinstall..."
            $null = & pipx uninstall andromity 2>&1
        }
    }

    if (-not $installedViaPipx) {
        $installOut = & pipx install andromity 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) {
            Write-Success "andromity installed via pipx"
            $installedViaPipx = $true
        } else {
            Write-Warn "pipx install failed. Falling back to pip..."
        }
    }
}

# Fallback: install via pip --user (works on all Python setups)
if (-not $installedViaPipx) {
    Write-Info "Installing via pip (user install)..."
    & $python -m pip install --user andromity --quiet
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Installation failed. Please report this at: https://github.com/agenticmarket/andromity/issues"
    }
    Write-Success "andromity installed via pip"

    # Add user Scripts to PATH for this session and permanently
    $userScripts = & $python -c "import site, os; print(os.path.join(os.path.dirname(site.getusersitepackages()), 'Scripts'))"
    if ($userScripts -and (Test-Path $userScripts)) {
        $env:PATH = "$userScripts;$env:PATH"
        $currentUserPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
        if ($currentUserPath -notlike "*$userScripts*") {
            [System.Environment]::SetEnvironmentVariable("PATH", "$userScripts;$currentUserPath", "User")
            Write-Info "Added $userScripts to your PATH permanently."
        }
    }
}

# ── 4. Ensure pipx bin dir is on PATH permanently ─────────────────────────

if ($installedViaPipx) {
    $null = & pipx ensurepath 2>&1
    # Refresh PATH in this session from the updated user environment variable
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "User") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
}

# ── 5. Verify & Launch ──────────────────────────────────────────────────────

Write-Host ""
$andromityCmd = Get-Command andromity -ErrorAction SilentlyContinue
if ($andromityCmd) {
    Write-Success "andromity is ready at $($andromityCmd.Source)"
    Write-Host ""
    Write-Info "Starting Andromity automatically..."
    Start-Sleep -Seconds 1
    & andromity
} else {
    Write-Warn "andromity was installed but is not yet on PATH in this terminal session."
    Write-Host ""
    Write-Host "  Open a NEW terminal window, then run:" -ForegroundColor White
    Write-Host "    andromity" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Or refresh PATH in this window with:" -ForegroundColor White
    Write-Host "    `$env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','User') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','Machine')" -ForegroundColor Gray
    Write-Host ""
}


