const { Client } = require('pg'); 
const client = new Client({ connectionString: 'postgresql://postgres:Riverplate912@localhost:5432/analiticos' }); 
client.connect()
  .then(() => client.query("SELECT documento, nombre, apellido, quinttos_id, matricula, pais_residencia, carrera_licencia, datos_extra FROM student WHERE documento IN ('42458932', '46219189')"))
  .then(res => { console.log(JSON.stringify(res.rows, null, 2)); client.end(); })
  .catch(e => console.error(e));
