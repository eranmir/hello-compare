/**
 * Create Hello listings for every CRYSTAL PALACE HOME game, for every section in `crystalPalaceConf`,
 * CATEGORY-ONLY (no blocks — the conf has none), for each split 1/2/3/4.
 *
 * Dry-run by default; pass --go to actually create.
 *   node createCrystalPalaceListings.js          # preview
 *   node --experimental-global-webcrypto createCrystalPalaceListings.js --go   # create
 */
import { getEventsForTeam } from "./DiscoveryApiUtils.js";
import { createTicketGroups } from "./SellerApiUtils.js";
import { getDayBefore } from "./GenericUtils.js";

const GO = process.argv.includes("--go");
const CONCURRENCY = 5;

// Embedded so it runs on the box (whose consts.js doesn't carry this conf). Category-only: no blocks.
const P = { 1: { price: 20000, face: 0 }, 2: { price: 20000, face: 0 }, 3: { price: 20000, face: 0 }, 4: { price: 24000, face: 0 } };
const crystalPalaceConf = [
  { section: "VIP PACKAGES", pricing: P },
  { section: "SHORTSIDE UPPER TIER", pricing: P },
  { section: "SHORTSIDE LOWER TIER", pricing: P },
  { section: "LONGSIDE TIER", pricing: P },
  { section: "LONGSIDE LOWER TIER", pricing: P },
  { section: "LONGSIDE LOWER CENTRAL TIER", pricing: P },
  { section: "LONGSIDE UPPER TIER", pricing: P },
  { section: "LONGSIDE CENTRAL TIER", pricing: P },
  { section: "EXECUTIVE BOX", pricing: P },
];

const isHome = (name = "") => String(name).toLowerCase().split(/\s+vs\.?\s+/)[0].includes("crystal palace");
const todayISO = () => new Date().toISOString().slice(0, 10);

async function main() {
  const perfs = (await getEventsForTeam("Crystal Palace")) || [];
  const today = todayISO();
  const homeEvents = perfs.filter((e) => isHome(e.name) && (e.start_date?.local_date || "") >= today);

  console.log(`Crystal Palace performances fetched: ${perfs.length}`);
  console.log(`Crystal Palace HOME upcoming events: ${homeEvents.length}`);
  homeEvents.forEach((e) => console.log(`   ${e.start_date?.local_date}  ${e.name}  (id ${e.id})`));

  const jobs = [];
  for (const event of homeEvents) {
    const inHandDate = getDayBefore(event.start_date.local_date);
    for (const conf of crystalPalaceConf) {
      for (const [quantity, pricing] of Object.entries(conf.pricing)) {
        const rand = Math.floor(Math.random() * 500000);
        jobs.push({
          performance_id: event.id,
          external_id: `${rand}-ext-${event.id}-${conf.section}-CAT-q${quantity}`,
          category: conf.section,
          row: "BEST",
          quantity: Number(quantity),
          split_type: 1,
          in_hand_date: inHandDate,
          currency: "USD",
          face_value: pricing.face,
          unit_price: pricing.price,
        }); // no `section` field → category-generic
      }
    }
  }

  console.log(`\nPer event: ${crystalPalaceConf.length} sections × 4 splits = ${crystalPalaceConf.length * 4} listings`);
  console.log(`TOTAL listings to create: ${jobs.length}`);
  console.log("sample:", JSON.stringify(jobs[0]));

  if (!GO) {
    console.log("\n💡 DRY RUN — nothing created. Re-run with --go to create these.");
    return;
  }

  console.log(`\n🚀 Creating ${jobs.length} listings (concurrency ${CONCURRENCY})...`);
  let created = 0, failed = 0, i = 0;
  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++];
      try { await createTicketGroups(job); created++; } catch { failed++; }
      if ((created + failed) % 50 === 0) console.log(`   ${created + failed}/${jobs.length} (${failed} failed)`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\n✅ Done. Created ${created}, failed ${failed}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
