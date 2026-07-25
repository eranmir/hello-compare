import express from "express";

import {
    createTicketGroups,
    getHelloTicketsListings, getHelloTicketsOrderById,
    getHelloTicketsOrders, updateListingPrice, updateOrderInfo,
    updateOrderStatus
} from "./SellerApiUtils.js";
import fs from "fs/promises";
import {
    fixListingsByPerformanceId, fixOrdersByPerformanceId,
    getDayBefore,
    getEventsByIdFromFile, getOrderById,
    sendTelegramMessage,
    starterFunction
} from "./GenericUtils.js";
import { getEventNameById } from "./db.js";
import { getPerformanceById } from "./DiscoveryApiUtils.js";

const ordersChatId = -5034935260;
const app = express();
app.use(express.json());
app.use(express.static("public"));

import multer from "multer";
import {disableListing, enableListing, getBlacklistSet} from "./blackListUtils.js";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {fileSize: 10 * 1024 * 1024}
});

app.post(
    "/api/orders/:orderId/upload",
    upload.array("files"),
    async (req, res) => {
        try {
            const {orderId} = req.params;
            const {type, mobileLinks, transferUrl} = req.body;

            if (!type) {
                return res.status(400).json({error: "Missing type"});
            }

            // 🔹 fetch full order object (required by updateOrderInfo)
            const order = await getOrderById(Number(orderId));
            if (!order) {
                return res.status(404).json({error: "Order not found"});
            }

            const details = {};

            // MOBILE
            if (type === "mobile") {
                // frontend will send array-of-arrays
                details.mobileLinksSets = JSON.parse(mobileLinks || "[]");
            }

            // ETICKET / TRANSFER
            if (type === "eticket" || type === "transfer") {
                if (!req.files?.length) {
                    return res.status(400).json({error: "No files uploaded"});
                }

                // your function currently supports ONE file
                details.filePaths = req.files.map(f =>
                    f.buffer.toString("base64")
                );
            }

            // TRANSFER requires URL
            if (type === "transfer") {
                if (!transferUrl) {
                    return res.status(400).json({error: "transferUrl required"});
                }
                details.transferUrl = transferUrl;
            }

            await updateOrderInfo(order, type, details);

            res.json({success: true});

        } catch (err) {
            console.error("❌ Upload error:", err);
            res.status(500).json({error: "Upload failed"});
        }
    }
);


function sendSSE(res, event, data) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    res.write(`event: ${event}\ndata: ${payload}\n\n`);
}

app.get("/api/listings/stream", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
        const [events, snapshotRaw] = await Promise.all([
            getEventsByIdFromFile(),
            fs.readFile("./listingsSnapshot.json", "utf-8").catch(() => "[]")
        ]);

        const listingsResp = await getHelloTicketsListings((page) => {
            sendSSE(res, "progress", { page });
            if (typeof res.flush === "function") res.flush();
        });

        let listings = listingsResp.ticket_groups;
        listings = await fixListingsByPerformanceId(listings, events);

        const snapshot = JSON.parse(snapshotRaw || "[]");
        const cheapestByListingId = new Map();
        for (const ev of snapshot) {
            for (const l of ev.listingsJsons || []) {
                const key = String(l.id);
                cheapestByListingId.set(key, {
                    inSection: l.cheapestInSection ?? null,
                    inCategory: l.cheapestInCategory ?? null
                });
            }
        }

        const resultEntries = [];
        for (const [perfId, perf] of listings.entries()) {
            const enhanced = {
                performance_id: perf.performance_id,
                performance_name: perf.performance_name,
                performance_date: perf.performance_date,
                myListings: (perf.myListings || []).map(l => {
                    const extra = cheapestByListingId.get(String(l.id)) || {};
                    const cheapest_in_section = extra.inSection ?? null;
                    const cheapest_in_category = extra.inCategory ?? null;
                    const hasSection = (l.section ?? "").toString().trim().length > 0;
                    const cheapest_price = hasSection
                        ? (cheapest_in_section ?? cheapest_in_category ?? null)
                        : (cheapest_in_category ?? null);
                    return { ...l, cheapest_in_section, cheapest_in_category, cheapest_price };
                })
            };
            resultEntries.push([perfId, enhanced]);
        }

        sendSSE(res, "done", { data: Object.fromEntries(resultEntries) });
    } catch (err) {
        console.error("❌ Listings stream error:", err);
        sendSSE(res, "servererror", { message: err.message || "Failed to fetch listings" });
    } finally {
        res.end();
    }
});

app.get("/api/orders/stream", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
        const events = await getEventsByIdFromFile();
        const orders = await getHelloTicketsOrders((page) => {
            sendSSE(res, "progress", { page });
            if (typeof res.flush === "function") res.flush();
        });
        const data = await fixOrdersByPerformanceId(orders, events);
        sendSSE(res, "done", { data: Object.fromEntries(data) });
    } catch (err) {
        console.error("❌ Orders stream error:", err);
        sendSSE(res, "servererror", { message: err.message || "Failed to fetch orders" });
    } finally {
        res.end();
    }
});

app.get("/api/listings", async (req, res) => {
    try {
        // 1) Load live listings + events from HelloTickets API
        const [events, listingsResp, snapshotRaw] = await Promise.all([
            getEventsByIdFromFile(),
            getHelloTicketsListings(),
            fs.readFile("./listingsSnapshot.json", "utf-8").catch(() => "[]")
        ]);

        let listings = listingsResp.ticket_groups;
        listings = await fixListingsByPerformanceId(listings, events);

        // 2) Build lookup from snapshot: listingId -> cheapest info
        const snapshot = JSON.parse(snapshotRaw || "[]");
        const cheapestByListingId = new Map();
        for (const ev of snapshot) {
            for (const l of ev.listingsJsons || []) {
                const key = String(l.id);
                cheapestByListingId.set(key, {
                    inSection: l.cheapestInSection ?? null,
                    inCategory: l.cheapestInCategory ?? null
                });
            }
        }

        // 3) Attach cheapest prices to live listings
        const resultEntries = [];
        for (const [perfId, perf] of listings.entries()) {
            const enhanced = {
                performance_id: perf.performance_id,
                performance_name: perf.performance_name,
                performance_date: perf.performance_date,
                myListings: (perf.myListings || []).map(l => {
                    const extra = cheapestByListingId.get(String(l.id)) || {};
                    const cheapest_in_section = extra.inSection ?? null;
                    const cheapest_in_category = extra.inCategory ?? null;

                    const hasSection =
                        (l.section ?? "").toString().trim().length > 0;

                    const cheapest_price = hasSection
                        ? (cheapest_in_section ?? cheapest_in_category ?? null)
                        : (cheapest_in_category ?? null);

                    return {
                        ...l,
                        cheapest_in_section,
                        cheapest_in_category,
                        cheapest_price
                    };
                })
            };
            resultEntries.push([perfId, enhanced]);
        }

        res.json(Object.fromEntries(resultEntries));
    } catch (err) {
        console.error("❌ Failed to fetch listings:", err);
        res.status(500).json({error: "Failed to fetch listings"});
    }
});

const MINIMUM_PRICE_FILE = "./minimum_price.json";

app.get("/api/minimum-prices", async (req, res) => {
    try {
        const raw = await fs.readFile(MINIMUM_PRICE_FILE, "utf-8").catch(() => "{}");
        const data = JSON.parse(raw || "{}");
        res.json(data);
    } catch (err) {
        console.error("❌ Failed to read minimum prices:", err);
        res.status(500).json({error: "Failed to fetch minimum prices"});
    }
});

app.post("/api/minimum-prices", async (req, res) => {
    try {
        const updates = req.body;
        if (!updates || typeof updates !== "object") {
            return res.status(400).json({error: "Body must be an object of listing id to minimum price"});
        }
        const raw = await fs.readFile(MINIMUM_PRICE_FILE, "utf-8").catch(() => "{}");
        const data = JSON.parse(raw || "{}");
        for (const [id, value] of Object.entries(updates)) {
            const key = String(id);
            if (value === null || value === undefined || value === "") {
                delete data[key];
            } else {
                const num = Number(value);
                if (!Number.isFinite(num) || num < 0) continue;
                data[key] = num;
            }
        }
        await fs.writeFile(MINIMUM_PRICE_FILE, JSON.stringify(data, null, 2), "utf-8");
        res.json(data);
    } catch (err) {
        console.error("❌ Failed to write minimum prices:", err);
        res.status(500).json({error: "Failed to save minimum prices"});
    }
});

app.post("/api/listings/prices", async (req, res) => {
    try {
        const {updates} = req.body;
        if (!Array.isArray(updates) || !updates.length) {
            return res.status(400).json({error: "Body must include updates array of { listingId, newPrice }"});
        }
        const listingsResp = await getHelloTicketsListings();
        const byId = new Map(listingsResp.ticket_groups.map((l) => [String(l.id), l]));
        const results = await Promise.all(
            updates.map(async ({listingId, newPrice}) => {
                const id = String(listingId);
                const price = Number(newPrice);
                if (!Number.isFinite(price) || price <= 0) {
                    return {listingId: id, ok: false, error: "Invalid newPrice"};
                }
                const listing = byId.get(id);
                if (!listing) {
                    return {listingId: id, ok: false, error: "Listing not found"};
                }
                try {
                    await updateListingPrice(listing, price);
                    return {listingId: id, ok: true};
                } catch (err) {
                    console.error("❌ Update price", id, err?.message || err);
                    return {listingId: id, ok: false, error: err?.message || "Update failed"};
                }
            })
        );
        const saved = results.filter((r) => r.ok).length;
        const failed = results.filter((r) => !r.ok);
        res.json({saved, failed: failed.length, errors: failed});
    } catch (err) {
        console.error("❌ Batch update prices", err);
        res.status(500).json({error: "Failed to update prices"});
    }
});

app.post("/api/listings/:listingId/price", async (req, res) => {
    try {
        const {listingId} = req.params;
        const {newPrice} = req.body;

        if (!newPrice || isNaN(newPrice)) {
            return res.status(400).json({error: "Invalid newPrice"});
        }

        const listingsResp = await getHelloTicketsListings();
        const listing = listingsResp.ticket_groups.find(
            l => String(l.id) === String(listingId)
        );

        if (!listing) {
            return res.status(404).json({error: "Listing not found"});
        }

        await updateListingPrice(listing, Number(newPrice));

        res.json({success: true});
    } catch (err) {
        console.error("❌ Failed to update listing price", err);
        res.status(500).json({error: "Failed to update price"});
    }
});


// Get orders
app.get("/api/orders", async (req, res) => {
    try {
        let events = await getEventsByIdFromFile();
        let orders = await getHelloTicketsOrders();
        orders = await fixOrdersByPerformanceId(orders, events);
        res.json(Object.fromEntries(orders));
    } catch (err) {
        res.status(500).json({error: "Failed to fetch orders"});
    }
});

// Last 20 orders (filter rejected first, then take first 20 before grouping by game)
app.get("/api/orders/last", async (req, res) => {
    try {
        const events = await getEventsByIdFromFile();
        let orders = await getHelloTicketsOrders();
        orders = orders.filter((o) => !(o.status || "").toLowerCase().includes("reject"));
        orders.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        const last20 = orders.slice(0, 20);
        const list = last20.map((order) => {
            const event = events.get(order.performance_id);
            const quantity = order.tickets_quantity || 0;
            const totalCents = order.total_price || 0;
            const usdPerTicket = quantity ? (totalCents / 100) / quantity : 0;
            return {
                orderId: order.id,
                eventName: event?.name || "",
                quantity,
                category: order.ticket_group?.category ?? "",
                section: order.ticket_group?.section ?? "",
                orderDate: order.created_at ? new Date(order.created_at).toISOString().slice(0, 10) : "",
                eventDate: event?.date ?? "",
                usdPerTicket: Math.round(usdPerTicket * 100) / 100,
            };
        });
        res.json(list);
    } catch (err) {
        res.status(500).json({error: "Failed to fetch last orders"});
    }
});

// Update order status
app.put("/api/orders/:orderId/status", async (req, res) => {
    const {orderId} = req.params;
    const {status} = req.body;

    if (!status) {
        return res.status(400).json({error: "Missing status"});
    }

    try {
        const result = await updateOrderStatus(orderId, status);
        res.json({success: true, result});
    } catch (err) {
        res.status(500).json({error: "Failed to update order"});
    }
});

// Sandbox webhook
app.post("/hellotickets/sandbox", async (req, res) => {
    try {
        // console.log("🔵 Raw body type:", typeof req.body);
       // console.log("🔵 Raw body:", req.body);

        let body = req.body;

        // If webhook sent text/plain → parse manually
        if (typeof body === "string") {
            try {
                body = JSON.parse(body);
            } catch {
                console.warn("⚠️ Body is not valid JSON");
                return res.send("ignored");
            }
        }

        if (!body || !body.order) {
            console.warn("⚠️ No order in webhook:", body);
            return res.send("no order");
        }

        const order = body.order;

        const {
            performance_id,
            quantity,
            total_order_amount,
            ticket_group_id,
            currency,
            customer_info,
            id: orderId
        } = order;
        let listings = await getHelloTicketsListings();
        let category = listings.ticket_groups.find((l) => l.id === ticket_group_id)?.category;
        let section = listings.ticket_groups.find((l) => l.id === ticket_group_id)?.section;
        // Resolve the event name from the DB first (bot_event_listings), then fall back to the
        // hellotickets API — so a sale for an event that's not in events.json never shows "unknown".
        let eventName = await getEventNameById(performance_id);
        if (!eventName) {
            const perf = await getPerformanceById(performance_id);
            eventName = perf?.name;
        }
        eventName = eventName || 'unknown event';
        const message = section !== undefined ? `📦Order ID: ${orderId} \n event ID: ${performance_id} \n event Name: ${eventName} \n Category: ${category} \n Section: ${section} \n Quantity: ${quantity} \n Total Amount: ${total_order_amount / 100} ${currency}\n Buyer Name: ${customer_info.name} ${customer_info.surname}\n Buyer Email: ${customer_info.email}` :
        `📦Order ID: ${orderId} \n event ID: ${performance_id} \n event Name: ${eventName} \n Category: ${category} \n Quantity: ${quantity} \n Total Amount: ${total_order_amount / 100} ${currency}\n Buyer Name: ${customer_info.name} ${customer_info.surname}\n Buyer Email: ${customer_info.email}`;
   //     console.log(message);
        await sendTelegramMessage(ordersChatId, message);
        res.send("sandbox good");
    } catch (err) {
        console.error("❌ Webhook fhandling error:", err);
        res.status(500).send("error");
    }
});


app.post("/api/listings", async (req, res) => {
    try {
        const result = await createTicketGroups({
            performance_id: Number(req.body.performance_id),
            external_id: req.body.external_id,
            category: req.body.category,
            section: req.body.section,
            row: req.body.row,
            quantity: Number(req.body.quantity),
            split_type: Number(req.body.split_type),
            in_hand_date: req.body.in_hand_date,
            currency: req.body.currency || "USD",
            face_value: Number(req.body.face_value || 0),
            unit_price: Number(req.body.unit_price)
        });

        res.json({success: true, result});
    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).json({error: "Failed to create listing"});
    }
});

app.get("/api/orders/:id", async (req, res) => {
    try {
        const orderId = Number(req.params.id);
        if (!orderId) {
            return res.status(400).json({ error: "Invalid order ID" });
        }

        const order = await getHelloTicketsOrderById(orderId);
        const events = await getEventsByIdFromFile();

        const event = events.get(order.performance_id);

        const response = {
            [order.performance_id]: {
                performance_id: order.performance_id,
                performance_name: event?.name || "Unknown Event",
                performance_date: event?.start_date?.local_date || "",
                myOrders: [order]
            }
        };

        res.json(response);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch order" });
    }
});

app.post("/api/listings/:id/bot", async (req, res) => {
    const { id } = req.params;
    const { enabled } = req.body; // true / false

    try {
        if (enabled) {
            await enableListing(id);
        } else {
            await disableListing(id);
        }

        res.json({ success: true });
    } catch (err) {
        console.error("Bot toggle error", err);
        res.status(500).json({ error: "Failed to update bot state" });
    }
});

app.get("/api/blacklist", async (req, res) => {
    const set = await getBlacklistSet();
    res.json([...set]); // array of listingIds (strings)
});

app.post("/api/blacklist/disable", async (req, res) => {
    await disableListing(req.body.listingId);
    res.json({ ok: true });
});

app.post("/api/blacklist/enable", async (req, res) => {
    await enableListing(req.body.listingId);
    res.json({ ok: true });
});

// Production webhook
app.post("/hellotickets/prod", async (req, res) => {
    console.log("🟢 Production webhook received:", req.body);
    await sendTelegramMessage(ordersChatId, "prod order");

    res.send("prod ok");
});

// Root
app.get("/", (req, res) => {
    res.send("HelloTickets API local server running!");
});

app.listen(3000, () => console.log("Server running on port 3000"));
await starterFunction()
