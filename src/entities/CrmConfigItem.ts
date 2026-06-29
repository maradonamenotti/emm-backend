import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('crm_config_item')
export class CrmConfigItem {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column()
    tipo!: string; // 'estado' | 'origen' | 'curso' | 'operadora'

    @Column()
    valor!: string;

    @Column({ default: 0 })
    orden!: number;

    @Column({ default: '#6B7280' })
    color!: string;

    @Column({ default: false })
    es_ganado!: boolean;

    @Column({ default: false })
    es_perdido!: boolean;

    @Column({ type: 'float', nullable: true, default: 0 })
    valor_estimado?: number;
}
