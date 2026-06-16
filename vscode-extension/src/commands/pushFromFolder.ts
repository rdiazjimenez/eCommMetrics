import * as vscode from 'vscode';
import { readConfig } from '../config';
import { run } from '../runner';
import { PqSyncStatusBar } from '../statusBar';
import { workspaceRoot, lastLine, getScriptInvocation } from './_shared';

export async function pushFromFolderCommand(
    uri: vscode.Uri,
    output: vscode.OutputChannel,
    statusBar: PqSyncStatusBar,
): Promise<void> {
    const config = readConfig();
    if (!config) {
        vscode.window.showErrorMessage('pq-sync: No config found. Run pq-sync: Configure first.');
        return;
    }
    if (uri.fsPath !== config.mcodePath) {
        vscode.window.showErrorMessage(
            'pq-sync: This folder is not the configured mcode folder. Run pq-sync: Configure to change it.',
        );
        return;
    }

    statusBar.setState('syncing');
    output.show();
    output.appendLine(`[pq-sync] Push started — ${new Date().toLocaleTimeString()}`);

    let result;
    try {
        const script = getScriptInvocation('import_mcode.ts');
        result = run(script.command, [...script.args, config.workbookPath, config.mcodePath, '--in-place'], workspaceRoot());
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        statusBar.setState('error');
        output.appendLine(`[pq-sync] ERROR: ${msg}`);
        vscode.window.showErrorMessage(`pq-sync Push failed: ${msg}`);
        return;
    }

    if (result.stdout) output.appendLine(result.stdout.trimEnd());
    if (result.stderr) output.appendLine(result.stderr.trimEnd());

    if (result.exitCode === 0) {
        statusBar.setState('success');
        vscode.window.showInformationMessage(`pq-sync: ${lastLine(result.stdout) || 'Push complete'}`);
    } else {
        statusBar.setState('error');
        vscode.window.showErrorMessage(`pq-sync Push failed: ${lastLine(result.stderr) || 'non-zero exit'}`);
    }
}
