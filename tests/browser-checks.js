(async () => {
  const wait = () => new Promise(resolve => setTimeout(resolve, 0));
  const checked = [];
  const assert = (condition, label) => { if (!condition) throw new Error(label); };
  const check = (label, action) => { action(); checked.push(label); };
  const fail = (action, pattern) => { let error; try { action(); } catch (e) { error = e; } assert(error && pattern.test(error.message), `Expected rejection: ${pattern}`); };
  const $ = id => testState.shadow.getElementById(id);
  const click = async id => { $(id).click(); await wait(); await wait(); };
  const tick = async () => { for (const callback of testState.intervals) await callback(); };
  const genCount = () => testState.requests.filter(m => m.type === "generate").length;
  const editor = document.querySelector('[data-tid="ckeditor"]');
  const main = document.querySelector("main");
  const list = document.querySelector('[data-tid="message-pane-list-viewport"]');
  function incoming(id, message) {
    const row = document.createElement("div"); row.dataset.tid = "chat-pane-message"; row.dataset.messageId = id;
    const author = document.createElement("b"); author.dataset.tid = "message-author-name"; author.textContent = "Alice";
    const body = document.createElement("p"); body.dataset.tid = "message-body"; body.textContent = message;
    row.append(author, body); list.append(row); list.scrollTop = list.scrollHeight; return row;
  }
  try {
    await wait();
    check("loaded messages and sender labels", () => {
      const snap = TeamsReplyAdapter.snapshot(testState.config);
      assert(snap.messages.length === 2 && snap.messages[0].role === "me" && snap.messages[1].role === "other", "Incorrect sender labels");
      assert(snap.chatId === "chat-a" && snap.atBottom, "Chat ID / bottom detection failed");
    });
    check("unknown authors and group-like titles rejected", () => {
      const author = list.querySelector('[data-tid="message-author-name"]'); const original = author.textContent;
      author.textContent = ""; fail(() => TeamsReplyAdapter.snapshot(testState.config), /identify every sender/); author.textContent = original;
      const other = list.querySelectorAll('[data-tid="message-author-name"]')[1];
      other.textContent = ""; fail(() => TeamsReplyAdapter.snapshot(testState.config), /identify every sender/); other.textContent = "Alice";
      const title = document.querySelector("h1"); title.textContent = "Group chat";
      fail(() => TeamsReplyAdapter.snapshot(testState.config), /title must exactly match/); title.textContent = "Alice";
    });
    check("draft and ambiguous composer protection", () => {
      editor.textContent = "My unfinished draft";
      fail(() => TeamsReplyAdapter.insert(testState.config, "AI reply"), /already contains/);
      assert(editor.textContent === "My unfinished draft", "Draft overwritten"); editor.textContent = "";
      const copy = editor.cloneNode(); main.append(copy);
      fail(() => TeamsReplyAdapter.composerEmpty(testState.config), /found 2/); copy.remove();
    });
    await click("select"); await click("start"); await tick();
    check("startup baseline ignores old messages", () => assert(genCount() === 0, "Old message generated a reply"));
    incoming("3", "Can you help?"); await tick(); testState.now += 1100; await tick();
    check("new incoming turn produces one draft", () => {
      assert(genCount() === 1 && $("draft").value === "Sounds good!", "No draft generated");
      assert(testState.sendCount === 0 && editor.textContent === "", "Draft mode sent or inserted automatically");
    });
    await tick(); await click("dismiss"); await tick();
    check("same message is not regenerated", () => assert(genCount() === 1, "Duplicate generation"));
    await click("pause");
    let resolveGeneration;
    testState.response = () => new Promise(resolve => { resolveGeneration = resolve; });
    await click("generate");
    main.dataset.chatId = "chat-b";
    resolveGeneration({ ok: true, reply: "Stale response" }); await wait(); await wait();
    check("chat switch discards in-flight generation", () => assert($("draft").value === "" && editor.textContent === "" && testState.sendCount === 0, "Stale reply used"));
    main.dataset.chatId = "chat-a"; testState.response = null; await click("select");
    await click("generate"); await click("insert");
    check("rich-text insertion updates the composer", () => assert(editor.innerText === "Sounds good!", "Insertion failed"));
    editor.textContent = ""; await click("select");
    $("mode").value = "auto"; await click("start");
    incoming("4", "Thanks for checking"); await tick(); testState.now += 1100; await tick();
    incoming("4b", "And one more thing"); await tick();
    check("automatic mode sends once and verifies outgoing echo", () => {
      assert(testState.sendCount === 1, `Automatic send failed: ${$("status").textContent}`);
      assert($("status").textContent.includes("Reply appeared"), "Outgoing echo not verified");
    });
    testState.now += 1100; await tick(); await tick();
    check("incoming text during delivery verification gets its own reply", () => {
      assert(testState.sendCount === 2, "An incoming turn was lost while checking delivery");
    });
    await click("pause");
    main.removeAttribute("data-chat-id"); await click("select"); await click("start");
    check("automatic mode blocks without stable chat ID", () => {
      assert($("status").textContent.includes("requires a stable chat ID"), "Automatic mode accepted a display name identity");
      assert(!$("start").disabled, "Monitoring started without a chat ID");
    });
    main.dataset.chatId = "chat-a"; await click("select"); $("mode").value = "draft";
    const before = genCount();
    editor.textContent = "Keep my draft"; await click("generate");
    check("generation preserves existing composer text", () => assert(genCount() === before && editor.textContent === "Keep my draft", "Existing draft altered"));
    editor.textContent = "";
    // Simulate Pause arriving during ownership acquisition, before inference starts.
    const originalSend = chrome.runtime.sendMessage;
    let resolveClaim;
    chrome.runtime.sendMessage = async message => message.type === "claim" ? new Promise(resolve => { resolveClaim = resolve; }) : originalSend(message);
    incoming("5", "One more question"); await click("generate"); await click("pause");
    resolveClaim({ ok: true }); await wait(); await wait(); chrome.runtime.sendMessage = originalSend;
    check("pause cancels generation during ownership acquisition", () => assert(genCount() === before && $("draft").value === "", "Pause race generated a reply"));
    await click("select"); $("mode").value = "auto"; await click("start");
    const intervene = () => setTimeout(() => {
      editor.focus(); document.execCommand("insertText", false, " I want to edit this");
    }, 20);
    editor.addEventListener("input", intervene, { once: true });
    incoming("6", "Please confirm"); await tick(); testState.now += 1100; await tick();
    check("user editing after insertion cancels automatic Send", () => {
      assert(testState.sendCount === 2 && editor.innerText.includes("I want to edit this"), "User edit was sent or lost");
      assert($("status").textContent.includes("changed after insertion"), "User editing did not cancel automatic sending");
    });
    document.getElementById("test-result").textContent = `PASS (${checked.length} browser checks)\n${checked.join("\n")}`;
    document.documentElement.dataset.testResult = "pass";
  } catch (error) {
    document.getElementById("test-result").textContent = `FAIL: ${error.message}\n${error.stack}`;
    document.documentElement.dataset.testResult = "fail";
  }
})();
