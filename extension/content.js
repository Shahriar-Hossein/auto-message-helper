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
    <header><strong>Local Replies <small>v0.2.11</small></strong><button id="collapse" aria-label="Collapse panel">−</button></header>
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
  let automaticDraft = null, waitingForBottom = false;
  let inserting = false, navigating = false, monitor = Core.monitorSettings();
  let resumePending = false, resumeDue = 0;
  const unreadSeen = new Map();
  const unreadQueue = new Map();
  const unsupportedChats = new Set();
  let scanDue = 0, lastUnreadCount = 0;
  const marks = new Map();
  const unanswered = new Map();
  function withPending(snapshot) {
    const pending = unanswered.get(snapshot.identity);
    if (!pending || snapshot.messages.at(-1)?.role === "other") return snapshot;
    // A subsequent human reply takes precedence over the bot's pending work.
    if (snapshot.messages.at(-1)?.id !== pending.outgoingId) {
      unanswered.delete(snapshot.identity); return snapshot;
    }
    const source = snapshot.messages.filter(m => m.role === "other" && pending.ids.has(m.id)).at(-1);
    return source ? { ...snapshot, replyTo: source.id } : snapshot;
  }
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
    running = false; waitingForBottom = false; epoch++; due = 0;
    if (pendingDelivery) pendingDelivery.waiting = false;
    if (disable) { resumePending = false; monitor = { ...monitor, enabled: false }; void saveMonitor().catch(error => status(error.message)); }
    $("start").disabled = $("scope").value === "selected" && !selected; $("pause").disabled = !monitor.enabled; $("mode").disabled = false; $("scope").disabled = false;
    status(message);
    void request({ type: "release" }).catch(() => {});
  }
  function clearDraft() {
    $("draft").value = ""; draftSnapshot = null; automaticDraft = null; $("insert").disabled = true; $("send").disabled = true;
  }
  function waitForBottom() {
    waitingForBottom = true;
    status("Waiting for the bottom of this chat. Automatic replies resume there.");
  }
  async function insertReply(reply, onInserted) {
    inserting = true;
    try { return await Teams.insert(config, reply, onInserted); }
    finally { inserting = false; }
  }
  function current(requireBottom = true) {
    if (!selected) throw new Error("Open a direct or group chat and click Select this chat first.");
    const result = Teams.snapshot(Core.conversationConfig(config, selected.isGroup));
    if (result.identity !== selected.identity || result.title !== selected.title) throw new Error("The selected conversation changed. Select it again before starting.");
    if (requireBottom && !result.atBottom) throw new Error(result.hasScroller ? "Scroll to the bottom of the chat before continuing." : "Cannot identify the message scroller. Update its selector in Settings.");
    return withPending(result);
  }
  function inspect(snapshot) {
    $("copy-report").hidden = true;
    $("context").textContent = `${snapshot.title}\nConversation key: ${snapshot.chatId || (snapshot.isGroup ? "not exposed by Teams (selected-group sending bound to the source message)" : "not available (automatic sending disabled)")}\n\n` +
      snapshot.messages.map(m => `${m.role === "me" ? "Me" : m.author}: ${m.text}${(m.media || []).map(item => ` [${item.kind}: ${item.label}]`).join("")}`).join("\n\n");
  }
  function showPageCheck(error) {
    pageReport = (error ? `Selection failed: ${error.message}\n\n` : "") + Teams.diagnostics(config);
    $("context").textContent = pageReport;
    $("inspection").open = true; $("copy-report").hidden = false;
  }
  function keepDraft(snapshot, reply, automatic = false) {
    $("draft").value = reply; draftSnapshot = snapshot;
    automaticDraft = automatic ? { snapshot, reply, revision: userRevision } : null;
    $("insert").disabled = false; $("send").disabled = false;
  }
  $("draft").addEventListener("input", () => { automaticDraft = null; });
  function reviewedDraft(snapshot, latest) {
    if (!snapshot) throw new Error("Generate a draft first.");
    if (!snapshot.isGroup) {
      if (!Core.isFresh(snapshot, latest)) throw new Error("This draft is stale. Dismiss it and generate a new one.");
      return;
    }
    const state = Core.groupDraftState(snapshot, latest);
    if (state === "conversation") throw new Error("This draft belongs to a different conversation. Select this group again.");
    if (state === "unavailable") throw new Error("The draft's original message is no longer loaded. Scroll to the latest messages or generate a new draft.");
    if (state === "edited") throw new Error("This draft is stale because its original message or sender changed. Dismiss it and generate a new one.");
  }
  async function deliver(snapshot, reply, version, revision, manual, reviewed = false) {
    reply = Core.plainReply(reply);
    let receipt = null, clicked = false;
    const fresh = () => {
      if (version !== epoch || !manual && !running || revision !== userRevision) return false;
      if (snapshot.isGroup) {
        const latest = current(false);
        if (!reviewed) return Core.groupSendFresh(snapshot, latest);
        const state = Core.groupDraftState(snapshot, latest);
        return state === "ready" || state === "updated";
      }
      return Core.isFresh(snapshot, current());
    };
    try {
      if (!fresh()) throw new Error("The conversation changed before insertion. Generate a new reply.");
      status("Inserting reply into Teams…");
      await insertReply(reply, value => { receipt = value; });
      if (!fresh()) throw new Error("The conversation changed after insertion. Review the unsent composer draft.");
      await request({ type: "heartbeat" });
      if (!fresh()) throw new Error("Sending was cancelled. Review the composer draft.");
      status("Sending reply through Teams…");
      await Teams.send(config, reply, fresh, () => {
        clicked = true;
        pendingDelivery = { reply, waiting: true, started: Date.now(), snapshot };
      });
      clearDraft();
      status("Send clicked. Waiting for the outgoing message…");
    } catch (error) {
      // A click can have taken effect even if its handler throws. Verify the
      // outgoing message instead of clearing its draft or risking another click.
      if (clicked) { clearDraft(); status("Send attempted. Waiting for the outgoing message…"); return; }
      if ((manual || running) && version === epoch && revision === userRevision) {
        try {
          const latest = current(false), source = Core.replySource(latest);
          if (source?.role === "other" && source.id !== Core.replySource(snapshot)?.id) {
            const valid = () => version === epoch && (manual || running) && revision === userRevision &&
              (!snapshot.isGroup || ["ready", "updated"].includes(Core.groupDraftState(snapshot, current(false)))) &&
              current(false).identity === snapshot.identity;
            let cleared = Teams.composerEmpty(config);
            if (!cleared && receipt) {
              inserting = true;
              try { cleared = await Teams.clearOwned(config, receipt, valid); }
              finally { inserting = false; }
            }
            if (cleared && valid()) {
              if (manual) {
                keepDraft(snapshot, reply);
                status("New messages arrived. Removed the unchanged bot draft; review the panel reply or generate a new one.");
                return;
              }
              clearDraft(); baseline = Core.fingerprint(latest); marks.set(latest.identity, baseline);
              due = Date.now() + config.debounceMs;
              status("New messages arrived. Removed the unchanged bot draft; preparing a fresh reply.");
              return;
            }
          }
        } catch { /* Preserve unknown or human-owned composer content. */ }
      }
      if (version === epoch) { keepDraft(snapshot, reply); showPageCheck(error); }
      throw new Error(`${manual ? "Send" : "Automatic send"} stopped: ${error.message}`);
    }
  }
  async function generate(manual = false, replyMode = selectedMode) {
    if (busy) throw new Error("A reply is already being generated.");
    if ($("draft").value.trim()) throw new Error("Insert or dismiss the existing draft before generating another reply.");
    let snapshot = current(manual && !selected?.isGroup);
    if (!manual && !snapshot.atBottom) {
      due = Date.now() + config.debounceMs;
      waitForBottom();
      return;
    }
    if (replyMode === "auto" && !snapshot.chatId && !snapshot.isGroup) throw new Error("Automatic sending requires a stable conversation identity.");
    if (Core.replySource(snapshot)?.role !== "other" && !(manual && snapshot.isGroup)) throw new Error("The latest message is yours. Waiting for the other person.");
    if (!Teams.composerEmpty(config)) throw new Error("Your composer contains a draft or attachment. It was preserved.");
    const version = epoch, revision = userRevision;
    busy = true;
    $("pause").disabled = false; $("start").disabled = true;
    inspect(snapshot);
    status(`Generating locally from ${snapshot.messages.length} loaded messages…`);
    try {
      await request({ type: "claim" });
      if (version !== epoch) return;
      const history = await Teams.recentHistory(Core.conversationConfig(config, snapshot.isGroup), () => version === epoch && revision === userRevision);
      snapshot = current(!snapshot.isGroup);
      if (Core.replySource(snapshot)?.role !== "other") throw new Error("The latest message is yours. Waiting for the other person.");
      const lastContext = history.at(-1), lastLoaded = snapshot.messages.at(-1);
      if (lastContext?.id !== lastLoaded?.id || lastContext?.text !== lastLoaded?.text ||
          (!snapshot.isGroup && !Core.isFresh(snapshot, current())) || revision !== userRevision || !Teams.composerEmpty(config)) {
        status("Conversation changed before generation. Try again when it settles."); return;
      }
      inspect({ ...snapshot, messages: history });
      status(`Generating locally from ${history.length} recent messages, including media…`);
      const response = await request({ type: "generate", identity: snapshot.identity, replyTo: snapshot.replyTo,
        isGroup: snapshot.isGroup,
        messages: history.map(({ id, text, role, author, media }) => ({ id, text: text.slice(0, Core.conversationConfig(config, snapshot.isGroup).maxContextChars), role, author, ...(media?.length ? { media } : {}) })), manual });
      const reply = Core.plainReply(response.reply);
      if (version !== epoch) return;
      const latest = current(!snapshot.isGroup);
      if (snapshot.isGroup) {
        const state = Core.groupDraftState(snapshot, latest);
        // Preserve a useful group reply in the panel when the discussion, lazy
        // media, virtualized history, scroll position, or composer changes.
        if (replyMode === "auto" && (manual || running) && Core.groupSendFresh(snapshot, latest) && revision === userRevision && Teams.composerEmpty(config)) {
          await deliver(snapshot, reply, version, revision, manual);
        } else {
          keepDraft(snapshot, reply, !manual && replyMode === "auto" && revision === userRevision);
          if (state === "conversation") {
            status("Group reply kept as a draft. Select the original group before sending.");
          } else if (state === "edited" || state === "unavailable") {
            status("Group reply kept as a draft. Its original message changed or is no longer loaded; review it and regenerate before sending.");
          } else if (revision !== userRevision || !Teams.composerEmpty(config)) {
            status("Group draft ready. Your Teams composer changed and was preserved; clear or send its text before inserting this draft.");
          } else if (replyMode === "auto" && !latest.atBottom) {
            if (manual) status("Group reply kept as a draft. Scroll to the latest messages and review it before Send reply.");
            else waitForBottom();
          } else if (replyMode === "auto" && !Core.groupSendFresh(snapshot, latest)) {
            status(!manual && Core.replySource(latest)?.id !== Core.replySource(snapshot)?.id ?
              "New messages arrived. Preparing a fresh automatic reply after the conversation settles." :
              "Group reply kept as a draft. New messages or message content changed during generation; review it before Send reply.");
          } else if (state === "updated") {
            status("Group draft ready. Loaded context changed; review the draft against the conversation before Send reply.");
          } else status("Group draft ready. Use Send reply to send it, or Insert draft to edit it in Teams.");
        }
        return;
      }
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
    try { snapshot = scope === "selected" ? current(false) : Teams.snapshot(config); }
    catch (error) { if (scope === "selected") throw error; }
    if (snapshot) {
      snapshot = withPending(snapshot);
      if (scope === "selected" && !snapshot.hasScroller) throw new Error("Cannot identify the message scroller. Update its selector in Settings.");
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
      if (resuming && Core.replySource(snapshot)?.role === "other") due = Date.now() + config.debounceMs;
    }
    $("mode").value = selectedMode; $("scope").value = scope;
    $("start").disabled = true; $("pause").disabled = false; $("mode").disabled = true; $("scope").disabled = true;
    status(`Watching ${scope === "all" ? "all unread direct chats" : snapshot?.isGroup ? "this group (50-message context)" : "this chat"} (${selectedMode === "draft" ? "draft mode" : "automatic send"}). Enabled across reloads.`);
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
    reviewedDraft(snapshot, current(!snapshot?.isGroup));
    if (!snapshot.chatId && !snapshot.isGroup) throw new Error("Automatic sending requires a stable conversation identity.");
    if (!reply) throw new Error("The draft is empty.");
    const version = epoch, revision = userRevision;
    busy = true;
    try {
      await request({ type: "claim" });
      if (version !== epoch) return;
      await deliver(snapshot, reply, version, revision, true, true);
    } finally {
      busy = false;
      if (!running && !pendingDelivery) void request({ type: "release" }).catch(() => {});
    }
  });
  act("insert", async () => {
    reviewedDraft(draftSnapshot, current(!draftSnapshot?.isGroup));
    const snapshot = draftSnapshot, reply = Core.plainReply($("draft").value), version = epoch;
    $("insert").disabled = true;
    try {
      await insertReply(reply);
      if (version !== epoch || draftSnapshot !== snapshot) return;
      if (Core.plainReply($("draft").value) === reply) clearDraft();
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
  // Only actual Teams-composer activity cancels sending. Search boxes and panel
  // controls can receive trusted input without changing the outgoing message.
  const inComposer = event => event.composedPath().some(node => node instanceof Element && node.matches(config?.selectors.composer || Core.DEFAULT_SELECTORS.composer));
  document.addEventListener("input", event => { if (event.isTrusted && !inserting && inComposer(event)) userRevision++; }, true);
  document.addEventListener("keydown", event => {
    if (event.isTrusted && inComposer(event)) userRevision++;
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
        const latest = withPending(opened);
        bind(latest); baseline = Core.fingerprint(latest); marks.set(latest.identity, baseline);
        due = Core.replySource(latest)?.role === "other" ? Date.now() + config.debounceMs : 0;
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
        try { snapshot = withPending(Teams.snapshot(config)); }
        catch {
          due = 0;
          selected = null; $("generate").disabled = true; $("preview").disabled = true; $("selected").textContent = "Waiting for an unread direct chat";
          await navigateUnread(); return;
        }
        if (snapshot.isGroup) { due = 0; await navigateUnread(); return; }
        if (!selected || snapshot.identity !== selected.identity) {
          bind(snapshot); baseline = marks.get(snapshot.identity) || Core.fingerprint(snapshot);
          due = Core.replySource(snapshot)?.role === "other" ? Date.now() + config.debounceMs : 0;
        }
        if (!Teams.composerEmpty(config)) { status("Unread chats are queued; waiting for your Teams draft to be cleared."); return; }
        if (!snapshot.atBottom) {
          await navigateUnread(); return;
        }
        if (selectedMode === "auto" && !snapshot.chatId) { status("Waiting for a direct chat with a stable conversation identity."); await navigateUnread(); return; }
      } else snapshot = current(false);
      if (pendingDelivery) {
        const delivered = snapshot.messages.find(m => m.role === "me" &&
          !pendingDelivery.snapshot.messages.some(old => old.id === m.id) && Core.normalize(m.text) === Core.normalize(pendingDelivery.reply));
        if (delivered) {
          const previous = pendingDelivery.snapshot;
          const ids = new Set(unanswered.get(snapshot.identity)?.ids || []);
          for (const message of previous.messages) ids.delete(message.id);
          const covered = new Set(previous.messages.map(m => m.id));
          const boundary = snapshot.messages.findLastIndex(m => covered.has(m.id));
          // Earlier virtualized rows being loaded are not new incoming work.
          for (const message of snapshot.messages.slice(boundary < 0 ? snapshot.messages.indexOf(delivered) + 1 : boundary + 1)) {
            if (message.role === "other" && !covered.has(message.id)) ids.add(message.id);
          }
          if (ids.size) unanswered.set(snapshot.identity, { ids, outgoingId: delivered.id });
          else unanswered.delete(snapshot.identity);
          if (unanswered.size > 500) unanswered.delete(unanswered.keys().next().value);
          snapshot = withPending(snapshot);
          pendingDelivery = null; baseline = Core.fingerprint(snapshot); marks.set(snapshot.identity, baseline);
          due = Core.replySource(snapshot)?.role === "other" ? Date.now() + config.debounceMs : 0;
          if (!running) pause("Reply appeared in the conversation.");
          else status("Reply appeared in the conversation. Watching for new messages.");
        }
        else if (Date.now() - pendingDelivery.started > 12000) pause("Delivery is uncertain. Check Teams before selecting the chat again. No retry was made.");
        return;
      }
      if (!snapshot.hasScroller) throw new Error("Cannot identify the message scroller. Update its selector in Settings.");
      if (!snapshot.atBottom) {
        waitForBottom();
        return;
      }
      if (waitingForBottom) {
        waitingForBottom = false;
        status("At the bottom again. Watching for new messages.");
      }
      if (!Teams.composerEmpty(config)) {
        status("Waiting for your Teams draft or attachment to be cleared. Monitoring remains enabled.");
        return;
      }
      if (automaticDraft && running && selectedMode === "auto") {
        const saved = automaticDraft;
        if ($("draft").value !== saved.reply || saved.revision !== userRevision) automaticDraft = null;
        else {
          if (Core.replySource(snapshot)?.id !== Core.replySource(saved.snapshot)?.id) {
            clearDraft();
            due = Core.replySource(snapshot)?.role === "other" ? Date.now() + config.debounceMs : 0;
            status("Replaced an outdated automatic draft. Watching the latest messages.");
          } else if (Core.groupSendFresh(saved.snapshot, snapshot)) {
            busy = true;
            try { await deliver(saved.snapshot, saved.reply, epoch, saved.revision, false); }
            finally { busy = false; }
            return;
          }
        }
      }
      const mark = Core.fingerprint(snapshot);
      if (mark !== baseline) {
        baseline = mark; marks.set(snapshot.identity, mark);
        due = Core.replySource(snapshot)?.role === "other" ? Date.now() + config.debounceMs : 0;
      }
      if (!due && running && monitor.scope === "all" && !$("draft").value.trim()) {
        if (await navigateUnread()) return;
      }
      if (due && Date.now() >= due && !busy && !$("draft").value.trim()) {
        due = 0;
        const probe = await request({ type: "attempted", identity: snapshot.identity, replyTo: snapshot.replyTo,
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
