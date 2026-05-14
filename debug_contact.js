const { Client, LocalAuth } = require('whatsapp-web.js');
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './sessions' }),
    puppeteer: { args: ['--no-sandbox'] }
});

client.on('ready', async () => {
    console.log('Client is ready');
    try {
        const id = '36271149871113@c.us';
        const contact = await client.getContactById(id);
        console.log('Contact found:', contact.number, contact.pushname || contact.name);
    } catch (err) {
        console.error('Error:', err.message);
    }
    process.exit(0);
});

client.initialize();
