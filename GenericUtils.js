import fs from "fs";
import fsPromises from "fs/promises";
import {Telegraf} from "telegraf";
import XLSX from "xlsx";

import {
    createTicketGroups, deleteTicketGroupsByPerformance,
    getHelloTicketsListings,
    getHelloTicketsOrders,
    updateListingPrice, updateOrderInfo, updateOrderStatus
} from "./SellerApiUtils.js";
import {awayConf, brunoconf, btsconf, chelseaConf, configurations, harryConf, OrderStatus, worldCup} from "./consts.js";
import axios from "axios";
import {getEventsForTeam, getPerformanceById, HELLO_API_BASE, HELLO_PUBLIC_KEY} from "./DiscoveryApiUtils.js";
import {acquireProxyUrl} from "./proxyPool.js";
import {execFile} from "child_process";
import {promisify} from "util";
const execFileP = promisify(execFile);

// Resolve a performance's name/date: prefer events.json, but fall back to Hello's API for events
// not in the static file (so newly-listed events aren't dropped). Caches the result back into the map.
async function resolveEvent(eventsById, perfId) {
    let event = eventsById.get(perfId);
    if (event && event.name && event.date) return event;
    const perf = await getPerformanceById(perfId);
    if (perf) {
        event = { name: perf.name, id: perfId, date: perf.start_date?.local_date };
        eventsById.set(perfId, event);
    }
    return event || null;
}

export function fileToBase64(path) {
    return fs.readFileSync(path, {encoding: "base64"});
}

export async function getOrderById(id) {
    return getHelloTicketsOrders().then(orders => orders.find(order => order.id === id));
}

export async function deleteAllListings() {
    let listings = await getHelloTicketsListings();
    let events = await getEventsByIdFromFile()
    listings = listings.ticket_groups;
    listings = await fixListingsByPerformanceId(listings, events);
    for (let key of listings.keys()) {
        await deleteTicketGroupsByPerformance(key)
    }
}

export async function sendTelegramMessage(chatId, message) {
    try {
        const randomToken = "7757411028:AAGzo8QKYPfVvgLv3KZinknW3w2hUXhjdKc";
        const bot = new Telegraf(randomToken);
        // await bot.telegram.sendMessage(didNotUpdateChatId, message);
        await bot.telegram.sendMessage(chatId, message);
    } catch (e) {
        console.log(e)
    }
}

export function getDayBefore(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
}

export async function getEventsByIdFromFile() {
    try {
        const raw = await fsPromises.readFile('./events.json', 'utf-8');
        let evs = JSON.parse(raw);
        evs = evs
            /* .filter(ev =>
                 ev.name?.toLowerCase().includes("chelsea fc vs.")
             )*/
            .filter((ev, i, arr) =>
                arr.findIndex(e => e.id === ev.id) === i
            );

        return new Map(
            evs.map(ev => [
                ev.id,
                {
                    name: ev.name,
                    id: ev.id,
                    date: ev.start_date?.local_date
                }
            ])
        );
    } catch (err) {
        console.warn('⚠️ Could not read minPrices.json:', err.message);
    }
}

export async function fixOrdersByPerformanceId(orders, eventsById) {
    const ordersByPerformance = new Map();

    for (const order of orders) {
        const perfId = order.performance_id;

        if (!ordersByPerformance.has(perfId)) {
            const event = await resolveEvent(eventsById, perfId);

            ordersByPerformance.set(perfId, {
                performance_id: perfId,
                performance_name: event?.name || null,
                performance_date: event?.date || null,
                myOrders: []
            });
        }

        ordersByPerformance.get(perfId).myOrders.push(order);
    }

    return ordersByPerformance;
}

export async function fixListingsByPerformanceId(listings, eventsById) {
    const listingsByPerformance = new Map();

    // Pass 1: bucket listings by performance id (pure in-memory, no network).
    for (const listing of listings) {
        const perfId = listing.performance_id;
        if (!listingsByPerformance.has(perfId)) {
            listingsByPerformance.set(perfId, {
                performance_id: perfId,
                performance_name: null,
                performance_date: null,
                myListings: []
            });
        }
        listingsByPerformance.get(perfId).myListings.push(listing);
    }

    // Pass 2: resolve each unique performance's name/date concurrently. resolveEvent hits the
    // API when the event isn't already cached in the file, so doing these sequentially cost ~27s;
    // a bounded worker pool cuts it to a few seconds.
    const perfIds = [...listingsByPerformance.keys()];
    const CONCURRENCY = 8;
    let cursor = 0;
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= perfIds.length) return;
            const perfId = perfIds[i];
            const event = await resolveEvent(eventsById, perfId);
            const entry = listingsByPerformance.get(perfId);
            entry.performance_name = event?.name || null;
            entry.performance_date = event?.date || null;
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, perfIds.length) }, worker)
    );

    return listingsByPerformance;
}

export async function createAllEvents(events) {
    //events =events.filter((event) => event.name.includes('vs. Tottenham'))
    for (let eventTotal of events) {
        let event = eventTotal;
        const inHandDate = getDayBefore(event.start_date.local_date);
        for (let conf of chelseaConf) {
            for (const [quantity, pricing] of Object.entries(conf.pricing)) {
                if (conf.blocks) {
                    for (let block of conf.blocks) {
                        let rand = Math.floor(Math.random() * 500000);
                        let listing = {
                            performance_id: event.id,
                            external_id: `${rand}-ext-${event.id}-${conf.section}-${quantity}-pairs`,
                            category: conf.section,
                            isPairs: conf.isPairs,
                            section: block,
                            row: "BEST",
                            quantity: Number(quantity),
                            split_type: 1,
                            in_hand_date: inHandDate,
                            currency: "USD",
                            face_value: pricing.face,
                            unit_price: pricing.price
                        }
                        await createTicketGroups(listing);
                        setTimeout(() => {}, 1000);
                    }
                } else {
                    let rand = Math.floor(Math.random() * 500000);

                    let listing = {
                        performance_id: event.id,
                        external_id: `${rand}-ext-${event.id}-${conf.section}-${quantity}-pairs`,
                        category: conf.section,
                        isPairs: conf.isPairs,
                        //  section: conf.section,
                        row: "BEST",
                        quantity: Number(quantity),
                        split_type: 1,
                        in_hand_date: inHandDate,
                        currency: "USD",
                        face_value: pricing.face,
                        unit_price: pricing.price
                    }
                    await createTicketGroups(listing);
                }
            }
        }

    }
}

export async function getListingsFromClientSide(listings) {
    /*return await Promise.all(
        [...listings.entries()].map(async ([performanceId, obj]) => {
            const lists = await getSiteListings(performanceId);

            const myListingIds = obj.myListings.map(l => l.id.toString());

            obj.allListings = (lists?.tickets || []).filter(
                l => !myListingIds.includes(l.id)
            );

            obj.myListingsToCompare = (lists?.tickets || []).filter(
                l => myListingIds.includes(l.id)
            );

            return obj; // ✅ THIS WAS MISSING
        })
    );*/
    const entries = [...listings.entries()];
    const results = new Array(entries.length);

    // Fetch competitor listings concurrently. Each call is server-bound (~2.5s for events with
    // real inventory), so concurrency is the main lever; the API stays clean at 10 in flight but
    // starts to 429 / drop connections around 12+. A worker pool keeps N requests in flight and
    // preserves input order. getSiteListings swallows its own errors (returns empty), so one bad
    // fetch can't sink a worker.
    const CONCURRENCY = 10;
    let cursor = 0;
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= entries.length) return;
            const [performanceId, obj] = entries[i];
            const lists = await getSiteListings(performanceId);
            const myListingIds = obj.myListings.map(l => l.id.toString());
            obj.allListings = (lists?.tickets || []).filter(l => !myListingIds.includes(l.id));
            obj.myListingsToCompare = (lists?.tickets || []).filter(l => myListingIds.includes(l.id));
            results[i] = obj;
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker)
    );

    return results;
}

const USD_TO_GBP = 0.74;

/**
 * @param {Map<number, object>} ordersMap
 * @param {string} outputPath
 */
export function exportOrdersToExcel(ordersMap, outputPath = "orders.xlsx") {
    // Convert map → array and sort by match date
    const performances = [...ordersMap.values()].sort((a, b) => {
        return new Date(a.performance_date) - new Date(b.performance_date);
    });

    const rows = [];

    for (const perf of performances) {
        const {
            performance_name,
            performance_date,
            myOrders = []
        } = perf;

        for (const order of myOrders) {
            const quantity = order.tickets_quantity || 0;

            // prices are in cents
            const totalUsd = (order.total_price || 0) / 100;
            const pricePerTicket = quantity ? totalUsd / quantity : 0;
            const totalGbp = totalUsd * USD_TO_GBP;

            const customer = order.customer_info || {};
            const ticketGroup = order.ticket_group || {};
            const category = ticketGroup.category + (ticketGroup.section ? ` - ${ticketGroup.section}` : "");
            rows.push({
                "Order ID": order.id,
                "Order Date": order.created_at
                    ? new Date(order.created_at).toISOString().slice(0, 10)
                    : "",
                "Event Name": performance_name,
                "Event Date": performance_date,
                "Quantity": quantity,
                "Price Per Ticket (USD)": Number(pricePerTicket.toFixed(2)),
                "Total Price (USD)": Number(totalUsd.toFixed(2)),
                "USD To GBP Rate": USD_TO_GBP,
                "Total Price (GBP)": Number(totalGbp.toFixed(2)),
                "Category": category || "",
              //  "Section": ticketGroup.section || "",
                "Customer Name": `${customer.user_first_name || ""} ${customer.user_last_name || ""}`.trim(),
                "Customer Phone": customer.user_phone || "",
                "Customer Email": customer.user_email || ""
            });
        }
    }

    // Create worksheet & workbook
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Orders");

    // Auto column widths
    const colWidths = Object.keys(rows[0] || {}).map(key => ({
        wch: Math.max(
            key.length,
            ...rows.map(r => String(r[key] ?? "").length)
        ) + 2
    }));
    worksheet["!cols"] = colWidths;

    // Write file\
    XLSX.writeFile(workbook, outputPath);

    console.log(`✅ Orders exported to ${outputPath}`);
}

function formatDate(dateStr) {
    const d = new Date(dateStr);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
}


/*
export async function getPaymentExcel(pastEventsMap) {
    const alreadyRequested = await readPaymentRequests();
    const newlyRequested = new Set(alreadyRequested);

    const rows = [];

    for (const [, perf] of pastEventsMap.entries()) {
        const eventName = perf.performance_name;

        for (const order of perf.myOrders) {
            const orderId = String(order.id);

            // skip already requested
            if (alreadyRequested.has(orderId)) continue;

            const quantity = order.tickets_quantity;
            const totalUsd = order.total_price / 100;

            rows.push({
                "Order number": order.id || order.reference,
                "Purchase Date": formatDate(order.created_at),
                "Event Description": eventName,
                "Quantity": quantity,
                "Amount": Math.round(totalUsd * 100) / 100, // ✅ number
                "Currency": order.currency || "USD"
            });

            newlyRequested.add(orderId);
        }
    }

    if (!rows.length) {
        console.log("ℹ️ No new payment requests to export");
        return;
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);

    XLSX.utils.book_append_sheet(wb, ws, "Payment Requests");

    const today = new Date().toISOString().slice(0, 10);
    const fileName = `payment-request-${today}.xlsx`;

    XLSX.writeFile(wb, fileName);

    await writePaymentRequests(newlyRequested);

    console.log(`✅ Payment request exported: ${fileName}`);
}
*/

export async function getPaymentExcel(orders) {
    const alreadyRequested = await readPaymentRequests();
    const newlyRequested = new Set(alreadyRequested);

    const rows = [];

    for (const order of orders) {
        const orderId = String(order.id);

        // Skip orders already requested
      //  if (alreadyRequested.has(orderId)) continue;

        const totalUsd = order.total_price / 100;

        rows.push({
            "Order number": order.id || order.reference,
            "Purchase Date": formatDate(order.created_at),
            "Event Description": "BTS",
            "Quantity": order.tickets_quantity,
            "Amount": Math.round(totalUsd * 100) / 100,
            "Currency": order.currency || "USD"
        });

        newlyRequested.add(orderId);
    }

    if (!rows.length) {
        console.log("ℹ️ No new payment requests to export");
        return;
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);

    XLSX.utils.book_append_sheet(wb, ws, "Payment Requests");

    const today = new Date().toISOString().slice(0, 10);
    const fileName = `payment-request-${today}.xlsx`;

    XLSX.writeFile(wb, fileName);

    await writePaymentRequests(newlyRequested);

    console.log(`✅ Payment request exported: ${fileName}`);
}
const PAYMENT_FILE = "./paymentRequests.json";

async function readPaymentRequests() {
    try {
        const raw = await fsPromises.readFile(PAYMENT_FILE, "utf-8");
        return new Set(JSON.parse(raw));
    } catch {
        return new Set();
    }
}

async function writePaymentRequests(set) {
    await fsPromises.writeFile(
        PAYMENT_FILE,
        JSON.stringify([...set], null, 2)
    );
}


function splitOrdersByDate(ordersMap) {
    const futureEvents = new Map();
    const pastEvents = new Map();

    // Today at midnight (UTC-safe)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const [performanceId, perf] of ordersMap.entries()) {
        // performance_date is "YYYY-MM-DD"
        const eventDate = new Date(perf.performance_date + "T00:00:00");

        if (eventDate < today) {
            pastEvents.set(performanceId, perf);
        } else {
            futureEvents.set(performanceId, perf);
        }
    }

    return {
        futureEvents,
        pastEvents
    };
}


export async function starterFunction() {
    //await deleteAllListings()
    let debugListings = await getSiteListings("2540672");
    debugListings = debugListings.tickets.sort((a, b) => a.pricePerSeat - b.pricePerSeat);

    let aa = await getEventsForTeam("Chelsea");
    aa = aa.filter(a => a.name.includes("Chelsea FC vs.")).splice( 1);
    await createAllEvents(aa)
   /* let events =  await getEventsByIdFromFile();

    events = new Map(
        [...events].filter(([key, event]) => event.name === "BTS")
    );
    const eventIds = new Set(
        [...events.values()].map(event => event.id), 43282
    );



    //events = events.filter((event) => event.performers[0].id ===327 );
    let orders = await getHelloTicketsOrders()
    orders = orders.filter((order) => !order.status.includes("reject"));

    orders = orders.filter(order => eventIds.has(order.performance_id));

    // const { futureEvents, pastEvents } = splitOrdersByDate(orders);
    await getPaymentExcel(orders);*/
    // DEBUG: fetch this event's competitor listings (Chelsea vs Bournemouth, 2540672) and print them
    // so we can inspect exactly what the Hello API returns (id, section, currency, ticket_price,
    // valid_splits, plus the normalised pricePerSeat/validSplits). Early-return so nothing else runs.
    console.log(`event 2540672 — ${debugListings?.tickets?.length ?? 0} listings:`);
    console.log(JSON.stringify(debugListings, null, 2));
    return;

    // eslint-disable-next-line no-unreachable
    // await deleteTicketGroupsByPerformance( 2540753)

   // let aa = await getEventsForTeam("Manchester United");
  //let listings = await getHelloTicketsListings();


        //aa = aa.filter(a => a.name.includes("Manchester United FC vs.") || a.name.includes("Arsenal FC vs."));
    //await createAllEvents(aa);
     //listings = await getHelloTicketsListings();

    //orders = orders.filter((order) => !order.status.includes("reject"));

    //const missingOrders = orders.filter(order => !ids.includes(order.id));

        // await deleteTicketGroupsByPerformance( 2254337 )




orders = await fixOrdersByPerformanceId(orders, events)
 //   await exportOrdersToExcel(orders, 'hello_orders.xlsx');



 //let aa = await getEventsForTeam("galatasaray");
    /*orders = orders.filter((order) => !order.status.includes("reject"));
    orders = await fixOrdersByPerformanceId(orders, events)
    await exportOrdersToExcel(orders, 'hello_orders.xlsx');*/

    listings = listings.ticket_groups;
    listings = await fixListingsByPerformanceId(listings, events);



    //orders = orders.slice(0,22);

    /*const totalTickets = orders.reduce((sum, order) => {
        return sum + (Number(order.tickets_quantity) || 0);
    }, 0);

// Sum total_price (convert from cents to currency)
    const totalPrice = orders.reduce((sum, order) => {
        return sum + ((Number(order.total_price) || 0) / 100);
    }, 0);

    console.log("Total Tickets:", totalTickets);
    console.log("Total Price:", totalPrice);*/

    //await deleteTicketGroupsByPerformance(2257235)




    //let orders = await getHelloTicketsOrders();


   // let listings = await getHelloTicketsListings();

     //await deleteTicketGroupsByPerformance(2254295)
    //await deleteTicketGroupsByPerformance(2254265)


  //  await createAllEvents(aa);
   /* orders = orders.filter((order) => !order.status.includes("reject"));
    orders = fixOrdersByPerformanceId(orders, events)*/
    //const { futureEvents, pastEvents } = splitOrdersByDate(orders);
    // await getPaymentExcel(pastEvents);


    //aa = aa.filter((event) => event.venue.name.includes('Tottenham'));
    /*aa = aa.map((event) => event.id);
    for (let id of aa) {
        await deleteTicketGroupsByPerformance(id)
    }*/
    // await deleteAllListings()
    /*const filteredListings = new Map(
        [...events.entries()].filter(([_, value]) =>
            value.name?.toLowerCase().includes("manchester city fc vs.")
        )
    );*/

   // let sdorders = await getHelloTicketsOrders();

    let dfevents = await getEventsByIdFromFile();

    /*et lsistings = await getHelloTicketsListings();
    lsistings = lsistings.ticket_groups;
    lsistings = fixListingsByPerformanceId(lsistings, events);*/



   // await updateListingPrice(listings.get(2411609).listings[19], 57)
    // await updateOrderInfo(orders[1], "mobile", "proof.jpeg", "https://example.com/transfer-link");
    /* await updateOrderInfo(orders[2], "eticket", {
         filePath: "ticket.pdf"
     });*/


    /* let listing = listings.ticket_groups.find((l) => l.id === orders[0].ticket_group_id);
     let quantity = orders[0].tickets_quantity + listing.available_quantity;
     await updateListingQuantity(listing, quantity);
     await updateOrderStatus(orders[0].id, OrderStatus.DELIVERED);
 */

}

// Fetch competitor listings for a performance from HelloTickets' official partner API
// (X-Public-Key auth). Returns { tickets: [...] }. Being an official API, it has no
// Cloudflare TLS fingerprinting, so the old curl + rotating-proxy workaround is gone.
//
// The API renames a few fields vs the old client-site endpoint the pricing code was written
// against, so normaliseTicket() aliases them back (see below) — otherwise every competitor
// price/split reads as undefined and managetix shows empty competition for all listings.
export async function getSiteListings(performanceId) {
    const url = `${HELLO_API_BASE}/v1/tickets/${performanceId}`;
    try {
        const { data } = await axios.get(url, {
            timeout: 30000,
            maxContentLength: 25 * 1024 * 1024,
            headers: {
                "X-Public-Key": HELLO_PUBLIC_KEY,
                Accept: "application/json",
            },
        });
        if (data && Array.isArray(data.tickets)) {
            data.tickets.forEach(normaliseTicket);
            return data;
        }
        throw new Error(data?.error_message || "unexpected response (no tickets array)");
    } catch (err) {
        // 404 "no record found" just means this performance has no listings — treat as empty, not an error.
        if (err.response?.status === 404) return { tickets: [] };
        console.error(`Error fetching site listings (perf ${performanceId}):`, (err.message || "").slice(0, 120));
    }
}

// Map the official API's ticket fields onto the names the pricing code (helloBot.js) expects.
// The old client-site endpoint exposed pricePerSeat / validSplits directly; the partner API
// calls them ticket_price / valid_splits. ticket_price is per-seat (verified: it doesn't scale
// with quantity). Currency: the API returns the event's native currency (often EUR) and offers
// no override — per user's call we treat the number as USD 1:1 for now (suspected HT bug, to be
// verified later). id is coerced to String so my-own-listing exclusion (string listing ids) matches.
function normaliseTicket(t) {
    if (t.pricePerSeat == null) t.pricePerSeat = t.ticket_price;
    if (t.validSplits == null) t.validSplits = t.valid_splits;
    if (t.id != null) t.id = String(t.id);
}