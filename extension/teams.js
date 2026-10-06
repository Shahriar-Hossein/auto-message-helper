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
  function participants(header) {
    // The reported PWA places immutable participant keys inside chat-title.
    return [...header.querySelectorAll('[data-tid^="participant-"]')];
  }
  function chatTitle(header) {
    const peers = participants(header);
    if (peers.length > 1) throw new Error("More than one chat participant found. Only one-to-one chats are supported.");
    return Core.normalize(text(peers[0] || header));
  }
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
    const routeId = route.match(/19:[A-Za-z0-9_:.@+\-=]+/)?.[0];
    if (routeId) return routeId;
    const peers = participants(header);
    // In the personal-account UI, a single immutable recipient key identifies the
    // selected one-to-one conversation even when no server chat ID is in the DOM.
    return peers.length === 1 ? `direct:${peers[0].getAttribute("data-tid").slice("participant-".length)}` : "";
  }
  function messageBody(row, config) {
    const matched = all(config.selectors.body, row);
    const bodies = matched.filter(node => !matched.some(parent => parent !== node && parent.contains(node)));
    if (bodies.length > 1) throw new Error("More than one message body matched in a row. Narrow the body selector.");
    if (!bodies.length && (config.selectors.body !== Core.DEFAULT_SELECTORS.body || row.getAttribute("data-tid") !== "chat-pane-message")) return "";
    const source = bodies[0] || row;
    const clone = source.cloneNode(true);
    // This PWA has untagged text inside the message group, alongside action/reaction
    // controls. Keep the text while excluding those controls and media previews.
    const omit = 'button, [role="toolbar"], [data-tid*="reaction"], [data-tid*="attachment"], [data-tid*="file-preview"], [data-tid="message-author-name"], [data-tid="chat-pane-message-author"], time, script, style, [hidden], [aria-hidden="true"]';
    const originals = [...source.querySelectorAll("*")];
    const copies = [...clone.querySelectorAll("*")];
    for (let index = copies.length - 1; index >= 0; index--) {
      if (!visible(originals[index]) || copies[index].matches(omit)) copies[index].remove();
    }
    // innerText on detached clones is unreliable. Preserve paragraph boundaries.
    for (const node of clone.querySelectorAll("img")) {
      const alt = node.getAttribute("alt") || "";
      node.replaceWith(/\p{Extended_Pictographic}/u.test(alt) || node.closest('[data-tid*="emoji"]') ? alt : "");
    }
    for (const node of clone.querySelectorAll("br")) node.replaceWith("\n");
    for (const node of clone.querySelectorAll("p, div, blockquote, li")) node.append("\n");
    return clone.textContent.replace(/[\t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function messageMedia(row) {
    const media = [];
    const excluded = 'button, [role="toolbar"], [data-tid*="reaction"], [data-tid*="avatar"], [data-tid*="author"], [data-tid*="emoji"]';
    for (const img of all("img, video", row)) {
      if (img.closest(excluded) || /\p{Extended_Pictographic}/u.test(img.alt || "") && img.naturalWidth <= 48) continue;
      const src = img.currentSrc || img.poster || img.src || "";
      const kind = img.tagName === "VIDEO" || /gif|giphy|tenor/i.test(src + " " + (img.alt || "") + " " + (img.getAttribute("data-tid") || "")) ? "GIF" : "image";
      media.push({ kind, label: Core.normalize(img.alt || img.title || "No caption").slice(0, 500), key: src });
    }
    for (const node of all('[data-tid="attachment-card"], [data-tid="file-preview"], [data-tid="attachment"]', row)) {
      if (!node.querySelector("img")) media.push({ kind: "attachment", label: Core.normalize(text(node)).slice(0, 300), key: node.getAttribute("data-attachment-id") || text(node) });
    }
    return media.slice(0, 4);
  }
  function captureMedia(snapshot, config) {
    let count = 0, bytes = 0;
    const images = all(config.selectors.row).flatMap(row => all("img, video", row));
    return snapshot.messages.slice().reverse().map(message => ({ ...message, media: (message.media || []).map(item => {
      const clean = { kind: item.kind, label: item.label };
      if (config.vision === "off" || count >= 20) return clean;
      const img = images.find(node => (node.currentSrc || node.poster || node.src || "") === item.key);
      const width = img?.naturalWidth || img?.videoWidth, height = img?.naturalHeight || img?.videoHeight;
      if (!width || !height || img.tagName === "IMG" && !img.complete || img.tagName === "VIDEO" && img.readyState < 2) return clean;
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 384 / Math.max(width, height));
        canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL("image/jpeg", 0.7);
        if (data.length <= 200000 && bytes + data.length <= 2000000) { clean.data = data; count++; bytes += data.length; }
      } catch { /* Cross-origin previews retain their captions; no remote fetch. */ }
      return clean;
    }) })).reverse();
  }
  function messageAuthor(row, config) {
    let names = all(config.selectors.author, row);
    let item = null;
    if (!names.length) {
      item = row.closest('[data-tid="chat-pane-item"]');
      // Bind only to this message's own wrapper, never the preceding message.
      if (item && all(config.selectors.row, item).length === 1) names = all(config.selectors.author, item);
    }
    if (names.length > 1) throw new Error("More than one author matched in a message wrapper. Narrow the author selector.");
    return Core.normalize(text(names[0]) || row.getAttribute("data-author-name") ||
      (row.getAttribute("data-is-own-message") === "true" ? config.selfName : ""));
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
  function snapshot(config, limit = config.windowSize) {
    if (!config.selfName) throw new Error("Set your exact Teams display name in Settings first.");
    const header = one(config.selectors.header, "chat title");
    const title = chatTitle(header);
    if (!title) throw new Error("The chat title is empty.");
    const rows = all(config.selectors.row);
    if (!rows.length) throw new Error("No text messages found. Open a chat or update the selectors.");
    const messages = [];
    const authors = new Set();
    const seen = new Set();
    let lastTextRow;
    for (const row of rows) {
      const body = messageBody(row, config);
      const media = messageMedia(row);
      if (!body && !media.length) continue;
      const author = messageAuthor(row, config);
      if (author) authors.add(author);
      const id = row.getAttribute("data-message-id") || row.getAttribute("data-mid") || row.id;
      if (!id) throw new Error("A message has no stable ID. Narrow the row selector to the message container.");
      if (seen.has(id)) throw new Error("Duplicate message IDs detected. Narrow the row selector.");
      seen.add(id);
      messages.push({ id, text: body, role: !author ? "unknown" : author === config.selfName ? "me" : "other", author, ...(media.length ? { media } : {}) });
      lastTextRow = row;
    }
    if (!messages.length) throw new Error("No readable text messages found.");
    if (authors.size > 2) throw new Error("More than two senders found. Only one-to-one chats are supported.");
    const otherNames = [...authors].filter(name => name !== config.selfName);
    if (otherNames.length > 1 || (otherNames.length === 1 && otherNames[0] !== title)) {
      throw new Error("The chat title must exactly match the other person's message author. Group chats and ambiguous names are excluded.");
    }
    const bounded = messages.slice(-limit);
    Core.contextWindow(bounded, config); // Reject unknown senders before any inference.
    const chatId = stableId(header, config);
    const scroller = scrollerFor(lastTextRow, config);
    return {
      title, chatId, identity: JSON.stringify([location.origin, chatId || title]), messages: bounded,
      atBottom: !!scroller && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 80,
      hasScroller: !!scroller
    };
  }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function recentHistory(config, valid = () => true) {
    const initial = snapshot(config);
    const collected = captureMedia(initial, config);
    const mergeOlder = older => {
      const ids = new Set(collected.map(m => m.id));
      collected.unshift(...older.filter(m => !ids.has(m.id)));
    };
    const rows = all(config.selectors.row);
    const scroller = scrollerFor(rows.at(-1), config);
    // Fetch virtualized history in bounded steps, then return to the latest turn.
    try {
      for (let step = 0; collected.length < config.windowSize && step < 8 && scroller; step++) {
        if (!valid()) throw new Error("History loading was cancelled.");
        const previous = collected.length;
        scroller.scrollTop = 0; scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await delay(250);
        const older = snapshot(config, 20);
        if (older.identity !== initial.identity) throw new Error("The conversation changed while loading history.");
        mergeOlder(captureMedia(older, config));
        if (collected.length === previous && step >= 2) break;
      }
    } finally {
      // Never scroll a different conversation after navigation or user intervention.
      if (valid() && scroller?.isConnected && snapshot(config).identity === initial.identity) {
        scroller.scrollTop = scroller.scrollHeight; scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await delay(250);
      }
    }
    if (!valid()) throw new Error("History loading was cancelled.");
    const latest = snapshot(config);
    if (latest.identity !== initial.identity) throw new Error("The conversation changed while loading history.");
    const fresh = captureMedia(latest, config);
    const ids = new Set(fresh.map(m => m.id));
    let imageCount = 0, imageBytes = 0;
    const context = [...collected.filter(m => !ids.has(m.id)), ...fresh].slice(-config.windowSize);
    // Bound the aggregate too: virtualized pages were captured separately.
    return context.reverse().map(message => ({ ...message, media: (message.media || []).map(item => {
      if (!item.data) return item;
      if (imageCount >= 20 || imageBytes + item.data.length > 2000000) return { kind: item.kind, label: item.label };
      imageCount++; imageBytes += item.data.length; return item;
    }) })).reverse();
  }
  function unreadChats(config) {
    const matches = all(config.selectors.chatItem);
    // Wrappers and their inner row may both match: use the inner target only.
    const items = matches.filter(node => !matches.some(other => other !== node && node.contains(other)));
    return items.filter(node => node.matches(config.selectors.unread) || all(config.selectors.unread, node).length).map(node => {
      const nameNode = node.querySelector('[data-tid="chat-list-item-title"], [data-tid="chat-name"], [data-tid="chatListItem-title"], [data-tid="chat-title"]');
      const title = Core.normalize(text(nameNode) || node.getAttribute("data-chat-name") || node.getAttribute("title") ||
        node.getAttribute("aria-label")?.replace(/\b(unread|chat|messages?)\b[: ,]*/gi, ""));
      const id = node.getAttribute("data-chat-id") || node.getAttribute("data-conversation-id") || node.getAttribute("data-thread-id") || "";
      return { node, title, id, key: id || node.id || title };
    }).filter(item => item.title && item.key);
  }
  async function openUnread(config, target, valid = () => true) {
    if (!target.node.isConnected || !valid()) throw new Error("The unread chat changed before opening.");
    if (all(config.selectors.composer).length && !composerEmpty(config)) throw new Error("Your composer contains a draft or attachment. It was preserved.");
    target.node.click();
    let last = "", settled = 0;
    for (let attempt = 0; attempt < 24 && valid(); attempt++) {
      await delay(250);
      try {
        const result = snapshot(config);
        if (result.title !== target.title || target.id && result.chatId !== target.id) continue;
        const mark = Core.fingerprint(result);
        settled = mark === last ? settled + 1 : 0; last = mark;
        if (settled < 2) continue;
        const scroller = scrollerFor(all(config.selectors.row).at(-1), config);
        if (scroller) { scroller.scrollTop = scroller.scrollHeight; scroller.dispatchEvent(new Event("scroll", { bubbles: true })); }
        await delay(250);
        const ready = snapshot(config);
        if (ready.identity === result.identity && ready.title === target.title && ready.atBottom) return ready;
      } catch { /* Teams can temporarily remove the title/composer during navigation. */ }
    }
    throw new Error("Could not confirm the unread conversation. Check Teams selectors or chat loading.");
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
    if (!Core.normalize(reply)) throw new Error("The draft is empty. Generate or enter a reply first.");
    editor.focus();
    // Focus from the panel can leave the selection in its shadow DOM, or leave
    // Teams with no caret at all. Bind the editing command to this composer.
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    // Let rich-text editors import plain text through their own paste pipeline
    // so it reaches their document model, rather than only changing the DOM.
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", reply);
    const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: clipboard });
    editor.dispatchEvent(paste);
    if (paste.defaultPrevented || Core.normalize(text(editor))) return verifyInsertion(config, editor, reply);
    // Teams' rich-text editor needs a real editing command to update its model and undo history.
    let inputFired = false;
    const observeInput = () => { inputFired = true; };
    editor.addEventListener("input", observeInput);
    try { document.execCommand("insertText", false, reply); }
    finally { editor.removeEventListener("input", observeInput); }
    if (Core.normalize(text(editor)) !== Core.normalize(reply)) throw new Error("Teams rejected text insertion or changed the inserted text. Inspect the composer; copy your draft from the panel if needed.");
    if (!inputFired) editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: reply }));
    return verifyInsertion(config, editor, reply);
  }
  async function verifyInsertion(config, editor, reply) {
    // Teams may re-render after processing an edit. Do not clear the reviewable
    // panel draft or click Send based on a transient DOM change.
    await new Promise(resolve => setTimeout(resolve, 350));
    if (!editor.isConnected || composer(config) !== editor || Core.normalize(text(editor)) !== Core.normalize(reply)) {
      throw new Error("The composer changed after insertion. Inspect Teams before sending; copy your draft from the panel if needed.");
    }
    return editor;
  }
  async function send(config, reply, valid = () => true) {
    // Send may become enabled after the editor's state catches up with its DOM.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!valid() || Core.normalize(text(composer(config))) !== Core.normalize(reply)) throw new Error("The composer or conversation changed; sending was stopped.");
      const matches = all(config.selectors.send).map(match => match.matches('button, [role="button"]') ? match :
        match.closest('button, [role="button"]') || match.querySelector('button, [role="button"]')).filter(Boolean);
      const buttons = [...new Set(matches)];
      if (buttons.length > 1) throw new Error("More than one Send button matched. Update the Send selector.");
      const button = buttons[0];
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") { button.click(); return; }
      await delay(100);
    }
    throw new Error("Teams Send did not become available. Review the composer and check the Send selector.");
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
    const safeTid = value => value.startsWith("participant-") ? "participant-<redacted>" : value;
    const counts = new Map();
    for (const node of document.querySelectorAll("[data-tid]")) {
      const tid = node.getAttribute("data-tid");
      if (visible(node) && /chat|message|compos|editor|send|author|topic|title|viewport/i.test(tid)) {
        const safe = safeTid(tid);
        counts.set(safe, (counts.get(safe) || 0) + 1);
      }
    }
    report.push("", "Available visible data-tid values:", ...[...counts].slice(0, 80).map(([tid, count]) => `${tid}: ${count}`));
    function metadata(node) {
      const attrs = ["data-tid", "role", "contenteditable", "data-is-own-message"].map(key => {
        const value = node.getAttribute(key);
        return value === null ? "" : `${key}=${JSON.stringify((key === "data-tid" ? safeTid(value) : value).slice(0, 100))}`;
      }).filter(Boolean);
      return `${node.tagName.toLowerCase()} ${attrs.join(" ")}`.trim();
    }
    const editors = [...document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]')].filter(visible);
    report.push("", "Visible editor candidates:", ...editors.slice(0, 10).map(metadata));
    const headings = [...document.querySelectorAll('h1, h2, [role="heading"], [data-tid*="header"], [data-tid*="title"]')].filter(visible);
    report.push("", "Visible title/header candidates:", ...headings.slice(0, 25).map(node => {
      const descendants = [...node.querySelectorAll("[data-tid], [role]")].filter(visible).slice(0, 6);
      return [metadata(node), ...descendants.map(child => `  ${metadata(child)}`)].join("\n");
    }));
    try {
      const rows = all(config.selectors.row);
      report.push("", `Message containers: ${rows.length}`);
      for (const row of rows.slice(-3)) {
        const nodes = [row, ...row.querySelectorAll('[data-tid], [role], [contenteditable]')];
        report.push("Row structure:", ...nodes.slice(0, 25).map(metadata));
        report.push(`Stable message ID present: ${!!(row.getAttribute("data-message-id") || row.getAttribute("data-mid") || row.id)}`);
        report.push(`Author matches: ${all(config.selectors.author, row).length}`);
        const item = row.closest('[data-tid="chat-pane-item"]');
        report.push(`Author matches in own chat-pane-item: ${item ? all(config.selectors.author, item).length : 0}`);
        report.push(`Readable message text: ${!!messageBody(row, config)}`);
      }
      const headers = all(config.selectors.header);
      if (headers.length === 1) report.push(`Header participants: ${participants(headers[0]).length}`, `Stable conversation identity available: ${!!stableId(headers[0], config)}`);
    } catch (error) { report.push(`Row inspection failed: ${error.message}`); }
    return report.join("\n");
  }
  root.TeamsReplyAdapter = { snapshot, recentHistory, captureMedia, unreadChats, openUnread, composerEmpty, insert, send, diagnostics };
})(globalThis);
