import { PDFDocument, StandardFonts, TextAlignment } from 'pdf-lib';

function stripAccents(str: string | undefined | null): string {
    if (!str) return '';
    return str
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9\s.,:#-]/g, '')
        .toUpperCase();
}

export function getFullName(nombre: string, apellido?: string): string {
    const n = (nombre || '').trim().toUpperCase();
    const a = (apellido || '').trim().toUpperCase();
    if (!a) return n;
    if (n.endsWith(a)) return n;
    return `${n} ${a}`.trim();
}

function numeroMenorA100ALetras(num: number): string {
    const units: Record<number, string> = {
        0: "CERO", 1: "UNO", 2: "DOS", 3: "TRES", 4: "CUATRO",
        5: "CINCO", 6: "SEIS", 7: "SIETE", 8: "OCHO", 9: "NUEVE"
    };
    const teens: Record<number, string> = {
        10: "DIEZ", 11: "ONCE", 12: "DOCE", 13: "TRECE", 14: "CATORCE",
        15: "QUINCE", 16: "DIECISEIS", 17: "DIECISIETE", 18: "DIECIOCHO", 19: "DIECINUEVE"
    };
    const tens: Record<number, string> = {
        20: "VEINTE", 30: "TREINTA", 40: "CUARENTA", 50: "CINCUENTA",
        60: "SESENTA", 70: "SETENTA", 80: "OCHENTA", 90: "NOVENTA"
    };

    if (num < 10) return units[num] || String(num);
    if (num < 20) return teens[num] || String(num);
    if (num < 30) {
        const veinti: Record<number, string> = {
            20: "VEINTE", 21: "VEINTIUNO", 22: "VEINTIDOS", 23: "VEINTITRES",
            24: "VEINTICUATRO", 25: "VEINTICINCO", 26: "VEINTISEIS", 27: "VEINTISIETE",
            28: "VEINTIOCHO", 29: "VEINTINUEVE"
        };
        return veinti[num] || String(num);
    }

    const ten = Math.floor(num / 10) * 10;
    const unit = num % 10;
    if (unit === 0) return tens[ten] || String(num);
    return `${tens[ten]} Y ${units[unit]}`;
}

function numeroALetras(num: number): string {
    const map: Record<number, string> = {
        0: "CERO", 1: "UNO", 2: "DOS", 3: "TRES", 4: "CUATRO",
        5: "CINCO", 6: "SEIS", 7: "SIETE", 8: "OCHO", 9: "NUEVE", 10: "DIEZ"
    };
    const normalized = Number(num.toFixed(2));
    const entero = Math.floor(normalized);
    const decimales = Math.round((normalized - entero) * 100);
    let base = map[entero] || "";
    if (decimales > 0) return `${base} CON ${numeroMenorA100ALetras(decimales)}`;
    return base;
}

function formatGradeDisplay(value: number | string | undefined | null): string {
    if (value === undefined || value === null) return '';
    const raw = String(value).trim().replace(',', '.');
    if (!raw) return '';
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return raw;
    return raw.includes('.') ? raw.replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '') : raw;
}

function normalizeSubjectField(subject: string): string {
    return subject.toUpperCase().replace(/,/g, '').trim();
}

function getSubjectAliases(subject: string): string[] {
    const normSubject = normalizeSubjectField(subject);
    const aliases: string[] = [];
    const add = (...values: string[]) => {
        values.forEach(v => {
            if (v && !aliases.includes(v)) aliases.push(v);
        });
    };

    if (normSubject === 'PSICOLOGIA I' || normSubject === 'PSICOLOGÍA I') {
        add('PSICOLOGIA II', 'PSICOLOGÍA II', normSubject);
    } else if (normSubject === 'PSICOLOGIA II' || normSubject === 'PSICOLOGÍA II') {
        add('PSICOLOGIA III', 'PSICOLOGÍA III', normSubject);
    } else {
        add(
            normSubject,
            normSubject.replace(/ I$/, ' 1'),
            normSubject.replace(/ 1$/, ' I'),
            normSubject.replace(/ II$/, ' 2'),
            normSubject.replace(/ 2$/, ' II'),
            normSubject.replace(/ III$/, ' 3'),
            normSubject.replace(/ 3$/, ' III'),
        );
    }

    switch (normSubject) {
        case 'METODOLOGIA DE LA ENSENANZA II':
        case 'METODOLOGÍA DE LA ENSEÑANZA II':
            add('METODOLOGIA DE LA ENSENANZA', 'METODOLOGÍA DE LA ENSEÑANZA');
            break;
        case 'PREPARACION FISICA I':
        case 'PREPARACIÓN FÍSICA I':
            add('PREPARACION FISICA', 'PREPARACIÓN FÍSICA');
            break;
        case 'PSICOLOGIA I':
        case 'PSICOLOGÃ A I':
            add('PSICOLOGIA II', 'PSICOLOGÃ A II');
            break;
        case 'PSICOLOGIA II':
        case 'PSICOLOGÃ A II':
            add('PSICOLOGIA III', 'PSICOLOGÃ A III');
            break;
        case 'PLANIFICACION DEL ENTRENAMIENTO I':
        case 'PLANIFICACIÓN DEL ENTRENAMIENTO I':
            add('PLANIFICACION DEL ENTRENAMIENTO', 'PLANIFICACIÓN DEL ENTRENAMIENTO');
            break;
        case 'PLANIFICACION DEL ENTRENAMIENTO II':
        case 'PLANIFICACIÓN DEL ENTRENAMIENTO II':
            add('PLANIFICACION DEL ENTRENAMIENTO_2', 'PLANIFICACIÓN DEL ENTRENAMIENTO_2');
            break;
        case 'DIRECCION DE JUGADORES Y EQUIPOS I':
        case 'DIRECCIÓN DE JUGADORES Y EQUIPOS I':
            add('DIRECCION DE JUGADORES Y EQUIPOS', 'DIRECCIÓN DE JUGADORES Y EQUIPOS');
            break;
        case 'DERECHO DEPORTIVO I':
            add('DERECHO DEPORTIVO');
            break;
    }

    return aliases;
}

function normalizeLicenciaCode(licRaw: string | undefined | null): string {
    return stripAccents(licRaw || 'CB').replace('LICENCIA ', '').trim();
}

function normalizeOptionalText(value: string | undefined | null): string {
    return stripAccents(value || '').trim();
}

function isTrayectoria1Lic(licRaw: string | undefined | null): boolean {
    const lic = normalizeLicenciaCode(licRaw);
    return lic === 'BA'
        || lic === 'B Y A'
        || lic === 'TD1'
        || lic.includes('TRAYECTORIA DESTACADA I')
        || lic.includes('TRAYECTORIA DESTACADA 1')
        || lic.includes('TRAYECTORIA I')
        || lic.includes('TRAYECTORIA 1');
}

function isTrayectoria2Lic(licRaw: string | undefined | null): boolean {
    const lic = normalizeLicenciaCode(licRaw);
    return lic === 'TD2'
        || lic.includes('TRAYECTORIA DESTACADA II')
        || lic.includes('TRAYECTORIA DESTACADA 2')
        || lic.includes('TRAYECTORIA II')
        || lic.includes('TRAYECTORIA 2');
}

function isComision03(comisionRaw: string | undefined | null): boolean {
    const comision = normalizeOptionalText(comisionRaw);
    return comision === '3'
        || comision === '03'
        || /\bCOMISION\s*0?3\b/.test(comision);
}

function isComision03Trayectoria2(licRaw: string | undefined | null, comisionRaw: string | undefined | null): boolean {
    const combined = `${normalizeLicenciaCode(licRaw)} ${normalizeOptionalText(comisionRaw)}`.trim();
    return isTrayectoria2Lic(combined) && (isComision03(comisionRaw) || /\bCOMISION\s*0?3\b/.test(combined));
}

function getHorasCampo(licRaw: string | undefined | null, comisionRaw?: string | null): number {
    const lic = normalizeLicenciaCode(licRaw);
    if (isComision03Trayectoria2(licRaw, comisionRaw)) return 94;
    if (isTrayectoria1Lic(lic) || isTrayectoria2Lic(lic)) return 94;
    if (lic === 'A') return 128;
    if (lic === 'PRO') return 188;
    return 108;
}

function numberToWordsForHours(num: number): string {
    const map: Record<number, string> = {
        94: 'NOVENTA Y CUATRO',
        108: 'CIENTO OCHO',
        128: 'CIENTO VEINTIOCHO',
        188: 'CIENTO OCHENTA Y OCHO'
    };
    return map[num] || String(num);
}

export interface StudentGradeLog {
    name: string;
    dni: string;
    fecha_fin_cursada?: string;
    fecha_emision?: string;
    carrera_licencia?: string;
    comision?: string;
    grades: { subject: string; finalGrade: number; finalGradeDisplay?: string }[];
}

export function parseDateStrings(dateString?: string): { day: string, month: string, year: string } | null {
    if (!dateString) return null;
    let d: Date;
    if (dateString.includes('-')) {
        const [y, m, dayv] = dateString.split('-');
        d = new Date(parseInt(y), parseInt(m) - 1, parseInt(dayv));
    } else if (dateString.includes('/')) {
        const [dayv, m, y] = dateString.split('/');
        d = new Date(parseInt(y), parseInt(m) - 1, parseInt(dayv));
    } else {
        d = new Date(dateString);
    }
    if (isNaN(d.getTime())) return null;

    return {
        day: d.getDate().toString().padStart(2, '0'),
        month: stripAccents(d.toLocaleString('es-ES', { month: 'long' })),
        year: d.getFullYear().toString()
    };
}

function getCertificateDisplayLicencia(licRaw: string | undefined | null): string {
    const lic = normalizeLicenciaCode(licRaw);
    if (isTrayectoria2Lic(lic)) return 'PRO';
    if (isTrayectoria1Lic(lic)) return 'BA';
    if (lic === 'CB') return 'CB';
    if (lic.includes('COMBO') || (lic.includes('C') && lic.includes('B'))) return 'CB';
    if (lic === 'BA' || lic === 'B Y A') return 'BA';
    return lic;
}

function getDiplomaDisplayLicencia(licRaw: string | undefined | null): string {
    const lic = normalizeLicenciaCode(licRaw);
    if (isTrayectoria2Lic(lic)) return 'PRO';
    if (isTrayectoria1Lic(lic)) return 'A';
    if (lic === 'CB') return 'CB';
    if (lic.includes('COMBO') || (lic.includes('C') && lic.includes('B'))) return 'CB';
    if (lic === 'BA' || lic === 'B Y A') return 'A';
    return lic;
}

export async function generateCertificate(
    student: StudentGradeLog,
    pdfTemplateBuffer: Buffer
): Promise<Buffer> {
    const pdfDoc = await PDFDocument.load(pdfTemplateBuffer);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const form = pdfDoc.getForm();
    const cleanName = getFullName(student.name);

    const nameFields = ['Texto7', 'Texto31', 'Texto40', 'NOMBRE'];
    const dniFields = ['Texto8', 'Texto32', 'Texto41', 'DNI', 'ID'];

    nameFields.forEach(f => {
        try {
            const field = form.getTextField(f);
            if (field) {
                field.setText(cleanName);
                if (cleanName.length >= 35) field.setFontSize(6);
                else if (cleanName.length >= 28) field.setFontSize(7);
                else if (cleanName.length >= 20) field.setFontSize(8);
                field.updateAppearances(boldFont);
            }
        } catch (e) { /* ignore */ }
    });

    dniFields.forEach(f => {
        try { form.getTextField(f).setText(student.dni); } catch (e) { /* ignore */ }
    });

    const finCursadaDate = parseDateStrings(student.fecha_fin_cursada);
    if (finCursadaDate) {
        ['Texto10', 'Texto33', 'Texto43', 'DIA FINAL'].forEach(f => { try { form.getTextField(f).setText(finCursadaDate.day) } catch (e) { } });
        ['Texto11', 'Texto34', 'Texto44', 'MES FINAL'].forEach(f => { try { form.getTextField(f).setText(finCursadaDate.month) } catch (e) { } });
        ['Texto35', 'Texto45', 'AÑO FINAL'].forEach(f => { try { form.getTextField(f).setText(finCursadaDate.year) } catch (e) { } });
        ['Texto12'].forEach(f => { try { form.getTextField(f).setText(finCursadaDate.year) } catch (e) { } });
    }

    const emisionDate = parseDateStrings(student.fecha_emision);
    if (emisionDate) {
        ['Texto36', 'Texto46', 'DIA EXP'].forEach(f => { try { form.getTextField(f).setText(emisionDate.day) } catch (e) { } });
        ['Texto37', 'Texto47', 'MES EXP'].forEach(f => { try { form.getTextField(f).setText(emisionDate.month) } catch (e) { } });
        ['Texto38', 'Texto48', 'AÑO EXP'].forEach(f => { try { form.getTextField(f).setText(emisionDate.year) } catch (e) { } });
        ['Texto13'].forEach(f => { try { form.getTextField(f).setText(emisionDate.day) } catch (e) { } });
        ['Texto14'].forEach(f => { try { form.getTextField(f).setText(emisionDate.month) } catch (e) { } });
        ['Texto15'].forEach(f => { try { form.getTextField(f).setText(emisionDate.year) } catch (e) { } });
    }

    const displayLic = getCertificateDisplayLicencia(student.carrera_licencia);
    ['LICENCIA', 'Texto39', 'Texto42', 'Texto9'].forEach(f => {
        try { form.getTextField(f).setText(displayLic); } catch (e) { }
    });

    try {
        for (const g of student.grades) {
            if (g.finalGrade <= 0) continue;
            const subjectAliases = getSubjectAliases(g.subject);
            let found = false;
            for (const alias of Array.from(new Set(subjectAliases))) {
                try {
                    const numF = form.getTextField(`EN N${alias}`);
                    if (numF) { numF.setText(g.finalGradeDisplay || formatGradeDisplay(g.finalGrade)); found = true; }
                } catch (e) {
                    try {
                        const alternate = form.getTextField(`EN N ${alias}`);
                        if (alternate) { alternate.setText(g.finalGradeDisplay || formatGradeDisplay(g.finalGrade)); found = true; }
                    } catch (e2) { }
                }

                try {
                    const letF = form.getTextField(`EN LETRAS${alias}`);
                    if (letF) {
                        const textVal = numeroALetras(g.finalGrade).toUpperCase();
                        letF.setText(textVal);
                        if (textVal.includes("CON CINCUENTA")) letF.setFontSize(7);
                        found = true;
                    }
                } catch (e) {
                    try {
                        const alternate = form.getTextField(`EN LETRAS ${alias}`);
                        if (alternate) { alternate.setText(numeroALetras(g.finalGrade).toUpperCase()); found = true; }
                    } catch (e2) { }
                }

                if (found) break;
            }
        }
    } catch (e) { }

    try {
        const horasCampo = getHorasCampo(student.carrera_licencia, student.comision);

        const horasTexto = numberToWordsForHours(horasCampo);
        const horasTextoFontSize = horasTexto.length >= 20 ? 6 : horasTexto.length >= 15 ? 7 : 8;
        const setHorasNumeroField = (fieldName: string, value: string) => {
            const field = form.getTextField(fieldName);
            field.setText(value);
        };
        const setHorasLetrasField = (fieldName: string, value: string, fontSize: number) => {
            const field = form.getTextField(fieldName);
            field.setText(value);
            field.setFontSize(fontSize);
        };
        ['EN NTOTAL DE HORAS PRÃ CTICAS EN CAMPO', 'EN NTOTAL DE HORAS PRÁCTICAS EN CAMPO LIC B Y A', 'EN NTOTAL DE HORAS PRÁCTICAS EN CAMPO'].forEach(f => {
            try { setHorasNumeroField(f, String(horasCampo)); } catch (e) { }
        });
        ['EN LETRASTOTAL DE HORAS PRÃ CTICAS EN CAMPO', 'EN LETRASTOTAL DE HORAS PRÁCTICAS EN CAMPO LIC B Y A', 'EN LETRASTOTAL DE HORAS PRÁCTICAS EN CAMPO'].forEach(f => {
            try { setHorasLetrasField(f, horasTexto, horasTextoFontSize); } catch (e) { }
        });
    } catch (e) { }

    try {
        const notaPracticas = student.grades.find(g =>
            g.subject.toUpperCase().includes('PROMEDIO GENERAL DE PR')
        );
        if (notaPracticas && notaPracticas.finalGrade > 0) {
            const valNum = notaPracticas.finalGradeDisplay || formatGradeDisplay(notaPracticas.finalGrade);
            const valLetras = stripAccents(numeroALetras(notaPracticas.finalGrade));
            ['EN NPROMEDIO GENERAL DE PRÁCTICAS', 'EN NPROMEDIO GENERAL DE PRACTICAS'].forEach(f => {
                try { form.getTextField(f).setText(valNum); } catch (e) {}
            });
            ['EN LETRAS PROMEDIO GENERAL DE PRÁCTICAS', 'EN LETRAS PROMEDIO GENERAL DE PRACTICAS'].forEach(f => {
                try { form.getTextField(f).setText(valLetras); } catch (e) {}
            });
        }
    } catch (e) { }

    try { form.flatten(); } catch (e) { }
    return Buffer.from(await pdfDoc.save());
}

export async function generateDiploma(
    student: { nombre: string; apellido?: string; nacionalidad?: string; documento: string; fecha_emision?: string; carrera_licencia?: string },
    pdfTemplateBuffer: Buffer
): Promise<Buffer> {
    const pdfDoc = await PDFDocument.load(pdfTemplateBuffer);
    const form = pdfDoc.getForm();
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fullName = getFullName(student.nombre, student.apellido);
    const displayLic = getDiplomaDisplayLicencia(student.carrera_licencia);

    const fillTextFields = (
        fieldNames: string[],
        value?: string | null,
        opts?: { adjustNameFont?: boolean; fillAll?: boolean; alignCenter?: boolean; fontSize?: number; maxSize?: number }
    ) => {
        if (!value) return;
        for (const name of fieldNames) {
            try {
                const field = form.getTextField(name);
                if (!field) continue;
                field.setText(value);
                if (opts?.adjustNameFont) {
                    let size = value.length >= 46 ? 22 : value.length >= 40 ? 26 : value.length >= 34 ? 30 : value.length >= 28 ? 36 : 44;
                    if (opts?.maxSize) size = Math.min(size, opts.maxSize);
                    field.setFontSize(size);
                } else if (opts?.fontSize) {
                    field.setFontSize(opts.fontSize);
                }
                if (opts?.alignCenter) field.setAlignment(TextAlignment.Center);
                field.updateAppearances(boldFont);
                if (!opts?.fillAll) break;
            } catch (e) { }
        }
    };

    fillTextFields(['Texto1', 'Nombre y Apellido'], fullName, { adjustNameFont: true, alignCenter: true, maxSize: 42 });
    fillTextFields(['Texto2', 'Nacionalidad'], student.nacionalidad ? student.nacionalidad.toUpperCase() : null, { alignCenter: true, fontSize: 18 });
    fillTextFields(['Texto3', 'Documento/ID'], student.documento, { alignCenter: true, fontSize: 18 });

    const licMainSize = displayLic.length >= 3 ? 28 : 32;
    fillTextFields(['Texto4', 'Licencia XX'], `LICENCIA ${displayLic}`, { fillAll: true, fontSize: licMainSize, alignCenter: true });
    
    const licInlineSize = displayLic.length >= 3 ? 10 : 14;
    fillTextFields(['Texto5', 'XX'], displayLic, { fillAll: true, fontSize: licInlineSize, alignCenter: true });

    try {
        if (student.fecha_emision) {
            const fDate = parseDateStrings(student.fecha_emision);
            if (fDate) {
                const dateText = `${fDate.day} DE ${fDate.month} DE ${fDate.year}`;
                fillTextFields(['Texto6', 'Fecha de emisión'], dateText, { alignCenter: true, fontSize: 16 });
            }
        }
    } catch (e) { }

    try { form.flatten(); } catch (e) {
        try { form.getFields().forEach(f => { try { f.enableReadOnly(); } catch (e) { } }); } catch (e) { }
    }

    return Buffer.from(await pdfDoc.save());
}

export async function generateActualizacionDiploma(
    student: { nombre: string; apellido?: string; nacionalidad?: string; documento: string; fecha_emision?: string },
    pdfTemplateBuffer: Buffer
): Promise<Buffer> {
    const pdfDoc = await PDFDocument.load(pdfTemplateBuffer);
    const form = pdfDoc.getForm();
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fullName = getFullName(student.nombre, student.apellido);
    const nacionalidad = (student.nacionalidad || '').toUpperCase();
    const doc = student.documento;

    const fecha = parseDateStrings(student.fecha_emision || new Date().toISOString().split('T')[0]);
    const fechaTexto = fecha
        ? `${fecha.day} DE ${fecha.month} DE ${fecha.year}`
        : new Date().toLocaleDateString('es-AR');

    const setField = (name: string, value: string, fontSize?: number, alignCenter = true) => {
        try {
            const field = form.getTextField(name);
            field.setText(value);
            if (fontSize) field.setFontSize(fontSize);
            if (alignCenter) field.setAlignment(TextAlignment.Center);
            field.updateAppearances(boldFont);
        } catch (e) { }
    };

    const nameSize = fullName.length > 34 ? 20 : fullName.length > 28 ? 24 : 28;
    setField('Texto16', fullName, nameSize);
    setField('Texto17', nacionalidad, 16);
    setField('Texto18', doc, 16);
    setField('Texto19', fechaTexto, 14);

    setField('Texto4', fullName, nameSize);
    const natLine = `DE NACIONALIDAD ${nacionalidad}, ID ${doc},`;
    const natSize = natLine.length > 55 ? 11 : natLine.length > 45 ? 12 : 13;
    setField('Texto5', natLine, natSize);
    setField('Texto6', `CIUDAD AUTÓNOMA DE BUENOS AIRES, ${fechaTexto}`, 12);

    try { form.getFields().forEach(f => { try { f.enableReadOnly(); } catch (e) { } }); } catch (e) { }

    return Buffer.from(await pdfDoc.save());
}

export async function generateSeleccionesDiploma(
    student: { nombre: string; apellido?: string; fecha_emision?: string },
    pdfTemplateBuffer: Buffer
): Promise<Buffer> {
    const pdfDoc = await PDFDocument.load(pdfTemplateBuffer);
    const form = pdfDoc.getForm();
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    // El PDF tiene los campos: Texto1, Texto2, Texto3
    // Texto1 y Texto2 llevan el Nombre y Apellido
    // Texto3 lleva la Fecha
    
    const fullName = getFullName(student.nombre, student.apellido);
    const fecha = parseDateStrings(student.fecha_emision || new Date().toISOString().split('T')[0]);
    const fechaTexto = fecha
        ? `${fecha.day} DE ${fecha.month} DE ${fecha.year}`
        : new Date().toLocaleDateString('es-AR');

    const setField = (name: string, value: string, fontSize?: number, alignCenter = true) => {
        try {
            const field = form.getTextField(name);
            field.setText(value);
            if (fontSize) field.setFontSize(fontSize);
            if (alignCenter) field.setAlignment(TextAlignment.Center);
            field.updateAppearances(boldFont);
        } catch (e) { }
    };

    const nameSize = fullName.length > 34 ? 24 : fullName.length > 28 ? 28 : 32;
    setField('Texto1', 'SELECCIONES NACIONALES', 32);
    setField('Texto2', fullName, nameSize);
    setField('Texto3', fechaTexto, 16);

    try { form.getFields().forEach(f => { try { f.enableReadOnly(); } catch (e) { } }); } catch (e) { }

    return Buffer.from(await pdfDoc.save());
}
