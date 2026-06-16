## What to build

Extract `vscode-extension/` into its own git repository, bundle with esbuild, and package as a `.vsix` installable from disk.

### HITL decision required first

The scripts (`extract_mcode.ts`, `import_mcode.ts`, `sync_mcode.ts`) currently live in the parent repo. In a standalone extension repo they are no longer co-located. Two options:

**Option A — Bundled string templates:** Embed the script source as string literals inside the extension bundle. At runtime, write to a temp file and spawn from there.  
- Pro: single `.vsix`, no external deps  
- Con: scripts duplicated, updates require re-releasing the extension

**Option B — Companion npm package `@ricardodiaz/pq-sync-scripts`:** Publish scripts to npm. Extension declares it as a dependency, `npm install` pulls it in before bundling.  
- Pro: scripts versioned independently, extension stays thin  
- Con: requires npm publish step; adds a release coordinate

**Decision owner:** user. Must be resolved before AFK implementation proceeds.

### AFK implementation (after decision)

- Move `vscode-extension/` to standalone repo
- Add `esbuild` build script: entry `src/extension.ts`, output `dist/extension.js`, externals `['vscode']`, target `node18`, platform `node`
- Add `vsce` for packaging: `vsce package` produces `pq-sync-<version>.vsix`
- Update `package.json` `main` to point to `dist/extension.js`
- Verify: install `.vsix` via "Install from VSIX…" in VS Code, run Pull/Push from a workspace with an xlsx

## Acceptance criteria

- [ ] Script distribution strategy decided (Option A or B)
- [ ] `npm run build` produces `dist/extension.js` via esbuild with no errors
- [ ] `vsce package` produces a `.vsix` file
- [ ] Extension installed from `.vsix` loads correctly in VS Code (no source or `tsx` required)
- [ ] Pull and Push commands work in installed extension against a real workbook

## Blocked by

- 001-extension-scaffold
- 002-pull-command
- 003-push-command
- 004-configure-command
- 005-single-pq-push-context
- 006-folder-context-commands
