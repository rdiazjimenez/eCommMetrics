## What to build

Wire up `pq-sync.pull` end-to-end: read config, spawn `extract_mcode.ts`, stream output to the VS Code Output Channel, update the status bar through all states, and surface a toast notification on completion.

Flow:
1. Read `pqSync.workbookPath` and `pqSync.mcodePath` from workspace settings via `config.ts`
2. If either is missing, run auto-detect. If auto-detect finds candidates, show a confirmation prompt before persisting. If auto-detect finds nothing, show error: "Run pq-sync: Configure first"
3. Set status bar to `syncing`
4. Spawn `npx tsx scripts/extract_mcode.ts <workbookPath> <mcodePath>` via `runner.ts` (cwd = workspace root)
5. Write stdout + stderr to output channel; show output channel
6. On exit code 0: set status bar to `success` (auto-resets after 5s), show info toast with summary line from stdout (e.g. "5 modificados, 17 sin cambios")
7. On non-zero exit: set status bar to `error`, show error toast with last line of stderr

Excel open-state detection and COM vs direct routing happen inside the script — extension does not check.

## Acceptance criteria

- [ ] `pq-sync: Pull from Excel` in command palette triggers the pull flow
- [ ] Output channel opens and shows full stdout + stderr from extract script
- [ ] Status bar shows spinning icon while script runs
- [ ] On success: status bar shows check icon, info toast appears, status bar reverts to idle after 5s
- [ ] On failure (non-zero exit): status bar shows error icon, error toast appears with stderr tail
- [ ] If settings missing and auto-detect succeeds: confirmation prompt shown, settings persisted before run
- [ ] If settings missing and auto-detect fails: error toast shown, script not spawned

## Blocked by

- 001-extension-scaffold
