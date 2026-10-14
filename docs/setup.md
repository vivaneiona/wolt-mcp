# Setup — use Wolt from your AI tool

This guide installs [vivaneiona/wolt-mcp](https://github.com/vivaneiona/wolt-mcp), a fork of [erlaufer/wolt-mcp](https://github.com/erlaufer/wolt-mcp). You review and check out on wolt.com yourself — orders and payments are never automated.

## 1. Install

**Requirements:** Node 22 or newer, npm and Git.

```sh
git clone https://github.com/vivaneiona/wolt-mcp.git
cd wolt-mcp/mcp
npm ci
```

**Claude Desktop:** run `node server.mjs install` from this directory. It registers the local checkout and prints configuration for other clients.

**Claude Code:** replace the example with your clone's absolute path:
```sh
claude mcp add wolt-mcp -- node /absolute/path/to/wolt-mcp/mcp/server.mjs
```

**Any other MCP client** (Cursor, Windsurf, etc.) — stdio server config:
```json
{ "command": "node", "args": ["/absolute/path/to/wolt-mcp/mcp/server.mjs"] }
```

Use the absolute path to the clone you installed. The upstream npm package `wolt-mcp` and upstream release bundles do not contain these fork changes.

## 2. Connect your Wolt account

Just ask your AI: **"Connect my Wolt account."** It will pick the easiest path:

1. **`login_via_chrome`** (zero paste): a browser window opens on wolt.com — log in normally and you're done.
   - Needs a **Chromium-based browser**: Chrome, Edge, Brave, Vivaldi, or plain Chromium. It works over the Chrome DevTools Protocol, so Firefox and Safari can't be used here — use the manual paste below instead.
   - Chrome is found automatically at its standard location on macOS/Windows/Linux. For any other browser (or a non-standard install path), set `CHROME_BIN` to the binary, e.g. `CHROME_BIN="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"`.
   - The window opens with a **separate, empty profile** (`~/.wolt-mcp/chrome-profile`) — not your everyday one. That means you'll log into Wolt fresh, and none of your normal cookies, extensions, or saved passwords are exposed to the server. This is intentional, not a bug.
2. **Manual token fallback:** on a logged-in wolt.com tab, DevTools → Network → find a POST to `authentication.wolt.com/v1/wauth2/access_token` → copy `refresh_token` from the request payload → supply it to `set_wolt_token`.

Tokens are stored locally (`~/.wolt-mcp/tokens.json`, mode 600) and sent only to Wolt. Refresh is attempted automatically, but an expired or revoked session may require login again. Call `wolt_status` before shopping: it checks the account live. `loginVerified: false` with an unknown login state after a network/server failure is not proof that the credentials are invalid.

Searching stores needs no login; reading your account or baskets and changing baskets does.

### Use your existing Chrome session

With **Chrome 144+**, `login_via_existing_chrome` connects to the Wolt account already open in your ordinary Chrome profile:

1. Keep a signed-in `https://wolt.com` tab open.
2. Open `chrome://inspect/#remote-debugging` and enable remote debugging yourself.
3. Ask the client to call `login_via_existing_chrome`, then personally approve Chrome's connection prompt. Allow up to two minutes for this step; set your MCP client's tool timeout to at least 180 seconds.
4. Verify the account with `wolt_status` and `get_wolt_profile`, then select the intended saved address. Chrome chooses the shared profile; with multiple profiles, check that it is the right one.
5. You can disable remote debugging after connecting. MCP keeps its Wolt tokens locally and uses the existing refresh flow.

Chrome's permission grants browser-wide debugging access. This tool requests cookies only for Wolt, closes its WebSocket immediately after reading them, and validates the refresh token before replacing the stored account. It never closes or navigates your tabs, copies a browser profile, or reads a cookie database. The shared Wolt session may still expire or be revoked; reconnect if needed.

The only file read from Chrome is `DevToolsActivePort`, which contains the local connection endpoint. The standard Chrome user-data directory is detected on macOS, Windows and Linux; `WOLT_CHROME_USER_DATA_DIR` overrides it. Set this to the **user-data root**, not its `Default` or `Profile 1` subdirectory. If the OS denies access to that metadata, grant the MCP host application access to Google Chrome in OS privacy settings; the tool does not change permissions itself. If Chrome is too old or you do not want browser-wide debugging access, use the separate-profile `login_via_chrome` instead.

This uses Chrome's [existing-session permission flow](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session), not the legacy `--remote-debugging-port` flag. The latter no longer works with the standard profile in Chrome 136+. No extension or additional npm dependency is needed.

## 3. Set your delivery location

Say **"use my saved Wolt address"**. `use_saved_address` selects a single saved address automatically. With several addresses it returns the choices without selecting one; call again with the requested `address_id`. Alternatively, resolve a spoken address with `resolve_address` and save its coordinates with `set_location`. Searches default to this location. If none is set, browsing may estimate a city from your IP. Basket writes require a saved search location; check that it matches the intended address.

**This does not change Wolt's checkout address.** These tools set only the search location and delivery estimate. Select and verify the actual delivery address on wolt.com before payment.

## 4. Use it

- "Add the ingredients for carbonara to my Wolt cart."
- "Find me 2L of milk and a dozen eggs, cheapest decent store."
- "What's in my Wolt basket?" / "How much will it be with delivery?" (`checkout_preview`)
- "Remove the olives." (`update_cart_item`)

When your basket is ready, the AI gives you the wolt.com link — you review and pay there.

Pin `venue_slug` when you want a particular Carrefour or other store. Review product names and package sizes: the matcher does not understand every product distinction or choose promotions reliably. `quantityReview` means a requested amount could not safely be converted to packages or weight; no ready basket is built until those amounts are resolved.

New lines prohibit substitutions unless you explicitly pass `allow_substitution: true`. `grams` always means the **total weight of the line**. To change a weighted line's quantity with `update_cart_item`, supply its new total `grams` and `venue_slug`; a count change alone is refused.

`checkout_preview` does not return a total for baskets with weighted items because the current preview payload cannot safely represent their weights. Review those baskets and their price on wolt.com.

## Tool reference

| Tool | Auth | What it does |
|---|---|---|
| `search_products` | no | Search grocery products for one ingredient near you |
| `search_restaurant_dishes` | no | Search restaurant food (separate from groceries) |
| `search_venues` | no | Find stores/restaurants by name or cuisine |
| `get_feed` | no | Discovery feed: "Popular", "Order again", … |
| `top_venues` | no | Ranked venues with filters: open now, score, fee, Wolt+ |
| `get_venue` | no | Venue details, rating, opening hours |
| `get_venue_menu` | no | Browse/search a venue's menu (handles huge grocery catalogs) |
| `get_venue_categories` | no | Category tree for browsing a large store |
| `find_item` | no | Resolve by name, ID or wolt.com URL, including partial catalogs |
| `get_dish_options` | no | Sizes/toppings/sides for a dish, with required flags |
| `resolve_address` | no | Geocode a free-form address (OpenStreetMap) |
| `use_saved_address` | yes | Select search/estimate location; multiple addresses require an ID |
| `get_order_history` / `get_order` | yes | Past orders — enables "reorder my usual" |
| `get_favorites` / `add_favorite` / `remove_favorite` | yes | Manage favorite venues |
| `get_payment_methods` | yes | List saved payment methods (read-only) |
| `plan_cart` | no | One-shot: search a list, pick best single store, return a plan |
| `add_to_cart` | yes | Read, merge, write and verify a single-venue basket |
| `get_baskets` | yes | List your baskets and line items |
| `update_cart_item` | yes | Change count, total grams, substitution permission or remove a line |
| `clear_basket` | yes | Delete a basket |
| `checkout_preview` | yes | Estimate incl. fees/delivery — read-only, never orders |
| `login_via_chrome` / `set_wolt_token` | — | Connect your account |
| `login_via_existing_chrome` | Chrome approval | Reuse the signed-in Wolt session in ordinary Chrome 144+ |
| `get_wolt_profile` | yes | Name/email/phone; use `use_saved_address` for addresses |
| `set_location` | no | Save search/estimate coordinates; does not change checkout |
| `wolt_status` | optional | Live login verification and configured search location |

## Troubleshooting

- **"SETUP NEEDED" message** — your token expired and can't refresh; reconnect (step 2).
- **Initial basket read failed** — no write is attempted. Resolve the connection or login issue before trying again.
- **Write accepted, result unverified** — `writeSucceeded: true` with `verified: false` does not prove that the requested basket persisted. Inspect `get_baskets` or wolt.com before making another change; blindly retrying an add can double quantities.
- **Write outcome unknown** — a network error or server failure during mutation returns `writeSucceeded: null`. Wolt may already have applied the change; inspect the live basket before retrying.
- **Products/amounts differ after writing** — inspect the reported dropped/mismatched lines and the whole basket. Success requires full read-back verification, including options and replacement settings.
- **Item added but browser looks stale** — inspect `get_baskets` and reload wolt.com before retrying the write.
- **Search finds nothing** — check `wolt_status` shows the right location; Wolt search is location-scoped.

## Disclaimers

Unofficial project using Wolt's private consumer APIs — not affiliated with or endorsed by Wolt. Endpoints can change without notice. The fork changes are covered by offline tests, not a complete live validation. Confirm the actual address, promotions, weighted amounts and final total at checkout. Personal use; never automates payment.
