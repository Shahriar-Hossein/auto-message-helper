(function (root) {
  "use strict";
  const Core = TeamsReplyCore;
  const visible = element => !!element && !element.closest('[hidden], [aria-hidden="true"]') && element.getClientRects().length > 0;
  function all(selector, scope = document) {
    return [...scope.querySelectorAll(selector)].filter(visible);
  }
  function one(selector, label, scope = document) {
    const elements = all(selector, scope);
    if (elements.length !== 1) throw new Error(`Expected one ${label}; found ${elements.length}. Update selectors in Settings.`);
    return elements[0];
  }
  const text = element => (element?.innerText ?? element?.textContent ?? "").trim();
  function stableId(header, config) {
    // Never mistake a display name or generic /v2/ URL for a chat ID.
    const candidates = all(config.selectors.identity);
    for (let node = header; node && node !== document.body; node = node.parentElement) candidates.push(node);
    const ids = new Set();
    for (const node of candidates) {
      for (const attr of ["data-chat-id", "data-conversation-id", "data-thread-id"]) {
        const value = node.getAttribute(attr);
        if (value) ids.add(value);
      }
    }
    if (ids.size === 1) return [...ids][0];
    if (ids.size > 1) throw new Error("Ambiguous conversation IDs. Pause and check the identity selector.");
    let route;
    try { route = decodeURIComponent(location.href); } catch { route = location.href; }
    return route.match(/19:[A-Za-z0-9_:.@+\-=]+/)?.[0] ?? "";
  }
  function scrollerFor(lastRow, config) {
    const matches = all(config.selectors.scroller);
    const containing = matches.filter(node => node.contains(lastRow));
    if (containing.length) return containing.at(-1);
    for (let node = lastRow?.parentElement; node && node !== document.body; node = node.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.clientHeight > 0) return node;
    }
    return null;
  }
  function snapshot(config) {
    if (!config.selfName) throw new Error("Set your exact Teams display name in Settings first.");
    const header = one(config.selectors.header, "chat title");
    const title = Core.normalize(text(header));
    if (!title) throw new Error("The chat title is empty.");
    const rows = all(config.selectors.row);
    if (!rows.length) throw new Error("No text messages found. Open a chat or update the selectors.");
    const messages = [];
    const authors = new Set();
    const seen = new Set();
    let lastTextRow;
    for (const row of rows) {
      const bodies = all(config.selectors.body, row);
      if (bodies.length > 1) throw new Error("More than one message body matched in a row. Narrow the body selector.");
      if (!bodies.length || !text(bodies[0])) continue;
      const names = all(config.selectors.author, row);
      if (names.length > 1) throw new Error("More than one author matched in a row. Narrow the author selector.");
      // Missing authors are ambiguous, even beside a known author. Never infer them from row order.
      const author = Core.normalize(text(names[0]) || row.getAttribute("data-author-name") ||
        (row.getAttribute("data-is-own-message") === "true" ? config.selfName : ""));
      if (author) authors.add(author);
      const id = row.getAttribute("data-message-id") || row.getAttribute("data-mid") || row.id;
      if (!id) throw new Error("A message has no stable ID. Narrow the row selector to the message container.");
      if (seen.has(id)) throw new Error("Duplicate message IDs detected. Narrow the row selector.");
      seen.add(id);
      const body = text(bodies[0]);
      messages.push({ id, text: body, role: !author ? "unknown" : author === config.selfName ? "me" : "other", author });
      lastTextRow = row;
    }
    if (!messages.length) throw new Error("No readable text messages found.");
    if (authors.size > 2) throw new Error("More than two senders found. Only one-to-one chats are supported.");
    const otherNames = [...authors].filter(name => name !== config.selfName);
    if (otherNames.length > 1 || (otherNames.length === 1 && otherNames[0] !== title)) {
      throw new Error("The chat title must exactly match the other person's message author. Group chats and ambiguous names are excluded.");
    }
    const bounded = messages.slice(-config.windowSize);
    Core.contextWindow(bounded, config); // Reject unknown senders before any inference.
    const chatId = stableId(header, config);
    const scroller = scrollerFor(lastTextRow, config);
    return {
      title, chatId, identity: JSON.stringify([location.origin, chatId || title]), messages: bounded,
      atBottom: !!scroller && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 80,
      hasScroller: !!scroller
    };
  }
  function composer(config) { return one(config.selectors.composer, "message composer"); }
  function composerEmpty(config) {
    const editor = composer(config);
    return !Core.normalize(text(editor)) && !editor.querySelector('img, [data-attachment-id], [contenteditable="false"]') &&
      !document.querySelector('[data-tid="attachment-card"], [data-tid="compose-attachment"]');
  }
  function insert(config, reply) {
    const editor = composer(config);
    if (!composerEmpty(config)) throw new Error("Your composer already contains a draft or attachment. It was preserved.");
    editor.focus();
    // Teams' rich-text editor needs a real editing command to update its model and undo history.
    if (!document.execCommand("insertText", false, reply)) throw new Error("Teams rejected text insertion. Copy the draft from the panel.");
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: reply }));
    if (Core.normalize(text(editor)) !== Core.normalize(reply)) throw new Error("Composer verification failed. Inspect it before sending.");
    return editor;
  }
  function send(config, reply) {
    if (Core.normalize(text(composer(config))) !== Core.normalize(reply)) throw new Error("The composer changed; sending was stopped.");
    const button = one(config.selectors.send, "Send button");
    if (button.disabled || button.getAttribute("aria-disabled") === "true") throw new Error("Teams Send is disabled. Review the composer.");
    button.click();
  }
  function diagnostics(config) {
    // Report DOM metadata, never message text, chat names, IDs, or model settings.
    const report = ["Teams page check", `Display name configured: ${!!config.selfName}`, "", "Selector matches (visible / total):"];
    for (const [key, selector] of Object.entries(config.selectors)) {
      try {
        const nodes = [...document.querySelectorAll(selector)];
        report.push(`${key}: ${nodes.filter(visible).length} / ${nodes.length}`);
      } catch (error) { report.push(`${key}: invalid CSS selector (${error.message})`); }
    }
    const counts = new Map();
    for (const node of document.querySelectorAll("[data-tid]")) {
      const tid = node.getAttribute("data-tid");
      if (visible(node) && /chat|message|compos|editor|send|author|topic|title|viewport/i.test(tid)) {
        counts.set(tid, (counts.get(tid) || 0) + 1);
      }
    }
    report.push("", "Available visible data-tid values:", ...[...counts].slice(0, 80).map(([tid, count]) => `${tid}: ${count}`));
    function metadata(node) {
      const attrs = ["data-tid", "role", "contenteditable", "data-is-own-message"].map(key => {
        const value = node.getAttribute(key);
        return value === null ? "" : `${key}=${JSON.stringify(value.slice(0, 100))}`;
      }).filter(Boolean);
      return `${node.tagName.toLowerCase()} ${attrs.join(" ")}`.trim();
    }
    const editors = [...document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]')].filter(visible);
    report.push("", "Visible editor candidates:", ...editors.slice(0, 10).map(metadata));
    try {
      const rows = all(config.selectors.row);
      report.push("", `Message containers: ${rows.length}`);
      for (const row of rows.slice(-3)) {
        const nodes = [row, ...row.querySelectorAll('[data-tid], [role], [contenteditable]')];
        report.push("Row structure:", ...nodes.slice(0, 25).map(metadata));
        report.push(`Stable message ID present: ${!!(row.getAttribute("data-message-id") || row.getAttribute("data-mid") || row.id)}`);
        report.push(`Author matches: ${all(config.selectors.author, row).length}`);
      }
    } catch (error) { report.push(`Row inspection failed: ${error.message}`); }
    return report.join("\n");
  }
  root.TeamsReplyAdapter = { snapshot, composerEmpty, insert, send, diagnostics };
})(globalThis);
