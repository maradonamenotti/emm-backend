const dotenv = require('dotenv');
dotenv.config();

async function testToken(name, token) {
    if (!token) {
        console.log(`[${name}] No token configured.`);
        return;
    }
    console.log(`\nTesting [${name}] (ends with ...${token.substring(token.length - 10)}):`);
    try {
        // Test /me endpoint to check token identity
        const meRes = await fetch(`https://graph.facebook.com/v19.0/me?access_token=${token}`);
        const meData = await meRes.json();
        console.log('  /me status:', meRes.status);
        console.log('  /me response:', JSON.stringify(meData, null, 2));

        if (meRes.ok) {
            // Test if we can see accounts/pages linked
            const accountsRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${token}`);
            const accountsData = await accountsRes.json();
            console.log('  /me/accounts status:', accountsRes.status);
            if (accountsRes.ok) {
                console.log('  Available pages:', accountsData.data?.map(p => ({ name: p.name, id: p.id, tasks: p.tasks })));
            } else {
                console.log('  /me/accounts error:', accountsData);
            }
        }
    } catch (e) {
        console.error(`  Error testing [${name}]:`, e.message);
    }
}

async function main() {
    await testToken('Facebook Maradona Menotti (656586727544612)', process.env.META_PAGE_TOKEN_656586727544612);
    await testToken('Instagram Business Account (17841475184516351)', process.env.META_PAGE_TOKEN_17841475184516351);
    await testToken('System User Token', process.env.META_SYSTEM_USER_TOKEN);
}

main();
