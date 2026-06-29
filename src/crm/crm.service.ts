import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { Prospecto } from '../entities/Prospecto';
import { HistorialSeguimiento } from '../entities/HistorialSeguimiento';
import { CrmConfigItem } from '../entities/CrmConfigItem';
import { CrmPlantilla } from '../entities/CrmPlantilla';
import { EstadoEmbudo } from '../entities/EstadoEmbudo';
import * as XLSX from 'xlsx';

const DEFAULT_CURSOS = [
    'Selecciones Nacionales',
    'Facilitador',
    'Entrenador',
    'Actualización',
    'Membresía',
    'Asistente Táctico',
    'Licencia C',
    'Licencia B',
    'Licencia CB',
    'Licencia A',
    'Licencia PRO',
    'Licencia TD1',
    'Licencia TD2',
    'Preparador Físico',
    'Entrenador de Arqueros',
];

@Injectable()
export class CrmService {
    constructor(
        @InjectRepository(Prospecto, 'crm')
        private readonly prospectoRepo: Repository<Prospecto>,
        @InjectRepository(HistorialSeguimiento, 'crm')
        private readonly historialRepo: Repository<HistorialSeguimiento>,
        @InjectRepository(CrmConfigItem, 'crm')
        private readonly configRepo: Repository<CrmConfigItem>,
        @InjectRepository(CrmPlantilla, 'crm')
        private readonly plantillaRepo: Repository<CrmPlantilla>,
        @InjectRepository(EstadoEmbudo, 'crm')
        private readonly estadoEmbudoRepo: Repository<EstadoEmbudo>,
    ) {}

    private lastAssignedOperatorIndex = 0;

    private async getNextOperator(): Promise<string | null> {
        const operadoras = await this.configRepo.find({
            where: { tipo: 'operadora' },
            order: { orden: 'ASC' }
        });
        if (operadoras.length === 0) return null;
        
        const index = this.lastAssignedOperatorIndex % operadoras.length;
        const op = operadoras[index].valor;
        this.lastAssignedOperatorIndex = (index + 1) % operadoras.length;
        return op;
    }

    async onModuleInit() {
        await this.seedEstados();
        await this.seedCursos();
    }

    private async seedCursos() {
        for (const [index, valor] of DEFAULT_CURSOS.entries()) {
            const item = await this.configRepo.findOne({ where: { tipo: 'curso', valor } });
            if (!item) {
                await this.configRepo.save(this.configRepo.create({
                    tipo: 'curso',
                    valor,
                    orden: index + 1,
                }));
            }
        }
    }

    private uniqueConfigItems(items: CrmConfigItem[]) {
        const seen = new Set<string>();
        return items.filter(item => {
            const key = `${item.tipo}:${item.valor.trim().toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    private normalizeTags(value: unknown) {
        if (!Array.isArray(value)) return [];
        const seen = new Set<string>();
        return value
            .map(tag => String(tag || '').trim())
            .filter(tag => {
                const key = tag.toLowerCase();
                if (!tag || seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .slice(0, 12);
    }

    private async seedEstados() {
        const defaultEstados = [
            { 
                nombre: 'Nuevo', orden: 1, color: '#3B82F6', es_sistema: true, icono: '🔵',
                descripcion: 'La consulta entró pero aún nadie respondió. Es el punto de partida del embudo.',
                accion_sugerida: 'Responder lo antes posible — el tiempo de respuesta es clave para la conversión.'
            },
            { 
                nombre: 'Primer Contacto', orden: 2, color: '#8B5CF6', es_sistema: true, icono: '🟣',
                descripcion: 'Se estableció el primer contacto y el lead está en proceso de recibir información inicial.',
                accion_sugerida: 'Enviar información del curso, consultar nombre y país, y agendar próximo aviso.'
            },
            { 
                nombre: 'En Seguimiento', orden: 3, color: '#F59E0B', es_sistema: false, icono: '🟡',
                descripcion: 'El lead recibió información y está siendo acompañado activamente en su proceso de decisión.',
                accion_sugerida: 'Usar mensajes de seguimiento 1, 2 o 3 según los días transcurridos sin respuesta.'
            },
            { 
                nombre: 'Reserva Iniciada', orden: 4, color: '#F97316', es_sistema: false, icono: '🟠',
                descripcion: 'El lead completó el formulario de pre-inscripción. Está a un paso de inscribirse.',
                accion_sugerida: 'Confirmar recepción, enviar requisitos y orientar el pago o documentación.'
            },
            { 
                nombre: 'Inscripto', orden: 5, color: '#10B981', es_sistema: true, es_ganado: true, icono: '🟢',
                descripcion: '¡Conversión exitosa! El lead se convirtió en alumno de la institución.',
                accion_sugerida: 'Dar la bienvenida oficial y derivar al área académica o administrativa.'
            },
            { 
                nombre: 'Descartado', orden: 6, color: '#EF4444', es_sistema: true, es_perdido: true, icono: '⚫',
                descripcion: 'El lead no avanzó en el proceso, ya sea por falta de respuesta o por decisión propia.',
                accion_sugerida: 'Enviar mensaje de cierre cordial. Puede volver a consultar en el futuro.'
            },
        ];

        for (const def of defaultEstados) {
            let item = await this.estadoEmbudoRepo.findOneBy({ nombre: def.nombre });
            if (!item) {
                item = this.estadoEmbudoRepo.create(def);
                await this.estadoEmbudoRepo.save(item);
            } else {
                // Sincronizar campos faltantes
                if (!item.descripcion || !item.icono) {
                    item.descripcion = item.descripcion || def.descripcion;
                    item.accion_sugerida = item.accion_sugerida || def.accion_sugerida;
                    item.icono = item.icono || def.icono;
                    await this.estadoEmbudoRepo.save(item);
                }
            }
        }
        console.log('Sincronización de estados completada.');
    }

    // ─── CONFIG (catálogos) ────────────────────────────────────────────
    async getConfig() {
        const [items, estados, plantillas] = await Promise.all([
            this.configRepo.find({ order: { tipo: 'ASC', orden: 'ASC', valor: 'ASC' } }),
            this.estadoEmbudoRepo.find({ order: { orden: 'ASC' } }),
            this.plantillaRepo.find({ order: { curso: 'ASC', categoria: 'ASC', orden: 'ASC', titulo: 'ASC' } }),
        ]);
        const origenes = this.uniqueConfigItems(items.filter(i => i.tipo === 'origen'));
        const cursos = this.uniqueConfigItems(items.filter(i => i.tipo === 'curso'));
        const operadoras = this.uniqueConfigItems(items.filter(i => i.tipo === 'operadora'));
        return {
            estados: estados.map(e => ({ ...e, valor: e.nombre })), // Map for compatibility
            plantillas,
            origenes,
            cursos,
            operadoras,
        };
    }

    async createConfigItem(data: Partial<CrmConfigItem>) {
        if (!data.tipo || !data.valor) throw new BadRequestException('tipo y valor son requeridos');
        data.tipo = data.tipo.trim();
        data.valor = data.valor.trim();
        const exists = await this.configRepo.findOne({ where: { tipo: data.tipo, valor: data.valor } });
        if (exists) throw new BadRequestException('Ese valor ya existe en la configuración');
        const item = this.configRepo.create(data);
        return this.configRepo.save(item);
    }

    async updateConfigItem(id: string, data: Partial<CrmConfigItem>) {
        const item = await this.configRepo.findOneBy({ id });
        if (!item) throw new NotFoundException('Item no encontrado');
        Object.assign(item, data);
        return this.configRepo.save(item);
    }

    async deleteConfigItem(id: string) {
        await this.configRepo.delete({ id });
        return { success: true };
    }

    // ─── ESTADOS DEL EMBUDO ───────────────────────────────────────────
    async findAllEstados() {
        return this.estadoEmbudoRepo.find({ order: { orden: 'ASC' } });
    }

    async createEstado(data: Partial<EstadoEmbudo>) {
        const item = this.estadoEmbudoRepo.create(data);
        return this.estadoEmbudoRepo.save(item);
    }

    async updateEstadoConfig(id: string, data: Partial<EstadoEmbudo>) {
        const item = await this.estadoEmbudoRepo.findOneBy({ id });
        if (!item) throw new NotFoundException('Estado no encontrado');
        Object.assign(item, data);
        return this.estadoEmbudoRepo.save(item);
    }

    async deleteEstado(id: string) {
        const item = await this.estadoEmbudoRepo.findOneBy({ id });
        if (!item) throw new NotFoundException('Estado no encontrado');
        if (item.es_sistema) throw new BadRequestException('No se puede eliminar un estado del sistema');
        
        await this.estadoEmbudoRepo.delete({ id });
        return { success: true };
    }

    // ─── PROSPECTOS ────────────────────────────────────────────────────

    async findAll(filters: { estado?: string; id_estado?: string; origen?: string; asignado_a?: string; curso?: string }) {
        const qb = this.prospectoRepo
            .createQueryBuilder('p')
            .leftJoinAndSelect('p.historial', 'h')
            .leftJoinAndSelect('p.estado_entidad', 'ee')
            .orderBy('p.fecha_ingreso', 'DESC');

        if (filters.id_estado)  qb.andWhere('p.id_estado = :id_estado', { id_estado: filters.id_estado });
        else if (filters.estado) qb.andWhere('p.estado = :estado', { estado: filters.estado });
        
        if (filters.origen)     qb.andWhere('p.origen = :origen', { origen: filters.origen });
        if (filters.asignado_a) qb.andWhere('p.asignado_a = :asignado_a', { asignado_a: filters.asignado_a });
        if (filters.curso)      qb.andWhere('p.curso_interes = :curso', { curso: filters.curso });

        return qb.getMany();
    }

    async findOne(id: string) {
        const p = await this.prospectoRepo.findOne({
            where: { id },
            relations: { historial: true },
            order: { historial: { fecha_contacto: 'DESC' } },
        });
        if (!p) throw new NotFoundException('Prospecto no encontrado');
        return p;
    }

    async create(data: Partial<Prospecto>) {
        if (!data.nombre || !data.apellido) throw new BadRequestException('nombre y apellido son requeridos');
        
        // Asignar estado inicial si no viene
        if (!data.id_estado) {
            const nuevoStatus = await this.estadoEmbudoRepo.findOneBy({ nombre: 'Nuevo' });
            if (nuevoStatus) data.id_estado = nuevoStatus.id;
        }

        const p = this.prospectoRepo.create({
            nombre: data.nombre.trim().toUpperCase(),
            apellido: data.apellido.trim().toUpperCase(),
            telefono: data.telefono ? String(data.telefono).replace(/[^\d]/g, '') || undefined : undefined,
            email: data.email?.trim().toLowerCase(),
            curso_interes: data.curso_interes,
            origen: data.origen || 'WhatsApp',
            id_estado: data.id_estado,
            estado: data.estado || 'Nuevo',
            asignado_a: data.asignado_a,
            etiquetas: this.normalizeTags(data.etiquetas),
            notas_generales: data.notas_generales,
            silenciar_automatizaciones: data.silenciar_automatizaciones ?? false,
        });
        if (!p.asignado_a) {
            const nextOp = await this.getNextOperator();
            if (nextOp) p.asignado_a = nextOp;
        }
        return this.prospectoRepo.save(p);
    }

    async update(id: string, data: Partial<Prospecto>) {
        const p = await this.prospectoRepo.findOneBy({ id });
        if (!p) throw new NotFoundException('Prospecto no encontrado');
        if (data.nombre) data.nombre = data.nombre.trim().toUpperCase();
        if (data.apellido) data.apellido = data.apellido.trim().toUpperCase();
        if (data.telefono !== undefined) data.telefono = data.telefono ? String(data.telefono).replace(/[^\d]/g, '') || undefined : undefined;
        if (data.etiquetas !== undefined) data.etiquetas = this.normalizeTags(data.etiquetas);
        Object.assign(p, data);
        return this.prospectoRepo.save(p);
    }

    async updateEstado(id: string, id_estado: string, motivo_perdida?: string) {
        const p = await this.prospectoRepo.findOneBy({ id });
        if (!p) throw new NotFoundException('Prospecto no encontrado');
        
        const est = await this.estadoEmbudoRepo.findOneBy({ id: id_estado });
        if (est) {
            p.id_estado = id_estado;
            p.estado = est.nombre; // Sync string for now
        } else {
            // Fallback for legacy string updates
            p.estado = id_estado;
        }

        if (motivo_perdida !== undefined) {
            p.motivo_perdida = motivo_perdida;
        }
        
        return this.prospectoRepo.save(p);
    }

    async remove(id: string) {
        await this.prospectoRepo.delete({ id });
        return { success: true };
    }

    async mergeProspectos(sourceId: string, targetId: string) {
        if (sourceId === targetId) throw new BadRequestException('No se puede fusionar un prospecto consigo mismo');

        const source = await this.prospectoRepo.findOneBy({ id: sourceId });
        const target = await this.prospectoRepo.findOneBy({ id: targetId });

        if (!source || !target) {
            throw new NotFoundException('Prospecto origen o destino no encontrado');
        }

        // 1. Mover mensajes de WhatsApp
        await this.prospectoRepo.manager.query(
            'UPDATE mensajes_whatsapp SET id_prospecto = $1 WHERE id_prospecto = $2',
            [targetId, sourceId]
        );

        // 2. Mover historial de seguimiento
        await this.historialRepo.update({ prospecto_id: sourceId }, { prospecto_id: targetId });

        // 3. Combinar notas generales
        const notasSource = (source.notas_generales || '').trim();
        const notasTarget = (target.notas_generales || '').trim();
        if (notasSource) {
            target.notas_generales = notasTarget 
                ? `${notasTarget}\n\n[Fusionado de ${source.nombre} ${source.apellido}]:\n${notasSource}` 
                : notasSource;
        }

        // 4. Combinar etiquetas
        const etiquetasSource = source.etiquetas || [];
        const etiquetasTarget = target.etiquetas || [];
        target.etiquetas = this.normalizeTags([...etiquetasTarget, ...etiquetasSource]);

        // 5. Preservar datos de contacto si el destino no los tiene
        if (!target.telefono && source.telefono) target.telefono = source.telefono;
        if (!target.email && source.email) target.email = source.email;
        if (!target.pais && source.pais) target.pais = source.pais;
        if (!target.curso_interes && source.curso_interes) target.curso_interes = source.curso_interes;

        // Guardar destino
        await this.prospectoRepo.save(target);

        // 6. Eliminar origen
        await this.prospectoRepo.delete({ id: sourceId });

        return { success: true, targetId };
    }

    async limpiarFantasmas() {
        const descartado = await this.estadoEmbudoRepo.findOneBy({ nombre: 'Descartado' });
        if (!descartado) throw new BadRequestException('Estado Descartado no encontrado');

        const fantasmas = await this.prospectoRepo.createQueryBuilder('p')
            .where('p.telefono IS NULL')
            .andWhere('p.email IS NULL')
            .andWhere('p.id_estado != :descartadoId', { descartadoId: descartado.id })
            .getMany();

        if (fantasmas.length === 0) return { count: 0 };

        for (const p of fantasmas) {
            p.id_estado = descartado.id;
            p.estado = descartado.nombre;
            p.motivo_perdida = 'Sin datos de contacto (Fantasma)';
        }

        await this.prospectoRepo.save(fantasmas);

        return { count: fantasmas.length };
    }

    async importarExcel(fileBuffer: Buffer, curso_interes: string) {
        if (!fileBuffer) throw new BadRequestException('No se recibió el archivo Excel');
        
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        
        const rawData = XLSX.utils.sheet_to_json(sheet) as any[];
        if (rawData.length === 0) throw new BadRequestException('El archivo Excel está vacío');

        const estadoInicial = await this.estadoEmbudoRepo.findOneBy({ nombre: 'Nuevo' }) 
            || await this.estadoEmbudoRepo.findOneBy({ orden: 1 });

        let count = 0;
        for (const row of rawData) {
            // Normalizar keys para encontrarlas fácilmente sin importar mayúsculas
            const normalizedRow: any = {};
            for (const key in row) {
                normalizedRow[key.toLowerCase().trim()] = row[key];
            }

            const nombreCompleto = normalizedRow['nombre completo'] || normalizedRow['nombre'] || '';
            const email = normalizedRow['email'] || normalizedRow['correo'] || normalizedRow['mail'];
            const whatsappRaw = normalizedRow['whatsapp_number'] || normalizedRow['whatsapp'] || normalizedRow['telefono'] || normalizedRow['celular'];

            if (!nombreCompleto && !whatsappRaw && !email) continue;

            const partes = nombreCompleto.trim().split(' ');
            const nombre = partes[0] || 'SIN NOMBRE';
            const apellido = partes.slice(1).join(' ') || 'SIN APELLIDO';

            const p = new Prospecto();
            p.nombre = nombre.toUpperCase();
            p.apellido = apellido.toUpperCase();
            p.email = email ? String(email).trim().toLowerCase() : undefined;
            p.telefono = whatsappRaw ? String(whatsappRaw).replace(/[^\d]/g, '') : undefined;
            p.curso_interes = curso_interes || undefined;
            p.origen = 'Importación Excel';
            
            if (estadoInicial) {
                p.id_estado = estadoInicial.id;
                p.estado = estadoInicial.nombre;
            }

            const nextOp = await this.getNextOperator();
            if (nextOp) p.asignado_a = nextOp;

            p.fecha_ingreso = new Date();
            
            await this.prospectoRepo.save(p);
            count++;
        }

        return { success: true, count, message: `Se importaron ${count} prospectos correctamente.` };
    }

    // ─── HISTORIAL ─────────────────────────────────────────────────────
    async addSeguimiento(prospecto_id: string, data: Partial<HistorialSeguimiento>) {
        const p = await this.prospectoRepo.findOneBy({ id: prospecto_id });
        if (!p) throw new NotFoundException('Prospecto no encontrado');
        const h = this.historialRepo.create({ ...data, prospecto_id });
        return this.historialRepo.save(h);
    }

    async removeSeguimiento(id: string) {
        await this.historialRepo.delete({ id });
        return { success: true };
    }

    async snoozeSeguimiento(id: string, dias: number) {
        const h = await this.historialRepo.findOneBy({ id });
        if (!h) throw new NotFoundException('Seguimiento no encontrado');
        
        const date = new Date();
        date.setDate(date.getDate() + dias);
        h.fecha_proximo_aviso = date.toISOString().split('T')[0];
        
        return this.historialRepo.save(h);
    }

    // ─── KPI STATS ─────────────────────────────────────────────────────
    async getStats() {
        const [prospectos, estados, origenes, alertas, cursos] = await Promise.all([
            this.prospectoRepo.find(),
            this.estadoEmbudoRepo.find({ order: { orden: 'ASC' } }),
            this.configRepo.find({ where: { tipo: 'origen' }, order: { orden: 'ASC' } }),
            this.historialRepo
                .createQueryBuilder('h')
                .leftJoinAndSelect('h.prospecto', 'p')
                .leftJoin('p.estado_entidad', 'ee')
                .where('h.fecha_proximo_aviso <= :hoy', { hoy: new Date().toISOString().split('T')[0] })
                .andWhere('(ee.es_ganado = false AND ee.es_perdido = false)')
                .orderBy('h.fecha_proximo_aviso', 'ASC')
                .getMany(),
            this.configRepo.find({ where: { tipo: 'curso' } }),
        ]);

        const total = prospectos.length;
        const ganadosIds = estados.filter(e => e.es_ganado).map(e => e.id);
        const perdidosIds = estados.filter(e => e.es_perdido).map(e => e.id);
        
        const inscriptos = prospectos.filter(p => p.id_estado && ganadosIds.includes(p.id_estado)).length;
        const descartados = prospectos.filter(p => p.id_estado && perdidosIds.includes(p.id_estado)).length;
        const activos = total - descartados;
        const tasaConversion = activos > 0 ? Math.round((inscriptos / activos) * 100) : 0;

        // Map course name -> value
        const courseValues = new Map<string, number>();
        for (const c of cursos) {
            courseValues.set(c.valor.toUpperCase().trim(), c.valor_estimado || 0);
        }

        let ingresosGanados = 0;
        let ingresosPerdidos = 0;

        for (const p of prospectos) {
            if (!p.id_estado) continue;
            const cursoKey = (p.curso_interes || '').toUpperCase().trim();
            const val = courseValues.get(cursoKey) || 0;
            if (ganadosIds.includes(p.id_estado)) {
                ingresosGanados += val;
            } else if (perdidosIds.includes(p.id_estado)) {
                ingresosPerdidos += val;
            }
        }

        const porEstado = estados.map(e => ({
            id: e.id,
            estado: e.nombre,
            color: e.color,
            es_ganado: e.es_ganado,
            es_perdido: e.es_perdido,
            count: prospectos.filter(p => p.id_estado === e.id).length,
        }));

        const porOrigen = origenes.map(o => ({
            origen: o.valor,
            color: o.color,
            count: prospectos.filter(p => p.origen === o.valor).length,
        }));

        const noLeidosChatsRes = await this.prospectoRepo.query(`
            SELECT COUNT(DISTINCT p.id)::int AS count
            FROM prospecto p
            INNER JOIN mensajes_whatsapp um ON um.id_prospecto = p.id
            WHERE um.direccion = 'entrante'
              AND (p.whatsapp_ultimo_leido_at IS NULL OR um.fecha_envio > p.whatsapp_ultimo_leido_at);
        `);
        const noLeidosChatsCount = noLeidosChatsRes[0]?.count || 0;

        const motivosMap = new Map<string, number>();
        for (const p of prospectos) {
            if (p.id_estado && perdidosIds.includes(p.id_estado) && p.motivo_perdida) {
                motivosMap.set(p.motivo_perdida, (motivosMap.get(p.motivo_perdida) || 0) + 1);
            }
        }
        const motivosPerdida = Array.from(motivosMap.entries())
            .map(([motivo, count]) => ({ motivo, count }))
            .sort((a, b) => b.count - a.count);

        return {
            total,
            inscriptos,
            descartados,
            activos,
            tasaConversion,
            ingresosGanados,
            ingresosPerdidos,
            porEstado,
            porOrigen,
            motivosPerdida,
            noLeidosChatsCount,
            alertasSeguimiento: alertas.map(h => ({
                id: h.id,
                prospecto_id: h.prospecto_id,
                nombre: h.prospecto ? `${h.prospecto.nombre} ${h.prospecto.apellido}` : '',
                telefono: h.prospecto?.telefono,
                fecha_proximo_aviso: h.fecha_proximo_aviso,
                nota: h.nota,
            })),
        };
    }

    // ─── EXPORT EXCEL ──────────────────────────────────────────────────
    async exportExcel(filters: any): Promise<Buffer> {
        const prospectos = await this.findAll(filters);

        const rowsProspectos = prospectos.map(p => ({
            'Nombre': p.nombre,
            'Apellido': p.apellido,
            'Teléfono': p.telefono || '',
            'Email': p.email || '',
            'Curso Interés': p.curso_interes || '',
            'Origen': p.origen,
            'Estado': p.estado,
            'Asignado A': p.asignado_a || '',
            'Notas Generales': p.notas_generales || '',
            'Fecha Ingreso': p.fecha_ingreso ? new Date(p.fecha_ingreso).toLocaleDateString('es-AR') : '',
        }));

        const rowsHistorial: any[] = [];
        for (const p of prospectos) {
            for (const h of (p.historial || [])) {
                rowsHistorial.push({
                    'Prospecto': `${p.nombre} ${p.apellido}`,
                    'Teléfono': p.telefono || '',
                    'Tipo Contacto': h.tipo_contacto,
                    'Nota': h.nota || '',
                    'Fecha Contacto': h.fecha_contacto ? new Date(h.fecha_contacto).toLocaleDateString('es-AR') : '',
                    'Próximo Aviso': h.fecha_proximo_aviso || '',
                });
            }
        }

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsProspectos), 'Prospectos');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsHistorial.length ? rowsHistorial : [{}]), 'Historial');
        return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    }

    // ─── PLANTILLAS ────────────────────────────────────────────────────
    async findAllPlantillas(filters: { curso?: string; categoria?: string } = {}) {
        const qb = this.plantillaRepo
            .createQueryBuilder('p')
            .orderBy('p.curso', 'ASC', 'NULLS FIRST')
            .addOrderBy('p.categoria', 'ASC')
            .addOrderBy('p.orden', 'ASC')
            .addOrderBy('p.titulo', 'ASC');

        if (filters.curso) {
            qb.andWhere('(p.curso = :curso OR p.curso IS NULL)', { curso: filters.curso });
        }

        if (filters.categoria) {
            qb.andWhere('p.categoria = :categoria', { categoria: filters.categoria });
        }

        return qb.getMany();
    }

    async createPlantilla(data: Partial<CrmPlantilla>) {
        if (!data.titulo || !data.texto) throw new BadRequestException('titulo y texto son requeridos');
        data.titulo = data.titulo.trim();
        data.categoria = data.categoria?.trim() || 'Primer Contacto';
        data.curso = data.curso?.trim() || null;
        data.estado_sugerido = data.estado_sugerido?.trim() || null;
        const p = this.plantillaRepo.create(data);
        return this.plantillaRepo.save(p);
    }

    async updatePlantilla(id: string, data: Partial<CrmPlantilla>) {
        const p = await this.plantillaRepo.findOneBy({ id });
        if (!p) throw new NotFoundException('Plantilla no encontrada');
        if (data.titulo !== undefined) data.titulo = data.titulo.trim();
        if (data.categoria !== undefined) data.categoria = data.categoria.trim() || 'Primer Contacto';
        if (data.curso !== undefined) data.curso = data.curso?.trim() || null;
        if (data.estado_sugerido !== undefined) data.estado_sugerido = data.estado_sugerido?.trim() || null;
        Object.assign(p, data);
        return this.plantillaRepo.save(p);
    }

    async deletePlantilla(id: string) {
        await this.plantillaRepo.delete({ id });
        return { success: true };
    }
}
