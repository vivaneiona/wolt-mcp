import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "grocery-plan-quantity-test-"));
process.env.WOLT_STATE_DIR = stateDir;
globalThis.fetch = () => { throw new Error("quantity tests must not touch the network"); };

const { setFetchImpl } = await import("../mcp/lib/http.js");
const { planAtVenue, planResponse } = await import("../mcp/lib/plan.js");
const milk = { id: "111111111111111111111111", name: "milk", price: 400 };
const chicken = {
  id: "222222222222222222222222", name: "chicken", price: 1000,
  sell_by_weight_config: { grams_per_step: 100, price_per_kg: 2000 }
};
const calls = [];
setFetchImpl(async (url, init) => {
  let payload;
  if (url.endsWith("/static")) {
    payload = { venue: { id: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Demo grocery", currency: "GEL", country: "GEO" } };
  } else if (url.endsWith("/assortment")) {
    payload = { primary_language: "en", loading_strategy: "partial", categories: [], items: [] };
  } else if (url.endsWith("/assortment/items/search")) {
    const query = JSON.parse(init.body).q;
    calls.push(query);
    assert(["milk", "chicken"].includes(query), `quantity/unit leaked into search: ${query}`);
    payload = { items: [query === "milk" ? milk : chicken] };
  } else {
    throw new Error(`unexpected mock request: ${url}`);
  }
  return new Response(JSON.stringify(payload), { status: 200 });
});

try {
  const plan = await planAtVenue("demo-grocery", ["3 milk", "1200 g chicken"]);
  assert.equal(plan.basket.items[0].count, 3, "explicit count survives planning");
  assert.equal(plan.basket.items[1].weighted_item_info.purchased_weight_in_grams, 1200, "explicit grams survive planning");
  assert.equal(plan.lineItems[0].count, 3, "reviewed line carries the quantity to add_to_cart");
  assert.equal(plan.lineItems[1].grams, 1200);
  assert.equal(plan.cost, 3600, "store comparison prices the requested amounts");

  for (const raw of ["1.25 kg chicken", "1,25 кг chicken", "1250 гр. chicken", "1.25 კგ chicken", "1250 გ chicken"]) {
    const weighted = await planAtVenue("demo-grocery", [raw]);
    assert.equal(weighted.basket.items[0].weighted_item_info.purchased_weight_in_grams, 1300, `${raw}: rounds up to the catalog's step`);
  }
  const packages = await planAtVenue("demo-grocery", ["2 packages milk"]);
  assert.equal(packages.basket.items[0].count, 2);

  const defaults = await planAtVenue("demo-grocery", ["milk", "chicken"]);
  assert.equal(defaults.basket.items[0].count, 1, "unquantified package keeps its default");
  assert.equal(defaults.basket.items[1].weighted_item_info.purchased_weight_in_grams, 500, "only unquantified weight gets the default");

  for (const raw of ["2 l milk", "2 л milk", "2 ლ milk", "800 g milk", "1/2 cup milk", "0.5 milk", "2 chicken", "2 packages chicken", "0 milk"]) {
    const unresolved = await planAtVenue("demo-grocery", [raw, "milk"]);
    assert.equal(unresolved.coverageCount, 2, `${raw}: product is still found`);
    assert.equal(unresolved.basket, null, `${raw}: no ready basket with a guessed quantity`);
    assert(unresolved.lineItems[0].quantityNeedsReview, `${raw}: reason is available to the caller`);
    assert.equal(unresolved.lineItems[0].count, undefined, `${raw}: no invented package count`);
    const response = planResponse(unresolved, 2);
    assert.equal(response.quantityReview[0].ingredient, raw);
    assert.match(response.basketNote, /resolve the flagged quantities/);
    assert.doesNotMatch(response.basketNote, /No currency/);
  }
  assert(calls.length > 0, "the tests exercise actual catalog requests through planAtVenue");
  console.log("plan-quantity.test.mjs: all assertions passed");
} finally {
  setFetchImpl(null);
  rmSync(stateDir, { recursive: true, force: true });
}
