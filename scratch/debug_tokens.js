const dotenv = require('dotenv');
dotenv.config();

const appId = process.env.META_APP_ID;
const appSecret = process.env.META_APP_SECRET;

async function debugToken(name, token) {
    if (!token) {
        console.log(`[${name}] No token.`);
        return;
    }
    const appToken = `${appId}|${appSecret}`;
    const url = `https://graph.facebook.com/debug_token?input_token=${token}&access_token=${appToken}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        console.log(`\n=== DEBUG [${name}] ===`);
        console.log(JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`Error debugging [${name}]:`, e.message);
    }
}

async function main() {
    if (!appId || !appSecret) {
        console.error('META_APP_ID or META_APP_SECRET is missing in .env');
        return;
    }
    await debugToken('Facebook Maradona Menotti (656586727544612)', process.env.META_PAGE_TOKEN_656586727544612);
    await debugToken('Instagram Business Account (17841475184516351)', process.env.META_PAGE_TOKEN_17841475184516351);
    await debugToken('System User Token', process.env.META_SYSTEM_USER_TOKEN);
}

main();
