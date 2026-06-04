const { Client } = require('pg'); 
const client = new Client({ connectionString: 'postgresql://postgres:Riverplate912@localhost:5432/analiticos' }); 
client.connect()
  .then(() => client.query("SELECT en_analiticos, COUNT(*) FROM student GROUP BY en_analiticos"))
  .then(res => { 
     console.log('Database student count by en_analiticos status:');
     console.log(JSON.stringify(res.rows, null, 2)); 
     return client.query("SELECT COUNT(*) FROM student WHERE en_analiticos = true AND id IN (SELECT student_id FROM nota)");
  })
  .then(res => {
     console.log('Students in analiticos with notes:', res.rows[0].count);
     client.end(); 
  })
  .catch(e => { console.error(e); client.end(); });
