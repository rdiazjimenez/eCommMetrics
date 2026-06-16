import { spawnSync } from 'child_process';

export interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

// shell: true on Windows joins args into a cmd.exe command string — quote each arg to
// handle paths with spaces or other shell metacharacters.
function quoteArg(arg: string): string {
    return '"' + arg.replace(/"/g, '\\"') + '"';
}

export function run(command: string, args: string[], cwd: string): RunResult {
    const quotedArgs = args.map(quoteArg);
    const result = spawnSync(command, quotedArgs, {
        encoding: 'utf8',
        cwd,
        shell: true,
    });
    if (result.error) {
        throw result.error;
    }
    return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.status ?? 1,
    };
}
