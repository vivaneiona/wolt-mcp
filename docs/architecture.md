# Architecture

How [vivaneiona/wolt-mcp](https://github.com/vivaneiona/wolt-mcp), a fork of [erlaufer/wolt-mcp](https://github.com/erlaufer/wolt-mcp), talks to Wolt. Endpoint shapes were investigated upstream using live traffic. The fork's added safeguards are covered by offline tests; they have not all been verified live.

## Layout

```
mcp/server.mjs     tool definitions (thin — one try/catch per tool)
mcp/lib/
  http.js          authed fetch: 401 refresh-retry, Retry-After backoff
  auth.js          token store, wauth2 refresh, rotation strategy
  headers.js       the Wolt web-client header set
  wolt.js          search normalization, basket build/merge
  plan.js          single-store planning, quantity checks and review flags
  venue.js         venue detail, menu browsing, option groups, slug cache
  checkout.js      checkout preview payload + category enrichment
  account.js       order history, geocoding
  cdp-login.js     zero-paste browser login over the DevTools Protocol
  config.js        saved location
```

## Requests

Everything goes through `woltFetch`, which attaches the web app's own client headers:

```
platform: Web
client-version: 1.16.79
clientversionnumber: 1.16.79
w-wolt-session-id: no-analytics-consent    # sentinel the web app sends when analytics are declined
x-wolt-web-clientid: <uuid v4, per process>
app-language: en
authorization: Bearer <jwt>                # authed calls only
```

No `Origin`, `Referer`, or User-Agent spoofing is needed — plain server-side HTTP is accepted. Search is unauthenticated; everything account- or basket-related needs the bearer token.

## Auth

Wolt's web session issues a short-lived (~30 min) access JWT plus a refresh token, exchanged at `POST authentication.wolt.com/v1/wauth2/access_token` with `grant_type=refresh_token` — no client_id, no cookies.

Three things are easy to get wrong:

- **The `__wtoken` cookie is not an API token.** It's an opaque session value that Wolt's API rejects as a Bearer. Only `__wrtoken` (the refresh cookie) is useful; the login flow harvests it and immediately exchanges it for a real JWT, which doubles as validation.
- **Cookie values arrive wrapped** — URL-encoded and JSON-quoted (`%22abc%22`), sometimes several layers deep. `unwrapToken()` peels them.
- **Refresh tokens rotate, and your browser shares the chain.** Persisting our rotation over the bootstrap token forks the chain from the browser's copy and produces a session-expired loop; keeping rotations only in memory breaks across short-lived processes. So the user's bootstrap token stays pinned in `refreshToken` and rotations are persisted separately in `rotatedRefreshToken`, tried first with the bootstrap as fallback.

Tokens live in `~/.wolt-mcp/tokens.json`, mode 600.

`wolt_status` verifies the token against the account endpoint. Network/server failures leave login validity unknown rather than reporting a verified login or demanding reconnection. Refresh is automatic while Wolt accepts the tokens; it is not a permanent-session guarantee.

## Baskets

`POST /order-xp/v1/baskets` is a **wholesale replace** keyed by `venue_id`, not an append. Basket changes first read the current contents; a missing location, failed read or malformed response stops the write. Adds merge existing and incoming lines without collapsing distinct option variants. Removing a line posts the remaining set; removing the last line deletes the basket via `POST /baskets/bulk/delete`.

After a write is accepted, the server reads back and compares the full intended basket, including item variants, counts, total weights, options and substitution permissions. A mismatch or failed verification returns `ok: false`, `verified: false`, and `writeSucceeded: true`. That means the write was accepted but the outcome is unverified: inspect the live basket before retrying, because an additive retry can duplicate quantities. Basket changes are serialized per venue within this process; concurrent edits in a browser or another process can still race.

A network error or server failure during a mutation leaves the outcome unknown (`writeSucceeded: null`); the server does not treat it as proof that nothing changed. Inspect the basket before retrying this case too.

**Phantom baskets:** posting a venue *slug* as `venue_id` returns a success-shaped response and bumps the basket count, but the basket never persists. Only 24-hex ObjectIDs are real venue ids, and `add_to_cart` refuses anything else rather than reporting a false success.

New lines default to `allow_substitution: false`; callers opt into store replacements explicitly. Existing line settings are preserved. Weighted grocery items carry `weighted_item_info.purchased_weight_in_grams`: `grams` is the total weight of the line, not weight per count. A weighted count update requires explicit total `grams` and `venue_slug` so the current catalog step can be checked. Weight adjustments are reported.

`plan_cart` preserves explicit whole-package counts and supported gram/kilogram quantities, snapping weight upward to the catalog step. Without a requested quantity, the defaults remain one package or 500 g. It does not infer package sizes or piece weights from names. An unresolved conversion produces `quantityNeedsReview` on the line, `quantityReview` in the response and `basket: null`; the client must resolve quantities before writing.

## Menus and options

Two catalog shapes, distinguished by `loading_strategy` on the assortment payload:

- **`full`** (restaurants, small stores) — every item is in the top-level `items` array.
- **`partial`** (large groceries) — the payload carries a nested category tree and **zero** items. Items come from per-category fetches (`/assortment/categories/slug/{slug}`, leaf categories only) or server-side search (`POST /assortment/items/search`). `get_venue_menu` picks the right strategy automatically; `get_venue_categories` exposes the tree for browsing.

`find_item` resolves an exact ID or item URL through `/assortment/items` rather than assuming the item is in the top-level array. Name lookup in a partial catalog uses server-side search.

Option groups need a join: an item's `options[]` are *bindings* (`{id, option_id, multi_choice_config}`) that reference the assortment's top-level `options[]` *definitions* (`{id, name, values[]}`). The basket write wants the **binding** id as the group id and definition value ids inside it.

`prerequisite_values` gate a group behind a selection in another group — a party-pizza combo can expose 80 groups of which only two apply until you pick a base. Those are surfaced as `conditional: true` with the prerequisite named, and excluded from `required`, so the model asks in a sane order instead of demanding 80 answers.

## Checkout preview

`POST /order-xp/web/v2/pages/checkout` prices a basket without ordering. Each menu item must carry a `category_id`, resolved from the venue assortment, then per-item venue pages, and finally falling back to the item id itself (which Wolt accepts). Response rows nest amounts as `{amount, formatted_amount}`.

This is an estimate for the configured coordinates, not a paid order. `use_saved_address` selects the only saved address automatically; with multiple addresses it requires an explicit `address_id`. That tool and `set_location` only change local search/estimate coordinates. They never change the delivery address selected on wolt.com. The user confirms that address, credits, weighted amounts and final price at checkout.

The preview payload does not safely carry weighted-item amounts. Baskets containing weighted lines are therefore rejected by `checkout_preview` with instructions to check wolt.com; no potentially incorrect total is returned.

## Currency

Every basket write and checkout preview carries an explicit currency, and
search payloads carry a country but not always a currency. `resolveCurrency()`
in `mcp/lib/wolt.js` walks the sources in order of reliability — the caller's
value, the venue record, any search candidate that has one, then a
country → currency table covering Wolt's markets — and returns `null` when none
of them knows. Callers then refuse the write with a message asking for a
currency. Nothing defaults to a particular market's money: a wrong currency is
a silent pricing bug, not a recoverable one.

## Testing

- From `mcp/`, `npm test` runs the offline suite (no live account or network), including mocked basket/account flows, quantity planning, catalog lookup and the release version guard. The following `node test/...` paths are relative to the repository root.
- `node test/replay.test.mjs` (part of `npm test`) — plans a full shopping list against **recorded catalogs** in three markets, with global `fetch` disabled so a pass can't depend on Wolt being up. Covers store racing, in-venue matching, catalog language, currency resolution and basket assembly. Cassettes are recorded by `node test/record-cassette.mjs`; recording refuses any non-catalog endpoint, so a fixture can never contain account, order or auth traffic. Both the recorder and the test drive the same flow (`test/plan-flow.mjs`), so they cannot silently diverge.
- `node test/mcp.live.mjs` — lower-level live check of the lib layer directly (refresh → search → basket write → merge/persist verification → cleanup), bypassing the MCP protocol. Needs real credentials and writes a temporary basket to your account.
- `node mcp/test/tools.live.mjs` — drives every tool through a real stdio MCP client against a live account. Cart tests use a temporary basket and clean up; favorites tests are self-reversing; `set_wolt_token` round-trips the tokens already on disk rather than writing a dummy. A coverage guard compares the tools actually called against `listTools()` and fails the run on any gap, so a newly added tool can't go untested. Only `login_via_chrome` is skipped, being interactive.

- `node mcp/test/boot.test.mjs` (part of `npm test`) — starts the real server over stdio and lists its tools, catching broken tool registration without a live Wolt account.
- `npm run bench` (`node test/bench.mjs`) — scores match quality against the same recorded catalogs and prints the delta against `test/benchmarks/baseline.json` (`--save` adopts a new baseline). It deliberately does not report coverage, which lies: a run can fill every line while putting tomato pesto where tomatoes belong. It counts **correct** lines and **traps** — lines filled with the wrong thing, which is worse than a missing line because the user is told it's handled. Ground truth is per-market accept/reject name patterns, and each market scores against a pinned store so a matching change is measured on a fixed catalog rather than on whichever shop won that minute's race.

- `npm run timing` (`node mcp/test/timing.mjs`) — live latency of the main tools through a real MCP client, no login needed. Current shape: a 5-ingredient `plan_cart` is ~9 s, a 10-ingredient one ~20 s, because a plan costs roughly *stores raced × ingredients* in-venue searches and Wolt answers each in ~1–3 s. Our own rate limiter is a minor term — loosening it from 6 concurrent/80 ms to 12/30 ms moved a 10-line plan by about 12%.

CI (`.github/workflows/test.yml`) runs the offline suite and `node test/bench.mjs --check` on Node 22 and 24 for every push and pull request. The benchmark check fails the build if the overall score drops, if traps rise, or if any wrong pick goes unflagged — improving is free, regressing takes a deliberate `--save` and a committed baseline.

The fork is installed from source as described in [setup.md](setup.md). The upstream npm package and release bundles are not distributions of this fork.

## Known limitations

- Unofficial private APIs: they can change without notice.
- Restaurant menus vary by hour — item ids fetched earlier may be unavailable later.
- Product-name matching remains heuristic and needs semantic review. Product promotions are not used as a reliable selection criterion.
- Package conversions without structured sizing require review. Catalog metadata, availability and weights must be checked before checkout.
- Checkout totals for weighted baskets are only available on wolt.com; the MCP preview refuses those baskets.
- Session renewal can require a fresh login. The fork safeguards are offline-tested, not a guarantee of live behavior in every market.
- Orders, payments and the checkout delivery address are never changed automatically.
