import { spawnSync } from 'child_process';

const USAGE = `Usage:
  pull  — Excel overwrites codebase
    npx tsx scripts/sync_mcode.ts pull <workbook.xlsx> <mcode-folder>

  push  — Codebase overwrites Excel
    npx tsx scripts/sync_mcode.ts push <workbook.xlsx> <mcode-folder> [<query-name>] [--com | --direct] [--in-place | <output.xlsx>]`;

const [direction, workbook, mcodeFolder, ...rest] = process.argv.slice(2);

if (!direction || !workbook || !mcodeFolder || (direction !== 'pull' && direction !== 'push')) {
    console.error(USAGE);
    process.exit(1);
}

const scriptArgs = direction === 'pull'
    ? ['scripts/extract_mcode.ts', workbook, mcodeFolder]
    : ['scripts/import_mcode.ts', workbook, mcodeFolder, ...rest];

const result = spawnSync('npx', ['tsx', ...scriptArgs], {
    encoding: 'utf8',
    cwd: process.cwd(),
    shell: true,
});

if (result.error) {
    console.error(`Failed to spawn tsx: ${result.error.message}`);
    process.exit(1);
}

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

process.exit(result.status ?? 1);
