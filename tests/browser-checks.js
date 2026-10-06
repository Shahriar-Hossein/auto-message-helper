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
    if (id === "start" && $("scope").value === "all") await new Promise(resolve => setTimeout(resolve, 2500));
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
    // The PWA can expose Send as a clickable div without a button role.
    // Keep that control for all unread-queue and reload tests below.
    const pwaSend = document.createElement("div"); pwaSend.dataset.tid = "sendMessageCommands-send"; pwaSend.textContent = "Send";
    pwaSend.addEventListener("click", testState.sendFixtureReply); actualSend.replaceWith(pwaSend);
    // Match the supplied report: Teams switches to the simplified composer when
    // text is inserted, changing the Send data-tid after configuration was saved.
    testState.config = { ...testState.config, selectors: { ...testState.config.selectors,
      send: '[data-tid="sendMessageCommands-send"], button[data-tid="send-message"], button[data-tid="sendMessageButton"]' } };
    editor.addEventListener("input", () => { pwaSend.dataset.tid = "newMessageCommands-send"; }, { once: true });
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
    $("scope").value = "all"; $("mode").value = "auto";
    editor.textContent = "Preserve my unfinished message"; await click("start"); await tick();
    check("all-chat monitoring waits while the current composer contains a draft", () => {
      assert(main.dataset.chatId === "chat-a" && editor.textContent === "Preserve my unfinished message", "Unread navigation discarded an existing draft");
    });
    editor.textContent = ""; await tick(); testState.now += 1100; await tick(); await tick();
    check("unread Bob chat opens and receives its own latest twenty messages", () => {
      const payload = testState.requests.filter(m => m.type === "generate").at(-1);
      assert(title.textContent === "Bob" && testState.sendCount === manualBefore + 2, `Unread Bob was not answered: ${$("status").textContent}`);
      assert(payload.identity.includes("chat-b") && payload.messages.length === 20 && payload.messages.every(m => m.text.includes("Bob")), "Other chat context leaked into Bob's request");
    });
    check("automatic replies click a roleless PWA Send control and leave no manual draft", () => {
      assert(pwaSend.tagName === "DIV" && !pwaSend.hasAttribute("role"), "Fixture still requires a native button");
      assert(editor.innerText === "" && $("draft").value === "" && $("status").textContent.includes("Reply appeared"), "Automatic send left a draft awaiting a manual click");
    });
    check("saved selector defaults support the simplified toolbar appearing during insertion", () => {
      assert(pwaSend.dataset.tid === "newMessageCommands-send" && !document.querySelector('[data-tid="sendMessageCommands-send"]'), "Fixture still exposes the previous Send toolbar");
      assert(TeamsReplyAdapter.diagnostics(TeamsReplyCore.settings(testState.config)).includes("send: 1 / 1"), "Reported simplified Send control was not matched");
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
    sidebar.remove();
    await click("select");
    // Reproduce the reported PWA: no chat data-tid or data-chat-id, accessible
    // headings in clickable rows, an unread dot, and the native Unread filter.
    const personalSidebar = document.createElement("aside");
    const unreadFilter = document.createElement("button"); unreadFilter.textContent = "Unread"; unreadFilter.setAttribute("aria-label", "Filter unread chats"); unreadFilter.setAttribute("aria-pressed", "false");
    const personalList = document.createElement("div"); personalList.style.cssText = "height:220px;overflow-y:auto";
    personalSidebar.append(unreadFilter, personalList); document.body.prepend(personalSidebar);
    const contacts = [
      { name: "Already read friend", unread: false, preview: "Old incoming message", revision: 0 },
      { name: "Abid Hasan", unread: true, preview: "hello chuckles...i heard...", revision: 0 },
      { name: "Dina", unread: true, preview: "Hello", revision: 0 }
    ];
    function renderPersonalSidebar() {
      personalList.replaceChildren();
      for (const contact of contacts) {
        if (unreadFilter.getAttribute("aria-pressed") === "true" && !contact.unread) continue;
        const row = document.createElement("div"); row.tabIndex = 0; row.setAttribute("role", "button"); row.style.cssText = "height:60px;cursor:pointer";
        const avatar = document.createElement("span"); avatar.setAttribute("role", "img"); avatar.textContent = "●";
        const lines = document.createElement("div");
        const name = document.createElement("div"); if (contact.name !== "Ehsan") name.setAttribute("role", "heading"); name.style.fontWeight = contact.unread ? "700" : "400"; name.textContent = contact.name;
        const preview = document.createElement("div"); preview.textContent = contact.preview; lines.append(name, preview);
        const nameButton = contact.name === "Dina" ? document.createElement("button") : null;
        if (nameButton) { nameButton.append(lines); row.append(avatar, nameButton); } else row.append(avatar, lines);
        if (contact.unread) { const dot = document.createElement("span"); dot.setAttribute("aria-label", "Unread"); dot.textContent = "•"; row.append(dot); }
        (nameButton || row).addEventListener("click", () => {
          contact.unread = false; main.dataset.chatId = `personal-${contact.name}`; title.textContent = contact.name;
          list.replaceChildren();
          for (let i = 0; i < 25; i++) {
            const message = document.createElement("div"); message.dataset.tid = "chat-pane-message"; message.dataset.messageId = `${contact.name}-${contact.revision}-${i}`; message.dataset.authorName = contact.name;
            const body = document.createElement("p"); body.dataset.tid = "message-body"; body.textContent = `${contact.name}: ${contact.preview} (${i})`; message.append(body); list.append(message);
          }
          list.scrollTop = list.scrollHeight; renderPersonalSidebar();
        });
        personalList.append(row);
      }
    }
    unreadFilter.addEventListener("click", () => {
      unreadFilter.setAttribute("aria-pressed", unreadFilter.getAttribute("aria-pressed") === "true" ? "false" : "true"); renderPersonalSidebar();
    });
    renderPersonalSidebar();
    const initialPersonal = TeamsReplyAdapter.unreadChats(testState.config);
    const initialDinaNode = initialPersonal.find(item => item.title === "Dina").node;
    check("reported PWA heading rows and unread dots are detected without chat data attributes", () => {
      assert(document.querySelectorAll(testState.config.selectors.chatItem).length === 0, "Fixture accidentally uses configured chat row selectors");
      assert(initialPersonal.map(item => item.title).join(",") === "Abid Hasan,Dina", "Unread dots were not bound to their own named rows");
      assert(!initialPersonal.some(item => item.title === "Unread" || item.title === "Already read friend"), "Filter or read chat was treated as unread");
    });
    list.scrollTop = 0;
    const personalBefore = testState.sendCount;
    $("scope").value = "all"; $("mode").value = "auto"; await click("start");
    check("Start immediately scans existing unread chats even above the current chat's latest message", () => {
      assert(unreadFilter.getAttribute("aria-pressed") === "true", "Native Unread filter was not activated");
      assert(title.textContent === "Abid Hasan" && $("status").textContent.includes("Preparing a reply"), `Existing unread chat was not opened on Start: ${$("status").textContent}`);
      assert($("inbox-status").textContent.includes("2 found"), "Initial unread scan count was not shown");
      assert(!initialDinaNode.isConnected, "Fixture did not recycle the queued sidebar DOM row");
    });
    testState.now += 1100; await tick(); await tick();
    check("first existing unread PWA chat receives an automatic reply", () => assert(testState.sendCount === personalBefore + 1, `No reply to the first unread chat: ${$("status").textContent}`));
    await tick(); testState.now += 1100; await tick(); await tick();
    check("queued PWA chats are resolved after sidebar rerenders and answered one by one", () => {
      assert(title.textContent === "Dina" && testState.sendCount === personalBefore + 2, `Second queued chat was not answered: ${$("status").textContent}`);
      const payload = testState.requests.filter(message => message.type === "generate").at(-1);
      assert(payload.messages.every(message => message.text.includes("Dina")), "Queued reply used the previous recipient's context");
    });
    contacts.push({ name: "Ehsan", unread: true, preview: "A new message while the watcher is on", revision: 0 }); renderPersonalSidebar();
    testState.now += 3100; await tick(); testState.now += 1100; await tick(); await tick();
    check("new unread chats with plain-text names are discovered continuously without another Start", () => {
      assert(title.textContent === "Ehsan" && testState.sendCount === personalBefore + 3, `New unread chat was missed: ${$("status").textContent}`);
    });
    const abid = contacts.find(contact => contact.name === "Abid Hasan"); abid.unread = true; abid.revision++; renderPersonalSidebar();
    testState.now += 3100; await tick(); testState.now += 1100; await tick(); await tick();
    check("a previously answered person can become unread again with the same sidebar preview", () => {
      assert(title.textContent === "Abid Hasan" && testState.sendCount === personalBefore + 4, `Repeat unread contact was suppressed: ${$("status").textContent}`);
      const payload = testState.requests.filter(message => message.type === "generate").at(-1);
      assert(payload.messages.at(-1).id.includes("Abid Hasan-1-"), "Repeat contact used stale messages");
    });
    await click("pause");
    contacts.push({ name: "Paused contact", unread: true, preview: "Do not send while paused", revision: 0 }); renderPersonalSidebar();
    testState.now += 3100; await tick();
    check("Pause stops unread scanning and automatic queue delivery", () => assert(testState.sendCount === personalBefore + 4 && title.textContent === "Abid Hasan", "Paused watcher opened or answered another chat"));
    personalSidebar.remove();
    const virtualSidebar = document.createElement("div"); virtualSidebar.style.cssText = "height:120px;overflow-y:auto"; document.body.prepend(virtualSidebar);
    const virtualNames = Array.from({ length: 10 }, (_, i) => i === 1 ? "Visible unread" : i === 8 ? "Hidden unread" : `Read contact ${i}`);
    function renderVirtualSidebar() {
      const start = Math.min(8, Math.floor(virtualSidebar.scrollTop / 120) * 2);
      const before = document.createElement("div"); before.style.height = `${start * 60}px`;
      virtualSidebar.replaceChildren(before);
      for (let i = start; i < start + 2; i++) {
        const row = document.createElement("div"); row.setAttribute("role", "option"); row.style.height = "60px";
        const name = document.createElement("div"); name.setAttribute("role", "heading"); name.textContent = virtualNames[i]; row.append(name);
        if (i === 1 || i === 8) { const marker = document.createElement("span"); marker.setAttribute("aria-label", "Unread"); marker.textContent = "•"; row.append(marker); }
        row.addEventListener("click", () => {
          main.dataset.chatId = `virtual-contact-${i}`; title.textContent = virtualNames[i]; list.replaceChildren();
          const message = document.createElement("div"); message.dataset.tid = "chat-pane-message"; message.dataset.messageId = "hidden-incoming"; message.dataset.authorName = virtualNames[i];
          const body = document.createElement("p"); body.dataset.tid = "message-body"; body.textContent = "An unread message from outside the visible sidebar"; message.append(body); list.append(message); list.scrollTop = list.scrollHeight;
        });
        virtualSidebar.append(row);
      }
      const after = document.createElement("div"); after.style.height = `${(8 - start) * 60}px`; virtualSidebar.append(after);
    }
    virtualSidebar.addEventListener("scroll", event => { if (!event.isTrusted) renderVirtualSidebar(); });
    renderVirtualSidebar();
    const sidebarScan = await TeamsReplyAdapter.scanUnread(testState.config);
    const hiddenTarget = sidebarScan.unread.find(item => item.title === "Hidden unread");
    check("sidebar scanning discovers unread rows outside the loaded virtualized window", () => {
      assert(sidebarScan.unread.length === 2 && hiddenTarget, "An offscreen unread chat was not queued");
      assert(virtualSidebar.scrollTop === 0 && !hiddenTarget.node.isConnected, "Sidebar viewport was not restored or fixture did not recycle DOM");
    });
    const hiddenOpened = await TeamsReplyAdapter.openUnread(testState.config, hiddenTarget);
    check("a queued virtualized chat is rediscovered at its saved sidebar position", () => {
      assert(hiddenOpened.title === "Hidden unread" && hiddenOpened.messages.at(-1).text.includes("outside the visible sidebar"), "Queued virtualized row opened the wrong chat");
    });
    virtualSidebar.remove();
    const sendProbe = document.createElement("div"); sendProbe.setAttribute("data-send-probe", ""); sendProbe.textContent = "Send";
    const probeWrapper = document.createElement("div"); probeWrapper.append(sendProbe); main.append(probeWrapper);
    const probeConfig = { ...testState.config, selectors: { ...testState.config.selectors, send: "[data-send-probe]" } };
    editor.textContent = "Only this reply";
    let probeClicks = 0, clickedWhileDisabled = false;
    sendProbe.addEventListener("click", () => { probeClicks++; if (sendProbe.getAttribute("aria-disabled") === "true" || probeWrapper.hasAttribute("disabled")) clickedWhileDisabled = true; });
    sendProbe.setAttribute("aria-disabled", "true");
    setTimeout(() => sendProbe.setAttribute("aria-disabled", "false"), 2800);
    await TeamsReplyAdapter.send(probeConfig, "Only this reply");
    check("non-button Send waits for delayed enablement and clicks exactly once", () => assert(probeClicks === 1 && !clickedWhileDisabled, "Disabled control was clicked or slow enablement timed out"));
    probeWrapper.setAttribute("disabled", "");
    setTimeout(() => probeWrapper.removeAttribute("disabled"), 300);
    await TeamsReplyAdapter.send(probeConfig, "Only this reply");
    check("non-button Send honors disabled ancestors", () => assert(probeClicks === 2 && !clickedWhileDisabled, "Disabled wrapper was ignored"));
    sendProbe.setAttribute("aria-disabled", "true"); let validityChecks = 0, cancelledSend;
    try { await TeamsReplyAdapter.send(probeConfig, "Only this reply", () => ++validityChecks === 1); } catch (error) { cancelledSend = error; }
    check("waiting for Send cancels when conversation validity changes", () => assert(probeClicks === 2 && /conversation changed/.test(cancelledSend?.message || ""), "Stale reply clicked Send"));
    sendProbe.removeAttribute("aria-disabled");
    const extraSend = sendProbe.cloneNode(true); probeWrapper.append(extraSend); let ambiguousSend;
    try { await TeamsReplyAdapter.send(probeConfig, "Only this reply"); } catch (error) { ambiguousSend = error; }
    check("multiple non-button Send matches are rejected without clicking", () => assert(probeClicks === 2 && /More than one Send control/.test(ambiguousSend?.message || ""), "Ambiguous Send target was clicked"));
    extraSend.remove();
    const svgSend = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svgSend.setAttribute("data-send-probe", ""); svgSend.style.cssText = "width:24px;height:24px";
    sendProbe.replaceWith(svgSend); let svgClicks = 0; svgSend.addEventListener("click", () => svgClicks++);
    await TeamsReplyAdapter.send(probeConfig, "Only this reply");
    check("Send icons without a native click method receive a bubbling click", () => assert(svgClicks === 1, "SVG Send icon was not clicked exactly once"));
    const sendReport = TeamsReplyAdapter.diagnostics(probeConfig);
    check("page checks report Send control type and disabled state without reply text", () => assert(sendReport.includes("Send control: svg role=none; disabled=false") && !sendReport.includes("Only this reply"), "Send diagnostic metadata missing or text exposed"));
    probeWrapper.remove(); editor.textContent = "";
    document.getElementById("test-result").textContent = `PASS (${checked.length} browser checks)\n${checked.join("\n")}`;
    document.documentElement.dataset.testResult = "pass";
  } catch (error) {
    document.getElementById("test-result").textContent = `FAIL: ${error.message}\n${error.stack}`;
    document.documentElement.dataset.testResult = "fail";
  }
})();
