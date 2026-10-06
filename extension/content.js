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
    <header><strong>Local Replies</strong><button id="collapse" aria-label="Collapse panel">−</button></header>
    <div id="controls">
      <p id="selected">No chat selected</p><p id="status" role="status">Paused. Open Settings to configure your model and name.</p>
      <div class="row"><button id="settings">Settings</button><button class="primary" id="select">Select this chat</button><button id="diagnose">Check Teams page</button></div>
      <label>Reply mode <select id="mode"><option value="draft">Draft</option><option value="auto">Automatic send</option></select></label>
      <div class="row"><button class="primary" id="start" disabled>Start</button><button class="pause" id="pause" disabled>Pause</button><button id="generate" disabled>Generate now</button></div>
      <textarea id="draft" aria-label="Generated reply" placeholder="Your generated reply appears here. You can edit it before inserting."></textarea>
      <div class="row"><button id="insert" disabled>Insert draft</button><button id="dismiss">Dismiss</button></div>
      <details id="inspection"><summary>Inspect loaded context / page check</summary><div class="row"><button id="inspect">Refresh context</button><button id="copy-report" hidden>Copy page check</button></div><pre id="context">Select a chat to inspect its recent messages.</pre></details>
      <small>Keep the selected chat open at the bottom. Start establishes a baseline; only new incoming messages trigger replies.</small>
    </div>
  </section>`;
  document.body.append(host);
  const $ = id => shadow.getElementById(id);
  const status = message => { $("status").textContent = message; };
  let pageReport = "";
  let config, selected = null, running = false, busy = false, epoch = 0, baseline = "", due = 0;
  let draftSnapshot = null, pendingDelivery = null, userRevision = 0, selectedMode = "draft";
  let inserting = false;
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
  function pause(message = "Paused.") {
    running = false; epoch++; due = 0;
    $("start").disabled = !selected; $("pause").disabled = true; $("mode").disabled = false;
    status(message);
    void request({ type: "release" }).catch(() => {});
  }
  function clearDraft() {
    $("draft").value = ""; draftSnapshot = null; $("insert").disabled = true;
  }
  function insertReply(reply) {
    inserting = true;
    try { Teams.insert(config, reply); }
    finally { inserting = false; }
  }
  function current() {
    if (!selected) throw new Error("Open a one-to-one chat and click Select this chat first.");
    const result = Teams.snapshot(config);
    if (result.identity !== selected.identity || result.title !== selected.title) throw new Error("The selected conversation changed. Select it again before starting.");
    if (!result.atBottom) throw new Error(result.hasScroller ? "Scroll to the bottom of the chat before continuing." : "Cannot identify the message scroller. Update its selector in Settings.");
    return result;
  }
  function inspect(snapshot) {
    $("copy-report").hidden = true;
    $("context").textContent = `${snapshot.title}\nConversation key: ${snapshot.chatId || "not available (automatic sending disabled)"}\n\n` +
      snapshot.messages.map(m => `${m.role === "me" ? "Me" : m.author}: ${m.text}`).join("\n\n");
  }
  function showPageCheck(error) {
    pageReport = (error ? `Selection failed: ${error.message}\n\n` : "") + Teams.diagnostics(config);
    $("context").textContent = pageReport;
    $("inspection").open = true; $("copy-report").hidden = false;
  }
  async function generate(manual = false) {
    if (busy) throw new Error("A reply is already being generated.");
    if ($("draft").value.trim()) throw new Error("Insert or dismiss the existing draft before generating another reply.");
    const snapshot = current();
    if (snapshot.messages.at(-1).role !== "other") throw new Error("The latest text message is yours. Waiting for the other person.");
    if (!Teams.composerEmpty(config)) throw new Error("Your composer contains a draft or attachment. It was preserved.");
    const version = epoch, revision = userRevision;
    busy = true;
    $("pause").disabled = false; $("start").disabled = true;
    status("Generating locally…");
    try {
      await request({ type: "claim" });
      if (version !== epoch) return;
      if (!Core.isFresh(snapshot, current()) || revision !== userRevision || !Teams.composerEmpty(config)) {
        status("Conversation changed before generation. Try again when it settles."); return;
      }
      const { reply } = await request({ type: "generate", identity: snapshot.identity,
        messages: snapshot.messages.map(({ id, text, role }) => ({ id, text: text.slice(0, config.maxContextChars), role })), manual });
      if (version !== epoch) return;
      const latest = current();
      if (!Core.isFresh(snapshot, latest) || revision !== userRevision || !Teams.composerEmpty(config)) {
        status("Discarded the reply because the conversation or composer changed."); return;
      }
      if (!manual && running && selectedMode === "auto") {
        // Revalidate after Teams has processed editor changes and enabled its Send button.
        insertReply(reply);
        await new Promise(resolve => setTimeout(resolve, 350));
        if (version !== epoch || !running || revision !== userRevision || !Core.isFresh(snapshot, current())) {
          throw new Error("The conversation changed after insertion. Review the unsent composer draft.");
        }
        await request({ type: "heartbeat" });
        if (version !== epoch || !running || revision !== userRevision || !Core.isFresh(snapshot, current())) {
          throw new Error("Sending was cancelled. Review the composer draft.");
        }
        Teams.send(config, reply);
        pendingDelivery = { reply, started: Date.now(), snapshot };
        status("Send clicked. Waiting for the outgoing message…");
      } else {
        $("draft").value = reply; draftSnapshot = snapshot; $("insert").disabled = false;
        status(manual ? "Draft ready. Review it, then insert it into Teams." : "Draft ready. Monitoring waits until you insert or dismiss it.");
      }
    } finally {
      busy = false;
      if (!running) {
        $("pause").disabled = true; $("start").disabled = !selected;
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
  act("settings", () => request({ type: "settings" }));
  act("select", async () => {
    selected = null; $("selected").textContent = "No chat selected"; $("generate").disabled = true;
    pause(); clearDraft(); pendingDelivery = null;
    await loadConfig();
    selected = Teams.snapshot(config);
    $("start").disabled = false; $("generate").disabled = false;
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
  act("start", async () => {
    if (busy) throw new Error("Wait for the current generation to finish.");
    const version = epoch;
    const snapshot = current();
    selectedMode = $("mode").value;
    if (selectedMode === "auto" && !snapshot.chatId) throw new Error("Automatic sending requires a stable conversation identity (chat ID or one-to-one participant ID). Draft mode is available.");
    if (pendingDelivery) throw new Error("Previous delivery is uncertain. Check the conversation, then select the chat again.");
    if (!Teams.composerEmpty(config)) throw new Error("Clear or send your existing Teams draft before starting.");
    await request({ type: "claim" });
    if (version !== epoch) { void request({ type: "release" }).catch(() => {}); return; }
    if (Core.fingerprint(snapshot) !== Core.fingerprint(current())) {
      throw new Error("The conversation changed while starting. Press Start again.");
    }
    running = true; epoch++; baseline = Core.fingerprint(snapshot); due = 0;
    $("start").disabled = true; $("pause").disabled = false; $("mode").disabled = true;
    status(`Watching for new messages (${selectedMode === "auto" ? "automatic send" : "draft mode"}).`);
  });
  act("pause", () => pause());
  act("generate", () => generate(true));
  act("insert", () => {
    if (!draftSnapshot || !Core.isFresh(draftSnapshot, current())) throw new Error("This draft is stale. Dismiss it and generate a new one.");
    insertReply($("draft").value.trim()); clearDraft();
    status("Inserted into Teams. Review it and press Teams Send.");
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
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") {
      selected = null; $("generate").disabled = true;
      pause("Settings changed. Select the chat again."); clearDraft(); $("selected").textContent = "No chat selected";
    }
  });
  let ticking = false;
  setInterval(async () => {
    if ((!running && !busy) || ticking) return;
    ticking = true;
    try {
      await request({ type: "heartbeat" });
      if (!running) return;
      const snapshot = current();
      if (pendingDelivery) {
        const delivered = snapshot.messages.some(m => m.role === "me" &&
          !pendingDelivery.snapshot.messages.some(old => old.id === m.id) && Core.normalize(m.text) === Core.normalize(pendingDelivery.reply));
        if (delivered) {
          pendingDelivery = null; baseline = Core.fingerprint(snapshot);
          due = snapshot.messages.at(-1).role === "other" ? Date.now() + config.debounceMs : 0;
          status("Reply appeared in the conversation. Watching for new messages.");
        }
        else if (Date.now() - pendingDelivery.started > 12000) pause("Delivery is uncertain. Check Teams before selecting the chat again. No retry was made.");
        return;
      }
      const mark = Core.fingerprint(snapshot);
      if (mark !== baseline) {
        baseline = mark;
        due = snapshot.messages.at(-1).role === "other" ? Date.now() + config.debounceMs : 0;
      }
      if (due && Date.now() >= due && !busy && !$("draft").value.trim()) {
        due = 0;
        await generate();
      }
    } catch (error) { pause(error.message); }
    finally { ticking = false; }
  }, 1000);
  window.addEventListener("pagehide", () => pause());
  try { await loadConfig(); } catch (error) { status(error.message); }
})();
