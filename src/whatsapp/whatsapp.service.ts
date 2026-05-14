import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Prospecto } from '../entities/Prospecto';
import { MensajeWhatsApp, WhatsAppEstadoLectura } from '../entities/MensajeWhatsApp';
import { EstadoEmbudo } from '../entities/EstadoEmbudo';
import { WhatsAppGateway } from './whatsapp.gateway';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

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
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
    private client: any;
    private isReady = false;
    private isInitializing = false;
    private reconnectAttempts = 0;
    private reconnectTimer?: ReturnType<typeof setTimeout>;

    constructor(
        @InjectRepository(Prospecto, 'crm')
        private readonly prospectoRepo: Repository<Prospecto>,
        @InjectRepository(MensajeWhatsApp, 'crm')
        private readonly mensajeRepo: Repository<MensajeWhatsApp>,
        @InjectRepository(EstadoEmbudo, 'crm')
        private readonly estadoEmbudoRepo: Repository<EstadoEmbudo>,
        private readonly gateway: WhatsAppGateway,
    ) {}

    onModuleInit() {
        void this.initializeClient();
    }

    async onModuleDestroy() {
        this.clearReconnectTimer();
        await this.destroyClient();
    }

    private createClient(): any {
        return new Client({
            authStrategy: new LocalAuth({
                dataPath: './sessions'
            }),
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
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            }
        });
    }

    private clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }

    private async destroyClient() {
        const client = this.client;
        this.client = undefined;
        if (!client) return;

        client.removeAllListeners();
        try {
            await client.destroy();
        } catch (err) {
            console.error('Error destroying WhatsApp client:', err);
        }
    }

    private scheduleReconnect(reason?: unknown) {
        if (this.reconnectTimer) return;

        this.isReady = false;
        const delayMs = Math.min(30000, 2000 * (this.reconnectAttempts + 1));
        this.reconnectAttempts += 1;
        console.log(`Scheduling WhatsApp reconnect in ${delayMs}ms`, reason || '');

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (this.isInitializing) {
                this.scheduleReconnect(reason);
                return;
            }
            void this.initializeClient();
        }, delayMs);
    }

    private registerClientHandlers(client: any) {
        client.on('qr', (qr: string) => {
            console.log('QR RECEIVED');
            this.gateway.emit('whatsapp:qr', qr);
        });

        client.on('ready', () => {
            console.log('WhatsApp Web Client is ready!');
            this.isReady = true;
            this.reconnectAttempts = 0;
            this.gateway.emit('whatsapp:status', { status: 'ready' });
        });

        client.on('message', async (msg: any) => {
            if (msg.from === 'status@broadcast') return;
            
            // --- MENSAJE ENTRANTE CRUDO ---
            console.log('--- MENSAJE ENTRANTE CRUDO ---');
            console.log('From:', msg.from);
            console.log('Author:', msg.author);
            console.log('_data:', JSON.stringify(msg._data, null, 2));
            console.log('------------------------------');

            // --- DEBUG LOGS PARA EL EXPERTO ---
            console.log('--- NUEVO MENSAJE RECIBIDO ---');
            console.log('FROM (msg.from):', msg.from);
            console.log('AUTHOR (msg.author):', msg.author); // Importante en grupos/empresa
            console.log('BODY:', msg.body);
            
            const contact = await msg.getContact();
            console.log('CONTACT INFO:', {
                number: contact.number,
                pushname: contact.pushname,
                name: contact.name,
                id: contact.id?._serialized
            });
            // ----------------------------------

            const jid = msg.from; // ej: 54911... @c.us o 263088... @lid
            const contactId = contact.id?.user || jid.split('@')[0];
            const realNumber = contact.number || contactId;
            
            console.log(`Buscando prospecto para: JID=${jid}, Number=${realNumber}`);

            // Buscamos si ya existe por JID o por número
            let prospecto = await this.prospectoRepo.findOne({ 
                where: [
                    { whatsapp_id: jid },
                    { telefono: realNumber }
                ] 
            });
            
            if (!prospecto) {
                console.log('Prospecto no encontrado, creando uno nuevo...');
                prospecto = await this.getOrCreateProspecto(realNumber, contact.pushname || contact.name, jid);
            } else {
                let changed = false;
                if (!prospecto.whatsapp_id) {
                    prospecto.whatsapp_id = jid;
                    changed = true;
                }
                // Si el teléfono guardado es muy largo (probablemente un LID) y tenemos uno más corto/limpio, lo actualizamos
                if (realNumber && (prospecto.telefono !== realNumber || (prospecto.telefono?.length || 0) > 15)) {
                    console.log(`Actualizando teléfono de ${prospecto.telefono} a ${realNumber}`);
                    prospecto.telefono = realNumber;
                    changed = true;
                }
                if (changed) {
                    await this.prospectoRepo.save(prospecto);
                    console.log('Prospecto actualizado y guardado.');
                }
            }
            
            const message = this.mensajeRepo.create({
                id_mensaje: msg.id.id,
                prospecto,
                id_prospecto: prospecto.id,
                direccion: 'entrante',
                cuerpo_mensaje: msg.body || '[Mensaje no textual]',
                fecha_envio: new Date(),
                estado_lectura: 'Entregado',
            });

            await this.mensajeRepo.upsert(message, ['id_mensaje']);
            
            // Actualizar fecha de último mensaje del cliente
            prospecto.fecha_ultimo_mensaje_cliente = new Date();
            await this.prospectoRepo.save(prospecto);
            
            // --- AUTO-PARSING DE FORMULARIO WEB ---
            if (msg.body && msg.body.includes('Nombre:') && msg.body.includes('Email:')) {
                await this.parsePrefilledMessage(prospecto, msg.body);
            }
            
            const payload = {
                prospecto: await this.serializeConversation(prospecto),
                mensaje: this.serializeMessage(message),
            };
            this.gateway.emit('whatsapp:message', payload);
        });

        client.on('message_ack', async (msg: any, ack: number) => {
            // ack: 1 = Enviado, 2 = Entregado, 3 = Leido, 4 = Reproducido (audio)
            const estadoMap: Record<number, WhatsAppEstadoLectura> = {
                1: 'Enviado',
                2: 'Entregado',
                3: 'Leido',
                4: 'Leido',
            };
            
            const nuevoEstado = estadoMap[ack];
            if (nuevoEstado) {
                await this.mensajeRepo.update({ id_mensaje: msg.id.id }, { estado_lectura: nuevoEstado });
                
                // Avisamos al frontend para que cambie los tildes en tiempo real
                this.gateway.emit('whatsapp:status', { 
                    id_mensaje: msg.id.id, 
                    estado_lectura: nuevoEstado 
                });
            }
        });

        client.on('auth_failure', (message: string) => {
            if (this.client !== client) return;

            console.error('WhatsApp authentication failed:', message);
            this.isReady = false;
            this.gateway.emit('whatsapp:status', { status: 'auth_failure', message });
            this.scheduleReconnect(message);
        });

        client.on('disconnected', (reason: string) => {
            if (this.client !== client) return;

            console.log('WhatsApp Web Client was logged out', reason);
            this.isReady = false;
            this.gateway.emit('whatsapp:status', { status: 'disconnected', reason });
            this.scheduleReconnect(reason);
        });
    }

    private async initializeClient() {
        if (this.isInitializing) return;

        this.isInitializing = true;
        this.clearReconnectTimer();
        try {
            await this.destroyClient();
            const client = this.createClient();
            this.client = client;
            this.registerClientHandlers(client);
            await client.initialize();
        } catch (err: any) {
            console.error('Error initializing WhatsApp client:', err);
            this.scheduleReconnect(err?.message || err);
        } finally {
            this.isInitializing = false;
        }
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

    private shouldResolveContact(value: unknown) {
        return value === true || value === 'true' || value === '1';
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

    private async parsePrefilledMessage(prospecto: Prospecto, body: string) {
        console.log('Detectado mensaje de formulario web. Analizando datos...');
        try {
            const extract = (key: string) => {
                const regex = new RegExp(`${key}:?\\s*([^|\\n]+)`, 'i');
                const match = body.match(regex);
                return match ? match[1].trim() : null;
            };

            const nombre = extract('Nombre');
            const apellido = extract('Apellido');
            const email = extract('Email');
            const curso = extract('Curso');

            let changed = false;
            if (nombre) { prospecto.nombre = nombre.toUpperCase(); changed = true; }
            if (apellido) { prospecto.apellido = apellido.toUpperCase(); changed = true; }
            if (email) { prospecto.email = email.toLowerCase(); changed = true; }
            if (curso) { prospecto.curso_interes = curso; changed = true; }

            if (changed) {
                await this.prospectoRepo.save(prospecto);
                console.log(`Datos de formulario auto-completados para: ${prospecto.nombre} ${prospecto.apellido}`);
            }
        } catch (err) {
            console.error('Error al parsear mensaje predefinido:', err);
        }
    }

    async getOrCreateProspecto(telefono: string, displayName?: string, jid?: string) {
        // Buscamos primero por whatsapp_id si lo tenemos, luego por telefono
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
                p.id,
                p.nombre,
                p.apellido,
                p.telefono,
                p.whatsapp_id,
                p.email,
                p.pais,
                p.curso_interes,
                p.origen,
                p.estado,
                p.asignado_a,
                p.etiquetas,
                p.whatsapp_ultimo_leido_at,
                p.fue_alumno,
                p.fecha_ingreso,
                p.notas_generales,
                row_to_json(m.*) AS ultimo_mensaje,
                COALESCE(u.no_leidos, 0)::int AS no_leidos
            FROM prospecto p
            LEFT JOIN (
                SELECT DISTINCT ON (id_prospecto)
                    id_mensaje,
                    id_prospecto,
                    direccion,
                    cuerpo_mensaje,
                    fecha_envio,
                    estado_lectura
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
            WHERE p.telefono IS NOT NULL
              AND p.origen = $1
            ORDER BY (COALESCE(u.no_leidos, 0) > 0) DESC, COALESCE(m.fecha_envio, p.fecha_ingreso) DESC NULLS LAST, p.fecha_ingreso DESC
            LIMIT $2 OFFSET $3
        `, ['WhatsApp', limit + 1, offset]);

        const pageRows = rows.slice(0, limit);
        const items = await Promise.all(pageRows.map((row: any) => {
            const prospecto = this.prospectoRepo.create({
                id: row.id,
                nombre: row.nombre,
                apellido: row.apellido,
                telefono: row.telefono,
                whatsapp_id: row.whatsapp_id,
                email: row.email,
                pais: row.pais,
                curso_interes: row.curso_interes,
                origen: row.origen,
                estado: row.estado,
                asignado_a: row.asignado_a,
                etiquetas: this.normalizeTags(row.etiquetas),
                whatsapp_ultimo_leido_at: row.whatsapp_ultimo_leido_at,
                fue_alumno: row.fue_alumno,
                fecha_ingreso: row.fecha_ingreso,
                notas_generales: row.notas_generales,
            });

            const lastMessage: MensajeWhatsApp | null = row.ultimo_mensaje
                ? this.mensajeRepo.create({
                    id_mensaje: row.ultimo_mensaje.id_mensaje,
                    id_prospecto: row.ultimo_mensaje.id_prospecto,
                    direccion: row.ultimo_mensaje.direccion,
                    cuerpo_mensaje: row.ultimo_mensaje.cuerpo_mensaje,
                    fecha_envio: new Date(row.ultimo_mensaje.fecha_envio),
                    estado_lectura: row.ultimo_mensaje.estado_lectura,
                })
                : null;

            return this.serializeConversation(prospecto, lastMessage, Number(row.no_leidos || 0));
        }));

        return {
            items,
            hasMore: rows.length > limit,
            limit,
            offset,
        };
    }

    async messages(prospectoId: string, options: MessageQueryOptions = {}) {
        if (!prospectoId) throw new BadRequestException('prospecto_id es requerido');

        const prospecto = await this.prospectoRepo.findOneBy({ id: prospectoId });
        if (!prospecto) throw new NotFoundException('Prospecto no encontrado');

        let changed = false;
        const shouldResolveContact = this.shouldResolveContact(options.resolveContact);

        // Sincronización proactiva del número si es un ID largo
        if (shouldResolveContact && this.isReady && prospecto.telefono && prospecto.telefono.length >= 12) {
            console.log(`Attempting to resolve real number for ${prospecto.telefono}...`);
            try {
                const contact = await this.client.getContactById(`${prospecto.telefono}@c.us`);
                console.log(`Contact info resolved: number=${contact?.number}, name=${contact?.name}, id=${contact?.id?._serialized}`);
                if (contact && contact.number && contact.number !== prospecto.telefono) {
                    prospecto.telefono = contact.number;
                    changed = true;
                }
            } catch (err) {
                console.error(`FAILED to resolve real number for ${prospecto.telefono}:`, err);
            }
        }
        
        // Si hemos detectado un cambio, guardamos para persistir el número real
        if (changed) {
            await this.prospectoRepo.save(prospecto);
            console.log(`Número resuelto con éxito para ${prospecto.nombre}: ${prospecto.telefono}`);
        }

        const limit = this.parseLimit(options.limit, 60, 200);
        const before = this.parseDate(options.before);
        const where: any = { id_prospecto: prospectoId };
        if (before) where.fecha_envio = LessThan(before);

        const mensajes = await this.mensajeRepo.find({
            where,
            order: { fecha_envio: 'DESC' },
            take: limit + 1,
        });
        const page = mensajes.slice(0, limit).reverse();

        return {
            prospecto: await this.serializeConversation(prospecto, before ? undefined : (mensajes[0] || null)),
            mensajes: page.map(m => this.serializeMessage(m)),
            hasMore: mensajes.length > limit,
            limit,
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
                    const text = incoming.text?.body || incoming.button?.text || incoming.interactive?.button_reply?.title || '[Mensaje no textual]';

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
        this.isReady = false;
        this.clearReconnectTimer();
        try {
            await this.destroyClient();
            // Eliminamos la carpeta de sesiones para un reset completo
            const fs = require('fs');
            const path = require('path');
            const sessionsPath = path.join(process.cwd(), 'sessions');
            if (fs.existsSync(sessionsPath)) {
                fs.rmSync(sessionsPath, { recursive: true, force: true });
            }
            console.log('WhatsApp session cleared.');
        } catch (err) {
            console.error('Error during logout:', err);
        }
        // Reiniciamos el cliente
        this.reconnectAttempts = 0;
        void this.initializeClient();
    }

    getStatus() {
        return { isReady: this.isReady };
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
            : telefono
                ? await this.getOrCreateProspecto(telefono)
                : null;
        if (!prospecto) throw new NotFoundException('Prospecto no encontrado');
        if (!prospecto.telefono) throw new BadRequestException('El prospecto no tiene telefono');

        if (!this.isReady) {
            throw new BadRequestException('El cliente de WhatsApp no está conectado (escanee el QR)');
        }

        const waId = prospecto.whatsapp_id || (prospecto.telefono?.includes('@') ? prospecto.telefono : `${prospecto.telefono}@c.us`);
        
        if (!waId) {
            throw new BadRequestException(`El prospecto no tiene un identificador de WhatsApp válido.`);
        }

        let msgId = `local-${Date.now()}`;
        
        try {
            const chat = await this.client.getChatById(waId);
            const sentMsg = await chat.sendMessage(cuerpo);
            msgId = sentMsg.id.id;
        } catch (err: any) {
            console.error('Initial send failed:', err.message);
            // Fallback para errores de LID: intentar con sufijo @lid
            if (err.message?.includes('LID') && !waId.endsWith('@lid')) {
                const lid = waId.split('@')[0] + '@lid';
                console.log(`Retrying with LID format: ${lid}`);
                try {
                    const chat = await this.client.getChatById(lid);
                    const sentMsg = await chat.sendMessage(cuerpo);
                    msgId = sentMsg.id.id;
                } catch (err2: any) {
                    throw new BadRequestException({ error: 'Error de LID persistente', details: err2.message });
                }
            } else {
                throw new BadRequestException({ error: 'Error al enviar por WhatsApp Web', details: err.message || err });
            }
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

        // --- AUTOMACIÓN: Cambio a "Primer Contacto" ---
        const estadoNuevo = await this.estadoEmbudoRepo.findOneBy({ nombre: 'Nuevo' });
        const estadoPrimerContacto = await this.estadoEmbudoRepo.findOneBy({ nombre: 'Primer Contacto' });

        if (estadoNuevo && estadoPrimerContacto && (prospecto.id_estado === estadoNuevo.id || prospecto.estado === 'Nuevo')) {
            console.log(`Cambiando prospecto ${prospecto.nombre} de Nuevo a Primer Contacto`);
            prospecto.id_estado = estadoPrimerContacto.id;
            prospecto.estado = estadoPrimerContacto.nombre; // Sync string for safety
        }

        // Actualizar fecha de último mensaje del sistema
        prospecto.fecha_ultimo_mensaje_sistema = new Date();
        await this.prospectoRepo.save(prospecto);

        const payload = {
            prospecto: await this.serializeConversation(prospecto),
            mensaje: this.serializeMessage(message),
        };
        this.gateway.emit('whatsapp:message', payload);
        return payload;
    }
}
