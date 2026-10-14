# wolt-mcp — local MCP server for Wolt

This is **[vivaneiona/wolt-mcp](https://github.com/vivaneiona/wolt-mcp)**, a fork of **[erlaufer/wolt-mcp](https://github.com/erlaufer/wolt-mcp)** with stricter basket verification, substitution controls and quantity handling.

Exposes Wolt as MCP tools, so you can tell Claude Desktop, Claude Code, Cursor, or any MCP client:

> "Search my local Wolt for the ingredients in this carbonara recipe and add them to my cart."

Your client's own model does the reasoning — no hosted LLM, no API key here. Nothing is ever ordered: you review and check out on wolt.com.

The client model translates your list into the store's catalog language and checks that each candidate is the intended product. Token similarity alone cannot distinguish a real ingredient from a sauce, snack or other lookalike; promotion-aware product selection is not implemented.

## Install

```sh
git clone https://github.com/vivaneiona/wolt-mcp.git
cd wolt-mcp/mcp
npm ci
node server.mjs install
```

The last command registers this local checkout with Claude Desktop and prints configuration for other clients. For Claude Code, replace the path with the absolute path to your clone:

```sh
claude mcp add wolt-mcp -- node /absolute/path/to/wolt-mcp/mcp/server.mjs
```

Other stdio MCP clients:

```json
{ "command": "node", "args": ["/absolute/path/to/wolt-mcp/mcp/server.mjs"] }
```

The upstream npm package and release bundles do not install this fork.

Requires **Node 22+** (the browser login relies on Node's global `WebSocket`).

See [docs/setup.md](../docs/setup.md) for the full setup guide and tool reference, and [docs/architecture.md](../docs/architecture.md) for how it works internally.

## Connect your account

Ask your AI: **"Connect my Wolt account."** It opens a browser window; log into wolt.com and you're done (`login_via_chrome`). Fallback: paste a Wolt refresh token in chat (`set_wolt_token`).

This needs a **Chromium-based browser** — Chrome, Edge, Brave, Vivaldi, or Chromium — because it works over the Chrome DevTools Protocol; Firefox and Safari users should use the `set_wolt_token` fallback. Chrome is auto-detected; point `CHROME_BIN` at the binary for anything else. The window uses a **separate, empty profile** (`~/.wolt-mcp/chrome-profile`), so you log into Wolt fresh and your everyday profile is never touched.

Tokens are stored locally (`~/.wolt-mcp/tokens.json`, mode 600). Automatic refresh can fail if a session expires or is revoked; `wolt_status` checks the login live. Env vars `WOLT_BEARER_TOKEN` / `WOLT_REFRESH_TOKEN` work as initial seeds; `WOLT_LAT` / `WOLT_LON` seed the search location.

Searching stores needs no login. Account access and basket changes do. `use_saved_address` requires `address_id` when several saved addresses exist. It sets the search and estimate location, **not** the delivery address selected at checkout.

## Tools

**Find things** — `search_products` (groceries), `search_restaurant_dishes`, `search_venues`, `top_venues` (open-now / rating / fee filters), `get_feed`, `find_item` (by name or wolt.com URL).

**Explore a venue** — `get_venue` (details, hours), `get_venue_categories`, `get_venue_menu`, `get_dish_options`.

**Cart** — `plan_cart` (recipe → single-store plan), `add_to_cart` (merge and verify, supports dish options), `get_baskets`, `update_cart_item`, `clear_basket`, `checkout_preview` (estimate incl. fees; never orders).

**Account** — `get_wolt_profile`, `use_saved_address`, `get_order_history`, `get_order`, `get_payment_methods`, `get_favorites`, `add_favorite`, `remove_favorite`, `resolve_address`, `set_location`, `wolt_status`.

## Try it

- *"Is my Wolt set up?"* → `wolt_status`
- *"Add the ingredients for a bolognese to my cart."* → searches per ingredient, picks one store, writes the basket
- *"What's good and open near me?"* → `top_venues`
- *"How much with delivery?"* → `checkout_preview`

## Notes

- Basket writes stop if the initial read fails and report success only after verifying the full result. If a write is unverified or its outcome is unknown, inspect `get_baskets` or wolt.com before retrying; blindly adding again can duplicate quantities.
- New lines default to `allow_substitution: false`; opt in explicitly to allow replacements. Existing settings are preserved.
- `plan_cart` preserves supported counts and weights. `quantityReview` means a package/weight conversion needs review and no ready basket was built. `grams` is total line weight; updating a weighted count requires explicit `grams` and `venue_slug`.
- Exact item IDs/links are resolved directly in partial catalogs. The fork's new behavior is offline-tested; it has not all been verified live.
- Confirm products, promotions, the actual checkout address and final total on wolt.com. Location tools never change the checkout address.
- `checkout_preview` refuses to return a total for weighted baskets; review their price directly on wolt.com.
- Unofficial: built on Wolt's private consumer APIs, which can change without notice. Payment is never automated.
- Credentials are sent only to Wolt. `resolve_address` sends address text to OpenStreetMap's Nominatim geocoder; browsing without a configured location may use ipapi.co for a city-level IP estimate.
- **Automating access may violate Wolt's Terms of Service.** You run this against your own account, at your own risk, and Wolt could restrict or block that account.
- Not affiliated with, endorsed by, or sponsored by Wolt. Wolt is a trademark of Wolt Enterprises Oy.
