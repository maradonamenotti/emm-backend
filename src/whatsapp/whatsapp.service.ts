import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Prospecto } from '../entities/Prospecto';
import { MensajeWhatsApp, WhatsAppEstadoLectura } from '../entities/MensajeWhatsApp';
import { EstadoEmbudo } from '../entities/EstadoEmbudo';
import { WhatsAppGateway } from './whatsapp.gateway';

export interface SerializedMessage {
    id_mensaje: string;
    id_prospecto: string;
    direccion: string;
    cuerpo_mensaje: string;
    fecha_envio: Date;
    estado_lectura: string;
}

interface PaginationOptions {
    limit?: string | number;
    offset?: string | number;
}

interface MessageQueryOptions {
    limit?: string | number;
    before?: string;
    resolveContact?: string | boolean;
}

@Injectable()
export class WhatsAppService {
    constructor(
        @InjectRepository(Prospecto, 'crm')
        private readonly prospectoRepo: Repository<Prospecto>,
        @InjectRepository(MensajeWhatsApp, 'crm')
        private readonly mensajeRepo: Repository<MensajeWhatsApp>,
        @InjectRepository(EstadoEmbudo, 'crm')
        private readonly estadoEmbudoRepo: Repository<EstadoEmbudo>,
        private readonly gateway: WhatsAppGateway,
    ) {}

    private parseLimit(value: unknown, fallback = 60, max = 200) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
        return Math.min(Math.floor(parsed), max);
    }

    private parseOffset(value: unknown) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) return 0;
        return Math.floor(parsed);
    }

    private parseDate(value?: string) {
        if (!value) return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
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

    normalizePhone(value: unknown) {
        return String(value || '').replace(/[^\d]/g, '');
    }

    serializeMessage(message: MensajeWhatsApp): SerializedMessage {
        return {
            id_mensaje: message.id_mensaje,
            id_prospecto: message.id_prospecto,
            direccion: message.direccion,
            cuerpo_mensaje: message.cuerpo_mensaje,
            fecha_envio: message.fecha_envio,
            estado_lectura: message.estado_lectura,
        };
    }

    async serializeConversation(prospecto: Prospecto, lastMessage?: MensajeWhatsApp | null, unreadCount?: number) {
        const ultimo_mensaje = lastMessage === undefined
            ? await this.mensajeRepo.findOne({
                where: { id_prospecto: prospecto.id },
                order: { fecha_envio: 'DESC' },
            })
            : lastMessage;
        let no_leidos = unreadCount;
        if (no_leidos === undefined) {
            const qb = this.mensajeRepo.createQueryBuilder('m')
                .where('m.id_prospecto = :id', { id: prospecto.id })
                .andWhere('m.direccion = :direccion', { direccion: 'entrante' });
            if (prospecto.whatsapp_ultimo_leido_at) {
                qb.andWhere('m.fecha_envio > :ultimoLeido', { ultimoLeido: prospecto.whatsapp_ultimo_leido_at });
            }
            no_leidos = await qb.getCount();
        }

        return {
            id: prospecto.id,
            nombre: prospecto.nombre,
            apellido: prospecto.apellido,
            telefono: prospecto.telefono,
            whatsapp_id: prospecto.whatsapp_id,
            email: prospecto.email,
            pais: prospecto.pais,
            curso_interes: prospecto.curso_interes,
            origen: prospecto.origen,
            estado: prospecto.estado,
            asignado_a: prospecto.asignado_a,
            etiquetas: prospecto.etiquetas || [],
            no_leidos,
            fue_alumno: prospecto.fue_alumno,
            fecha_ingreso: prospecto.fecha_ingreso,
            notas_generales: prospecto.notas_generales,
            ultimo_mensaje: ultimo_mensaje ? this.serializeMessage(ultimo_mensaje) : null,
        };
    }

    async getOrCreateProspecto(telefono: string, displayName?: string, jid?: string) {
        let existing = jid ? await this.prospectoRepo.findOne({ where: { whatsapp_id: jid } }) : null;
        if (!existing) existing = await this.prospectoRepo.findOne({ where: { telefono } });
        
        if (existing) {
            if (jid && !existing.whatsapp_id) {
                existing.whatsapp_id = jid;
                await this.prospectoRepo.save(existing);
            }
            return existing;
        }

        const parts = (displayName || '').trim().split(/\s+/).filter(Boolean);
        const nombre = (parts.shift() || 'WHATSAPP').toUpperCase();
        const apellido = (parts.join(' ') || 'SIN APELLIDO').toUpperCase();

        const prospecto = this.prospectoRepo.create({
            nombre,
            apellido,
            telefono,
            whatsapp_id: jid,
            origen: 'WhatsApp',
            estado: 'Nuevo',
            fue_alumno: false,
        });
        return this.prospectoRepo.save(prospecto);
    }

    async conversations(options: PaginationOptions = {}) {
        const limit = this.parseLimit(options.limit, 60, 150);
        const offset = this.parseOffset(options.offset);

        const rows = await this.prospectoRepo.query(`
            SELECT
                p.id, p.nombre, p.apellido, p.telefono, p.whatsapp_id, p.email,
                p.pais, p.curso_interes, p.origen, p.estado, p.asignado_a,
                p.etiquetas, p.whatsapp_ultimo_leido_at, p.fue_alumno,
                p.fecha_ingreso, p.notas_generales,
                row_to_json(m.*) AS ultimo_mensaje,
                COALESCE(u.no_leidos, 0)::int AS no_leidos
            FROM prospecto p
            LEFT JOIN (
                SELECT DISTINCT ON (id_prospecto) *
                FROM mensajes_whatsapp
                ORDER BY id_prospecto, fecha_envio DESC, id_mensaje DESC
            ) m ON m.id_prospecto = p.id
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS no_leidos
                FROM mensajes_whatsapp um
                WHERE um.id_prospecto = p.id
                  AND um.direccion = 'entrante'
                  AND (p.whatsapp_ultimo_leido_at IS NULL OR um.fecha_envio > p.whatsapp_ultimo_leido_at)
            ) u ON true
            WHERE p.telefono IS NOT NULL AND p.origen = $1
            ORDER BY (COALESCE(u.no_leidos, 0) > 0) DESC, COALESCE(m.fecha_envio, p.fecha_ingreso) DESC NULLS LAST, p.fecha_ingreso DESC
            LIMIT $2 OFFSET $3
        `, ['WhatsApp', limit + 1, offset]);

        const pageRows = rows.slice(0, limit);
        const items = await Promise.all(pageRows.map((row: any) => {
            const prospecto = this.prospectoRepo.create({
                id: row.id, nombre: row.nombre, apellido: row.apellido, telefono: row.telefono,
                whatsapp_id: row.whatsapp_id, email: row.email, pais: row.pais,
                curso_interes: row.curso_interes, origen: row.origen, estado: row.estado,
                asignado_a: row.asignado_a, etiquetas: this.normalizeTags(row.etiquetas),
                whatsapp_ultimo_leido_at: row.whatsapp_ultimo_leido_at, fue_alumno: row.fue_alumno,
                fecha_ingreso: row.fecha_ingreso, notas_generales: row.notas_generales,
            });

            const lastMessage = row.ultimo_mensaje ? this.mensajeRepo.create({
                ...row.ultimo_mensaje, fecha_envio: new Date(row.ultimo_mensaje.fecha_envio)
            }) : null;

            return this.serializeConversation(prospecto, lastMessage, Number(row.no_leidos || 0));
        }));

        return { items, hasMore: rows.length > limit, limit, offset };
    }

    async messages(prospectoId: string, options: MessageQueryOptions = {}) {
        if (!prospectoId) throw new BadRequestException('prospecto_id es requerido');
        const prospecto = await this.prospectoRepo.findOneBy({ id: prospectoId });
        if (!prospecto) throw new NotFoundException('Prospecto no encontrado');

        const limit = this.parseLimit(options.limit, 60, 200);
        const before = this.parseDate(options.before);
        const where: any = { id_prospecto: prospectoId };
        if (before) where.fecha_envio = LessThan(before);

        const mensajes = await this.mensajeRepo.find({
            where, order: { fecha_envio: 'DESC' }, take: limit + 1,
        });
        const page = mensajes.slice(0, limit).reverse();

        return {
            prospecto: await this.serializeConversation(prospecto, before ? undefined : (mensajes[0] || null)),
            mensajes: page.map(m => this.serializeMessage(m)),
            hasMore: mensajes.length > limit, limit,
        };
    }

    async processWebhook(body: any) {
        const entries = Array.isArray(body?.entry) ? body.entry : [];

        for (const entry of entries) {
            const changes = Array.isArray(entry?.changes) ? entry.changes : [];
            for (const change of changes) {
                const value = change?.value || {};
                const contacts = Array.isArray(value.contacts) ? value.contacts : [];
                const messages = Array.isArray(value.messages) ? value.messages : [];
                const statuses = Array.isArray(value.statuses) ? value.statuses : [];

                for (const incoming of messages) {
                    const telefono = this.normalizePhone(incoming.from);
                    if (!telefono || !incoming.id) continue;

                    const contact = contacts.find((c: any) => this.normalizePhone(c.wa_id) === telefono);
                    const prospecto = await this.getOrCreateProspecto(telefono, contact?.profile?.name);
                    const fecha = incoming.timestamp ? new Date(Number(incoming.timestamp) * 1000) : new Date();
                    const text = incoming.text?.body || incoming.button?.text || incoming.interactive?.button_reply?.title || '[Mensaje multimedia o interactivo]';

                    const message = this.mensajeRepo.create({
                        id_mensaje: incoming.id,
                        prospecto,
                        id_prospecto: prospecto.id,
                        direccion: 'entrante',
                        cuerpo_mensaje: text,
                        fecha_envio: fecha,
                        estado_lectura: 'Entregado',
                    });

                    await this.mensajeRepo.upsert(message, ['id_mensaje']);
                    
                    prospecto.fecha_ultimo_mensaje_cliente = fecha;
                    await this.prospectoRepo.save(prospecto);

                    const payload = {
                        prospecto: await this.serializeConversation(prospecto),
                        mensaje: this.serializeMessage(message),
                    };
                    this.gateway.emit('whatsapp:message', payload);
                }

                for (const status of statuses) {
                    if (!status.id) continue;
                    const message = await this.mensajeRepo.findOneBy({ id_mensaje: status.id });
                    if (!message) continue;
                    message.estado_lectura = this.mapStatus(status.status);
                    await this.mensajeRepo.save(message);
                    this.gateway.emit('whatsapp:status', this.serializeMessage(message));
                }
            }
        }
        return { success: true };
    }

    mapStatus(status: string): WhatsAppEstadoLectura {
        if (status === 'read') return 'Leido';
        if (status === 'delivered') return 'Entregado';
        return 'Enviado';
    }

    async logout() {
        return { success: true, message: 'La sesión es gestionada por Meta Cloud API. No requiere desvinculación.' };
    }

    getStatus() {
        return { isReady: true, type: 'cloud_api' };
    }

    async markRead(prospectoId: string) {
        if (!prospectoId) throw new BadRequestException('prospecto_id es requerido');
        const prospecto = await this.prospectoRepo.findOneBy({ id: prospectoId });
        if (!prospecto) throw new NotFoundException('Prospecto no encontrado');

        prospecto.whatsapp_ultimo_leido_at = new Date();
        await this.prospectoRepo.save(prospecto);
        return this.serializeConversation(prospecto);
    }

    async send(data: { id_prospecto?: string; telefono?: string; cuerpo_mensaje?: string; text?: string }) {
        const cuerpo = String(data.cuerpo_mensaje || data.text || '').trim();
        const telefono = this.normalizePhone(data.telefono);
        if (!cuerpo) throw new BadRequestException('cuerpo_mensaje es requerido');

        const prospecto = data.id_prospecto
            ? await this.prospectoRepo.findOneBy({ id: data.id_prospecto })
            : telefono ? await this.getOrCreateProspecto(telefono) : null;
            
        if (!prospecto || !prospecto.telefono) throw new BadRequestException('El prospecto no tiene telefono válido');

        const phoneId = process.env.META_PHONE_NUMBER_ID;
        const token = process.env.META_SYSTEM_USER_TOKEN;

        if (!phoneId || !token) {
            throw new BadRequestException('Faltan credenciales de Meta en el archivo .env (META_PHONE_NUMBER_ID o META_SYSTEM_USER_TOKEN)');
        }

        let msgId = `local-${Date.now()}`;
        try {
            const url = `https://graph.facebook.com/v19.0/${phoneId}/messages`;
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to: prospecto.telefono,
                    type: 'text',
                    text: { preview_url: false, body: cuerpo }
                })
            });

            const result = await response.json();

            if (!response.ok) {
                console.error('Meta API Error:', result);
                throw new Error(result.error?.message || 'Error desconocido de Meta');
            }

            if (result.messages && result.messages[0]) {
                msgId = result.messages[0].id;
            }
        } catch (err: any) {
            throw new BadRequestException({ error: 'Error al enviar por Meta Cloud API', details: err.message || err });
        }

        const message = this.mensajeRepo.create({
            id_mensaje: msgId,
            prospecto,
            id_prospecto: prospecto.id,
            direccion: 'saliente',
            cuerpo_mensaje: cuerpo,
            fecha_envio: new Date(),
            estado_lectura: 'Enviado',
        });
        await this.mensajeRepo.save(message);

        // Cambio a Primer Contacto
        const estadoNuevo = await this.estadoEmbudoRepo.findOneBy({ nombre: 'Nuevo' });
        const estadoPrimerContacto = await this.estadoEmbudoRepo.findOneBy({ nombre: 'Primer Contacto' });
        if (estadoNuevo && estadoPrimerContacto && (prospecto.id_estado === estadoNuevo.id || prospecto.estado === 'Nuevo')) {
            prospecto.id_estado = estadoPrimerContacto.id;
            prospecto.estado = estadoPrimerContacto.nombre;
        }

        prospecto.fecha_ultimo_mensaje_sistema = new Date();
        await this.prospectoRepo.save(prospecto);

        const payload = { prospecto: await this.serializeConversation(prospecto), mensaje: this.serializeMessage(message) };
        this.gateway.emit('whatsapp:message', payload);
        return payload;
    }
}
