"use strict";
importScripts("core.js");
const Core = TeamsReplyCore;
const TEAMS_HOSTS = new Set(["teams.microsoft.com", "teams.cloud.microsoft", "teams.live.com"]);
let queue = Promise.resolve();
const serial = task => {
  const next = queue.then(task);
  queue = next.catch(() => {});
  return next;
};
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
function trusted(sender) {
  if (sender.id !== chrome.runtime.id) throw new Error("Untrusted extension request.");
  if (sender.tab) {
    const url = new URL(sender.url);
    if (sender.frameId !== 0 || url.protocol !== "https:" || !TEAMS_HOSTS.has(url.hostname)) throw new Error("Use the main Teams page.");
  } else if (sender.url !== chrome.runtime.getURL("options.html")) {
    throw new Error("Use the extension settings page.");
  }
}
async function ownership(sender, token, claim = false) {
  if (!sender.tab || typeof token !== "string" || token.length > 100) throw new Error("Invalid controller.");
  const { owner } = await chrome.storage.session.get("owner");
  const mine = owner?.tabId === sender.tab.id && owner?.token === token;
  if (!mine && (!claim || owner?.expires > Date.now())) {
    throw new Error("Another Teams window is active, or this session expired. Pause it before starting here.");
  }
  await chrome.storage.session.set({ owner: { tabId: sender.tab.id, token, expires: Date.now() + 45000 } });
}
async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function infer(config, messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(Core.endpoint(config.baseUrl, config.provider), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Core.modelRequest(config, messages)), signal: controller.signal,
      redirect: "error", credentials: "omit"
    });
    if (!response.ok) throw new Error(`Local server returned HTTP ${response.status}. Check the URL, model ID, and server origin settings.`);
    return Core.replyText(await response.json(), config.provider);
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Local model timed out after 25 seconds. Warm up the model, then retry manually.");
    if (error instanceof TypeError) throw new Error("Cannot reach the local model. Check that the server is running and allows this extension's origin.");
    throw error;
  } finally { clearTimeout(timeout); }
}
async function handle(message, sender) {
  trusted(sender);
  if (message.type === "settings") { await chrome.runtime.openOptionsPage(); return {}; }
  if (message.type === "claim" || message.type === "heartbeat") {
    await serial(() => ownership(sender, message.token, message.type === "claim")); return {};
  }
  if (message.type === "release") {
    await serial(async () => {
      const { owner } = await chrome.storage.session.get("owner");
      if (owner?.tabId === sender.tab?.id && owner?.token === message.token) await chrome.storage.session.remove("owner");
    });
    return {};
  }
  const { config: raw } = await chrome.storage.local.get("config");
  const config = Core.settings(raw);
  if (message.type === "test") {
    if (sender.tab) throw new Error("Test the model from settings.");
    return { reply: await infer(config, [{ role: "other", text: "Hi! Can you say hello in one short sentence?" }]) };
  }
  if (message.type !== "generate" || !sender.tab) throw new Error("Unknown request.");
  const messages = message.messages;
  if (!Array.isArray(messages) || messages.length > 10 || messages.some(m =>
    typeof m.id !== "string" || m.id.length > 300 || typeof m.text !== "string" || m.text.length > 12000 ||
    !["me", "other"].includes(m.role)) || messages.at(-1)?.role !== "other" ||
    typeof message.identity !== "string" || message.identity.length > 1000) throw new Error("Invalid conversation window.");
  const key = await digest(JSON.stringify([message.identity, messages.at(-1).id, messages.at(-1).text]));
  await serial(async () => {
    await ownership(sender, message.token);
    const { ledger = [], flight } = await chrome.storage.session.get(["ledger", "flight"]);
    if (flight?.expires > Date.now()) throw new Error("A reply is already being generated.");
    if (ledger.includes(key) && message.manual !== true) throw new Error("This message was already attempted. Wait for a new message or generate manually.");
    // Reserve before inference. A failed or uncertain attempt is never silently retried.
    await chrome.storage.session.set({ ledger: [...ledger.slice(-199), key], flight: { key, expires: Date.now() + 30000 } });
  });
  try { return { reply: await infer(config, messages) }; }
  finally {
    await serial(async () => {
      const { flight } = await chrome.storage.session.get("flight");
      if (flight?.key === key) await chrome.storage.session.remove("flight");
    });
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(data => respond({ ok: true, ...data }), error => respond({ ok: false, error: error.message }));
  return true;
});
