## What to build

Add right-click context menu actions on folders in the Explorer sidebar: "pq-sync: Pull from Excel" and "pq-sync: Push to Excel". These trigger the full folder sync, identical to the command palette versions, but initiated from the folder context.

**When clause limitation:** VS Code `package.json` cannot compare a folder's path against a workspace setting at manifest time. The menu items are therefore registered with `when: explorerResourceIsFolder` (visible on all folders) and validated at runtime.

Runtime validation: if clicked folder path does not match `pqSync.mcodePath`, show error: "This folder is not the configured mcode folder. Run pq-sync: Configure to change it."

Commands to register: `pq-sync.pullFromFolder` and `pq-sync.pushFromFolder`, both with `when: explorerResourceIsFolder`.

Flow (when validation passes):
- Pull: same as `pq-sync.pull` — config already confirmed by runtime check
- Push: same as `pq-sync.push` with `--in-place`

## Acceptance criteria

- [ ] Right-click on any folder shows "pq-sync: Pull from Excel" and "pq-sync: Push to Excel"
- [ ] Clicking on the configured mcode folder triggers correct Pull or Push flow
- [ ] Clicking on any other folder shows error toast: "This folder is not the configured mcode folder"
- [ ] Output channel, status bar, and toast behavior identical to command palette equivalents
- [ ] No runtime error if `pqSync.mcodePath` is not set (shows "Run pq-sync: Configure first" instead)

## Blocked by

- 002-pull-command
- 003-push-command
