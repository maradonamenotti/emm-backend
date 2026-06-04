const dotenv = require('dotenv');
dotenv.config();

async function test(urlName, url) {
    console.log(`\nQuerying ${urlName}:`);
    try {
        const res = await fetch(url);
        const data = await res.json();
        console.log('Status:', res.status);
        console.log('Response:', JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    }
}

async function main() {
    const token = process.env.META_PAGE_TOKEN_656586727544612;
    if (!token) {
        console.log('No token found');
        return;
    }
    await test('/me', `https://graph.facebook.com/v19.0/me?access_token=${token}`);
    await test('/me/accounts', `https://graph.facebook.com/v19.0/me/accounts?access_token=${token}`);
}

main();
