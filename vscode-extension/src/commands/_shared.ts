import * as vscode from 'vscode';
import * as path from 'path';
import { readConfig, autoDetect, writeConfig, getScriptsRoot, PqSyncConfig } from '../config';

let _extensionPath = '';

export function init(extensionPath: string): void {
    _extensionPath = extensionPath;
}

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

/** Returns the command + args prefix needed to invoke a script by its .ts basename. */
export function getScriptInvocation(scriptName: string): { command: string; args: string[] } {
    const override = getScriptsRoot();
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (override && override !== wsRoot) {
        // Dev override: run from source via tsx
        return { command: 'npx', args: ['tsx', path.join(override, 'scripts', scriptName)] };
    }
    // Standalone/production: run pre-bundled JS
    const scriptJs = scriptName.replace(/\.ts$/, '.js');
    return { command: 'node', args: [path.join(_extensionPath, 'dist', 'scripts', scriptJs)] };
}

export function lastLine(text: string): string {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? '';
}
