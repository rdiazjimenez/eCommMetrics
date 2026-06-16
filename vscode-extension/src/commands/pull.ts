import * as vscode from 'vscode';
import { run } from '../runner';
import { PqSyncStatusBar } from '../statusBar';
import { resolveConfig, workspaceRoot, lastLine, getScriptInvocation } from './_shared';

export async function pullCommand(output: vscode.OutputChannel, statusBar: PqSyncStatusBar): Promise<void> {
    const config = await resolveConfig();
    if (!config) return;

    statusBar.setState('syncing');
    output.show();
    output.appendLine(`[pq-sync] Pull started — ${new Date().toLocaleTimeString()}`);

    let result;
    try {
        const script = getScriptInvocation('extract_mcode.ts');
        result = run(script.command, [...script.args, config.workbookPath, config.mcodePath], workspaceRoot());
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        statusBar.setState('error');
        output.appendLine(`[pq-sync] ERROR: ${msg}`);
        vscode.window.showErrorMessage(`pq-sync Pull failed: ${msg}`);
        return;
    }

    if (result.stdout) output.appendLine(result.stdout.trimEnd());
    if (result.stderr) output.appendLine(result.stderr.trimEnd());

    if (result.exitCode === 0) {
        statusBar.setState('success');
        vscode.window.showInformationMessage(`pq-sync: ${lastLine(result.stdout) || 'Pull complete'}`);
    } else {
        statusBar.setState('error');
        vscode.window.showErrorMessage(`pq-sync Pull failed: ${lastLine(result.stderr) || 'non-zero exit'}`);
    }
}
