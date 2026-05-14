import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Prospecto } from './Prospecto';

export type WhatsAppDireccion = 'entrante' | 'saliente';
export type WhatsAppEstadoLectura = 'Enviado' | 'Entregado' | 'Leido';

@Entity('mensajes_whatsapp')
@Index('idx_mensajes_whatsapp_prospecto_fecha', ['id_prospecto', 'fecha_envio'])
export class MensajeWhatsApp {
    @PrimaryColumn()
    id_mensaje!: string;

    @ManyToOne(() => Prospecto, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'id_prospecto' })
    prospecto!: Prospecto;

    @Column({ name: 'id_prospecto' })
    @Index()
    id_prospecto!: string;

    @Column()
    direccion!: WhatsAppDireccion;

    @Column({ type: 'text' })
    cuerpo_mensaje!: string;

    @Column({ type: 'timestamptz' })
    fecha_envio!: Date;

    @Column({ default: 'Enviado' })
    estado_lectura!: WhatsAppEstadoLectura;
}
