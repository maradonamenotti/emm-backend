import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Student } from '../entities/Student';
import { SUBJECTS_BY_LICENSE } from '../config/subjects';
import { normalizeSubjectName, getDocsPath, cleanDNI, stripAccents, parseExcelBuffer } from '../common/helpers';
import { StudentGradeLog, generateCertificate, generateDiploma, generateActualizacionDiploma } from './pdfGenerator';
import { loadCertificateTemplate } from './certificateTemplate';
import * as path from 'path';
import * as fs from 'fs';
import * as XLSX from 'xlsx';
import archiver from 'archiver';

@Injectable()
export class CertificatesService {
  constructor(
    @InjectRepository(Student)
    private readonly studentRepo: Repository<Student>,
  ) {}

  async getCertificate(id: string) {
    const student = await this.studentRepo.findOne({
      where: { id },
      relations: { notas: true }
    });
    
    if (!student) throw new NotFoundException({ error: "Alumno no encontrado" });
    if (!student.notas || student.notas.length === 0) {
      throw new BadRequestException({ error: "Alumno sin notas: no se puede emitir analítico." });
    }

    const lic = (student.carrera_licencia || 'CB').toUpperCase().replace('LICENCIA ', '').trim();
    if (lic !== 'ACTUALIZACION') {
        const required = SUBJECTS_BY_LICENSE[lic] || [];
        for (const sub of required) {
            const normReq = normalizeSubjectName(sub);
            const nota = student.notas.find(n => normalizeSubjectName(n.asignatura) === normReq);
            if (!nota || Number(nota.nota) < 6) {
                throw new BadRequestException({ 
                    error: "Requisitos no cumplidos", 
                    message: `La materia '${sub}' falta o tiene una nota menor a 6.` 
                });
            }
        }
    }

    const formatGradeDisplay = (value: unknown): string => {
      if (value === undefined || value === null) return '';
      const raw = String(value).trim().replace(',', '.');
      if (!raw) return '';
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return raw;
      return raw.includes('.') ? raw.replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '') : raw;
    };

    const grades = student.notas.map(n => ({
      subject: n.asignatura,
      finalGrade: Number(n.nota),
      finalGradeDisplay: formatGradeDisplay(n.nota)
    }));

    let cleanLic = student.carrera_licencia ? String(student.carrera_licencia).toUpperCase().replace('LICENCIA ', '').trim() : 'CB';

    const studentData: StudentGradeLog = {
      name: student.nombre + (student.apellido !== 'Sin Apellido' && student.apellido ? ` ${student.apellido}` : ''),
      dni: student.documento,
      fecha_fin_cursada: student.fecha_fin_cursada,
      fecha_emision: student.fecha_emision,
      carrera_licencia: cleanLic,
      comision: student.comision,
      grades
    };

    const { buffer: templateBuffer, templateName } = await loadCertificateTemplate(cleanLic);
    const pdfBuf = await generateCertificate(studentData, templateBuffer);
    const cleanName = studentData.name.replace(/[^\w\s\u00C0-\u017F]/g, '').trim() || "Analitico";
    const filename = `${studentData.dni}_${cleanName}.pdf`;

    return { pdfBuf, filename };
  }

  async generateMassiveCertificates(files: any, body: any) {
    if (!files || !files.excelFile || !files.excelFile[0]) {
        throw new BadRequestException({ error: "Falta el archivo Excel (excelFile)." });
    }

    let rawLic = body.licencia;
    let licencia = rawLic ? String(rawLic).toUpperCase().replace('LICENCIA ', '').trim() : 'CB';

    let templateBuffer: Buffer;
    if (files.pdfTemplate && files.pdfTemplate[0]) {
        templateBuffer = files.pdfTemplate[0].buffer;
    } else {
        const templateName = `Certificado analítico Licencia ${licencia} - Diseño 2025.pdf`;
        const defaultPath = path.join(getDocsPath(), templateName);
        if (fs.existsSync(defaultPath)) {
            templateBuffer = fs.readFileSync(defaultPath);
        } else {
            throw new BadRequestException({ error: `Plantilla no encontrada: ${templateName}` });
        }
    }

    const workbook = parseExcelBuffer(files.excelFile[0].buffer, XLSX);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];

    if (rawData.length < 3) throw new BadRequestException({ error: "Excel sin suficientes filas" });

    const materiasMap: { [col: number]: string } = {};
    for (let i = 3; i < rawData[0].length; i += 2) {
        if (typeof rawData[0][i] === 'string') {
            materiasMap[i] = rawData[0][i].trim();
        }
    }

    const A_ALIASES: Record<string, string[]> = {
        "TÉCNICA, TÁCTICA Y ESTRATEGIA III LA ACCIÓN DE RECUPERAR": ["TÉCNICA, TÁCTICA Y ESTRATEGIA III"],
        "PLANIFICACION DEL ENTRENAMIENTO": ["PLANIFICACIÓN DEL ENTRENAMIENTO II"],
        "DESARROLLO DE TALENTOS A": ["DESARROLLO DE TALENTOS"],
        "DIRECCION DE JUGADORES I Y II": ["DIRECCIÓN DE JUGADORES Y EQUIPOS I"],
        "ADMINISTRACIÓN ESTRATÉGICA, ORGANIZACIÓN ESTRATÉGICA Y DERECHO DEPORTIVO": ["DERECHO DEPORTIVO I", "ORGANIZACIÓN DEPORTIVA", "ADMINISTRACIÓN DEPORTIVA"],
        "PREPARACION FISICA II": ["PREPARACIÓN FÍSICA II"],
        "PSICOLOGIA III": ["PSICOLOGÍA III"],
        "MEDICINA III": ["MEDICINA III"],
        "REGLAMENTO III": ["REGLAMENTO III"]
    };

    const targetStudents: StudentGradeLog[] = [];
    for (let r = 2; r < rawData.length; r++) {
        const row = rawData[r];
        if (!row || !row[0]) continue;
        const name = String(row[0]);
        const dni = String(row[1] || "");
        const grades = [];
        for (const colStr in materiasMap) {
            const col = Number(colStr);
            const i1 = Number(row[col]) || 0;
            const i2 = Number(row[col + 1]) || 0;
            const max = Math.max(i1, i2);
            if (max > 0) {
                const val = Math.round((max / 10) * 2) / 2;
                const excelHeader = materiasMap[col].toUpperCase();
                let targetSubjects: string[] = [materiasMap[col]];

                if (licencia === 'A' && A_ALIASES[excelHeader]) {
                    targetSubjects = A_ALIASES[excelHeader];
                }

                for (const subj of targetSubjects) {
                    grades.push({ subject: subj, finalGrade: val });
                }
            }
        }
        const docClean = cleanDNI(dni);
        const dbStudent = await this.studentRepo.findOneBy({ documento: docClean });
        let fecha_fin_cursada = body.fecha_fin_cursada;
        let fecha_emision = body.fecha_emision;
        let carrera_licencia = licencia || 'CB';
        let comision = body.comision ? String(body.comision) : undefined;

        if (dbStudent) {
            fecha_fin_cursada = dbStudent.fecha_fin_cursada || fecha_fin_cursada;
            fecha_emision = dbStudent.fecha_emision || fecha_emision;
            if (dbStudent.carrera_licencia) carrera_licencia = dbStudent.carrera_licencia;
            comision = dbStudent.comision || comision;
        }

        targetStudents.push({ name, dni, fecha_fin_cursada, fecha_emision, carrera_licencia, comision, grades });
    }

    const outPath = path.join(getDocsPath(), "certificados_generados.zip");
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    return new Promise((resolve, reject) => {
        output.on('close', function () {
            resolve({ success: true, downloadUrl: `/api/certificates/download-zip` });
        });
        archive.on('error', function (err: Error) {
            reject(err);
        });
        archive.pipe(output);

        (async () => {
            for (const student of targetStudents) {
                try {
                    const { buffer: tBuffer } = await loadCertificateTemplate(student.carrera_licencia);
                    const pdfBuf = await generateCertificate({
                        ...student,
                        name: stripAccents(student.name)
                    }, tBuffer);
                    const cleanName = stripAccents(student.name).replace(/\s+/g, '_');
                    archive.append(pdfBuf, { name: `${student.dni}_${cleanName}.pdf` });
                } catch (e) {
                    console.error(`Error generando PDF para ${student.name}`, e);
                }
            }
            await archive.finalize();
        })();
    });
  }

  async createDiploma(id: string, body: any) {
    const { nombre, apellido, fecha_emision } = body;
    const student = await this.studentRepo.findOne({ 
        where: { id },
        relations: ["notas"]
    });

    if (!student) throw new NotFoundException({ error: "Alumno no encontrado" });
    const lic = (student.carrera_licencia || 'CB').toUpperCase();

    if (lic !== 'ACTUALIZACION' && (!student.notas || student.notas.length === 0)) {
        throw new BadRequestException({ error: "Alumno sin notas: no se puede emitir diploma." });
    }

    const nacionalidadNormalizada = String(student.nacionalidad ?? '').trim().toUpperCase();
    if (!nacionalidadNormalizada) {
        throw new BadRequestException({ error: "Requisitos no cumplidos", message: "La nacionalidad es obligatoria para emitir el diploma." });
    }

    if (lic !== 'ACTUALIZACION') {
        const required = SUBJECTS_BY_LICENSE[lic] || [];
        for (const sub of required) {
            const normReq = normalizeSubjectName(sub);
            const nota = student.notas?.find(n => normalizeSubjectName(n.asignatura) === normReq);
            if (!nota || Number(nota.nota) < 6) {
                throw new BadRequestException({ error: "Requisitos no cumplidos", message: `La materia '${sub}' falta o tiene una nota menor a 6.` });
            }
        }
    }

    if (nombre) student.nombre = nombre.toUpperCase().trim();
    if (apellido) student.apellido = apellido.toUpperCase().trim();
    student.nacionalidad = nacionalidadNormalizada;
    if (fecha_emision) student.fecha_emision = fecha_emision;
    
    await this.studentRepo.save(student);

    let templateName = `DIPLOMA_LICENCIA_CB_MM.pdf`;
    if (lic === 'ACTUALIZACION') templateName = `DIPLOMA_ACTUALIZACION_LIC.pdf`;
    const templatePath = path.join(getDocsPath(), templateName);

    if (!fs.existsSync(templatePath)) {
        throw new BadRequestException({ error: `Plantilla de diploma no encontrada: ${templateName}` });
    }

    const templateBuffer = fs.readFileSync(templatePath);
    const diplomaBuffer = lic === 'ACTUALIZACION'
        ? await generateActualizacionDiploma({ nombre: student.nombre, apellido: student.apellido, nacionalidad: student.nacionalidad, documento: student.documento, fecha_emision: student.fecha_emision }, templateBuffer)
        : await generateDiploma({ nombre: student.nombre, apellido: student.apellido, nacionalidad: student.nacionalidad, documento: student.documento, fecha_emision: student.fecha_emision, carrera_licencia: lic }, templateBuffer);

    student.diploma_emitido = true;
    await this.studentRepo.save(student);

    const safeApellido = stripAccents(student.apellido).replace(/\s+/g, '_');
    return { buffer: diplomaBuffer, filename: `Diploma_${safeApellido}.pdf` };
  }

  async getDiploma(id: string) {
    const student = await this.studentRepo.findOneBy({ id });
    if (!student) throw new NotFoundException({ error: "Alumno no encontrado" });

    let cleanLic = student.carrera_licencia ? String(student.carrera_licencia).toUpperCase().replace('LICENCIA ', '').trim() : 'CB';
    let templateName = `DIPLOMA_LICENCIA_CB_MM.pdf`;
    if (cleanLic === 'ACTUALIZACION') templateName = `DIPLOMA_ACTUALIZACION_LIC.pdf`;
    const templatePath = path.join(getDocsPath(), templateName);

    if (!fs.existsSync(templatePath)) {
        throw new BadRequestException({ error: `Plantilla de diploma no encontrada: ${templateName}` });
    }

    const templateBuffer = fs.readFileSync(templatePath);
    const diplomaBuf = cleanLic === 'ACTUALIZACION'
        ? await generateActualizacionDiploma({ nombre: student.nombre, apellido: student.apellido, nacionalidad: student.nacionalidad, documento: student.documento, fecha_emision: student.fecha_emision }, templateBuffer)
        : await generateDiploma({ nombre: student.nombre, apellido: student.apellido, nacionalidad: student.nacionalidad, documento: student.documento, fecha_emision: student.fecha_emision, carrera_licencia: cleanLic }, templateBuffer);

    const safeApellido = stripAccents(student.apellido).replace(/\s+/g, '_');
    return { buffer: diplomaBuf, filename: `Diploma_${safeApellido}.pdf` };
  }
}
