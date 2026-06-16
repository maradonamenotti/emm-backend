import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, IsNull, Or, MoreThan } from 'typeorm';
import { Prospecto } from '../entities/Prospecto';
import { EstadoEmbudo } from '../entities/EstadoEmbudo';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { HistorialSeguimiento } from '../entities/HistorialSeguimiento';
import { CrmPlantilla } from '../entities/CrmPlantilla';

@Injectable()
export class CrmCronService {
    private readonly logger = new Logger(CrmCronService.name);

    constructor(
        @InjectRepository(Prospecto, 'crm')
        private readonly prospectoRepo: Repository<Prospecto>,
        @InjectRepository(EstadoEmbudo, 'crm')
        private readonly estadoEmbudoRepo: Repository<EstadoEmbudo>,
        @InjectRepository(HistorialSeguimiento, 'crm')
        private readonly historialRepo: Repository<HistorialSeguimiento>,
        @InjectRepository(CrmPlantilla, 'crm')
        private readonly plantillaRepo: Repository<CrmPlantilla>,
        private readonly whatsappService: WhatsAppService,
    ) {}

    /**
     * Tarea: Auto-descarte por falta de respuesta (Cada día a las 3 AM)
     */
    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async handleAutoDescarte() {
        this.logger.log('Iniciando limpieza de prospectos inactivos...');
        
        const estadoDescartado = await this.estadoEmbudoRepo.findOneBy({ nombre: 'Descartado' });
        if (!estadoDescartado) return;

        // Buscamos todos los estados que tengan configurado inactividad_dias_descarte
        const estadosConAutoDescarte = await this.estadoEmbudoRepo.find({
            where: { inactividad_dias_descarte: MoreThan(0) }
        });

        for (const estado of estadosConAutoDescarte) {
            const limite = new Date();
            limite.setDate(limite.getDate() - (estado.inactividad_dias_descarte || 14));

            const prospectos = await this.prospectoRepo
                .createQueryBuilder('p')
                .where('p.id_estado = :estadoId', { estadoId: estado.id })
                .andWhere('(p.fecha_ultimo_mensaje_cliente <= :limite OR (p.fecha_ultimo_mensaje_cliente IS NULL AND p.fecha_ingreso <= :limite))', { limite })
                .getMany();

            for (const p of prospectos) {
                this.logger.log(`Auto-descartando prospecto ${p.nombre} ${p.apellido} desde estado ${estado.nombre}.`);
                p.id_estado = estadoDescartado.id;
                p.estado = estadoDescartado.nombre;
                await this.prospectoRepo.save(p);

                await this.historialRepo.save({
                    prospecto_id: p.id,
                    tipo_contacto: 'Sistema',
                    nota: `Descartado automáticamente por inactividad (> ${estado.inactividad_dias_descarte} días) en etapa ${estado.nombre}.`,
                    fecha_contacto: new Date(),
                });
            }
        }
        
        this.logger.log('Limpieza completada.');
    }

    /**
     * Tarea: Limpieza de Fantasmas (Contactos sin datos) (Cada día a las 4 AM)
     */
    @Cron(CronExpression.EVERY_DAY_AT_4AM)
    async handleLimpiezaFantasmas() {
        this.logger.log('Iniciando limpieza automática de prospectos fantasma...');
        
        const estadoDescartado = await this.estadoEmbudoRepo.findOneBy({ nombre: 'Descartado' });
        if (!estadoDescartado) return;

        const limiteGeneral = new Date();
        limiteGeneral.setDate(limiteGeneral.getDate() - 1); // 24 horas de gracia general

        const limiteComentarios = new Date();
        limiteComentarios.setHours(limiteComentarios.getHours() - 12); // 12 horas de gracia para comentarios de Instagram/Facebook

        const fantasmas = await this.prospectoRepo
            .createQueryBuilder('p')
            .where('p.telefono IS NULL')
            .andWhere('p.email IS NULL')
            .andWhere('p.id_estado != :descartadoId', { descartadoId: estadoDescartado.id })
            .andWhere(
                `((p.origen IN ('Instagram - Comentario', 'Facebook') AND p.fecha_ingreso <= :limiteComentarios) OR 
                  (p.origen NOT IN ('Instagram - Comentario', 'Facebook') AND p.fecha_ingreso <= :limiteGeneral))`
            )
            .setParameters({ limiteGeneral, limiteComentarios })
            .getMany();

        if (fantasmas.length > 0) {
            for (const p of fantasmas) {
                this.logger.log(`Auto-descartando fantasma ${p.nombre} ${p.apellido} (Origen: ${p.origen}).`);
                p.id_estado = estadoDescartado.id;
                p.estado = estadoDescartado.nombre;
                p.motivo_perdida = 'Sin datos de contacto (Fantasma)';
                await this.prospectoRepo.save(p);

                await this.historialRepo.save({
                    prospecto_id: p.id,
                    tipo_contacto: 'Sistema',
                    nota: `Descartado automáticamente por no proveer datos de contacto después de ${p.origen?.includes('Comentario') ? '12' : '24'} horas.`,
                    fecha_contacto: new Date(),
                });
            }
        }
        
        this.logger.log(`Limpieza de fantasmas completada. Se descartaron ${fantasmas.length} prospectos.`);
    }

    /**
     * Tarea: Seguimiento automático (Cada hora)
     */
    @Cron(CronExpression.EVERY_HOUR)
    async handleSeguimientoAutomatico() {
        this.logger.log('Verificando seguimientos automáticos dinámicos...');

        // Solo enviar recordatorios automáticos en horario comercial (9 a 20 hs) para no parecer un robot de madrugada
        const currentHour = new Date().getHours();
        if (currentHour < 9 || currentHour >= 20) {
            this.logger.log('Fuera de horario comercial. Se posponen los seguimientos automáticos hasta las 9 AM.');
            return;
        }

        // Buscamos estados con recordatorio configurado
        const estadosConRecordatorio = await this.estadoEmbudoRepo.find({
            where: { recordatorio_horas: MoreThan(0) }
        });

        for (const estado of estadosConRecordatorio) {
            const limite = new Date();
            limite.setHours(limite.getHours() - (estado.recordatorio_horas || 48));

            const pendientes = await this.prospectoRepo
                .createQueryBuilder('p')
                .where('p.id_estado = :estadoId', { estadoId: estado.id })
                .andWhere('(p.fecha_ultimo_mensaje_cliente IS NULL OR p.fecha_ultimo_mensaje_cliente <= :limite)', { limite })
                .andWhere('(p.fecha_ultimo_mensaje_sistema IS NULL OR p.fecha_ultimo_mensaje_sistema <= :limite)', { limite })
                .getMany();

            if (pendientes.length === 0) continue;

            // Obtener plantilla si existe
            let plantillaTexto = `¡Hola {{nombre}}! 👋 Solo quería saber si pudiste revisar la información que te enviamos. ¿Tienes alguna duda en la que pueda ayudarte?`;
            if (estado.id_plantilla_recordatorio) {
                const p = await this.plantillaRepo.findOneBy({ id: estado.id_plantilla_recordatorio });
                if (p) plantillaTexto = p.texto;
            }

            for (const p of pendientes) {
                if (!p.telefono) continue;

                const mensajeFinal = plantillaTexto
                    .replace(/{{\s*nombre\s*}}/gi, p.nombre || '')
                    .replace(/{{\s*curso\s*}}/gi, p.curso_interes || 'la carrera/curso de interés')
                    .replace(/\[Nombre\]/gi, p.nombre || '')
                    .replace(/\[Curso\]/gi, p.curso_interes || 'la carrera/curso de interés')
                    .replace(/Carrera de Entrenador de Fútbol/gi, p.curso_interes || 'la carrera/curso de interés');
                
                try {
                    await this.whatsappService.send({
                        id_prospecto: p.id,
                        cuerpo_mensaje: mensajeFinal
                    });
                    this.logger.log(`Recordatorio enviado a ${p.nombre} (Estado: ${estado.nombre})`);
                } catch (err) {
                    this.logger.error(`Error enviando seguimiento a ${p.id}: ${err.message}`);
                }
            }
        }
    }
}
