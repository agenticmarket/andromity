import * as cp from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as vscode from "vscode";
import { RpcClient } from "./RpcClient.js";

export class PythonBridge {
  private _process: cp.ChildProcessWithoutNullStreams | null = null;
  private _socket: net.Socket | null = null;
  private _client: RpcClient | null = null;
  private _outputChannel: vscode.OutputChannel;
  private _isDisposed = false;
  private _reconnectAttempts = 0;
  private _maxReconnectAttempts = 5;
  private _clientCallbacks: ((client: RpcClient) => void)[] = [];

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

  private async _startSubprocess(): Promise<RpcClient> {
    const pythonPath = await this._resolvePythonPath();
    this._outputChannel.appendLine(`[Andromity] Launching daemon using Python: ${pythonPath}`);

    const args = ["-m", "andromity.server", "--stdio"];
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
    };

    const srcDir = path.join(cwd, "src");
    if (fs.existsSync(srcDir)) {
      env.PYTHONPATH = env.PYTHONPATH ? `${srcDir}${path.delimiter}${env.PYTHONPATH}` : srcDir;
    }

    const proc = cp.spawn(pythonPath, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this._process = proc;

    const client = new RpcClient((msg) => {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(msg);
      }
    });

    proc.stdout.on("data", (data) => {
      client.handleIncomingMessage(data.toString("utf-8"));
    });

    proc.stderr.on("data", (data) => {
      const text = data.toString("utf-8");
      this._outputChannel.append(`[Daemon Log] ${text}`);
    });

    proc.on("error", (err) => {
      this._outputChannel.appendLine(`[Daemon Error] ${err.message}`);
      client.close(`Daemon process error: ${err.message}`);
      vscode.window.showErrorMessage(`Andromity Daemon error: ${err.message}`);
    });

    proc.on("exit", (code, signal) => {
      this._outputChannel.appendLine(`[Daemon Exit] Process exited with code ${code} (signal: ${signal})`);
      client.close(`Daemon exited with code ${code}`);
      this._process = null;
      this._client = null;

      if (!this._isDisposed && this._reconnectAttempts < this._maxReconnectAttempts) {
        this._reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 10000);
        this._outputChannel.appendLine(`[Andromity] Restarting daemon in ${delay}ms (attempt ${this._reconnectAttempts})...`);
        setTimeout(() => this._startSubprocess(), delay);
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

  public async restart(): Promise<RpcClient> {
    this.dispose();
    this._isDisposed = false;
    this._reconnectAttempts = 0;
    return this.start();
  }

  public dispose(): void {
    this._isDisposed = true;
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

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const root = workspaceFolders[0].uri.fsPath;
      const isWin = process.platform === "win32";

      const candidatePaths = isWin
        ? [
            path.join(root, ".venv", "Scripts", "python.exe"),
            path.join(root, "venv", "Scripts", "python.exe"),
            path.join(root, ".eval-venv", "Scripts", "python.exe"),
          ]
        : [
            path.join(root, ".venv", "bin", "python"),
            path.join(root, "venv", "bin", "python"),
            path.join(root, ".eval-venv", "bin", "python"),
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

    return process.platform === "win32" ? "python" : "python3";
  }
}
