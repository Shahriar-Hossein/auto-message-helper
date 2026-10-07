(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const checked = [];
  const assert = (condition, message) => { if (!condition) throw new Error(`${message}: ${$("status").textContent}`); };
  const check = (label, action) => { action(); checked.push(label); };
  const $ = id => testState.shadow.getElementById(id);
  const click = async id => { $(id).click(); await wait(0); await wait(0); };
  const tick = async () => { for (const callback of testState.intervals) await callback(); };
  const genCount = () => testState.requests.filter(m => m.type === "generate").length;
  const latestRequest = () => testState.requests.filter(m => m.type === "generate").at(-1);
  const main = document.querySelector("main");
  const list = document.querySelector('[data-tid="message-pane-list-viewport"]');
  const editor = document.querySelector('[data-tid="ckeditor"]');
  const send = document.querySelector('[data-tid="send-message"]');
  function message(id, content, authorName = "Alice") {
    const row = document.createElement("div"); row.dataset.tid = "chat-pane-message"; row.dataset.messageId = id;
    const author = document.createElement("b"); author.dataset.tid = "message-author-name"; author.textContent = authorName;
    const body = document.createElement("p"); body.dataset.tid = "message-body"; body.textContent = content;
    row.append(author, body); list.append(row); list.scrollTop = list.scrollHeight;
  }
  const restart = async () => {
    await click("pause"); await click("dismiss"); editor.textContent = "";
    await click("select"); $("mode").value = "auto"; $("scope").value = "selected"; await click("start");
  };
  const generateIncoming = async (id, content) => {
    message(id, content); await tick(); testState.now += 1100; await tick();
  };
  const finishFresh = async () => { await tick(); testState.now += 1100; await tick(); await tick(); };
  try {
    await wait(0);
    for (let i = 0; i < 55; i++) message(`history-${i}`, `Earlier message ${i}`, i % 2 ? "Alice" : "Me");
    await restart();
    const initialGenerations = genCount();
    message("burst-1", "First part"); await tick(); testState.now += 500;
    message("burst-2", "Second part"); await tick(); testState.now += 600; await tick();
    check("a burst waits for the last message's debounce", () => assert(genCount() === initialGenerations, "Generated before the burst settled"));
    testState.now += 500; await tick(); await tick();
    check("a burst gets one reply using both incoming messages", () => {
      assert(genCount() === initialGenerations + 1 && testState.sendCount === 1, "Burst created duplicate replies");
      assert(latestRequest().messages.slice(-2).map(m => m.id).join() === "burst-1,burst-2", "Burst context lost a message");
    });

    let resolveGeneration;
    testState.response = () => new Promise(resolve => { resolveGeneration = resolve; });
    message("inference-1", "A question"); await tick(); testState.now += 1100;
    const generation = tick(); await wait(800);
    assert(typeof resolveGeneration === "function", "Inference did not begin");
    message("inference-2", "An additional question"); await tick();
    resolveGeneration({ ok: true, reply: "An outdated answer" }); await generation; testState.response = null;
    check("a newer incoming message during inference discards the outdated answer", () => assert(testState.sendCount === 1 && TeamsReplyAdapter.composerEmpty(testState.config) && $("start").disabled, "Stale inference was sent or monitoring stopped"));
    await finishFresh();
    check("monitoring generates again for the newest incoming message", () => assert(testState.sendCount === 2 && latestRequest().messages.at(-1).id === "inference-2", "Newest message was not answered"));

    let before = testState.sendCount;
    editor.addEventListener("input", () => setTimeout(() => message("insert-2", "Changed while inserting"), 20), { once: true });
    await generateIncoming("insert-1", "Original question");
    check("a newer message after insertion removes only the unchanged bot draft", () => assert(testState.sendCount === before && TeamsReplyAdapter.composerEmpty(testState.config) && !$("draft").value && $("start").disabled && $("status").textContent.includes("Removed"), "Bot draft blocked recovery"));
    await finishFresh();
    check("the insertion race recovers without another Start", () => assert(testState.sendCount === before + 1 && latestRequest().messages.at(-1).id === "insert-2", "Insertion race did not recover"));

    before = testState.sendCount; send.disabled = true;
    editor.addEventListener("input", () => setTimeout(() => { message("waiting-2", "Changed while Send was disabled"); send.disabled = false; }, 450), { once: true });
    await generateIncoming("waiting-1", "Wait for the Send control");
    check("new incoming text while waiting for Send rolls back before clicking", () => assert(testState.sendCount === before && TeamsReplyAdapter.composerEmpty(testState.config) && $("start").disabled, "Stale text was sent while waiting"));
    await finishFresh();
    check("the Send wait race answers the latest question once", () => assert(testState.sendCount === before + 1 && latestRequest().messages.at(-1).id === "waiting-2", "Send wait did not recover"));

    before = testState.sendCount;
    editor.addEventListener("input", () => setTimeout(() => { editor.append(" My edit"); message("edited-2", "Another question"); }, 20), { once: true });
    await generateIncoming("edited-1", "Let me edit the reply");
    check("human edits survive a simultaneous newer incoming message", () => assert(testState.sendCount === before && editor.innerText.includes("My edit") && $("draft").value, "Human edit was deleted or sent"));
    await tick(); testState.now += 1100; await tick();
    check("human edits are not silently retried", () => assert(testState.sendCount === before && editor.innerText.includes("My edit"), "Human draft was retried"));
    await restart();

    editor.addEventListener("input", () => setTimeout(() => { editor.append(" "); message("whitespace-2", "New question"); }, 20), { once: true });
    await generateIncoming("whitespace-1", "Preserve even a whitespace edit");
    check("rollback compares exact markup rather than normalized reply text", () => assert(testState.sendCount === before && editor.textContent.endsWith(" "), "Whitespace edit was overwritten"));
    await restart();

    const attachment = document.createElement("div"); attachment.dataset.tid = "compose-attachment"; attachment.textContent = "My upload";
    editor.addEventListener("input", () => setTimeout(() => { main.append(attachment); message("attachment-2", "New question with my upload pending"); }, 20), { once: true });
    await generateIncoming("attachment-1", "Keep my queued attachment");
    check("queued attachments prevent bot-draft cleanup", () => assert(testState.sendCount === before && attachment.isConnected && editor.innerText, "Queued attachment was cleared or sent"));
    attachment.remove(); await restart();

    editor.addEventListener("input", () => setTimeout(() => { main.dataset.chatId = "different-chat"; message("different-2", "Another conversation"); }, 20), { once: true });
    await generateIncoming("different-1", "Do not touch another conversation");
    check("switching chats prevents cleanup and sending", () => assert(testState.sendCount === before && editor.innerText, "Another conversation's composer was cleared or sent"));
    main.dataset.chatId = "chat-a"; await restart();

    let replacement;
    editor.addEventListener("input", () => setTimeout(() => { replacement = editor.cloneNode(true); editor.replaceWith(replacement); message("replacement-2", "New message after the editor was replaced"); }, 20), { once: true });
    await generateIncoming("replacement-1", "Teams replaces the composer");
    check("a replacement editor is never treated as an owned draft", () => assert(testState.sendCount === before && replacement.innerText, "Replacement editor was cleared or sent"));
    replacement.replaceWith(editor); await restart();

    const json = '{\n  "response": "Ready",\n  "count": 2\n}';
    testState.response = () => ({ ok: true, reply: '```json\n' + json + '\n```' });
    let pasted;
    editor.addEventListener("paste", event => {
      event.preventDefault(); pasted = event.clipboardData.getData("text/plain"); editor.textContent = pasted;
    }, { once: true });
    await generateIncoming("json", "Give me JSON"); await tick(); testState.response = null;
    check("JSON is pasted and delivered without native code-block delimiters", () => {
      assert(pasted === json && testState.sendCount === before + 1 && TeamsReplyAdapter.composerEmpty(testState.config), "JSON formatting blocked delivery");
      assert(list.lastElementChild.querySelector("p").textContent === json, "JSON indentation or content changed");
    });

    before = testState.sendCount;
    send.addEventListener("click", () => message("late-before-echo", "Arrived just before the outgoing echo"), { capture: true, once: true });
    await generateIncoming("late-original", "Question being answered"); await tick();
    check("an incoming message before the outgoing echo remains pending", () => assert(testState.sendCount === before + 1 && list.lastElementChild.dataset.messageId.startsWith("outgoing"), "Delivery fixture did not end with the outgoing echo"));
    testState.now += 1100; await tick(); await tick();
    check("a pending incoming message is answered even when the last row is ours", () => {
      assert(testState.sendCount === before + 2 && latestRequest().replyTo === "late-before-echo", "Pending incoming message was overlooked");
      const history = latestRequest().messages;
      assert(history.at(-1).role === "me" && history.at(-2).id === "late-before-echo", "Pending context was reordered");
    });
    await tick(); testState.now += 1100; await tick();
    check("confirmed pending work does not generate duplicate replies", () => assert(testState.sendCount === before + 2, "Pending work sent twice"));

    before = testState.sendCount;
    send.addEventListener("click", () => message("human-pending", "Question answered manually next"), { capture: true, once: true });
    await generateIncoming("human-original", "Earlier question"); await tick();
    message("human-reply", "I answered that myself", "Me"); await tick(); testState.now += 1100; await tick();
    check("a later human outgoing reply takes precedence over pending bot work", () => assert(testState.sendCount === before + 1, "Bot answered after the human reply"));

    before = testState.sendCount;
    send.addEventListener("click", () => {
      list.replaceChildren(...[...list.children].slice(-10));
      message("older-loaded", "An earlier message loaded by virtualization");
      list.prepend(list.lastElementChild); list.scrollTop = list.scrollHeight;
    }, { capture: true, once: true });
    await generateIncoming("virtualized-original", "The newest question"); await tick(); testState.now += 1100; await tick();
    check("older rows loaded during delivery are not mistaken for new incoming work", () => assert(testState.sendCount === before + 1, "Virtualized history triggered an extra reply"));

    main.dataset.chatType = "group"; document.querySelector("h1").textContent = "Recovery group"; await restart();
    before = testState.sendCount;
    send.addEventListener("click", () => message("group-late", "Another group question"), { capture: true, once: true });
    await generateIncoming("group-original", "First group question"); await tick(); testState.now += 1100; await tick(); await tick();
    check("selected groups also answer incoming messages preceding the outgoing echo", () => assert(testState.sendCount === before + 2 && latestRequest().replyTo === "group-late" && latestRequest().isGroup, "Group pending message was overlooked"));

    before = testState.sendCount;
    editor.addEventListener("input", () => setTimeout(() => message("group-insert-new", "New group question during insertion"), 20), { once: true });
    await generateIncoming("group-insert-old", "Original group question");
    check("automatic group sends also recover their unchanged composer drafts", () => assert(testState.sendCount === before && TeamsReplyAdapter.composerEmpty(testState.config) && $("start").disabled, "Group composer draft blocked recovery"));
    await finishFresh();
    check("group composer recovery answers the newest group message", () => assert(testState.sendCount === before + 1 && latestRequest().messages.at(-1).id === "group-insert-new", "Group recovery used an old message"));

    before = testState.sendCount; testState.suppressEcho = true;
    await generateIncoming("uncertain-original", "Delivery will have no echo");
    message("uncertain-new", "Message while delivery is uncertain"); await tick(); testState.now += 13000; await tick(); testState.suppressEcho = false;
    check("uncertain delivery stops without retrying or sending newer work", () => assert(testState.sendCount === before + 1 && $("status").textContent.includes("uncertain"), "Uncertain delivery was retried"));
    await click("pause");
    document.getElementById("test-result").textContent = `PASS (${checked.length} recovery checks)\n${checked.join("\n")}`;
    document.documentElement.dataset.testResult = "pass";
  } catch (error) {
    document.getElementById("test-result").textContent = `FAIL: ${error.message}\n${error.stack}`;
    document.documentElement.dataset.testResult = "fail";
  }
})();
