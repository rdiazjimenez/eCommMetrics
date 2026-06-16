import * as vscode from 'vscode';
import { PqSyncStatusBar } from './statusBar';
import { pullCommand } from './commands/pull';
import { pushCommand } from './commands/push';
import { configureCommand } from './commands/configure';
import { pushQueryCommand } from './commands/pushQuery';
import { pullFromFolderCommand } from './commands/pullFromFolder';
import { pushFromFolderCommand } from './commands/pushFromFolder';
import { init } from './commands/_shared';

export function activate(context: vscode.ExtensionContext): void {
    init(context.extensionPath);
    const output = vscode.window.createOutputChannel('pq-sync');
    const statusBar = new PqSyncStatusBar();

    context.subscriptions.push(
        output,
        statusBar,
        vscode.commands.registerCommand('pq-sync.pull', () => pullCommand(output, statusBar)),
        vscode.commands.registerCommand('pq-sync.push', () => pushCommand(output, statusBar)),
        vscode.commands.registerCommand('pq-sync.configure', () => configureCommand()),
        vscode.commands.registerCommand('pq-sync.pushQuery', (uri: vscode.Uri) =>
            pushQueryCommand(uri, output, statusBar),
        ),
        vscode.commands.registerCommand('pq-sync.pullFromFolder', (uri: vscode.Uri) =>
            pullFromFolderCommand(uri, output, statusBar),
        ),
        vscode.commands.registerCommand('pq-sync.pushFromFolder', (uri: vscode.Uri) =>
            pushFromFolderCommand(uri, output, statusBar),
        ),
    );
}

export function deactivate(): void {
    // subscriptions disposed automatically by VS Code
}
