## What to build

Scaffold the `pq-sync` VS Code extension with its core infrastructure modules. No real sync behavior yet — this slice produces a loadable extension with stub commands, tested deep modules, and the status bar plumbing that slices 2 and 3 depend on.

Deliverables:
- `package.json` manifest: extension ID `ricardodiaz.pq-sync`, three command contributions (`pq-sync.pull`, `pq-sync.push`, `pq-sync.configure`), `pqSync.workbookPath` and `pqSync.mcodePath` settings schema
- `tsconfig.json` targeting VS Code extension host
- `src/extension.ts`: `activate` registers the three commands as stubs (each shows a placeholder info message), creates output channel and status bar item, disposes on `deactivate`
- `src/runner.ts`: `spawnSync` wrapper — takes command + args + cwd, returns `{ stdout, stderr, exitCode }`. Uses `shell: true` on Windows for `npx` resolution
- `src/config.ts`: reads/writes `pqSync.workbookPath` and `pqSync.mcodePath` from workspace settings; auto-detect logic walks workspace root for first `.xlsx` and folder matching `MCode_Export` pattern; returns `{ workbookPath, mcodePath } | null`
- `src/statusBar.ts`: status bar item stub with `setState(state: 'idle' | 'syncing' | 'success' | 'error')` — icons: `$(sync)` idle, `$(sync~spin)` syncing, `$(check)` success (auto-resets to idle after 5s), `$(error)` error (stays until next run). Click triggers `pq-sync.configure`
- Unit tests for `runner.ts` and `config.ts` (Jest, `vscode` namespace mocked)

## Acceptance criteria

- [ ] Extension loads in VS Code Extension Development Host without errors
- [ ] All three commands appear in command palette, each shows a placeholder message when triggered
- [ ] Status bar item visible in the left status bar area
- [ ] `runner.ts` unit tests pass: correct args assembled, stdout/stderr captured, ENOENT throws
- [ ] `config.ts` unit tests pass: auto-detect returns correct paths given mocked workspace, missing settings returns null

## Blocked by

None — can start immediately.
