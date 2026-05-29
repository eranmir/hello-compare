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
import {awayConf, brunoconf, btsconf, configurations, harryConf, OrderStatus} from "./consts.js";
import axios from "axios";
import {getEventsForTeam} from "./DiscoveryApiUtils.js";

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
    listings = fixListingsByPerformanceId(listings, events);
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

export function fixOrdersByPerformanceId(orders, eventsById) {
    const ordersByPerformance = new Map();

    for (const order of orders) {
        const perfId = order.performance_id;

        if (!ordersByPerformance.has(perfId)) {
            const event = eventsById.get(perfId);

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

export function fixListingsByPerformanceId(listings, eventsById) {
    const listingsByPerformance = new Map();

    for (const listing of listings) {
        const perfId = listing.performance_id;

        if (!listingsByPerformance.has(perfId)) {
            const event = eventsById.get(perfId);

            listingsByPerformance.set(perfId, {
                performance_id: perfId,
                performance_name: event?.name || null,
                performance_date: event?.date || null,
                myListings: []
            });
        }

        listingsByPerformance.get(perfId).myListings.push(listing);
    }

    return listingsByPerformance;
}

export async function createAllEvents(events) {
    //events =events.filter((event) => event.name.includes('vs. Tottenham'))
    for (let eventTotal of events) {
        let event = eventTotal;
        const inHandDate = getDayBefore(event.start_date.local_date);
        for (let conf of configurations) {
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
    const results = [];
    for (const [performanceId, obj] of listings.entries()) {
        const lists = await getSiteListings(performanceId);
        const myListingIds = obj.myListings.map(l => l.id.toString());

        obj.allListings = (lists?.tickets || []).filter(
            l => !myListingIds.includes(l.id)
        );

        obj.myListingsToCompare = (lists?.tickets || []).filter(
            l => myListingIds.includes(l.id)
        );

        results.push(obj);

        // wait 0.5 seconds before next request
        await new Promise(res => setTimeout(res, 500));
    }

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

    await deleteTicketGroupsByPerformance( 2257225)
        // await deleteTicketGroupsByPerformance( 2254337 )
 //   let aa = await getEventsForTeam("fa cup");
    //await createAllEvents( [aa[0]]);

let orders = await getHelloTicketsOrders()
let events =  await getEventsByIdFromFile();

orders = orders.filter((order) => !order.status.includes("reject"));

orders = fixOrdersByPerformanceId(orders, events)
    await exportOrdersToExcel(orders, 'hello_orders.xlsx');

    const { futureEvents, pastEvents } = splitOrdersByDate(orders);

await getPaymentExcel(pastEvents);

 //let aa = await getEventsForTeam("galatasaray");
    /*orders = orders.filter((order) => !order.status.includes("reject"));
    orders = fixOrdersByPerformanceId(orders, events)
    await exportOrdersToExcel(orders, 'hello_orders.xlsx');*/




    let listings = await getHelloTicketsListings();

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

export async function getSiteListings(performanceId) {
    try {
        const resp = await axios.get(
            `https://www.hellotickets.com/api/performances/${performanceId}/tickets`,
            {
                headers: {
                    "accept": "application/json",
                    "accept-language": "en-US,en;q=0.9",
                    "cookie": "ht-internal-traffic=0; locale=en_US; cookiesAccepted=true"
                }
            }
        );

        return resp.data;
    } catch (err) {
        console.error("Error fetching site listings:", err.response?.data || err.message);
    }
}