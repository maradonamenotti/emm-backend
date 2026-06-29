import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Prospecto } from '../entities/Prospecto';
import { MensajeWhatsApp, WhatsAppEstadoLectura } from '../entities/MensajeWhatsApp';
import { EstadoEmbudo } from '../entities/EstadoEmbudo';
import { CrmPlantilla } from '../entities/CrmPlantilla';
import { Student } from '../entities/Student';
import { WhatsAppGateway } from './whatsapp.gateway';
import { AiTriageService } from './ai-triage.service';
import * as fs from 'fs';
import * as path from 'path';

// @ts-ignore
import { Client, LocalAuth } from 'whatsapp-web.js';

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
export class WhatsAppService implements OnModuleInit {
    private platformLocks = new Map<string, Promise<{ prospecto: Prospecto; isNew: boolean }>>();
    private whatsappLocks = new Map<string, Promise<{ prospecto: Prospecto; isNew: boolean }>>();
    private client!: Client;
    private isClientReady = false;
    private lastQr: string | null = null;
    private sendQueue: Array<{ jid: string; cuerpo: string; resolve: (val: any) => void; reject: (err: any) => void }> = [];
    private isProcessingQueue = false;
    private lastAssignedOperatorIndex = 0;

    private async getNextOperator(): Promise<string | null> {
        try {
            const operadoras = await this.prospectoRepo.manager.query(
                "SELECT valor FROM crm_config_item WHERE tipo = 'operadora' ORDER BY orden ASC"
            );
            if (!operadoras || operadoras.length === 0) return null;
            
            const index = this.lastAssignedOperatorIndex % operadoras.length;
            const op = operadoras[index].valor;
            this.lastAssignedOperatorIndex = (index + 1) % operadoras.length;
            return op;
        } catch (e) {
            console.error('Error fetching operators for Round Robin:', e);
            return null;
        }
    }

    constructor(
        @InjectRepository(Prospecto, 'crm')
        private readonly prospectoRepo: Repository<Prospecto>,
        @InjectRepository(MensajeWhatsApp, 'crm')
        private readonly mensajeRepo: Repository<MensajeWhatsApp>,
        @InjectRepository(EstadoEmbudo, 'crm')
        private readonly estadoEmbudoRepo: Repository<EstadoEmbudo>,
        @InjectRepository(CrmPlantilla, 'crm')
        private readonly plantillaRepo: Repository<CrmPlantilla>,
        @InjectRepository(Student)
        private readonly studentRepo: Repository<Student>,
        private readonly gateway: WhatsAppGateway,
        private readonly aiTriageService: AiTriageService,
    ) {}

    onModuleInit() {
        this.initializeClient();
    }

    private initializeClient() {
        console.log('Initializing WhatsApp Web client...');
        this.client = new Client({
            authStrategy: new LocalAuth({ dataPath: './wwebjs_auth' }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ],
            }
        });

        this.client.on('qr', (qr: string) => {
            console.log('WhatsApp QR Code received.');
            this.lastQr = qr;
            this.isClientReady = false;
            this.gateway.emit('whatsapp:qr', qr);
        });

        this.client.on('ready', () => {
            console.log('WhatsApp Web client is ready!');
            this.isClientReady = true;
            this.lastQr = null;
            this.gateway.emit('whatsapp:status', { status: 'ready' });
        });

        this.client.on('disconnected', (reason: string) => {
            console.log('WhatsApp Web client disconnected:', reason);
            this.isClientReady = false;
            this.lastQr = null;
            this.gateway.emit('whatsapp:status', { status: 'disconnected' });
            
            // Attempt to destroy and re-initialize
            try {
                this.client.destroy().catch(() => {});
            } catch (e) {}
            this.initializeClient();
        });

        this.client.on('message_create', async (msg: any) => {
            if (msg.fromMe) {
                await this.handleOutgoingMessageFromPhone(msg);
            } else {
                await this.handleIncomingMessage(msg);
            }
        });

        this.client.initialize().catch((err: any) => {
            console.error('Error during WhatsApp Web client initialization:', err);
        });
    }

    private async processSendQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        while (this.sendQueue.length > 0) {
            const item = this.sendQueue.shift();
            if (!item) continue;

            try {
                if (!this.isClientReady) {
                    throw new Error('El cliente de WhatsApp no está conectado. Reintentando más tarde...');
                }

                console.log(`Queue: sending message to ${item.jid}...`);
                const sentMsg = await this.client.sendMessage(item.jid, item.cuerpo);
                let msgId = `local-${Date.now()}`;
                if (sentMsg && sentMsg.id && sentMsg.id.id) {
                    msgId = sentMsg.id.id;
                }
                item.resolve(msgId);
            } catch (err: any) {
                console.error(`Queue: error sending message to ${item.jid}:`, err);
                item.reject(err);
            }

            // Force 2000ms delay between sending messages
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        this.isProcessingQueue = false;
    }

    private enqueueMessage(jid: string, cuerpo: string): Promise<string> {
        return new Promise((resolve, reject) => {
            this.sendQueue.push({ jid, cuerpo, resolve, reject });
            this.processSendQueue();
        });
    }

    private async handleOutgoingMessageFromPhone(msg: any) {
        if (msg.to.endsWith('@g.us')) return;
        const jid = msg.to;
        const telefono = this.normalizePhone(jid.split('@')[0]);

        const { prospecto } = await this.getOrCreateProspecto(telefono, 'WHATSAPP', jid);
        const fecha = new Date(msg.timestamp * 1000);
        let text = msg.body || '';
        if (msg.hasMedia) {
            text = `[Adjunto o Multimedia]`;
        }

        // Avoid duplication if the message is already saved (e.g. sent from our CRM)
        const existing = await this.mensajeRepo.findOneBy({ id_mensaje: msg.id.id });
        if (existing) return;

        const message = this.mensajeRepo.create({
            id_mensaje: msg.id.id,
            prospecto,
            id_prospecto: prospecto.id,
            direccion: 'saliente',
            cuerpo_mensaje: text,
            fecha_envio: fecha,
            estado_lectura: 'Leido',
        });
        await this.mensajeRepo.save(message);

        // Update last message status
        prospecto.fecha_ultimo_mensaje_cliente = fecha;
        await this.prospectoRepo.save(prospecto);

        this.gateway.emit('whatsapp:message', {
            prospecto: await this.serializeConversation(prospecto),
            mensaje: this.serializeMessage(message),
        });
    }

    private async handleIncomingMessage(msg: any) {
        if (msg.from.endsWith('@g.us')) return;
        const jid = msg.from;
        const telefono = this.normalizePhone(jid.split('@')[0]);

        let displayName = 'WHATSAPP';
        try {
            const contact = await msg.getContact();
            displayName = contact.pushname || contact.name || 'WHATSAPP';
        } catch (e) {
            console.error('Error fetching contact info:', e);
        }

        const { prospecto, isNew } = await this.getOrCreateProspecto(telefono, displayName, jid);
        const fecha = new Date(msg.timestamp * 1000);
        let text = msg.body || '';

        if (msg.hasMedia) {
            text = `[Mensaje multimedia o adjunto]`;
        }

        const extractedName = this.extractNameFromText(text);
        if (extractedName && (prospecto.nombre === 'WHATSAPP' || prospecto.nombre.includes('USUARIO DE'))) {
            const parts = extractedName.split(/\s+/);
            prospecto.nombre = (parts.shift() || 'WHATSAPP').toUpperCase();
            prospecto.apellido = (parts.join(' ') || 'SIN APELLIDO').toUpperCase();
            await this.prospectoRepo.save(prospecto);
        }

        const dataUpdated = this.extractLeadData(text, prospecto);
        if (dataUpdated) {
            await this.prospectoRepo.save(prospecto);
        }

        const message = this.mensajeRepo.create({
            id_mensaje: msg.id.id,
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
            '👋 ¡Hola! Gracias por escribirnos y por tu interés en Escuela Maradona Menotti.\n\nPara enviarte la información correspondiente, por favor respondé este mensaje indicando:\n\n⚽ Propuesta de interés:\n* Carrera de Entrenador/a de Fútbol Profesional\n* Licencia B de Preparación Física Específica en Fútbol\n* Cursos y Especializaciones\n\n📌 Nombre y Apellido:\n📌 Email:\n📌 País de residencia:\n\nCon esos datos podremos compartirte toda la información de manera personalizada. 😊'
        );
    }

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
            silenciar_automatizaciones: prospecto.silenciar_automatizaciones,
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

    async getOrCreateProspectoForPlatform(senderId: string, platform: 'Facebook' | 'Instagram', whatsapp_id: string, recipientPageId: string, origenEspecifico?: string) {
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

                const nextOp = await this.getNextOperator();
                const prospecto = this.prospectoRepo.create({
                    nombre,
                    apellido,
                    whatsapp_id,
                    origen: origenEspecifico || platform,
                    estado: 'Nuevo',
                    fue_alumno: false,
                    asignado_a: nextOp || undefined,
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

                const nextOp = await this.getNextOperator();
                const prospecto = this.prospectoRepo.create({
                    nombre,
                    apellido,
                    telefono,
                    whatsapp_id: jid,
                    origen: 'WhatsApp',
                    estado: 'Nuevo',
                    fue_alumno: false,
                    asignado_a: nextOp || undefined,
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
            WHERE (p.origen IN ('WhatsApp', 'Facebook', 'Instagram') OR m.id_mensaje IS NOT NULL OR (p.telefono IS NOT NULL AND p.telefono != ''))
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

    private extractLeadData(text: string, prospecto: Prospecto): boolean {
        if (!text) return false;
        let updated = false;

        const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) {
            const extractedEmail = emailMatch[0].toLowerCase();
            if (prospecto.email !== extractedEmail) {
                prospecto.email = extractedEmail;
                updated = true;
            }
        }

        const cursosKeywords = [
            { key: 'Entrenador', match: /entrenador/i },
            { key: 'Preparador Físico', match: /preparador/i },
            { key: 'Selecciones Nacionales', match: /selecciones/i },
            { key: 'Facilitador', match: /facilitador/i },
            { key: 'Arqueros', match: /arquero/i },
            { key: 'Licencia C', match: /licencia c/i },
            { key: 'Licencia B', match: /licencia b/i },
            { key: 'Licencia A', match: /licencia a/i },
            { key: 'Licencia PRO', match: /licencia pro/i },
        ];

        for (const c of cursosKeywords) {
            if (c.match.test(text)) {
                if (prospecto.curso_interes !== c.key) {
                    prospecto.curso_interes = c.key;
                    updated = true;
                }
                break;
            }
        }

        // Si se extrajeron datos por regex pero el nombre sigue siendo WHATSAPP o usuario de meta
        // Podríamos intentar sacar el nombre de las líneas previas al email si sigue el formato Nombre Apellido
        if (updated && (prospecto.nombre === 'WHATSAPP' || prospecto.nombre.includes('USUARIO DE'))) {
            const lines = text.split('\n');
            const possibleName = lines.find(l => l.trim().length > 3 && l.trim().length < 30 && !l.includes('@'));
            if (possibleName) {
                const parts = possibleName.trim().split(/\s+/);
                if (parts.length >= 2) {
                    prospecto.nombre = parts.shift()!.toUpperCase();
                    prospecto.apellido = parts.join(' ').toUpperCase();
                } else {
                    prospecto.nombre = parts[0].toUpperCase();
                }
            }
        }

        return updated;
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

                if (triageResult.nombre_extraido && (!prospecto.nombre || prospecto.nombre.includes('SIN APELLIDO'))) {
                    const parts = triageResult.nombre_extraido.split(' ');
                    prospecto.nombre = parts[0];
                    prospecto.apellido = parts.slice(1).join(' ');
                }
                if (triageResult.email_extraido && !prospecto.email) {
                    prospecto.email = triageResult.email_extraido;
                }
                if (triageResult.telefono_extraido && (!prospecto.telefono || prospecto.whatsapp_id?.startsWith('facebook:') || prospecto.whatsapp_id?.startsWith('instagram:'))) {
                    prospecto.telefono = triageResult.telefono_extraido;
                }

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

        // Si es Facebook o Instagram, no enviamos respuestas automáticas por el momento (hasta que Meta valide la App)
        const channel = (prospecto.whatsapp_id && prospecto.whatsapp_id.startsWith('facebook:'))
            ? 'Facebook'
            : (prospecto.whatsapp_id && prospecto.whatsapp_id.startsWith('instagram:'))
            ? 'Instagram'
            : 'WhatsApp';

        if (channel === 'Facebook' || channel === 'Instagram') {
            return;
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

                        const dataUpdated = this.extractLeadData(text, prospecto);
                        if (dataUpdated) {
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
                            '👋 ¡Hola! Gracias por escribirnos y por tu interés en Escuela Maradona Menotti.\n\nPara enviarte la información correspondiente, por favor respondé este mensaje indicando:\n\n⚽ Propuesta de interés:\n* Carrera de Entrenador/a de Fútbol Profesional\n* Licencia B de Preparación Física Específica en Fútbol\n* Cursos y Especializaciones\n\n📌 Nombre y Apellido:\n📌 Email:\n📌 País de residencia:\n\nCon esos datos podremos compartirte toda la información de manera personalizada. 😊'
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

                    const incomingMessage = msgEvent.message || {};
                    const isStoryMention = incomingMessage.attachments && incomingMessage.attachments[0]?.type === 'story_mention';
                    const isReaction = msgEvent.reaction || isStoryMention;

                    if (isReaction) {
                        continue;
                    }

                    if (!incomingMessage.mid) continue;

                    const platform = objectType === 'page' ? 'Facebook' : 'Instagram';

                    // Check if it is an echo (sent by our page/colleague)
                    const isEcho = incomingMessage.is_echo || senderId === recipientPageId;
                    if (isEcho) {
                        const prospectSenderId = msgEvent.recipient?.id;
                        if (!prospectSenderId) continue;

                        const whatsapp_id = `${platform.toLowerCase()}:${prospectSenderId}:${recipientPageId}`;
                        const prospecto = await this.prospectoRepo.findOne({ where: { whatsapp_id } });
                        if (prospecto) {
                            let text = incomingMessage.text || '';
                            if (!text && incomingMessage.attachments && incomingMessage.attachments.length > 0) {
                                const type = incomingMessage.attachments[0].type;
                                const url = incomingMessage.attachments[0].payload?.url;
                                text = url ? `[Adjunto ${type}](${url})` : `[Adjunto ${type}]`;
                            } else if (!text) {
                                text = '[Mensaje multimedia o adjunto]';
                            }

                            const fecha = this.parseTimestamp(msgEvent.timestamp);
                            
                            // Check if the message is already saved (to avoid duplicates if sent from our CRM)
                            const existingMsg = await this.mensajeRepo.findOneBy({ id_mensaje: incomingMessage.mid });
                            if (!existingMsg) {
                                const message = this.mensajeRepo.create({
                                    id_mensaje: incomingMessage.mid,
                                    prospecto,
                                    id_prospecto: prospecto.id,
                                    direccion: 'saliente',
                                    cuerpo_mensaje: text,
                                    fecha_envio: fecha,
                                    estado_lectura: 'Leido',
                                });
                                await this.mensajeRepo.save(message);

                                // Mark conversation as read since an operator responded from Meta
                                prospecto.whatsapp_ultimo_leido_at = fecha;
                                
                                // Auto change state to Primer Contacto if it was Nuevo
                                const estadoNuevo = await this.estadoEmbudoRepo.findOneBy({ nombre: 'Nuevo' });
                                const estadoPrimerContacto = await this.estadoEmbudoRepo.findOneBy({ nombre: 'Primer Contacto' });
                                if (estadoNuevo && estadoPrimerContacto && (prospecto.id_estado === estadoNuevo.id || prospecto.estado === 'Nuevo')) {
                                    prospecto.id_estado = estadoPrimerContacto.id;
                                    prospecto.estado = estadoPrimerContacto.nombre;
                                }

                                prospecto.fecha_ultimo_mensaje_sistema = fecha;
                                await this.prospectoRepo.save(prospecto);

                                const payload = {
                                    prospecto: await this.serializeConversation(prospecto),
                                    mensaje: this.serializeMessage(message),
                                };
                                this.gateway.emit('whatsapp:message', payload);
                            }
                        }
                        continue;
                    }

                    let text = incomingMessage.text || '';
                    if (!text && incomingMessage.attachments && incomingMessage.attachments.length > 0) {
                        const type = incomingMessage.attachments[0].type;
                        const url = incomingMessage.attachments[0].payload?.url;
                        if (url) {
                            text = `[Adjunto ${type}](${url})`;
                        } else {
                            text = `[Adjunto ${type}]`;
                        }
                    } else if (!text) {
                        text = '[Mensaje multimedia o adjunto]';
                    }
                    const fecha = this.parseTimestamp(msgEvent.timestamp);
                    const whatsapp_id = `${platform.toLowerCase()}:${senderId}:${recipientPageId}`;
                    const isStoryReply = incomingMessage.referral?.source_type === 'STORY' || msgEvent.referral?.source_type === 'STORY';
                    
                    let origenEspecifico = platform;
                    if (platform === 'Instagram') {
                        origenEspecifico = isStoryReply ? 'Instagram - Historia' : 'Instagram - Mensaje';
                    }

                    const { prospecto, isNew } = await this.getOrCreateProspectoForPlatform(senderId, platform, whatsapp_id, recipientPageId, origenEspecifico);

                    const extractedName = this.extractNameFromText(text);
                    if (extractedName && (prospecto.nombre.includes('USUARIO DE') || prospecto.apellido === 'INSTAGRAM' || prospecto.apellido === 'USER' || prospecto.apellido === senderId)) {
                        const parts = extractedName.split(/\s+/);
                        prospecto.nombre = (parts.shift() || prospecto.nombre).toUpperCase();
                        prospecto.apellido = (parts.join(' ') || 'SIN APELLIDO').toUpperCase();
                        await this.prospectoRepo.save(prospecto);
                    }

                    const dataUpdated = this.extractLeadData(text, prospecto);
                    if (dataUpdated) {
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

                    if (isStoryReply && text && text !== '[Mensaje multimedia o adjunto]') {
                        await this.processTriageAndAutoReply(
                            prospecto,
                            text,
                            false,
                            '👋 ¡Hola! Gracias por escribirnos y por tu interés en Escuela Maradona Menotti.\n\nPara enviarte la información correspondiente, por favor respondé este mensaje indicando:\n\n⚽ Propuesta de interés:\n* Carrera de Entrenador/a de Fútbol Profesional\n* Licencia B de Preparación Física Específica en Fútbol\n* Cursos y Especializaciones\n\n📌 Nombre y Apellido:\n📌 Email:\n📌 País de residencia:\n\nCon esos datos podremos compartirte toda la información de manera personalizada. 😊'
                        );
                    } else {
                        await this.processTriageAndAutoReply(
                            prospecto,
                            text,
                            isNew,
                            '👋 ¡Hola! Gracias por escribirnos y por tu interés en Escuela Maradona Menotti.\n\nPara enviarte la información correspondiente, por favor respondé este mensaje indicando:\n\n⚽ Propuesta de interés:\n* Carrera de Entrenador/a de Fútbol Profesional\n* Licencia B de Preparación Física Específica en Fútbol\n* Cursos y Especializaciones\n\n📌 Nombre y Apellido:\n📌 Email:\n📌 País de residencia:\n\nCon esos datos podremos compartirte toda la información de manera personalizada. 😊'
                        );
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
                    
                    const origenEspecifico = platform === 'Instagram' ? 'Instagram - Comentario' : platform;

                    const { prospecto, isNew } = await this.getOrCreateProspectoForPlatform(senderId, platform, whatsapp_id, recipientPageId, origenEspecifico);
                    
                    const commentText = `[Comentario] ${text}`;

                    if (senderName && (prospecto.nombre.includes('USUARIO DE') || prospecto.apellido === 'INSTAGRAM' || prospecto.apellido === 'USER' || prospecto.apellido === senderId)) {
                        const parts = senderName.split(/\s+/);
                        prospecto.nombre = (parts.shift() || prospecto.nombre).toUpperCase();
                        prospecto.apellido = (parts.join(' ') || 'SIN APELLIDO').toUpperCase();
                        await this.prospectoRepo.save(prospecto);
                    }

                    const dataUpdated = this.extractLeadData(commentText, prospecto);
                    if (dataUpdated) {
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
                        '👋 ¡Hola! Gracias por escribirnos y por tu interés en Escuela Maradona Menotti.\n\nPara enviarte la información correspondiente, por favor respondé este mensaje indicando:\n\n⚽ Propuesta de interés:\n* Carrera de Entrenador/a de Fútbol Profesional\n* Licencia B de Preparación Física Específica en Fútbol\n* Cursos y Especializaciones\n\n📌 Nombre y Apellido:\n📌 Email:\n📌 País de residencia:\n\nCon esos datos podremos compartirte toda la información de manera personalizada. 😊'
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
        try {
            console.log('Logging out from WhatsApp Web client...');
            this.isClientReady = false;
            this.lastQr = null;
            await this.client.logout();
            await this.client.destroy();
        } catch (e) {
            console.error('Error during client logout:', e);
        }

        // Clean up the auth folder
        const authPath = path.resolve('./wwebjs_auth');
        if (fs.existsSync(authPath)) {
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
            } catch (err) {
                console.error('Error deleting auth folder:', err);
            }
        }

        // Re-initialize client to generate a new QR
        this.initializeClient();

        return { success: true, message: 'Sesión de WhatsApp cerrada y archivos de autenticación eliminados.' };
    }

    async sendBroadcastToStudents(studentIds: string[], plantillaId: string) {
        if (!this.isClientReady) {
            throw new BadRequestException('El cliente de WhatsApp no está conectado. Escanea el código QR primero.');
        }

        const plantilla = await this.plantillaRepo.findOneBy({ id: plantillaId });
        if (!plantilla) throw new NotFoundException('Plantilla no encontrada');

        const students = await this.studentRepo.findByIds(studentIds);
        let sent = 0;
        let failed = 0;

        for (const student of students) {
            if (!student.telefono) {
                failed++;
                continue;
            }

            const cleanPhone = student.telefono.replace(/\D/g, '');
            if (cleanPhone.length < 8) {
                failed++;
                continue;
            }

            // Replace variables in plantilla
            let finalBody = plantilla.texto;
            const fullName = [student.nombre, student.apellido].filter(Boolean).join(' ').trim();
            finalBody = finalBody.replace(/\{\{\s*nombre\s*\}\}/gi, fullName || student.nombre || '');
            finalBody = finalBody.replace(/\[Nombre\]/gi, fullName || student.nombre || '');
            finalBody = finalBody.replace(/\{\{\s*curso\s*\}\}/gi, student.carrera_licencia || 'el curso');
            finalBody = finalBody.replace(/\[Curso\]/gi, student.carrera_licencia || 'el curso');

            try {
                const jid = `${cleanPhone}@c.us`;
                await this.enqueueMessage(jid, finalBody);
                sent++;
            } catch (e) {
                console.error(`Failed to send broadcast to ${student.telefono}:`, e);
                failed++;
            }
        }

        return { success: true, sent, failed };
    }

    getStatus() {
        return { isReady: this.isClientReady, type: 'qr', qr: this.lastQr };
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

                const lastInbound = await this.mensajeRepo.findOne({
                    where: { id_prospecto: prospecto.id, direccion: 'entrante' },
                    order: { fecha_envio: 'DESC' }
                });

                let payload: any;
                let isCommentReply = false;

                if (lastInbound && lastInbound.cuerpo_mensaje.startsWith('[Comentario]')) {
                    payload = {
                        recipient: { comment_id: lastInbound.id_mensaje },
                        message: { text: cuerpo }
                    };
                    isCommentReply = true;
                } else {
                    payload = {
                        recipient: { id: senderId },
                        message: { text: cuerpo }
                    };
                    if (channel === 'Facebook') {
                        payload.messaging_type = 'RESPONSE';
                    }
                }

                let response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(payload)
                });

                let result = await response.json();

                // Si ya respondimos a este comentario, intentamos mandar un DM normal
                if (!response.ok && isCommentReply && result.error?.error_subcode === 2534023) {
                    console.log('Comentario ya respondido. Intentando fallback a DM normal...');
                    payload = {
                        recipient: { id: senderId },
                        message: { text: cuerpo }
                    };
                    if (channel === 'Facebook') {
                        payload.messaging_type = 'RESPONSE';
                    }
                    response = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(payload)
                    });
                    result = await response.json();
                }

                if (!response.ok) {
                    console.error('Meta API Error:', result);
                    if (result.error?.error_subcode === 2534023) {
                        throw new Error('Meta solo permite 1 respuesta privada por comentario. Esperá a que el usuario te conteste.');
                    }
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
        if (!this.isClientReady) {
            throw new BadRequestException('El cliente de WhatsApp no está conectado. Escanea el código QR primero.');
        }

        const jid = prospecto.whatsapp_id || `${prospecto.telefono}@c.us`;
        let msgId = `local-${Date.now()}`;

        try {
            msgId = await this.enqueueMessage(jid, cuerpo);
        } catch (err: any) {
            throw new BadRequestException({ error: 'Error al enviar por WhatsApp Web', details: err.message || err });
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
