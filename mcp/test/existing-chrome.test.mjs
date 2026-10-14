// No browser, network, or real account state is touched by these login checks.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "shopping-browser-test-"));
const stateDir = join(testDir, "state");
const userDataDir = join(testDir, "browser");
mkdirSync(stateDir);
mkdirSync(userDataDir);
const stateFile = join(stateDir, "tokens.json");
const endpointFile = join(userDataDir, "DevToolsActivePort");
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const oldEnv = Object.fromEntries(["WOLT_STATE_DIR", "WOLT_BEARER_TOKEN", "WOLT_REFRESH_TOKEN"].map((key) => [key, process.env[key]]));
process.env.WOLT_STATE_DIR = stateDir;
delete process.env.WOLT_BEARER_TOKEN;
delete process.env.WOLT_REFRESH_TOKEN;

const cookieToken = "browser-refresh-test-token";
const accessToken = "verified-access-test-token";
const rotatedToken = "rotated-refresh-test-token";
const oldState = { accessToken: "prior-access-test-token", refreshToken: "prior-refresh-test-token", rotatedRefreshToken: "prior-rotation-test-token" };
const woltTarget = { targetId: "shopping-tab", type: "page", url: "https://wolt.com/en/geo/batumi" };
const tokenCookie = { name: "__wrtoken", domain: ".wolt.com", value: cookieToken };
let scenario;

function reset(overrides = {}) {
  writeFileSync(endpointFile, "9222\n/devtools/browser/shopping-session\n");
  writeFileSync(stateFile, JSON.stringify(oldState));
  scenario = {
    targets: [woltTarget], cookies: [tokenCookie], sockets: [], fetches: [],
    ...overrides
  };
}

class MockWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  sent = [];
  closeCalls = 0;

  constructor(url) {
    super();
    this.url = url;
    scenario.sockets.push(this);
    queueMicrotask(() => {
      if (scenario.connect === "timeout") return;
      if (scenario.connect === "error") return this.emit("error");
      if (scenario.connect === "close") {
        this.readyState = MockWebSocket.CLOSED;
        return this.emit("close");
      }
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
    });
  }

  emit(type, data) {
    const event = new Event(type);
    if (data !== undefined) Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
    this[`on${type}`]?.(event);
  }

  send(payload) {
    const message = JSON.parse(payload);
    this.sent.push(message);
    let result;
    switch (message.method) {
      case "Target.getTargets":
        result = { targetInfos: scenario.targets };
        break;
      case "Target.attachToTarget":
        assert.equal(message.params.flatten, true);
        assert.ok(scenario.targets.some((target) => target.targetId === message.params.targetId));
        result = scenario.missingSession ? {} : { sessionId: "shopping-tab-session" };
        break;
      case "Network.getCookies":
        assert.equal(message.sessionId, "shopping-tab-session", "cookies must be requested through the selected tab's session");
        assert.deepEqual([...message.params.urls].sort(), ["https://wolt.com/", "https://www.wolt.com/"]);
        result = { cookies: scenario.cookies };
        break;
      default:
        assert.fail(`Unexpected browser command: ${message.method}`);
    }
    queueMicrotask(() => {
      if (scenario.stallMethod === message.method) return;
      if (scenario.closeMethod === message.method) {
        this.readyState = MockWebSocket.CLOSED;
        return this.emit("close");
      }
      const response = scenario.errorMethod === message.method
        ? { id: message.id, error: { code: -32000, message: "Permission denied" } }
        : { id: message.id, result };
      if (message.sessionId) response.sessionId = message.sessionId;
      if (scenario.wrongSessionMethod === message.method) response.sessionId = "unrelated-tab-session";
      this.emit("message", JSON.stringify(response));
    });
  }

  close() {
    this.closeCalls++;
    this.readyState = MockWebSocket.CLOSED;
    queueMicrotask(() => this.emit("close"));
  }
}

globalThis.WebSocket = MockWebSocket;
globalThis.fetch = async (url, init) => {
  scenario.fetches.push({ url, init });
  assert.equal(url, "https://authentication.wolt.com/v1/wauth2/access_token");
  assert.equal(init.method, "POST");
  assert.equal(init.body.get("grant_type"), "refresh_token");
  assert.equal(init.body.get("refresh_token"), cookieToken);
  if (scenario.refreshError) throw new Error("Connection interrupted");
  return new Response(JSON.stringify(scenario.refreshBody ?? { access_token: accessToken, refresh_token: rotatedToken }), {
    status: scenario.refreshStatus ?? 200
  });
};

const { existingChromeEndpoint, existingChromeLogin } = await import("../lib/existing-chrome.js");
const { getAccessToken } = await import("../lib/auth.js");
const login = () => existingChromeLogin({ userDataDir, timeoutMs: 30 });
const storedState = () => JSON.parse(readFileSync(stateFile, "utf8"));
function browserStayedOpen() {
  for (const socket of scenario.sockets) {
    assert.equal(socket.readyState, MockWebSocket.CLOSED, "the debugger connection must be released");
    assert.ok(socket.sent.every(({ method }) => !["Browser.close", "Target.closeTarget"].includes(method)), "login must never close the user's browser or tabs");
  }
}

try {
  for (const browserPath of ["/devtools/browser/shopping-session", "/devtools/browser"]) {
    reset();
    writeFileSync(endpointFile, `9222\n${browserPath}\n`);
    assert.equal(await existingChromeEndpoint(userDataDir), `ws://127.0.0.1:9222${browserPath}`);
  }

  for (const malformed of [
    "", "9222", "9222\n", "0\n/devtools/browser/session", "65536\n/devtools/browser/session",
    "9222junk\n/devtools/browser/session", "1e3\n/devtools/browser/session", "-1\n/devtools/browser/session",
    "9222\nws://remote.example/devtools/browser/session", "9222\n//remote.example/devtools/browser/session",
    "9222\n/devtools/browser/session?redirect=remote.example", "9222\n/devtools/browser/../session",
    "9222\n/devtools/browser/session\nextra", "9222\n/devtools/page/session"
  ]) {
    reset();
    writeFileSync(endpointFile, malformed);
    await assert.rejects(() => existingChromeEndpoint(userDataDir), undefined, `invalid endpoint must be rejected: ${JSON.stringify(malformed)}`);
    assert.equal(scenario.sockets.length, 0);
    assert.equal(scenario.fetches.length, 0);
  }

  reset();
  rmSync(endpointFile);
  await assert.rejects(() => login(), /Chrome|debug|remote/i);
  assert.equal(scenario.sockets.length, 0);
  assert.deepEqual(storedState(), oldState);

  for (const cookies of [
    [tokenCookie],
    [{ ...tokenCookie, domain: "www.wolt.com", value: `%22${cookieToken}%22` }],
    [tokenCookie, { ...tokenCookie, domain: ".www.wolt.com" }]
  ]) {
    reset({ cookies });
    const result = await login();
    assert.equal(result.via, "existing-chrome");
    assert.equal(result.tokenState.accessTokenStored, true);
    assert.equal(result.tokenState.refreshTokenStored, true);
    assert.equal(scenario.fetches.length, 1);
    assert.equal(scenario.sockets[0].url, "ws://127.0.0.1:9222/devtools/browser/shopping-session");
    assert.deepEqual(storedState(), { accessToken, refreshToken: cookieToken, rotatedRefreshToken: rotatedToken });
    for (const secret of [cookieToken, accessToken, rotatedToken]) assert.ok(!JSON.stringify(result).includes(secret), "the login response must not reveal credentials");
    assert.equal(scenario.sockets[0].closeCalls, 1);
    browserStayedOpen();
  }

  // A stale environment setting may belong to another Wolt account.
  const jwt = (sub, secondsLeft) => ["e30", Buffer.from(JSON.stringify({
    sub, exp: Math.floor(Date.now() / 1000) + secondsLeft
  })).toString("base64url"), "test-signature"].join(".");
  const chromeAccessToken = jwt("browser-account", 1800);
  process.env.WOLT_BEARER_TOKEN = jwt("previous-account", 3600);
  try {
    reset({ refreshBody: { access_token: chromeAccessToken, refresh_token: rotatedToken } });
    await login();
    assert.equal(await getAccessToken(), chromeAccessToken,
      "importing the browser account must supersede an environment token even when the latter expires later");
    assert.equal(storedState().accessToken, chromeAccessToken);
    assert.equal(scenario.fetches.length, 1);
    browserStayedOpen();
  } finally {
    delete process.env.WOLT_BEARER_TOKEN;
  }

  reset({
    targets: [{ ...woltTarget, targetId: "untrusted-tab", url: "https://wolt.com.evil.example/" }, woltTarget],
    cookies: [{ ...tokenCookie, domain: "wolt.com.evil.example", value: "unrelated-cookie" }, tokenCookie]
  });
  await login();
  assert.equal(scenario.sockets[0].sent.find(({ method }) => method === "Target.attachToTarget").params.targetId, woltTarget.targetId);
  assert.equal(scenario.fetches.length, 1);
  browserStayedOpen();

  for (const targets of [
    [],
    [{ ...woltTarget, type: "service_worker" }],
    [{ ...woltTarget, url: "http://wolt.com/" }],
    [{ ...woltTarget, url: "https://wolt.com.evil.example/" }],
    [{ ...woltTarget, url: "https://evilwolt.com/" }],
    [{ ...woltTarget, url: "https://accounts.wolt.com/" }],
    [{ ...woltTarget, url: "https://wolt.com@evil.example/" }],
    [{ ...woltTarget, url: "https://user:password@wolt.com/" }],
    [{ ...woltTarget, url: "not a url" }],
    [{ ...woltTarget, browserContextId: "profile-one" }, { ...woltTarget, targetId: "other-tab", browserContextId: "profile-two" }]
  ]) {
    reset({ targets });
    await assert.rejects(login);
    assert.equal(scenario.fetches.length, 0, "an untrusted or ambiguous target must not import a cookie");
    assert.deepEqual(storedState(), oldState);
    browserStayedOpen();
  }

  for (const cookies of [
    [],
    [{ ...tokenCookie, name: "unrelated_session" }],
    [{ ...tokenCookie, domain: "wolt.com.evil.example" }],
    [{ ...tokenCookie, domain: "evilwolt.com" }],
    [{ ...tokenCookie, domain: "accounts.wolt.com" }],
    [{ ...tokenCookie, value: "" }],
    [tokenCookie, { ...tokenCookie, domain: "www.wolt.com", value: "another-profile-token" }]
  ]) {
    reset({ cookies });
    await assert.rejects(login);
    assert.equal(scenario.fetches.length, 0);
    assert.deepEqual(storedState(), oldState);
    browserStayedOpen();
  }

  for (const failure of [
    { connect: "error" }, { connect: "close" }, { connect: "timeout" },
    { errorMethod: "Target.getTargets" }, { errorMethod: "Target.attachToTarget" }, { errorMethod: "Network.getCookies" },
    { closeMethod: "Target.getTargets" }, { stallMethod: "Network.getCookies" },
    { wrongSessionMethod: "Network.getCookies" }, { missingSession: true }
  ]) {
    reset(failure);
    await assert.rejects(login);
    assert.equal(scenario.fetches.length, 0);
    assert.deepEqual(storedState(), oldState);
    browserStayedOpen();
  }

  for (const failure of [
    { refreshStatus: 401, refreshBody: { error: cookieToken } },
    { refreshStatus: 503, refreshBody: { error: cookieToken } },
    { refreshBody: { refresh_token: rotatedToken } },
    { refreshError: true }
  ]) {
    reset(failure);
    await assert.rejects(login, (error) => {
      for (const secret of [cookieToken, accessToken, rotatedToken]) assert.ok(!error.message.includes(secret), "failed imports must not expose tokens in errors");
      return true;
    });
    assert.deepEqual(storedState(), oldState, "a failed refresh must preserve the previous token chain");
    assert.equal(scenario.fetches.length, 1, "do not retry or refresh the previous account during import");
    browserStayedOpen();
  }

  console.log("existing-chrome.test.mjs: offline browser login, origin filtering, cleanup, and token preservation checks passed");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testDir, { recursive: true, force: true });
}
