// A small, recording stand-in for the `vscode` module, for the Create pull request adversarial tests.
// Install it before importing anything that imports "vscode". State is shared and mutable so a test can
// change settings, the GitHub session or the Git extension between steps.
import Module from "node:module";

export interface StubSession {
  accessToken: string;
  account: { label: string; id: string };
  scopes: string[];
}

export interface VscodeStubState {
  /** Settings by section, then key. */
  config: Record<string, Record<string, unknown>>;
  /** Settings at workspace (repository) scope, for inspect(). */
  workspaceConfig: Record<string, Record<string, unknown>>;
  session: StubSession | null;
  /** Session handed out when the user is asked to sign in (createIfNone / forceNewSession). */
  sessionOnPrompt: StubSession | null;
  sessionRequests: { scopes: string[]; options: any }[];
  gitExtension: { isActive: boolean; exports: any; activate(): Promise<any> } | undefined;
  infos: string[];
  warnings: string[];
  errors: string[];
  clipboard: string[];
  opened: string[];
  commands: { command: string; args: unknown[] }[];
  updates: { section: string; key: string; value: unknown; target: unknown }[];
}

export const state: VscodeStubState = {
  config: {},
  workspaceConfig: {},
  session: null,
  sessionOnPrompt: null,
  sessionRequests: [],
  gitExtension: undefined,
  infos: [],
  warnings: [],
  errors: [],
  clipboard: [],
  opened: [],
  commands: [],
  updates: [],
};

export function resetState(): void {
  state.config = {};
  state.workspaceConfig = {};
  state.session = null;
  state.sessionOnPrompt = null;
  state.sessionRequests = [];
  state.infos = [];
  state.warnings = [];
  state.errors = [];
  state.clipboard = [];
  state.opened = [];
  state.commands = [];
  state.updates = [];
}

function configuration(section: string) {
  return {
    get<T>(key: string, fallback?: T): T | undefined {
      const values = state.config[section] || {};
      const ws = state.workspaceConfig[section] || {};
      if (key in ws) return ws[key] as T;
      return key in values ? (values[key] as T) : fallback;
    },
    inspect<T>(key: string): { globalValue?: T; workspaceValue?: T } | undefined {
      const values = state.config[section] || {};
      const ws = state.workspaceConfig[section] || {};
      return { globalValue: values[key] as T, workspaceValue: ws[key] as T };
    },
    has(key: string) {
      return key in (state.config[section] || {});
    },
    async update(key: string, value: unknown, target: unknown) {
      state.updates.push({ section, key, value, target });
      state.config[section] = { ...(state.config[section] || {}), [key]: value };
    },
  };
}

class Uri {
  constructor(public readonly scheme: string, public readonly fsPath: string, private readonly raw: string) {}
  static parse(value: string, strict?: boolean): Uri {
    if (strict && !/^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error("strict parse failed");
    return new Uri(value.split(":")[0], "", value);
  }
  static file(path: string): Uri {
    return new Uri("file", path, "file://" + path);
  }
  toString(): string {
    return this.raw;
  }
}

export const vscodeStub = {
  workspace: {
    getConfiguration: (section = "") => configuration(section),
    workspaceFolders: [] as { uri: { fsPath: string } }[],
    textDocuments: [] as unknown[],
    getWorkspaceFolder: () => undefined,
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    showInformationMessage: async (text: string, ..._items: unknown[]) => {
      state.infos.push(text);
      return undefined;
    },
    showWarningMessage: async (text: string, ..._items: unknown[]) => {
      state.warnings.push(text);
      return undefined;
    },
    showErrorMessage: async (text: string, ..._items: unknown[]) => {
      state.errors.push(text);
      return undefined;
    },
    activeTextEditor: undefined,
  },
  env: {
    clipboard: { writeText: async (text: string) => { state.clipboard.push(text); } },
    openExternal: async (uri: Uri) => {
      state.opened.push(uri.toString());
      return true;
    },
  },
  commands: {
    executeCommand: async (command: string, ...args: unknown[]) => {
      state.commands.push({ command, args });
      return undefined;
    },
  },
  authentication: {
    getSession: async (_provider: string, scopes: string[], options: any) => {
      state.sessionRequests.push({ scopes, options });
      if (options?.createIfNone || options?.forceNewSession) return state.sessionOnPrompt;
      return state.session;
    },
  },
  extensions: {
    getExtension: (id: string) => (id === "vscode.git" ? state.gitExtension : undefined),
  },
  Uri,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ViewColumn: { One: 1, Active: -1, Beside: -2 },
};

let installed = false;

/** Makes `require("vscode")` return the stub for the rest of this test process. */
export function installVscodeStub(): typeof vscodeStub {
  if (installed) return vscodeStub;
  installed = true;
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
  const original = loader._load;
  loader._load = function (id: string, ...args: unknown[]) {
    return id === "vscode" ? vscodeStub : original.call(this, id, ...args);
  };
  return vscodeStub;
}
