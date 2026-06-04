import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Prospecto } from '../entities/Prospecto';
import { MensajeWhatsApp, WhatsAppEstadoLectura } from '../entities/MensajeWhatsApp';
import { EstadoEmbudo } from '../entities/EstadoEmbudo';
import { CrmPlantilla } from '../entities/CrmPlantilla';
import { WhatsAppGateway } from './whatsapp.gateway';
import { AiTriageService } from './ai-triage.service';

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
    private platformLocks = new Map<string, Promise<{ prospecto: Prospecto; isNew: boolean }>>();
    private whatsappLocks = new Map<string, Promise<{ prospecto: Prospecto; isNew: boolean }>>();

    constructor(
        @InjectRepository(Prospecto, 'crm')
        private readonly prospectoRepo: Repository<Prospecto>,
        @InjectRepository(MensajeWhatsApp, 'crm')
        private readonly mensajeRepo: Repository<MensajeWhatsApp>,
        @InjectRepository(EstadoEmbudo, 'crm')
        private readonly estadoEmbudoRepo: Repository<EstadoEmbudo>,
        @InjectRepository(CrmPlantilla, 'crm')
        private readonly plantillaRepo: Repository<CrmPlantilla>,
        private readonly gateway: WhatsAppGateway,
        private readonly aiTriageService: AiTriageService,
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

    private getTokenForPage(pageId: string): string | null {
        const token = process.env[`META_PAGE_TOKEN_${pageId}`];
        if (token) return token;
        return process.env.META_SYSTEM_USER_TOKEN || null;
    }

    private parseTimestamp(timestamp: any): Date {
        if (!timestamp) return new Date();
        const ts = Number(timestamp);
        if (ts < 9999999999) {
            return new Date(ts * 1000);
        }
        return new Date(ts);
    }

    async getOrCreateProspectoForPlatform(senderId: string, platform: 'Facebook' | 'Instagram', whatsapp_id: string, recipientPageId: string) {
        let promise = this.platformLocks.get(whatsapp_id);
        if (!promise) {
            promise = (async () => {
                let existing = await this.prospectoRepo.findOne({ where: { whatsapp_id } });
                if (existing) {
                    return { prospecto: existing, isNew: false };
                }

                let nombre = `USUARIO DE ${platform.toUpperCase()}`;
                let apellido = senderId;

                try {
                    const token = this.getTokenForPage(recipientPageId);
                    if (token) {
                        const fields = platform === 'Instagram' ? 'name,username' : 'first_name,last_name';
                        const url = `https://graph.facebook.com/v18.0/${senderId}?fields=${fields}&access_token=${token}`;
                        const res = await fetch(url);
                        if (res.ok) {
                            const data = await res.json();
                            if (platform === 'Instagram') {
                                const fullName = (data.name || '').trim().toUpperCase();
                                const username = (data.username || '').trim().toUpperCase();
                                if (fullName) {
                                    const parts = fullName.split(/\s+/);
                                    nombre = parts.shift() || 'INSTAGRAM';
                                    apellido = parts.join(' ') || username || 'USER';
                                } else if (username) {
                                    nombre = username;
                                    apellido = 'INSTAGRAM';
                                }
                            } else {
                                const firstName = (data.first_name || '').trim().toUpperCase();
                                const lastName = (data.last_name || '').trim().toUpperCase();
                                if (firstName) nombre = firstName;
                                if (lastName) apellido = lastName;
                            }
                        } else {
                            const errBody = await res.text();
                            console.warn(`Meta Profile API returned status ${res.status}:`, errBody);
                        }
                    }
                } catch (e) {
                    console.error('Error fetching user profile from Meta:', e);
                }

                const prospecto = this.prospectoRepo.create({
                    nombre,
                    apellido,
                    whatsapp_id,
                    origen: platform,
                    estado: 'Nuevo',
                    fue_alumno: false,
                });
                const saved = await this.prospectoRepo.save(prospecto);
                return { prospecto: saved, isNew: true };
            })();
            this.platformLocks.set(whatsapp_id, promise);
            try {
                return await promise;
            } finally {
                this.platformLocks.delete(whatsapp_id);
            }
        }
        return promise;
    }

    async getOrCreateProspecto(telefono: string, displayName?: string, jid?: string) {
        const lockKey = jid || telefono;
        let promise = this.whatsappLocks.get(lockKey);
        if (!promise) {
            promise = (async () => {
                let existing = jid ? await this.prospectoRepo.findOne({ where: { whatsapp_id: jid } }) : null;
                if (!existing) existing = await this.prospectoRepo.findOne({ where: { telefono } });
                
                if (existing) {
                    if (jid && !existing.whatsapp_id) {
                        existing.whatsapp_id = jid;
                        await this.prospectoRepo.save(existing);
                    }
                    return { prospecto: existing, isNew: false };
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
                const saved = await this.prospectoRepo.save(prospecto);
                return { prospecto: saved, isNew: true };
            })();
            this.whatsappLocks.set(lockKey, promise);
            try {
                return await promise;
            } finally {
                this.whatsappLocks.delete(lockKey);
            }
        }
        return promise;
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
            WHERE (p.origen IN ('WhatsApp', 'Facebook', 'Instagram') OR m.id_mensaje IS NOT NULL)
            ORDER BY (COALESCE(u.no_leidos, 0) > 0) DESC, COALESCE(m.fecha_envio, p.fecha_ingreso) DESC NULLS LAST, p.fecha_ingreso DESC
            LIMIT $1 OFFSET $2
        `, [limit + 1, offset]);

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

            const lastMessage: MensajeWhatsApp | null = row.ultimo_mensaje ? (this.mensajeRepo.create({
                ...row.ultimo_mensaje, fecha_envio: new Date(row.ultimo_mensaje.fecha_envio)
            }) as any as MensajeWhatsApp) : null;

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

    private extractNameFromText(text: string): string | null {
        if (!text) return null;
        const match = text.match(/(?:mi nombre es|soy|me llamo)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ\s]+)(?:,|\.|-|\d|mi |y |$)/i);
        if (match) {
            const name = match[1].trim();
            if (name.split(/\s+/).length <= 4) return name;
        }
        return null;
    }

    private async markAsReadMeta(senderId: string, pageId: string) {
        const token = this.getTokenForPage(pageId);
        if (!token) return;
        try {
            await fetch(`https://graph.facebook.com/v19.0/me/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    recipient: { id: senderId },
                    sender_action: 'mark_seen'
                })
            });
        } catch (e) {
            console.error('Error marking as read Meta API:', e);
        }
    }

    private async processTriageAndAutoReply(prospecto: Prospecto, text: string, isNew: boolean, defaultWelcomeMessage: string) {
        let triageResult = null;
        let isSpam = false;

        if (text && text !== '[Mensaje multimedia o interactivo]' && text !== '[Mensaje multimedia o adjunto]') {
            triageResult = await this.aiTriageService.classifyMessage(text);
            if (triageResult) {
                prospecto.ai_estado_sugerido = triageResult.estado_sugerido;
                prospecto.ai_curso_mencionado = triageResult.curso_mencionado;
                prospecto.ai_es_comprobante = triageResult.es_comprobante_pago;

                if (triageResult.estado_sugerido === 'SPAM_BASURA') {
                    isSpam = true;
                    if (!prospecto.etiquetas) prospecto.etiquetas = [];
                    if (!prospecto.etiquetas.includes('SPAM_BASURA')) {
                        prospecto.etiquetas.push('SPAM_BASURA');
                    }
                    const estadoPerdido = await this.estadoEmbudoRepo.findOneBy({ nombre: 'Perdido' });
                    if (estadoPerdido) {
                        prospecto.id_estado = estadoPerdido.id;
                        prospecto.estado = estadoPerdido.nombre;
                    }
                }
                await this.prospectoRepo.save(prospecto);
            }
        }

        let autoReplied = false;
        if (triageResult && !isSpam) {
            const query = this.plantillaRepo.createQueryBuilder('p')
                .where('p.activa = true')
                .andWhere('p.estado_sugerido = :estado', { estado: triageResult.estado_sugerido });
            
            if (triageResult.curso_mencionado) {
                query.andWhere('(p.curso ILIKE :curso OR p.curso IS NULL)', { curso: `%${triageResult.curso_mencionado}%` });
                query.orderBy('p.curso', 'DESC');
            } else {
                query.andWhere('p.curso IS NULL');
            }
            
            const plantilla = await query.getOne();
            
            if (plantilla && plantilla.texto) {
                await this.send({ id_prospecto: prospecto.id, cuerpo_mensaje: plantilla.texto });
                autoReplied = true;
            }
        }

        if (!autoReplied && isNew && defaultWelcomeMessage) {
            await this.send({
                id_prospecto: prospecto.id,
                cuerpo_mensaje: defaultWelcomeMessage
            });
        }
    }

    async processWebhook(body: any) {
        if (!body) return { success: false };

        const objectType = body.object;

        if (objectType === 'whatsapp_business_account') {
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
                        const { prospecto, isNew } = await this.getOrCreateProspecto(telefono, contact?.profile?.name);
                        const fecha = this.parseTimestamp(incoming.timestamp);
                        const text = incoming.text?.body || incoming.button?.text || incoming.interactive?.button_reply?.title || '[Mensaje multimedia o interactivo]';

                        const extractedName = this.extractNameFromText(text);
                        if (extractedName && (prospecto.nombre === 'WHATSAPP' || prospecto.nombre.includes('USUARIO DE'))) {
                            const parts = extractedName.split(/\s+/);
                            prospecto.nombre = (parts.shift() || 'WHATSAPP').toUpperCase();
                            prospecto.apellido = (parts.join(' ') || 'SIN APELLIDO').toUpperCase();
                            await this.prospectoRepo.save(prospecto);
                        }

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

                        await this.processTriageAndAutoReply(
                            prospecto,
                            text,
                            isNew,
                            '👋 ¡Hola! Bienvenido/a a Maradona Menotti. Gracias por escribirnos ⚽🏆\nSi estás interesado/a en alguna de nuestras carreras o cursos, dejanos tu nombre, teléfono y email y te contamos todo 😊'
                        );
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
        } else if (objectType === 'page' || objectType === 'instagram') {
            const entries = Array.isArray(body?.entry) ? body.entry : [];
            for (const entry of entries) {
                const recipientPageId = entry.id;
                const messagingList = Array.isArray(entry?.messaging) ? entry.messaging : [];
                
                for (const msgEvent of messagingList) {
                    const senderId = msgEvent.sender?.id;
                    if (!senderId) continue;

                    // Skip echoes (messages sent by the page itself)
                    if (senderId === recipientPageId) continue;

                    const incomingMessage = msgEvent.message || {};
                    const isStoryMention = incomingMessage.attachments && incomingMessage.attachments[0]?.type === 'story_mention';
                    const isReaction = msgEvent.reaction || isStoryMention;

                    if (isReaction) {
                        await this.markAsReadMeta(senderId, recipientPageId);
                        continue; // No procesamos como mensaje entrante de texto
                    }

                    if (!incomingMessage.mid) continue;

                    // Skip echoes indicated by flag
                    if (incomingMessage.is_echo) continue;

                    const text = incomingMessage.text || '[Mensaje multimedia o adjunto]';
                    const fecha = this.parseTimestamp(msgEvent.timestamp);
                    const platform = objectType === 'page' ? 'Facebook' : 'Instagram';
                    const whatsapp_id = `${platform.toLowerCase()}:${senderId}:${recipientPageId}`;

                    const { prospecto, isNew } = await this.getOrCreateProspectoForPlatform(senderId, platform, whatsapp_id, recipientPageId);

                    const extractedName = this.extractNameFromText(text);
                    if (extractedName && (prospecto.nombre.includes('USUARIO DE') || prospecto.apellido === 'INSTAGRAM' || prospecto.apellido === 'USER' || prospecto.apellido === senderId)) {
                        const parts = extractedName.split(/\s+/);
                        prospecto.nombre = (parts.shift() || prospecto.nombre).toUpperCase();
                        prospecto.apellido = (parts.join(' ') || 'SIN APELLIDO').toUpperCase();
                        await this.prospectoRepo.save(prospecto);
                    }

                    const message = this.mensajeRepo.create({
                        id_mensaje: incomingMessage.mid,
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

                    const isStoryReply = incomingMessage.referral?.source_type === 'STORY' || msgEvent.referral?.source_type === 'STORY';

                    if (isStoryReply && text && text !== '[Mensaje multimedia o adjunto]') {
                        await this.processTriageAndAutoReply(
                            prospecto,
                            text,
                            false,
                            '👋 ¡Hola! Gracias por tu mensaje. Si estás interesado/a en alguna de nuestras carreras o cursos, dejanos tu nombre, teléfono y email y te contamos todo 😊⚽'
                        );
                    } else {
                        await this.processTriageAndAutoReply(
                            prospecto,
                            text,
                            isNew,
                            '👋 ¡Hola! Bienvenido/a a Maradona Menotti. Gracias por escribirnos ⚽🏆\nSi estás interesado/a en alguna de nuestras carreras o cursos, dejanos tu nombre, teléfono y email y te contamos todo 😊'
                        );
                    }
                    }
                }

                const changesList = Array.isArray(entry?.changes) ? entry.changes : [];
                for (const change of changesList) {
                    let senderId: string | undefined;
                    let text: string | undefined;
                    let msgId: string | undefined;
                    let senderName: string | undefined;

                    if (objectType === 'instagram' && change.field === 'comments') {
                        senderId = change.value?.from?.id;
                        senderName = change.value?.from?.username;
                        text = change.value?.text;
                        msgId = change.value?.id;
                    } else if (objectType === 'page' && change.field === 'feed') {
                        const value = change.value || {};
                        if (value.item === 'comment' && value.verb === 'add') {
                            senderId = value.from?.id;
                            senderName = value.from?.name;
                            text = value.message;
                            msgId = value.comment_id;
                        }
                    }

                    if (!senderId || !text || !msgId || senderId === recipientPageId) continue;

                    const fecha = this.parseTimestamp(entry.time || Date.now());
                    const platform = objectType === 'page' ? 'Facebook' : 'Instagram';
                    const whatsapp_id = `${platform.toLowerCase()}:${senderId}:${recipientPageId}`;

                    const { prospecto, isNew } = await this.getOrCreateProspectoForPlatform(senderId, platform, whatsapp_id, recipientPageId);
                    
                    const commentText = `[Comentario] ${text}`;

                    if (senderName && (prospecto.nombre.includes('USUARIO DE') || prospecto.apellido === 'INSTAGRAM' || prospecto.apellido === 'USER' || prospecto.apellido === senderId)) {
                        const parts = senderName.split(/\s+/);
                        prospecto.nombre = (parts.shift() || prospecto.nombre).toUpperCase();
                        prospecto.apellido = (parts.join(' ') || 'SIN APELLIDO').toUpperCase();
                        await this.prospectoRepo.save(prospecto);
                    }

                    const message = this.mensajeRepo.create({
                        id_mensaje: msgId,
                        prospecto,
                        id_prospecto: prospecto.id,
                        direccion: 'entrante',
                        cuerpo_mensaje: commentText,
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

                    await this.processTriageAndAutoReply(
                        prospecto,
                        commentText,
                        isNew,
                        '👋 ¡Hola! Gracias por tu comentario. Si estás interesado/a en alguna de nuestras carreras o cursos, dejanos tu nombre, teléfono y email y te contamos todo 😊⚽'
                    );
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

        let prospecto: Prospecto | null = null;
        if (data.id_prospecto) {
            prospecto = await this.prospectoRepo.findOneBy({ id: data.id_prospecto });
        } else if (telefono) {
            const res = await this.getOrCreateProspecto(telefono);
            prospecto = res.prospecto;
        }
            
        if (!prospecto) throw new BadRequestException('El prospecto no existe');

        const channel = (prospecto.whatsapp_id && prospecto.whatsapp_id.startsWith('facebook:'))
            ? 'Facebook'
            : (prospecto.whatsapp_id && prospecto.whatsapp_id.startsWith('instagram:'))
            ? 'Instagram'
            : 'WhatsApp';

        if (channel === 'Facebook' || channel === 'Instagram') {
            if (!prospecto.whatsapp_id) {
                throw new BadRequestException('El prospecto no tiene ID de Facebook/Instagram válido');
            }
            const parts = prospecto.whatsapp_id.split(':');
            const senderId = parts[1];
            const pageId = parts[2];
            if (!senderId || !pageId) {
                throw new BadRequestException('El prospecto no tiene ID de Facebook/Instagram válido');
            }

            const token = this.getTokenForPage(pageId);
            if (!token) {
                throw new BadRequestException(`No se encontró token para la página/cuenta ${pageId}`);
            }

            let msgId = `local-${Date.now()}`;
            try {
                const url = `https://graph.facebook.com/v19.0/me/messages`;
                const payload: any = {
                    recipient: { id: senderId },
                    message: { text: cuerpo }
                };

                // Meta API no soporta 'messaging_type' en Instagram, lo omitimos.
                if (channel === 'Facebook') {
                    payload.messaging_type = 'RESPONSE';
                }

                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(payload)
                });

                const result = await response.json();

                if (!response.ok) {
                    console.error('Meta API Error:', result);
                    throw new Error(result.error?.message || 'Error desconocido de Meta');
                }

                if (result.message_id) {
                    msgId = result.message_id;
                }
            } catch (err: any) {
                throw new BadRequestException({ error: `Error al enviar por ${channel}`, details: err.message || err });
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

        // WhatsApp sending logic
        if (!prospecto.telefono) throw new BadRequestException('El prospecto no tiene telefono válido');

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
