import * as cp from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";
import { RpcClient } from "./RpcClient.js";

export interface PythonStatus {
  installed: boolean;
  path: string;
  version?: string;
  isVersionSupported: boolean;
  hasAndromityPackage: boolean;
  errorMessage?: string;
}

export class PythonBridge {
  private _process: cp.ChildProcessWithoutNullStreams | null = null;
  private _socket: net.Socket | null = null;
  private _client: RpcClient | null = null;
  private _outputChannel: vscode.OutputChannel;
  private _isDisposed = false;
  private _reconnectAttempts = 0;
  private _maxReconnectAttempts = 5;
  private _clientCallbacks: ((client: RpcClient) => void)[] = [];
  private _lastPythonStatus: PythonStatus | null = null;
  private _packageInstallAttempted = false;
  private _lastExitWasPackageError = false;

  /**
   * Look for a platform-specific pre-built binary bundled inside the extension,
   * exactly the same way kilo.exe is shipped inside kilo-code's extension.
   *
   * Layout (mirrors what kilo-code uses):
   *   <extension-root>/bin/win32-x64/andromity-server.exe
   *   <extension-root>/bin/darwin-x64/andromity-server
   *   <extension-root>/bin/linux-x64/andromity-server
   */
  private _findBundledBinary(): string | null {
    const platform = process.platform;  // 'win32' | 'darwin' | 'linux'
    const arch = process.arch;           // 'x64' | 'arm64'
    const exeName = platform === "win32" ? "andromity-server.exe" : "andromity-server";

    // Locate extension root directory by walking up from __dirname
    const searchDirs: string[] = [];
    
    // 1. Walk up from __dirname looking for folder with bin/
    let curr = __dirname;
    for (let i = 0; i < 5; i++) {
      searchDirs.push(curr);
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }

    // 2. Check workspace folders
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      searchDirs.push(wf.uri.fsPath);
      searchDirs.push(path.join(wf.uri.fsPath, "vscode-extension"));
    }

    for (const base of searchDirs) {
      const candidate = path.join(base, "bin", `${platform}-${arch}`, exeName);
      if (fs.existsSync(candidate)) {
        this._outputChannel.appendLine(`[Andromity] ✓ Bundled binary found: ${candidate}`);
        return candidate;
      }
    }

    this._outputChannel.appendLine(`[Andromity] No bundled binary found for ${platform}-${arch} — falling back to Python.`);
    return null;
  }


  constructor(outputChannel: vscode.OutputChannel) {
    this._outputChannel = outputChannel;
  }

  public onClientReady(callback: (client: RpcClient) => void) {
    this._clientCallbacks.push(callback);
    if (this._client) {
      try {
        callback(this._client);
      } catch (e) {
        console.error("[Andromity] Error in immediate onClientReady callback:", e);
      }
    }
  }

  private _notifyClientReady(client: RpcClient) {
    for (const cb of this._clientCallbacks) {
      try {
        cb(client);
      } catch (e) {
        console.error("[Andromity] Error in onClientReady callback:", e);
      }
    }
  }

  public getLastPythonStatus(): PythonStatus | null {
    return this._lastPythonStatus;
  }

  public async checkPythonStatus(): Promise<PythonStatus> {
    const pythonPath = await this._resolvePythonPath();
    const projectRoot = this._findProjectRoot();
    const cwd = projectRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
    };

    const srcDir = projectRoot ? path.join(projectRoot, "src") : path.join(cwd, "src");
    if (fs.existsSync(srcDir)) {
      env.PYTHONPATH = env.PYTHONPATH ? `${srcDir}${path.delimiter}${env.PYTHONPATH}` : srcDir;
    }

    try {
      const versionOutput = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const proc = cp.spawn(pythonPath, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"], {
          cwd,
          env,
          windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => { stdout += d.toString(); });
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("error", (err) => { resolve({ code: -1, stdout, stderr: err.message }); });
        proc.on("exit", (code) => { resolve({ code: code ?? -1, stdout, stderr }); });
      });

      const cleanOut = versionOutput.stdout.trim();
      if (versionOutput.code !== 0 || !cleanOut || cleanOut.includes("Python was not found")) {
        const status: PythonStatus = {
          installed: false,
          path: pythonPath,
          isVersionSupported: false,
          hasAndromityPackage: false,
          errorMessage: versionOutput.stderr.trim() || versionOutput.stdout.trim() || "Python executable not functional",
        };
        this._lastPythonStatus = status;
        return status;
      }

      const version = cleanOut;
      const parts = version.split(".").map(Number);
      const isVersionSupported = (parts[0] === 3 && parts[1] >= 11) || parts[0] > 3;

      // Probe whether andromity server module is importable
      const pkgCheck = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const proc = cp.spawn(pythonPath, ["-c", "import andromity.server; print('ok')"], {
          cwd,
          env,
          windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => { stdout += d.toString(); });
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        proc.on("error", (err) => { resolve({ code: -1, stdout, stderr: err.message }); });
        proc.on("exit", (code) => { resolve({ code: code ?? -1, stdout, stderr }); });
      });

      const hasAndromityPackage = pkgCheck.code === 0 && pkgCheck.stdout.includes("ok");

      const status: PythonStatus = {
        installed: true,
        path: pythonPath,
        version,
        isVersionSupported,
        hasAndromityPackage,
      };
      this._lastPythonStatus = status;
      return status;
    } catch (e: any) {
      const status: PythonStatus = {
        installed: false,
        path: pythonPath,
        isVersionSupported: false,
        hasAndromityPackage: false,
        errorMessage: e.message,
      };
      this._lastPythonStatus = status;
      return status;
    }
  }

  public async start(): Promise<RpcClient> {
    const config = vscode.workspace.getConfiguration("andromity");
    const serverPort = config.get<number>("serverPort", 0);

    if (serverPort > 0) {
      return this._connectTcp(serverPort);
    } else {
      return this._startSubprocess();
    }
  }

  private async _connectTcp(port: number, host = "127.0.0.1"): Promise<RpcClient> {
    this._outputChannel.appendLine(`[Andromity] Connecting to TCP server on ${host}:${port}...`);

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        this._outputChannel.appendLine(`[Andromity] Connected to TCP server.`);
        this._socket = socket;

        const client = new RpcClient((msg) => {
          socket.write(msg);
        });

        socket.on("data", (data) => {
          client.handleIncomingMessage(data.toString("utf-8"));
        });

        socket.on("error", (err) => {
          this._outputChannel.appendLine(`[Andromity TCP Error] ${err.message}`);
        });

        socket.on("close", () => {
          this._outputChannel.appendLine(`[Andromity] TCP connection closed.`);
          client.close("Andromity TCP connection closed.");
          this._client = null;
        });

        this._client = client;
        this._notifyClientReady(client);
        resolve(client);
      });

      socket.on("error", (err) => {
        this._outputChannel.appendLine(`[Andromity TCP Connection Failed] ${err.message}`);
        reject(err);
      });
    });
  }

  /** Install the andromity package into the given Python environment. */
  private async _installPackage(pythonPath: string, cwd: string, srcDir: string | null): Promise<boolean> {
    this._outputChannel.appendLine(`[Andromity] Auto-installing 'andromity' package...`);

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Andromity: Setting up AI Engine",
        cancellable: false,
      },
      async (progress) => {
        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          PYTHONUNBUFFERED: "1",
          PYTHONIOENCODING: "utf-8",
        };
        if (srcDir) {
          env.PYTHONPATH = env.PYTHONPATH ? `${srcDir}${path.delimiter}${env.PYTHONPATH}` : srcDir;
        }

        // Use workspace install if we have pyproject.toml, else PyPI
        const hasPyproject = fs.existsSync(path.join(cwd, "pyproject.toml"));
        const pipArgs = hasPyproject
          ? ["-m", "pip", "install", ".", "--quiet", "--no-warn-script-location"]
          : ["-m", "pip", "install", "--upgrade", "andromity", "--quiet", "--no-warn-script-location"];

        const source = hasPyproject ? "workspace" : "PyPI";
        progress.report({ message: `Installing from ${source}...` });
        this._outputChannel.appendLine(`[Andromity] pip install (${source}) cwd=${cwd}`);

        const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
          const proc = cp.spawn(pythonPath, pipArgs, {
            cwd,
            env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stderr = "";
          proc.stdout?.on("data", (d: Buffer) => { /* quiet */ });
          proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
          proc.on("error", (err) => resolve({ code: -1, stderr: err.message }));
          proc.on("exit", (code) => resolve({ code: code ?? -1, stderr }));
        });

        if (result.code === 0) {
          progress.report({ message: "Verifying..." });
          this._outputChannel.appendLine(`[Andromity] Installation finished.`);
          return true;
        }

        const errSummary = result.stderr
          .split("\n")
          .filter((l) => !l.includes("WARNING") && !l.includes("not on PATH") && l.trim())
          .join("\n");
        this._outputChannel.appendLine(`[Andromity] pip failed (exit ${result.code}): ${errSummary}`);
        return false;
      }
    );
  }

  /**
   * Find the andromity project root (the folder containing pyproject.toml or src/andromity).
   * Walks up from this extension's directory, open workspace folders, and process.cwd().
   */
  private _findProjectRoot(): string | null {
    const isProjectRoot = (dir: string) => {
      try {
        return (
          fs.existsSync(path.join(dir, "pyproject.toml")) ||
          fs.existsSync(path.join(dir, "src", "andromity", "__init__.py"))
        );
      } catch {
        return false;
      }
    };

    // 1. Walk up from __dirname
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      if (isProjectRoot(dir)) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) { break; }
      dir = parent;
    }

    // 2. Check open workspace folders and their parents
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      const p = wf.uri.fsPath;
      if (isProjectRoot(p)) {
        return p;
      }
      const parent = path.dirname(p);
      if (isProjectRoot(parent)) {
        return parent;
      }
    }

    // 3. Check process.cwd() and its parent
    try {
      const cwd = process.cwd();
      if (isProjectRoot(cwd)) return cwd;
      const cwdParent = path.dirname(cwd);
      if (isProjectRoot(cwdParent)) return cwdParent;
    } catch {}

    return null;
  }

  /** Verify that andromity.server is importable in the given Python. Returns error message or null on success. */
  private async _verifyPackage(pythonPath: string, extraPythonPath?: string): Promise<{ ok: boolean; error: string }> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
    };
    if (extraPythonPath) {
      env.PYTHONPATH = env.PYTHONPATH
        ? `${extraPythonPath}${path.delimiter}${env.PYTHONPATH}`
        : extraPythonPath;
    }

    return new Promise((resolve) => {
      const proc = cp.spawn(
        pythonPath,
        ["-c", "import andromity.server; print('ok')"],
        { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      );
      let out = "";
      let err = "";
      proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
      proc.on("error", (e) => resolve({ ok: false, error: e.message }));
      proc.on("exit", (code) => {
        if (code === 0 && out.includes("ok")) {
          resolve({ ok: true, error: "" });
        } else {
          // Extract most useful error line (skip tracebacks)
          const errLine = err.split("\n").find((l) => l.startsWith("ModuleNotFoundError") || l.startsWith("ImportError") || l.includes("Error")) ?? err.trim().split("\n").pop() ?? "unknown error";
          resolve({ ok: false, error: errLine.trim() });
        }
      });
    });
  }

  private _isUsingBundledBinary = false;

  public isUsingBundledBinary(): boolean {
    return this._isUsingBundledBinary;
  }

  public isConnected(): boolean {
    return this._client !== null;
  }

  public getRunningPid(): number | undefined {
    return this._process?.pid;
  }

  public hasBundledBinary(): boolean {
    return this._findBundledBinary() !== null;
  }

  private async _startSubprocess(): Promise<RpcClient> {
    // ── Fast path: bundled binary (like kilo.exe) ────────────────────────────
    const bundledBin = this._findBundledBinary();
    if (bundledBin) {
      this._isUsingBundledBinary = true;
      this._outputChannel.appendLine(`[Andromity] Starting via bundled binary: ${bundledBin}`);
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
      };
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const client = this._spawnDaemon(bundledBin, ["--stdio"], cwd, env);
      this._client = client;
      this._reconnectAttempts = 0;
      this._notifyClientReady(client);
      return client;
    }

    this._isUsingBundledBinary = false;

    // ── Slow path: Python subprocess ─────────────────────────────────────────
    const status = await this.checkPythonStatus();

    // Resolve workspace/project root robustly
    const projectRoot = this._findProjectRoot();
    const cwd = projectRoot
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      ?? process.cwd();

    this._outputChannel.appendLine(`[Andromity] Project root: ${cwd} (pyproject.toml: ${projectRoot ? "found" : "not found"})`);


    if (!status.installed) {
      this._outputChannel.appendLine(`[Andromity] Python not found at: ${status.path}`);
      throw new Error(`Python executable not found at "${status.path}". Install Python 3.11+ or set 'andromity.pythonPath'.`);
    }

    if (!status.isVersionSupported) {
      this._outputChannel.appendLine(`[Andromity] Python ${status.version} too old (need 3.11+).`);
      throw new Error(`Python ${status.version} at "${status.path}" is too old. Andromity requires Python 3.11+.`);
    }

    const pythonPath = status.path;

    // ── Ensure andromity is importable ──────────────────────────────────────
    if (!status.hasAndromityPackage) {
      const srcDir = projectRoot ? path.join(projectRoot, "src") : null;
      const hasSrc = srcDir !== null && fs.existsSync(srcDir);

      // Step 1: Can we import directly via PYTHONPATH (workspace dev mode)?
      const wsCheck = await this._verifyPackage(pythonPath, hasSrc ? srcDir! : undefined);
      if (wsCheck.ok) {
        this._outputChannel.appendLine(`[Andromity] ✓ Package importable via workspace src/. No pip install needed.`);
      } else {
        this._outputChannel.appendLine(`[Andromity] Workspace check: ${wsCheck.error || "not found"}`);

        if (this._packageInstallAttempted) {
          this._outputChannel.appendLine(`[Andromity] Install already tried. Stopping.`);
          throw new Error(
            `Could not start Andromity. Run in terminal:\n  ${pythonPath} -m pip install andromity`
          );
        }

        this._packageInstallAttempted = true;

        // Step 2: Install
        const installed = await this._installPackage(pythonPath, cwd, hasSrc ? srcDir! : null);
        if (!installed) {
          throw new Error(`pip install failed. Run:\n  ${pythonPath} -m pip install andromity`);
        }

        // Step 3: Re-verify with same python + PYTHONPATH
        const postCheck = await this._verifyPackage(pythonPath, hasSrc ? srcDir! : undefined);
        if (!postCheck.ok) {
          this._outputChannel.appendLine(`[Andromity] Still not importable: ${postCheck.error}`);
          throw new Error(
            `Installed but not importable (${postCheck.error}).\nRun:\n  ${pythonPath} -m pip install andromity`
          );
        }

        this._packageInstallAttempted = false;
        this._outputChannel.appendLine(`[Andromity] ✓ Package verified. Starting daemon...`);
        vscode.window.showInformationMessage("Andromity Engine installed successfully!");
      }
    }

    this._outputChannel.appendLine(`[Andromity] Launching daemon (Python ${status.version || ""}): ${pythonPath}`);

    const args = ["-m", "andromity.server", "--stdio"];

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
    };

    const daemonSrcDir = projectRoot ? path.join(projectRoot, "src") : path.join(cwd, "src");
    if (fs.existsSync(daemonSrcDir)) {
      env.PYTHONPATH = env.PYTHONPATH ? `${daemonSrcDir}${path.delimiter}${env.PYTHONPATH}` : daemonSrcDir;
    }

    return this._spawnDaemon(pythonPath, args, projectRoot || cwd, env);
  }

  /** Shared daemon spawn logic used by both binary and Python paths. */
  private _spawnDaemon(
    execPath: string,
    args: string[],
    cwd: string,
    env: Record<string, string>
  ): RpcClient {
    const startTime = Date.now();
    const proc = cp.spawn(execPath, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this._process = proc;
    this._lastExitWasPackageError = false;
    this._outputChannel.appendLine(`[Andromity] Daemon process spawned (PID: ${proc.pid}, launch time: ${Date.now() - startTime}ms)`);

    const client = new RpcClient((msg) => {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(msg);
      }
    });

    let stderrBuffer = "";

    proc.stdout.on("data", (data) => {
      client.handleIncomingMessage(data.toString("utf-8"));
    });

    proc.stderr.on("data", (data) => {
      const text = data.toString("utf-8");
      stderrBuffer += text;
      this._outputChannel.append(`[Daemon Log] ${text}`);
    });

    proc.on("error", (err) => {
      this._outputChannel.appendLine(`[Daemon Error] ${err.message}`);
      client.close(`Daemon process error: ${err.message}`);
    });

    proc.on("exit", (code, signal) => {
      this._outputChannel.appendLine(`[Daemon Exit] Process exited with code ${code} (signal: ${signal})`);

      // Always reject pending RPCs on the client bound to this process.
      client.close(`Daemon exited with code ${code}`);

      // Stale exit event: this process was already replaced (restart()/dispose()
      // spawned a new daemon or cleared the handle). Do NOT clobber the current
      // _process/_client — doing so would null out the freshly-spawned daemon
      // and schedule a duplicate reconnect. Pending requests were rejected above.
      if (this._process !== proc) {
        return;
      }

      this._process = null;
      this._client = null;

      const isPackageError =
        code === 1 &&
        (stderrBuffer.includes("No module named 'andromity'") ||
          stderrBuffer.includes("ModuleNotFoundError"));

      if (isPackageError) {
        this._lastExitWasPackageError = true;
        this._outputChannel.appendLine(
          `[Andromity] Daemon failed because 'andromity' package is missing. Triggering auto-install...`
        );
        // Reset install flag so we try again (e.g. venv was deleted)
        this._packageInstallAttempted = false;
        // Don't count as a reconnect attempt — do a fresh install-then-start
        if (!this._isDisposed) {
          setTimeout(() => this._startSubprocess().catch((err) => {
            this._outputChannel.appendLine(`[Andromity] Auto-install recovery failed: ${err.message}`);
            vscode.window.showErrorMessage(
              `Andromity could not install the AI engine automatically.`,
              "Run Setup Check"
            ).then((choice) => {
              if (choice === "Run Setup Check") {
                vscode.commands.executeCommand("andromity.checkSetup");
              }
            });
          }), 500);
        }
        return;
      }

      // Normal crash / unexpected exit — apply exponential backoff restart
      if (!this._isDisposed && this._reconnectAttempts < this._maxReconnectAttempts) {
        this._reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 10000);
        this._outputChannel.appendLine(
          `[Andromity] Restarting daemon in ${delay}ms (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})...`
        );
        setTimeout(() => this._startSubprocess(), delay);
      } else if (!this._isDisposed && this._reconnectAttempts >= this._maxReconnectAttempts) {
        this._outputChannel.appendLine(`[Andromity] Max reconnect attempts reached. Stopping auto-restart.`);
        vscode.window.showErrorMessage(
          `Andromity daemon crashed repeatedly and stopped restarting. Check the 'Andromity' output channel for details.`,
          "View Logs",
          "Run Setup Check"
        ).then((choice) => {
          if (choice === "View Logs") { this._outputChannel.show(true); }
          if (choice === "Run Setup Check") { vscode.commands.executeCommand("andromity.checkSetup"); }
        });
      }
    });

    this._client = client;
    this._reconnectAttempts = 0;
    this._notifyClientReady(client);
    return client;
  }

  public getClient(): RpcClient | null {
    return this._client;
  }

  public async waitForClient(timeoutMs: number = 5000): Promise<RpcClient | null> {
    if (this._client) return this._client;
    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(this._client);
        }
      }, timeoutMs);

      this.onClientReady((client) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(client);
        }
      });
    });
  }

  public async restart(): Promise<RpcClient> {
    this.dispose();
    this._isDisposed = false;
    this._reconnectAttempts = 0;
    return this.start();
  }

  public dispose(): void {
    this._isDisposed = true;
    // Reject pending RPCs immediately instead of waiting for the async
    // 'exit' event (or the per-call timeout) to fire.
    if (this._client) {
      try {
        this._client.close("Andromity daemon disposed");
      } catch (e) {
        // ignore
      }
    }
    if (this._process) {
      try {
        this._process.kill();
      } catch (e) {
        // ignore
      }
      this._process = null;
    }
    if (this._socket) {
      try {
        this._socket.destroy();
      } catch (e) {
        // ignore
      }
      this._socket = null;
    }
    this._client = null;
  }

  private async _resolvePythonPath(): Promise<string> {
    const config = vscode.workspace.getConfiguration("andromity");
    const configuredPath = config.get<string>("pythonPath", "").trim();
    if (configuredPath && fs.existsSync(configuredPath)) {
      return configuredPath;
    }

    const isWin = process.platform === "win32";
    const searchDirs: string[] = [];

    const projectRoot = this._findProjectRoot();
    if (projectRoot) {
      searchDirs.push(projectRoot);
    }

    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      searchDirs.push(wf.uri.fsPath);
      searchDirs.push(path.dirname(wf.uri.fsPath));
    }

    try {
      searchDirs.push(process.cwd());
      searchDirs.push(path.dirname(process.cwd()));
    } catch {}

    let curr = __dirname;
    for (let i = 0; i < 5; i++) {
      searchDirs.push(curr);
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }

    const uniqueDirs = Array.from(new Set(searchDirs.filter(Boolean)));

    for (const dir of uniqueDirs) {
      const candidatePaths = isWin
        ? [
            path.join(dir, ".venv", "Scripts", "python.exe"),
            path.join(dir, "venv", "Scripts", "python.exe"),
            path.join(dir, ".eval-venv", "Scripts", "python.exe"),
            path.join(dir, "env", "Scripts", "python.exe"),
          ]
        : [
            path.join(dir, ".venv", "bin", "python"),
            path.join(dir, "venv", "bin", "python"),
            path.join(dir, ".eval-venv", "bin", "python"),
            path.join(dir, "env", "bin", "python"),
          ];

      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          return p;
        }
      }
    }

    // Try VS Code Python extension interpreter if available
    try {
      const pythonExtension = vscode.extensions.getExtension("ms-python.python");
      if (pythonExtension) {
        const api = pythonExtension.exports;
        if (api?.environments?.getActiveEnvironmentPath) {
          const envPath = await api.environments.getActiveEnvironmentPath();
          if (envPath?.path && fs.existsSync(envPath.path)) {
            return envPath.path;
          }
        }
      }
    } catch (e) {
      // ignore
    }

    // On Windows, auto-detect standard Python installation directories before falling back
    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || "";
      const programFiles = process.env.ProgramFiles || "C:\\Program Files";
      const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

      const windowsCandidates = [
        path.join(localAppData, "Programs", "Python", "Python313", "python.exe"),
        path.join(localAppData, "Programs", "Python", "Python312", "python.exe"),
        path.join(localAppData, "Programs", "Python", "Python311", "python.exe"),
        path.join(localAppData, "Programs", "Python", "Python310", "python.exe"),
        path.join(programFiles, "Python313", "python.exe"),
        path.join(programFiles, "Python312", "python.exe"),
        path.join(programFiles, "Python311", "python.exe"),
        path.join(programFiles, "Python310", "python.exe"),
        path.join(programFilesX86, "Python313", "python.exe"),
        path.join(programFilesX86, "Python312", "python.exe"),
        path.join(programFilesX86, "Python311", "python.exe"),
      ];

      for (const winPath of windowsCandidates) {
        if (fs.existsSync(winPath)) {
          return winPath;
        }
      }
    }

    return process.platform === "win32" ? "python" : "python3";
  }
}
