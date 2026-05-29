import axios from "axios";

const ENV = process.env.HELLOTICKETS_ENV || "production"; // sandbox | production

const HELLOTICKETS_CONFIG = {
    sandbox: {
        baseUrl: "https://sandbox-discovery-api.hellotickets.com",
        privateKey: "private-6c8ffa29-88e7-4a14-8792-792b20f7f96c",
        publicKey: "pub-43a8d2d5-b4c6-4429-a49e-c8544babb52b"
    },
    production: {
        baseUrl: "https://api-live.hellotickets.com/",
        privateKey: "private-2edde620-4025-46d7-b14c-348ebce78436",
        publicKey: "pub-661b6a01-e903-4879-93af-21cef8a396a7"
    }
};

const {
    baseUrl,
    privateKey,
    publicKey
} = HELLOTICKETS_CONFIG[ENV];

export  async function getEventsForTeam(teamName) {
    try {
        let performerId = await getPerformerId(teamName);
    const response = await axios.get(`${baseUrl}/v1/performances?limit=1000&page=1&performer_id=${performerId}`, {
        headers: {
        Accept: "application/json",
            "x-private-key": privateKey,
    }});

    if (!response.status === 200) {
        throw new Error(`Error fetching events for team ${teamName}: ${response.statusText}`);
    }
    return response.data.performances;
    } catch (err) {
        console.error(`Error fetching events for team ${teamName}:`, err.message);
        return null;
    }
}

async function getPerformerId(performerName) {
    try {
        const response = await axios.get(`${baseUrl}/v1/performers?limit=10&page=1&name=${performerName}`, {
            headers: {
                Accept: "application/json",
                "x-private-key": privateKey,
            }});
        if (!response.status === 200) {
            throw new Error(`Error fetching performer ID for ${performerName}: ${response.statusText}`);
        }

        return response.data.performers[0]?.id || null;
    } catch (err) {
        console.error(`Error fetching performer ID for ${performerName}:`, err.message);
        return null;
    }
}