(async function () {
  "use strict";
  if (document.getElementById("teams-local-replies")) return;
  const Core = TeamsReplyCore;
  const Teams = TeamsReplyAdapter;
  const host = document.createElement("div");
  host.id = "teams-local-replies";
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "closed" });
  // This template is static. All chat/model text is assigned through textContent/value.
  shadow.innerHTML = `<style>
    :host{font:13px/1.5 system-ui,sans-serif;color:#edf0ff;color-scheme:dark}
    section{width:310px;max-width:calc(100vw - 32px);max-height:calc(100vh - 60px);overflow:auto;background:#202334;border:1px solid #555b7c;border-radius:14px;box-shadow:0 10px 40px #0006;padding:14px}
    header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}strong{font-size:15px}
    button,select{font:inherit;background:#383e5b;color:#fff;border:1px solid #687094;border-radius:7px;padding:6px 10px;cursor:pointer}button:disabled{opacity:.45;cursor:default}
    button.primary{background:#6254cf}button.pause{background:#8a3844}button:hover{filter:brightness(1.15)}
    .row{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}label{display:flex;align-items:center;gap:7px}
    p{margin:6px 0;overflow-wrap:anywhere}#status{color:#c8cdec}#selected{color:#a9f0ce}
    textarea{box-sizing:border-box;width:100%;height:100px;resize:vertical;background:#151827;color:#fff;border:1px solid #555b7c;border-radius:7px;padding:8px;font:inherit}
    details{margin-top:10px}pre{white-space:pre-wrap;max-height:180px;overflow:auto;background:#151827;padding:8px;border-radius:7px}
    [hidden]{display:none!important}small{color:#b8bfd7}
  </style><section aria-label="Teams Local Replies">
    <header><strong>Local Replies <small>v0.2.7</small></strong><button id="collapse" aria-label="Collapse panel">−</button></header>
    <div id="controls">
      <p id="selected">No chat selected</p><p id="status" role="status">Paused. Open Settings to configure your model and name.</p>
      <div class="row"><button id="settings">Settings</button><button class="primary" id="select">Select this chat</button><button id="diagnose">Check Teams page</button></div>
      <label>New incoming messages <select id="mode"><option value="auto">Automatic send</option><option value="draft">Draft</option></select></label>
      <label>Watch <select id="scope"><option value="all">All unread direct chats</option><option value="selected">Selected chat only</option></select></label>
      <div class="row"><button class="primary" id="start">Start</button><button class="pause" id="pause" disabled>Pause</button><button id="generate" disabled>Generate &amp; send</button><button id="preview" disabled>Preview reply</button></div>
      <textarea id="draft" aria-label="Generated reply" placeholder="Your generated reply appears here. You can edit it before inserting."></textarea>
      <div class="row"><button class="primary" id="send" disabled>Send reply</button><button id="insert" disabled>Insert draft</button><button id="dismiss">Dismiss</button></div>
      <details id="inspection"><summary>Inspect loaded context / page check</summary><div class="row"><button id="inspect">Refresh context</button><button id="copy-report" hidden>Copy page check</button></div><pre id="context">Select a chat to inspect its recent messages.</pre></details>
      <p id="inbox-status"><small>Unread inbox has not been scanned yet.</small></p>
      <small>Start once to keep replies enabled across reloads. Keep Teams open. Unread direct chats open automatically; Pause turns monitoring off.</small>
    </div>
  </section>`;
  document.body.append(host);
  const $ = id => shadow.getElementById(id);
  const status = message => { $("status").textContent = message; };
  let pageReport = "";
  let config, selected = null, running = false, busy = false, epoch = 0, baseline = "", due = 0;
  let draftSnapshot = null, pendingDelivery = null, userRevision = 0, selectedMode = "auto";
  let inserting = false, navigating = false, monitor = Core.monitorSettings();
  let resumePending = false, resumeDue = 0;
  const unreadSeen = new Map();
  const unreadQueue = new Map();
  const unsupportedChats = new Set();
  let scanDue = 0, lastUnreadCount = 0;
  const marks = new Map();
  async function saveMonitor() { await chrome.storage.local.set({ monitor }); }
  function bind(snapshot) {
    selected = snapshot;
    $("selected").textContent = `Selected: ${snapshot.title}`;
    $("generate").disabled = false; $("preview").disabled = false;
  }
  const token = crypto.randomUUID();
  async function request(message) {
    const response = await chrome.runtime.sendMessage({ ...message, token });
    if (!response?.ok) throw new Error(response?.error || "Extension connection lost. Reload Teams.");
    return response;
  }
  async function loadConfig() {
    const { config: raw } = await chrome.storage.local.get("config");
    config = Core.settings(raw);
  }
  function pause(message = "Paused.", disable = false) {
    running = false; epoch++; due = 0;
    if (pendingDelivery) pendingDelivery.waiting = false;
    if (disable) { resumePending = false; monitor = { ...monitor, enabled: false }; void saveMonitor().catch(error => status(error.message)); }
    $("start").disabled = $("scope").value === "selected" && !selected; $("pause").disabled = !monitor.enabled; $("mode").disabled = false; $("scope").disabled = false;
    status(message);
    void request({ type: "release" }).catch(() => {});
  }
  function clearDraft() {
    $("draft").value = ""; draftSnapshot = null; $("insert").disabled = true; $("send").disabled = true;
  }
  async function insertReply(reply) {
    inserting = true;
    try { return await Teams.insert(config, reply); }
    finally { inserting = false; }
  }
  function current() {
    if (!selected) throw new Error("Open a direct or group chat and click Select this chat first.");
    const result = Teams.snapshot(config);
    if (result.identity !== selected.identity || result.title !== selected.title) throw new Error("The selected conversation changed. Select it again before starting.");
    if (!result.atBottom) throw new Error(result.hasScroller ? "Scroll to the bottom of the chat before continuing." : "Cannot identify the message scroller. Update its selector in Settings.");
    return result;
  }
  function inspect(snapshot) {
    $("copy-report").hidden = true;
    $("context").textContent = `${snapshot.title}\nConversation key: ${snapshot.chatId || "not available (automatic sending disabled)"}\n\n` +
      snapshot.messages.map(m => `${m.role === "me" ? "Me" : m.author}: ${m.text}${(m.media || []).map(item => ` [${item.kind}: ${item.label}]`).join("")}`).join("\n\n");
  }
  function showPageCheck(error) {
    pageReport = (error ? `Selection failed: ${error.message}\n\n` : "") + Teams.diagnostics(config);
    $("context").textContent = pageReport;
    $("inspection").open = true; $("copy-report").hidden = false;
  }
  function keepDraft(snapshot, reply) {
    $("draft").value = reply; draftSnapshot = snapshot;
    $("insert").disabled = false; $("send").disabled = false;
  }
  async function deliver(snapshot, reply, version, revision, manual) {
    const fresh = () => version === epoch && (manual || running) && revision === userRevision && Core.isFresh(snapshot, current());
    try {
      if (!fresh()) throw new Error("The conversation changed before insertion. Generate a new reply.");
      status("Inserting reply into Teams…");
      await insertReply(reply);
      if (!fresh()) throw new Error("The conversation changed after insertion. Review the unsent composer draft.");
      await request({ type: "heartbeat" });
      if (!fresh()) throw new Error("Sending was cancelled. Review the composer draft.");
      status("Sending reply through Teams…");
      await Teams.send(config, reply, fresh);
      pendingDelivery = { reply, waiting: true, started: Date.now(), snapshot };
      clearDraft();
      status("Send clicked. Waiting for the outgoing message…");
    } catch (error) {
      if (version === epoch) { keepDraft(snapshot, reply); showPageCheck(error); }
      throw new Error(`Automatic send stopped: ${error.message}`);
    }
  }
  async function generate(manual = false, replyMode = selectedMode) {
    if (busy) throw new Error("A reply is already being generated.");
    if ($("draft").value.trim()) throw new Error("Insert or dismiss the existing draft before generating another reply.");
    let snapshot = current();
    // Group monitoring prepares reviewable drafts; explicit send actions still send.
    if (snapshot.isGroup && !manual) replyMode = "draft";
    if (replyMode === "auto" && !snapshot.chatId) throw new Error("Automatic sending requires a stable conversation identity.");
    if (snapshot.messages.at(-1).role !== "other") throw new Error("The latest message is yours. Waiting for the other person.");
    if (!Teams.composerEmpty(config)) throw new Error("Your composer contains a draft or attachment. It was preserved.");
    const version = epoch, revision = userRevision;
    busy = true;
    $("pause").disabled = false; $("start").disabled = true;
    inspect(snapshot);
    status(`Generating locally from ${snapshot.messages.length} loaded messages…`);
    try {
      await request({ type: "claim" });
      if (version !== epoch) return;
      const history = await Teams.recentHistory(config, () => version === epoch && revision === userRevision);
      snapshot = current();
      const lastContext = history.at(-1), lastLoaded = snapshot.messages.at(-1);
      if (lastContext?.id !== lastLoaded?.id || lastContext?.text !== lastLoaded?.text ||
          !Core.isFresh(snapshot, current()) || revision !== userRevision || !Teams.composerEmpty(config)) {
        status("Conversation changed before generation. Try again when it settles."); return;
      }
      inspect({ ...snapshot, messages: history });
      status(`Generating locally from ${history.length} recent messages, including media…`);
      const { reply } = await request({ type: "generate", identity: snapshot.identity,
        isGroup: snapshot.isGroup,
        messages: history.map(({ id, text, role, author, media }) => ({ id, text: text.slice(0, Core.conversationConfig(config, snapshot.isGroup).maxContextChars), role, author, ...(media?.length ? { media } : {}) })), manual });
      if (version !== epoch) return;
      const latest = current();
      if (!Core.isFresh(snapshot, latest) || revision !== userRevision || !Teams.composerEmpty(config)) {
        status("Discarded the reply because the conversation or composer changed."); return;
      }
      if (replyMode === "auto" && (manual || running)) {
        await deliver(snapshot, reply, version, revision, manual);
      } else {
        keepDraft(snapshot, reply);
        status(`${snapshot.isGroup ? "Group draft" : "Preview"} ready. Use Send reply to send it, or Insert draft to edit it in Teams.`);
      }
    } finally {
      busy = false;
      if (!running && !pendingDelivery) {
        $("pause").disabled = !monitor.enabled; $("start").disabled = false;
        void request({ type: "release" }).catch(() => {});
      }
    }
  }
  function act(id, action) {
    $(id).addEventListener("click", () => Promise.resolve().then(action).catch(error => {
      if (running) pause(error.message); else status(error.message);
      if ((id === "select" || id === "inspect") && config) showPageCheck(error);
    }));
  }
  $("scope").addEventListener("change", () => { $("start").disabled = $("scope").value === "selected" && !selected; });
  act("settings", () => request({ type: "settings" }));
  act("select", async () => {
    selected = null; $("selected").textContent = "No chat selected"; $("generate").disabled = true; $("preview").disabled = true;
    pause(); clearDraft(); pendingDelivery = null;
    await loadConfig();
    selected = Teams.snapshot(config);
    $("start").disabled = false; $("generate").disabled = false; $("preview").disabled = false;
    $("selected").textContent = `Selected: ${selected.title}`;
    inspect(selected);
    status("Chat selected. Check the sender labels in Inspect loaded context before starting.");
  });
  act("diagnose", async () => {
    await loadConfig(); showPageCheck();
    status("Page check ready below. Copy it to share the selector results; it contains no message text.");
  });
  act("copy-report", async () => {
    await navigator.clipboard.writeText(pageReport);
    status("Page check copied. Paste it into the chat with Codex.");
  });
  act("inspect", () => inspect(Teams.snapshot(config)));
  async function start(resuming = false) {
    if (busy) throw new Error("Wait for the current generation to finish.");
    if (!config.selfName) throw new Error("Set your exact Teams display name in Settings first.");
    selectedMode = resuming ? monitor.mode : $("mode").value;
    const scope = resuming ? monitor.scope : $("scope").value;
    const version = epoch;
    if (pendingDelivery) throw new Error("Previous delivery is uncertain. Check the conversation, then select the chat again.");
    let snapshot;
    if (resuming && scope === "selected" && !selected) {
      const opened = Teams.snapshot(config);
      if (opened.identity !== monitor.identity) throw new Error("Open the previously selected chat or choose All unread direct chats and press Start.");
      bind(opened);
    }
    try { snapshot = scope === "selected" ? current() : Teams.snapshot(config); }
    catch (error) { if (scope === "selected") throw error; }
    if (snapshot) {
      if (selectedMode === "auto" && !snapshot.isGroup && !snapshot.chatId && scope === "selected") throw new Error("Automatic sending requires a stable conversation identity (chat ID or one-to-one participant ID). Draft mode is available.");
      if (scope === "selected" && !Teams.composerEmpty(config)) throw new Error("Clear or send your existing Teams draft before starting.");
    }
    await request({ type: "claim" });
    if (version !== epoch) { void request({ type: "release" }).catch(() => {}); return; }
    if (snapshot && Core.fingerprint(snapshot) !== Core.fingerprint(Teams.snapshot(config))) throw new Error("The conversation changed while starting. Press Start again.");
    monitor = { enabled: true, mode: selectedMode, scope, replyModeVersion: 3, ...(scope === "selected" && snapshot ? { identity: snapshot.identity } : {}) };
    await saveMonitor();
    if (version !== epoch) return;
    running = true; resumePending = false; epoch++; due = 0;
    if (snapshot) {
      bind(snapshot); baseline = Core.fingerprint(snapshot); marks.set(snapshot.identity, baseline);
      if (resuming && snapshot.atBottom && snapshot.messages.at(-1)?.role === "other") due = Date.now() + config.debounceMs;
    }
    $("mode").value = selectedMode; $("scope").value = scope;
    $("start").disabled = true; $("pause").disabled = false; $("mode").disabled = true; $("scope").disabled = true;
    status(`Watching ${scope === "all" ? "all unread direct chats" : snapshot?.isGroup ? "this group (50-message context)" : "this chat"} (${scope === "selected" && snapshot?.isGroup || selectedMode === "draft" ? "draft mode" : "automatic send"}). Enabled across reloads.`);
    if (scope === "all") {
      unreadQueue.clear(); unreadSeen.clear(); unsupportedChats.clear(); scanDue = 0;
      await scanInbox(true);
      if (running) await navigateUnread();
    } else $("inbox-status").textContent = "Watching the selected chat only.";
  }
  act("start", () => start());
  act("pause", () => pause("Paused. Automatic monitoring is off until you press Start.", true));
  act("generate", () => generate(true, "auto"));
  act("preview", () => generate(true, "draft"));
  act("send", async () => {
    if (busy) throw new Error("Wait for the current reply operation to finish.");
    if (pendingDelivery) throw new Error("Check the previous delivery before sending another reply.");
    const snapshot = draftSnapshot, reply = $("draft").value.trim();
    if (!snapshot || !Core.isFresh(snapshot, current())) throw new Error("This draft is stale. Dismiss it and generate a new one.");
    if (!snapshot.chatId) throw new Error("Automatic sending requires a stable conversation identity.");
    if (!reply) throw new Error("The draft is empty.");
    const version = epoch, revision = userRevision;
    busy = true;
    try {
      await request({ type: "claim" });
      if (version !== epoch) return;
      await deliver(snapshot, reply, version, revision, true);
    } finally {
      busy = false;
      if (!running && !pendingDelivery) void request({ type: "release" }).catch(() => {});
    }
  });
  act("insert", async () => {
    if (!draftSnapshot || !Core.isFresh(draftSnapshot, current())) throw new Error("This draft is stale. Dismiss it and generate a new one.");
    const snapshot = draftSnapshot, reply = $("draft").value.trim(), version = epoch;
    $("insert").disabled = true;
    try {
      await insertReply(reply);
      if (version !== epoch || draftSnapshot !== snapshot) return;
      if ($("draft").value.trim() === reply) clearDraft();
      status("Inserted into Teams. Review it and press Teams Send.");
    } finally {
      $("insert").disabled = !draftSnapshot;
    }
  });
  act("dismiss", () => { clearDraft(); status(running ? "Draft dismissed. Watching for new messages." : "Draft dismissed."); });
  act("collapse", () => {
    $("controls").hidden = !$("controls").hidden;
    $("collapse").textContent = $("controls").hidden ? "+" : "−";
    $("collapse").setAttribute("aria-label", $("controls").hidden ? "Expand panel" : "Collapse panel");
  });
  // Trusted typing/focus activity cancels an in-flight automatic reply, even if text is later cleared.
  document.addEventListener("input", event => { if (event.isTrusted && !inserting) userRevision++; }, true);
  document.addEventListener("keydown", event => {
    if (event.isTrusted && event.target?.isContentEditable) userRevision++;
  }, true);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.monitor?.newValue) {
      monitor = Core.monitorSettings(changes.monitor.newValue);
      if (!monitor.enabled && running) pause("Monitoring was turned off in another Teams window.");
    }
    if (changes.config) {
      selected = null; $("generate").disabled = true; $("preview").disabled = true;
      pause("Settings changed. Reloading configuration…"); clearDraft(); $("selected").textContent = "No chat selected";
      resumePending = monitor.enabled;
      void loadConfig().then(() => { if (monitor.enabled) return start(true); }).catch(error => status(error.message));
    }
  });
  async function scanInbox(force = false) {
    if (!running || monitor.scope !== "all" || busy || pendingDelivery || navigating || !force && Date.now() < scanDue) return;
    const version = epoch, revision = userRevision;
    navigating = true;
    $("inbox-status").textContent = "Scanning unread chats…";
    try {
      const result = await Teams.scanUnread(config, () => running && version === epoch && revision === userRevision);
      if (version !== epoch || !running || revision !== userRevision) return;
      for (const item of result.unread) {
        if (unsupportedChats.has(item.key)) continue;
        const previous = unreadSeen.get(item.key);
        if (!previous || previous.signature !== item.signature || previous.until <= Date.now()) unreadQueue.set(item.key, item);
      }
      for (const item of result.entries.filter(item => !item.unread)) unreadSeen.delete(item.key);
      if (unreadSeen.size > 500) unreadSeen.delete(unreadSeen.keys().next().value);
      lastUnreadCount = result.unread.length;
      $("inbox-status").textContent = !result.rowCount && !result.filtered
        ? "No sidebar chat rows detected. Open the chat list or use Check Teams page."
        : `Unread inbox: ${result.unread.length} found, ${unreadQueue.size} queued. Scanning while enabled.`;
    } catch (error) {
      if (version === epoch) $("inbox-status").textContent = `Unread scan failed: ${error.message}`;
    } finally { navigating = false; scanDue = Date.now() + 3000; }
  }
  async function navigateUnread() {
    if (!running || monitor.scope !== "all" || busy || pendingDelivery || navigating || $("draft").value.trim()) return false;
    await scanInbox();
    const candidates = unreadQueue.size;
    for (let attempt = 0; attempt < candidates && running; attempt++) {
      const target = unreadQueue.values().next().value;
      if (!target) return false;
      const version = epoch, revision = userRevision;
      try {
        if (!Teams.composerEmpty(config)) { status("Unread chats are queued; waiting for your Teams draft to be cleared."); return false; }
      } catch (error) {
        if (!/found 0\./.test(error.message)) { status(error.message); return false; }
      }
      navigating = true; unreadQueue.delete(target.key);
      $("inbox-status").textContent = `Unread inbox: ${lastUnreadCount} found, ${unreadQueue.size} queued. Scanning while enabled.`;
      status(`Opening unread chat from ${target.title} (${unreadQueue.size} more queued)…`);
      try {
        const opened = await Teams.openUnread(config, target, () => running && version === epoch && revision === userRevision);
        if (version !== epoch || !running || revision !== userRevision) return false;
        // Once opening marks a chat read, a new unread appearance is a new event,
        // even if its preview text is identical and the person replies immediately.
        if (Teams.unreadChats(config).some(item => item.key === target.key)) {
          unreadSeen.set(target.key, { signature: target.signature, until: Date.now() + 5000 });
        } else unreadSeen.delete(target.key);
        if (!opened.chatId && selectedMode === "auto") { status("Skipped an unread chat without a stable conversation identity."); continue; }
        bind(opened); baseline = Core.fingerprint(opened); marks.set(opened.identity, baseline);
        due = opened.messages.at(-1)?.role === "other" ? Date.now() + config.debounceMs : 0;
        inspect(opened);
        status(due ? `Unread chat opened. Preparing a reply (${unreadQueue.size} more queued)…` : `Unread chat has no unanswered incoming message (${unreadQueue.size} more queued).`);
        return true;
      } catch (error) {
        if (version === epoch && running) {
          if (error.code === "UNSUPPORTED_CHAT") unsupportedChats.add(target.key);
          unreadSeen.set(target.key, { signature: target.signature, until: Date.now() + 30000 });
          status(`Skipped unread chat: ${error.message}`);
        }
        if (version !== epoch || revision !== userRevision) return false;
      } finally { navigating = false; }
    }
    return false;
  }
  let ticking = false;
  setInterval(async () => {
    if (resumePending && !running && !busy && !ticking && Date.now() >= resumeDue) {
      resumeDue = Date.now() + 5000;
      try { await start(true); } catch (error) { status(`Waiting to resume: ${error.message}`); }
    }
    if ((!running && !pendingDelivery?.waiting) || busy || ticking || navigating) return;
    ticking = true;
    try {
      await request({ type: "heartbeat" });
      if (busy || !running && !pendingDelivery) return;
      if (running && monitor.scope === "all" && !pendingDelivery) await scanInbox();
      if (!running && !pendingDelivery?.waiting) return;
      let snapshot;
      if (running && monitor.scope === "all" && !pendingDelivery && !busy) {
        try { snapshot = Teams.snapshot(config); }
        catch {
          due = 0;
          selected = null; $("generate").disabled = true; $("preview").disabled = true; $("selected").textContent = "Waiting for an unread direct chat";
          await navigateUnread(); return;
        }
        if (snapshot.isGroup) { due = 0; await navigateUnread(); return; }
        if (!selected || snapshot.identity !== selected.identity) {
          bind(snapshot); baseline = marks.get(snapshot.identity) || Core.fingerprint(snapshot);
          due = snapshot.messages.at(-1)?.role === "other" ? Date.now() + config.debounceMs : 0;
        }
        if (!Teams.composerEmpty(config)) { status("Unread chats are queued; waiting for your Teams draft to be cleared."); return; }
        if (!snapshot.atBottom) {
          await navigateUnread(); return;
        }
        if (selectedMode === "auto" && !snapshot.chatId) { status("Waiting for a direct chat with a stable conversation identity."); await navigateUnread(); return; }
      } else snapshot = current();
      if (pendingDelivery) {
        const delivered = snapshot.messages.some(m => m.role === "me" &&
          !pendingDelivery.snapshot.messages.some(old => old.id === m.id) && Core.normalize(m.text) === Core.normalize(pendingDelivery.reply));
        if (delivered) {
          pendingDelivery = null; baseline = Core.fingerprint(snapshot); marks.set(snapshot.identity, baseline);
          due = snapshot.messages.at(-1).role === "other" ? Date.now() + config.debounceMs : 0;
          if (!running) pause("Reply appeared in the conversation.");
          else status("Reply appeared in the conversation. Watching for new messages.");
        }
        else if (Date.now() - pendingDelivery.started > 12000) pause("Delivery is uncertain. Check Teams before selecting the chat again. No retry was made.");
        return;
      }
      const mark = Core.fingerprint(snapshot);
      if (mark !== baseline) {
        baseline = mark; marks.set(snapshot.identity, mark);
        due = snapshot.messages.at(-1).role === "other" ? Date.now() + config.debounceMs : 0;
      }
      if (!due && running && monitor.scope === "all" && !$("draft").value.trim()) {
        if (await navigateUnread()) return;
      }
      if (due && Date.now() >= due && !busy && !$("draft").value.trim()) {
        due = 0;
        const probe = await request({ type: "attempted", identity: snapshot.identity,
          isGroup: snapshot.isGroup,
          messages: snapshot.messages.map(({ id, text, role, author }) => ({ id, text: text.slice(0, Core.conversationConfig(config, snapshot.isGroup).maxContextChars), role, author })) });
        if (!probe.attempted) await generate();
        else status("Latest incoming message was already handled. Watching for new messages.");
      }
    } catch (error) {
      if (running && monitor.scope === "all" && !pendingDelivery && !error.message.includes("session expired")) {
        due = 0; status(`${error.message} Watching for the next incoming message.`);
      } else pause(error.message);
    }
    finally { ticking = false; }
  }, 1000);
  window.addEventListener("pagehide", () => pause());
  try {
    await loadConfig();
    const saved = await chrome.storage.local.get("monitor");
    if (saved.monitor) {
      monitor = Core.monitorSettings(saved.monitor);
      if (saved.monitor.replyModeVersion !== 3) await saveMonitor();
    }
    $("pause").disabled = !monitor.enabled;
    $("mode").value = monitor.mode; $("scope").value = monitor.scope;
    if (monitor.enabled) {
      resumePending = true;
      // A saved selected-chat mode is scoped to its previous recipient only.
      if (monitor.scope === "selected") {
        const opened = Teams.snapshot(config);
        if (monitor.identity && opened.identity !== monitor.identity) throw new Error("Open the previously selected chat or choose All unread direct chats and press Start.");
        bind(opened);
      }
      await start(true);
    }
  } catch (error) { status(error.message); }
})();
