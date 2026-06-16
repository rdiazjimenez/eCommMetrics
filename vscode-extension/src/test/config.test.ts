import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { readConfig, writeConfig, autoDetect, getScriptsRoot } from '../config';
import { workspace } from 'vscode';

const mockWorkspace = workspace as typeof workspace & {
    _set(section: string, key: string, value: unknown): void;
    _clear(): void;
};

beforeEach(() => mockWorkspace._clear());

describe('readConfig', () => {
    it('returns null when both settings missing', () => {
        expect(readConfig()).toBeNull();
    });

    it('returns null when only workbookPath set', () => {
        mockWorkspace._set('pqSync', 'workbookPath', '/foo.xlsx');
        expect(readConfig()).toBeNull();
    });

    it('returns config when both settings present', () => {
        mockWorkspace._set('pqSync', 'workbookPath', '/foo.xlsx');
        mockWorkspace._set('pqSync', 'mcodePath', '/mcode');
        expect(readConfig()).toEqual({ workbookPath: '/foo.xlsx', mcodePath: '/mcode' });
    });
});

describe('autoDetect', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-sync-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns null when no xlsx or mcode folder', () => {
        expect(autoDetect(tmpDir)).toBeNull();
    });

    it('returns null when xlsx present but no mcode folder', () => {
        fs.writeFileSync(path.join(tmpDir, 'Report.xlsx'), '');
        expect(autoDetect(tmpDir)).toBeNull();
    });

    it('returns null when mcode folder present but no xlsx', () => {
        fs.mkdirSync(path.join(tmpDir, 'MCode_Export'));
        expect(autoDetect(tmpDir)).toBeNull();
    });

    it('finds xlsx and MCode folder at root level', () => {
        const xlsxPath = path.join(tmpDir, 'Report.xlsx');
        const mcodePath = path.join(tmpDir, 'MCode_Export');
        fs.writeFileSync(xlsxPath, '');
        fs.mkdirSync(mcodePath);
        const result = autoDetect(tmpDir);
        expect(result).toEqual({ workbookPath: xlsxPath, mcodePath });
    });

    it('finds xlsx and mcode folder nested one level deep', () => {
        const sub = path.join(tmpDir, 'ShopifyMetrics');
        fs.mkdirSync(sub);
        const xlsxPath = path.join(sub, 'Metrics.xlsx');
        const mcodePath = path.join(sub, 'MCode_Export');
        fs.writeFileSync(xlsxPath, '');
        fs.mkdirSync(mcodePath);
        const result = autoDetect(tmpDir);
        expect(result).toEqual({ workbookPath: xlsxPath, mcodePath });
    });

    it('ignores node_modules and dotfiles', () => {
        fs.mkdirSync(path.join(tmpDir, 'node_modules'));
        fs.writeFileSync(path.join(tmpDir, 'node_modules', 'Report.xlsx'), '');
        fs.mkdirSync(path.join(tmpDir, '.hidden'));
        fs.writeFileSync(path.join(tmpDir, '.hidden', 'foo.xlsx'), '');
        expect(autoDetect(tmpDir)).toBeNull();
    });
});

describe('writeConfig', () => {
    it('persists both paths to workspace settings', async () => {
        await writeConfig({ workbookPath: '/a.xlsx', mcodePath: '/mcode' });
        expect(readConfig()).toEqual({ workbookPath: '/a.xlsx', mcodePath: '/mcode' });
    });
});

describe('getScriptsRoot', () => {
    it('returns pqSync.scriptsRoot when set', () => {
        mockWorkspace._set('pqSync', 'scriptsRoot', '/custom/scripts/root');
        expect(getScriptsRoot()).toBe('/custom/scripts/root');
    });

    it('falls back to process.cwd() when setting absent and no workspace folders', () => {
        // workspaceFolders is undefined in mock
        expect(getScriptsRoot()).toBe(process.cwd());
    });
});
