import fs from "fs/promises";
import {getHelloTicketsListings, getHelloTicketsOrders, updateListingPrice} from "./SellerApiUtils.js";
import {
    fixListingsByPerformanceId,
    getEventsByIdFromFile,
    getListingsFromClientSide,
} from "./GenericUtils.js";
import {getBlacklistSet} from "./blackListUtils.js";
import {saveListingsToDB, getGbpRatesFromDB} from "./db.js";

const LISTINGS_SNAPSHOT_FILE = "./listingsSnapshot.json";

const UNDERCUT_AMOUNT = 2;   // USD
const RAISE_THRESHOLD = 4;   // USD
// Markup Hello's API feed (getSiteListings) applies to OUR listing prices: measured ~1.26 across
// 197 live listings (1.256–1.263). The bot converts between our seller price and feed prices with
// this. Was hardcoded 1.1, which under-compensated → our listings sat ~15% ABOVE competitors on the
// buyer site despite the bot thinking we were cheapest (0 sales). Buyer-final markup is higher
// (~1.43 = 1.1 site markup × 1.3 cart fee) but the bot works in feed space, so 1.26 is the value here.
const HELLO_MARKUP = 1.26;
const blacklist = await getBlacklistSet();

// Hello prices are USD; the dashboard + minimum floors are GBP. Fetch a live USD→GBP rate.
const USD_GBP_FALLBACK = 0.79;
// Competitor prices from the Hello API come in the event's native currency (usually EUR, sometimes
// GBP) — convert them TO USD so they compare apples-to-apples with our USD listings.
const EUR_USD_FALLBACK = 1.14;
const GBP_USD_FALLBACK = 1.27;
const CURRENCY_TOKENS = [
    "fca_live_p6pmtee37c8GsrcHAXzaHwPwrmnQOBADjgHop3QQ",
    "fca_live_8sZ0nxwcSaRnrI1CwRBvqdWPojkhacHx3Oj4hKnE",
    "fca_live_NHTtPJDfbovwwiPqt6EFGO4wx2pT7BK4KAIcVxAL",
    "fca_live_TV6LmmUV8gNO1ZAQ2cYLGvBYlpQBFaQ55uDi8Hfw",
    "fca_live_tIxnPAePGhIezVogsLMu7K2gbtv4jLBiHeSySVfk",
    "fca_live_yLskjwTWuHgnqnrETf1a6qbabI9vbnHixMmdAXnh",
];

async function getUsdToGbp() {
    // Preferred: managetix's daily GBP rate (fx_rates/gbp_rates, refreshed once a day). Live, consistent
    // with the dashboard, and no per-run FX-API quota to burn (the old per-run fetch kept 429ing and
    // falling back to a stale rate, which corrupted every price decision).
    const gbp = await getGbpRatesFromDB();
    if (gbp && Number.isFinite(gbp.USD)) {
        console.log(`💱 USD→GBP (managetix daily): ${gbp.USD}`);
        return gbp.USD;
    }
    // Fallback: live FX API, then the hardcoded constant.
    try {
        const key = CURRENCY_TOKENS[Math.floor(Math.random() * CURRENCY_TOKENS.length)];
        const res = await fetch(
            `https://api.freecurrencyapi.com/v1/latest?apikey=${key}&base_currency=USD&currencies=GBP`
        );
        const json = await res.json();
        const rate = json?.data?.GBP;
        if (rate && Number.isFinite(rate)) {
            console.log(`💱 USD→GBP rate (FX API fallback): ${rate}`);
            return rate;
        }
    } catch (err) {
        console.warn("⚠️ Could not fetch USD→GBP rate:", err.message);
    }
    console.warn(`⚠️ Using fallback USD→GBP rate ${USD_GBP_FALLBACK}`);
    return USD_GBP_FALLBACK;
}

// FX multipliers TO USD, keyed by currency code, for converting competitor prices to USD.
async function getFxToUsd() {
    const fx = { USD: 1, EUR: EUR_USD_FALLBACK, GBP: GBP_USD_FALLBACK };
    // Preferred: derive X→USD from managetix's daily GBP rates. X→USD = (X→GBP) / (USD→GBP).
    const gbp = await getGbpRatesFromDB();
    if (gbp && Number.isFinite(gbp.USD) && gbp.USD > 0) {
        if (Number.isFinite(gbp.EUR)) fx.EUR = gbp.EUR / gbp.USD;
        fx.GBP = (gbp.GBP ?? 1) / gbp.USD;
        console.log(`💱 EUR→USD: ${fx.EUR.toFixed(4)} | GBP→USD: ${fx.GBP.toFixed(4)} (managetix daily)`);
        return fx;
    }
    // Fallback: live FX API, then constants.
    try {
        const key = CURRENCY_TOKENS[Math.floor(Math.random() * CURRENCY_TOKENS.length)];
        const res = await fetch(
            `https://api.freecurrencyapi.com/v1/latest?apikey=${key}&base_currency=USD&currencies=EUR,GBP`
        );
        const json = await res.json();
        // API gives USD→X; invert to get X→USD.
        if (json?.data?.EUR && Number.isFinite(json.data.EUR)) fx.EUR = 1 / json.data.EUR;
        if (json?.data?.GBP && Number.isFinite(json.data.GBP)) fx.GBP = 1 / json.data.GBP;
        console.log(`💱 EUR→USD: ${fx.EUR.toFixed(4)} | GBP→USD: ${fx.GBP.toFixed(4)} (FX API fallback)`);
    } catch (err) {
        console.warn("⚠️ Could not fetch FX→USD rates, using fallbacks:", err.message);
    }
    return fx;
}

function normalize(str = "") {
    return str
        .toLowerCase()
        .replace(/\b(tier|level)\b/g, "") // remove "tier" and "level"
        .replace(/\s+/g, " ")             // collapse extra spaces
        .trim();
}


function isCentral(str = "") {
    return normalize(str).includes("central");
}

function categoryMatches(myCategory, theirCategory) {
    const mine = normalize(myCategory);
    const theirs = normalize(theirCategory);

    // must include my category
    if (!theirs.includes(mine)) return false;

    const mineCentral = isCentral(mine);
    const theirsCentral = isCentral(theirs);

    // if mine is central and theirs is not → reject
    if (mineCentral && !theirsCentral) return false;

    // all other cases allowed
    return true;
}

/** True if listing has a section (not just category). */
function hasSection(listing) {
    const s = (listing.section ?? "").toString().trim();
    return s.length > 0;
}

/** True if competitor is in the same section (normalized). */
function sectionMatches(mySection, theirSection) {
    const mine = normalize(mySection ?? "");
    const theirs = normalize(theirSection ?? "");
    return mine.length > 0 && theirs.length > 0 && mine === theirs;
}



function buildPricingDecisionsForPerformance(perf) {
    const decisions = [];

    for (const my of perf.myListings) {
        const myCategory = my.category || my.section;
        const myQty = my.split_type === 4 ? 2 : my.available_quantity;

        const myPrice = my.price.unit_price / 100; // actual USD
        const myNormalized = myPrice * HELLO_MARKUP;

        const competitors = perf.allListings.filter(c => {
            if (!quantityMatches(myQty, c)) return false;
            if (hasSection(my)) {
                return sectionMatches(my.section, c.section);
            }
            return categoryMatches(myCategory, c.category);
        });

        // No competition
        if (!competitors.length) {
            decisions.push({
                myListingId: my.id,
                performance_id: perf.performance_id,
                category: myCategory,
                quantity: myQty,
                status: "NO_COMPETITION",
                myPrice
            });
            continue;
        }

        // Find cheapest competitor
        const cheapest = competitors.reduce((min, c) =>
            c.pricePerSeat < min.pricePerSeat ? c : min
        );

        const cheapestPrice = cheapest.pricePerSeat;

        // Difference AFTER normalization
        // positive → I am more expensive
        // negative → I am cheaper
        const diff = myNormalized - cheapestPrice;

        // ─────────────────────────────
        // CASE 1: I am more expensive → UNDERCUT
        // ─────────────────────────────
        if (diff > 0) {
            let suggestedPrice =
                (cheapestPrice - UNDERCUT_AMOUNT) / HELLO_MARKUP;
            decisions.push({
                myListingId: my.id,
                performance_id: perf.performance_id,
                category: myCategory,
                quantity: myQty,
                status: "SHOULD_UNDERCUT",
                myPrice,
                cheapestPrice,
                suggestedPrice: Number(suggestedPrice.toFixed(2))
            });
            continue;
        }

        // ─────────────────────────────
        // CASE 2: I am cheapest BUT too cheap → RAISE
        // ─────────────────────────────
        if (Math.abs(diff) >= RAISE_THRESHOLD) {
            const suggestedPrice =
                (cheapestPrice - UNDERCUT_AMOUNT) / HELLO_MARKUP;

            // Safety: never suggest lowering when raising
            if (suggestedPrice > myPrice) {
                decisions.push({
                    myListingId: my.id,
                    performance_id: perf.performance_id,
                    category: myCategory,
                    quantity: myQty,
                    status: "SHOULD_RAISE",
                    myPrice,
                    cheapestPrice,
                    suggestedPrice: Number(suggestedPrice.toFixed(2))
                });
                continue;
            }
        }

        // ─────────────────────────────
        // CASE 3: Price is good → OK
        // ─────────────────────────────
        decisions.push({
            myListingId: my.id,
            performance_id: perf.performance_id,
            category: myCategory,
            quantity: myQty,
            status: "OK",
            myPrice,
            cheapestPrice
        });
    }

    return decisions;
}


function getEffectiveSplits(listing) {
    const warnings = listing?.seatsWarnings?.provider_warnings || [];

    if (warnings.includes("SEATS_WARNING_PAIR_GROUPING")) {
        return [1, 2]; // pairs only, ignore validSplits
    }

    return listing.validSplits || [];
}

function quantityMatches(myQty, listing) {
    const splits = getEffectiveSplits(listing);

    if (!splits.length) return false;

    const has = (n) => splits.includes(n);
    const hasMoreThan4 = splits.some(n => n > 4);

    // A single competes ONLY with listings that can actually sell a single (valid_splits includes 1)
    // — not pairs-only listings a single-buyer can't purchase, which used to drag our price down.
    if (myQty === 1) {
        return has(1);
    }

    if (myQty === 2) {
        return has(2) || has(4) || hasMoreThan4;
    }

    if (myQty === 3) {
        return has(3) || hasMoreThan4;
    }

    if (myQty === 4) {
        return has(4) || hasMoreThan4;
    }

    // myQty > 4
    return hasMoreThan4;
}

function isEventUpcomingOrYesterday(dateStr) {
    const eventDate = new Date(dateStr + "T00:00:00Z");

    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);

    return eventDate >= yesterday;
}

// Build the list of {listing, price} updates for a performance WITHOUT sending them — the actual
// PUTs are run in parallel by runPricingBot (see below). This is pure computation, so it's fast.
function collectPricingJobsForPerformance(perf, minimumPrices, usdToGbp) {
    const jobs = [];
    // Safety guard: if the WHOLE game has zero competitor listings, the site scrape almost certainly
    // failed this run (API hiccup / Cloudflare) rather than the event genuinely having no competition.
    // Bail out so we never treat every listing as "no competition" and snap them all down to their
    // minimums on bad data. Per-listing no-competition (game has competitors, this section doesn't)
    // is still handled below.
    if (!perf.allListings?.length) {
        console.log(`⚠️  ${perf.performance_name}: 0 competitor listings for the whole game — skipping (likely an API issue this run)`);
        return jobs;
    }

    const decisions = buildPricingDecisionsForPerformance(perf);

    for (const d of decisions) {
        if (blacklist.has(String(d.myListingId))) {
            console.log(`⛔ Skipping listing ${d.myListingId} (bot off)`);
            continue;
        }

        const myListing = perf.myListings.find(l => l.id === d.myListingId);
        if (!myListing) {
            continue;
        }

        // No floor set on this listing ⇒ never change its price (unchanged behaviour).
        const minimum = minimumPrices[String(myListing.id)];
        if (minimum == null) {
            continue;
        }

        const currentPrice = myListing.price.unit_price / 100; // USD
        const currentGbp = currentPrice * usdToGbp;
        const floorUsd = minimum / usdToGbp; // GBP floor → USD list price
        const SECTION_UNDERCUT = 3;

        // 1) Competitor-based target (USD), or null when there's no competitor move to make
        //    (price is OK, no competition, or a section priced the same as its category).
        let target = null;
        if (d.suggestedPrice) {
            if (hasSection(myListing)) {
                // Section listings undercut their SECTION competitor directly (section-to-section,
                // regardless of category). The old `sameAsCategory` gate (skip when the section's
                // cheapest equalled the category's cheapest) left listings — especially 4-seated,
                // whose competitors are sparse — frozen at the high start price. Removed.
                const secCheapest = getCheapestCompetitorPrice(perf, myListing);
                if (secCheapest != null && Number.isFinite(secCheapest)) {
                    let secNew = secCheapest - SECTION_UNDERCUT;
                    if (secNew <= 0) secNew = secCheapest;
                    target = Number(secNew.toFixed(2));
                }
            } else {
                target = d.suggestedPrice;
            }
        }

        // 2) Final price, honouring the floor (same rule as the StubHub bot). The minimum is a GBP
        //    dashboard value; my prices are USD, so compare in GBP.
        //    - competitor target at/above the floor → undercut the competitor
        //    - competitor target below the floor     → sit AT the floor (raise up / take down)
        //    - NO competition at all                 → snap to the floor (up OR down): the minimum
        //                                              acts as a manual price when nothing competes
        //    - competition fine, but I'm below floor → raise UP to the floor
        //    - competition fine and at/above floor   → leave the price alone
        let newPrice;
        if (target != null && target * usdToGbp >= minimum) {
            newPrice = target;
        } else if (target != null) {
            newPrice = Number(floorUsd.toFixed(2));
        } else if (d.status === "NO_COMPETITION") {
            newPrice = Number(floorUsd.toFixed(2)); // no competition → price = minimum (up or down)
        } else if (currentGbp < minimum) {
            newPrice = Number(floorUsd.toFixed(2)); // competition fine but below floor → raise up to it
        } else {
            continue; // competition fine and at/above floor → leave
        }

        // avoid micro-changes
        if (Math.abs(currentPrice - newPrice) < 0.5) {
            continue;
        }

        jobs.push({ listing: myListing, price: newPrice }); // price set on Hello stays USD
    }
    return jobs;
}

// Run `worker(item)` over items with at most `limit` in flight. updateListingPrice swallows its own
// errors, so one bad update never sinks the pool.
async function runPool(items, worker, limit) {
    let i = 0;
    async function runner() {
        while (i < items.length) {
            const item = items[i++];
            await worker(item);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
}

// Concurrency for the price-update PUTs. Sequential updates made a full run ~16 min (Arsenal events
// have 484 listings each); running them in parallel brings it back to a few minutes. Kept modest so
// we don't hammer the Hello Seller API into 429s.
const UPDATE_CONCURRENCY = 10;

async function runPricingBot(listingsMap, minimumPrices, usdToGbp) {
    // Phase 1: compute every needed price change (fast, no network).
    const allJobs = [];
    for (const [performanceId, perf] of listingsMap.entries()) {
        if (!perf.myListings?.length || !perf.allListings?.length) continue;
        console.log(`⚽ Pricing ${perf.performance_name} (${perf.performance_date})`);
        const jobs = collectPricingJobsForPerformance(perf, minimumPrices, usdToGbp);
        for (const j of jobs) allJobs.push(j);
    }
    // Phase 2: apply them all in parallel.
    console.log(`🧮 ${allJobs.length} price updates to apply (concurrency ${UPDATE_CONCURRENCY})`);
    const t0 = Date.now();
    await runPool(allJobs, (j) => updateListingPrice(j.listing, j.price), UPDATE_CONCURRENCY);
    console.log(`✅ applied ${allJobs.length} price updates in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function getCheapestCompetitorPrice(perf, myListing) {
    const myCategory = myListing.category || myListing.section;
    const myQty = myListing.split_type === 4 ? 2 : myListing.available_quantity;

    const allListings = perf.allListings || [];
    const competitors = allListings.filter((c) => {
        if (!quantityMatches(myQty, c)) return false;
        if (hasSection(myListing)) {
            return sectionMatches(myListing.section, c.section);
        }
        return categoryMatches(myCategory, c.category);
    });

    if (!competitors.length) return null;

    const cheapest = competitors.reduce((min, c) =>
        c.pricePerSeat < min.pricePerSeat ? c : min
    );

    // Competitor prices are taken from the client-side feed (includes ~10% markup).
    // Snapshot should store the "real" price after removing that markup.
    return cheapest.pricePerSeat / HELLO_MARKUP;
}

/** Cheapest in category that fits quantity, ignoring section/block. */
function getCheapestInCategoryIgnoringSection(perf, myListing) {
    const myCategory = myListing.category || myListing.section;
    const myQty = myListing.split_type === 4 ? 2 : myListing.available_quantity;

    const competitors = (perf.allListings || []).filter((c) =>
        categoryMatches(myCategory, c.category) && quantityMatches(myQty, c)
    );

    if (!competitors.length) return null;

    const cheapest = competitors.reduce((min, c) =>
        c.pricePerSeat < min.pricePerSeat ? c : min
    );
    return cheapest.pricePerSeat / HELLO_MARKUP;
}

/**
 * Build snapshot of all listings by event (sorted by event) with listing id,
 * details, cheapest price and current price. Written after bot run for min-price tracking.
 */
function buildListingsSnapshot(listingsMap) {
    const entries = [...listingsMap.entries()].sort((a, b) => {
        const [idA, perfA] = a;
        const [idB, perfB] = b;
        const dateA = perfA.performance_date || "";
        const dateB = perfB.performance_date || "";
        return dateA.localeCompare(dateB) || idA - idB;
    });

    return entries.map(([performanceId, perf]) => {
        const listingsJsons = (perf.myListings || []).map((listing) => {
            const priceUsd = (listing.price?.unit_price ?? 0) / 100;
            const currency = listing.price?.currency || "USD";
            const activated = blacklist.has(String(listing.id)) ? 0 : 1;
            let cheapestInSection = null;
            if (hasSection(listing)) {
                const sectionPrice = getCheapestCompetitorPrice(perf, listing);
                cheapestInSection = sectionPrice == null ? null : Math.round(sectionPrice * 100) / 100;
            }
            const catPrice = getCheapestInCategoryIgnoringSection(perf, listing);
            const cheapestInCategory = catPrice == null ? null : Math.round(catPrice * 100) / 100;
            return {
                id: listing.id,
                event_id: String(performanceId),
                event_name: perf.performance_name || "",
                activated,
                quantity: listing.available_quantity ?? 0,
                price: Math.round(priceUsd * 100) / 100,
                currency_code: currency,
                category: listing.category ?? "",
                section: listing.section ?? "",
                row: listing.row ?? "",
                cheapestInSection,
                cheapestInCategory,
                currentPrice: Math.round(priceUsd * 100) / 100,
            };
        });
        return {
            id: String(performanceId),
            name: perf.performance_name || "",
            performance_date: perf.performance_date || "",
            listingsJsons,
        };
    });
}

async function writeListingsSnapshot(listingsMap) {
    const snapshot = buildListingsSnapshot(listingsMap);
    await fs.writeFile(
        LISTINGS_SNAPSHOT_FILE,
        JSON.stringify(snapshot, null, 2),
        "utf-8"
    );
    console.log(`📄 Wrote ${snapshot.length} events to ${LISTINGS_SNAPSHOT_FILE}`);
}

async function readMinimumPrices() {
    const { MongoClient } = await import("mongodb");
    const uri = "mongodb+srv://alaluf99_db_user:huGakuycAwaHlm5o@cluster0.mmmplb9.mongodb.net/";
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const docs = await client.db().collection("listing_minimums")
            .find({ platform: "hello" }, { projection: { listingId: 1, minimumPrice: 1 } })
            .toArray();
        const result = {};
        for (const doc of docs) {
            result[doc.listingId] = doc.minimumPrice;
        }
        console.log(`✅ Loaded ${docs.length} Hello minimums from DB`);
        return result;
    } catch (err) {
        console.warn("⚠️ Could not read minimums from DB:", err.message);
        return {};
    } finally {
        await client.close();
    }
}

(async () => {
    let events = await getEventsByIdFromFile();
    let listings = await getHelloTicketsListings();

    listings = listings.ticket_groups;
    listings = await fixListingsByPerformanceId(listings, events);
    listings = await getListingsFromClientSide(listings);

    // filter past events (future + yesterday)
    listings = new Map(
        [...listings.entries()].filter(([_, perf]) =>
            isEventUpcomingOrYesterday(perf.performance_date)
        )
    );

    const minimumPrices = await readMinimumPrices();
    const usdToGbp = await getUsdToGbp();

    // Convert every competitor's per-seat price from its native currency (EUR/GBP) to USD, in place,
    // so all downstream pricing + snapshot math compares against USD numbers (our listings are USD).
    const fxToUsd = await getFxToUsd();
    let converted = 0;
    for (const perf of listings.values()) {
        for (const c of perf.allListings || []) {
            const rate = fxToUsd[c.currency] ?? 1;
            if (typeof c.pricePerSeat === "number") {
                c.pricePerSeat = c.pricePerSeat * rate;
                if (rate !== 1) converted++;
            }
        }
    }
    console.log(`💱 converted ${converted} competitor prices to USD`);

    await runPricingBot(listings, minimumPrices, usdToGbp);

    await writeListingsSnapshot(listings);

    await saveListingsToDB(buildListingsSnapshot(listings), usdToGbp);

    console.log("✅ Pricing bot finished");
})();
