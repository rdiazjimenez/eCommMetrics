# PRD: pq-sync VS Code Extension

**Extension ID:** `ricardodiaz.pq-sync`  
**Location:** `vscode-extension/` (same repo, extracted to standalone repo in Phase 3)

---

## Problem Statement

Power Query M code lives inside Excel workbooks as a binary blob (`DataMashup`). There is no native way to view, edit, or version-control it outside Excel. The existing TypeScript scripts (`extract_mcode.ts`, `import_mcode.ts`) solve the round-trip problem, but running them requires dropping to the terminal, remembering argument syntax, and switching context away from the editor.

Developers who work with these Excel reports want to stay in VS Code: author M code in `.pq` files, push changes to Excel with a single action, and pull Excel edits back into the repo without touching a terminal.

---

## Solution

A VS Code extension that wraps the existing sync scripts behind familiar editor actions:

- **Pull** (Excel → files): command palette + status bar button
- **Push** (files → Excel): command palette + status bar button
- **Configure**: set workbook path and mcode folder via guided picker, stored in workspace settings

The extension spawns the existing `npx tsx scripts/...` commands under the hood. It surfaces results via the VS Code Output Channel and status bar, so the user never needs to open a terminal.

---

## User Stories

1. As a developer, I want to run `pq-sync: Pull from Excel` from the command palette so I can extract M code without remembering script arguments.
2. As a developer, I want to run `pq-sync: Push to Excel` from the command palette so I can import edited `.pq` files into the workbook without opening a terminal.
3. As a developer, I want a `pq-sync: Configure` command so I can pick my workbook and mcode folder interactively instead of editing JSON settings manually.
4. As a developer, I want the extension to remember my workbook path and mcode folder in workspace settings so I don't reconfigure on every session.
5. As a developer, I want a status bar item showing the current sync state (idle, syncing, success, error) so I have ambient feedback without watching the terminal.
6. As a developer, I want all script output routed to a dedicated VS Code Output Channel so I can inspect detailed logs without cluttering the integrated terminal.
7. As a developer, I want toast notifications on completion (success or error) so I'm alerted even when focused elsewhere in the editor.
8. As a developer, I want the extension to auto-detect the workbook and mcode folder from the workspace on first use so I skip configuration for the common case.
9. As a developer, I want Excel open-state detection to happen on each command trigger (not continuously) so the extension doesn't poll in the background.
10. As a developer, I want `Push` to route through COM if the workbook is open in Excel, and fall back to direct XLSX mutation if it isn't, so I get the right behavior automatically.
11. As a developer, I want `Pull` to route through COM if the workbook is open (unsaved M code visible), and fall back to direct XLSX read if closed, so I always get the most current state.
12. As a developer, I want right-click context menus on `.pq` files to expose Push/Pull actions so I can trigger syncs without opening the command palette.
13. As a developer, I want right-click context menus on the mcode root folder to expose Push/Pull so I can sync the whole folder from the Explorer sidebar.
14. As a developer, I want to push a single named query (not the whole folder) from a context menu on one `.pq` file so I can do targeted updates.
15. As a developer, I want to see "X changed, Y unchanged" in the Output Channel after every sync so I know exactly what moved.

---

## Implementation Decisions

### Phase 1 — Command Palette + Status Bar (MVP)

**3 commands registered:**
- `pq-sync.pull` — "pq-sync: Pull from Excel"
- `pq-sync.push` — "pq-sync: Push to Excel"
- `pq-sync.configure` — "pq-sync: Configure"

**Configuration storage:** `vscode.workspace.getConfiguration('pqSync')` with keys:
- `pqSync.workbookPath` — absolute path to `.xlsx`
- `pqSync.mcodePath` — absolute path to mcode folder

**Auto-detect on first trigger:** if settings are missing, walk up from the workspace root to find the first `.xlsx` file and a folder named `MCode_Export` (or similar). Prompt confirmation before persisting.

**Configure command flow:** 
1. `vscode.window.showOpenDialog` filtered to `*.xlsx` → set `workbookPath`
2. `vscode.window.showOpenDialog` folder mode → set `mcodePath`

**Script invocation:** `child_process.spawnSync('npx', ['tsx', 'scripts/extract_mcode.ts' | 'scripts/import_mcode.ts', workbookPath, mcodePath], { cwd: workspaceRoot, shell: true, encoding: 'utf8' })`. COM vs direct routing is handled by the scripts themselves (auto-detect).

**Output:** single `vscode.window.createOutputChannel('pq-sync')` shared across all commands. Show on each run.

**Status bar:** one `vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)` always visible, shows:
- `$(sync~spin) pq-sync` while running
- `$(check) pq-sync` after success (clears after 5s → idle icon)
- `$(error) pq-sync` after error (stays until next run)
- Click → `pq-sync.configure`

**Notifications:** `vscode.window.showInformationMessage` on success, `vscode.window.showErrorMessage` on non-zero exit.

**Excel detection:** done inside scripts, not in the extension. Extension calls the script, script picks COM or direct.

### Phase 2 — Context Menus

Register two contribution points in `package.json`:
- `explorer/context` when `resourceExtname == .pq` → **Push only** for single file (Pull of a single query is not supported by the scripts). Passes `--query <name>` where name = `path.basename(file, '.pq')`.
- `explorer/context` on folders → Pull/Push for the whole folder. `when` clause cannot compare path against workspace settings at manifest time, so the menu is visible on all folders; command validates at runtime that the clicked path matches `pqSync.mcodePath` and shows an error if not.

Single-file push: query name = `path.basename(uri.fsPath, '.pq')`. No group prefix logic — `import_mcode.ts` matches by basename only.

### Phase 3 — Standalone Repo + Bundle

Move `vscode-extension/` to its own git repository. Add `esbuild` bundling:
- Entry: `src/extension.ts`
- Output: `dist/extension.js`
- External: `vscode` (injected by VS Code host)
- Target: `node18`
- Scripts no longer in the same repo — embed scripts as bundled string templates or publish a companion npm package `@ricardodiaz/pq-sync-scripts`.

`package.json` gains `vsce` for packaging to `.vsix`.

### Modules

| Module | Responsibility |
|--------|---------------|
| `extension.ts` | Activate, register commands, create status bar + output channel |
| `commands/pull.ts` | Resolve config → spawn extract script → emit output → notify |
| `commands/push.ts` | Resolve config → spawn import script → emit output → notify |
| `commands/configure.ts` | Show file/folder pickers → write workspace settings |
| `config.ts` | Read/write `pqSync.*` workspace settings; auto-detect logic |
| `runner.ts` | `spawnSync` wrapper: returns `{ stdout, stderr, exitCode }` |
| `statusBar.ts` | Status bar item lifecycle: idle / syncing / success / error states |

`runner.ts` and `config.ts` are the two deep modules — they encapsulate the platform-specific spawn behavior and settings schema respectively, behind simple interfaces.

---

## Testing Decisions

**What makes a good test:** test behavior visible at module boundaries, not internal implementation. For `runner.ts`, test that stdout/stderr/exit code pass through correctly. For `config.ts`, test that auto-detect returns expected paths given a mocked file tree, and that missing settings produce the right prompt signal. Do not test VS Code UI calls directly — mock `vscode` namespace.

**Modules to test:**
- `config.ts`: auto-detect logic, settings read/write
- `runner.ts`: spawnSync wrapper — correct args assembled, stdout/stderr captured, error thrown on ENOENT

**Prior art:** none in this repo. Use `@vscode/test-electron` for integration tests if needed; use plain Jest with `vscode` mocked for unit tests on `config.ts` and `runner.ts`.

---

## Out of Scope

- Multi-workbook support (single workbook per workspace)
- Diff viewer inside VS Code for M code changes
- Automatic sync on file save
- Background polling for Excel state changes
- Authentication or multi-user scenarios
- Publishing to VS Code Marketplace (Phase 3 prerequisite only)
- Support for `.xlsm` or other Excel formats
- Windows-only limitation is acceptable; no macOS/Linux support planned

---

## Further Notes

- Scripts must remain runnable standalone (terminal use stays supported); the extension is a UI shell only.
- Phase 1 can ship without Phase 2 context menus — they are additive.
- Phase 3 (standalone repo) is a packaging concern, not a feature change; no behavioral changes expected when extracting.
- The `FunctionQueryBinding` annotation stripping and CR/LF normalization live entirely in the scripts; the extension does not need to understand M code format.
- On Windows, `spawnSync` with `shell: true` is required for `npx` to resolve via `cmd.exe`. This is already established in `scripts/sync_mcode.ts`.
