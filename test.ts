import { DataSource } from 'typeorm';
import { Student } from './src/entities/Student';
import { Nota } from './src/entities/Nota';
const ds = new DataSource({ type: 'sqlite', database: 'database.sqlite', entities: [Student, Nota] });
ds.initialize().then(async () => {
    const s = await ds.getRepository(Student).find({ take: 5 });
    console.log(JSON.stringify(s, null, 2));
    process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
