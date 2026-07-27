import { MongoClient } from "mongodb";
import { standardizeWorldCupName } from "./worldCupName.js";

const MONGO_URI = "mongodb+srv://alaluf99_db_user:huGakuycAwaHlm5o@cluster0.mmmplb9.mongodb.net/";
const COLLECTION = "bot_event_listings";

// Process-level cache so a single cron run reads the daily FX doc at most once.
let _gbpRatesCache = null;

// Read managetix's daily GBP-based FX doc (fx_rates/gbp_rates, refreshed once a day at ~06:00 UTC).
// Each value is that currency expressed in GBP, e.g. { USD: 0.75, EUR: 0.85, GBP: 1 } → 1 USD = 0.75
// GBP. Returns null on failure so callers can fall back. This is the same "once a day" rate the
// managetix dashboard uses, so the bot's pricing math stays consistent with it.
export async function getGbpRatesFromDB() {
    if (_gbpRatesCache) return _gbpRatesCache;
    const client = new MongoClient(MONGO_URI);
    try {
        await client.connect();
        const doc = await client.db().collection("fx_rates").findOne({ _id: "gbp_rates" });
        if (!doc || !Number.isFinite(doc.USD) || doc.USD <= 0) return null;
        _gbpRatesCache = {
            USD: doc.USD,
            EUR: Number.isFinite(doc.EUR) ? doc.EUR : null,
            GBP: Number.isFinite(doc.GBP) ? doc.GBP : 1,
            updatedAt: doc.updatedAt,
        };
        return _gbpRatesCache;
    } catch (err) {
        console.warn("⚠️ Could not read fx_rates from DB:", err.message);
        return null;
    } finally {
        await client.close();
    }
}

// Build bot_event_listings docs from the Hello snapshot array
// (the same shape written to listingsSnapshot.json). Snapshot prices are USD;
// `rate` converts them to GBP for the dashboard (USD × rate = GBP).
function normaliseHelloEvents(snapshot, rate = 1) {
    const toGbp = (usd) => (usd == null ? null : Number((usd * rate).toFixed(2)));
    const isWorldCup = (name) => /world\s*cup/i.test(name ?? "");
    const docs = [];
    for (const ev of snapshot) {
        if (!ev.id || !ev.name) continue;

        // World Cup events are kept in USD (no conversion); everything else converts USD → GBP.
        const wc = isWorldCup(ev.name);
        const price = wc ? (usd) => (usd == null ? null : Number(Number(usd).toFixed(2))) : toGbp;

        // Split listings into two buckets keyed by display label:
        //   catMap — category-only listings (no section) → competitor = cheapest in category
        //   secMap — section-specific listings           → competitor = cheapest in section
        // value = { mine: Map<listingId, listing>, splitComp: Map<splitType, number[]> }
        const catMap = new Map();
        const secMap = new Map();

        for (const l of ev.listingsJsons ?? []) {
            const cat = (l.category ?? "Unknown").trim() || "Unknown";
            const section = (l.section ?? "").toString().trim();
            const isSection = section.length > 0;
            const qty = l.quantity ?? 0;
            const split = `${qty} Seated Together`;

            const map = isSection ? secMap : catMap;
            const label = isSection ? `${cat} — ${section}` : cat;
            if (!map.has(label)) map.set(label, { mine: new Map(), splitComp: new Map() });
            const entry = map.get(label);

            if (l.id != null && l.price != null) {
                entry.mine.set(String(l.id), {
                    listingId: String(l.id),
                    priceUsd: l.price,
                    quantity: qty,
                    splitType: split,
                });
            }

            // competitor price (USD): section listings compare ONLY within their own section — if
            // there's no competitor in that block, competition is null (do NOT fall back to the
            // category cheapest, which would show unrelated blocks' prices and contradicts the
            // pricing logic, which does nothing when a section has no competitor). Category-only
            // listings use the category cheapest.
            const compUsd = isSection ? l.cheapestInSection : l.cheapestInCategory;
            if (compUsd != null) {
                if (!entry.splitComp.has(split)) entry.splitComp.set(split, []);
                entry.splitComp.get(split).push(compUsd);
            }
        }

        // Build the doc-shape array (categoryName + myListings + splitBreakdown + mins) from a bucket map.
        const buildBuckets = (map) =>
            Array.from(map.entries()).map(([categoryName, { mine, splitComp }]) => {
                // myListings carry the GBP price (display); USD is summarised per split below
                const myListings = Array.from(mine.values()).map((l) => ({
                    listingId: l.listingId,
                    price: price(l.priceUsd),
                    quantity: l.quantity,
                    splitType: l.splitType,
                }));

                // group my listings (USD) by split
                const mySplitUsd = new Map();
                for (const l of mine.values()) {
                    if (!mySplitUsd.has(l.splitType)) mySplitUsd.set(l.splitType, []);
                    mySplitUsd.get(l.splitType).push(l.priceUsd);
                }

                const allSplits = new Set([...mySplitUsd.keys(), ...splitComp.keys()]);
                const splitBreakdown = Array.from(allSplits).map((splitType) => {
                    const myUsd = mySplitUsd.get(splitType) ?? [];
                    const compUsd = splitComp.get(splitType) ?? [];
                    const myMinUsd = myUsd.length ? Math.min(...myUsd) : null;
                    const compMinUsd = compUsd.length ? Math.min(...compUsd) : null;
                    return {
                        splitType,
                        myMinPrice: price(myMinUsd),
                        competitorMinPrice: price(compMinUsd),
                        myMinPriceUsd: myMinUsd,           // original USD (for hover tooltip)
                        competitorMinPriceUsd: compMinUsd, // original USD (for hover tooltip)
                    };
                });

                const allMyUsd = Array.from(mine.values()).map((l) => l.priceUsd);
                const allCompUsd = Array.from(splitComp.values()).flat();
                return {
                    categoryName,
                    myListings,
                    splitBreakdown,
                    myMinPrice: allMyUsd.length ? price(Math.min(...allMyUsd)) : null,
                    competitorMinPrice: allCompUsd.length ? price(Math.min(...allCompUsd)) : null,
                };
            });

        const categories = buildBuckets(catMap);
        const sections = buildBuckets(secMap);

        docs.push({
            platform: "hello",
            eventId: String(ev.id),
            eventName: standardizeWorldCupName(ev.name), // canonical WC name so it matches StubHub
            eventDate: ev.performance_date ? new Date(ev.performance_date) : null,
            venue: null,
            categories,
            sections,
            updatedAt: new Date(),
        });
    }
    return docs;
}

export async function saveListingsToDB(snapshot, usdToGbp = 1) {
    const client = new MongoClient(MONGO_URI);
    try {
        await client.connect();
        const col = client.db().collection(COLLECTION);

        await col.createIndex({ platform: 1, eventId: 1 }, { unique: true });

        const docs = normaliseHelloEvents(snapshot, usdToGbp);

        // Safety guard: a Cloudflare-degraded / partial scrape can return far fewer events than
        // reality. Since we prune events not in this run (deleteMany below), a tiny snapshot would
        // wipe good data. If the snapshot is dramatically smaller than what's already stored, skip
        // the save + prune entirely and preserve the existing data.
        const existingCount = await col.countDocuments({ platform: "hello" });
        if (existingCount > 10 && docs.length < existingCount * 0.5) {
            console.warn(
                `⚠️ Skipping Hello DB save: scrape returned ${docs.length} events but DB has ${existingCount} — looks degraded (Cloudflare block?). Preserving existing data.`,
            );
            return;
        }

        const ops = docs.map((doc) => ({
            updateOne: {
                filter: { platform: doc.platform, eventId: doc.eventId },
                update: { $set: doc },
                upsert: true,
            },
        }));

        if (ops.length > 0) {
            const result = await col.bulkWrite(ops);
            console.log(`✅ DB upserted ${result.upsertedCount} new, ${result.modifiedCount} updated (Hello listings)`);

            // Reconcile: the API is authoritative for my Hello listings, so remove any
            // Hello events in the DB that are no longer returned by this run (delisted /
            // stale). Guarded by docs.length > 0 so a transient empty API response can't
            // wipe everything.
            const currentIds = docs.map((d) => d.eventId);
            const del = await col.deleteMany({ platform: "hello", eventId: { $nin: currentIds } });
            if (del.deletedCount) {
                console.log(`🧹 removed ${del.deletedCount} stale Hello events no longer on the API`);
            }
        }
    } catch (err) {
        console.error("❌ Failed to save Hello listings to DB:", err.message);
    } finally {
        await client.close();
    }
}

// Resolve a performance's event name from the DB (bot_event_listings, keyed by eventId ==
// String(performanceId)). Returns null if not found. Used by the order notification so it can
// name the event without relying on the static events.json file.
export async function getEventNameById(performanceId) {
    const client = new MongoClient(MONGO_URI);
    try {
        await client.connect();
        const doc = await client
            .db()
            .collection(COLLECTION)
            .findOne(
                { platform: "hello", eventId: String(performanceId) },
                { projection: { eventName: 1 } },
            );
        return doc?.eventName || null;
    } catch (err) {
        console.error("❌ Failed to read event name from DB:", err.message);
        return null;
    } finally {
        await client.close();
    }
}
