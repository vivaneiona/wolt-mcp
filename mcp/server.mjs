#!/usr/bin/env node
// Local MCP server for Wolt.
//
// Design: the MCP *client's* model does the reasoning — read the recipe, pick
// the product, choose the venue — so there's no hosted LLM and no API key here.
// This server exposes the Wolt primitives: search, browse menus, read and write
// baskets, preview checkout. Ordering and payment always happen on wolt.com.
//
// Auth: search needs none. Account and basket calls need a token — connect once
// via login_via_chrome (or set_wolt_token); it auto-renews after that.
// See docs/architecture.md for how the API layer works.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  searchItems, selectBestVenue, rankVenues, buildBasketBody, reconcileWeightedItems, resolveCurrency, BASKET_URL,
  BASKETS_PAGE_URL, BASKETS_DELETE_URL, isVenueObjectId, findBasketForVenue, mergeBasketItems, basketItemKey, upsertItemFromLine
} from "./lib/wolt.js";
import { woltFetch } from "./lib/http.js";
import { rankCandidates } from "./lib/match.js";
import { parseIngredientLine } from "./lib/recipe.js";
import { setTokens, describeTokens, getAccessToken } from "./lib/auth.js";
import { getLocation, setLocation, estimateLocation } from "./lib/config.js";
import { checkoutPreview } from "./lib/checkout.js";
import { cdpLogin } from "./lib/cdp-login.js";
import { existingChromeLogin } from "./lib/existing-chrome.js";
import { getVenue, getMenu, getItemOptions, getCategories, resolveItem, parseItemUrl, searchVenueItems, getCatalogLanguage, getMarketLanguage, getWeightConfigs } from "./lib/venue.js";
import { getOrderHistory, getOrder, geocodeAddress } from "./lib/account.js";
import { langOf, sameScript, isNonLatinLang } from "./lib/lang.js";
import { planAtVenue, planResponse, translationPreflight, rankPlans, mapPool, quantityForItem } from "./lib/plan.js";

// catalogLanguage (+ a hint for non-Latin markets) for tool responses that
// establish or report the user's location — so the model knows to translate
// its queries BEFORE the first plan_cart. Best-effort: never throws, {} on
// unknown, and cached per ~11km bucket so repeat calls are free.
async function marketLanguageFields(lat, lon) {
  const language = await getMarketLanguage({ lat, lon });
  if (!language) return {};
  return {
    catalogLanguage: language,
    ...(isNonLatinLang(language)
      ? { languageHint: `Write product queries and plan_cart ingredient lines in '${language}' (translate them yourself).` }
      : {})
  };
}

// Resolve coordinates for a tool call: explicit args win, then the saved/env
// location, then a one-shot city-level IP estimate. Throws an actionable error
// when nothing is available so the model asks the user instead of guessing.
async function needLocation(lat, lon) {
  if (lat != null && lon != null) return { lat, lon };
  const loc = getLocation() || await estimateLocation();
  if (!loc) throw new Error("No delivery location is set and IP detection failed. Ask the user for their address and call set_location, or call use_saved_address to use their saved Wolt addresses.");
  return { lat: lat ?? loc.lat, lon: lon ?? loc.lon };
}

async function getBasketsPage(lat, lon) {
  const r = await woltFetch(`${BASKETS_PAGE_URL}?lat=${lat}&lon=${lon}`);
  if (!r.ok) throw new Error(`baskets fetch failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  if (!Array.isArray(r.json?.baskets) || r.json.baskets.some((b) => !b?.venue?.id || !Array.isArray(b.items))) {
    throw new Error("Invalid baskets response — cannot safely read or replace the current basket.");
  }
  return r.json;
}

// Serialize this process's read/replace operations so parallel tools cannot lose lines.
const basketWrites = new Map();
async function withBasketLock(venueId, write) {
  const task = (basketWrites.get(venueId) || Promise.resolve()).catch(() => {}).then(write);
  basketWrites.set(venueId, task);
  try { return await task; }
  finally { if (basketWrites.get(venueId) === task) basketWrites.delete(venueId); }
}

async function verifyBasketWrite(venueId, expected, loc) {
  const retryNote = "The write was accepted. Inspect get_baskets or wolt.com before retrying: another add would increase quantities.";
  try {
    const after = findBasketForVenue(await getBasketsPage(loc.lat, loc.lon), venueId);
    const actual = after?.items || [];
    const remaining = [...actual];
    const mismatchedLines = [];
    const droppedLines = [];
    for (const wanted of expected) {
      const index = remaining.findIndex((line) => basketItemKey(line) === basketItemKey(wanted));
      if (index < 0) { droppedLines.push(wanted.name || wanted.id); continue; }
      const [line] = remaining.splice(index, 1);
      if (line.count !== wanted.count
        || (line.weighted_item_info?.purchased_weight_in_grams ?? null) !== (wanted.weighted_item_info?.purchased_weight_in_grams ?? null)
        || (line.weighted_item_info?.count ?? null) !== (wanted.weighted_item_info?.count ?? null)
        || !!line.substitution_settings?.is_allowed !== !!wanted.substitution_settings?.is_allowed) {
        mismatchedLines.push(wanted.name || wanted.id);
      }
    }
    const verified = !droppedLines.length && !mismatchedLines.length && !remaining.length;
    return {
      ok: verified, verified, writeSucceeded: true, linesInBasket: actual.length,
      ...(droppedLines.length ? { droppedLines } : {}),
      ...(mismatchedLines.length ? { mismatchedLines } : {}),
      ...(remaining.length ? { unexpectedLines: remaining.map((line) => line.name || line.id) } : {}),
      ...(!verified ? { verificationError: "Basket contents differ from the requested items, quantities, weights, options or substitutions.", retryNote } : {})
    };
  } catch (e) {
    return { ok: false, verified: false, writeSucceeded: true, verificationError: e.message, retryNote };
  }
}

async function mutateBasket(url, body) {
  try {
    const response = await woltFetch(url, { method: "POST", body });
    if (response.ok) return { response };
    if (response.status < 500) return { error: errText(`Basket mutation rejected: HTTP ${response.status} ${response.text.slice(0, 200)}`) };
    throw new Error(`HTTP ${response.status}`);
  } catch (e) {
    // A timeout or server error can arrive after Wolt committed the replacement.
    return { error: { ...text({
      ok: false, verified: false, writeSucceeded: null, writeError: e.message,
      retryNote: "The write outcome is unknown. Inspect get_baskets or wolt.com before retrying; another add could duplicate quantities."
    }), isError: true } };
  }
}

// `node server.mjs install` registers this checkout in Claude
// Desktop's config (and prints the JSON for any other MCP client), then exits.
if (process.argv[2] === "install") {
  const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const entry = { command: process.execPath, args: [fileURLToPath(import.meta.url)] };
  const cfgPath = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : process.platform === "win32"
      ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      : join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  try {
    // Read first, and treat "file missing" and "file unparseable" differently.
    // Missing is fine (fresh install). Unparseable is NOT: these configs are
    // hand-edited, and silently replacing one with {} would delete every other
    // MCP server the user has registered.
    let existingRaw = null;
    try { existingRaw = readFileSync(cfgPath, "utf8"); } catch (e) { /* no config yet */ }

    let cfg = {};
    let bakPath = null;
    if (existingRaw && existingRaw.trim()) {
      try { cfg = JSON.parse(existingRaw); } catch (e) {
        console.log(`✗ ${cfgPath}\n  exists but isn't valid JSON (${e.message}).`);
        console.log(`  Refusing to rewrite it — that would delete your other MCP servers.`);
        console.log(`  Fix the file (a trailing comma is the usual culprit) and re-run, or add this by hand:`);
        console.log(`    "wolt-mcp": ${JSON.stringify(entry)}`);
        process.exit(1);
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        console.log(`✗ ${cfgPath} is valid JSON but not an object — leaving it alone.`);
        console.log(`  Add this by hand:  "wolt-mcp": ${JSON.stringify(entry)}`);
        process.exit(1);
      }
      // Same check for the one member we actually mutate: spreading a string or
      // an array below would turn it into {"0": ...} and break the whole file.
      if (cfg.mcpServers != null && (typeof cfg.mcpServers !== "object" || Array.isArray(cfg.mcpServers))) {
        console.log(`✗ ${cfgPath} has an "mcpServers" that isn't an object — leaving it alone.`);
        console.log(`  Fix that key and re-run, or add this by hand:  "wolt-mcp": ${JSON.stringify(entry)}`);
        process.exit(1);
      }
      // Keep a copy of whatever was there before we touch it — without ever
      // overwriting an existing backup, which may be the pristine copy from an
      // earlier install run or one the user made themselves. A backup whose
      // contents already match is reused rather than duplicated.
      bakPath = `${cfgPath}.bak`;
      for (let i = 1; i <= 20 && existsSync(bakPath) && readFileSync(bakPath, "utf8") !== existingRaw; i++) {
        bakPath = `${cfgPath}.bak.${i}`;
      }
      if (!existsSync(bakPath)) writeFileSync(bakPath, existingRaw);
      else if (readFileSync(bakPath, "utf8") !== existingRaw) bakPath = null; // all taken — clobber none
    }

    cfg.mcpServers = { ...cfg.mcpServers, "wolt-mcp": entry };
    mkdirSync(join(cfgPath, ".."), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const kept = Object.keys(cfg.mcpServers).filter((k) => k !== "wolt-mcp");
    console.log(`✓ Added wolt-mcp to Claude Desktop (${cfgPath}).`);
    if (kept.length) console.log(`  Left your other servers untouched: ${kept.join(", ")}${bakPath ? ` (backup: ${bakPath})` : ""}`);
    console.log(`  Restart Claude Desktop, then say: "Connect my Wolt account."`);
  } catch (e) {
    console.log(`Could not write Claude Desktop config (${e.message}).`);
  }
  console.log(`\nFor any other MCP client, add:\n  "wolt-mcp": ${JSON.stringify(entry)}`);
  process.exit(0);
}

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const errText = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

// Version comes from package.json so a release bump can't leave the server
// reporting a stale one (test/version.test.mjs keeps manifest.json in step).
const { version: VERSION } = createRequire(import.meta.url)("./package.json");
export const server = new McpServer({ name: "wolt-mcp", version: VERSION }, {
  instructions: "When the user wants to BUY something (not just browse), call wolt_status FIRST — it live-verifies the Wolt login. If it reports loginNeeded, sort the login out with the user (login_via_chrome, or set_wolt_token on Firefox/Safari) before searching and planning, so the work isn't lost to an expired session mid-checkout. Searching and browsing venues never need a login. For the delivery address: use_saved_address pulls the user's saved Wolt addresses and sets one as the search location (get_wolt_profile does NOT have addresses); a spoken address goes through resolve_address + set_location. Baskets are single-venue: source every item from one store. The fast path for a shopping list is wolt_status -> use_saved_address (if no location) -> ONE plan_cart call (it auto-picks the store and reports runner-up coverage) -> review the matches -> add_to_cart -> checkout_preview. wolt_status and the address tools report the market's catalogLanguage — translate the ingredient list into it BEFORE calling plan_cart (Greek in Greece, Japanese in Japan, Hebrew in Israel, Georgian in Georgia, and so on), and write each product in dictionary form (singular nominative, like a shelf label) since catalog search matches prefixes and inflected words find little or nothing; plan_cart refuses off-language lists with needsTranslation. Don't compare stores manually with repeated searches unless the user asks, and never write a lowCoverage plan without agreeing with the user first."
});

// --- search_products: one ingredient -> candidate products (no auth) ---
server.tool(
  "search_products",
  "Search Wolt grocery products for a single ingredient. Default: searches ALL nearby stores. With venue_slug: searches ONE store's own catalog (needs login; query in the store's language) — use this to check or fix a single item at the store you're building the basket at. For a whole recipe or shopping list, prefer plan_cart — it resolves every ingredient in one call. A basket must be all from ONE venueId. MATCHING RULES when picking: (1) Match the ingredient ITSELF — never a plant-based, vegan, imitation, or flavored substitute unless the user explicitly asked. e.g. 'Redefine Meat'/'plant-based mince' is NOT ground beef; margarine is NOT butter; imitation crab is NOT crab. (2) Do NOT just pick the cheapest — Wolt surfaces cheap 'Substitute Deals' that are often imitation products; prefer the real, mainstream item at a sensible package size. (3) Match the right FORM (crushed tomatoes ≠ tomato paste; ground beef ≠ beef sausage). When unsure, prefer the plainest real version of the actual ingredient.",
  {
    query: z.string().describe("Product search term, e.g. 'crushed tomatoes' — with venue_slug set, write it in the store's catalogLanguage (returned by get_venue/plan_cart/this tool), in dictionary form (singular nominative, as a shelf label reads): catalog search matches prefixes, so an inflected word finds little or nothing"),
    venue_slug: z.string().optional().describe("Search only this store's catalog (the venue you're building the basket at)"),
    lat: z.number().optional().describe("Override latitude; defaults to the saved location"),
    lon: z.number().optional().describe("Override longitude; defaults to the saved location")
  },
  async ({ query, venue_slug, lat, lon }) => {
    if (venue_slug) {
      try {
        const [venue, catalogLanguage, hits] = await Promise.all([
          getVenue(venue_slug),
          getCatalogLanguage(venue_slug),
          searchVenueItems(venue_slug, query, { lang: langOf(query) })
        ]);
        return text({
          query, venue: { venueId: venue.venueId, slug: venue_slug, name: venue.name, currency: venue.currency, catalogLanguage },
          count: hits.length,
          items: hits.slice(0, 15).map((c) => ({ itemId: c.itemId, name: c.name, price: c.price, ...(c.isWeighted ? { isWeighted: true, sellByWeight: c.sellByWeight } : {}) })),
          ...(catalogLanguage && isNonLatinLang(catalogLanguage) && !sameScript(query, catalogLanguage)
            ? { languageNote: `This catalog is indexed in '${catalogLanguage}' and the query isn't — results may be poor or wrong-form. Translate the query to ${catalogLanguage} and retry for better matches.` }
            : {})
        });
      } catch (e) { return errText(e.message); }
    }
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      // Header follows the query's script so result names come back in the
      // query's language instead of machine-translated (relevance is driven by
      // the query text itself; the header only controls display names).
      const items = await searchItems(query, { lat, lon, lang: langOf(query) });
      // Venue metadata goes once into `venues`, not on all 20 items — these
      // responses are read by a model every turn, and the repetition was
      // roughly half the payload.
      const venues = {};
      const top = items.slice(0, 20).map((c) => {
        venues[c.venueId] ||= { name: c.venueName, slug: c.venueSlug, rating: c.venueRating, citySlug: c.citySlug, country: c.country };
        return {
          itemId: c.itemId, name: c.name, price: c.price, currency: c.currency,
          venueId: c.venueId, isWeighted: c.isWeighted, unitSize: c.unitSizeText
        };
      });
      return text({ query, count: top.length, items: top, venues });
    } catch (e) {
      return errText(`search failed: ${e.message}`);
    }
  }
);

// --- search_restaurant_dishes: restaurant food, separate from groceries ---
server.tool(
  "search_restaurant_dishes",
  "Search RESTAURANT dishes (prepared food) near a location — separate from search_products, which is groceries only. Returns dishes with itemId, price, venueId/venueName. A basket is per-venue: don't mix dishes with grocery items. For dishes that likely have choices (burgers, pizzas, combos), call get_dish_options first and pass the user's selections to add_to_cart.",
  {
    query: z.string().describe("Dish or cuisine search term, e.g. 'pad thai'"),
    lat: z.number().optional().describe("Override latitude; defaults to the saved location"),
    lon: z.number().optional().describe("Override longitude; defaults to the saved location")
  },
  async ({ query, lat, lon }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const items = await searchItems(query, { lat, lon, lang: langOf(query), mode: "restaurant" });
      const venues = {};
      const top = items.slice(0, 20).map((c) => {
        venues[c.venueId] ||= { name: c.venueName, slug: c.venueSlug, rating: c.venueRating, citySlug: c.citySlug, country: c.country };
        return { itemId: c.itemId, name: c.name, price: c.price, currency: c.currency, venueId: c.venueId };
      });
      return text({ query, count: top.length, dishes: top, venues });
    } catch (e) {
      return errText(`restaurant search failed: ${e.message}`);
    }
  }
);

// --- use_saved_address: pull the delivery address from the Wolt account ---
server.tool(
  "use_saved_address",
  "Fetch saved Wolt addresses and set the search/estimate location only. This does NOT change the delivery address selected at checkout on wolt.com. With multiple addresses, pass address_id explicitly; without it the tool lists choices. A single saved address is selected automatically.",
  { address_id: z.string().optional().describe("Address id from a previous call, to pick a specific one") },
  async ({ address_id }) => {
    try {
      const r = await woltFetch("https://restaurant-api.wolt.com/v2/delivery/info");
      if (!r.ok) return errText(`address fetch failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      const rows = r.json?.results || r.json?.addresses || [];
      // Live-verified shape: coordinates are GeoJSON [lon, lat] under
      // location.user_coordinates (user's pin) or google_place_coordinates.
      const addresses = rows.map((row) => {
        const coords = row.location?.user_coordinates?.coordinates
          || row.location?.google_place_coordinates?.coordinates || null;
        return {
          id: String(row.id || row.address_id || ""),
          alias: row.alias || null,
          labelType: row.label_type || null, // "home" / "work" / "other"
          address: [row.location?.address, row.location?.city].filter(Boolean).join(", ") || null,
          lat: coords ? coords[1] : null,
          lon: coords ? coords[0] : null
        };
      }).filter((a) => a.lat != null && a.lon != null);
      if (!addresses.length) return errText("No saved addresses with coordinates on this Wolt account. Ask the user for their address and use set_location.");
      // The payload has no reliable indication of the address selected on the website.
      const pick = address_id
        ? addresses.find((a) => a.id === address_id)
        : addresses.length === 1 ? addresses[0] : null;
      if (address_id && !pick) return errText(`Saved address ${address_id} was not found; nothing changed.`);
      if (!pick) return text({ addresses, checkoutAddressUnchanged: true, note: "Choose the requested address and call again with address_id. The checkout address on wolt.com is unchanged." });
      const saved = setLocation({ lat: pick.lat, lon: pick.lon, label: pick.alias ? `${pick.alias} — ${pick.address}` : pick.address });
      return text({ saved, pickedAddressId: pick.id, addresses, checkoutAddressUnchanged: true, note: "Search location saved. Confirm the delivery address separately at checkout on wolt.com.", ...(await marketLanguageFields(pick.lat, pick.lon)) });
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- plan_cart: whole list -> single-store plan, one call ---
server.tool(
  "plan_cart",
  "Resolve a whole ingredient list into a single-store cart in ONE call. Without venue_slug it auto-picks: shortlists the best-covering nearby stores and races the list against each store's own catalog, returning the winner plus per-store coverage of the runners-up (evaluatedVenues) — if lowCoverage is flagged, agree with the user before writing anything. With venue_slug it plans against that store only. Write ingredient lines in the market's catalog language (reported by wolt_status/set_location/use_saved_address as catalogLanguage — translate them yourself), and name each product in DICTIONARY form — singular nominative, the way a shelf label reads — because catalog search matches prefixes: an inflected line like '2 sipulia' finds a fraction of what '2 sipuli' finds, and in the worst case nothing. If most lines are in the wrong script it returns needsTranslation instead of planning — translate and call again. A rateLimited response means Wolt throttled the burst: wait ~30s and retry, don't rephrase. Returns line items with alternatives and quantities. If quantityReview is present, resolve package counts or grams before writing; no ready basket is returned. Each line carries a confidence: 'low' ones are listed again under verifyBeforeWriting with the reason — read those names yourself and judge by meaning (a sauce, pesto, snack or flavoured version scores just as well as the real product), swapping in an alternative or dropping the line before you write anything.",
  {
    ingredients: z.array(z.string()).describe("Ingredient lines, e.g. ['800 g crushed tomatoes', '1 onion'] — in the store's catalogLanguage (translate them yourself; the plan response reports it), and each product named in DICTIONARY form: singular nominative, as a shop shelf labels it, not as a recipe inflects it ('2 sipuli' not '2 sipulia', '400 g tomaattimurska' not 'tomaattimurskaa')"),
    venue_slug: z.string().optional().describe("Pin planning to this store instead of auto-picking"),
    lat: z.number().optional().describe("Override latitude; defaults to the saved location"),
    lon: z.number().optional().describe("Override longitude; defaults to the saved location")
  },
  async ({ ingredients, venue_slug, lat, lon }) => {
    try {
      if (venue_slug) {
        // Preflight: refuse to burn a whole planning round on off-script lines.
        const early = translationPreflight(ingredients, await getCatalogLanguage(venue_slug));
        if (early) return text(early);
        return text(planResponse(await planAtVenue(venue_slug, ingredients), ingredients.length));
      }
      ({ lat, lon } = await needLocation(lat, lon));
      const early = translationPreflight(ingredients, await getMarketLanguage({ lat, lon }));
      if (early) return text(early);
      const perIngredient = await mapPool(ingredients, 6, async (raw) => {
        const q = parseIngredientLine(raw).name;
        let candidates = [];
        try { candidates = await searchItems(q, { lat, lon, lang: langOf(q) }); } catch (e) {}
        return { ingredient: raw, spec: { query: q }, candidates: rankCandidates(q, candidates) };
      });
      // In-venue planning is tokenless — every user gets the full store race.
      // Top 3 by global coverage: the winner is overwhelmingly in there, and 5
      // venues' searches were half of the burst that got us rate-limited.
      const shortlist = rankVenues(perIngredient).slice(0, 3).filter((r) => r.venue.venueSlug);
      if (shortlist.length) {
        const plans = (await mapPool(shortlist, 3, async (r) => {
          try { return await planAtVenue(r.venue.venueSlug, ingredients); } catch (e) { return null; }
        })).filter(Boolean);
        if (plans.length) {
          // Coverage always beats price, and a half-degraded plan can't win —
          // its coverage number is a lie, not a store comparison.
          const { best, allDegraded } = rankPlans(plans, ingredients.length);
          if (allDegraded) {
            return text({ rateLimited: true, note: "Wolt rate-limited the planning burst. Wait ~30 seconds and call plan_cart again, or pin one store with venue_slug." });
          }
          return text({
            ...planResponse(best, ingredients.length),
            evaluatedVenues: plans.map((p) => ({
              name: p.venue.name, slug: p.venue.slug, coverage: `${p.coverageCount}/${ingredients.length}`,
              ...(p.searchErrors ? { searchErrors: p.searchErrors } : {})
            }))
          });
        }
      }
      const { venue, chosen, missing } = selectBestVenue(perIngredient);
      if (!venue) return text({ venue: null, missing, note: "No store covered these ingredients." });
      const currency = resolveCurrency({ candidates: chosen.map((c) => c.candidate), country: venue.country });
      const selections = chosen.map((c) => ({ candidate: c.candidate, ...quantityForItem(c.ingredient, c.candidate) }));
      const lineItems = chosen.map((c) => ({ ingredient: c.ingredient, name: c.candidate.name, itemId: c.candidate.itemId, price: c.candidate.price, isWeighted: c.candidate.isWeighted, ...quantityForItem(c.ingredient, c.candidate) }));
      const quantityReview = lineItems.filter((li) => li.quantityNeedsReview);
      return text({
        venue,
        coverage: `${chosen.length}/${ingredients.length}`,
        lineItems,
        missing,
        basket: currency && !quantityReview.length ? buildBasketBody(selections, venue.venueId, currency) : null,
        ...(quantityReview.length ? { quantityReview, basketNote: "Confirm package counts or grams for these lines before add_to_cart; no basket was built." }
          : currency ? {} : { basketNote: "No currency on record for this venue — call add_to_cart with an explicit currency taken from search_products results." })
      });
    } catch (e) {
      return errText(`plan failed: ${e.message}`);
    }
  }
);

// --- add_to_cart: write the basket (needs WOLT_BEARER_TOKEN) ---
server.tool(
  "add_to_cart",
  "Write items to the user's Wolt basket for one venue. All items must share the venue_id. Needs login (if wolt_status says loginNeeded, do that first). ALWAYS pass venue_slug: it lets each line's weighted flag be reconciled against how the catalog actually sells the item — items named '~900 g pack' are often COUNT items, truly weighted items only accept multiples of their gramsPerStep, and either mismatch is silently dropped by Wolt. Corrections made are reported as `adjustments`. A saved search location and a readable existing basket are required. New items disallow store substitutions unless allow_substitution is true. After writing, the entire basket is verified, including counts, grams and options. If verified is false or the write outcome is unknown, inspect get_baskets or wolt.com before retrying; repeated adds increase quantities. Returns a checkoutUrl — give it to the user, and call checkout_preview for an estimate including fees when there are no weighted items. Nothing is ever ordered automatically; the user reviews and pays on wolt.com.",
  {
    venue_id: z.string(),
    venue_slug: z.string().optional().describe("Venue slug — in search_products results it is venues[venueId].slug, not a field on the item"),
    city_slug: z.string().optional().describe("City slug — venues[venueId].citySlug in search_products results"),
    country: z.string().optional().describe("3-letter country — venues[venueId].country in search_products results, e.g. 'fin', 'deu', 'jpn'"),
    currency: z.string().optional().describe("Currency, taken from the item you picked (e.g. 'EUR', 'SEK', 'PLN'); resolved from the venue if omitted"),
    items: z.array(z.object({
      id: z.string(),
      name: z.string(),
      price: z.number().int().nonnegative().describe("price in minor units"),
      count: z.number().int().positive().default(1),
      weighted: z.boolean().default(false),
      grams: z.number().positive().nullable().default(null).describe("Total grams to buy for by-weight items"),
      allow_substitution: z.boolean().default(false).describe("Allow the store to replace this product; defaults to false"),
      options: z.array(z.object({
        id: z.string().describe("groupId from get_dish_options"),
        values: z.array(z.object({
          id: z.string().describe("valueId from get_dish_options"),
          count: z.number().int().default(1),
          price: z.number().default(0)
        }))
      })).optional().describe("Dish option selections; required-option dishes need these")
    })).min(1)
  },
  async ({ venue_id, venue_slug, city_slug, country, currency, items }) => withBasketLock(venue_id, async () => {
    // A slug posted as venue_id yields a success-shaped response but a basket
    // that never persists (phantom basket). Refuse early rather than lie.
    if (!isVenueObjectId(venue_id)) {
      return errText(`venue_id "${venue_id}" is not a Wolt venue id (24 hex chars). Use the venueId field from search_products — not the venue slug — or the item was NOT added.`);
    }
    try {
      const loc = getLocation();
      if (!loc) return errText("Set a search location with use_saved_address or set_location before changing a basket; nothing was written.");
      const existing = findBasketForVenue(await getBasketsPage(loc.lat, loc.lon), venue_id);
      // Resolve currency/country from the venue when not supplied, then from
      // the venue's market — never from a hardcoded default, which would price
      // one market's basket in another's money.
      let venueInfo = null;
      if (venue_slug && (!currency || !country)) {
        try { venueInfo = await getVenue(venue_slug); } catch (e) {}
      }
      country = country || venueInfo?.country?.toLowerCase() || null;
      currency = resolveCurrency({ currency, venue: venueInfo, country });
      if (!currency) {
        return errText(`can't tell which currency this venue prices in, so nothing was written. Pass currency (the value from the search_products results, e.g. 'EUR') — and venue_slug, if you have it — and call add_to_cart again.`);
      }
      // The caller's weighted flag is a guess (names like "~900 g pack" read
      // as weighted but are count items, and vice versa). Reconcile every
      // line against how the catalog actually sells it, and snap weighted
      // grams onto the item's step — either kind of mismatch is a line Wolt
      // accepts and then silently repairs or removes.
      const adjustments = venue_slug
        ? reconcileWeightedItems(items, await getWeightConfigs(venue_slug, items.map((it) => it.id)))
        : [];
      let body = buildBasketBody(
        items.map((it) => ({ candidate: { itemId: it.id, name: it.name, price: it.price, isWeighted: it.weighted }, count: it.count, grams: it.grams || undefined, options: it.options, allowSubstitution: it.allow_substitution })),
        venue_id, currency
      );
      // POST /baskets replaces the venue's basket wholesale — merge with any
      // existing lines first so we never clobber what the user already added.
      body = { ...body, items: mergeBasketItems(existing?.items || [], body.items) };
      const mergedFromExisting = existing?.items.length || 0;
      const { response: r, error } = await mutateBasket(BASKET_URL, body);
      if (error) return error;
      // Read-after-write: Wolt's basket POST returns success even for lines it
      // silently discards (invalid weight, unavailable item). Re-read the
      // basket and diff, so "ok" is never claimed for a line that isn't there.
      const verification = await verifyBasketWrite(venue_id, body.items, loc);
      let checkoutUrl = "https://wolt.com";
      if (venue_slug && country && city_slug) {
        checkoutUrl = `https://wolt.com/en/${country}/${city_slug}/venue/${venue_slug}`;
      } else if (venue_slug) {
        // The venue's own share_url is the canonical link — no city/country
        // plumbing needed from the caller.
        try { checkoutUrl = (await getVenue(venue_slug)).shareUrl || checkoutUrl; } catch (e) {}
        if (checkoutUrl === "https://wolt.com") checkoutUrl = `https://wolt.com/search?q=${encodeURIComponent(venue_slug)}`;
      }
      return { ...text({
        status: r.status, basketId: r.json?.id ?? null, itemsWritten: items.length, existingLinesPreserved: mergedFromExisting,
        ...(adjustments.length ? { adjustments } : {}),
        ...verification,
        checkoutUrl,
        note: verification.ok ? `Basket verified. Review and check out at ${checkoutUrl}; checkout_preview estimates delivery and fees.` : verification.retryNote
      }), isError: !verification.ok };
    } catch (e) {
      return errText(e.message);
    }
  })
);

// --- get_baskets: list the user's current Wolt baskets ---
server.tool(
  "get_baskets",
  "List the user's current Wolt baskets (needs a token): basket id, venue, and line items with names, counts, prices (minor units), grams, options and replacement permissions. Use before add_to_cart to see what's already there, or after to confirm the write persisted.",
  {
    lat: z.number().optional().describe("Override latitude; defaults to the saved location"),
    lon: z.number().optional().describe("Override longitude; defaults to the saved location")
  },
  async ({ lat, lon }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const page = await getBasketsPage(lat, lon);
      const baskets = (page.baskets || []).map((b) => ({
        basketId: b.id,
        venueId: b.venue?.id,
        venueName: b.venue?.name,
        items: (b.items || []).map((it) => ({
          id: it.id, name: it.name, count: it.count, price: it.price,
          weighted: !!it.weighted_item_info,
          grams: it.weighted_item_info?.purchased_weight_in_grams ?? null,
          options: it.options || [], allow_substitution: !!it.substitution_settings?.is_allowed
        }))
      }));
      return text({ count: baskets.length, baskets });
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- clear_basket: delete a basket by id ---
server.tool(
  "clear_basket",
  "Delete one of the user's Wolt baskets entirely (needs a token). Get the basketId from get_baskets. Confirm with the user before clearing a basket they built themselves.",
  { basket_id: z.string().describe("Basket id from get_baskets") },
  async ({ basket_id }) => {
    try {
      const { error } = await mutateBasket(BASKETS_DELETE_URL, { ids: [basket_id] });
      if (error) return error;
      return text({ ok: true, deleted: basket_id });
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- get_venue: detail + hours (slug-cached 24h) ---
server.tool(
  "get_venue",
  "Venue details by slug (from search results): rating, address, currency, delivery price, opening hours per day with timezone, and catalogLanguage (the language the venue's catalog is indexed in — query/plan in it for best matches). Check hours before adding food from a restaurant that might be closed.",
  { venue_slug: z.string() },
  async ({ venue_slug }) => {
    try {
      const [venue, catalogLanguage] = await Promise.all([getVenue(venue_slug), getCatalogLanguage(venue_slug)]);
      return text({ ...venue, catalogLanguage });
    } catch (e) { return errText(e.message); }
  }
);

// --- get_venue_menu: browse/search within one venue ---
server.tool(
  "get_venue_menu",
  "Browse a venue's full menu by slug: categories and items with prices. Optional query (free-text filter) and category (slug). Items flag requiredOptions=true when the dish needs choices — fetch those with get_dish_options before add_to_cart.",
  {
    venue_slug: z.string(),
    query: z.string().optional().describe("Search items by name/description (uses Wolt's in-venue search for large catalogs)"),
    category: z.string().optional().describe("Category slug from get_venue_categories or a previous call"),
    limit: z.number().int().default(30)
  },
  async ({ venue_slug, query, category, limit }) => {
    try { return text(await getMenu(venue_slug, { query, categorySlug: category, limit })); } catch (e) { return errText(e.message); }
  }
);

// --- get_venue_categories: the browse index (big groceries nest deeply) ---
server.tool(
  "get_venue_categories",
  "List a venue's categories (nested: depth, parent, subcategories, item counts). Start here to browse a large grocery store, then call get_venue_menu with a category slug. Restaurants usually have a handful of flat categories.",
  { venue_slug: z.string() },
  async ({ venue_slug }) => {
    try { return text(await getCategories(venue_slug)); } catch (e) { return errText(e.message); }
  }
);

// --- find_item: resolve an item by name or wolt.com URL ---
server.tool(
  "find_item",
  "Resolve one item in a venue by name, item id, or a wolt.com item URL (…/venue/<slug>/itemid-<id>). Exact name matches win; an ambiguous name returns the top candidates so you can ask the user which they meant. Use when the user pastes a Wolt link or names a dish loosely.",
  {
    item: z.string().describe("Item name, 24-hex item id, or full wolt.com item URL"),
    venue_slug: z.string().optional().describe("Required unless the URL contains /venue/<slug>/")
  },
  async ({ item, venue_slug }) => {
    try {
      const parsed = parseItemUrl(item);
      const resolved = await resolveItem(venue_slug || parsed.slug, item);
      return text({ venueSlug: venue_slug || parsed.slug, ...resolved });
    } catch (e) { return errText(e.message); }
  }
);

// --- get_dish_options: option groups for one item ---
server.tool(
  "get_dish_options",
  "Option groups for one menu item (sizes, toppings, sides): group ids, required/min/max, and each value's id/name/price. Ask the user for required choices, then pass options to add_to_cart as [{id: groupId, values: [{id: valueId, count: 1, price}]}].",
  { venue_slug: z.string(), item_id: z.string().describe("itemId from get_venue_menu — availability varies by hour, so fetch the menu first") },
  async ({ venue_slug, item_id }) => {
    try { return text(await getItemOptions(venue_slug, item_id)); } catch (e) { return errText(e.message); }
  }
);

// --- get_order_history / get_order: enables "reorder my usual" ---
server.tool(
  "get_order_history",
  "The user's past Wolt orders (needs a token): venue, date, total, status, purchase_id. Use get_order for line items — together these enable 'order my usual again'.",
  { limit: z.number().int().default(10), skip: z.number().int().default(0) },
  async ({ limit, skip }) => {
    try {
      const j = await getOrderHistory({ limit, skip });
      const orders = (j.orders || []).map((o) => ({
        purchaseId: o.purchase_id, venue: o.venue_name, receivedAt: o.received_at,
        status: o.status, total: o.total_amount, active: o.is_active
      }));
      return text({ orders, nextPageToken: j.next_page_token ?? null });
    } catch (e) { return errText(e.message); }
  }
);

server.tool(
  "get_order",
  "Full detail for one past order by purchase_id (from get_order_history), including line items — feed them back into add_to_cart to reorder.",
  { purchase_id: z.string() },
  async ({ purchase_id }) => {
    try { return text(await getOrder(purchase_id)); } catch (e) { return errText(e.message); }
  }
);

// --- resolve_address: free-form address -> coordinates (OpenStreetMap) ---
server.tool(
  "resolve_address",
  "Geocode a free-form address to coordinates via OpenStreetMap (no Wolt account needed). Use the result with set_location. Returns up to 3 candidates — confirm with the user if ambiguous.",
  { address: z.string().describe("e.g. 'Aleksanterinkatu 1, Helsinki'") },
  async ({ address }) => {
    try {
      const candidates = await geocodeAddress(address);
      if (!candidates.length) return errText(`no results for "${address}" — try adding a city or country`);
      return text({ candidates });
    } catch (e) { return errText(e.message); }
  }
);

// --- get_feed: discovery front page ("Popular", "Order again", …) ---
server.tool(
  "get_feed",
  "Wolt's discovery feed near the user: sections like 'Order again', 'Popular right now' with venues (name, slug, rating, delivery estimate). Good for 'what should I eat?' questions.",
  {
    lat: z.number().optional(), lon: z.number().optional(),
    section: z.string().optional().describe("Return only the section whose title contains this text")
  },
  async ({ lat, lon, section }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const r = await woltFetch(`https://consumer-api.wolt.com/v1/pages/front?lat=${lat}&lon=${lon}`);
      if (!r.ok) return errText(`feed failed: HTTP ${r.status}`);
      let sections = (r.json?.sections || []).map((s) => ({
        title: s.title || s.name || null,
        venues: (s.items || []).filter((it) => it.venue).slice(0, 10).map((it) => ({
          name: it.venue.name, slug: it.venue.slug, venueId: it.venue.id,
          rating: it.venue.rating?.score ?? it.venue.rating?.rating ?? null,
          estimate: it.venue.estimate_range || it.venue.delivery_price || null,
          online: it.venue.online ?? null
        }))
      })).filter((s) => s.title && s.venues.length);
      if (section) sections = sections.filter((s) => s.title.toLowerCase().includes(section.toLowerCase()));
      return text({ sections });
    } catch (e) { return errText(e.message); }
  }
);

// --- top_venues: ranked venues with real filters (open-now, fee, score) ---
server.tool(
  "top_venues",
  "Top venues near the user with real filters: open now, min score (0-10), max delivery fee, Wolt+ only, restaurant vs grocery, tag/name text. Sorted by score by default. THE tool for 'what's good and open near me right now?'.",
  {
    lat: z.number().optional(), lon: z.number().optional(),
    open_now: z.boolean().default(true),
    min_score: z.number().optional().describe("Minimum rating score, 0-10 (e.g. 8.5)"),
    max_delivery_fee: z.number().optional().describe("Max delivery fee in minor units"),
    wolt_plus_only: z.boolean().default(false),
    kind: z.enum(["restaurant", "grocery", "any"]).default("any"),
    query: z.string().optional().describe("Filter by name/tags/description substring, e.g. 'sushi'"),
    sort: z.enum(["score", "delivery_fee", "estimate"]).default("score"),
    limit: z.number().int().default(10)
  },
  async ({ lat, lon, open_now, min_score, max_delivery_fee, wolt_plus_only, kind, query, sort, limit }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const r = await woltFetch(`https://consumer-api.wolt.com/v1/pages/front?lat=${lat}&lon=${lon}`);
      if (!r.ok) return errText(`feed failed: HTTP ${r.status}`);
      const seen = new Set();
      let venues = [];
      for (const s of r.json?.sections || []) {
        for (const it of s.items || []) {
          const v = it.venue;
          if (!v?.id || seen.has(v.id)) continue;
          seen.add(v.id);
          venues.push({
            name: v.name, slug: v.slug, venueId: v.id,
            score: v.rating?.score ?? null, ratingVolume: v.rating?.volume ?? null,
            online: v.online ?? null, estimateMinutes: v.estimate ?? null,
            deliveryFee: v.delivery_price_int ?? null, deliveryFeeFormatted: v.delivery_price ?? null,
            woltPlus: !!v.show_wolt_plus, productLine: v.product_line || null,
            tags: v.tags || [], description: v.short_description || null
          });
        }
      }
      const total = venues.length;
      if (open_now) venues = venues.filter((v) => v.online !== false);
      if (min_score != null) venues = venues.filter((v) => v.score != null && v.score >= min_score);
      if (max_delivery_fee != null) venues = venues.filter((v) => v.deliveryFee != null && v.deliveryFee <= max_delivery_fee);
      if (wolt_plus_only) venues = venues.filter((v) => v.woltPlus);
      if (kind !== "any") venues = venues.filter((v) => kind === "grocery" ? v.productLine !== "restaurant" : v.productLine === "restaurant");
      if (query) {
        const q = query.toLowerCase();
        venues = venues.filter((v) => [v.name, v.description, ...(v.tags || [])].filter(Boolean).some((t) => t.toLowerCase().includes(q)));
      }
      venues.sort((a, b) =>
        sort === "delivery_fee" ? (a.deliveryFee ?? 1e9) - (b.deliveryFee ?? 1e9)
        : sort === "estimate" ? (a.estimateMinutes ?? 1e9) - (b.estimateMinutes ?? 1e9)
        : (b.score ?? -1) - (a.score ?? -1)
      );
      return text({ totalNearby: total, matching: venues.length, venues: venues.slice(0, limit) });
    } catch (e) { return errText(e.message); }
  }
);

// --- search_venues: find venues (not items) by name/cuisine ---
server.tool(
  "search_venues",
  "Search venues (stores AND restaurants) by name or cuisine near the user. Returns name, slug, venueId, rating, online status. Use get_venue for hours, get_venue_menu to browse.",
  { query: z.string(), lat: z.number().optional(), lon: z.number().optional() },
  async ({ query, lat, lon }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const r = await woltFetch("https://restaurant-api.wolt.com/v1/pages/search", {
        method: "POST", body: { q: query, target: null, lat, lon }
      });
      if (!r.ok) return errText(`venue search failed: HTTP ${r.status}`);
      const venues = [];
      for (const s of r.json?.sections || []) {
        for (const it of s.items || []) {
          const v = it.venue;
          if (!v || venues.some((x) => x.venueId === v.id)) continue;
          venues.push({
            name: v.name, slug: v.slug, venueId: v.id,
            rating: v.rating?.score ?? v.rating?.rating ?? null,
            online: v.online ?? null, address: v.address || null,
            productLine: v.product_line || null
          });
        }
      }
      return text({ query, count: venues.length, venues: venues.slice(0, 15) });
    } catch (e) { return errText(e.message); }
  }
);

// --- get_payment_methods (read-only) ---
server.tool(
  "get_payment_methods",
  "The user's saved Wolt payment methods (needs a token). Read-only — payment always happens on wolt.com.",
  async () => {
    try {
      const r = await woltFetch("https://restaurant-api.wolt.com/v3/user/me/payment_methods");
      if (!r.ok) return errText(`payment methods failed: HTTP ${r.status}`);
      return text(r.json?.results ?? r.json);
    } catch (e) { return errText(e.message); }
  }
);

// --- favorites ---
server.tool(
  "get_favorites",
  "The user's favorited Wolt venues (needs a token).",
  async () => {
    try {
      const loc = await needLocation();
      const r = await woltFetch(`https://consumer-api.wolt.com/v1/pages/venue-list/profile/favourites?lat=${loc.lat}&lon=${loc.lon}`);
      if (!r.ok) return errText(`favorites failed: HTTP ${r.status}`);
      const venues = (r.json?.sections || []).flatMap((s) => (s.items || []))
        .filter((it) => it.venue)
        .map((it) => ({ name: it.venue.name, slug: it.venue.slug, venueId: it.venue.id, rating: it.venue.rating?.score ?? null, online: it.venue.online ?? null }));
      return text({ count: venues.length, venues });
    } catch (e) { return errText(e.message); }
  }
);

server.tool(
  "add_favorite",
  "Add a venue to the user's Wolt favorites (needs a token).",
  { venue_id: z.string().describe("Venue id (24 hex)") },
  async ({ venue_id }) => {
    try {
      const r = await woltFetch(`https://restaurant-api.wolt.com/v3/venues/favourites/${venue_id}`, { method: "PUT" });
      if (!r.ok) return errText(`add favorite failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      return text({ ok: true, favorited: venue_id });
    } catch (e) { return errText(e.message); }
  }
);

server.tool(
  "remove_favorite",
  "Remove a venue from the user's Wolt favorites (needs a token).",
  { venue_id: z.string().describe("Venue id (24 hex)") },
  async ({ venue_id }) => {
    try {
      const r = await woltFetch(`https://restaurant-api.wolt.com/v3/venues/favourites/${venue_id}`, { method: "DELETE" });
      if (!r.ok) return errText(`remove favorite failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      return text({ ok: true, unfavorited: venue_id });
    } catch (e) { return errText(e.message); }
  }
);

// --- checkout_preview: price the basket (fees, delivery) — never orders ---
server.tool(
  "checkout_preview",
  "Estimate checkout for a basket of packaged items, including delivery fees, service charges and offers. Weighted baskets are refused because their checkout pricing schema is not verified. Read-only; never places an order or changes the delivery address. Confirm the final amount, credits and address on wolt.com.",
  {
    venue_id: z.string().optional().describe("Venue id (24 hex) of the basket to price; defaults to the user's only/first basket"),
    venue_slug: z.string().optional().describe("venueSlug from search results — improves category resolution"),
    tip: z.number().int().default(0).describe("Courier tip in minor units"),
    promo_code: z.string().optional(),
    lat: z.number().optional(), lon: z.number().optional()
  },
  async ({ venue_id, venue_slug, tip, promo_code, lat, lon }) => {
    try {
      ({ lat, lon } = await needLocation(lat, lon));
      const preview = await checkoutPreview({
        venueId: venue_id || null, venueSlug: venue_slug || null,
        lat, lon, tip, promoCode: promo_code || null
      });
      const { raw, ...summary } = preview; // keep the tool result compact
      return text({ ...summary, estimateOnly: true, note: "Confirm the delivery address, weighted amounts, credits and final total on wolt.com before payment." });
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- update_cart_item: change a line's count or remove it ---
server.tool(
  "update_cart_item",
  "Update a basket item's count, total grams or replacement permission; count 0 removes it. Weighted quantity changes require explicit grams and venue_slug to validate the catalog step. Reads the current basket before writing and verifies the result. Removing the last line deletes the basket.",
  {
    venue_id: z.string().describe("Venue id (24 hex) from get_baskets"),
    item_id: z.string().describe("Item id of the line to change"),
    venue_slug: z.string().optional().describe("Required for weight changes, to validate the catalog step"),
    count: z.number().int().min(0).optional().describe("New count; 0 removes the line"),
    grams: z.number().positive().optional().describe("New total purchased weight in grams"),
    allow_substitution: z.boolean().optional().describe("Whether the store may replace this item")
  },
  async ({ venue_id, item_id, venue_slug, count, grams, allow_substitution }) => withBasketLock(venue_id, async () => {
    if (!isVenueObjectId(venue_id)) return errText(`venue_id "${venue_id}" is not a Wolt venue id (24 hex chars).`);
    if (count == null && grams == null && allow_substitution == null) return errText("Provide count, grams or allow_substitution; nothing was changed.");
    try {
      const loc = getLocation();
      if (!loc) return errText("Set a search location before changing a basket; nothing was written.");
      const page = await getBasketsPage(loc.lat, loc.lon);
      const basket = findBasketForVenue(page, venue_id);
      if (!basket) return errText(`no basket found for venue ${venue_id}`);
      const matches = basket.items.filter((it) => it.id === item_id);
      if (matches.length > 1) return errText("Multiple variants share this item id; edit the intended variant on wolt.com to avoid changing the wrong line.");
      const [line] = matches;
      if (!line) return errText(`item ${item_id} not in this basket. Lines: ${(basket.items || []).map((i) => `${i.id} (${i.name})`).join(", ")}`);
      if (count !== 0 && line.weighted_item_info && count != null && count !== line.count && grams == null) {
        return errText("Changing a weighted item's count requires its new total grams and venue_slug; nothing was changed.");
      }
      const updated = upsertItemFromLine(line, count);
      const adjustments = [];
      if (count !== 0 && grams != null) {
        if (!line.weighted_item_info || !venue_slug) return errText("Only weighted items accept grams; provide venue_slug to validate the weight. Nothing was changed.");
        const configs = await getWeightConfigs(venue_slug, [item_id]);
        if (!configs?.get(item_id)?.gramsPerStep) return errText("Cannot verify this item's weight step in the catalog; nothing was changed.");
        const request = { id: item_id, weighted: true, grams };
        adjustments.push(...reconcileWeightedItems([request], configs));
        updated.weighted_item_info.purchased_weight_in_grams = request.grams;
      }
      if (allow_substitution != null) updated.substitution_settings.is_allowed = allow_substitution;
      const remaining = (basket.items || []).filter((it) => it.id !== item_id);
      if (count === 0 && remaining.length === 0) {
        // last line → delete the basket
        const { error } = await mutateBasket(BASKETS_DELETE_URL, { ids: [basket.id] });
        if (error) return error;
        const verification = await verifyBasketWrite(venue_id, [], loc);
        return { ...text({ ...verification, removedItem: item_id, basketDeleted: basket.id }), isError: !verification.ok };
      }
      const items = mergeBasketItems(count === 0 ? remaining : basket.items, [])
        .map((it) => (it.id === item_id ? updated : it));
      // The basket's own currency is authoritative here; the venue's market is
      // the fallback. Rewriting a basket in a guessed currency is worse than
      // failing loudly.
      const currency = resolveCurrency({ currency: basket.currency, country: basket.venue?.country });
      if (!currency) return errText(`basket ${basket.id} has no currency on record and the venue's market is unknown — nothing was changed. Re-add the line with add_to_cart (passing currency) instead.`);
      const body = { items, venue_id, currency };
      const { error } = await mutateBasket(BASKET_URL, body);
      if (error) return error;
      const verification = await verifyBasketWrite(venue_id, items, loc);
      return { ...text({ ...verification, itemId: item_id, newCount: count ?? line.count, grams: updated.weighted_item_info?.purchased_weight_in_grams ?? null, adjustments, linesNow: items.length }), isError: !verification.ok };
    } catch (e) {
      return errText(e.message);
    }
  })
);

// --- login_via_chrome: zero-paste login by watching a Chrome you launch ---
server.tool(
  "login_via_chrome",
  "Zero-paste Wolt login: launches a Chromium-based browser with wolt.com open; the user logs in normally and the refresh token is picked up automatically and exchanged for an API token. Tell the user two things: (1) a browser window will open in a SEPARATE, EMPTY profile, so they log into Wolt fresh there — their everyday profile, cookies and extensions are untouched; (2) this tool waits up to 2 minutes — if it times out the window stays open, so if they need longer (waiting on an emailed code), let them finish signing in there and call this again. Requires a Chromium-family browser — the user's default browser is auto-detected and used when it's Chrome, Edge, Brave, Vivaldi, Arc or Chromium (CDP-based, so Firefox and Safari cannot work; use set_wolt_token there instead). CHROME_BIN overrides the choice if needed. After a successful login, call use_saved_address so searches use the user's real address.",
  {},
  async () => {
    try {
      const { via, tokenState } = await cdpLogin({});
      return text({ ok: true, connectedVia: via, ...tokenState });
    } catch (e) {
      return errText(`Browser login didn't complete: ${e.message}\nIf they use a non-Chrome Chromium browser (Edge, Brave, Vivaldi, Chromium), set CHROME_BIN to its binary and retry.\nFallback for Firefox/Safari users, or if no Chromium browser is installed: ask the user to paste a Wolt refresh token and store it with set_wolt_token (see the README).`);
    }
  }
);

server.tool(
  "login_via_existing_chrome",
  "Connect the Wolt session already signed into ordinary Chrome 144+, without another Wolt login. Explain first: the user must enable remote debugging at chrome://inspect/#remote-debugging and personally approve Chrome's connection prompt; that permission is browser-wide, although this tool only reads Wolt login cookies from an HTTPS Wolt tab. Never enable debugging or approve the prompt on the user's behalf. Reads only DevToolsActivePort metadata from disk, not browser cookie databases; never copies a profile, launches/closes Chrome, or navigates tabs. Disconnects after reading the cookie, validates it with Wolt, and only then stores tokens locally. Keep a signed-in wolt.com tab open in the profile Chrome shares. Defaults to the standard Chrome user-data directory; WOLT_CHROME_USER_DATA_DIR overrides it. Allow up to 2 minutes for approval. After success, verify the account with wolt_status/get_wolt_profile and use_saved_address before changing a basket.",
  {},
  async () => {
    try {
      const { via, tokenState } = await existingChromeLogin();
      return text({ ok: true, connectedVia: via, ...tokenState });
    } catch (error) { return errText(error.message); }
  }
);

// --- set_wolt_token: paste tokens in-chat; enables auto-refresh ---
server.tool(
  "set_wolt_token",
  "Store the user's Wolt tokens (persisted locally, chmod 600). Prefer login_via_chrome; use this when the user pastes a token themselves. Accepts access_token and/or refresh_token, or a JSON blob containing either. With a valid refresh token stored, the server renews access automatically; reconnect if Wolt revokes the session.",
  {
    blob: z.string().optional().describe("A JSON blob containing the tokens, e.g. {\"refresh_token\":\"...\"}"),
    access_token: z.string().optional().describe("Wolt access JWT (eyJ..., 'Bearer ' prefix ok)"),
    refresh_token: z.string().optional().describe("Wolt refresh token — enables automatic renewal while the token remains valid")
  },
  async ({ blob, access_token, refresh_token }) => {
    if (blob) {
      try {
        const j = JSON.parse(blob);
        access_token = access_token || j.access_token || j.accessToken || j.authorization;
        refresh_token = refresh_token || j.refresh_token || j.refreshToken;
      } catch (e) { return errText("blob is not valid JSON — paste the raw token instead, or use access_token / refresh_token."); }
    }
    if (!access_token && !refresh_token) return errText("Provide a blob, or access_token and/or refresh_token.");
    return text(setTokens({ accessToken: access_token, refreshToken: refresh_token }));
  }
);

// --- get_wolt_profile: authenticated user info (may include saved addresses) ---
server.tool(
  "get_wolt_profile",
  "Fetch the logged-in user's Wolt profile — name/email/phone only (GET /v1/user/me; needs a token). It does NOT contain delivery addresses: to pull the user's saved addresses and set one as the search location, call use_saved_address instead.",
  async () => {
    try {
      const r = await woltFetch("https://restaurant-api.wolt.com/v1/user/me");
      if (!r.ok) return errText(`profile fetch failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      return text(r.json ?? r.text);
    } catch (e) {
      return errText(e.message);
    }
  }
);

// --- set_location: persist the delivery location ---
server.tool(
  "set_location",
  "Save the user's delivery location (persisted; used as the default for all searches). When the user gives an address or city, geocode it with resolve_address first and pass the coordinates here with the human-readable text as label. For their saved Wolt addresses, use use_saved_address instead.",
  {
    lat: z.number().describe("Latitude"),
    lon: z.number().describe("Longitude"),
    label: z.string().optional().describe("Human-readable place, e.g. 'Aleksanterinkatu 1, Helsinki'")
  },
  async ({ lat, lon, label }) => text({ saved: setLocation({ lat, lon, label }), ...(await marketLanguageFields(lat, lon)) })
);

// --- wolt_status: live login check + location ---
server.tool(
  "wolt_status",
  "Call this FIRST whenever the user wants to buy or manage their account: it live-verifies the Wolt login (refreshing the access token if needed) and reports the configured location plus the market's catalogLanguage — write product queries and plan_cart ingredient lines in that language (translate them yourself). If loginNeeded is true, offer login_via_chrome (or set_wolt_token) before planning a cart. If loginNeeded is null, verification was unavailable; retry later rather than asking for a new login. Search works without a token.",
  async () => {
    // Actually exercise the token chain instead of reporting what's on disk —
    // a stored refresh token can be stale, and finding that out here beats
    // finding out after the cart is planned.
    let loginNeeded = null, loginVerified = false, loginDetail = null;
    try {
      await getAccessToken();
      loginNeeded = null; // A network/server error cannot establish whether login is needed.
      const r = await woltFetch("https://restaurant-api.wolt.com/v1/user/me");
      if (r.ok) { loginNeeded = false; loginVerified = true; }
      else {
        loginNeeded = r.status === 401 || r.status === 403 ? true : null;
        loginDetail = `Profile verification failed: HTTP ${r.status}`;
      }
    } catch (e) {
      if (e.loginNeeded) loginNeeded = true;
      loginDetail = e.message;
    }
    const loc = getLocation();
    return text({
      loginNeeded,
      loginVerified,
      ...(loginDetail ? { loginDetail } : {}),
      ...describeTokens(),
      location: loc || { label: "not set (estimated from IP on first search)", hint: "use_saved_address sets it from the user's saved Wolt addresses; set_location takes a spoken address" },
      ...(loc ? await marketLanguageFields(loc.lat, loc.lon) : {})
    });
  }
);

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await server.connect(new StdioServerTransport());
  console.error("wolt-mcp server running on stdio");
}
