import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';

// ── Types ─────────────────────────────────────────────────────────────────────

type ImportedQuery = {
    name: string;
    formula: string;
};

type QueryFormula = {
    name: string;
    declaration: string;
    formula: string;
};

type MashupPart = {
    entryName: string;
    xml: string;
    encoding: 'utf16le' | 'utf8';
    payload: Buffer;
    base64: string;
};

type InnerZipInfo = {
    header: Buffer;
    zip: Buffer;
    trailer: Buffer;
};

// ── Shared helpers ────────────────────────────────────────────────────────────

function collectTxtFiles(root: string): string[] {
    const result: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            result.push(...collectTxtFiles(fullPath));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pq')) {
            result.push(fullPath);
        }
    }
    return result;
}

function normalizeFormula(value: string): string {
    return value.trim().replace(/;$/, '').trim().replace(/\r\n?/g, '\n');
}

function stripQueryMetadata(value: string): string {
    const trimmed = value.trim();
    const lastSemi = trimmed.lastIndexOf(';');
    if (lastSemi >= 0) {
        const afterSemi = trimmed.slice(lastSemi + 1);
        if (/^\s*(\[[^\]]*\]\s*)*$/.test(afterSemi)) {
            return trimmed.slice(0, lastSemi).trim();
        }
    }
    return trimmed.replace(/;$/, '').trim();
}

function readImportedQueries(inputRoot: string): ImportedQuery[] {
    const seen = new Set<string>();
    const imported: ImportedQuery[] = [];

    for (const filePath of collectTxtFiles(inputRoot)) {
        const name = path.basename(filePath, '.pq');
        const formula = stripQueryMetadata(fs.readFileSync(filePath, 'utf8'));

        if (seen.has(name)) {
            throw new Error(`Duplicate query file: ${name}`);
        }

        seen.add(name);
        imported.push({ name, formula });
    }

    if (imported.length === 0) {
        throw new Error(`No .pq files found in M code folder: ${inputRoot}`);
    }

    return imported;
}

// ── ZIP/XML path ──────────────────────────────────────────────────────────────

function cleanXmlStart(value: string): string {
    return value.replace(/^[﻿\x00\s]+(?=<\?xml|<)/, '');
}

function decodeXmlBuffer(buffer: Buffer): { text: string; encoding: 'utf16le' | 'utf8' } {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return { text: cleanXmlStart(buffer.toString('utf16le')), encoding: 'utf16le' };
    }

    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        const swapped = Buffer.alloc(buffer.length - 2);
        for (let i = 2; i + 1 < buffer.length; i += 2) {
            swapped[i - 2] = buffer[i + 1];
            swapped[i - 1] = buffer[i];
        }
        return { text: cleanXmlStart(swapped.toString('utf16le')), encoding: 'utf16le' };
    }

    return { text: cleanXmlStart(buffer.toString('utf8')), encoding: 'utf8' };
}

function encodeXmlBuffer(xml: string, encoding: 'utf16le' | 'utf8'): Buffer {
    if (encoding === 'utf16le') {
        return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
    }
    return Buffer.from(xml, 'utf8');
}

function getMashupBase64FromXml(xml: string): string | null {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.documentElement;
    if (root && root.localName === 'DataMashup') {
        return root.textContent?.trim() || null;
    }

    const nodes = doc.getElementsByTagName('DataMashup');
    if (nodes.length > 0) {
        return nodes.item(0)?.textContent?.trim() || null;
    }

    const fallback = xml.match(/<[^>]*DataMashup[^>]*>([\s\S]*?)<\/[^>]*DataMashup>/);
    return fallback?.[1]?.trim() || null;
}

function findMashupPart(workbookZip: AdmZip): MashupPart {
    for (const entry of workbookZip.getEntries()) {
        if (!entry.entryName.startsWith('customXml/') || !entry.entryName.endsWith('.xml')) {
            continue;
        }

        const decoded = decodeXmlBuffer(entry.getData());
        const base64 = getMashupBase64FromXml(decoded.text);
        if (base64) {
            return {
                entryName: entry.entryName,
                xml: decoded.text,
                encoding: decoded.encoding,
                payload: Buffer.from(base64, 'base64'),
                base64,
            };
        }
    }

    throw new Error('No DataMashup found in customXml.');
}

function splitMashupPayload(payload: Buffer): InnerZipInfo {
    const zipStart = payload.indexOf(Buffer.from('504b0304', 'hex'));
    if (zipStart < 0) throw new Error('DataMashup does not contain a ZIP PK header.');

    const eocdStart = payload.indexOf(Buffer.from('504b0506', 'hex'), zipStart);
    if (eocdStart < 0) throw new Error('Inner DataMashup ZIP does not contain EOCD.');

    const commentLength = payload.readUInt16LE(eocdStart + 20);
    const zipEnd = eocdStart + 22 + commentLength;

    return {
        header: payload.subarray(0, zipStart),
        zip: payload.subarray(zipStart, zipEnd),
        trailer: payload.subarray(zipEnd),
    };
}

function updateMashupPayload(original: InnerZipInfo, updatedZip: Buffer): Buffer {
    const header = Buffer.from(original.header);
    if (header.length >= 8) header.writeUInt32LE(updatedZip.length, 4);
    return Buffer.concat([header, updatedZip, original.trailer]);
}

function splitQueries(sectionM: string): QueryFormula[] {
    const body = sectionM.replace(/^section\s+Section1;\s*/i, '').trim();
    const chunks = body.replace(/^shared\s+/i, '').split(/\r?\nshared\s+/);

    return chunks.flatMap(chunk => {
        const firstEquals = chunk.indexOf('=');
        if (firstEquals < 0) return [];

        const declaration = chunk.slice(0, firstEquals).trim();
        const formula = chunk.slice(firstEquals + 1).trim().replace(/;$/, '').trim();
        const name = declaration.replace(/^#"/, '').replace(/"$/, '');

        return [{ name, declaration, formula }];
    });
}

function readOriginalQueries(mashupZip: AdmZip): QueryFormula[] {
    const sectionEntry = mashupZip.getEntry('Formulas/Section1.m');
    if (!sectionEntry) throw new Error("DataMashup does not contain 'Formulas/Section1.m'.");
    return splitQueries(sectionEntry.getData().toString('utf8'));
}

function buildSectionM(originalQueries: QueryFormula[], imported: ImportedQuery[]): { sectionM: string; newCount: number; updatedCount: number } {
    const originalNames = new Set(originalQueries.map(q => q.name));
    const importedMap = new Map(imported.map(q => [q.name, q.formula]));

    let updatedCount = 0;
    const existingLines = originalQueries.map(q => {
        const importedFormula = importedMap.get(q.name);
        if (importedFormula !== undefined && normalizeFormula(importedFormula) !== normalizeFormula(q.formula)) {
            updatedCount++;
        }
        const formula = importedFormula ?? q.formula;
        return `shared ${q.declaration} = ${formula};`;
    });

    const newQueries = imported.filter(q => !originalNames.has(q.name));
    const newLines = newQueries.map(q => `shared #"${q.name}" = ${q.formula};`);

    const allLines = [...existingLines, ...newLines];
    return {
        sectionM: `section Section1;\r\n\r\n${allLines.join('\r\n\r\n')}\r\n`,
        newCount: newQueries.length,
        updatedCount,
    };
}

function replaceDataMashupXml(xml: string, oldBase64: string, newBase64: string): string {
    if (!xml.includes(oldBase64)) {
        throw new Error('Could not replace DataMashup: original base64 not found.');
    }
    return xml.replace(oldBase64, newBase64);
}

function verifyZipOutput(outputXlsxPath: string, imported: ImportedQuery[], expectedCount: number): void {
    const workbookZip = new AdmZip(outputXlsxPath);
    const mashupPart = findMashupPart(workbookZip);
    const inner = splitMashupPayload(mashupPart.payload);
    const mashupZip = new AdmZip(inner.zip);
    const queries = readOriginalQueries(mashupZip);

    if (queries.length !== expectedCount) {
        throw new Error(`Verification failed: expected ${expectedCount} queries, found ${queries.length}.`);
    }

    const queryMap = new Map(queries.map(q => [q.name, normalizeFormula(q.formula)]));
    for (const { name, formula } of imported) {
        if (queryMap.get(name) !== normalizeFormula(formula)) {
            throw new Error(`Verification failed: imported query does not match: ${name}`);
        }
    }
}

function hasDirectChanges(xlsxPath: string, imported: ImportedQuery[]): boolean {
    const workbookZip = new AdmZip(xlsxPath);
    const mashupPart = findMashupPart(workbookZip);
    const inner = splitMashupPayload(mashupPart.payload);
    const mashupZip = new AdmZip(inner.zip);
    const originalQueries = readOriginalQueries(mashupZip);
    const { updatedCount, newCount } = buildSectionM(originalQueries, imported);
    return updatedCount > 0 || newCount > 0;
}

function importMCodeDirect(xlsxPath: string, imported: ImportedQuery[], outputXlsxPath: string): void {
    console.log(`\n📥 Importing M code to: ${outputXlsxPath}`);

    const workbookZip = new AdmZip(xlsxPath);
    const mashupPart = findMashupPart(workbookZip);
    const inner = splitMashupPayload(mashupPart.payload);
    const mashupZip = new AdmZip(inner.zip);
    const originalQueries = readOriginalQueries(mashupZip);
    const { sectionM: updatedSectionM, newCount, updatedCount } = buildSectionM(originalQueries, imported);

    if (updatedCount === 0 && newCount === 0) {
        console.log('✅ Nothing changed — output not written.');
        return;
    }

    mashupZip.deleteFile('Formulas/Section1.m');
    mashupZip.addFile('Formulas/Section1.m', Buffer.from(updatedSectionM, 'utf8'));

    const updatedMashupPayload = updateMashupPayload(inner, mashupZip.toBuffer());
    const updatedBase64 = updatedMashupPayload.toString('base64');
    const updatedXml = replaceDataMashupXml(mashupPart.xml, mashupPart.base64, updatedBase64);

    workbookZip.updateFile(mashupPart.entryName, encodeXmlBuffer(updatedXml, mashupPart.encoding));

    const outputDir = path.dirname(outputXlsxPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    workbookZip.writeZip(outputXlsxPath);
    verifyZipOutput(outputXlsxPath, imported, originalQueries.length + newCount);

    console.log(`✅ Import verified. Updated: ${updatedCount} | Added: ${newCount}`);
}

function importMCodeDirectInPlace(xlsxPath: string, imported: ImportedQuery[]): void {
    if (!hasDirectChanges(xlsxPath, imported)) {
        console.log('\n✅ Nothing changed — workbook not modified.');
        return;
    }

    const parsed = path.parse(xlsxPath);
    const backupPath = path.join(parsed.dir, `${parsed.name}.bak${parsed.ext}`);
    const tempPath = path.join(parsed.dir, `${parsed.name}.tmp${parsed.ext}`);

    console.log(`\n🛟 Backup: ${backupPath}`);
    fs.copyFileSync(xlsxPath, backupPath);

    try {
        importMCodeDirect(xlsxPath, imported, tempPath);
        fs.copyFileSync(tempPath, xlsxPath);
        fs.unlinkSync(tempPath);
        console.log(`✅ Workbook updated: ${xlsxPath}`);
    } catch (error) {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        throw error;
    }
}

// ── COM path ──────────────────────────────────────────────────────────────────

function resolvePowerShell(): string {
    return process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
}

function writeTempJson(imported: ImportedQuery[]): string {
    const tempPath = path.join(os.tmpdir(), `import-mcode-${process.pid}.json`);
    fs.writeFileSync(tempPath, JSON.stringify(imported), 'utf8');
    return tempPath;
}

function writeTempPowerShell(): string {
    const scriptPath = path.join(os.tmpdir(), `import-mcode-${process.pid}.ps1`);
    fs.writeFileSync(scriptPath, `
param(
    [Parameter(Mandatory = $true)][string]$WorkbookPath,
    [Parameter(Mandatory = $true)][string]$QueriesJsonPath
)

$ErrorActionPreference = "Stop"
trap {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}

function Normalize-Formula([string]$Value) {
    if ($null -eq $Value) { return "" }
    return (($Value.Trim() -replace ';\\s*$', '').Trim() -replace '\\r', '')
}

if (-not (Test-Path -LiteralPath $WorkbookPath)) {
    throw "Workbook not found: $WorkbookPath"
}

if (-not (Test-Path -LiteralPath $QueriesJsonPath)) {
    throw "Query JSON file not found: $QueriesJsonPath"
}

if (-not (Get-Process -Name EXCEL -ErrorAction SilentlyContinue)) {
    throw "Excel is not running. Open the workbook in Excel first, or use --direct to update the closed file."
}

$TargetPath = [System.IO.Path]::GetFullPath($WorkbookPath)
$ImportedQueries = Get-Content -LiteralPath $QueriesJsonPath -Raw | ConvertFrom-Json
if ($null -eq $ImportedQueries) {
    throw "No imported queries found in JSON payload."
}

$Excel = [Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")
$Workbook = $null

foreach ($Candidate in @($Excel.Workbooks)) {
    try {
        $CandidatePath = [System.IO.Path]::GetFullPath($Candidate.FullName)
        if ([string]::Equals($CandidatePath, $TargetPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            $Workbook = $Candidate
            break
        }
    } catch {
        # Ignore unsaved or inaccessible workbooks.
    }
}

if ($null -eq $Workbook) {
    throw "Workbook is not open in the running Excel instance: $TargetPath"
}

$ExistingQueries = @{}
$ToUpdate = @()
$ToAdd = @()
foreach ($Imported in @($ImportedQueries)) {
    $Name = [string]$Imported.name
    $ExistingQuery = $null
    try { $ExistingQuery = $Workbook.Queries.Item($Name) } catch {}
    if ($null -ne $ExistingQuery) {
        $ExistingQueries[$Name] = $ExistingQuery
        $ToUpdate += $Imported
    } else {
        $ToAdd += $Imported
    }
}

$Backups = @{}
$ImportedMap = @{}
foreach ($Imported in @($ToUpdate)) { $ImportedMap[[string]$Imported.name] = [string]$Imported.formula }

$Updated = 0
$Added = 0
$Unchanged = 0
$UpdatedNames = @()
$AddedQueryObjects = @{}
try {
    foreach ($Imported in @($ToUpdate)) {
        $Name = [string]$Imported.name
        $Current = Normalize-Formula([string]$ExistingQueries[$Name].Formula)
        $New = Normalize-Formula([string]$Imported.formula)
        if ($Current -ne $New) {
            $Backups[$Name] = [string]$ExistingQueries[$Name].Formula
            $ExistingQueries[$Name].Formula = [string]$Imported.formula
            $UpdatedNames += $Name
            $Updated += 1
        } else {
            $Unchanged += 1
        }
    }

    foreach ($Imported in @($ToAdd)) {
        $Name = [string]$Imported.name
        $NewQuery = $Workbook.Queries.Add($Name, [string]$Imported.formula)
        if ($null -eq $NewQuery) { throw "Queries.Add returned null for: $Name" }
        $AddedQueryObjects[$Name] = $NewQuery
        $Added += 1
    }

    foreach ($Name in $UpdatedNames) {
        $Expected = Normalize-Formula($ImportedMap[$Name])
        $Actual = Normalize-Formula([string]$ExistingQueries[$Name].Formula)
        if ($Actual -ne $Expected) {
            throw "Post-update formula mismatch: $Name"
        }
    }

    if ($Updated -gt 0 -or $Added -gt 0) {
        $Workbook.Save()
    }
    Write-Output ("Updated: " + $Updated + " | Added: " + $Added + " | Unchanged: " + $Unchanged)
} catch {
    foreach ($Name in $Backups.Keys) {
        try {
            $ExistingQueries[$Name].Formula = $Backups[$Name]
        } catch {
            Write-Warning ("Rollback failed for query: " + $Name)
        }
    }
    foreach ($Name in $AddedQueryObjects.Keys) {
        try {
            $AddedQueryObjects[$Name].Delete()
        } catch {
            Write-Warning ("Rollback delete failed for new query: " + $Name)
        }
    }
    throw
}
`, 'utf8');
    return scriptPath;
}

function importMCodeViaCom(workbookPath: string, imported: ImportedQuery[]): void {
    const jsonPath = writeTempJson(imported);
    const scriptPath = writeTempPowerShell();

    try {
        const result = spawnSync(resolvePowerShell(), [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
            path.resolve(workbookPath), jsonPath,
        ], { cwd: process.cwd(), encoding: 'utf8' });

        if (result.stdout.trim()) console.log(result.stdout.trim());

        if (result.status !== 0) {
            throw new Error(result.stderr.trim() || `PowerShell exited with status ${result.status}`);
        }

        console.log(`✅ COM import done.`);
    } finally {
        for (const tmpPath of [jsonPath, scriptPath]) {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        }
    }
}

// ── Auto-detect ───────────────────────────────────────────────────────────────

function isWorkbookOpenInExcel(workbookPath: string): boolean {
    const targetPath = path.resolve(workbookPath).replace(/'/g, "''");
    const script = `
$t = [System.IO.Path]::GetFullPath('${targetPath}')
if (-not (Get-Process -Name EXCEL -ErrorAction SilentlyContinue)) { exit 1 }
try { $xl = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application') } catch { exit 1 }
foreach ($wb in @($xl.Workbooks)) {
    try {
        if ([string]::Equals([System.IO.Path]::GetFullPath($wb.FullName), $t, [System.StringComparison]::OrdinalIgnoreCase)) { exit 0 }
    } catch {}
}
exit 1`.trim();

    const result = spawnSync(resolvePowerShell(), [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { encoding: 'utf8' });

    return result.status === 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const forceCom = args.includes('--com');
const forceDirect = args.includes('--direct');
const inPlace = args.includes('--in-place');
const positional = args.filter(a => !a.startsWith('--'));
const [workbookInput, mcodeInput, ...rest] = positional;

if (!workbookInput || !mcodeInput) {
    console.error('Usage: npx tsx scripts/import_mcode.ts <workbook.xlsx> <mcode-folder> [<query-name>] [--com | --direct] [--in-place | <output.xlsx>]');
    process.exit(1);
}

if (forceCom && forceDirect) {
    console.error('Fatal error: --com and --direct are mutually exclusive.');
    process.exit(1);
}

let queryName: string | undefined;
let outputInput: string | undefined;

for (const token of rest) {
    if (/\.(xlsx|xlsm|xlsb)$/i.test(token)) {
        outputInput = token;
    } else {
        queryName = token;
    }
}

try {
    const workbookPath = path.resolve(process.cwd(), workbookInput);
    const mcodePath = path.resolve(process.cwd(), mcodeInput);

    if (!fs.existsSync(workbookPath)) {
        throw new Error(`Workbook not found: ${workbookPath}`);
    }

    if (!fs.existsSync(mcodePath) || !fs.statSync(mcodePath).isDirectory()) {
        throw new Error(`M code folder not found: ${mcodePath}`);
    }

    let imported = readImportedQueries(mcodePath);

    if (queryName !== undefined) {
        const match = imported.find(q => q.name === queryName);
        if (!match) throw new Error(`Query file not found in folder: ${queryName}`);
        imported = [match];
    }

    const useCom = forceCom || (!forceDirect && isWorkbookOpenInExcel(workbookPath));

    if (useCom) {
        importMCodeViaCom(workbookPath, imported);
    } else if (inPlace) {
        importMCodeDirectInPlace(workbookPath, imported);
    } else {
        if (!outputInput) {
            throw new Error('Direct mode requires --in-place or an output path. Use --com to update the open workbook.');
        }
        const outputPath = path.resolve(process.cwd(), outputInput);
        if (workbookPath === outputPath) {
            throw new Error('Cannot overwrite the source workbook. Use --in-place or a different output path.');
        }
        importMCodeDirect(workbookPath, imported, outputPath);
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Fatal error: ${message}`);
    process.exit(1);
}
