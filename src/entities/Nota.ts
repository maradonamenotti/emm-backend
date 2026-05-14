import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from "typeorm";
import { Student } from "./Student";

@Entity()
export class Nota {
    @PrimaryGeneratedColumn()
    id!: number;

    @ManyToOne(() => Student, student => student.notas, { onDelete: "CASCADE" })
    @JoinColumn({ name: "student_id" })
    student!: Student;

    @Column()
    asignatura!: string;

    @Column({ nullable: true })
    l_tipo_id?: string;

    @Column({ nullable: true })
    l_nro?: string;

    @Column({ nullable: true })
    folio_nro?: string;

    @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
    nota?: number;

    @Column({ type: "date", nullable: true })
    fecha?: Date;

    @Column({ nullable: true })
    acta?: string;
}
