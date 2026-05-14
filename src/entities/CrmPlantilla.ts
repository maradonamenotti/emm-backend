import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('crm_plantilla')
export class CrmPlantilla {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column()
    titulo!: string;

    @Column({ default: 'General' })
    categoria!: string;

    @Column({ type: 'varchar', nullable: true })
    curso?: string | null;

    @Column({ type: 'varchar', nullable: true })
    estado_sugerido?: string | null;

    @Column({ type: 'text' })
    texto!: string;

    @Column({ default: 0 })
    orden!: number;

    @Column({ default: true })
    activa!: boolean;

    @CreateDateColumn({ type: 'timestamptz' })
    creada_at!: Date;
}
