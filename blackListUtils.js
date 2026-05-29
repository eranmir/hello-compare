import fs from "fs/promises";

const BLACKLIST_FILE = "./blacklist.json";

async function readBlacklist() {
    try {
        const raw = await fs.readFile(BLACKLIST_FILE, "utf-8");
        const json = JSON.parse(raw);
        return new Set(json.disabledListingIds || []);
    } catch {
        return new Set();
    }
}

async function writeBlacklist(set) {
    const data = {
        disabledListingIds: [...set]
    };
    await fs.writeFile(BLACKLIST_FILE, JSON.stringify(data, null, 2));
}

export async function isListingDisabled(listingId) {
    const blacklist = await readBlacklist();
    return blacklist.has(String(listingId));
}

export async function disableListing(listingId) {
    const blacklist = await readBlacklist();
    blacklist.add(String(listingId));
    await writeBlacklist(blacklist);
}

export async function enableListing(listingId) {
    const blacklist = await readBlacklist();
    blacklist.delete(String(listingId));
    await writeBlacklist(blacklist);
}

export async function getBlacklistSet() {
    return readBlacklist();
}
