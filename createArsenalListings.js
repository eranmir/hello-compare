/**
 * Create Hello listings for every ARSENAL HOME game, for every section in `arsenalConf`:
 *   - one CATEGORY-GENERIC listing (no block/section), AND
 *   - one BLOCK-SPECIFIC listing per block,
 * for each split 1/2/3/4.
 *
 * Dry-run by default (prints the plan + counts, creates nothing).
 * Pass `--go` to actually create the listings.
 *
 *   node createArsenalListings.js          # preview
 *   node --experimental-global-webcrypto createArsenalListings.js --go   # create
 */
import { getEventsForTeam } from "./DiscoveryApiUtils.js";
import { createTicketGroups } from "./SellerApiUtils.js";
import { getDayBefore } from "./GenericUtils.js";

const GO = process.argv.includes("--go");
const CONCURRENCY = 5;

// arsenalConf is embedded here (rather than imported) because the deployed consts.js on the box
// doesn't carry it, and its consts.js has other exports local lacks — so we avoid touching either.
const range = (a, b) => {
  const out = [];
  for (let i = a; i <= b; i++) out.push(String(i));
  return out;
};
const arsenalConf = [
  {
    section: "SHORTSIDE UPPER TIER",
    pricing: { 1: { price: 5000, face: 0 }, 2: { price: 10000, face: 0 }, 3: { price: 10000, face: 0 }, 4: { price: 10000, face: 0 } },
    blocks: [...range(95, 108), ...range(117, 130)],
  },
  {
    section: "LONGSIDE UPPER TIER",
    pricing: { 1: { price: 10000, face: 0 }, 2: { price: 10000, face: 0 }, 3: { price: 10000, face: 0 }, 4: { price: 10000, face: 0 } },
    blocks: [...range(109, 116), ...range(91, 94), ...range(131, 134)],
  },
  {
    section: "SHORTSIDE LOWER TIER",
    pricing: { 1: { price: 10000, face: 0 }, 2: { price: 10000, face: 0 }, 3: { price: 10000, face: 0 }, 4: { price: 10000, face: 0 } },
    blocks: [...range(5, 12), ...range(24, 28)],
  },
  {
    section: "LONGSIDE LOWER TIER",
    pricing: { 1: { price: 15000, face: 0 }, 2: { price: 15000, face: 0 }, 3: { price: 15000, face: 0 }, 4: { price: 15000, face: 0 } },
    blocks: [...range(13, 19), ...range(1, 4), ...range(29, 32)],
  },
  {
    section: "CLUB LEVEL TIER",
    pricing: { 1: { price: 3000, face: 0 }, 2: { price: 3000, face: 0 }, 3: { price: 3000, face: 0 }, 4: { price: 3400, face: 0 } },
    blocks: range(41, 84).map((n) => "B" + n),
  },
];

// Home game = the team before " vs" is Arsenal (event names are "Home vs. Away").
function isArsenalHome(name = "") {
  const home = String(name).toLowerCase().split(/\s+vs\.?\s+/)[0];
  return home.includes("arsenal");
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const perfs = (await getEventsForTeam("Arsenal FC")) || [];
  const today = todayISO();
  const EXCLUDE = [/dortmund/i]; // user: skip Arsenal vs Borussia Dortmund
  const homeEvents = perfs.filter(
    (e) =>
      isArsenalHome(e.name) &&
      (e.start_date?.local_date || "") >= today &&
      !EXCLUDE.some((rx) => rx.test(e.name || "")),
  );

  console.log(`Arsenal performances fetched: ${perfs.length}`);
  console.log(`Arsenal HOME upcoming events: ${homeEvents.length}`);
  homeEvents.forEach((e) => console.log(`   ${e.start_date?.local_date}  ${e.name}  (id ${e.id})`));

  // Build the flat list of listing payloads.
  const jobs = [];
  for (const event of homeEvents) {
    const inHandDate = getDayBefore(event.start_date.local_date);
    for (const conf of arsenalConf) {
      const targets = [null, ...(conf.blocks || [])]; // null = category-generic, then each block
      for (const [quantity, pricing] of Object.entries(conf.pricing)) {
        for (const block of targets) {
          const rand = Math.floor(Math.random() * 500000);
          const listing = {
            performance_id: event.id,
            external_id: `${rand}-ext-${event.id}-${conf.section}-${block || "CAT"}-q${quantity}`,
            category: conf.section,
            row: "BEST",
            quantity: Number(quantity),
            split_type: 1,
            in_hand_date: inHandDate,
            currency: "USD",
            face_value: pricing.face,
            unit_price: pricing.price,
          };
          if (block) listing.section = block; // omit for the category-generic listing
          jobs.push(listing);
        }
      }
    }
  }

  const perSection = arsenalConf.map(
    (c) => `${c.section}: ${(c.blocks?.length || 0) + 1} listings/split (1 category + ${c.blocks?.length || 0} blocks)`,
  );
  console.log(`\nPer event: ${jobs.length / (homeEvents.length || 1)} listings`);
  perSection.forEach((s) => console.log("   " + s));
  console.log(`\nTOTAL listings to create: ${jobs.length}`);
  console.log("Sample payloads:");
  console.log("   generic:", JSON.stringify(jobs.find((j) => !j.section)));
  console.log("   block:  ", JSON.stringify(jobs.find((j) => j.section)));

  if (!GO) {
    console.log("\n💡 DRY RUN — nothing created. Re-run with --go to create these.");
    return;
  }

  console.log(`\n🚀 Creating ${jobs.length} listings (concurrency ${CONCURRENCY})...`);
  let created = 0, failed = 0, i = 0;
  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++];
      try {
        await createTicketGroups(job);
        created++;
      } catch {
        failed++;
      }
      if ((created + failed) % 100 === 0) console.log(`   ${created + failed}/${jobs.length} (${failed} failed)`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\n✅ Done. Created ${created}, failed ${failed}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
