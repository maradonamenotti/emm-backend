const dotenv = require('dotenv');
dotenv.config();

async function main() {
    const token = process.env.META_PAGE_TOKEN_656586727544612;
    if (!token) {
        console.log('No token found for META_PAGE_TOKEN_656586727544612');
        return;
    }
    const pageId = '656586727544612';
    const url = `https://graph.facebook.com/v19.0/${pageId}?fields=name,username,instagram_business_account&access_token=${token}`;
    
    console.log(`Testing token against page ${pageId}:`);
    try {
        const res = await fetch(url);
        const data = await res.json();
        console.log('Status:', res.status);
        console.log('Response:', JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    }
}

main();
