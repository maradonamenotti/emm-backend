import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, OneToMany, ManyToOne, JoinColumn, Index } from 'typeorm';
import { HistorialSeguimiento } from './HistorialSeguimiento';
import { EstadoEmbudo } from './EstadoEmbudo';

@Entity('prospecto')
@Index('idx_prospecto_origen_telefono', ['origen', 'telefono'])
export class Prospecto {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column()
    nombre!: string;

    @Column()
    apellido!: string;

    @Column({ nullable: true })
    telefono?: string;

    @Column({ nullable: true })
    whatsapp_id?: string;

    @Column({ nullable: true })
    email?: string;

    @Column({ nullable: true })
    pais?: string;

    @Column({ nullable: true })
    curso_interes?: string;

    @Column({ default: 'WhatsApp' })
    origen!: string;

    @Column({ nullable: true })
    id_estado?: string;

    @ManyToOne(() => EstadoEmbudo, e => e.prospectos, { eager: true, nullable: true })
    @JoinColumn({ name: 'id_estado' })
    estado_entidad?: EstadoEmbudo;

    @Column({ default: 'Nuevo' })
    estado!: string; // Keep for backward compatibility or migration

    @Column({ nullable: true, type: 'timestamptz' })
    fecha_ultimo_mensaje_cliente?: Date;

    @Column({ nullable: true, type: 'timestamptz' })
    fecha_ultimo_mensaje_sistema?: Date;

    @Column({ nullable: true, type: 'timestamptz' })
    whatsapp_ultimo_leido_at?: Date;

    @Column('text', { array: true, default: () => "'{}'" })
    etiquetas!: string[];

    @Column({ nullable: true })
    asignado_a?: string;

    @Column({ default: false })
    fue_alumno!: boolean;

    @CreateDateColumn({ type: 'timestamptz' })
    fecha_ingreso!: Date;

    @Column({ nullable: true, type: 'text' })
    notas_generales?: string;

    @OneToMany(() => HistorialSeguimiento, h => h.prospecto, { cascade: true, eager: false })
    historial!: HistorialSeguimiento[];
}
