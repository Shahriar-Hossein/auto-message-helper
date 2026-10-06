(async () => {
  const wait = () => new Promise(resolve => setTimeout(resolve, 0));
  const settleInsertion = () => new Promise(resolve => setTimeout(resolve, 400));
  const checked = [];
  const assert = (condition, label) => { if (!condition) throw new Error(label); };
  const check = (label, action) => { action(); checked.push(label); };
  const fail = (action, pattern) => { let error; try { action(); } catch (e) { error = e; } assert(error && pattern.test(error.message), `Expected rejection: ${pattern}`); };
  const $ = id => testState.shadow.getElementById(id);
  const click = async id => {
    $(id).click(); await wait(); await wait();
    if (["generate", "preview", "send", "insert"].includes(id)) await new Promise(resolve => setTimeout(resolve, 1300));
  };
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
    $("mode").value = "draft"; $("scope").value = "selected"; $("scope").dispatchEvent(new Event("change"));
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
    await click("preview");
    main.dataset.chatId = "chat-b";
    resolveGeneration({ ok: true, reply: "Stale response" }); await wait(); await wait();
    check("chat switch discards in-flight generation", () => assert($("draft").value === "" && editor.textContent === "" && testState.sendCount === 0, "Stale reply used"));
    main.dataset.chatId = "chat-a"; testState.response = null; await click("select");
    await click("preview");
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
    editor.textContent = "Keep my draft"; await click("preview");
    check("generation preserves existing composer text", () => assert(genCount() === before && editor.textContent === "Keep my draft", "Existing draft altered"));
    editor.textContent = "";
    // Simulate Pause arriving during ownership acquisition, before inference starts.
    const originalSend = chrome.runtime.sendMessage;
    let resolveClaim;
    chrome.runtime.sendMessage = async message => message.type === "claim" ? new Promise(resolve => { resolveClaim = resolve; }) : originalSend(message);
    incoming("5", "One more question"); await click("preview"); await click("pause");
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
    list.append(modernMessage("preview-send", "Alice", "Can you send this reply?")); list.scrollTop = list.scrollHeight;
    await click("preview");
    const generatedBeforeSend = genCount(), sendsBeforeDraft = testState.sendCount;
    $("draft").value = "A reviewed reply 😄";
    await click("send"); await tick();
    check("Send reply sends the existing edited panel draft without another model request", () => {
      assert(testState.sendCount === sendsBeforeDraft + 1 && genCount() === generatedBeforeSend, `Panel draft was not sent: ${$("status").textContent}`);
      assert($("draft").value === "" && $("send").disabled, "Sent panel draft was not cleared");
      assert(TeamsReplyAdapter.snapshot(testState.config).messages.at(-1).text === "A reviewed reply 😄", "Edited draft was not sent exactly");
    });
    list.append(modernMessage("preview-stale", "Alice", "Another question")); list.scrollTop = list.scrollHeight;
    await click("preview");
    peer.dataset.tid = "participant-8:live:different-chat";
    await click("send");
    check("Send reply rejects an existing draft after switching recipients", () => {
      assert(testState.sendCount === sendsBeforeDraft + 1 && $("draft").value === "Sounds good!", "A stale panel draft was sent or lost");
    });
    peer.dataset.tid = "participant-8:live:fixture-peer"; await click("dismiss");
    // Expand the fixture to cover 20-turn media context and a persistent inbox watcher.
    main.dataset.chatId = "chat-a"; title.dataset.tid = "chat-header-title"; title.textContent = "Alice";
    let historyPage = 0;
    function historyRows(start) {
      list.replaceChildren();
      for (let i = start; i < start + 5; i++) {
        const row = document.createElement("div"); row.dataset.tid = "chat-pane-message"; row.dataset.messageId = `virtual-${i}`; row.dataset.authorName = "Alice"; row.style.height = "60px";
        const body = document.createElement("p"); body.dataset.tid = "message-body"; body.textContent = `Virtual message ${i}`; row.append(body); list.append(row);
      }
    }
    historyRows(35); list.scrollTop = list.scrollHeight;
    const loadHistory = event => {
      if (event.isTrusted) return;
      if (list.scrollTop === 0 && historyPage < 3) historyRows(30 - 5 * historyPage++);
      else if (list.scrollTop > 0) historyRows(35);
    };
    list.addEventListener("scroll", loadHistory);
    const virtualHistory = await TeamsReplyAdapter.recentHistory(testState.config);
    list.removeEventListener("scroll", loadHistory);
    check("virtualized history loads twenty turns in order and restores the latest viewport", () => {
      assert(virtualHistory.length === 20 && virtualHistory.every((message, index) => message.id === `virtual-${index + 20}`), "History pages were missing or out of order");
      assert(TeamsReplyAdapter.snapshot(testState.config).messages.at(-1).id === "virtual-39" && TeamsReplyAdapter.snapshot(testState.config).atBottom, "Latest viewport was not restored");
    });
    list.replaceChildren();
    for (let i = 0; i < 25; i++) incoming(`history-${i}`, `Earlier message ${i}`);
    const mediaRow = list.lastElementChild;
    mediaRow.querySelector("p").remove();
    const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 64;
    canvas.getContext("2d").fillRect(0, 0, 64, 64);
    const image = document.createElement("img"); image.alt = "dancing cat GIF"; image.width = 64; image.height = 64;
    const imageReady = new Promise(resolve => { image.onload = resolve; });
    image.src = canvas.toDataURL("image/png"); mediaRow.append(image); await imageReady; list.scrollTop = list.scrollHeight;
    check("media-only incoming GIFs count among the latest twenty messages", () => {
      const snapshot = TeamsReplyAdapter.snapshot(testState.config);
      assert(snapshot.messages.length === 20 && snapshot.messages[0].id === "history-5", "Wrong recent context window");
      assert(snapshot.messages.at(-1).text === "" && snapshot.messages.at(-1).media[0].kind === "GIF", "Media-only message was skipped or turned into text");
      const captured = TeamsReplyAdapter.captureMedia(snapshot, testState.config);
      assert(captured.at(-1).media[0].data.startsWith("data:image/jpeg;base64,"), "Image pixels were not captured");
    });
    await click("select"); $("mode").value = "draft";
    const manualBefore = testState.sendCount;
    // Use the actual fixture button, whose icon carries the Send selector.
    const actualSend = sendIcon.closest("button"); actualSend.disabled = true;
    setTimeout(() => { actualSend.disabled = false; }, 1600);
    await click("generate"); await new Promise(resolve => setTimeout(resolve, 700)); await tick();
    check("Generate & send sends even with Draft selected and waits for Send to enable", () => {
      assert(testState.sendCount === manualBefore + 1, `Manual automatic send failed: ${$("status").textContent}`);
      const payload = testState.requests.filter(m => m.type === "generate").at(-1);
      assert(payload.messages.length === 20 && payload.messages.at(-1).media[0].data, "Full recent media context was not sent to the worker");
      assert($("draft").value === "" && $("mode").value === "draft", "Explicit send became a preview or changed the monitoring mode");
    });
    const sidebar = document.createElement("nav"); document.body.prepend(sidebar);
    function unreadChat(id, name) {
      const item = document.createElement("button"); item.dataset.tid = "chat-list-item"; item.dataset.chatId = id; item.dataset.unread = "true";
      const label = document.createElement("span"); label.dataset.tid = "chat-list-item-title"; label.textContent = name; item.append(label);
      item.addEventListener("click", () => {
        item.dataset.unread = "false"; main.dataset.chatId = id; title.textContent = name; list.replaceChildren();
        for (let i = 0; i < 25; i++) {
          const row = document.createElement("div"); row.dataset.tid = "chat-pane-message"; row.dataset.messageId = `${id}-${i}`; row.dataset.authorName = name;
          const body = document.createElement("p"); body.dataset.tid = "message-body"; body.textContent = `${name} message ${i}`; row.append(body); list.append(row);
        }
        list.scrollTop = list.scrollHeight;
      });
      sidebar.append(item); return item;
    }
    const bob = unreadChat("chat-b", "Bob"), carol = unreadChat("chat-c", "Carol");
    $("scope").value = "all"; $("mode").value = "auto"; await click("start");
    editor.textContent = "Preserve my unfinished message"; await tick();
    check("all-chat monitoring waits while the current composer contains a draft", () => {
      assert(main.dataset.chatId === "chat-a" && editor.textContent === "Preserve my unfinished message", "Unread navigation discarded an existing draft");
    });
    editor.textContent = ""; await tick(); testState.now += 1100; await tick(); await tick();
    check("unread Bob chat opens and receives its own latest twenty messages", () => {
      const payload = testState.requests.filter(m => m.type === "generate").at(-1);
      assert(title.textContent === "Bob" && testState.sendCount === manualBefore + 2, `Unread Bob was not answered: ${$("status").textContent}`);
      assert(payload.identity.includes("chat-b") && payload.messages.length === 20 && payload.messages.every(m => m.text.includes("Bob")), "Other chat context leaked into Bob's request");
    });
    await tick(); testState.now += 1100; await tick(); await tick();
    check("multiple unread conversations are answered sequentially", () => {
      assert(title.textContent === "Carol" && testState.sendCount === manualBefore + 3, `Unread Carol was not answered: ${$("status").textContent}`);
      assert(testState.monitor.enabled && testState.monitor.mode === "auto" && testState.monitor.scope === "all", "Monitoring preference was not saved");
    });
    // Simulate a legacy saved Draft preference before loading this update.
    testState.monitor = { ...testState.monitor, mode: "draft" }; delete testState.monitor.replyModeVersion;
    // Simulate content-script reload with saved extension storage and the same Teams DOM.
    window.dispatchEvent(new Event("pagehide"));
    document.getElementById("teams-local-replies").remove();
    const reloaded = document.createElement("script"); reloaded.src = "../extension/content.js?reload-check";
    const ready = new Promise(resolve => { reloaded.onload = resolve; }); document.body.append(reloaded); await ready; await wait(); await wait();
    check("upgrade migrates saved Draft to Automatic send and resumes without Select or Start", () => {
      assert($("start").disabled && !$("pause").disabled && $("mode").value === "auto", `Monitoring did not resume: ${$("status").textContent}`);
    });
    const carolIncoming = document.createElement("div"); carolIncoming.dataset.tid = "chat-pane-message"; carolIncoming.dataset.messageId = "carol-new"; carolIncoming.dataset.authorName = "Carol";
    const carolBody = document.createElement("p"); carolBody.dataset.tid = "message-body"; carolBody.textContent = "Another question after reload"; carolIncoming.append(carolBody); list.append(carolIncoming); list.scrollTop = list.scrollHeight;
    await tick(); testState.now += 1100; await tick(); await tick();
    check("new messages are sent automatically after reload", () => assert(testState.sendCount === manualBefore + 4, `No automatic reply after reload: ${$("status").textContent}`));
    const uncertainIncoming = carolIncoming.cloneNode(true); uncertainIncoming.dataset.messageId = "carol-uncertain";
    uncertainIncoming.querySelector("p").textContent = "A message with no outgoing echo"; list.append(uncertainIncoming); list.scrollTop = list.scrollHeight;
    testState.suppressEcho = true;
    await tick(); testState.now += 1100; await tick(); testState.now += 13000; await tick();
    const requestsAfterUncertain = testState.requests.length;
    await tick();
    check("uncertain delivery stops once and keeps the delivery warning", () => {
      assert($("status").textContent.includes("Delivery is uncertain") && !$("start").disabled, "Uncertain send did not stop monitoring");
      assert(testState.requests.length === requestsAfterUncertain, "A paused uncertain send kept issuing heartbeat or generation requests");
    });
    testState.suppressEcho = false;
    await click("pause");
    check("Pause disables saved monitoring for future sessions", () => assert(testState.monitor.enabled === false, "Pause did not persist"));
    document.getElementById("test-result").textContent = `PASS (${checked.length} browser checks)\n${checked.join("\n")}`;
    document.documentElement.dataset.testResult = "pass";
  } catch (error) {
    document.getElementById("test-result").textContent = `FAIL: ${error.message}\n${error.stack}`;
    document.documentElement.dataset.testResult = "fail";
  }
})();
