import * as vscode from 'vscode';
import * as path from 'path';
import { readConfig, autoDetect, writeConfig, getScriptsRoot, PqSyncConfig } from '../config';

export async function resolveConfig(): Promise<PqSyncConfig | null> {
    const existing = readConfig();
    if (existing) return existing;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('pq-sync: No workspace open.');
        return null;
    }

    const detected = autoDetect(workspaceRoot);
    if (!detected) {
        vscode.window.showErrorMessage('pq-sync: No config found. Run pq-sync: Configure first.');
        return null;
    }

    const answer = await vscode.window.showInformationMessage(
        'pq-sync: Auto-detected paths. Use these?',
        { detail: `Workbook: ${detected.workbookPath}\nMcode folder: ${detected.mcodePath}` },
        'Yes',
        'No',
    );
    if (answer !== 'Yes') return null;

    await writeConfig(detected);
    return detected;
}

export function workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
}

export function scriptPath(scriptName: string): string {
    return path.join(getScriptsRoot(), 'scripts', scriptName);
}

export function lastLine(text: string): string {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? '';
}
