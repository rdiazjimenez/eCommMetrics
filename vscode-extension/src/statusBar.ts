import * as vscode from 'vscode';

type StatusState = 'idle' | 'syncing' | 'success' | 'error';

export class PqSyncStatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private resetTimer?: ReturnType<typeof setTimeout>;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.item.command = 'pq-sync.configure';
        this.setState('idle');
        this.item.show();
    }

    setState(state: StatusState): void {
        if (this.resetTimer) {
            clearTimeout(this.resetTimer);
            this.resetTimer = undefined;
        }
        switch (state) {
            case 'idle':
                this.item.text = '$(sync) pq-sync';
                this.item.tooltip = 'Click to configure pq-sync';
                break;
            case 'syncing':
                this.item.text = '$(sync~spin) pq-sync';
                this.item.tooltip = 'Syncing…';
                break;
            case 'success':
                this.item.text = '$(check) pq-sync';
                this.item.tooltip = 'Sync complete';
                this.resetTimer = setTimeout(() => this.setState('idle'), 5000);
                break;
            case 'error':
                this.item.text = '$(error) pq-sync';
                this.item.tooltip = 'Sync failed — click to reconfigure';
                break;
        }
    }

    dispose(): void {
        if (this.resetTimer) clearTimeout(this.resetTimer);
        this.item.dispose();
    }
}
