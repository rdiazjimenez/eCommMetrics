import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface PqSyncConfig {
    workbookPath: string;
    mcodePath: string;
}

export function readConfig(): PqSyncConfig | null {
    const cfg = vscode.workspace.getConfiguration('pqSync');
    const workbookPath = cfg.get<string>('workbookPath');
    const mcodePath = cfg.get<string>('mcodePath');
    if (workbookPath && mcodePath) {
        return { workbookPath, mcodePath };
    }
    return null;
}

export async function writeConfig(config: PqSyncConfig): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('pqSync');
    await cfg.update('workbookPath', config.workbookPath, vscode.ConfigurationTarget.Workspace);
    await cfg.update('mcodePath', config.mcodePath, vscode.ConfigurationTarget.Workspace);
}

export function getScriptsRoot(): string {
    const cfg = vscode.workspace.getConfiguration('pqSync');
    const override = cfg.get<string>('scriptsRoot');
    if (override) return override;
    return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
}

export function autoDetect(workspaceRoot: string): PqSyncConfig | null {
    let workbookPath: string | null = null;
    let mcodePath: string | null = null;

    function walk(dir: string, depth: number): void {
        if (depth > 3) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name.endsWith('.xlsx') && !workbookPath) {
                workbookPath = fullPath;
            } else if (entry.isDirectory()) {
                if (/mcode/i.test(entry.name) && !mcodePath) {
                    mcodePath = fullPath;
                }
                walk(fullPath, depth + 1);
            }
        }
    }

    walk(workspaceRoot, 0);
    if (workbookPath && mcodePath) {
        return { workbookPath, mcodePath };
    }
    return null;
}
