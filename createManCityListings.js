/**
 * Create Hello listings for every MANCHESTER CITY HOME game (incl. the Community Shield), for every
 * section in `manCityConf`: a CATEGORY-GENERIC listing AND one per block, for each split 1/2/3/4.
 *
 * Dry-run by default; pass --go to create.
 *   node createManCityListings.js          # preview
 *   node --experimental-global-webcrypto createManCityListings.js --go   # create
 */
import { getEventsForTeam } from "./DiscoveryApiUtils.js";
import { createTicketGroups } from "./SellerApiUtils.js";
import { getDayBefore } from "./GenericUtils.js";

const GO = process.argv.includes("--go");
const CONCURRENCY = 5;

const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(String(i)); return out; };
// Embedded (box consts.js doesn't carry this conf).
const manCityConf = [
  { section: "VIP PACKAGES", pricing: { 1: { price: 20000, face: 0 }, 2: { price: 20000, face: 0 }, 3: { price: 20000, face: 0 }, 4: { price: 24000, face: 0 } }, blocks: ["KITS", "CITIZENS", "JOES EAST", "93:20", "JOES WEST", "THE MANCUNIAN", "LEGENDS"] },
  { section: "SHORTSIDE UPPER TIER", pricing: { 1: { price: 5000, face: 0 }, 2: { price: 10000, face: 0 }, 3: { price: 10000, face: 0 }, 4: { price: 10000, face: 0 } }, blocks: [...range(316, 318)] },
  { section: "LONGSIDE UPPER TIER", pricing: { 1: { price: 10000, face: 0 }, 2: { price: 10000, face: 0 }, 3: { price: 10000, face: 0 }, 4: { price: 10000, face: 0 } }, blocks: [...range(301, 309), ...range(322, 330)] },
  { section: "LONGSIDE MIDDLE TIER", pricing: { 1: { price: 10000, face: 0 }, 2: { price: 10000, face: 0 }, 3: { price: 10000, face: 0 }, 4: { price: 10000, face: 0 } }, blocks: [...range(101, 142)] },
  { section: "SHORTSIDE MIDDLE TIER", pricing: { 1: { price: 10000, face: 0 }, 2: { price: 10000, face: 0 }, 3: { price: 10000, face: 0 }, 4: { price: 10000, face: 0 } } },
  { section: "SHORTSIDE LOWER TIER", pricing: { 1: { price: 10000, face: 0 }, 2: { price: 10000, face: 0 }, 3: { price: 10000, face: 0 }, 4: { price: 10000, face: 0 } }, blocks: [...range(1, 42)] },
  { section: "LONGSIDE LOWER TIER", pricing: { 1: { price: 15000, face: 0 }, 2: { price: 15000, face: 0 }, 3: { price: 15000, face: 0 }, 4: { price: 15000, face: 0 } } },
];

// Home = "Manchester City" before " vs ", OR the Community Shield (Man City is the first-named team).
const isManCityHome = (name = "") => {
  const n = String(name).toLowerCase();
  if (n.includes("community shield") && n.includes("manchester city")) return true;
  return n.split(/\s+vs\.?\s+/)[0].includes("manchester city");
};
const todayISO = () => new Date().toISOString().slice(0, 10);

async function main() {
  const perfs = (await getEventsForTeam("Manchester City")) || [];
  const today = todayISO();
  const homeEvents = perfs.filter((e) => isManCityHome(e.name) && (e.start_date?.local_date || "") >= today);

  console.log(`Manchester City performances fetched: ${perfs.length}`);
  console.log(`Man City HOME upcoming events: ${homeEvents.length}`);
  homeEvents.forEach((e) => console.log(`   ${e.start_date?.local_date}  ${e.name}  (id ${e.id})`));
  const cs = homeEvents.find((e) => /community shield/i.test(e.name));
  console.log(cs ? `✅ Community Shield INCLUDED: ${cs.name}` : `⚠️  Community Shield NOT in Man City performer results — needs manual add`);

  const jobs = [];
  for (const event of homeEvents) {
    const inHandDate = getDayBefore(event.start_date.local_date);
    for (const conf of manCityConf) {
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
          if (block) listing.section = block;
          jobs.push(listing);
        }
      }
    }
  }

  const perSection = manCityConf.map((c) => `${c.section}: ${(c.blocks?.length || 0) + 1}/split (1 cat + ${c.blocks?.length || 0} blocks)`);
  console.log(`\nPer event: ${jobs.length / (homeEvents.length || 1)} listings`);
  perSection.forEach((s) => console.log("   " + s));
  console.log(`\nTOTAL listings to create: ${jobs.length}`);
  console.log("samples:  generic:", JSON.stringify(jobs.find((j) => !j.section)));
  console.log("          block:  ", JSON.stringify(jobs.find((j) => j.section)));

  if (!GO) { console.log("\n💡 DRY RUN — nothing created. Re-run with --go to create these."); return; }

  console.log(`\n🚀 Creating ${jobs.length} listings (concurrency ${CONCURRENCY})...`);
  let created = 0, failed = 0, i = 0;
  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++];
      try { await createTicketGroups(job); created++; } catch { failed++; }
      if ((created + failed) % 100 === 0) console.log(`   ${created + failed}/${jobs.length} (${failed} failed)`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\n✅ Done. Created ${created}, failed ${failed}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
