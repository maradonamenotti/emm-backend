import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from "typeorm";
import { Nota } from "./Nota";

@Entity()
export class Student {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column()
    documento!: string;

    @Column({ nullable: true })
    password?: string;

    @Column()
    nombre!: string;

    @Column()
    apellido!: string;

    @Column({ nullable: true })
    email?: string;

    @Column({ nullable: true })
    telefono?: string;

    @Column({ nullable: true })
    nacionalidad?: string;

    @Column({ nullable: true })
    pais_residencia?: string;

    @Column({ nullable: true })
    provincia?: string;

    @Column({ nullable: true })
    carrera_licencia?: string;

    @Column({ nullable: true })
    comision?: string;

    @Column({ nullable: true })
    situacion?: string;

    @Column({ type: "int", nullable: true })
    ciclo_lectivo?: number;

    @Column({ default: 'student' })
    role!: string;

    @Column({ default: 'borrador' })
    estado_analitico!: string;

    @Column({ default: false })
    diploma_emitido!: boolean;

    @Column({ nullable: true })
    fecha_emision?: string;

    @Column({ nullable: true })
    fecha_fin_cursada?: string;

    @Column({ default: false })
    pagos_ok!: boolean;

    @Column({ default: false })
    documentacion_ok!: boolean;

    @Column('simple-json', { nullable: true, default: [] })
    historial?: any[];

    @OneToMany(() => Nota, nota => nota.student, { cascade: true })
    notas!: Nota[];
}
