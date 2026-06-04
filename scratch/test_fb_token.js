const token = "EABAyu2qw7GYBRowNtw3fbIHXcqK1Q3ZAjSg97MRBliyJoFdtlv07C93MQhmU1abXNrEluZCwS7KhXEK3vjAHQbpVptixHc7GLOrINnSQGExuizYzUXOdnxpDeBvapMLe5H5VskjagSuihzGkBW3pBN6ISxrT0MlrzDiZCrktZAry7pKWBBz9nUGwwVN5VPYoT0ACcgDuYWrAc1aHGzUZD";
const senderId = "26661019840267225";
const url = `https://graph.facebook.com/v19.0/${senderId}?fields=first_name,last_name&access_token=${token}`;

async function test() {
    try {
        const response = await fetch(url);
        const data = await response.json();
        console.log("Profile Fetch Result:", data);

        const debugUrl = `https://graph.facebook.com/v19.0/debug_token?input_token=${token}&access_token=${token}`;
        const debugRes = await fetch(debugUrl);
        const debugData = await debugRes.json();
        console.log("Token Debug Result:", debugData);
    } catch(e) {
        console.error(e);
    }
}
test();
