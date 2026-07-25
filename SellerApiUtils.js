import axios from "axios";
import {fileToBase64} from "./GenericUtils.js";

const ENV = process.env.HELLOTICKETS_ENV || "production"; // sandbox | production

const HELLOTICKETS_CONFIG = {
    sandbox: {
        baseUrl: "https://sandbox-seller-api.hellotickets.com",
        privateKey: "private-6c8ffa29-88e7-4a14-8792-792b20f7f96c",
        publicKey: "pub-43a8d2d5-b4c6-4429-a49e-c8544babb52b"
    },
    production: {
        baseUrl: "https://seller-api.hellotickets.com",
        privateKey: "private-2edde620-4025-46d7-b14c-348ebce78436",
        publicKey: "pub-661b6a01-e903-4879-93af-21cef8a396a7"
    }
};

const {
    baseUrl,
    privateKey,
    publicKey
} = HELLOTICKETS_CONFIG[ENV];

export async function updateListingPrice(listing, newPrice) {
    try {
        // if (!listing.section) {
        newPrice = Math.floor(newPrice);
        let price = listing.price;
        price.unit_price = newPrice * 100; // convert to cents
        let data = {
            external_id: listing.external_id,
            attributes: listing.attributes,
            in_hand_date: listing.in_hand_date,
            category: listing.category,
            row: listing.row,
            available_quantity: listing.available_quantity,
            split_type: listing.split_type,
            ticket_access_type: listing.ticket_access_type,
            ticket_type: listing.ticket_type,
            listing_owner: listing.listing_owner,
            performance_id: listing.performance_id,
            restricted_locales: listing.restricted_locales,
            has_restricted_view: listing.has_restricted_view,
            price: price, // convert to cents
            seats: listing.seats
        }

        if (listing.section) {
            data.section = listing.section;
        }
        const resp = await axios.put(
            `${baseUrl}/v1/listings/${listing.id}`,
            data,
            {
                headers: {
                    Accept: "application/json",
                    "x-private-key": privateKey,
                }
            });
        //   }
    } catch (err) {
        console.error(`Error updating listing ${listing.id}:`, err.response?.data || err.message);
    }
}

export async function updateOrderInfo(order, type, details) {
    const in_hand_date =
        order.in_hand_date || new Date().toISOString().slice(0, 10);

    const orderId = order.id;

    let section = order.ticket_group.section;
    let row = order.ticket_group.row;

    // your current override
    section = "248";
    row = "6";

    //const seat = order?.ticket_group?.seats?.[0] || "BEST";
    const category = order.ticket_group.category;

    if (!orderId) throw new Error("orderId is required");
    if (!section || !row) throw new Error("section and row are required");

    const tickets = [];

    /* =====================
       E-TICKETS (N PDFs)
       ===================== */
    if (type === "eticket") {
        if (!Array.isArray(details.filePaths) || !details.filePaths.length) {
            throw new Error("filePaths[] required for etickets");
        }

        for (const base64 of details.filePaths) {
            tickets.push({
                section,
                row,
                category,
                eticket: {
                    file: base64
                }
            });
        }
    }

    /* =====================
       TRANSFER (N PROOFS)
       ===================== */
    else if (type === "transfer") {
        if (!details.transferUrl) {
            throw new Error("transferUrl is required for transfer");
        }

        if (!Array.isArray(details.filePaths) || !details.filePaths.length) {
            throw new Error("filePaths[] required for transfer proof");
        }

        for (const base64 of details.filePaths) {
            tickets.push({
                section,
                row,
                category,
                transfer_link: {
                    url: details.transferUrl,
                    proof_of_transfer: {
                        file: base64
                    }
                }
            });
        }
    }

    /* =====================
       MOBILE (N TICKETS)
       ===================== */
    else if (type === "mobile") {
        if (
            !Array.isArray(details.mobileLinksSets) ||
            !details.mobileLinksSets.length
        ) {
            throw new Error("mobileLinksSets[] required for mobile tickets");
        }

        for (const links of details.mobileLinksSets) {
            if (!Array.isArray(links) || !links.length) continue;

            tickets.push({
                section,
                row,
                category,
                mobile_links: links
            });
        }
    } else {
        throw new Error("type must be eticket, transfer, or mobile");
    }

    const payload = {
        in_hand_date,
        tickets
    };

    const url = `${baseUrl}/v1/orders/${orderId}`;

    try {
        const resp = await axios.put(url, payload, {
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "x-private-key": privateKey
            }
        });

        console.log(`✅ Order ${orderId} updated (${tickets.length} tickets)`);
        return resp.data;

    } catch (err) {
        console.error(
            `❌ Failed to update order ${orderId}`,
            err.response?.data || err.message
        );
        throw err;
    }
}


export async function updateOrderStatus(orderId, orderStatus) {
    try {
        const resp = await axios.put(
            `${baseUrl}/v1/orders/${orderId}/status`,
            {status: orderStatus},
            {
                headers: {
                    Accept: "application/json",
                    "x-private-key": privateKey
                },
            }
        );

        console.log(`Order ${orderId} updated to status ${orderStatus}:`, resp.data);
        return resp.data;
    } catch (err) {
        console.error(`Error updating order ${orderId}:`, err.response?.data || err.message);
    }
}

/**
 * @param {(page: number) => void} [onPageLoaded] - optional callback after each page (page number 1-based)
 */
export async function getHelloTicketsOrders(onPageLoaded) {
    console.log("🚀 ORDERS PAGINATION LOADED", new Date().toISOString());

    const perPage = 500;
    let page = 1;
    let allOrders = [];

    while (true) {
        const resp = await axios.get(`${baseUrl}/v1/orders`, {
            params: {
                page,
                per_page: perPage
            },
            headers: {
                Accept: "application/json",
                "x-public-key": publicKey,
            },
        });
        const orders = resp.data?.orders || [];

        if (!orders.length) break;

        allOrders.push(...orders);
        if (typeof onPageLoaded === "function") onPageLoaded(page);
        page++;
    }

    return allOrders;
}

/**
 * @param {(page: number) => void} [onPageLoaded] - optional callback after each page (page number 1-based)
 */
export async function getHelloTicketsListings(onPageLoaded) {
    console.log("🚀 VERSION WITH PAGINATION LOADED", new Date().toISOString());
    const perPage = 500;
    let page = 1;
    let allTicketGroups = [];

    while (true) {
        const resp = await axios.get(`${baseUrl}/v1/listings`, {
            params: {page, per_page: perPage},
            headers: {
                Accept: "application/json",
                "x-public-key": publicKey,
            },
        });

        const groups = resp.data?.ticket_groups || [];
        if (!groups.length) break;

        allTicketGroups.push(...groups);
        if (typeof onPageLoaded === "function") onPageLoaded(page);
        page++;
    }

    return {ticket_groups: allTicketGroups};
}

export async function getHelloTicketsOrderById(orderId) {
    if (!orderId) throw new Error("orderId is required");

    try {
        const resp = await axios.get(
            `${baseUrl}/v1/orders/${orderId}`,
            {
                headers: {
                    Accept: "application/json",
                    "x-public-key": publicKey
                }
            }
        );

        return resp.data;
    } catch (err) {
        console.error(
            `❌ Failed fetching order ${orderId}`,
            err.response?.data || err.message
        );
        throw err;
    }
}

export async function deleteTicketGroupsByPerformance(performanceId) {
    const url = `${baseUrl}/v1/listings?performance_id=${performanceId}`;

    const headers = {
        Accept: "application/json",
        "x-private-key": privateKey
    };

    try {
        const resp = await axios.delete(url, {headers});
        console.log("✅ Deleted all ticket groups for performance:", performanceId);
        console.log("Response:", resp.data || "Success (no body)");
    } catch (err) {
        console.error("❌ Error deleting ticket groups");

        if (err.response) {
            console.error("Status:", err.response.status);
            console.error("Body:", err.response.data);
        } else {
            console.error("Message:", err.message);
        }
    }
}


export async function createTicketGroups({
                                             performance_id,
                                             external_id,
                                             isPairs = false,
                                             category = "Shortside Upper",
                                             section,
                                             row = "BEST",
                                             quantity = 2,
                                             split_type,
                                             in_hand_date,
                                             currency = "USD",
                                             face_value = 200,
                                             unit_price = 300
                                         }) {
    const url = `${baseUrl}/v1/listings`;
    unit_price *= 100; // Convert to dollars
    face_value *= 100; // Convert to dollars
    const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-private-key": privateKey
    };


    let ticketGroup = {
        external_id,
        category,
        row,
        available_quantity: quantity,
        split_type,
        ticket_access_type: 1,
        ticket_type: 3,
        attributes: [],
        restricted_locales: [],
        has_restricted_view: false,
        in_hand_date,
        price: {
            currency,
            face_value,
            unit_price
        }
    }

    if (section) {
        ticketGroup.section = section;
    }

    // const body = { performance_id: 2254201, // REQUIRED — your performanceId here ticket_groups: [ { external_id: "2254", // REQUIRED category: "Shortside Upper Tier", min_age: 0, max_age: 0, ticket_access_type: 1, // 1=event_ticket attributes: [], ticket_type: 3, // 1=mobile, 2=e-ticket, 3=transfer section: "Shortside Upper Tier", row: "5", available_quantity: 2, // REQUIRED split_type: 1, // 1=None, 2=All together, 3=Avoid leaving one, 4=Pairs notes: "string", restricted_locales: [], has_restricted_view: false, // REQUIRED in_hand_date: "2024-12-31", price: { currency: "USD", // REQUIRED face_value: 50, unit_price: 100 }, } ] };

    const body = {
        performance_id,
        ticket_groups: [
            ticketGroup
        ]
    };

    try {
        const resp = await axios.post(url, body, {headers});
        console.log("Created listing:", resp.data);
        return resp.data;
    } catch (err) {
        console.error(
            "❌ Error creating ticket groups:",
            err.response?.data || err.message
        );
        throw err;
    }
}