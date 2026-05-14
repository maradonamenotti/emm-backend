import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as XLSX from 'xlsx';
import { Student } from '../entities/Student';
import { Nota } from '../entities/Nota';
import { normalizeKeys, parseExcelBuffer, pushHistorial, cleanDNI, normalizeSubjectName } from '../common/helpers';

@Injectable()
export class ImportsService {
  constructor(
    @InjectRepository(Student)
    private readonly studentRepo: Repository<Student>,
    @InjectRepository(Nota)
    private readonly notaRepo: Repository<Nota>,
  ) {}

  async importQuinttos(fileBuffer: Buffer, req: any) {
    const workbook = parseExcelBuffer(fileBuffer, XLSX);
    const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

    let count = 0;
    const seenSet = new Set<string>();

    for (const rawRow of (rawData as any[])) {
      const row = normalizeKeys(rawRow);

      const docRaw = row.documento || row.dni || row['nro documento'] || row['nro. documento'];
      const docClean = cleanDNI(docRaw);
      if (!docClean) continue;

      let rawLic = row.carrera || row['carrera / licencia / curso'] || row.licencia || null;
      let cleanLic = rawLic ? String(rawLic).toUpperCase().replace('LICENCIA ', '').trim() : null;

      let student = await this.studentRepo.findOne({ where: { documento: docClean } });
      if (!student) student = await this.studentRepo.findOne({ where: { documento: String(docRaw || "") } });
      
      if (student && student.estado_analitico === 'emitido') continue;
      if (!student) student = new Student();

      student.documento = docClean;
      student.nombre = row.nombre || "Sin Nombre";
      student.apellido = row.apellido || "Sin Apellido";
      student.email = row.email || null;
      student.carrera_licencia = cleanLic || student.carrera_licencia || undefined;
      student.comision = row.comision || null;

      const uniqueKey = `${docClean}-${cleanLic}`;
      if (seenSet.has(uniqueKey)) {
        student.situacion = "DUPLICADO";
      } else {
        student.situacion = row.situacion || row['situacion academica'] || row['situación académica'] || row['estado'] || null;
        seenSet.add(uniqueKey);
      }

      student.password = docClean;
      pushHistorial(student, `Alumno importado/actualizado desde el padrón QUINTTOS.`, req);

      await this.studentRepo.save(student);
      count++;
    }

    return { success: true, message: `Se procesaron ${count} alumnos de QUINTTOS.` };
  }

  async processExcel(fileBuffer: Buffer, body: any, req: any) {
    const workbook = parseExcelBuffer(fileBuffer, XLSX);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];

    if (rawData.length < 3) {
      throw new BadRequestException({ error: "Excel sin suficientes filas (Formato 2 intentos)" });
    }

    let matches = 0;
    let noMatches = 0;

    const headerRow = rawData[0] || [];
    const norm = (v: any) => (typeof v === "string" ? v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() : "");
    const findCol = (needles: string[]) => headerRow.findIndex(h => needles.some(n => norm(h).includes(n)));
    const docCol = findCol(["dni", "documento", "doc"]);
    const apellidoCol = findCol(["apellido"]);
    const nombreCol = findCol(["nombre"]);

    let firstSubjectCol = headerRow.findIndex((h, idx) => {
      if (idx === docCol || idx === apellidoCol || idx === nombreCol) return false;
      const hv = norm(h);
      if (!hv) return false;
      return !["licencia", "promedio", "promedio general", "situacion", "situacin", "estado"].some(t => hv.includes(t));
    });
    if (firstSubjectCol < 3) firstSubjectCol = 3;

    const materiasMap: { [col: number]: string } = {};
    const bannedBase = ["materia", "materias", "nombre", "apellido", "dni", "documento", "licencia", "situacion", "situación", "estado", "fecha", "curso", "comision"];
    
    let isTwoColumnsFormat = false;

    const tryFillMap = (startIdx: number) => {
      let foundSecondColumn = false;
      for (let i = startIdx; i < headerRow.length - 1; i++) {
        const h1 = norm(headerRow[i]);
        const h2 = norm(headerRow[i+1]);
        if (h1 && (!h2 || h2.includes("intento 2"))) {
          foundSecondColumn = true;
          break;
        }
      }
      isTwoColumnsFormat = foundSecondColumn;

      const step = isTwoColumnsFormat ? 2 : 1;
      for (let i = startIdx; i < headerRow.length; i += step) {
        if (typeof headerRow[i] !== "string") continue;
        const hdr = headerRow[i].trim();
        if (!hdr || hdr.length <= 1) continue;
        if (/^\d+([.,]\d+)?$/.test(hdr)) continue;
        const n = norm(hdr);
        const banned = bannedBase.some(b => n === b || n.startsWith(b + " "));
        const isPromedioPracticas = n.includes("promedio") && n.includes("pract");
        if (banned && !isPromedioPracticas) continue;
        materiasMap[i] = hdr;
      }
    };

    tryFillMap(firstSubjectCol);
    if (Object.keys(materiasMap).length === 0) {
      tryFillMap(3);
    }

    for (let r = 1; r < rawData.length; r++) {
      const row = rawData[r];
      if (!row) continue;

      const docIdx = docCol >= 0 ? docCol : 1;
      const doc = String(row[docIdx] || "").trim();
      if (!doc || doc === "undefined" || doc === "null" || doc === "") continue;
      if (!/\d/.test(doc)) continue;

      let rawLicReq = body.licencia;
      let cleanLicReq = rawLicReq ? String(rawLicReq).toUpperCase().replace('LICENCIA ', '').trim() : null;

      const docClean = cleanDNI(doc);
      const candidates = await this.studentRepo.find({ where: { documento: docClean }, relations: { notas: true } });
      if (candidates.length === 0 && doc !== docClean) {
        candidates.push(...(await this.studentRepo.find({ where: { documento: doc }, relations: { notas: true } })));
      }

      const student = candidates.find(s => {
        const dbLic = (s.carrera_licencia || '').toUpperCase().trim();
        const reqLic = (cleanLicReq || '').toUpperCase().trim();
        if (dbLic === reqLic) return true;

        const isTD1 = (l: string) => l === 'TD1' || l.includes('TRAYECTORIA DESTACADA I') || l.includes('TRAYECTORIA DESTACADA 1');
        const isTD2 = (l: string) => l === 'TD2' || l.includes('TRAYECTORIA DESTACADA II') || l.includes('TRAYECTORIA DESTACADA 2');

        if (reqLic === 'TD1' && (isTD1(dbLic) || dbLic === 'BA' || dbLic === 'B Y A')) return true;
        if (reqLic === 'TD2' && (isTD2(dbLic) || dbLic === 'PRO')) return true;
        if (reqLic === 'BA' && (isTD1(dbLic) || dbLic === 'B Y A')) return true;
        if (reqLic === 'PRO' && isTD2(dbLic)) return true;
        
        return false;
      });

      if (!student) {
        noMatches++;
        continue;
      }

      const { fecha_fin_cursada, fecha_emision } = body;
      if (fecha_fin_cursada) student.fecha_fin_cursada = fecha_fin_cursada;
      if (fecha_emision) student.fecha_emision = fecha_emision;

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

      for (const colStr in materiasMap) {
        const col = Number(colStr);
        const i1 = Number(row[col]) || 0;
        let max = i1;

        if (isTwoColumnsFormat) {
          const i2 = Number(row[col + 1]) || 0;
          max = Math.max(i1, i2);
        }

        if (!isFinite(max) || max <= 0) continue;
        if (max > 100) continue;

        if (max > 0) {
          const val = Number((max / 10).toFixed(2));

          const excelHeader = materiasMap[col].toUpperCase();
          const excelNorm = normalizeSubjectName(excelHeader).toLowerCase();
          let targetSubjects: string[] = [materiasMap[col]];
          const promAlias = excelNorm.includes('promedio') && excelNorm.includes('practic');
          if (promAlias) {
            targetSubjects = ['PROMEDIO GENERAL DE PRÁCTICAS'];
          }
          if (cleanLicReq === 'A' && A_ALIASES[excelHeader]) {
            targetSubjects = A_ALIASES[excelHeader];
          }

          for (const subjectAlias of targetSubjects) {
            let newNota = student.notas?.find(n => normalizeSubjectName(n.asignatura) === normalizeSubjectName(subjectAlias));
            if (!newNota) {
              newNota = new Nota();
              newNota.student = student;
              newNota.asignatura = subjectAlias;
            }
            newNota.nota = val;
            newNota.fecha = new Date();
            const savedNota = await this.notaRepo.save(newNota);
            student.notas = student.notas || [];
            const existingIdx = student.notas.findIndex(n => n.id === savedNota.id);
            if (existingIdx >= 0) {
              student.notas[existingIdx] = savedNota;
            } else {
              student.notas.push(savedNota);
            }
          }
        }
      }

      pushHistorial(student, `Importación de notas desde excel completada (${isTwoColumnsFormat ? '2 intentos' : 'consecutivo'}).`, req);
      await this.studentRepo.save(student);

      matches++;
    }

    return { data: { success: true, matchCount: matches, noMatchCount: noMatches } };
  }
}
