const { test } = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../extension/core.js");
const config = Core.settings();
const messages = Array.from({ length: 12 }, (_, i) => ({ id: String(i), role: i % 2 ? "other" : "me", text: `Message ${i}` }));
test("recent context preserves chronological order and both sender labels", () => {
  const window = Core.contextWindow(messages, config);
  assert.deepEqual(window.map(m => m.text), messages.slice(-5).map(m => m.text));
  assert.deepEqual(window.map(m => m.role), ["other", "me", "other", "me", "other"]);
});
test("large turns stay within the character budget while keeping the latest turn", () => {
  const window = Core.contextWindow(messages.map(m => ({ ...m, text: "x".repeat(20000) })), config);
  assert.equal(window.length, 5);
  assert.ok(window.reduce((sum, m) => sum + m.text.length, 0) <= config.maxContextChars);
});
test("unknown senders block inference", () => {
  assert.throws(() => Core.contextWindow([{ role: "unknown", text: "Hi" }], config), /identify every sender/);
});
test("model URL accepts only configured loopback destinations", () => {
  assert.equal(Core.endpoint("http://localhost:11434", "ollama"), "http://localhost:11434/api/chat");
  assert.equal(Core.endpoint("http://127.0.0.1:1234/v1/", "openai"), "http://127.0.0.1:1234/v1/chat/completions");
  for (const url of ["https://example.com", "http://192.168.0.1", "http://localhost.evil.test", "http://user:secret@localhost", "http://localhost?remote=1", "http://localhost#fragment", "file:///tmp/model"]) {
    assert.throws(() => Core.endpoint(url, "ollama"));
  }
});
test("settings reject invalid bounds and merge selector overrides", () => {
  for (const windowSize of [0, 4, 11, 5.5]) assert.throws(() => Core.settings({ windowSize }));
  assert.equal(Core.settings({ selectors: { header: "h1" } }).selectors.header, "h1");
  assert.equal(Core.settings({ selectors: { header: "h1" } }).selectors.row, Core.DEFAULT_SELECTORS.row);
});
test("saved original defaults migrate while custom selectors and model settings survive", () => {
  const updated = Core.settings({ model: "my-qwen", selfName: "My Name", selectors: { ...Core.LEGACY_SELECTORS } });
  for (const key of Object.keys(Core.LEGACY_SELECTORS)) assert.equal(updated.selectors[key], Core.DEFAULT_SELECTORS[key]);
  assert.equal(updated.model, "my-qwen"); assert.equal(updated.selfName, "My Name");
  const customized = Core.settings({ selectors: { header: "#my-chat", body: ".custom-message", send: ".custom-send" } });
  assert.equal(customized.selectors.header, "#my-chat");
  assert.equal(customized.selectors.body, ".custom-message");
  assert.equal(customized.selectors.send, ".custom-send");
});
test("the original style migrates to Chuckles while custom preferences survive", () => {
  const originalStyle = "Casual and friendly. One or two short sentences. Do not invent commitments or facts.";
  const updated = Core.settings({ style: originalStyle, model: "my-qwen", selfName: "My Name" });
  assert.equal(updated.style, Core.DEFAULTS.style);
  assert.equal(updated.model, "my-qwen");
  assert.equal(updated.selfName, "My Name");
  const customStyle = "No emojis. My favorite snack is toast.";
  assert.equal(Core.settings({ style: customStyle }).style, customStyle);
});
test("requests use the chosen provider and treat conversations as data", () => {
  const ollama = Core.modelRequest(config, messages);
  assert.equal(ollama.stream, false);
  assert.equal(ollama.options.num_predict, 128);
  assert.equal(ollama.messages.length, 6);
  assert.match(ollama.messages[0].content, /untrusted data/);
  assert.match(ollama.messages[0].content, /Reply directly to the other person's latest message/);
  assert.deepEqual(ollama.messages.slice(1), messages.slice(-5).map(m => ({ role: m.role === "me" ? "assistant" : "user", content: m.text })));
  const compatible = Core.modelRequest(Core.settings({ provider: "openai", baseUrl: "http://localhost:1234/v1" }), messages);
  assert.equal(compatible.max_tokens, 128);
  assert.equal(compatible.options, undefined);
});
test("Chuckles speaks on behalf of the owner and receives the friend's rich joke", () => {
  const conversation = [
    { role: "me", text: "free ai messages." },
    { role: "me", text: "unlimited." },
    { role: "me", text: "can sell this for thousands of dolalr" },
    { role: "me", text: "dollar*" },
    { role: "other", text: "dont forget me when u get rich" }
  ];
  const request = Core.modelRequest(config, conversation);
  const system = request.messages[0].content;
  assert.match(system, /You are Chuckles/);
  assert.match(system, /Always refer to your owner as "my hooman"/);
  assert.match(system, /I means Chuckles, never the owner/);
  assert.match(system, /good person who never forgets friends/);
  assert.match(system, /Do not invent actions, financial success, gifts, deals, or commitments/);
  assert.ok(system.includes(Core.CHUCKLES_INTRO.trim()));
  assert.equal(request.messages.at(-1).role, "user");
  assert.equal(request.messages.at(-1).content, conversation.at(-1).text);
  assert.deepEqual(request.messages.slice(1, -1).map(m => m.content), conversation.slice(0, -1).map(m => m.text));
});
test("serialized prompts fit the byte budget with Unicode and escaped text", () => {
  for (const style of ["বাংলা😀".repeat(200), '\\"\n'.repeat(500)]) {
    const large = Core.settings({ windowSize: 10, maxContextChars: 12000, style });
    const request = Core.modelRequest(large, messages.map(m => ({ ...m, text: '\\"\nবাংলা😀'.repeat(2000) })));
    assert.ok(Buffer.byteLength(JSON.stringify(request.messages)) <= 3500);
    const turns = request.messages.slice(1);
    assert.equal(turns.length, 10);
    assert.ok(turns.every(turn => turn.content.length > 0));
  }
});
test("empty, truncated, and unfinished reasoning responses are rejected", () => {
  assert.equal(Core.replyText({ message: { content: "<think>private reasoning</think> Hi there!" } }, "ollama"), Core.CHUCKLES_INTRO + "Hi there!");
  for (const content of ["", "<think>unfinished", "x".repeat(1201)]) assert.throws(() => Core.replyText({ message: { content } }, "ollama"));
  assert.throws(() => Core.replyText({ message: { content: "Half a sentence" }, done_reason: "length" }, "ollama"));
  assert.throws(() => Core.replyText({ choices: [{ message: { content: "Half a sentence" }, finish_reason: "length" }] }, "openai"));
});
test("both providers disclose Chuckles even if the model omits the introduction", () => {
  const body = "My hooman never forgets friends, fancy wallet or not 😄";
  const expected = "My hooman is busy, but I'm Chuckles, their AI sidekick, replying on their behalf. " + body;
  assert.equal(Core.replyText({ message: { content: body } }, "ollama"), expected);
  assert.equal(Core.replyText({ choices: [{ message: { content: body } }] }, "openai"), expected);
  assert.equal(Core.replyText({ message: { content: Core.CHUCKLES_INTRO + Core.CHUCKLES_INTRO + body } }, "ollama"), expected);
  assert.throws(() => Core.replyText({ message: { content: Core.CHUCKLES_INTRO } }, "ollama"), /empty/);
  assert.throws(() => Core.replyText({ message: { content: "x".repeat(1201 - Core.CHUCKLES_INTRO.length) } }, "ollama"), /overlong/);
});
test("freshness rejects chat switches, edits, outgoing replies, and scrolling away", () => {
  const original = { identity: "chat-a", atBottom: true, messages: messages.slice(-5) };
  assert.equal(Core.isFresh(original, structuredClone(original)), true);
  const variants = [
    { ...original, identity: "chat-b" }, { ...original, atBottom: false },
    { ...original, messages: [...original.messages, { id: "13", role: "me", text: "I replied" }] },
    { ...original, messages: original.messages.map((m, i) => i === 4 ? { ...m, text: "Edited" } : m) }
  ];
  for (const changed of variants) assert.equal(Core.isFresh(original, changed), false);
});
