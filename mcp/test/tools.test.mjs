// Exercise the registered MCP handlers without network access or real account state.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const stateDir = mkdtempSync(join(tmpdir(), "shopping-tools-test-"));
for (const key of ["WOLT_BEARER_TOKEN", "WOLT_REFRESH_TOKEN", "WOLT_LAT", "WOLT_LON"]) delete process.env[key];
process.env.WOLT_STATE_DIR = stateDir;
const originalFetch = globalThis.fetch;
const forbiddenFetch = async () => { throw new Error("Unexpected network access in tools test"); };
globalThis.fetch = forbiddenFetch;

const { setFetchImpl } = await import("../lib/http.js");
const { setLocation, getLocation } = await import("../lib/config.js");
const { server } = await import("../server.mjs");
const client = new Client({ name: "shopping-tools-test", version: "1" }, { capabilities: {} });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

const venueId = "111111111111111111111111";
const breadId = "222222222222222222222222";
const milkId = "333333333333333333333333";
const meatId = "444444444444444444444444";
const newItem = { id: milkId, name: "Milk", price: 499, count: 1 };
const line = (id, overrides = {}) => ({
  id, name: id === breadId ? "Bread" : "Milk", price: 499, count: 1,
  options: [], substitution_settings: { is_allowed: false }, ...overrides
});
const weightedLine = () => line(meatId, {
  name: "Smoked meat", weighted_item_info: {
    count: 1, purchased_weight_in_grams: 500, weighted_item_input_type: "grams"
  }
});
const basketPage = (items) => ({ baskets: items.length ? [{
  id: "shopping-basket", venue: { id: venueId, country: "GEO", name: "Grocery" }, currency: "GEL", items
}] : [] });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

function reset({ location = true, expired = false, refresh = false } = {}) {
  rmSync(join(stateDir, "config.json"), { force: true });
  const exp = Math.floor(Date.now() / 1000) + (expired ? -3600 : 3600);
  const accessToken = ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "test-signature"].join(".");
  writeFileSync(join(stateDir, "tokens.json"), JSON.stringify({ accessToken, ...(refresh ? { refreshToken: "refresh-test-token" } : {}) }));
  if (location) setLocation({ lat: 41.65, lon: 41.64, label: "Test delivery address" });
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const message = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  let data;
  try { data = JSON.parse(message); } catch { data = null; }
  return { ...result, data, message };
}

const add = (items = [newItem]) => call("add_to_cart", { venue_id: venueId, currency: "GEL", items });
const verified = (result) => {
  assert.notEqual(result.isError, true, result.message);
  assert.equal(result.data?.ok, true, result.message);
  assert.equal(result.data?.verified, true, result.message);
};
const unverifiedWrite = (result) => {
  assert.equal(result.isError, true, result.message);
  assert.equal(result.data?.ok, false, result.message);
  assert.equal(result.data?.writeSucceeded, true, result.message);
  assert.equal(result.data?.verified, false, result.message);
};

function mockBasket({ existing = [], before = null, after = null, writeResult = null } = {}) {
  let items = structuredClone(existing);
  const writes = [];
  const events = [];
  setFetchImpl(async (url, init) => {
    if (url.includes("/pages/baskets?")) {
      events.push("read");
      const override = writes.length ? after : before;
      return override ? override(structuredClone(items)) : response(basketPage(items));
    }
    if (url.endsWith("/order-xp/v1/baskets")) {
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body);
      writes.push(body);
      events.push("write");
      items = structuredClone(body.items);
      return writeResult ? writeResult() : response({ id: "shopping-basket" });
    }
    if (url.endsWith("/assortment/items")) {
      const { item_ids } = JSON.parse(init.body);
      return response({ items: item_ids.map((id) => ({
        id, ...(id === meatId ? { sell_by_weight_config: { grams_per_step: 100 } } : {})
      })) });
    }
    throw new Error(`Unexpected mock request: ${url}`);
  });
  return { writes, events, get items() { return structuredClone(items); } };
}

try {
  reset({ location: false });
  let scenario = mockBasket();
  assert.equal((await add()).isError, true, "missing saved location must stop a basket write");
  assert.equal(scenario.writes.length, 0);

  for (const failedRead of [
    () => response({ error: "temporary failure" }, 503),
    () => response({}),
    () => response({ baskets: {} }),
    () => response({ baskets: [{ id: "shopping-basket", venue: { id: venueId }, items: null }] })
  ]) {
    reset();
    scenario = mockBasket({ existing: [line(breadId)], before: failedRead });
    assert.equal((await add()).isError, true, "unreadable existing basket must stop a write");
    assert.equal(scenario.writes.length, 0, "the old basket must not be replaced after a failed read");
  }

  reset();
  const preserved = line(breadId, { count: 2, substitution_settings: { is_allowed: true } });
  scenario = mockBasket({ existing: [preserved] });
  verified(await add());
  assert.deepEqual(scenario.writes[0].items.find((item) => item.id === breadId), preserved);
  assert.equal(scenario.writes[0].items.find((item) => item.id === milkId).substitution_settings.is_allowed, false,
    "new products default to no substitutions");

  reset();
  scenario = mockBasket({
    existing: [preserved],
    after: (items) => response(basketPage(items.filter((item) => item.id !== breadId)))
  });
  unverifiedWrite(await add());

  reset();
  scenario = mockBasket();
  verified(await add([{ ...newItem, allow_substitution: true }]));
  assert.equal(scenario.writes[0].items[0].substitution_settings.is_allowed, true);

  for (const readback of [
    () => response({ error: "temporary failure" }, 503),
    () => response({}),
    () => response({ baskets: [] }),
    (items) => response(basketPage(items.map((item) => ({ ...item, count: item.count + 1 })))),
    (items) => response(basketPage(items.map((item) => ({ ...item, substitution_settings: { is_allowed: true } }))))
  ]) {
    reset();
    scenario = mockBasket({ after: readback });
    unverifiedWrite(await add());
    assert.equal(scenario.writes.length, 1, "uncertain writes must not be automatically repeated");
  }

  for (const writeResult of [
    () => { throw new Error("Connection closed after write"); },
    () => response({ error: "temporary failure after write" }, 503)
  ]) {
    reset();
    scenario = mockBasket({ writeResult });
    const result = await add();
    assert.equal(result.isError, true, result.message);
    assert.equal(result.data?.ok, false, result.message);
    assert.equal(result.data?.verified, false, result.message);
    assert.equal(result.data?.writeSucceeded, null, result.message);
    assert.match(result.data?.retryNote, /inspect.*before retrying/i);
    assert.equal(scenario.writes.length, 1, "a failed response must never repeat a potentially committed mutation");
    assert.equal(scenario.items[0].id, milkId, "the mock committed the mutation before losing its response");
  }

  reset();
  scenario = mockBasket({ after: (items) => {
    items[0].weighted_item_info.purchased_weight_in_grams = 250;
    return response(basketPage(items));
  } });
  unverifiedWrite(await add([{ id: meatId, name: "Smoked meat", price: 1499, weighted: true, grams: 500 }]));

  reset();
  scenario = mockBasket({ after: (items) => {
    items[0].options = [];
    return response(basketPage(items));
  } });
  unverifiedWrite(await add([{ ...newItem, options: [{ id: "size", values: [{ id: "large", count: 1, price: 100 }] }] }]));

  reset();
  scenario = mockBasket({ existing: [line(breadId), weightedLine()] });
  const listed = await call("get_baskets");
  assert.notEqual(listed.isError, true, listed.message);
  const meat = listed.data.baskets[0].items.find((item) => item.id === meatId);
  assert.equal(meat.weighted, true);
  assert.equal(meat.grams, 500);
  assert.equal(meat.count, 1);
  assert.deepEqual(meat.options, []);
  assert.equal(meat.allow_substitution, false);

  for (const grams of [500, 1200]) {
    reset();
    const item = weightedLine();
    item.weighted_item_info.purchased_weight_in_grams = grams;
    let checkoutPosts = 0;
    setFetchImpl(async (url, init) => {
      if (url.includes("/pages/baskets?")) return response(basketPage([item]));
      if (url.endsWith("/pages/checkout")) {
        assert.equal(init.method, "POST");
        checkoutPosts++;
        return response({ payable_amount: 499 });
      }
      throw new Error(`Unexpected mock request: ${url}`);
    });
    const result = await call("checkout_preview", { venue_id: venueId });
    assert.equal(result.isError, true, result.message);
    assert.match(result.message, /weighted/i);
    assert.equal(result.data?.payableAmount, undefined, "unsupported weighted preview must not quote a total");
    assert.equal(checkoutPosts, 0, "unsupported weighted preview must stop before pricing");
  }

  reset();
  scenario = mockBasket({ existing: [weightedLine()] });
  assert.equal((await call("update_cart_item", { venue_id: venueId, item_id: meatId, count: 2 })).isError, true);
  assert.equal(scenario.writes.length, 0, "weighted count changes need an explicit requested weight");
  assert.equal((await call("update_cart_item", { venue_id: venueId, item_id: meatId, grams: 800 })).isError, true);
  assert.equal(scenario.writes.length, 0, "weight changes need a venue catalog to validate the step");
  verified(await call("update_cart_item", { venue_id: venueId, venue_slug: "grocery-test", item_id: meatId, grams: 800 }));
  assert.equal(scenario.writes[0].items[0].weighted_item_info.purchased_weight_in_grams, 800);

  reset();
  scenario = mockBasket({ existing: [line(breadId), weightedLine()] });
  verified(await call("update_cart_item", { venue_id: venueId, item_id: meatId, count: 0 }));
  assert.deepEqual(scenario.items.map((item) => item.id), [breadId], "weighted products can still be removed without grams");

  reset();
  scenario = mockBasket({ existing: [weightedLine()] });
  verified(await call("update_cart_item", { venue_id: venueId, item_id: meatId, allow_substitution: true }));
  assert.equal(scenario.items[0].substitution_settings.is_allowed, true);
  assert.equal(scenario.items[0].weighted_item_info.purchased_weight_in_grams, 500,
    "changing substitution preference must not change the requested weight");

  // Concurrent changes at one venue must read each other's completed writes.
  reset();
  scenario = mockBasket();
  const parallelAdds = await Promise.all([add(), add([{ id: breadId, name: "Bread", price: 325 }])]);
  parallelAdds.forEach(verified);
  assert.deepEqual(scenario.items.map((item) => item.id).sort(), [breadId, milkId].sort());
  assert.deepEqual(scenario.events, ["read", "write", "read", "read", "write", "read"]);

  for (const [status, loginNeeded, loginVerified] of [[200, false, true], [401, true, false], [503, null, false]]) {
    reset({ location: false });
    let profileReads = 0;
    setFetchImpl(async (url) => {
      assert.equal(url, "https://restaurant-api.wolt.com/v1/user/me");
      profileReads++;
      return response(status === 200 ? { first_name: "Test", last_name: "Buyer" } : { error: "unavailable" }, status);
    });
    const result = await call("wolt_status");
    assert.equal(profileReads, 1, "a locally unexpired JWT still needs a live profile check");
    assert.equal(result.data.loginNeeded, loginNeeded, result.message);
    assert.equal(result.data.loginVerified, loginVerified, result.message);
  }

  for (const testCase of [
    { expired: true, refreshStatus: 503, loginNeeded: null },
    { expired: true, networkError: true, loginNeeded: null },
    { expired: false, refreshStatus: 503, loginNeeded: null },
    { expired: true, refreshStatus: 400, loginNeeded: true }
  ]) {
    reset({ location: false, expired: testCase.expired, refresh: true });
    let profileReads = 0;
    let refreshRequests = 0;
    setFetchImpl(async (url) => {
      assert.equal(url, "https://restaurant-api.wolt.com/v1/user/me");
      profileReads++;
      return response({ error: "access token rejected" }, 401);
    });
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://authentication.wolt.com/v1/wauth2/access_token");
      assert.equal(init.method, "POST");
      assert.equal(init.body.get("refresh_token"), "refresh-test-token");
      refreshRequests++;
      if (testCase.networkError) throw new Error("Authentication connection interrupted");
      return response({ error: "refresh failed" }, testCase.refreshStatus);
    };
    try {
      const result = await call("wolt_status");
      assert.equal(profileReads, testCase.expired ? 0 : 1);
      assert.equal(refreshRequests, 1);
      assert.equal(result.data.loginNeeded, testCase.loginNeeded, result.message);
      assert.equal(result.data.loginVerified, false, result.message);
    } finally {
      globalThis.fetch = forbiddenFetch;
    }
  }

  reset({ location: false });
  const addresses = [
    { id: "home-address", label_type: "home", location: { address: "Home street 1", city: "Batumi", user_coordinates: { coordinates: [41.63, 41.65] } } },
    { id: "delivery-address", label_type: "other", location: { address: "Vazha-Pshavela 55", city: "Batumi", user_coordinates: { coordinates: [41.64, 41.66] } } }
  ];
  setFetchImpl(async (url) => {
    if (url === "https://restaurant-api.wolt.com/v2/delivery/info") return response({ results: addresses });
    if (url.includes("/v1/pages/front?")) return response({ sections: [] });
    throw new Error(`Unexpected mock request: ${url}`);
  });
  const choices = await call("use_saved_address");
  assert.equal(choices.data.addresses.length, 2);
  assert.equal(getLocation(), null, "Home must not be selected automatically among multiple addresses");
  const selected = await call("use_saved_address", { address_id: "delivery-address" });
  assert.equal(selected.data.pickedAddressId, "delivery-address");
  assert.equal(selected.data.checkoutAddressUnchanged, true);
  assert.deepEqual([getLocation().lat, getLocation().lon], [41.66, 41.64]);

  console.log("tools.test.mjs: offline MCP basket, authentication, and address checks passed");
} finally {
  await client.close();
  await server.close();
  setFetchImpl(null);
  globalThis.fetch = originalFetch;
  rmSync(stateDir, { recursive: true, force: true });
}
