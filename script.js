const { Client } = require('pg'); 
const client = new Client({ connectionString: 'postgresql://postgres:Riverplate912@localhost:5432/analiticos' }); 
client.connect().then(async () => { 
  const res = await client.query("UPDATE student SET en_analiticos = true WHERE id IN (SELECT student_id FROM nota) OR estado_analitico = 'emitido' OR situacion = 'CREADO MANUAL'"); 
  console.log('Updated', res.rowCount, 'students'); 
  client.end(); 
}).catch(console.error);
