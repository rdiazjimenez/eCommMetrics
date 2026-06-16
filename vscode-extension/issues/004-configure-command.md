## What to build

Implement `pq-sync.configure` — a guided picker that sets `pqSync.workbookPath` and `pqSync.mcodePath` in workspace settings without requiring manual JSON editing.

Flow:
1. `showOpenDialog` filtered to `*.xlsx` → user picks workbook → write to `pqSync.workbookPath`
2. `showOpenDialog` in folder-picker mode → user picks mcode folder → write to `pqSync.mcodePath`
3. Show info toast: "pq-sync configured. Run Pull or Push to sync."
4. If user cancels either dialog, abort without writing partial config

The status bar item's click action already points to `pq-sync.configure` (wired in scaffold slice). This slice makes that action functional.

## Acceptance criteria

- [ ] `pq-sync: Configure` in command palette opens xlsx file picker filtered to `.xlsx` files
- [ ] After xlsx picked, folder picker opens for mcode directory
- [ ] Both paths written to workspace settings (visible in `.vscode/settings.json`)
- [ ] Cancelling either dialog leaves existing settings unchanged
- [ ] Completion toast confirms configuration saved
- [ ] Clicking status bar item triggers configure flow

## Blocked by

- 001-extension-scaffold
