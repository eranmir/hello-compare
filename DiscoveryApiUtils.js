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

// Shared with the reprice bot for the official tickets API (X-Public-Key auth).
// Trailing slash stripped so callers can safely build `${HELLO_API_BASE}/v1/...`.
export const HELLO_API_BASE = baseUrl.replace(/\/+$/, "");
export const HELLO_PUBLIC_KEY = publicKey;

export  async function getEventsForTeam(teamName) {
    try {
        let performerId = await getPerformerId(teamName);
        //performerId = 11983
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

// Look up a single performance (event) by id — used to resolve events that aren't in events.json,
// so newly-listed events show up without manually rebuilding the file. Cached per process run.
const _perfCache = new Map();
export async function getPerformanceById(performanceId) {
    if (_perfCache.has(performanceId)) return _perfCache.get(performanceId);
    try {
        const response = await axios.get(`${baseUrl}/v1/performances/${performanceId}`, {
            headers: { Accept: "application/json", "x-private-key": privateKey },
        });
        const perf = response.data?.performance || null;
        _perfCache.set(performanceId, perf);
        return perf;
    } catch (err) {
        console.error(`Error fetching performance ${performanceId}:`, err.response?.status || err.message);
        _perfCache.set(performanceId, null);
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