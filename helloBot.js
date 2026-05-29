import fs from "fs/promises";
import {getHelloTicketsListings, getHelloTicketsOrders, updateListingPrice} from "./SellerApiUtils.js";
import {
    fixListingsByPerformanceId,
    getEventsByIdFromFile,
    getListingsFromClientSide,
} from "./GenericUtils.js";
import {getBlacklistSet} from "./blackListUtils.js";

const LISTINGS_SNAPSHOT_FILE = "./listingsSnapshot.json";

const UNDERCUT_AMOUNT = 2;   // USD
const RAISE_THRESHOLD = 4;   // USD
const blacklist = await getBlacklistSet();

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
        const myNormalized = myPrice * 1.1;

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
                (cheapestPrice - UNDERCUT_AMOUNT) / 1.1;
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
                (cheapestPrice - UNDERCUT_AMOUNT) / 1.1;

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
    // singles compare to everything
    if (myQty === 1) return true;

    const splits = getEffectiveSplits(listing);

    if (!splits.length) return false;

    const has = (n) => splits.includes(n);
    const hasMoreThan4 = splits.some(n => n > 4);

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

async function applyPricingForPerformance(perf, minimumPrices) {
    const decisions = buildPricingDecisionsForPerformance(perf);

    for (const d of decisions) {
        if (!d.suggestedPrice) {
            continue;
        }

        if (blacklist.has(String(d.myListingId))) {
            console.log(`⛔ Skipping listing ${d.myListingId} (bot off)`);
            continue;
        }

        const myListing = perf.myListings.find(l => l.id === d.myListingId);
        if (!myListing) {
            continue;
        }

        const hasSec = hasSection(myListing);

        // Category-only (no block): no minimum price check — always apply suggested price.
        // Section-specific listings still require minimum price and use section competition below.

        const currentPrice = myListing.price.unit_price / 100;

        // Pricing rule:
        // - Category-only listings (no section): always apply suggestedPrice (no minimum guard).
        // - Section-specific listings:
        //   * Use section competition (cheapest in same block).
        //   * If section cheapest and category-wide cheapest are effectively the same → skip (do nothing),
        //     so section is not at the same price as the category.
        //   * Otherwise undercut section cheapest by a fixed amount.
        let newPrice;
        if (hasSec) {
            const secCheapest = getCheapestCompetitorPrice(perf, myListing);
            if (secCheapest == null || !Number.isFinite(secCheapest)) {
                continue;
            }

            const catCheapest = getCheapestInCategoryIgnoringSection(perf, myListing);
            if (catCheapest != null && Number.isFinite(catCheapest)) {
                const diff = Math.abs(secCheapest - catCheapest);
                // If section competition is at effectively the same price as category competition,
                // skip updating this listing so section is not priced the same as category.
                if (diff < 0.01) {
                    continue;
                }
            }

            const SECTION_UNDERCUT = 3;
            let secNew = secCheapest - SECTION_UNDERCUT;
            if (secNew <= 0) {
                secNew = secCheapest;
            }
            newPrice = Number(secNew.toFixed(2));
        } else {
            newPrice = d.suggestedPrice;
        }

        // avoid micro-changes
        if (Math.abs(currentPrice - newPrice) < 0.5) {
            continue;
        }

        await updateListingPrice(myListing, newPrice);
    }
}


async function runPricingBot(listingsMap, minimumPrices) {
    for (const [performanceId, perf] of listingsMap.entries()) {
        if (!perf.myListings?.length || !perf.allListings?.length) continue;

        console.log(
            `⚽ Pricing ${perf.performance_name} (${perf.performance_date})`
        );

        await applyPricingForPerformance(perf, minimumPrices);
    }
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
    return cheapest.pricePerSeat / 1.1;
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
    return cheapest.pricePerSeat / 1.1;
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
    try {
        const raw = await fs.readFile("./minimum_price.json", "utf-8");
        return JSON.parse(raw || "{}");
    } catch {
        return {};
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

    await runPricingBot(listings, minimumPrices);

    await writeListingsSnapshot(listings);

    console.log("✅ Pricing bot finished");
})();
