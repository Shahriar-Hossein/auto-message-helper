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
  function unsupportedChat(message) {
    const error = new Error(message);
    error.code = "UNSUPPORTED_CHAT";
    return error;
  }
  function participants(header) {
    // The reported PWA places immutable participant keys inside chat-title.
    return [...header.querySelectorAll('[data-tid^="participant-"]')];
  }
  function chatTitle(header) {
    const peers = participants(header);
    return Core.normalize(text(peers.length === 1 ? peers[0] : header));
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
  function snapshot(config, limit) {
    if (!config.selfName) throw new Error("Set your exact Teams display name in Settings first.");
    const header = one(config.selectors.header, "chat title");
    const title = chatTitle(header);
    if (!title) throw new Error("The chat title is empty.");
    if (header.closest('[data-chat-type="channel"], [data-conversation-type="channel"]') || /@thread\.tacv2/i.test(location.href)) {
      throw unsupportedChat("Teams channels are not supported. Open a direct or group chat.");
    }
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
    const otherNames = [...authors].filter(name => name !== config.selfName);
    const isGroup = config.isGroup === true || participants(header).length > 1 || otherNames.length > 1 ||
      !!header.closest('[data-chat-type="group"], [data-conversation-type="group"]') ||
      otherNames.length === 1 && otherNames[0] !== title;
    const chatConfig = Core.conversationConfig(config, isGroup);
    const bounded = messages.slice(-(limit ?? chatConfig.windowSize));
    Core.contextWindow(bounded, chatConfig); // Reject unknown senders before any inference.
    const chatId = stableId(header, config);
    const scroller = scrollerFor(lastTextRow, config);
    return {
      title, chatId, isGroup, identity: JSON.stringify([location.origin, chatId || title]), messages: bounded,
      atBottom: !!scroller && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 80,
      hasScroller: !!scroller
    };
  }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function latestViewport(config, scroller, identity, valid) {
    let previous = "", settled = 0, latest;
    for (let step = 0; step < 8 && valid(); step++) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await delay(150);
      if (!valid()) throw new Error("History loading was cancelled.");
      latest = snapshot(config);
      if (latest.identity !== identity) throw new Error("The conversation changed while loading history.");
      const last = latest.messages.at(-1);
      const mark = JSON.stringify([last.id, last.role, last.author, last.text]);
      settled = latest.atBottom && mark === previous ? settled + 1 : 0;
      previous = mark;
      if (settled >= 1) return latest;
    }
    if (!valid()) throw new Error("History loading was cancelled.");
    if (latest?.atBottom) return latest;
    throw new Error("Teams is still loading the latest messages. Try again when it finishes.");
  }
  async function recentHistory(config, valid = () => true) {
    let initial = snapshot(config);
    config = Core.conversationConfig(config, initial.isGroup);
    const rows = all(config.selectors.row);
    const scroller = scrollerFor(rows.at(-1), config);
    if (scroller && !initial.atBottom) initial = await latestViewport(config, scroller, initial.identity, valid);
    const collected = captureMedia(initial, config);
    const mergeOlder = older => {
      const ids = new Set(collected.map(m => m.id));
      collected.unshift(...older.filter(m => !ids.has(m.id)));
    };
    // Fetch virtualized history in bounded steps, then return to the latest turn.
    try {
      for (let step = 0; collected.length < config.windowSize && step < 8 && scroller; step++) {
        if (!valid()) throw new Error("History loading was cancelled.");
        const previous = collected.length;
        scroller.scrollTop = 0; scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await delay(250);
        const older = snapshot(config, config.windowSize);
        if (older.identity !== initial.identity) throw new Error("The conversation changed while loading history.");
        mergeOlder(captureMedia(older, config));
        if (collected.length === previous && step >= 2) break;
      }
    } finally {
      // Never scroll a different conversation after navigation or user intervention.
      if (valid() && scroller?.isConnected && snapshot(config).identity === initial.identity) {
        await latestViewport(config, scroller, initial.identity, valid);
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
  const CHAT_NAME = '[data-tid="chat-list-item-title"], [data-tid="chat-list-item-name"], [data-tid="chat-name"], [data-tid="chatListItem-title"], [data-tid="chat-item-title"], [data-tid="chat-title"], [role="heading"]';
  const IN_CONVERSATION = '[data-tid="entity-header"], [data-tid="chat-title"], [data-tid="chat-topic-menu"], [data-tid="message-pane-layout"], [data-tid="chat-pane-item"], [data-tid="ckeditor"]';
  function unreadFilter() {
    const buttons = all('button, [role="button"]');
    const matches = buttons.filter(node => !node.closest(IN_CONVERSATION) && (Core.normalize(text(node)).toLowerCase() === "unread" || /^(unread|filter unread (chats|messages))$/i.test(Core.normalize(node.getAttribute("aria-label")))));
    return matches.length === 1 ? matches[0] : null;
  }
  function filterActive() {
    const filter = unreadFilter();
    return !!filter && (filter.getAttribute("aria-pressed") === "true" || filter.getAttribute("aria-selected") === "true" || filter.getAttribute("data-state") === "on");
  }
  async function enableUnreadFilter(valid) {
    const filter = unreadFilter();
    if (filter && !filterActive() && valid()) {
      filter.click(); await delay(600);
    }
  }
  const AVATAR = 'img, [role="img"]:not(svg), [data-tid*="avatar"], [class*="avatar" i]';
  function sidebarSection(node) {
    if (node.matches('[role="group"], [role="tree"], [role="list"], [role="tab"]')) return true;
    // A real chat row may also expose expansion state; keep rows that carry
    // explicit conversation metadata rather than treating them as sections.
    return node.hasAttribute("aria-expanded") && !node.matches('[data-chat-id], [data-conversation-id], [data-thread-id], [data-tid="chat-list-item"], [data-tid="chat-list-item-wrapper"], [data-tid="chatListItem"], [data-tid="chat-item"]');
  }
  function nameElement(node) {
    const known = node.querySelector(CHAT_NAME);
    if (known) return known;
    if (node.hasAttribute("data-chat-name") || node.hasAttribute("data-display-name")) return node;
    // Some PWA rows expose plain spans rather than heading roles. Prefer a leaf
    // label and exclude avatars, timestamps, unread counters, and menu controls.
    return all('span, div, p, strong, b', node).find(child => {
      const value = Core.normalize(text(child));
      return !child.children.length && !child.closest(AVATAR) && !child.matches('[aria-label*="unread" i]') &&
        value.length >= 2 && value.length <= 200 && !/^[A-Z]{1,3}$/.test(value) &&
        !/^\d+([:/., -]\d+)*(\s*[AP]M)?$|^(unread|more options)$/i.test(value);
    }) || (node.getAttribute("aria-label") && node.matches('[role="treeitem"], [role="listitem"], [role="option"]') ? node : null);
  }
  function rowTitle(node, name) {
    const value = node.getAttribute("data-chat-name") || node.getAttribute("data-display-name") ||
      name?.getAttribute("title") || name?.getAttribute("aria-label") || text(name);
    const normalized = Core.normalize(value);
    return name === node && node.hasAttribute("aria-label") && !node.hasAttribute("data-chat-name") && !node.hasAttribute("data-display-name")
      ? normalized.replace(/^(chat (with|:)|unread (chat|messages? from):?)\s*/i, "").split(/[,\n]/)[0].replace(/\s+unread$/i, "").trim()
      : normalized;
  }
  function sidebarRow(node, config) {
    for (let candidate = node; candidate && candidate !== document.body; candidate = candidate.parentElement) {
      if (candidate.closest(IN_CONVERSATION) || candidate.querySelector(config.selectors.row)) return null;
      // Favorites/Chats tree sections remain visible with Unread enabled, but
      // expanding a section does not open a conversation.
      if (sidebarSection(candidate)) return null;
      const names = all(CHAT_NAME, candidate);
      // Do not turn a whole list, a filter, or the app navigation badge into a chat.
      if (names.length > 1) return null;
      const name = nameElement(candidate);
      if (!name || !rowTitle(candidate, name)) continue;
      if (candidate.matches(config.selectors.chatItem)) return candidate;
      const avatar = candidate.querySelector(AVATAR);
      if (avatar && (candidate.matches('button, a[href], [role="button"], [tabindex]') || getComputedStyle(candidate).cursor === "pointer")) return candidate;
    }
    return null;
  }
  function sidebarRows(config) {
    const rows = new Set(all(config.selectors.chatItem).filter(node => !sidebarSection(node) && !node.closest(IN_CONVERSATION) && !node.querySelector(config.selectors.row) && all(CHAT_NAME, node).length <= 1 && all(config.selectors.chatItem, node).length <= 1 && nameElement(node)));
    // The personal Teams PWA has heading-based sidebar entries without chat data-tid
    // values or data-chat-id. Resolve the heading and unread marker to their own row.
    for (const marker of [...all('[role="heading"]'), ...all(config.selectors.unread)]) {
      const row = sidebarRow(marker, config); if (row) rows.add(row);
    }
    return [...rows].filter(node => ![...rows].some(parent => parent !== node && parent.contains(node)))
      .sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  }
  function explicitUnread(node, config) {
    const markers = [node, ...all(config.selectors.unread, node)].filter(item => item.matches(config.selectors.unread));
    return markers.some(item => {
      if (item.getAttribute("data-is-unread") === "false" || item.getAttribute("data-unread") === "false" || item.getAttribute("data-unread-count") === "0") return false;
      return !/\b(no|0) unread\b|mark (as )?unread/i.test(item.getAttribute("aria-label") || "");
    });
  }
  function sidebarScroller(row) {
    for (let node = row?.parentElement; node && node !== document.body; node = node.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.clientHeight > 0) return node;
    }
    return null;
  }
  function inbox(config) {
    const rows = sidebarRows(config), filtered = filterActive();
    const weights = rows.map(node => Number(getComputedStyle(nameElement(node)).fontWeight) || 400);
    const baseWeight = Math.min(...weights, 700);
    const entries = rows.map((node, index) => {
      const name = nameElement(node);
      const title = rowTitle(node, name);
      const id = node.getAttribute("data-chat-id") || node.getAttribute("data-conversation-id") || node.getAttribute("data-thread-id") || "";
      const peer = node.querySelector('[data-tid^="participant-"]')?.getAttribute("data-tid").slice("participant-".length) || "";
      const key = id || (peer ? `direct:${peer}` : title);
      const unread = filtered || explicitUnread(node, config) || weights[index] >= 600 && weights[index] > baseWeight;
      const viewport = sidebarScroller(node);
      return { node, title, id, peer, key, unread, viewport, offset: viewport?.scrollTop || 0,
        signature: JSON.stringify([title, Core.normalize(text(node)), node.getAttribute("data-unread-count") || ""]) };
    }).filter(item => item.title && item.key && item.title !== config.selfName && !/\(you\)$/i.test(item.title));
    // A name alone is insufficient when two rows use it; a stable row/peer ID can distinguish them.
    for (const entry of entries) entry.ambiguous = entries.filter(other => other.title === entry.title).length > 1;
    return { entries, rowCount: rows.length, filtered, filterAvailable: !!unreadFilter() };
  }
  function unreadChats(config) { return inbox(config).entries.filter(item => item.unread); }
  const scanOffsets = new WeakMap();
  async function scanUnread(config, valid = () => true) {
    await enableUnreadFilter(valid);
    let state = inbox(config);
    const found = new Map();
    const collect = () => { for (const item of state.entries.filter(item => item.unread)) found.set(item.key, item); };
    collect();
    const viewport = state.entries.map(item => item.viewport).find(Boolean);
    if (!viewport || viewport.scrollHeight <= viewport.clientHeight || !valid()) return { ...state, unread: [...found.values()] };
    const originalTop = viewport.scrollTop;
    try {
      viewport.scrollTop = scanOffsets.get(viewport) || 0;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true })); await delay(150);
      for (let page = 0; page < 12 && valid(); page++) {
        state = inbox(config); collect();
        const end = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        if (viewport.scrollTop >= end - 2) { scanOffsets.set(viewport, 0); break; }
        const next = Math.min(end, viewport.scrollTop + Math.max(80, viewport.clientHeight * 0.8));
        viewport.scrollTop = next; scanOffsets.set(viewport, next);
        viewport.dispatchEvent(new Event("scroll", { bubbles: true })); await delay(150);
      }
      state = inbox(config); collect();
    } finally {
      if (valid() && viewport.isConnected) {
        viewport.scrollTop = originalTop; viewport.dispatchEvent(new Event("scroll", { bubbles: true })); await delay(150);
      }
    }
    return { ...state, unread: [...found.values()] };
  }
  async function openUnread(config, target, valid = () => true) {
    if (!valid()) throw new Error("The unread chat changed before opening.");
    // Teams recycles sidebar DOM nodes; rediscover the queued recipient by its key.
    if (target.viewport?.isConnected) {
      target.viewport.scrollTop = target.offset;
      target.viewport.dispatchEvent(new Event("scroll", { bubbles: true })); await delay(150);
    }
    const live = inbox(config).entries.find(item => item.key === target.key);
    if (!live?.node.isConnected || !live.unread) throw new Error("The queued chat is no longer unread or available.");
    target = live;
    if (target.ambiguous && !target.id && !target.peer) throw new Error("Two sidebar chats have the same name; cannot identify this recipient safely.");
    if (all(config.selectors.composer).length && !composerEmpty(config)) throw new Error("Your composer contains a draft or attachment. It was preserved.");
    const nameControl = nameElement(target.node)?.closest('button, a[href], [role="button"], [tabindex]');
    const control = nameControl && target.node.contains(nameControl) ? nameControl : target.node;
    const matchesTarget = () => {
      try {
        const header = one(config.selectors.header, "chat title");
        return target.id ? stableId(header, config) === target.id :
          target.peer ? stableId(header, config) === `direct:${target.peer}` :
            Core.normalize(text(header)) === target.title;
      } catch { return false; }
    };
    const messageId = row => row.getAttribute("data-message-id") || row.getAttribute("data-mid") || row.id;
    const previousIds = new Set(matchesTarget() ? [] : all(config.selectors.row).map(messageId));
    control.click();
    let last = "", settled = 0, unsupported = "", unsupportedCount = 0;
    for (let attempt = 0; attempt < 24 && valid(); attempt++) {
      await delay(250);
      if (!valid()) break;
      try {
        // Teams can replace the header before replacing the outgoing chat's rows.
        if (all(config.selectors.row).some(row => previousIds.has(messageId(row)))) continue;
        const result = snapshot(config);
        if (result.isGroup) throw unsupportedChat("Group chats are available through Select this chat and Preview reply; the unread queue watches direct chats.");
        unsupported = ""; unsupportedCount = 0;
        if (result.title !== target.title || target.id && result.chatId !== target.id || !target.id && target.peer && result.chatId !== `direct:${target.peer}`) continue;
        const mark = Core.fingerprint(result);
        settled = mark === last ? settled + 1 : 0; last = mark;
        if (settled < 2) continue;
        const scroller = scrollerFor(all(config.selectors.row).at(-1), config);
        if (scroller) { scroller.scrollTop = scroller.scrollHeight; scroller.dispatchEvent(new Event("scroll", { bubbles: true })); }
        await delay(250);
        const ready = snapshot(config);
        if (ready.identity === result.identity && ready.title === target.title && ready.atBottom) return ready;
      } catch (error) {
        // A new header can appear before its messages. Require repeated group
        // evidence in the requested chat, never in the conversation we are leaving.
        const oldMessages = all(config.selectors.row).some(row => previousIds.has(messageId(row)));
        if (error.code === "UNSUPPORTED_CHAT" && matchesTarget() && !oldMessages) {
          unsupportedCount = unsupported === error.message ? unsupportedCount + 1 : 1;
          unsupported = error.message;
          if (unsupportedCount >= 3) throw error;
        } else { unsupported = ""; unsupportedCount = 0; }
      }
    }
    throw new Error("Could not confirm the unread conversation. Check Teams selectors or chat loading.");
  }
  function composer(config) { return one(config.selectors.composer, "message composer"); }
  function composerEmpty(config) {
    const editor = composer(config);
    const queuedAttachments = all('[data-tid="attachment-card"], [data-tid="compose-attachment"]')
      .filter(node => !node.closest(config.selectors.row) && !node.closest('[data-tid="chat-pane-item"]'));
    return !Core.normalize(text(editor)) && !editor.querySelector('img, [data-attachment-id], [contenteditable="false"]') &&
      queuedAttachments.length === 0;
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
  function sendControls(config) {
    const matches = all(config.selectors.send).map(match => match.matches('button, [role="button"]') ? match :
      match.closest('button, [role="button"]') || match.querySelector('button, [role="button"]') || match);
    return [...new Set(matches)].filter(visible);
  }
  function sendDisabled(control) {
    return !!control.disabled || control.matches(":disabled") || !!control.closest('[disabled], [aria-disabled="true"], [inert]');
  }
  async function send(config, reply, valid = () => true) {
    // Send may become enabled after the editor's state catches up with its DOM.
    let reason = "No visible Send control matched. Check the Send selector.";
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!valid() || Core.normalize(text(composer(config))) !== Core.normalize(reply)) throw new Error("The composer or conversation changed; sending was stopped.");
      const controls = sendControls(config);
      if (controls.length > 1) throw new Error("More than one Send control matched. Update the Send selector.");
      const control = controls[0];
      if (control && !sendDisabled(control)) {
        // Personal Teams may put the click handler directly on a div/span or SVG
        // rather than expose a native button or an accessible button role.
        if (typeof control.click === "function") control.click();
        else control.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window }));
        return;
      }
      reason = control ? "The matched Send control remained disabled. Review the composer." : "No visible Send control matched. Check the Send selector.";
      await delay(100);
    }
    throw new Error(`Teams Send did not become available. ${reason}`);
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
    try {
      const controls = sendControls(config);
      report.push("", `Resolved Send controls: ${controls.length}`);
      for (const control of controls.slice(0, 4)) {
        report.push(`Send control: ${control.tagName.toLowerCase()} role=${control.getAttribute("role") || "none"}; disabled=${sendDisabled(control)}; native click=${typeof control.click === "function"}`);
      }
    } catch (error) { report.push(`Send inspection failed: ${error.message}`); }
    const sidebar = inbox(config);
    report.push("", `Detected sidebar rows: ${sidebar.rowCount}`, `Readable sidebar names: ${sidebar.entries.length}`,
      `Unread sidebar chats: ${sidebar.entries.filter(item => item.unread).length}`, `Unread filter available: ${sidebar.filterAvailable}`, `Unread filter active: ${sidebar.filtered}`);
    for (const entry of sidebar.entries.slice(0, 4)) {
      report.push(`Sidebar row: ${entry.node.tagName.toLowerCase()} role=${entry.node.getAttribute("role") || "none"}; title role=${nameElement(entry.node)?.getAttribute("role") || "none"}; unread=${entry.unread}; stable key=${!!(entry.id || entry.peer)}; scrollable=${!!entry.viewport}`);
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
  root.TeamsReplyAdapter = { snapshot, recentHistory, captureMedia, unreadChats, scanUnread, openUnread, composerEmpty, insert, send, diagnostics };
})(globalThis);
