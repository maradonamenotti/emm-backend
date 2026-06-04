const token = "EABAyu2qw7GYBRowNtw3fbIHXcqK1Q3ZAjSg97MRBliyJoFdtlv07C93MQhmU1abXNrEluZCwS7KhXEK3vjAHQbpVptixHc7GLOrINnSQGExuizYzUXOdnxpDeBvapMLe5H5VskjagSuihzGkBW3pBN6ISxrT0MlrzDiZCrktZAry7pKWBBz9nUGwwVN5VPYoT0ACcgDuYWrAc1aHGzUZD";
const senderId = "2174344963328923";
const url = `https://graph.facebook.com/v19.0/${senderId}?fields=name,username&access_token=${token}`;

async function test() {
    try {
        const response = await fetch(url);
        const data = await response.json();
        console.log("Instagram Profile Fetch Result:", data);
    } catch(e) {
        console.error(e);
    }
}
test();
