import { Injectable, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Student } from '../entities/Student';
import { Nota } from '../entities/Nota';
import { normalizeSubjectName, pushHistorial } from '../common/helpers';
import { SUBJECTS_BY_LICENSE } from '../config/subjects';

@Injectable()
export class StudentsService implements OnModuleInit {
  constructor(
    @InjectRepository(Student)
    private readonly studentsRepository: Repository<Student>,
    @InjectRepository(Nota)
    private readonly notasRepository: Repository<Nota>,
  ) {}

  async onModuleInit() {
    try {
      console.log('Running automatic en_analiticos migration check...');
      const result = await this.studentsRepository.query(`
        UPDATE student 
        SET en_analiticos = true 
        WHERE en_analiticos = false 
        AND (
          id IN (SELECT DISTINCT student_id FROM "nota") 
          OR estado_analitico = 'emitido' 
          OR situacion = 'CREADO MANUAL'
        )
      `);
      console.log('en_analiticos migration completed.');
    } catch (err) {
      console.error('Error running en_analiticos migration:', err);
    }
  }

  private formatStudent(s: Student) {
    const notas = s.notas || [];
    const totalNotas = notas.reduce((acc, curr) => acc + (Number(curr.nota) || 0), 0);
    const promedio = notas.length ? Number((totalNotas / notas.length).toFixed(2)) : 0;
    const emitido = (s.estado_analitico || 'borrador') === 'emitido';

    return {
      id: s.id,
      dni: s.documento, // legacy support for pdfService
      documento: s.documento,
      nombre: s.nombre,
      apellido: s.apellido,
      email: s.email,
      nacionalidad: s.nacionalidad,
      pais_residencia: s.pais_residencia,
      comision: s.comision,
      situacion: s.situacion,
      estado_analitico: s.estado_analitico || 'borrador',
      diploma_emitido: s.diploma_emitido || false,
      fecha_emision: s.fecha_emision || '',
      fecha_fin_cursada: s.fecha_fin_cursada || '',
      pagos_ok: emitido || !!s.pagos_ok,
      documentacion_ok: emitido || !!s.documentacion_ok,
      historial: s.historial || [],
      licencia: s.carrera_licencia || "N/A", // legacy support
      carrera_licencia: s.carrera_licencia,
      quinttos_id: s.quinttos_id,
      matricula: s.matricula,
      datos_extra: s.datos_extra,
      en_analiticos: !!s.en_analiticos,
      promedio,
      notas: notas.map(n => ({ materia: n.asignatura, nota: Number(n.nota), fecha: n.fecha }))
    };
  }

  async findAll() {
    const students = await this.studentsRepository.find({
      relations: { notas: true },
      order: { nombre: 'ASC' }
    });
    return students.map(s => this.formatStudent(s));
  }

  async findOne(id: string) {
    const student = await this.studentsRepository.findOne({
      where: { id },
      relations: { notas: true }
    });
    if (!student) throw new NotFoundException({ error: "Alumno no encontrado" });
    return this.formatStudent(student);
  }

  async create(data: any, req: any) {
    const { nombre, apellido, nacionalidad, documento, licencia, fecha_emision, fecha_fin_cursada } = data;
    if (!nombre || !apellido || !documento) {
      throw new BadRequestException({ error: "Nombre, apellido y documento son obligatorios" });
    }

    const student = new Student();
    student.nombre = String(nombre).toUpperCase().trim();
    student.apellido = String(apellido).toUpperCase().trim();
    student.documento = String(documento).trim();
    student.nacionalidad = nacionalidad ? String(nacionalidad).toUpperCase().trim() : undefined;
    const cleanLic = licencia ? String(licencia).toUpperCase().replace('LICENCIA ', '').trim() : undefined;
    student.carrera_licencia = cleanLic;
    student.fecha_emision = fecha_emision || undefined;
    student.fecha_fin_cursada = fecha_fin_cursada || undefined;
    student.estado_analitico = 'borrador';
    student.situacion = 'CREADO MANUAL';
    student.en_analiticos = true;
    student.password = student.documento;

    pushHistorial(student, 'Alumno creado manualmente desde la UI.', req);
    const saved = await this.studentsRepository.save(student);

    const subjects = cleanLic ? SUBJECTS_BY_LICENSE[cleanLic] || [] : [];
    if (subjects.length > 0) {
      const notas = subjects.map(sub => {
        const n = new Nota();
        n.student = saved;
        n.asignatura = sub;
        n.nota = 0;
        return n;
      });
      await this.notasRepository.save(notas);
    }

    const withRelations = await this.studentsRepository.findOne({
      where: { id: saved.id },
      relations: { notas: true }
    });
    return withRelations;
  }

  async remove(id: string) {
    await this.studentsRepository.delete({ id });
    return { success: true };
  }

  async updateEstado(id: string, data: any, req: any) {
    const student = await this.studentsRepository.findOneBy({ id });
    if (!student) throw new NotFoundException({ error: "Alumno no encontrado" });

    const newEstado = data.estado || (student.estado_analitico === 'emitido' ? 'borrador' : 'emitido');
    
    if (newEstado === 'emitido') {
      const studentWithNotas = await this.studentsRepository.findOne({
        where: { id: student.id },
        relations: ["notas"]
      });
      
      if (!studentWithNotas) throw new NotFoundException({ error: "Alumno no encontrado" });
      if (!studentWithNotas.pagos_ok) throw new BadRequestException({ error: "Requisitos no cumplidos", message: "No se puede emitir: faltan validar los pagos." });
      if (!studentWithNotas.documentacion_ok) throw new BadRequestException({ error: "Requisitos no cumplidos", message: "No se puede emitir: falta validar la documentacion." });
      if (!studentWithNotas.fecha_fin_cursada) throw new BadRequestException({ error: "Requisitos no cumplidos", message: "No se puede emitir: falta cargar la fecha de fin de cursada." });

      const licRaw = (studentWithNotas.carrera_licencia || 'CB').toUpperCase().replace('LICENCIA ', '').trim();
      const isSelecciones = licRaw === 'SELECCIONES_NACIONALES' || licRaw.includes('SELECCIONES');
      const isAct = licRaw === 'ACTUALIZACION' || licRaw.includes('ACTUALIZACION');
      
      if (!isAct && !isSelecciones) {
        const required = SUBJECTS_BY_LICENSE[licRaw] || [];
        for (const sub of required) {
          const normReq = normalizeSubjectName(sub);
          const nota = studentWithNotas.notas?.find(n => normalizeSubjectName(n.asignatura) === normReq);
          if (!nota || Number(nota.nota) < 6) {
            throw new BadRequestException({ error: "Requisitos no cumplidos", message: `No se puede emitir: La materia '${sub}' falta o tiene una nota menor a 6.` });
          }
        }
      }
    }

    student.estado_analitico = newEstado;
    const motivo = data.motivo ? ` Motivo: ${data.motivo}` : '';
    pushHistorial(student, `Cambio de estado analítico a: ${student.estado_analitico.toUpperCase()}.${motivo}`, req);

    await this.studentsRepository.save(student);
    return { success: true, estado: student.estado_analitico };
  }

  async updateDates(id: string, data: any, req: any) {
    const { fecha_emision, fecha_fin_cursada } = data;
    const student = await this.studentsRepository.findOneBy({ id });
    if (!student) throw new NotFoundException({ error: "Alumno no encontrado" });

    let cambios: string[] = [];
    if (student.fecha_emision !== fecha_emision) cambios.push(`Fecha Emisión: ${fecha_emision || 'Vacío'}`);
    if (student.fecha_fin_cursada !== fecha_fin_cursada) cambios.push(`Fecha Fin Cursada: ${fecha_fin_cursada || 'Vacío'}`);

    student.fecha_emision = fecha_emision;
    student.fecha_fin_cursada = fecha_fin_cursada;

    if (cambios.length > 0) {
      pushHistorial(student, `Actualización de fechas. ${cambios.join(' | ')}`, req);
    }

    await this.studentsRepository.save(student);
    return { success: true, student };
  }

  async updateLegajo(id: string, data: any, req: any) {
    const { pagos_ok, documentacion_ok } = data;
    const student = await this.studentsRepository.findOneBy({ id });
    if (!student) throw new NotFoundException({ error: "Alumno no encontrado" });

    const cambios: string[] = [];

    if (typeof pagos_ok === 'boolean' && student.pagos_ok !== pagos_ok) {
        student.pagos_ok = pagos_ok;
        cambios.push(`Pagos OK: ${pagos_ok ? 'SI' : 'NO'}`);
    }

    if (typeof documentacion_ok === 'boolean' && student.documentacion_ok !== documentacion_ok) {
        student.documentacion_ok = documentacion_ok;
        cambios.push(`Documentacion OK: ${documentacion_ok ? 'SI' : 'NO'}`);
    }

    if (cambios.length > 0) {
        pushHistorial(student, `Actualizacion de legajo. ${cambios.join(' | ')}`, req);
    }

    await this.studentsRepository.save(student);
    return { success: true, data: { pagos_ok: student.pagos_ok, documentacion_ok: student.documentacion_ok } };
  }

  async updateDatos(id: string, data: any, req: any) {
    const { documento, nombre, apellido, nacionalidad, email } = data;
    const student = await this.studentsRepository.findOneBy({ id });
    if (!student) throw new NotFoundException({ error: "Alumno no encontrado" });

    if (documento) student.documento = String(documento).trim();
    if (nombre) student.nombre = String(nombre).toUpperCase().trim();
    if (apellido) student.apellido = String(apellido).toUpperCase().trim();
    if (nacionalidad !== undefined) student.nacionalidad = String(nacionalidad).trim().toUpperCase();
    if (email !== undefined) student.email = String(email).trim();

    pushHistorial(student, `Datos personales actualizados: DNI=${student.documento}, Nombre=${student.nombre}, Apellido=${student.apellido}, Nacionalidad=${student.nacionalidad || 'N/A'}`, req);

    await this.studentsRepository.save(student);
    return { success: true };
  }

  async removeBulk(ids: string[]) {
    if (!ids || !Array.isArray(ids)) {
      throw new BadRequestException({ error: "Se requiere un array de IDs (ids)." });
    }
    const deleteResult = await this.studentsRepository
      .createQueryBuilder()
      .delete()
      .from(Student)
      .where("id IN (:...ids)", { ids })
      .execute();
    return { message: `${ids.length} alumnos eliminados correctamente. Filas afectadas: ${deleteResult.affected}` };
  }

  // Notas
  async updateNota(id: string, data: any, req: any) {
    const { asignatura, nota } = data;
    const student = await this.studentsRepository.findOneBy({ id });
    if (!student) throw new NotFoundException({ error: "Alumno no encontrado" });

    const notaNum = parseFloat(nota);
    if (isNaN(notaNum) || notaNum < 0 || notaNum > 10) throw new BadRequestException({ error: "Nota inválida (debe ser 0-10)" });
    if (!asignatura || !asignatura.trim()) throw new BadRequestException({ error: "El nombre de la materia es requerido" });

    let existingNota = await this.notasRepository.findOneBy({ student: { id: student.id }, asignatura: asignatura.trim() });
    if (existingNota) {
      existingNota.nota = notaNum;
      existingNota.fecha = new Date();
      await this.notasRepository.save(existingNota);
    } else {
      const newNota = new Nota();
      newNota.student = student;
      newNota.asignatura = asignatura.trim();
      newNota.nota = notaNum;
      newNota.fecha = new Date();
      await this.notasRepository.save(newNota);
    }

    student.en_analiticos = true;
    pushHistorial(student, `Nota manual cargada: ${asignatura} = ${notaNum}`, req);
    await this.studentsRepository.save(student);

    return { success: true, message: `${asignatura}: ${notaNum} guardado.` };
  }

  async removeNota(id: string, data: any) {
    const { asignatura } = data;
    const student = await this.studentsRepository.findOneBy({ id });
    if (!student) throw new NotFoundException({ error: "Alumno no encontrado" });

    const nota = await this.notasRepository.findOneBy({ student: { id: student.id }, asignatura: asignatura?.trim() });
    if (nota) await this.notasRepository.remove(nota);
    return { success: true };
  }

  async removeAllNotas(id: string, req: any) {
    const student = await this.studentsRepository.findOne({ where: { id }, relations: ["notas"] });
    if (!student) throw new NotFoundException({ error: "Alumno no encontrado" });

    if (student.notas.length > 0) {
      await this.notasRepository.remove(student.notas);
    }

    student.estado_analitico = 'borrador';
    pushHistorial(student, 'Eliminación manual de todas las notas del alumno.', req);
    await this.studentsRepository.save(student);

    return { success: true, message: "Notas eliminadas correctamente." };
  }

  async moveToAnaliticos(id: string, req: any) {
    const student = await this.studentsRepository.findOneBy({ id });
    if (!student) throw new NotFoundException({ error: "Alumno no encontrado" });

    student.en_analiticos = true;
    pushHistorial(student, 'Alumno movido manualmente a la sección de Analíticos.', req);
    await this.studentsRepository.save(student);

    return { success: true, message: "Alumno movido a analíticos exitosamente." };
  }

  async clearPadron() {
    // Delete students where en_analiticos is false AND they have no notes AND estado_analitico is borrador
    // Because notes cascade, we can check if they have notes by using a query builder.
    const result = await this.studentsRepository.createQueryBuilder('student')
      .leftJoin('student.notas', 'nota')
      .where('student.en_analiticos = :enAnaliticos', { enAnaliticos: false })
      .andWhere('student.estado_analitico = :estado', { estado: 'borrador' })
      .andWhere('nota.id IS NULL') // ensures no related notes exist
      .delete()
      .execute();

    return { 
      success: true, 
      message: `Se han eliminado ${result.affected} registros del padrón que no tenían datos de analítico.` 
    };
  }
}

