## What to build

Wire up `pq-sync.push` end-to-end using the same pattern as the Pull command, but spawning `import_mcode.ts --in-place` instead of `extract_mcode.ts`.

Flow:
1. Read config via `config.ts` — same auto-detect/prompt behavior as Pull
2. Set status bar to `syncing`
3. Spawn `npx tsx scripts/import_mcode.ts <workbookPath> <mcodePath> --in-place` via `runner.ts`
4. Write stdout + stderr to output channel; show output channel
5. On exit code 0: set status bar to `success` (auto-resets after 5s), show info toast with summary (e.g. "Updated: 3 | Added: 0 | Unchanged: 19")
6. On non-zero exit: set status bar to `error`, show error toast with stderr tail

COM vs direct routing and the nothing-changed no-op both happen inside the script.

## Acceptance criteria

- [ ] `pq-sync: Push to Excel` in command palette triggers the push flow
- [ ] Output channel opens and shows full stdout + stderr from import script
- [ ] Status bar spin → check/error transitions work correctly
- [ ] Success toast shows summary line from stdout
- [ ] Error toast shows stderr tail on non-zero exit
- [ ] Auto-detect/prompt behavior identical to Pull command (same config.ts path)
- [ ] `--in-place` flag passed to import script (no separate output file created)

## Blocked by

- 001-extension-scaffold
