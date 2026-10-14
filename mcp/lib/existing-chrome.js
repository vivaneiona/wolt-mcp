// Chrome 144+ exposes an opt-in WebSocket endpoint for its ordinary profile.
// Chrome asks the user to allow the connection; no cookie database is opened.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connectRefreshToken } from "./auth.js";

function chromeUserDataDir() {
  if (process.env.WOLT_CHROME_USER_DATA_DIR) return process.env.WOLT_CHROME_USER_DATA_DIR;
  if (process.platform === "darwin") return join(homedir(), "Library/Application Support/Google/Chrome");
  if (process.platform === "win32") {
    if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is unavailable; set WOLT_CHROME_USER_DATA_DIR to Chrome's user data directory.");
    return join(process.env.LOCALAPPDATA, "Google/Chrome/User Data");
  }
  return join(process.env.CHROME_CONFIG_HOME || process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "google-chrome");
}

export async function existingChromeEndpoint(userDataDir = chromeUserDataDir()) {
  let metadata;
  try {
    metadata = await readFile(join(userDataDir, "DevToolsActivePort"), "utf8");
  } catch (error) {
    if (["EACCES", "EPERM"].includes(error.code)) {
      throw new Error("The operating system denied access to Chrome's DevToolsActivePort. Allow the MCP host application access to Google Chrome in the OS privacy settings, then retry.");
    }
    throw new Error("Chrome's connection metadata is unavailable. Open Chrome 144+, enable remote debugging at chrome://inspect/#remote-debugging yourself, and leave a signed-in https://wolt.com tab open. For a custom user data directory, set WOLT_CHROME_USER_DATA_DIR.");
  }
  const lines = metadata.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const [port, path] = lines;
  if (lines.length !== 2 || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 ||
      !/^\/devtools\/browser(?:\/[A-Za-z0-9_-]+)?$/.test(path)) {
    throw new Error("Chrome's DevToolsActivePort is malformed; no connection was attempted.");
  }
  return `ws://127.0.0.1:${Number(port)}${path}`;
}

function isWoltPage(target) {
  try {
    const url = new URL(target.url);
    return target.type === "page" && url.protocol === "https:" &&
      ["wolt.com", "www.wolt.com"].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

async function readRefreshCookie(endpoint, timeoutMs) {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  let nextId = 0;
  let rejectOpen;
  let stopped = false;
  const opened = new Promise((resolve, reject) => {
    rejectOpen = reject;
    socket.onopen = resolve;
  });
  const fail = (message) => {
    stopped = true;
    const error = new Error(message);
    rejectOpen(error);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  socket.onerror = () => fail("Could not connect to the existing Chrome session. Check remote debugging and approve Chrome's connection prompt yourself.");
  socket.onclose = () => fail("Chrome closed or declined the connection. Approve Chrome's connection prompt yourself to use the existing Wolt session.");
  socket.onmessage = ({ data }) => {
    let reply;
    try { reply = JSON.parse(data); } catch { return; }
    const request = pending.get(reply.id);
    if (!request || reply.sessionId !== request.sessionId) return;
    pending.delete(reply.id);
    if (reply.error) request.reject(new Error(`Chrome rejected ${request.method} (CDP ${reply.error.code ?? "error"}).`));
    else request.resolve(reply.result || {});
  };
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (stopped) return reject(new Error("The Chrome connection is no longer available."));
    const id = ++nextId;
    pending.set(id, { resolve, reject, method, sessionId });
    try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
    catch { pending.delete(id); reject(new Error(`Could not send ${method} to Chrome.`)); }
  });
  const timer = setTimeout(() => fail("Timed out waiting for Chrome. Enable remote debugging and approve the connection prompt yourself, then retry."), timeoutMs);
  try {
    await opened;
    const { targetInfos } = await call("Target.getTargets");
    const pages = (targetInfos || []).filter(isWoltPage);
    if (!pages.length) throw new Error("No https://wolt.com tab is open in the Chrome profile shared by remote debugging. Open Wolt in that profile, then retry.");
    if (new Set(pages.map((page) => page.browserContextId)).size > 1) {
      throw new Error("Wolt tabs are open in multiple browser contexts. Leave Wolt open only in the intended profile/context, then retry.");
    }
    const { sessionId } = await call("Target.attachToTarget", { targetId: pages[0].targetId, flatten: true });
    if (!sessionId) throw new Error("Chrome did not provide a session for the Wolt tab.");
    const { cookies } = await call("Network.getCookies", { urls: ["https://wolt.com/", "https://www.wolt.com/"] }, sessionId);
    const values = [...new Set((cookies || []).filter((cookie) => cookie.name === "__wrtoken" &&
      ["wolt.com", "www.wolt.com"].includes((cookie.domain || "").replace(/^\./, "")) &&
      typeof cookie.value === "string" && cookie.value).map((cookie) => cookie.value))];
    if (values.length !== 1) throw new Error(values.length
      ? "Multiple Wolt login cookies were found; the account is ambiguous. Use the separate browser login instead."
      : "The shared Chrome profile has no Wolt refresh cookie. Sign into Wolt in that profile, then retry.");
    return values[0];
  } finally {
    clearTimeout(timer);
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    // Disconnect only. Never close or navigate the user's browser or tabs.
    socket.close();
  }
}

export async function existingChromeLogin({ userDataDir, timeoutMs = 120000 } = {}) {
  const endpoint = await existingChromeEndpoint(userDataDir);
  const refreshToken = await readRefreshCookie(endpoint, timeoutMs);
  const tokenState = await connectRefreshToken(refreshToken);
  return { via: "existing-chrome", tokenState };
}
