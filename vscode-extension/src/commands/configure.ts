import * as vscode from 'vscode';
import { writeConfig } from '../config';

export async function configureCommand(): Promise<void> {
    const xlsxPick = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'Excel Workbook': ['xlsx'] },
        title: 'pq-sync: Select Excel workbook',
    });
    if (!xlsxPick || xlsxPick.length === 0) return;
    const workbookPath = xlsxPick[0].fsPath;

    const folderPick = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: 'pq-sync: Select mcode folder',
    });
    if (!folderPick || folderPick.length === 0) return;
    const mcodePath = folderPick[0].fsPath;

    await writeConfig({ workbookPath, mcodePath });
    vscode.window.showInformationMessage('pq-sync configured. Run Pull or Push to sync.');
}
