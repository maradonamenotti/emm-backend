import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Prospecto } from './Prospecto';

@Entity('historial_seguimiento')
export class HistorialSeguimiento {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @ManyToOne(() => Prospecto, p => p.historial, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'prospecto_id' })
    prospecto!: Prospecto;

    @Column({ name: 'prospecto_id' })
    prospecto_id!: string;

    @CreateDateColumn({ type: 'timestamptz' })
    fecha_contacto!: Date;

    @Column({ default: 'WhatsApp' })
    tipo_contacto!: string;

    @Column({ nullable: true, type: 'text' })
    nota?: string;

    @Column({ nullable: true, type: 'date' })
    fecha_proximo_aviso?: string;
}
