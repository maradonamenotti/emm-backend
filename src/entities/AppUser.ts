import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity()
export class AppUser {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ unique: true })
    email!: string;

    @Column()
    nombre!: string;

    @Column()
    password!: string;

    // 'superadmin' | 'editor' | 'viewer'
    @Column({ default: 'editor' })
    role!: string;

    @Column('simple-json', { nullable: true, default: {} })
    permissions!: Record<string, string>;
}
