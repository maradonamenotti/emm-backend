import * as fs from 'fs';
import * as path from 'path';
import { PDFDocument } from 'pdf-lib';
import { getDocsPath } from '../common/helpers';

function normalizeLicencia(licencia?: string | null): string {
    return licencia
        ? String(licencia).toUpperCase().replace('LICENCIA ', '').trim()
        : 'CB';
}

function isTrayectoria1(lic: string): boolean {
    return lic === 'TD1'
        || lic === 'BA'
        || lic === 'B Y A'
        || lic.includes('TRAYECTORIA DESTACADA I')
        || lic.includes('TRAYECTORIA DESTACADA 1')
        || lic.includes('TRAYECTORIA I')
        || lic.includes('TRAYECTORIA 1');
}

function isTrayectoria2(lic: string): boolean {
    return lic === 'TD2'
        || lic === 'PRO'
        || lic.includes('TRAYECTORIA DESTACADA II')
        || lic.includes('TRAYECTORIA DESTACADA 2')
        || lic.includes('TRAYECTORIA II')
        || lic.includes('TRAYECTORIA 2');
}

export function getCertificateTemplateCandidates(licencia?: string | null): string[] {
    const cleanLic = normalizeLicencia(licencia);
    const candidates = new Set<string>();

    candidates.add(`Certificado_${cleanLic}_2025.pdf`);

    if (isTrayectoria1(cleanLic)) {
        candidates.add('Certificado_PROGRAMA DE TRAYECTORIA DESTACADA 1_2025.pdf');
    }

    if (isTrayectoria2(cleanLic)) {
        candidates.add('Certificado_PROGRAMA DE TRAYECTORIA DESTACADA 2_2025.pdf');
        candidates.add('Certificado_PRO_2025.pdf');
    }

    return Array.from(candidates);
}

export async function loadCertificateTemplate(licencia?: string | null): Promise<{ buffer: Buffer; templateName: string }> {
    const attempted: string[] = [];

    for (const templateName of getCertificateTemplateCandidates(licencia)) {
        const templatePath = path.join(getDocsPath(), templateName);
        if (!fs.existsSync(templatePath)) {
            attempted.push(`${templateName} (no existe)`);
            continue;
        }

        const buffer = fs.readFileSync(templatePath);
        const pdfDoc = await PDFDocument.load(buffer);
        const fieldCount = pdfDoc.getForm().getFields().length;

        if (fieldCount === 0) {
            attempted.push(`${templateName} (sin campos editables)`);
            continue;
        }

        return { buffer, templateName };
    }

    throw new Error(`No hay una plantilla válida para la licencia '${normalizeLicencia(licencia)}'. Intentos: ${attempted.join(', ') || 'sin candidatos'}`);
}
