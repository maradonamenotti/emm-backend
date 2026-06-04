const { Client } = require('pg');

async function main() {
    const client = new Client({
        connectionString: 'postgresql://postgres:Riverplate912@localhost:5432/emm_crm'
    });

    try {
        await client.connect();
        
        console.log('\n--- TODOS LOS PROSPECTOS ---');
        const resProspects = await client.query('SELECT id, nombre, apellido, origen, whatsapp_id FROM prospecto');
        console.table(resProspects.rows);

        console.log('\n--- TODOS LOS MENSAJES ---');
        const resMessages = await client.query('SELECT * FROM mensajes_whatsapp');
        console.table(resMessages.rows);

    } catch (err) {
        console.error('Error querying database:', err);
    } finally {
        await client.end();
    }
}

main();
