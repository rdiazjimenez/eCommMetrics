import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';

// --- FUNCIONES AUXILIARES ---
function cleanName(name: string): string {
    return name.replace(/[\\/*?:"<>|]/g, '_');
}

function getFullGroupPath(groupId: string, groupsDict: Record<string, any>): string {
    if (!groupsDict[groupId]) return '';
    const group = groupsDict[groupId];
    let currentPath = cleanName(group.name);
    if (group.parentId) {
        const parentPath = getFullGroupPath(group.parentId, groupsDict);
        currentPath = path.join(parentPath, currentPath);
    }
    return currentPath;
}

function decodeXmlBuffer(buffer: Buffer): string {
    const cleanXmlStart = (value: string): string =>
        value.replace(/^[\uFEFF\u0000\s]+(?=<\?xml|<)/, '');

    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return cleanXmlStart(buffer.toString('utf16le'));
    }

    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        const swapped = Buffer.alloc(buffer.length - 2);
        for (let i = 2; i + 1 < buffer.length; i += 2) {
            swapped[i - 2] = buffer[i + 1];
            swapped[i - 1] = buffer[i];
        }
        return cleanXmlStart(swapped.toString('utf16le'));
    }

    return cleanXmlStart(buffer.toString('utf8'));
}

function getFirstZipFromMashup(payload: Buffer): Buffer {
    const zipStart = payload.indexOf(Buffer.from('504b0304', 'hex'));
    if (zipStart < 0) {
        throw new Error('El DataMashup no contiene una cabecera ZIP PK.');
    }

    const eocdSignature = Buffer.from('504b0506', 'hex');
    const eocdStart = payload.indexOf(eocdSignature, zipStart);
    if (eocdStart < 0) {
        return payload.subarray(zipStart);
    }

    const commentLength = payload.readUInt16LE(eocdStart + 20);
    const zipEnd = eocdStart + 22 + commentLength;
    return payload.subarray(zipStart, zipEnd);
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

function guidFromBuffer(buffer: Buffer, offset: number): string {
    const part1 = buffer.readUInt32LE(offset).toString(16).padStart(8, '0');
    const part2 = buffer.readUInt16LE(offset + 4).toString(16).padStart(4, '0');
    const part3 = buffer.readUInt16LE(offset + 6).toString(16).padStart(4, '0');
    const part4 = buffer.subarray(offset + 8, offset + 10).toString('hex');
    const part5 = buffer.subarray(offset + 10, offset + 16).toString('hex');
    return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

function readInt64AsNumber(buffer: Buffer, offset: number): number {
    return Number(buffer.readBigInt64LE(offset));
}

function parseQueryGroups(encodedValue: string): Record<string, any> {
    const value = encodedValue.startsWith('s') ? encodedValue.slice(1) : encodedValue;
    const buffer = Buffer.from(value, 'base64');
    const groups: Record<string, any> = {};
    let offset = 0;
    const count = readInt64AsNumber(buffer, offset);
    offset += 8;

    for (let index = 0; index < count && offset < buffer.length; index++) {
        const id = guidFromBuffer(buffer, offset);
        offset += 16;

        const nameLength = buffer[offset];
        offset += 1;
        const name = buffer.subarray(offset, offset + nameLength).toString('utf8');
        offset += nameLength;

        if (buffer[offset] === 0) offset += 1;

        const hasParent = buffer[offset] === 1;
        offset += 1;

        let parentId: string | null = null;
        if (hasParent) {
            parentId = guidFromBuffer(buffer, offset);
            offset += 16;
        }

        let sortOrder = index;
        if (offset + 8 <= buffer.length) {
            sortOrder = readInt64AsNumber(buffer, offset);
            offset += 8;
        } else if (offset + 4 <= buffer.length) {
            sortOrder = buffer.readInt32LE(offset);
            offset += 4;
        }

        groups[id] = { name, parentId, sortOrder };
    }

    return groups;
}

function parseMetadataGroups(mashupPayload: Buffer): {
    queryGroups: Record<string, any>;
    queryToGroup: Record<string, string>;
} {
    const metadata = mashupPayload.toString('utf8');
    const queryGroups: Record<string, any> = {};
    const queryToGroup: Record<string, string> = {};

    const groupsMatch = metadata.match(/<Entry Type="QueryGroups" Value="([^"]+)"/);
    if (groupsMatch?.[1]) {
        Object.assign(queryGroups, parseQueryGroups(groupsMatch[1]));
    }

    const itemRegex = /<Item><ItemLocation><ItemType>Formula<\/ItemType><ItemPath>Section1\/([^<]+)<\/ItemPath><\/ItemLocation><StableEntries>([\s\S]*?)<\/StableEntries><\/Item>/g;
    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemRegex.exec(metadata)) !== null) {
        const queryName = itemMatch[1];
        const entries = itemMatch[2];
        const groupMatch = entries.match(/<Entry Type="QueryGroupID" Value="s?([^"]+)"/);
        if (groupMatch?.[1]) {
            queryToGroup[queryName] = groupMatch[1];
        }
    }

    return { queryGroups, queryToGroup };
}

function collectPqFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...collectPqFiles(fullPath));
        else if (entry.name.endsWith('.pq')) results.push(path.resolve(fullPath));
    }
    return results;
}

function removeEmptyDirs(dir: string, root: string): void {
    if (path.resolve(dir) === path.resolve(root)) return;
    try {
        if (fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
            removeEmptyDirs(path.dirname(dir), root);
        }
    } catch {}
}

// --- FUNCIÓN PRINCIPAL ---
function extractMCode(xlsxPath: string, outputRoot: string): void {
    console.log(`\n📂 Procesando: ${xlsxPath}`);

    try {
        const excelZip = new AdmZip(xlsxPath);
        let mashupB64: string | null = null;

        // Búsqueda robusta del DataMashup. Excel suele guardar este XML como UTF-16.
        for (const entry of excelZip.getEntries()) {
            if (entry.entryName.startsWith('customXml/') && entry.entryName.endsWith('.xml')) {
                const content = decodeXmlBuffer(entry.getData());
                const found = getMashupBase64FromXml(content);
                if (found) {
                    mashupB64 = found;
                    break;
                }
            }
        }

        if (!mashupB64) {
            console.error("❌ Error: No se encontró el nodo DataMashup. Asegúrate de que el archivo tenga consultas y guárdalo.");
            return;
        }

        const mashupPayload = Buffer.from(mashupB64, 'base64');
        const mashupZip = new AdmZip(getFirstZipFromMashup(mashupPayload));
        const mCodeEntry = mashupZip.getEntry('Formulas/Section1.m');
        const packageEntry = mashupZip.getEntry('Config/Package.xml');

        if (!mCodeEntry) {
             console.error("❌ Error: Se encontró el DataMashup pero no contiene 'Section1.m'.");
             return;
        }

        // Parseo de estructura de carpetas
        const metadataGroups = parseMetadataGroups(mashupPayload);
        const queryGroups: Record<string, any> = { ...metadataGroups.queryGroups };
        const queryToGroup: Record<string, string> = { ...metadataGroups.queryToGroup };

        if (packageEntry) {
            const pkgXml = decodeXmlBuffer(packageEntry.getData());
            const pkgDoc = new DOMParser().parseFromString(pkgXml, 'text/xml');
            
            const groups = pkgDoc.getElementsByTagName('QueryGroup');
            for (let i = 0; i < groups.length; i++) {
                const node = groups.item(i)!;
                queryGroups[node.getAttribute('Id')!] = {
                    name: node.getAttribute('Name'), 
                    parentId: node.getAttribute('ParentId') 
                };
            }

            const items = pkgDoc.getElementsByTagName('Item');
            for (let i = 0; i < items.length; i++) {
                const item = items.item(i)!;
                if (item.getAttribute('Type') === 'Formula') {
                    const qName = item.getAttribute('Path')!.replace('Section1/', '');
                    const props = item.getElementsByTagName('Property');
                    for (let j = 0; j < props.length; j++) {
                        const p = props.item(j)!;
                        if (p.getAttribute('Name') === 'QueryGroupId') queryToGroup[qName] = p.getAttribute('Value')!;
                    }
                }
            }
        }

        // Extracción de código
        const existingPqFiles = new Set(collectPqFiles(outputRoot));
        const writtenFiles = new Set<string>();

        let mCodeRaw = mCodeEntry.getData().toString('utf8').replace(/^section\s+Section1;\s*/i, '').trim();
        const queries = mCodeRaw.replace(/^shared\s+/i, '').split(/\r?\nshared\s+/);

        let count = 0;
        for (let q of queries) {
            if (!q.trim()) continue;
            const parts = q.split('=');
            if (parts.length < 2) continue;

            let name = parts[0].trim().replace(/^#"/, '').replace(/"$/, '');
            let formula = parts.slice(1).join('=').trim().replace(/;$/, '');

            const qGroupId = queryToGroup[name];
            const folderPath = path.join(outputRoot, qGroupId ? getFullGroupPath(qGroupId, queryGroups) : '');

            if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
            const outPath = path.resolve(folderPath, `${cleanName(name)}.pq`);
            fs.writeFileSync(outPath, formula, 'utf8');
            writtenFiles.add(outPath);
            count++;
        }

        let deletedCount = 0;
        for (const existing of existingPqFiles) {
            if (!writtenFiles.has(existing)) {
                fs.unlinkSync(existing);
                removeEmptyDirs(path.dirname(existing), outputRoot);
                deletedCount++;
            }
        }

        console.log(`✅ ¡Éxito! Se exportaron ${count} archivos a: ${outputRoot}`);
        if (deletedCount > 0) console.log(`🗑️ Se eliminaron ${deletedCount} archivos obsoletos.`);

    } catch (e) { console.error("❌ Error fatal:", e); }
}

// --- INTERFAZ ---
const cliExcelInput = process.argv[2];
const cliOutputInput = process.argv[3];

if (cliExcelInput || cliOutputInput) {
    const excelInput = cliExcelInput || 'ShopifyMetrics/Metrics.xlsx';
    const outputInput = cliOutputInput || 'ShopifyMetrics/MCode_Export/';
    extractMCode(path.resolve(process.cwd(), excelInput), path.resolve(process.cwd(), outputInput));
    process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
async function iniciar() {
    const excelInput = await new Promise<string>(r => rl.question('Archivo Excel [ShopifyMetrics/Metrics.xlsx]: ', r)) || 'ShopifyMetrics/Metrics.xlsx';
    const outputInput = await new Promise<string>(r => rl.question('Carpeta destino [ShopifyMetrics/MCode_Export/]: ', r)) || 'ShopifyMetrics/MCode_Export/';
    rl.close();
    extractMCode(path.resolve(process.cwd(), excelInput), path.resolve(process.cwd(), outputInput));
}
iniciar().catch(e => {
    console.error("❌ Error fatal:", e);
    process.exit(1);
});
