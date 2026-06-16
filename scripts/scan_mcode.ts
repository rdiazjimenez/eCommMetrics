import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

const excelPath = path.resolve(process.cwd(), 'ShopifyMetrics/Metrics.xlsx');

if (!fs.existsSync(excelPath)) {
    console.error("No se encuentra el archivo:", excelPath);
    process.exit(1);
}

const zip = new AdmZip(excelPath);
const entries = zip.getEntries();

console.log("--- ESTRUCTURA INTERNA DEL ARCHIVO ---");
entries.forEach(entry => {
    // Buscamos archivos que podrían contener el Mashup
    if (entry.entryName.toLowerCase().includes('customxml') || 
        entry.entryName.toLowerCase().includes('mashup')) {
        console.log("Archivo encontrado:", entry.entryName);
        
        // Si es un XML, leemos un trozo para ver si contiene la data
        if (entry.entryName.endsWith('.xml')) {
            const content = entry.getData().toString('utf8');
            if (content.length < 500) {
                console.log("   -> Contenido:", content);
            } else {
                console.log("   -> [Archivo grande, contiene DataMashup?]", content.includes('DataMashup'));
            }
        }
    }
});