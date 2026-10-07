"use strict";
importScripts("core.js");
const Core = TeamsReplyCore;
const TEAMS_HOSTS = new Set(["teams.microsoft.com", "teams.cloud.microsoft", "teams.live.com"]);
const capabilityCache = new Map();
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
  const mine = owner?.tabId === sender.tab.id && (owner?.token === token ||
    claim && sender.documentId && owner?.documentId !== sender.documentId);
  if (!mine && (!claim || owner?.expires > Date.now())) {
    throw new Error("Another Teams window is active, or this session expired. Pause it before starting here.");
  }
  await chrome.storage.session.set({ owner: { tabId: sender.tab.id, documentId: sender.documentId, token, expires: Date.now() + 90000 } });
}
async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function infer(config, messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    let vision = config.vision === "on";
    if (config.vision === "auto" && config.provider === "ollama" && messages.some(m => m.media?.some(item => item.data))) {
      const cacheKey = config.baseUrl + config.model;
      if (!capabilityCache.has(cacheKey)) {
        try {
          const showUrl = Core.endpoint(config.baseUrl, "ollama").replace(/\/api\/chat$/, "/api/show");
          const show = await fetch(showUrl, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: config.model }), signal: controller.signal, redirect: "error", credentials: "omit" });
          if (show.ok) capabilityCache.set(cacheKey, (await show.json()).capabilities?.includes("vision") === true);
        } catch (error) { if (controller.signal.aborted) throw error; }
      }
      vision = capabilityCache.get(cacheKey) === true;
    }
    const payload = Core.modelRequest({ ...config, vision: vision ? "on" : "off" }, messages);
    const fetchReply = async body => {
      const response = await fetch(Core.endpoint(config.baseUrl, config.provider), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
        redirect: "error", credentials: "omit"
      });
      if (!response.ok) {
        if (response.status === 403 && config.provider === "ollama") {
          const origin = chrome.runtime.getURL("").replace(/\/$/, "");
          throw new Error(`Ollama rejected this extension's origin (${origin}). Add ${origin} to OLLAMA_ORIGINS in the running Ollama server and restart it. See Settings for your extension origin.`);
        }
        throw new Error(`Local server returned HTTP ${response.status}. Check the URL, model ID, and server access settings.`);
      }
      return Core.replyText(await response.json(), config.provider, messages);
    };
    let reply = await fetchReply(payload);
    const language = Core.replyLanguage(messages);
    if (language.startsWith("Banglish")) {
      const body = reply;
      if (Core.replyLanguage([{ role: "other", text: body }]) !== language || /[\u0980-\u09ff]/.test(body)) {
        payload.messages[0].content += " STRICT LANGUAGE CHECK: The previous response used the wrong language. Write Bangla words in Latin letters (Banglish), matching the incoming wording. Do not use English sentences or Bangla script.";
        reply = await fetchReply(payload);
        const corrected = reply;
        if (Core.replyLanguage([{ role: "other", text: corrected }]) !== language || /[\u0980-\u09ff]/.test(corrected)) {
          throw new Error("The model kept replying in the wrong language. Try a model with stronger Banglish support; no message was sent.");
        }
      }
    }
    return reply;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Local model timed out after 60 seconds. Warm up the model, then retry manually.");
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
  let config = Core.settings(raw);
  if (message.type === "test") {
    if (sender.tab) throw new Error("Test the model from settings.");
    return { reply: await infer(config, [{ role: "other", text: "Hi! Can you say hello in one short sentence?" }]) };
  }
  if (!["generate", "attempted"].includes(message.type) || !sender.tab) throw new Error("Unknown request.");
  if (message.isGroup !== undefined && typeof message.isGroup !== "boolean") throw new Error("Invalid conversation type.");
  config = Core.conversationConfig(config, message.isGroup === true);
  const messages = message.messages;
  if (!Array.isArray(messages) || messages.length > config.windowSize || messages.some(m =>
    !m || typeof m.id !== "string" || m.id.length > 300 || typeof m.text !== "string" || m.text.length > config.maxContextChars ||
    m.author !== undefined && (typeof m.author !== "string" || !Core.normalize(m.author) || m.author.length > 200) ||
    config.isGroup && !m.author ||
    !["me", "other"].includes(m.role) || m.media !== undefined && (!Array.isArray(m.media) || m.media.length > 4 || m.media.some(item =>
      !item || !["image", "GIF", "attachment"].includes(item.kind) || typeof item.label !== "string" || item.label.length > 500 ||
      item.data !== undefined && (typeof item.data !== "string" || item.data.length > 200000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(item.data))))) || messages.at(-1)?.role !== "other" ||
    typeof message.identity !== "string" || message.identity.length > 1000) throw new Error("Invalid conversation window.");
  if (messages.flatMap(m => m.media || []).reduce((sum, item) => sum + (item.data?.length || 0), 0) > 2000000) throw new Error("Image context is too large.");
  const key = await digest(JSON.stringify([message.identity, messages.at(-1).id, messages.at(-1).text]));
  if (message.type === "attempted") {
    await serial(() => ownership(sender, message.token));
    const { ledger = [] } = await chrome.storage.local.get("ledger");
    return { attempted: ledger.includes(key) };
  }
  await serial(async () => {
    await ownership(sender, message.token);
    const { ledger = [] } = await chrome.storage.local.get("ledger");
    const { flight } = await chrome.storage.session.get("flight");
    if (flight?.expires > Date.now()) throw new Error("A reply is already being generated.");
    if (ledger.includes(key) && message.manual !== true) throw new Error("This message was already attempted. Wait for a new message or generate manually.");
    // Reserve before inference. A failed or uncertain attempt is never silently retried.
    await chrome.storage.local.set({ ledger: [...ledger.slice(-499), key] });
    await chrome.storage.session.set({ flight: { key, expires: Date.now() + 65000 } });
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
