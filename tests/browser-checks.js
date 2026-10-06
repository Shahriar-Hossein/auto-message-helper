(async () => {
  const wait = () => new Promise(resolve => setTimeout(resolve, 0));
  const settleInsertion = () => new Promise(resolve => setTimeout(resolve, 400));
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
    check("selection is required before Start or Generate", () => {
      assert($("start").disabled && $("generate").disabled, "Unselected chat actions enabled");
    });
    const title = document.querySelector("h1");
    title.dataset.tid = "actual-teams-title";
    await click("select");
    check("failed selection keeps the actual error and exposes page metadata", () => {
      assert($("status").textContent.includes("Expected one chat title; found 0"), "Selection error was lost");
      assert($("inspection").open && $("context").textContent.includes("actual-teams-title"), "Live title candidate not reported");
      assert($("start").disabled && $("generate").disabled, "Failed selection enabled generation");
      const report = $("context").textContent;
      assert(!report.includes("Hi Alice") && !report.includes("Hello!") && !report.includes("chat-a"), "Page check leaked conversation data");
    });
    title.dataset.tid = "chat-header-title";
    await click("diagnose");
    check("page check lists selector counts and header/editor candidates", () => {
      assert($("context").textContent.includes("header: 1 / 1"), "Selector count missing");
      assert($("context").textContent.includes("Visible title/header candidates"), "Header candidates missing");
      assert($("context").textContent.includes('contenteditable="true"'), "Editor metadata missing");
    });
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
    let inputCount = 0;
    const countInput = () => { inputCount++; };
    const removeCaret = () => document.getSelection().removeAllRanges();
    editor.addEventListener("input", countInput);
    editor.addEventListener("focus", removeCaret, { once: true });
    $("draft").focus();
    await TeamsReplyAdapter.insert(testState.config, "Reply with a fresh caret");
    editor.removeEventListener("input", countInput);
    check("insertion restores a missing caret and emits only one input event", () => {
      assert(editor.innerText === "Reply with a fresh caret", "Missing caret prevented insertion");
      assert(inputCount === 1, `Duplicate input events: ${inputCount}`);
    });
    editor.textContent = "";
    const originalExec = document.execCommand;
    let pasteSeen = false;
    const handlePaste = event => {
      event.preventDefault();
      pasteSeen = event.clipboardData.getData("text/plain") === "Paste through the editor model" && !event.clipboardData.getData("text/html");
      editor.textContent = event.clipboardData.getData("text/plain");
    };
    editor.addEventListener("paste", handlePaste, { once: true });
    document.execCommand = () => { throw new Error("Native editing must not run after handled paste"); };
    try { await TeamsReplyAdapter.insert(testState.config, "Paste through the editor model"); }
    finally { document.execCommand = originalExec; }
    check("a rich-text editor handles plain-text paste without a duplicate insertion", () => {
      assert(pasteSeen && editor.innerText === "Paste through the editor model", "Editor paste pipeline not used");
    });
    editor.textContent = "";
    await click("select"); await click("start"); await tick();
    check("startup baseline ignores old messages", () => assert(genCount() === 0, "Old message generated a reply"));
    incoming("3", "Can you help?"); await tick(); testState.now += 1100; await tick();
    check("new incoming turn produces one draft", () => {
      assert(genCount() === 1 && $("draft").value === "Sounds good!", "No draft generated");
      assert(testState.requests.filter(m => m.type === "generate").at(-1).messages.at(-1).text === "Can you help?", "Latest incoming text not sent to the worker");
      assert($("context").textContent.includes("Can you help?"), "Generation context not refreshed");
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
    await click("generate");
    const revertEdit = () => setTimeout(() => { editor.textContent = ""; }, 0);
    editor.addEventListener("input", revertEdit, { once: true });
    await click("insert"); await settleInsertion();
    check("a composer that discards the edit keeps the reviewable panel draft", () => {
      assert(editor.innerText === "" && $("draft").value === "Sounds good!", "Failed insertion lost the panel draft");
      assert(!$("insert").disabled && $("status").textContent.includes("changed after insertion"), "Insertion failure not reported");
    });
    await click("insert"); await settleInsertion();
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
      assert($("status").textContent.includes("requires a stable conversation identity"), "Automatic mode accepted a display name identity");
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
    title.dataset.tid = "actual-teams-title";
    await click("select");
    check("a failed reselection clears the previous target", () => {
      assert($("selected").textContent === "No chat selected" && $("start").disabled && $("generate").disabled, "Old target survived failed reselection");
    });
    editor.textContent = "";
    main.removeAttribute("data-chat-id");
    title.dataset.tid = "chat-title";
    const peer = document.createElement("span"); peer.dataset.tid = "participant-8:live:fixture-peer"; peer.textContent = "Alice";
    const menu = document.createElement("ul"); menu.dataset.tid = "chat-topic-menu"; menu.append(peer);
    const statusText = document.createElement("span"); statusText.textContent = " Extra header UI";
    title.replaceChildren(menu, statusText);
    function modernMessage(id, authorName, content) {
      const item = document.createElement("div"); item.dataset.tid = "chat-pane-item";
      const author = document.createElement("b"); author.dataset.tid = "message-author-name"; author.textContent = authorName;
      const row = document.createElement("div"); row.dataset.tid = "chat-pane-message"; row.dataset.messageId = id; row.setAttribute("role", "group");
      const body = document.createElement("div"); const p = document.createElement("p"); p.textContent = content; body.append(p);
      const actions = document.createElement("button"); actions.dataset.tid = "message-actions-menu-hidden-button"; actions.textContent = "Message actions";
      const reactions = document.createElement("div"); reactions.dataset.tid = "diverse-reaction-summary"; reactions.setAttribute("role", "toolbar"); reactions.textContent = "😀 3 reactions";
      row.append(body, actions, reactions); item.append(author, row); return item;
    }
    list.replaceChildren(modernMessage("modern-1", "Me", "My recent message"), modernMessage("modern-2", "Alice", "Reply to this"));
    list.scrollTop = list.scrollHeight;
    const sendButton = document.querySelector('[data-tid="send-message"]'); sendButton.removeAttribute("data-tid");
    const sendIcon = document.createElement("span"); sendIcon.dataset.tid = "sendMessageCommands-send"; sendIcon.textContent = "Send"; sendButton.replaceChildren(sendIcon);
    testState.config = TeamsReplyCore.settings({ ...testState.config, selectors: { ...TeamsReplyCore.LEGACY_SELECTORS } });
    await click("select");
    check("reported Teams layout reads untagged bodies and sibling authors", () => {
      const snap = TeamsReplyAdapter.snapshot(testState.config);
      assert(snap.title === "Alice" && snap.messages[0].role === "me" && snap.messages[1].role === "other", "Modern chat title or authors not read");
      assert(snap.messages[0].text === "My recent message" && snap.messages[1].text === "Reply to this", "Reaction/action text entered context");
      assert(snap.chatId === "direct:8:live:fixture-peer", "Recipient identity not detected");
      assert(!$("start").disabled && !$("generate").disabled, `Reported chat selection failed: ${$("status").textContent}`);
    });
    check("recipient identity distinguishes chats and rejects multiple participants", () => {
      const original = TeamsReplyAdapter.snapshot(testState.config).identity;
      peer.dataset.tid = "participant-8:live:another-peer";
      assert(TeamsReplyAdapter.snapshot(testState.config).identity !== original, "Different recipient kept same identity");
      peer.dataset.tid = "participant-8:live:fixture-peer";
      const second = peer.cloneNode(true); second.dataset.tid = "participant-8:live:second-peer"; menu.append(second);
      fail(() => TeamsReplyAdapter.snapshot(testState.config), /More than one chat participant/); second.remove();
    });
    check("diagnostics redact immutable participant IDs", () => {
      const report = TeamsReplyAdapter.diagnostics(testState.config);
      assert(!report.includes("fixture-peer") && !report.includes("Reply to this"), "Diagnostics exposed recipient or message content");
      assert(report.includes("Stable conversation identity available: true"), "Identity status missing");
    });
    check("sibling sender lookup cannot reuse an author across multiple message rows", () => {
      const item = list.lastElementChild; const duplicate = item.querySelector('[data-tid="chat-pane-message"]').cloneNode(true);
      duplicate.dataset.messageId = "modern-ambiguous"; item.append(duplicate);
      fail(() => TeamsReplyAdapter.snapshot(testState.config), /identify every sender/); duplicate.remove();
    });
    $("mode").value = "auto"; await click("start");
    list.append(modernMessage("modern-3", "Alice", "Another incoming message")); list.scrollTop = list.scrollHeight;
    await tick(); testState.now += 1100; await tick(); await tick();
    check("reported Teams layout generates and sends through its actual Send control", () => {
      assert(testState.sendCount === 3, `Modern automatic send failed: ${$("status").textContent}`);
      assert($("status").textContent.includes("Reply appeared"), "Modern outgoing echo not verified");
    });
    await click("pause");
    document.getElementById("test-result").textContent = `PASS (${checked.length} browser checks)\n${checked.join("\n")}`;
    document.documentElement.dataset.testResult = "pass";
  } catch (error) {
    document.getElementById("test-result").textContent = `FAIL: ${error.message}\n${error.stack}`;
    document.documentElement.dataset.testResult = "fail";
  }
})();
