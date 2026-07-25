import fs from "fs";
import { google } from "googleapis";
import { getHelloTicketsOrders } from "./SellerApiUtils.js";
import { getEventsByIdFromFile, fixOrdersByPerformanceId } from "./GenericUtils.js";

const USD_TO_GBP = 0.74;
const spreadsheetId = "1HMx_BfcFHwmdrrKtfF69_sL2KgBSML88r7ZF8lL_V3s";
const sheetName = "hello";

/* ───────────── Google Auth ───────────── */

const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(
        fs.readFileSync("sweep-8619b-d74952130c8d.json", "utf-8")
    ),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

/* ───────────── Helpers ───────────── */

async function readSheet() {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A2:A50000`, // Order IDs only
    });

    return res.data.values?.flat().map(String) || [];
}

function buildRowsFromOrdersMap(ordersMap) {
    const allOrders = [];

    // 1️⃣ Flatten all orders into a single array
    for (const perf of ordersMap.values()) {
        const {
            performance_name,
            performance_date,
            myOrders = []
        } = perf;

        for (const order of myOrders) {
            allOrders.push({
                perf,
                order
            });
        }
    }

    // 2️⃣ Sort by order creation date (earliest → latest)
    allOrders.sort((a, b) => {
        return new Date(a.order.created_at) - new Date(b.order.created_at);
    });

    // 3️⃣ Build rows
    const rows = [];

    for (const { perf, order } of allOrders) {
        const quantity = order.tickets_quantity || 0;

        // prices are in cents
        const totalUsd = (order.total_price || 0) / 100;
        const pricePerTicket = quantity ? totalUsd / quantity : 0;
        const totalGbp = totalUsd * USD_TO_GBP;

        const customer = order.customer_info || {};
        const ticketGroup = order.ticket_group || {};

        rows.push([
            order.id,                                           // 0 Order ID
            order.created_at?.slice(0, 10) || "",               // 1 Order Date
            perf.performance_name,                              // 2 Event Name
            perf.performance_date,                              // 3 Event Date
            quantity,                                           // 4 Quantity
            Number(pricePerTicket.toFixed(2)),                  // 5 Price / ticket USD
            Number(totalUsd.toFixed(2)),                        // 6 Total price USD
            USD_TO_GBP,                                         // 7 USD → GBP rate
            "",//Number(totalGbp.toFixed(2)),                        // 8 Total price GBP
            ticketGroup.category || "",                          // 9 Category
            ticketGroup.row || "",                               // 10 Row
            `${customer.user_first_name || ""} ${customer.user_last_name || ""}`.trim(), // 11 Name
            customer.user_phone || "",                           // 12 Phone
            customer.user_email || "",
            "",
            "",
            "",
            "",
            ""// 13 Email
        ]);
    }

    return rows;
}

/* ───────────── Main job ───────────── */

(async () => {
    console.log("⏳ Sync started", new Date().toISOString());

    // 1️⃣ Load events
    const events = await getEventsByIdFromFile();

    // 2️⃣ Load orders
    let orders = await getHelloTicketsOrders();

    // 3️⃣ Filter out rejected
    orders = orders.filter(o => !o.status.toLowerCase().includes("reject"));

    // 4️⃣ Group by performance
    const ordersMap = await fixOrdersByPerformanceId(orders, events);

    // 5️⃣ Read existing order IDs from sheet
    const existingOrderIds = new Set(await readSheet());

    // 6️⃣ Keep only new orders
    for (const perf of ordersMap.values()) {
        perf.myOrders = perf.myOrders.filter(
            o => !existingOrderIds.has(String(o.id))
        );
    }

    // 7️⃣ Build rows
    const rowsToAppend = buildRowsFromOrdersMap(ordersMap);

    if (!rowsToAppend.length) {
        console.log("✅ No new orders to append");
        return;
    }

    // 8️⃣ Append to sheet
   let m= await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
            values: rowsToAppend,
        },
    });

    console.log(`✅ Appended ${rowsToAppend.length} new orders`);
})();
