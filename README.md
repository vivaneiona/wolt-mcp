# wolt-mcp

**[vivaneiona/wolt-mcp](https://github.com/vivaneiona/wolt-mcp) is a fork of [erlaufer/wolt-mcp](https://github.com/erlaufer/wolt-mcp).** It adds stricter basket verification, explicit substitution controls, quantity checks and safer address selection. The original project and license are retained.

**Use Wolt from your favorite AI tool.** An open-source MCP server that lets Claude Desktop, Claude Code, Cursor, or any MCP client search Wolt, plan a grocery cart from a recipe, browse restaurant menus, and fill your Wolt basket — you review and check out on wolt.com yourself. **Nothing is ever ordered or paid automatically.**

> "Add the ingredients for carbonara to my cart" · "Order my usual from that burger place" · "What's good and open near me right now?" · "How much will my basket cost with delivery?"

![Upstream demo: planning groceries and previewing checkout](docs/wolt-mcp-demo.gif)

## Install

Requires Node 22+. Install this fork from source:

```sh
git clone https://github.com/vivaneiona/wolt-mcp.git
cd wolt-mcp/mcp
npm ci
```

**Claude Desktop** — run `node server.mjs install` from that directory to register this checkout. It also prints configuration for other clients.

**Any MCP client** — configure a stdio server, replacing the example path with the absolute path to your clone:

```json
{ "command": "node", "args": ["/absolute/path/to/wolt-mcp/mcp/server.mjs"] }
```

For Claude Code: `claude mcp add wolt-mcp -- node /absolute/path/to/wolt-mcp/mcp/server.mjs`. The npm package `wolt-mcp` and upstream release bundles do not install this fork.

Then in chat: *"Connect my Wolt account"* → sign in to the separate browser profile → *"use my saved Wolt address"* → choose the requested address if several exist. Login needs a Chromium-based browser; Firefox/Safari users can supply a token instead. Search location does **not** change the address selected at Wolt checkout.

Full walkthrough in [docs/setup.md](docs/setup.md); internals in [docs/architecture.md](docs/architecture.md).

## What it does

29 tools across:

- **Find** — grocery products, restaurant dishes, venues, a filtered "what's good and open near me" ranking, the discovery feed, and item lookup by name or wolt.com URL.
- **Browse** — venue details and opening hours, category trees, full menus (including large grocery catalogs), and dish option groups with required/conditional choices.
- **Cart** — recipe → single-store plan, basket writes verified by re-reading the full contents, line editing, and a checkout estimate including delivery and fees.
- **Account** — saved addresses, order history (so "order my usual" works), favorites, payment methods, geocoding.

## How it works

Wolt's own web-client APIs: search is unauthenticated; account actions use your Wolt tokens. Refresh is attempted automatically, but expired or revoked sessions can require login again. Tokens are stored locally (`~/.wolt-mcp/tokens.json`, mode 600).

The fork changes basket handling as follows:

- A failed initial basket read stops the write. After a write, success requires matching the full basket, including quantities, weights, options and substitution settings. Inspect any unverified or uncertain write with `get_baskets` or on wolt.com before retrying; adding again can duplicate quantities.
- Store substitutions default to **off** for new lines; opt in with `allow_substitution: true`. Re-adding the same item keeps the stricter replacement setting; use `update_cart_item` to change it explicitly.
- Explicit counts and gram/kilogram weights survive planning. If package conversion is unknown, `quantityReview` explains what needs review and no ready basket is returned. `grams` means the total weight of the line; changing a weighted line's count requires explicit total `grams` and `venue_slug`.
- Exact item IDs/links work with large partial catalogs. `wolt_status` checks the account live; multiple saved addresses require an explicit choice.

These fork changes are covered by offline tests. They have not all been verified against a live Wolt account; the demo above comes from upstream.

## Status & disclaimers

**Unofficial**, built on private consumer APIs that can change without notice. Product matching still requires semantic review: a similar name is not proof of the right product, and the planner does not optimize for promotions. Confirm the actual delivery address, products, weighted amounts and final total on wolt.com. Orders and payments are never automated. MIT license.

`checkout_preview` cannot safely price baskets containing weighted items and directs you to wolt.com instead of returning a total.

**Automating access may violate Wolt's Terms of Service.** You run this against your own account, at your own risk, and Wolt could restrict or block that account. This project never places or pays for an order, and backs off when Wolt asks it to — but that is a design choice, not permission.

Your credentials are sent only to Wolt. `resolve_address` sends the requested address text to OpenStreetMap's Nominatim service. If no location is configured, browsing may use ipapi.co for a city-level IP estimate; set a saved address to avoid that fallback.

Not affiliated with, endorsed by, or sponsored by Wolt. Wolt is a trademark of Wolt Enterprises Oy.
