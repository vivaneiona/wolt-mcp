import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "venue-test-"));
process.env.WOLT_STATE_DIR = stateDir;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network request in venue test"); };
const { setFetchImpl } = await import("../mcp/lib/http.js");
const { resolveItem } = await import("../mcp/lib/venue.js");

const target = {
  id: "111111111111111111111111", name: "Milk", price: 499,
  description: "Fresh milk", options: [],
  sell_by_weight_config: { grams_per_step: 100, price_per_kg: 499 }
};
const other = { id: "222222222222222222222222", name: "Milk chocolate", price: 299 };
const absentId = "333333333333333333333333";

function catalog(strategy, items = [target, other], { itemStatus = 200 } = {}) {
  const searches = [];
  setFetchImpl(async (url, init) => {
    assert.equal(init.headers.authorization, undefined, "item lookup must not need credentials");
    let body;
    if (url.endsWith("/assortment")) {
      body = { loading_strategy: strategy, items: strategy === "partial" ? [] : items };
    } else if (url.endsWith("/assortment/items")) {
      assert.equal(init.method, "POST");
      const { item_ids } = JSON.parse(init.body);
      body = { items: items.filter((item) => item_ids.includes(item.id)) };
      return new Response(JSON.stringify(body), { status: itemStatus });
    } else if (url.endsWith("/assortment/items/search")) {
      assert.equal(init.method, "POST");
      const { q } = JSON.parse(init.body);
      searches.push({ query: q, language: init.headers["app-language"] });
      body = { items };
    } else {
      throw new Error(`Unexpected request: ${url}`);
    }
    return new Response(JSON.stringify(body));
  });
  return searches;
}

try {
  for (const strategy of ["full", "partial"]) {
    for (const ref of [target.id, `https://wolt.com/en/geo/batumi/venue/grocery-test/itemid-${target.id}`]) {
      catalog(strategy);
      const resolved = await resolveItem(ref === target.id ? "grocery-test" : null, ref);
      assert.equal(resolved.itemId, target.id, `${strategy} lookup by id or URL`);
      assert.equal(resolved.price, target.price);
      assert.deepEqual(resolved.sellByWeight, { gramsPerStep: 100, pricePerKg: 499 });
    }

    catalog(strategy);
    assert.equal((await resolveItem("grocery-test", "mILk")).itemId, target.id,
      `${strategy} exact name must beat a substring match`);
    assert.equal((await resolveItem("grocery-test", "milk c")).itemId, other.id,
      `${strategy} unambiguous substring lookup`);
    catalog(strategy);
    await assert.rejects(resolveItem("grocery-test", absentId), /not found/);
    catalog(strategy, []);
    await assert.rejects(resolveItem("grocery-test", "Bread"), /no item matching/);
  }

  const georgianItem = { ...target, name: "რძე" };
  const searches = catalog("partial", [georgianItem]);
  assert.equal((await resolveItem("grocery-test", georgianItem.name)).itemId, target.id);
  assert.deepEqual(searches, [{ query: georgianItem.name, language: "ka" }],
    "partial catalog search must return names in the query language");

  catalog("full", [other, { ...target, name: "Milk drink" }]);
  await assert.rejects(resolveItem("grocery-test", "milk"), /matched 2 items/);
  catalog("full");
  await assert.rejects(resolveItem("grocery-test", "fresh milk bottle"), /closest:/);

  catalog("partial", [target], { itemStatus: 503 });
  await assert.rejects(resolveItem("grocery-test", target.id), /HTTP 503/,
    "a failed lookup must not be reported as an unavailable product");
  console.log("venue.test.mjs: all assertions passed");
} finally {
  setFetchImpl(null);
  globalThis.fetch = originalFetch;
  rmSync(stateDir, { recursive: true, force: true });
}
