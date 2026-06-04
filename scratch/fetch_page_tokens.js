async function getPageTokens() {
    const userToken = "EABAyu2qw7GYBRnWY8e68Wds5y2x6IriDwIrpJZBZBB1dj1tmdYZAvRaK22Dg8RZBJshoqSftwXpCSN6BZC31glNDd9gqY9X1cnfm6OJBFaPa3NXuWo2xIPB2meSCKfKvCcUFonZBrMMo2pUViLyfnCgfcVreQEWsq2LyHiZCwJVJJZCTFFI3EBdZCPh7suIF5UO9CGJU33rCm3TEmnHzaPswXQiwkhikOH2zOOOJc8FmWqyAsmL9AqpW1Dt7wCJUtaeKeAXIhCzToesnwhtahnFz90CONip2AKMjA";
    const url = `https://graph.facebook.com/v19.0/me/accounts?access_token=${userToken}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        console.log(JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(error);
    }
}

getPageTokens();
