import * as vscode from 'vscode';
import * as path from 'path';
import { run } from '../runner';
import { PqSyncStatusBar } from '../statusBar';
import { resolveConfig, workspaceRoot, lastLine, scriptPath } from './_shared';

export async function pushQueryCommand(
    uri: vscode.Uri,
    output: vscode.OutputChannel,
    statusBar: PqSyncStatusBar,
): Promise<void> {
    const config = await resolveConfig();
    if (!config) return;

    const queryName = path.basename(uri.fsPath, '.pq');

    statusBar.setState('syncing');
    output.show();
    output.appendLine(`[pq-sync] Push query "${queryName}" — ${new Date().toLocaleTimeString()}`);

    let result;
    try {
        result = run(
            'npx',
            ['tsx', scriptPath('import_mcode.ts'), config.workbookPath, config.mcodePath, queryName, '--in-place'],
            workspaceRoot(),
        );
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
        vscode.window.showInformationMessage(`pq-sync: ${lastLine(result.stdout) || `"${queryName}" pushed`}`);
    } else {
        statusBar.setState('error');
        vscode.window.showErrorMessage(`pq-sync Push failed: ${lastLine(result.stderr) || 'non-zero exit'}`);
    }
}
