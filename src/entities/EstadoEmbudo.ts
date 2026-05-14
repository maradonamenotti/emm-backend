import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { Prospecto } from './Prospecto';

@Entity('estados_embudo')
export class EstadoEmbudo {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column()
    nombre!: string;

    @Column({ default: 0 })
    orden!: number;

    @Column({ default: '#6B7280' })
    color!: string;

    @Column({ nullable: true })
    icono?: string;

    @Column({ default: false })
    es_sistema!: boolean;

    @Column({ default: false })
    es_ganado!: boolean;

    @Column({ default: false })
    es_perdido!: boolean;

    @Column({ nullable: true, type: 'text' })
    descripcion?: string;

    @Column({ nullable: true, type: 'text' })
    accion_sugerida?: string;

    @Column({ nullable: true })
    recordatorio_horas?: number;

    @Column({ nullable: true })
    id_plantilla_recordatorio?: string;

    @Column({ nullable: true })
    inactividad_dias_descarte?: number;

    @OneToMany(() => Prospecto, p => p.estado_entidad)
    prospectos!: Prospecto[];
}
