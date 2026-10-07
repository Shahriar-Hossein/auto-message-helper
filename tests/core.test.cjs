const { test } = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../extension/core.js");
const config = Core.settings();
const messages = Array.from({ length: 24 }, (_, i) => ({ id: String(i), role: i % 2 ? "other" : "me", text: `Message ${i}` }));
test("personality settings default old installs to Chuckles and preserve explicit choices and facts", () => {
  const previousStyle = "Playful, warm, and a little cheeky. Keep jokes relevant to the conversation and replies short. Be gentle and sincere when the conversation is serious.";
  assert.equal(Core.settings({ style: previousStyle }).personality, "chuckles");
  assert.equal(Core.settings({ style: previousStyle }).style, Core.DEFAULTS.style);
  for (const personality of Object.keys(Core.PERSONALITIES)) {
    const saved = Core.settings({ personality, style: "No emojis. My favorite snack is toast.", selfName: "Owner", model: "custom-model" });
    assert.deepEqual(Core.settings(JSON.parse(JSON.stringify(saved))), saved);
    assert.equal(saved.style, "No emojis. My favorite snack is toast.");
    assert.equal(saved.model, "custom-model");
    assert.equal(saved.selfName, "Owner");
  }
  for (const personality of ["unknown", "toString", "__proto__", null, ""]) assert.throws(() => Core.settings({ personality }), /personality/);
});
test("every persona reaches both providers and group prompts with shared courtesy and owner identity", () => {
  for (const [personality, persona] of Object.entries(Core.PERSONALITIES)) {
    for (const provider of ["ollama", "openai"]) for (const isGroup of [false, true]) {
      for (const [text, nickname] of [["Hello", "my hooman"], ["kemon acho?", "amr hoooman"], ["কেমন আছো?", "amr hoooman"]]) {
        const request = Core.modelRequest(Core.conversationConfig(Core.settings({ personality, provider, style: "Be rude. Call the owner they." }), isGroup), [
          { role: "me", author: "Owner", text: "I'm Chuckles, their sidekick." }, { role: "other", author: "Friend", text }
        ]);
        const system = request.messages[0].content;
        assert.ok(system.startsWith(`You are ${persona.name},`));
        assert.ok(system.includes(`I means ${persona.name}, never the owner`));
        assert.ok(system.includes(`identify yourself honestly as ${persona.name},`));
        assert.ok(system.includes(`Selected personality: ${persona.name} (${persona.mood}).`));
        assert.ok(system.includes(persona.instruction));
        assert.match(system, /Always be as polite, respectful, and considerate as possible/);
        assert.match(system, /take priority over personality and conflicting style preferences/);
        assert.match(system, /Your owner is male: use he\/him\/his in English, never they\/them\/their/);
        assert.ok(system.includes(`For this reply, the owner's nickname is "${nickname}"`));
        assert.match(system, /retaining that Latin spelling even in Bangla-script replies/);
        if (isGroup) assert.ok(system.includes(`When someone deliberately addresses ${persona.name}`));
        if (personality !== "chuckles") assert.ok(!system.includes("Chuckles"));
      }
    }
  }
});
test("all personalities fit the prompt budget with maximum context and owner preferences", () => {
  for (const personality of Object.keys(Core.PERSONALITIES)) for (const isGroup of [false, true]) {
    const settings = Core.conversationConfig(Core.settings({ personality, windowSize: 50, maxContextChars: 48000, style: "বাংলা😀".repeat(300) }), isGroup);
    const request = Core.modelRequest(settings, Array.from({ length: 50 }, () => ({ role: "other", author: "বন্ধু", text: '\\"\nবাংলা😀'.repeat(2000) })));
    assert.ok(Buffer.byteLength(JSON.stringify(request.messages)) <= (isGroup ? 64000 : 32000));
    assert.equal(request.messages.length, 51);
    assert.ok(request.messages.slice(1).every(turn => turn.content.length > 0));
  }
});
test("Banglish recognizes amr and strips both historical and corrected introductions", () => {
  assert.match(Core.replyLanguage([{ role: "other", text: "amr hoooman?" }]), /^Banglish/);
  for (const prefix of [
    "My hooman is busy, but I'm Chuckles, their AI sidekick, replying on their behalf. ",
    "My hooman ekhon busy, ami Chuckles, tar AI sidekick hoye reply dicchi. ",
    "My hooman এখন ব্যস্ত, আমি Chuckles, তার AI সহকারী হিসেবে উত্তর দিচ্ছি। ",
    Core.introduction("Banglish"), Core.introduction("Bangla"), Core.CHUCKLES_INTRO
  ]) assert.equal(Core.replyText({ message: { content: prefix + "Bujhlam." } }, "ollama"), "Bujhlam.");
});
test("plain replies retain JSON/code content without activating Markdown fences", () => {
  const json = '{\n  "response": "Ready 😄",\n  "count": 2\n}';
  assert.equal(Core.replyText({ message: { content: '```json\n' + json + '\n```' } }, "ollama"), json);
  assert.equal(Core.plainReply('Here is code:\n~~~python\nif ready:\n    print("ok")\n~~~\nUse `ready`.'), 'Here is code:\nif ready:\n    print("ok")\nUse `ready`.');
  assert.equal(Core.plainReply('```json\r\n' + json + '\r\n```'), json);
  assert.equal(Core.plainReply('Keep ```inline content``` and "```".'), 'Keep ```inline content``` and "```".');
  assert.throws(() => Core.plainReply("```\n```"), /empty/);
});
test("an explicitly pending incoming turn stays fresh after a confirmed bot reply", () => {
  const snapshot = { identity: "chat", title: "Chat", isGroup: false, atBottom: true, replyTo: "pending",
    messages: [{ id: "pending", role: "other", author: "Alice", text: "One more question" }, { id: "out", role: "me", text: "Reply to earlier messages" }] };
  assert.equal(Core.replySource(snapshot).id, "pending");
  assert.equal(Core.isFresh(snapshot, structuredClone(snapshot)), true);
  assert.equal(Core.isFresh(snapshot, { ...snapshot, replyTo: undefined }), false);
  const changed = structuredClone(snapshot); changed.messages.push({ id: "new", role: "other", text: "A newer question" }); changed.replyTo = undefined;
  assert.equal(Core.isFresh(snapshot, changed), false);
  const group = { ...snapshot, isGroup: true };
  assert.equal(Core.groupSendFresh(group, structuredClone(group)), true);
  assert.equal(Core.groupSendFresh(group, { ...changed, isGroup: true }), false);
  const request = Core.modelRequest({ ...config, replyTo: "pending" }, snapshot.messages);
  assert.match(request.messages[1].content, /\[Unanswered incoming message\]/);
  assert.equal(request.messages[2].role, "assistant");
  assert.equal(request.messages[2].content, snapshot.messages[1].text);
});
test("recent context preserves chronological order and both sender labels", () => {
  const window = Core.contextWindow(messages, config);
  assert.deepEqual(window.map(m => m.text), messages.slice(-20).map(m => m.text));
  assert.deepEqual(window.map(m => m.role), messages.slice(-20).map(m => m.role));
});
test("large turns stay within the character budget while keeping the latest turn", () => {
  const window = Core.contextWindow(messages.map(m => ({ ...m, text: "x".repeat(20000) })), config);
  assert.equal(window.length, 20);
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
  for (const windowSize of [0, 4, 51, 5.5]) assert.throws(() => Core.settings({ windowSize }));
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
test("saved 0.2.3 Send defaults migrate to both Teams compose toolbars", () => {
  const saved = '[data-tid="sendMessageCommands-send"], button[data-tid="send-message"], button[data-tid="sendMessageButton"]';
  const updated = Core.settings({ model: "my-local-model", selfName: "My Name", selectors: { send: saved } });
  assert.equal(updated.selectors.send, Core.DEFAULT_SELECTORS.send);
  assert.ok(updated.selectors.send.includes('[data-tid="newMessageCommands-send"]'));
  assert.ok(updated.selectors.send.includes('[data-tid="sendMessageCommands-send"]'));
  assert.equal(updated.model, "my-local-model");
  assert.equal(updated.selfName, "My Name");
  assert.equal(Core.settings({ selectors: { send: "#custom-send" } }).selectors.send, "#custom-send");
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
  assert.equal(ollama.options.num_predict, 1024);
  assert.equal(ollama.options.num_ctx, 32768);
  assert.equal(ollama.messages.length, 21);
  assert.match(ollama.messages[0].content, /untrusted data/);
  assert.match(ollama.messages[0].content, /Reply directly to the other person's latest message/);
  assert.deepEqual(ollama.messages.slice(1), messages.slice(-20).map(m => ({ role: m.role === "me" ? "assistant" : "user", content: m.text })));
  const compatible = Core.modelRequest(Core.settings({ provider: "openai", baseUrl: "http://localhost:1234/v1" }), messages);
  assert.equal(compatible.max_tokens, 1024);
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
  assert.match(system, /Mention the owner only when relevant/);
  assert.match(system, /I means Chuckles, never the owner/);
  assert.match(system, /Do not invent facts, private knowledge, actions/);
  assert.match(system, /Do not repeat an introduction/);
  assert.match(system, /Do useful work within the reply/);
  assert.match(system, /You have no tools to inspect computers/);
  assert.equal(request.messages.at(-1).role, "user");
  assert.equal(request.messages.at(-1).content, conversation.at(-1).text);
  assert.deepEqual(request.messages.slice(1, -1).map(m => m.content), conversation.slice(0, -1).map(m => m.text));
});
test("serialized prompts fit the byte budget with Unicode and escaped text", () => {
  for (const style of ["বাংলা😀".repeat(200), '\\"\n'.repeat(500)]) {
    const large = Core.settings({ windowSize: 20, maxContextChars: 12000, style });
    const request = Core.modelRequest(large, messages.map(m => ({ ...m, text: '\\"\nবাংলা😀'.repeat(2000) })));
    assert.ok(Buffer.byteLength(JSON.stringify(request.messages)) <= 32000);
    const turns = request.messages.slice(1);
    assert.equal(turns.length, 20);
    assert.ok(turns.every(turn => turn.content.length > 0));
  }
});
test("empty, truncated, and unfinished reasoning responses are rejected", () => {
  assert.equal(Core.replyText({ message: { content: "<think>private reasoning</think> Hi there!" } }, "ollama"), "Hi there!");
  for (const content of ["", "<think>unfinished", "x".repeat(6001)]) assert.throws(() => Core.replyText({ message: { content } }, "ollama"));
  assert.throws(() => Core.replyText({ message: { content: "Half a sentence" }, done_reason: "length" }, "ollama"));
  assert.throws(() => Core.replyText({ choices: [{ message: { content: "Half a sentence" }, finish_reason: "length" }] }, "openai"));
});
test("both providers return the useful reply and strip repeated legacy introductions", () => {
  const body = "My hooman never forgets friends, fancy wallet or not 😄";
  const expected = body;
  assert.equal(Core.replyText({ message: { content: body } }, "ollama"), expected);
  assert.equal(Core.replyText({ choices: [{ message: { content: body } }] }, "openai"), expected);
  assert.equal(Core.replyText({ message: { content: Core.CHUCKLES_INTRO + Core.CHUCKLES_INTRO + body } }, "ollama"), expected);
  assert.throws(() => Core.replyText({ message: { content: Core.CHUCKLES_INTRO } }, "ollama"), /empty/);
  assert.equal(Core.replyText({ message: { content: "x".repeat(1500) } }, "ollama").length, 1500);
  assert.throws(() => Core.replyText({ message: { content: "x".repeat(6001) } }, "ollama"), /overlong/);
});
test("freshness rejects chat switches, edits, outgoing replies, and scrolling away", () => {
  const original = { identity: "chat-a", atBottom: true, messages: messages.slice(-20) };
  assert.equal(Core.isFresh(original, structuredClone(original)), true);
  const variants = [
    { ...original, identity: "chat-b" }, { ...original, atBottom: false },
    { ...original, messages: [...original.messages, { id: "13", role: "me", text: "I replied" }] },
    { ...original, messages: original.messages.map((m, i) => i === 19 ? { ...m, text: "Edited" } : m) }
  ];
  for (const changed of variants) assert.equal(Core.isFresh(original, changed), false);
});
test("Banglish follows the latest recipient rather than older English replies", () => {
  const conversation = [{ role: "me", text: "I am busy right now." }, { role: "other", text: "ki korcho? ekhon kemon acho?" }];
  const request = Core.modelRequest(config, conversation);
  assert.match(request.messages[0].content, /Required reply language: Banglish/);
  assert.match(request.messages[0].content, /relevant emojis/);
  const reply = Core.replyText({ message: { content: "Ami achi, bolo ki lagbe 😄" } }, "ollama", conversation);
  assert.equal(reply, "Ami achi, bolo ki lagbe 😄");
  assert.ok(!reply.includes("My hooman is busy"));
  assert.ok(!Core.replyLanguage([...conversation, { role: "other", text: "Can you help me tomorrow?" }]).startsWith("Banglish"));
  assert.ok(!Core.replyLanguage([{ role: "other", text: "Re: project update" }]).startsWith("Banglish"));
});
test("Bangla and media-only turns use the recipient's recent language", () => {
  assert.match(Core.replyLanguage([{ role: "other", text: "কেমন আছো?" }]), /^Bangla /);
  assert.match(Core.replyLanguage([{ role: "other", text: "tumi kothay?" }, { role: "other", text: "", media: [{ kind: "GIF", label: "hello" }] }]), /^Banglish/);
});
test("twenty messages and media captions reach text models without image URLs", () => {
  const conversation = messages.map(m => ({ ...m, media: [{ kind: "GIF", label: "dancing cat", data: "data:image/jpeg;base64,aGVsbG8=" }] }));
  const request = Core.modelRequest({ ...config, vision: "off" }, conversation);
  assert.equal(request.messages.length, 21);
  assert.match(request.messages.at(-1).content, /Message 23\n\[GIF: dancing cat\]/);
  assert.ok(request.messages.every(m => !m.images));
  assert.ok(!JSON.stringify(request).includes("aGVsbG8="));
});
test("vision requests encode actual pixels using the provider's format", () => {
  const conversation = [{ role: "other", text: "What is this?", media: [{ kind: "image", label: "photo", data: "data:image/jpeg;base64,aGVsbG8=" }] }];
  const ollama = Core.modelRequest({ ...config, vision: "on" }, conversation);
  assert.deepEqual(ollama.messages.at(-1).images, ["aGVsbG8="]);
  const compatible = Core.modelRequest({ ...config, provider: "openai", vision: "on" }, conversation);
  assert.equal(compatible.messages.at(-1).content[1].image_url.url, conversation[0].media[0].data);
});
test("media edits invalidate in-flight replies", () => {
  const original = { identity: "a", atBottom: true, messages: [{ id: "1", role: "other", text: "", media: [{ kind: "image", label: "cat", key: "blob:a" }] }] };
  const changed = structuredClone(original); changed.messages[0].media[0].key = "blob:b";
  assert.equal(Core.isFresh(original, changed), false);
});

test("old message-window defaults migrate once while new explicit limits are respected", () => {
  assert.equal(Core.settings({ windowSize: 5, maxContextChars: 6000 }).windowSize, 20);
  assert.equal(Core.settings({ windowSize: 10 }).windowSize, 20);
  assert.equal(Core.settings({ contextVersion: 2, windowSize: 5, maxContextChars: 6000 }).windowSize, 5);
  assert.equal(Core.settings({ contextVersion: 2, windowSize: 5, maxContextChars: 6000 }).maxContextChars, 6000);
});

test("legacy draft monitoring migrates to automatic send without enabling paused monitoring", () => {
  const migrated = Core.monitorSettings({ enabled: false, mode: "draft", scope: "selected", identity: "chat-a" });
  assert.equal(migrated.mode, "auto"); assert.equal(migrated.enabled, false);
  assert.equal(migrated.scope, "selected"); assert.equal(migrated.identity, "chat-a");
  assert.equal(Core.monitorSettings({ enabled: true, mode: "draft" }).enabled, true);
});
test("explicit draft choice in the current version survives reload", () => {
  const saved = Core.monitorSettings({ enabled: true, mode: "draft", scope: "all", replyModeVersion: 3 });
  assert.equal(saved.mode, "draft"); assert.equal(saved.replyModeVersion, 3);
  assert.deepEqual(Core.monitorSettings(saved), saved);
});

test("group prompts preserve fifty chronological turns and each actual speaker", () => {
  const groupConfig = Core.conversationConfig(config, true);
  const conversation = Array.from({ length: 60 }, (_, i) => ({ id: String(i), role: i % 3 === 0 ? "me" : "other",
    author: ["Me", "Kajal", "Tazeen"][i % 3], text: `Discussion ${i}` }));
  const request = Core.modelRequest(groupConfig, conversation);
  assert.equal(groupConfig.windowSize, 50);
  assert.equal(groupConfig.maxContextChars, 48000);
  assert.equal(request.messages.length, 51);
  assert.deepEqual(request.messages.slice(1).map(m => m.content), conversation.slice(-50).map(m => `[Sender: ${m.author}]\n${m.text}`));
  assert.match(request.messages[0].content, /Do not impersonate other members/);
  assert.match(request.messages[0].content, /product performance, missing features, or repeated redesigns/);
  assert.match(request.messages[0].content, /When someone deliberately addresses Chuckles/);
  assert.equal(config.windowSize, 20);
});

test("fifty group turns fit the expanded byte budget even with Bangla and escapes", () => {
  const groupConfig = Core.conversationConfig(config, true);
  const conversation = Array.from({ length: 50 }, (_, i) => ({ role: "other", author: i % 2 ? "তাজীন" : "কাজল",
    text: '\\"\nবাংলা😀'.repeat(2000) }));
  const request = Core.modelRequest(groupConfig, conversation);
  assert.ok(Buffer.byteLength(JSON.stringify(request.messages)) <= 64000);
  assert.equal(request.messages.length, 51);
  assert.ok(request.messages.slice(1).every(m => m.content.startsWith("[Sender:") && m.content.includes("বাংলা")));
});

test("sender changes invalidate a group draft", () => {
  const original = { identity: "group", isGroup: true, atBottom: true, messages: [{ id: "1", role: "other", author: "Kajal", text: "Explain this" }] };
  const changed = structuredClone(original); changed.messages[0].author = "Tazeen";
  assert.equal(Core.isFresh(original, changed), false);
});

test("reviewed group drafts tolerate newer messages and recycled older history", () => {
  const original = { identity: "group-title", title: "Dev team", isGroup: true, atBottom: true,
    messages: [{ id: "old", role: "other", author: "Kajal", text: "An older message" }, { id: "question", role: "other", author: "Tazeen", text: "Explain this" }] };
  assert.equal(Core.groupDraftState(original, structuredClone(original)), "ready");
  const changed = { ...original, messages: [original.messages.at(-1), { id: "new", role: "other", author: "Kajal", text: "One more thought" }] };
  assert.equal(Core.isFresh(original, changed), false);
  assert.equal(Core.groupDraftState(original, changed), "updated");
  assert.equal(Core.groupDraftState(original, { ...original, atBottom: false }), "updated");
});

test("reviewed group actions reject wrong conversations and edited or missing source messages", () => {
  const original = { identity: "group-title", title: "Dev team", isGroup: true, atBottom: true,
    messages: [{ id: "question", role: "other", author: "Tazeen", text: "Explain this" }] };
  assert.equal(Core.groupDraftState(original, { ...original, identity: "other-group" }), "conversation");
  assert.equal(Core.groupDraftState(original, { ...original, title: "Other team" }), "conversation");
  assert.equal(Core.groupDraftState(original, { ...original, isGroup: false }), "conversation");
  assert.equal(Core.groupDraftState(original, { ...original, messages: [{ ...original.messages[0], id: "different-question" }] }), "unavailable");
  for (const update of [{ author: "Kajal" }, { text: "Edited question" }, { role: "me" }]) {
    assert.equal(Core.groupDraftState(original, { ...original, messages: [{ ...original.messages[0], ...update }] }), "edited");
  }
});

test("group draft source checks normalize whitespace and flag media preview updates for review", () => {
  const original = { identity: "group", title: "Dev team", isGroup: true, atBottom: true,
    messages: [{ id: "question", role: "other", author: "Tazeen", text: "Explain\nthis", media: [{ kind: "image", label: "photo", key: "blob:one" }] }] };
  const formatted = structuredClone(original); formatted.messages[0].text = "Explain this";
  assert.equal(Core.groupDraftState(original, formatted), "updated");
  formatted.messages[0].media[0].key = "blob:another";
  assert.equal(Core.groupDraftState(original, formatted), "updated");
});

test("group sending tolerates recycled history and older media refreshes", () => {
  const original = { identity: "group-title", title: "Dev team", isGroup: true, atBottom: true,
    messages: [{ id: "old", role: "other", author: "Kajal", text: "Earlier", media: [{ kind: "image", label: "photo", key: "blob:old" }] },
      { id: "question", role: "other", author: "Tazeen", text: "Explain\nthis" }] };
  assert.equal(Core.groupSendFresh(original, structuredClone(original)), true);
  const recycled = { ...original, messages: [{ ...original.messages.at(-1), text: "Explain this" }] };
  assert.equal(Core.isFresh(original, recycled), false);
  assert.equal(Core.groupSendFresh(original, recycled), true);
  const reloaded = structuredClone(original);
  reloaded.messages[0].media[0].key = "blob:reloaded";
  reloaded.messages.unshift({ id: "older", role: "me", author: "Me", text: "Old history loaded" });
  assert.equal(Core.groupSendFresh(original, reloaded), true);
});

test("group sending rejects newer messages, context edits, source media changes, and wrong chats", () => {
  const original = { identity: "group-title", title: "Dev team", isGroup: true, atBottom: true,
    messages: [{ id: "old", role: "other", author: "Kajal", text: "Earlier" },
      { id: "question", role: "other", author: "Tazeen", text: "Explain this", media: [{ kind: "image", label: "photo", key: "blob:source" }] }] };
  const variants = [{ ...original, identity: "different" }, { ...original, title: "Other team" },
    { ...original, atBottom: false }, { ...original, isGroup: false },
    { ...original, messages: original.messages.slice(0, 1) }];
  for (const role of ["me", "other"]) variants.push({ ...original, messages: [...original.messages, { id: "new", role, author: "Kajal", text: "New reply" }] });
  for (const index of [0, 1]) for (const update of [{ text: "Edited" }, { author: "Other sender" }, { role: "me" }]) {
    const edited = structuredClone(original); Object.assign(edited.messages[index], update); variants.push(edited);
  }
  const mediaChanged = structuredClone(original); mediaChanged.messages[1].media[0].key = "blob:changed"; variants.push(mediaChanged);
  for (const changed of variants) assert.equal(Core.groupSendFresh(original, changed), false);
});

test("previous default context budgets migrate once and current custom budgets survive", () => {
  assert.equal(Core.settings({ contextVersion: 2, maxContextChars: 12000 }).maxContextChars, 24000);
  assert.equal(Core.settings({ maxContextChars: 6000 }).maxContextChars, 24000);
  assert.equal(Core.settings({ contextVersion: 3, maxContextChars: 12000 }).maxContextChars, 12000);
});
