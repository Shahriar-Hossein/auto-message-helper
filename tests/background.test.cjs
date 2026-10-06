const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const Core = require("../extension/core.js");
function harness(fetchImpl) {
  const data = { config: Core.settings() };
  let listener;
  let requests = 0;
  const storage = {
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])),
    set: async values => Object.assign(data, structuredClone(values)),
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  };
  const chrome = {
    action: { onClicked: { addListener() {} } }, storage: { session: storage, local: storage },
    runtime: { id: "test-extension", getURL: file => `chrome-extension://test-extension/${file}`,
      openOptionsPage: async () => {}, onMessage: { addListener: callback => { listener = callback; } } }
  };
  const sandbox = { chrome, TeamsReplyCore: Core, importScripts() {}, crypto: webcrypto, TextEncoder, URL, AbortController, setTimeout, clearTimeout,
    fetch: async (...args) => { requests++; return fetchImpl ? fetchImpl(...args) : { ok: true, json: async () => ({ message: { content: "Hello!" } }) }; } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../extension/background.js"), "utf8"), sandbox);
  const sender = { id: chrome.runtime.id, tab: { id: 1 }, frameId: 0, url: "https://teams.microsoft.com/v2/" };
  const send = (message, from = sender) => new Promise(resolve => listener(message, from, resolve));
  const payload = { type: "generate", token: "a", identity: "chat-a", messages: [{ id: "1", role: "other", text: "Hello" }] };
  return { send, sender, payload, data, requests: () => requests };
}
test("only Teams top frames and extension settings can use the worker", async () => {
  const h = harness();
  for (const sender of [{ ...h.sender, frameId: 1 }, { ...h.sender, url: "https://evil.test" }, { ...h.sender, id: "different" }, { id: h.sender.id, url: "https://teams.microsoft.com" }]) {
    assert.equal((await h.send({ type: "claim", token: "a" }, sender)).ok, false);
  }
  assert.equal(h.requests(), 0);
});
test("one Teams window owns the active controller", async () => {
  const h = harness();
  assert.equal((await h.send({ type: "claim", token: "a" })).ok, true);
  const other = { ...h.sender, tab: { id: 2 } };
  assert.equal((await h.send({ type: "claim", token: "b" }, other)).ok, false);
  await h.send({ type: "release", token: "b" }, other);
  assert.equal(h.data.owner.tabId, 1);
  await h.send({ type: "release", token: "a" });
  assert.equal((await h.send({ type: "claim", token: "b" }, other)).ok, true);
});
test("automatic duplicate attempts are blocked; an explicit manual draft can retry", async () => {
  const h = harness();
  await h.send({ type: "claim", token: "a" });
  assert.equal((await h.send(h.payload)).reply, Core.CHUCKLES_INTRO + "Hello!");
  assert.equal((await h.send(h.payload)).ok, false);
  assert.equal(h.requests(), 1);
  assert.equal((await h.send({ ...h.payload, manual: true })).ok, true);
  assert.equal(h.requests(), 2);
});
test("failed inference stays reserved and is not automatically retried", async () => {
  const h = harness(async () => ({ ok: false, status: 503 }));
  await h.send({ type: "claim", token: "a" });
  assert.match((await h.send(h.payload)).error, /503/);
  assert.equal((await h.send(h.payload)).ok, false);
  assert.equal(h.requests(), 1);
  assert.equal(h.data.flight, undefined);
});
test("Ollama 403 identifies the exact extension origin and server-side fix", async () => {
  const h = harness(async () => ({ ok: false, status: 403 }));
  await h.send({ type: "claim", token: "a" });
  const result = await h.send(h.payload);
  assert.equal(result.ok, false);
  assert.match(result.error, /chrome-extension:\/\/test-extension/);
  assert.match(result.error, /OLLAMA_ORIGINS/);
  assert.match(result.error, /restart/);
  assert.equal((await h.send(h.payload)).ok, false);
  assert.equal(h.requests(), 1);
});
test("concurrent generations serialize reservation and allow only one fetch", async () => {
  let resolveFetch;
  const h = harness(() => new Promise(resolve => { resolveFetch = resolve; }));
  await h.send({ type: "claim", token: "a" });
  const first = h.send(h.payload);
  while (!resolveFetch) await new Promise(resolve => setImmediate(resolve));
  const second = await h.send({ ...h.payload, messages: [{ id: "2", role: "other", text: "Another" }] });
  assert.equal(second.ok, false);
  assert.match(second.error, /already being generated/);
  resolveFetch({ ok: true, json: async () => ({ message: { content: "Hello!" } }) });
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(result.reply, Core.CHUCKLES_INTRO + "Hello!");
  assert.equal(h.requests(), 1);
});
test("invalid or outgoing context never reaches the local API", async () => {
  const h = harness();
  await h.send({ type: "claim", token: "a" });
  for (const messages of [[], [{ id: "1", text: "Hi", role: "me" }], [{ id: "1", text: "Hi", role: "unknown" }], [{ text: "Hi", role: "other" }]]) {
    assert.equal((await h.send({ ...h.payload, messages })).ok, false);
  }
  assert.equal(h.requests(), 0);
});
test("network requests forbid redirects and avoid credentials", async () => {
  let seen;
  const h = harness(async (url, options) => { seen = { url, options }; return { ok: true, json: async () => ({ message: { content: "Hello" } }) }; });
  await h.send({ type: "claim", token: "a" }); await h.send(h.payload);
  assert.equal(seen.url, "http://127.0.0.1:11434/api/chat");
  assert.equal(seen.options.redirect, "error"); assert.equal(seen.options.credentials, "omit");
  assert.equal(h.data.ledger[0].length, 64);
  assert.equal(JSON.stringify(h.data.ledger).includes("Hello"), false);
});
test("the worker sends actual recent messages as the model conversation", async () => {
  let body;
  const h = harness(async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ message: { content: "Yes, send me the report." } }) };
  });
  await h.send({ type: "claim", token: "a" });
  const messages = [
    { id: "1", role: "other", text: "Do you have time to review the report?" },
    { id: "2", role: "me", text: "Yes, I have time this afternoon." },
    { id: "3", role: "other", text: "Should I send it now?\nIt is ready." }
  ];
  const result = await h.send({ ...h.payload, messages });
  assert.equal(result.ok, true);
  assert.equal(result.reply, Core.CHUCKLES_INTRO + "Yes, send me the report.");
  assert.deepEqual(body.messages.slice(1), messages.map(m => ({ role: m.role === "me" ? "assistant" : "user", content: m.text })));
  assert.equal(body.messages.at(-1).content, messages.at(-1).text);
});
test("the worker accepts twenty messages and rejects larger or malformed media contexts", async () => {
  const h = harness(); await h.send({ type: "claim", token: "a" });
  const messages = Array.from({ length: 20 }, (_, i) => ({ id: String(i), role: i % 2 ? "other" : "me", text: `Turn ${i}` }));
  assert.equal((await h.send({ ...h.payload, messages })).ok, true);
  assert.equal((await h.send({ ...h.payload, messages: [...messages, messages[0]] })).ok, false);
  for (const media of [[{ kind: "image", label: "x", data: "https://example.com/private" }], [{ kind: "script", label: "x" }], [{ kind: "image", label: "x".repeat(501) }]]) {
    assert.equal((await h.send({ ...h.payload, messages: [{ id: "invalid", role: "other", text: "", media }] })).ok, false);
  }
  assert.equal(h.requests(), 1);
});
test("saved attempt checks skip previous replies without inference", async () => {
  const h = harness(); await h.send({ type: "claim", token: "a" });
  assert.equal((await h.send({ ...h.payload, type: "attempted" })).attempted, false);
  await h.send(h.payload);
  assert.equal((await h.send({ ...h.payload, type: "attempted" })).attempted, true);
  assert.equal(h.requests(), 1);
});
test("a reloaded document can reclaim its own tab without displacing another tab", async () => {
  const h = harness();
  await h.send({ type: "claim", token: "a" }, { ...h.sender, documentId: "old" });
  assert.equal((await h.send({ type: "claim", token: "new" }, { ...h.sender, documentId: "new" })).ok, true);
  assert.equal((await h.send({ type: "heartbeat", token: "a" }, { ...h.sender, documentId: "old" })).ok, false);
  assert.equal((await h.send({ type: "claim", token: "other" }, { ...h.sender, tab: { id: 2 }, documentId: "another" })).ok, false);
});
test("wrong-language Banglish output is retried with strict guidance", async () => {
  const bodies = [];
  const h = harness(async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ message: { content: bodies.length === 1 ? "Your owner is busy right now." : "My hooman ekhon busy, bolo ki lagbe 😄" } }) };
  });
  await h.send({ type: "claim", token: "a" });
  const result = await h.send({ ...h.payload, messages: [{ id: "banglish", role: "other", text: "ki korcho?" }] });
  assert.equal(result.ok, true); assert.equal(h.requests(), 2);
  assert.match(bodies[1].messages[0].content, /STRICT LANGUAGE CHECK/);
  assert.ok(result.reply.startsWith(Core.introduction("Banglish")));
});
test("persistent wrong-language output is rejected rather than sent", async () => {
  const h = harness(); await h.send({ type: "claim", token: "a" });
  const result = await h.send({ ...h.payload, messages: [{ id: "banglish", role: "other", text: "tumi kemon acho?" }] });
  assert.equal(result.ok, false); assert.match(result.error, /wrong language/); assert.equal(h.requests(), 2);
});
test("Ollama detects vision support and attaches pixels only for a vision model", async () => {
  for (const vision of [true, false]) {
    let body;
    const h = harness(async (url, options) => {
      if (url.endsWith("/api/show")) return { ok: true, json: async () => ({ capabilities: vision ? ["completion", "vision"] : ["completion"] }) };
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ message: { content: "Nice photo!" } }) };
    });
    await h.send({ type: "claim", token: "a" });
    const result = await h.send({ ...h.payload, messages: [{ id: "image", role: "other", text: "", media: [{ kind: "image", label: "photo", data: "data:image/jpeg;base64,aGVsbG8=" }] }] });
    assert.equal(result.ok, true); assert.equal(h.requests(), 2);
    assert.deepEqual(body.messages.at(-1).images, vision ? ["aGVsbG8="] : undefined);
    assert.match(body.messages.at(-1).content, /\[image: photo\]/);
  }
});
