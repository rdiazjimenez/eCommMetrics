import { run } from '../runner';

jest.mock('child_process');

import { spawnSync } from 'child_process';
const mockSpawn = spawnSync as jest.Mock;

describe('runner.run', () => {
    afterEach(() => jest.clearAllMocks());

    it('returns stdout, stderr, exitCode on success', () => {
        mockSpawn.mockReturnValue({ stdout: 'hello\n', stderr: '', status: 0, error: undefined });
        expect(run('npx', ['tsx', 'foo.ts'], '/cwd')).toEqual({
            stdout: 'hello\n',
            stderr: '',
            exitCode: 0,
        });
    });

    it('throws when spawnSync sets error (e.g. ENOENT)', () => {
        mockSpawn.mockReturnValue({ stdout: '', stderr: '', status: null, error: new Error('spawn ENOENT') });
        expect(() => run('bad-cmd', [], '/cwd')).toThrow('spawn ENOENT');
    });

    it('uses shell: true so npx resolves on Windows', () => {
        mockSpawn.mockReturnValue({ stdout: '', stderr: '', status: 0, error: undefined });
        run('npx', ['tsx'], '/cwd');
        expect(mockSpawn).toHaveBeenCalledWith('npx', ['"tsx"'], expect.objectContaining({ shell: true }));
    });

    it('quotes args containing spaces to prevent shell word-splitting', () => {
        mockSpawn.mockReturnValue({ stdout: '', stderr: '', status: 0, error: undefined });
        run('npx', ['tsx', 'C:\\path with spaces\\file.ts'], '/cwd');
        expect(mockSpawn).toHaveBeenCalledWith(
            'npx',
            ['"tsx"', '"C:\\path with spaces\\file.ts"'],
            expect.objectContaining({ shell: true }),
        );
    });

    it('falls back exitCode 1 when status is null and no error', () => {
        mockSpawn.mockReturnValue({ stdout: '', stderr: 'oops', status: null, error: undefined });
        const result = run('npx', [], '/cwd');
        expect(result.exitCode).toBe(1);
    });
});
