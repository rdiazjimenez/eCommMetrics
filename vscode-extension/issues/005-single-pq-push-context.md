## What to build

Add a right-click context menu action on `.pq` files in the Explorer sidebar: "pq-sync: Push this query". Pushes a single named query to the workbook without touching other queries.

**Push only** — single-query Pull is not supported by the scripts. No Pull option on .pq files.

Query name derivation: `path.basename(uri.fsPath, '.pq')`. This matches how `import_mcode.ts` identifies queries by basename — no group prefix logic needed.

Command to register: `pq-sync.pushQuery`, contribution point `explorer/context` with `when: resourceExtname == .pq`.

Flow:
1. Derive query name from clicked file URI
2. Read config (same auto-detect/prompt path as Push command)
3. Set status bar to `syncing`
4. Spawn `npx tsx scripts/import_mcode.ts <workbookPath> <mcodePath> <queryName> --in-place`
5. Output channel + status bar + toast — same pattern as full Push

## Acceptance criteria

- [ ] Right-click on any `.pq` file shows "pq-sync: Push this query" in Explorer context menu
- [ ] Query name derived from filename (basename without `.pq` extension)
- [ ] Script receives query name as positional argument — only that query updated in workbook
- [ ] Output channel, status bar, and toast behave identically to full Push command
- [ ] Right-click on non-.pq files does not show the menu item

## Blocked by

- 003-push-command
