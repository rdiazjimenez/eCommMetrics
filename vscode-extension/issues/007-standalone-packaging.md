## What to build

Extract `vscode-extension/` into its own git repository, bundle the extension with esbuild, and package as a `.vsix` installable from disk.

### Decision: Option C — `pqSync.scriptsRoot` setting

Scripts (`extract_mcode.ts`, `import_mcode.ts`) stay external to the extension. The extension resolves their location via a workspace setting:

- `pqSync.scriptsRoot` — absolute path to the directory that contains the `scripts/` subfolder. Defaults to workspace root.
- Extension spawns: `npx tsx ${scriptsRoot}/scripts/extract_mcode.ts ...`

**Why A and B were rejected:**
- Option A (embed as string templates): scripts import `adm-zip` and other non-stdlib deps. Writing to a temp dir breaks dep resolution — `node_modules` is not next to the temp file.
- Option B (companion npm package): operational overhead (npm publish, release coordinate) not justified for a personal/team tool.

**Option C outcome:** zero packaging complexity. Works for same-repo use (default), standalone repo (user sets `pqSync.scriptsRoot`), or any shared location. esbuild still bundles the extension itself; scripts stay external by design.

### AFK implementation

1. Add `pqSync.scriptsRoot` to `package.json` configuration schema (type string, no default — falls back to workspace root at runtime)
2. Add `getScriptsRoot()` to `config.ts`: reads `pqSync.scriptsRoot`, falls back to `workspaceFolders[0]`
3. Update all commands to use `path.join(getScriptsRoot(), 'scripts', 'extract_mcode.ts')` / `import_mcode.ts` as the script path argument
4. Move `vscode-extension/` to standalone repo
5. Add `esbuild` build: entry `src/extension.ts`, output `dist/extension.js`, externals `['vscode']`, target `node18`, platform `node`
6. Update `package.json` `main` → `./dist/extension.js`
7. Add `@vscode/vsce` for packaging: `vsce package` → `pq-sync-<version>.vsix`

## Acceptance criteria

- [ ] `pqSync.scriptsRoot` setting documented in package.json schema
- [ ] Commands use `scriptsRoot` to build script path (not hardcoded `scripts/`)
- [ ] When `pqSync.scriptsRoot` unset, falls back to workspace root (existing behavior preserved)
- [ ] `npm run build` produces `dist/extension.js` via esbuild with no errors
- [ ] `vsce package` produces a `.vsix` file
- [ ] Extension installed from `.vsix` loads correctly in VS Code
- [ ] Pull and Push commands work when `pqSync.scriptsRoot` points to a separate scripts repo

## Blocked by

- 001-extension-scaffold
- 002-pull-command
- 003-push-command
- 004-configure-command
- 005-single-pq-push-context
- 006-folder-context-commands
