// Minimal vscode mock for unit tests. Only stubs what config.ts and runner.ts use.
const _store: Record<string, Record<string, unknown>> = {};

export const ConfigurationTarget = { Workspace: 2, Global: 1, WorkspaceFolder: 3 };
export const StatusBarAlignment = { Left: 1, Right: 2 };

export const workspace = {
    _store,
    _set(section: string, key: string, value: unknown): void {
        if (!_store[section]) _store[section] = {};
        _store[section][key] = value;
    },
    _clear(): void {
        for (const k of Object.keys(_store)) delete _store[k];
    },
    getConfiguration: jest.fn((section: string) => ({
        get: <T>(key: string): T | undefined => (_store[section] ?? {})[key] as T,
        update: jest.fn(async (key: string, value: unknown) => {
            if (!_store[section]) _store[section] = {};
            _store[section][key] = value;
        }),
    })),
    workspaceFolders: undefined as unknown as unknown[],
};

export const window = {
    createOutputChannel: jest.fn(() => ({
        appendLine: jest.fn(),
        show: jest.fn(),
        dispose: jest.fn(),
    })),
    createStatusBarItem: jest.fn(() => ({
        text: '',
        tooltip: '',
        command: '',
        show: jest.fn(),
        dispose: jest.fn(),
    })),
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    showOpenDialog: jest.fn(),
};

export const commands = { registerCommand: jest.fn() };

export const Uri = {
    file: (p: string) => ({ fsPath: p }),
};
