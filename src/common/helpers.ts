import * as fs from 'fs';
import * as path from 'path';
import { Student } from '../entities/Student';

export const getUserMeta = (req: any) => {
    const usuario = String(req.query.user || 'Sistema');
    const nombre = req.query.nombre ? String(req.query.nombre) : undefined;
    return { usuario, nombre };
};

export const pushHistorial = (student: Student, accion: string, req: any) => {
    const meta = getUserMeta(req);
    student.historial = student.historial || [];
    student.historial.push({
        fecha: new Date().toISOString(),
        usuario: meta.usuario,
        nombre: meta.nombre,
        accion
    });
};

export function stripAccents(str: string | undefined | null): string {
    if (!str) return '';
    return str
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9\s.,:#-]/g, '')
        .toUpperCase();
}

export function normalizeSubjectName(str: string | undefined | null): string {
    return stripAccents(str)
        .replace(/,/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function getDocsPath(): string {
    const pathsToTry = [
        path.join(process.cwd(), 'docs'),
        path.join(__dirname, '..', 'docs'),
        path.join(__dirname, '..', '..', 'docs'),
        path.join(__dirname, 'docs')
    ];

    for (const p of pathsToTry) {
        if (fs.existsSync(p)) {
            console.log(`[PathFinder] Carpeta docs encontrada en: ${p}`);
            return p;
        }
    }

    console.warn(`[PathFinder] ADVERTENCIA: No se encontró la carpeta docs en ninguna de las rutas.`);
    return path.join(process.cwd(), 'docs');
}

export function cleanDNI(dni: string | number | undefined | null): string {
    if (dni === undefined || dni === null) return '';
    return String(dni).replace(/[^0-9]/g, '').trim();
}

export const normalizeKeys = (obj: any) => {
    const newObj: any = {};
    for (let key in obj) {
        const cleanKey = key.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
        const v = obj[key];
        newObj[cleanKey] = typeof v === 'string' ? v.trim() : v;
    }
    return newObj;
};

export const parseExcelBuffer = (buffer: Buffer, XLSX: any) => {
    const isBinary = buffer[0] === 0x50 || buffer[0] === 0xD0;
    if (!isBinary) {
        return XLSX.read(buffer.toString('latin1'), { type: 'string' });
    }
    return XLSX.read(buffer, { type: 'buffer' });
};
