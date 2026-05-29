# Block/section-specific pricing – deploy checklist

For section-specific (block-specific) pricing to work on the server, these pieces must match your local setup.

## 1. Files to transfer (same versions as local)

| File | Why it matters |
|------|----------------|
| **helloBot.js** | Section logic, undercut rules, min-price handling. You already transferred this. |
| **SellerApiUtils.js** | `getHelloTicketsListings()` returns your listings; response is passed through as-is. If an old version mapped or stripped fields, `section` could be missing. |
| **GenericUtils.js** | `fixListingsByPerformanceId()` groups listings; `getListingsFromClientSide()` → `getSiteListings()` fetches competitor tickets. Any change in how listings/tickets are built or merged can affect `section` on both your listings and competitors. |
| **blackListUtils.js** | `getBlacklistSet()` – if the server blacklist includes listing IDs that are section-specific, those will be skipped and “section specific” will look like it’s not working. |
| **consts.js** | Only needed if you **create** new block listings on the server (e.g. CLUB LEVEL TIER blocks B41–B84). Not required for **pricing** existing section listings. |

Optional (no impact on section logic):

- **minimum_price.json** – optional floor; can be empty `{}`.
- **events.json** – used for event names/dates; if missing or wrong, event grouping can break.

## 2. Check that listings have `section` on the server

Section logic depends on:

- **Your listings** (from HelloTickets API): each listing should have a `section` property when it’s block-specific.
- **Competitor tickets** (from public HelloTickets site API): each ticket should have a `section` (or equivalent) so section-matching works.

If `section` is missing in the data, the bot will treat everything as non-section and block-specific pricing will never run.

**Quick check on the server:** Run the bot and look at the logs:

- If you see lines like `[SECTION-DEBUG] listing 422635 section="249" category="..." hasSec=true`, your **myListings** have `section` and the section path is running.
- If you never see `section="..."` in the logs (only `status=OK no suggestedPrice → skip`), then either no listings have `section` on the server, or the server is using different code/data.

To compare: run the bot locally and on the server and grep the first event’s lines, e.g.  
`npm run bot 2>&1 | head -80`  
and check whether the server output has any `section="..."` lines.

## 3. Environment / API

- Same **HelloTickets API keys** (public + private) as local, so listing and order data (and `section`) are the same.
- **Node version** compatible with your project (same major as local avoids surprises).

## 4. Summary

- **Transfer:** `helloBot.js`, `SellerApiUtils.js`, `GenericUtils.js`, `blackListUtils.js`. Optionally `consts.js` if you create block listings on the server.
- **Verify:** Run the short script above on the server and confirm that “My listings with section” is not 0 when you expect block-specific pricing to run.
- If section counts are correct but section-specific still doesn’t run, check that the listing IDs you expect are not in the server’s blacklist (`blackListUtils.js` / blacklist data).
