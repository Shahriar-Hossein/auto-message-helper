# Teams Local Replies

A Chrome/Edge extension that uses Ollama or a local OpenAI-compatible model to reply as one of four polite AI sidekicks across unread Microsoft Teams direct chats and prepare replies for selected group chats. Controls live inside the Teams page, including an installed PWA, so a browser toolbar is unnecessary.

The extension is implemented and tested against browser fixtures, including the title, sender placement, and Send control reported by your Teams PWA. **Live end-to-end operation has not been verified here.** Other Teams UI variants may need selector adjustments.

## Install in your PWA's browser

1. Use the **same browser profile that installed your Teams PWA**.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable **Developer mode**, choose **Load unpacked**, and select this repository's **`extension/`** folder. No build or npm install is needed.
4. Reload the Teams PWA (`Ctrl+R`), or close and reopen it. Look for **Local Replies** at the bottom right.
5. Open **Settings** in that panel. The extension's browser action also opens settings.

Supported hosts: `teams.microsoft.com`, `teams.cloud.microsoft`, and `teams.live.com`. This targets a Chromium web/PWA installation, not the native Teams desktop app, Firefox, Safari, or sovereign-cloud hosts. Verify PWA injection in your browser/profile. [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

## Connect your model

Choose the server you already use; the example Qwen name is a default, not a claim about your installed model.

| Setting | Ollama | LM Studio / OpenAI-compatible |
| --- | --- | --- |
| Server type | Ollama | OpenAI-compatible / LM Studio |
| Base URL | `http://127.0.0.1:11434` | `http://127.0.0.1:1234/v1` |
| Model ID | Exact name from `ollama list`, e.g. `qwen2.5:1.5b` | Exact model ID from your server's `/v1/models` |

Start the server and warm up the model. Enter **your exact Teams display name**, as shown on your sent messages, then choose **Save & test model**. The test sends a synthetic greeting, not your chat history.

Ollama requests use `/api/chat`, with streaming disabled. If its origin policy blocks the connection, find the extension ID on the browser's extensions page and add `chrome-extension://YOUR_EXTENSION_ID` to the **running server's** `OLLAMA_ORIGINS`. Restart that server with the updated environment. For a manually started server:

```bash
OLLAMA_ORIGINS="chrome-extension://YOUR_EXTENSION_ID" ollama serve
```

For a system service, configure its environment instead of starting a second server on the same port. [Ollama origin configuration](https://github.com/ollama/ollama/blob/main/docs/faq.mdx), [Ollama chat API](https://docs.ollama.com/api/chat)

**HTTP 403 from Ollama:** copy **This extension's origin** from extension Settings. On Linux with systemd, run `sudo systemctl edit ollama.service` and add the following, replacing the example origin with the one you copied:

```ini
[Service]
Environment="OLLAMA_ORIGINS=chrome-extension://YOUR_EXTENSION_ID"
```

Then apply it with `sudo systemctl daemon-reload` and `sudo systemctl restart ollama.service`. If `OLLAMA_ORIGINS` already allows other origins, preserve them and append this origin separated by a comma. Retry **Save & test model**, then **Generate & send**. A model-ID error is separate: for example, `qwen2.5-coder:1.5b` and `qwen2.5:1.5b` are different model names, so use the exact entry from `ollama list`.

LM Studio uses `/v1/chat/completions`; enable its local server and select its actual model ID. [LM Studio chat completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)

Only HTTP endpoints on `localhost` or `127.0.0.1` are accepted. Model requests run in the extension worker, use loopback host permissions, omit credentials, and reject redirects. [Chrome extension network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)

## Use it

1. Configure your model and exact Teams display name in **Settings**.
2. Choose **Automatic send** and **All unread direct chats**, then click **Start** once. It immediately scans existing unread chats and starts processing them one at a time.
3. Leave Teams open. The extension uses Teams’ **Unread** filter when available, scans the sidebar every three seconds while idle, and queues unread chats. It opens each chat, confirms the recipient, reads up to the latest **20 messages**, sends the reply, verifies the outgoing message, then moves to the next queued chat. The panel shows how many unread chats were found and how many are queued.
4. Monitoring resumes after reloading or reopening Teams, including checking the open conversation for an unhandled incoming message. **Pause** saves monitoring as off. Only one Teams window in the browser profile controls replies.

Use **Selected chat only** to restrict monitoring to one conversation: open it, click **Select this chat**, inspect sender labels, and start. Resuming this mode requires the same conversation. Sidebar section controls such as Favorites and Chats are excluded from the unread queue. Confirmed groups are skipped by **All unread direct chats** for the current monitoring session so they cannot keep reopening ahead of direct chats. New unread replies from previously answered people are queued even when their preview text is unchanged. Selected-chat mode establishes a baseline in the open chat. All-unread mode processes messages that were already unread when Start was clicked, including the current conversation if it appears unread in the sidebar. Reload resumes unhandled incoming messages, with saved attempt hashes preventing repeat automatic attempts.

**Group chats:** open the group, click **Select this chat**, then **Preview reply** for an immediate draft. To monitor new group messages, choose **Selected chat only** and press **Start**. Group monitoring follows the selected mode: Automatic send generates and sends replies; Draft prepares panel drafts for review. The bot reads up to the last **50 messages**, preserving each participant's name and quoted text. Edit the draft and choose **Send reply**, or **Insert draft** to review it in Teams. **Generate & send** explicitly generates and sends in a selected group too. Channels remain excluded. All unread direct chats continues to process direct conversations only.

Group drafts survive new incoming messages, older rows being recycled, media previews loading, and your own composer edits. Automatic send and **Generate & send** tolerate older history being loaded or recycled and older media previews refreshing. Automatic monitoring waits while you read older messages or have a composer draft, then resumes when you return to the bottom and clear the composer. A still-fresh, untouched automatic panel draft sends on return; if newer messages arrived, it is replaced with a reply to the latest incoming message after the debounce. Editing the panel draft, using Preview reply, changing message content or source media, and composer activity during generation require review. Explicit Generate & send also keeps changed context as a reviewable draft. Selected-group sending also works when Teams does not expose a conversation ID: the selected group title and the original source message's ID, sender, and text must still match. Automatic sending additionally requires that source message to remain the latest incoming message at the bottom of the chat. An edited or unavailable source message blocks sending with a specific explanation. Existing composer text and queued attachments are preserved; received attachments do not block drafting. Manual group previews can load the latest context even when you start above the bottom of the chat.

**Generate & send** requests insertion and sending, even if incoming-message monitoring is set to Draft; new group messages, content edits, or composer changes during this explicit action keep the reply as a reviewable draft. **Preview reply** creates a reviewable panel draft. **Send reply** sends that existing draft without generating it again. It explicitly allows retrying an earlier attempt. If the latest message is yours, generation waits for an incoming message. Use **Send reply** to send a panel preview, or **Insert draft** followed by Teams' Send button; preview and edited panel drafts wait until you send, insert, or dismiss them; untouched automatic drafts can resume or be replaced as the conversation advances.

The extension fetches earlier virtualized messages with bounded scroll attempts when fewer than the requested window are loaded, then returns to the latest message. It may receive fewer messages if history is unavailable. Direct chats default to 20 messages, configurable up to 50; groups always request 50. During generation, **Inspect loaded context** shows the actual recent context. Sender names and roles remain distinct and messages stay in chronological order. Long turns may be shortened to fit the model budget.

Choose **Settings → Personality & mood** and save to select a sidekick. Each option has its own mascot logo:

| Personality | Mood | Reply style |
| --- | --- | --- |
| Chuckles | Sarcastic | Gentle, warm wit about the situation |
| Ember | Angry | Restrained, theatrical frustration at the problem; always courteous |
| Frost | Cold-hearted | Cool, concise, reserved, and impeccably polite |
| Plot Twist | Mood breaker | Playful surprises that lighten ordinary tension without derailing the request |

Every persona is instructed to be as polite and considerate as possible. Serious or sensitive topics get gentle, sincere replies. The owner is male: English references use **he/him/his**, not they/them. The owner nickname is **my hooman** in English and exactly **amr hoooman** in Bangla and Banglish, including the Latin spelling inside Bangla-script replies. Nicknames refer only to the owner, never the recipient. **Settings → Extra style preferences and your known facts** applies to all personas; courtesy and owner identity take priority over conflicting style preferences. Existing installations default to Chuckles, retain custom preferences, and migrate the old stock style to a mood-neutral default. Saved mood changes apply to subsequent model requests; existing drafts keep their original text.

Your sidekick matches the latest recipient's language, spelling style, and level of formality. Banglish means Bangla written in Latin letters; older English replies do not select English for a new Banglish message. Replies go straight to the message: no repeated introduction, busy-owner preamble, or automatic disclosure lines. The sidekick identifies itself honestly by its selected name if asked. It can answer questions, summarize discussions, draft messages, explain problems, and suggest concrete fixes using the chat context. It cannot inspect PCs or perform external actions and must distinguish evidence from speculation. Emojis follow the selected mood and your preferences. If a detected Banglish message gets an English or Bangla-script response, the extension retries inference once with stricter language guidance; continued mismatch is reported without sending. Detection uses common Banglish words, so unfamiliar spellings can still need a better model. Personality, politeness, and pronouns are model instructions, not a guarantee of every model's output; Preview reply lets you review the result.

Images, GIFs, and media-only messages count in the context window. Captions and attachment labels are included. In **Image understanding → Detect automatically**, Ollama's `/api/show` capabilities determine whether actual image pixels can be attached. A text-only model receives captions and is told not to pretend it saw the media. GIFs and supported video previews supply one still frame. OpenAI-compatible servers require explicitly choosing **Enabled — vision model**. See [Ollama vision inputs](https://docs.ollama.com/capabilities/vision).

Loaded previews are resized to at most 384 pixels per side, with a maximum of 20 encoded images and 2 MB total across the context; remaining media retain captions. Images that the browser cannot read, including restricted cross-origin previews or unloaded media, also retain captions. The extension does not download attachment files. It replies with text and emojis, not outgoing GIFs or images.

Insertion uses the editor's plain-text paste handling or a native editing command with the caret in the composer. It verifies that Teams retained the text, then waits up to five seconds for the actual Send control to become enabled. Send supports native buttons, clickable div/span controls, and icons, including controls without a button role. It respects disabled controls and disabled ancestors, clicks once, and observes a matching new outgoing message before continuing the unread queue. Existing composer text and attachments are preserved; sending and navigation wait while your Teams composer contains a draft. All-unread mode continues scanning and can open queued chats while the current conversation is scrolled up. Switching conversations discards in-flight replies. Direct-chat sending also cancels on context or composer changes; group replies remain reviewable drafts when the same conversation changes.

Reload the extension in `chrome://extensions` or `edge://extensions`, then reload Teams to apply updates. The panel should show **v0.2.12** and **Generate & send**. If an earlier failed send left text in Teams' composer, clear that unsent draft once so monitoring can continue; existing drafts are preserved on reload. Old sidebar and Send selector defaults migrate automatically. Both the standard and simplified Teams compose toolbars are supported. Old 5- or 10-message defaults migrate to 20; the previous default context budget grows from 12,000 to 24,000 characters. Groups use 50 messages and 48,000 characters. Your model, display name, explicit monitoring mode, and custom style remain saved.

Automatic replies recover when newer messages arrive after insertion but before Send. The extension removes its own unchanged draft through the editor and generates a fresh reply after the debounce. Manual Generate & send and Send reply also remove unchanged bot drafts in this situation, keeping the panel reply for review. Cleanup requires the same conversation, the original editor, identical composer markup, no user activity and no queued attachments. A human edit or replaced editor keeps the draft for review. Once Send is attempted, the extension verifies delivery before proceeding; it never clears or retries an uncertain send.

Incoming message IDs that arrive during delivery remain pending even when the outgoing reply appears after them. Follow-up inference preserves chronological context and marks the unanswered incoming turn; a later human outgoing reply takes precedence. Pending-message tracking and insertion ownership stay in memory and do not survive reloading Teams. Markdown code fences are removed from generated and inserted replies; JSON/code content and indentation remain ordinary text so fence delimiters cannot activate Teams' native code-block editor.

## If selectors differ

If automatic insertion or sending fails, the reply stays in the panel, the status explains that sending stopped, and a page check opens automatically for copying. The panel reports when it cannot identify a title, message, sender, ID, scroller, composer, or Send button. Failed selection automatically opens a page check and keeps Start/Generate disabled so a later click cannot hide the original error. You can also click **Check Teams page → Copy page check** and share the report here to diagnose your PWA's selectors. The report contains selector counts and DOM metadata, without message text, chat names, message/chat IDs, or model settings.

In **Settings → Teams selectors**, update the JSON CSS selectors using the PWA's DevTools. Save, select the chat again, and inspect the context. After updating extension files, reload the extension from `chrome://extensions` or `edge://extensions`, then reload the PWA; reloading only Teams does not necessarily pick up extension updates.

| Selector | Required match |
| --- | --- |
| `header` | One visible title containing only the other person's display name |
| `row` | Each visible message container with `data-message-id`, `data-mid`, or a stable `id` |
| `body` | One text body inside each row; the default also reads untagged `chat-pane-message` text after removing action/reaction controls and media previews |
| `author` | A display name inside the row or its enclosing `chat-pane-item`, which must contain exactly one message; `data-author-name` on the row is also accepted |
| `composer` | One visible Teams `contenteditable` input |
| `send` | One visible Teams Send control or its icon; a native button or button role is optional |
| `scroller` | The actual scrolling viewport containing the message rows |
| `chatItem` | Sidebar chat entries; defaults include accessible tree/list/option rows. Personal Teams entries without these attributes are also discovered from their accessible name headings and unread indicators. |
| `unread` | Unread attributes or indicators on or inside each sidebar entry |
| `identity` | An element for the **current chat** carrying `data-chat-id`, `data-conversation-id`, or `data-thread-id` |

A row explicitly marked `data-is-own-message="true"` can identify your own messages without a name. Other missing authors stop generation; a message never inherits the preceding row's sender. Media-only rows are included when an image, GIF, or supported attachment preview is present.

A conversation key can come from the title's ancestors or a Teams URL containing a `19:` chat ID. In the personal-account UI, exactly one `participant-` key inside `chat-title` can identify a direct-chat recipient instead. Multiple participant keys indicate a group and cannot substitute for its conversation ID. **Automatic direct-chat sending requires a stable conversation key.** Selected-group sending can instead bind to the title and original source message ID, sender, and text, with automatic sending requiring the source to remain the latest incoming message. Names alone cannot authorize sending. Do not invent a fixed ID or select unrelated sidebar items to bypass this check.

Saved original default selectors migrate automatically to newer defaults when the extension loads; custom selectors, model settings, and your display name are preserved. Reload the extension and PWA to apply updates; there is no need to reset your settings.

Virtualized history is loaded with up to eight scroll attempts. If Teams cannot expose the requested 20 direct-chat or 50 group-chat messages, the available history is used. Selected-chat mode remains enabled while you scroll away from the bottom and resumes automatically on return. Viewport detection uses the actual scrolling ancestor rather than an unscrollable inner list, including reversed scroll coordinates. All-unread mode keeps scanning the inbox and opens queued unread direct chats.

## Behavior and limits

- Uses up to the latest 20 messages by default in direct chats (configurable to 50), and 50 in groups, including media-only turns, oldest to newest.
- Direct chats default to a 24,000-character context and a 32,000-byte serialized text prompt budget. Groups use 48,000 characters and 64,000 bytes. Ollama requests 32,768 context tokens; both providers allow 1,024 output tokens, with a 6,000-character reply guard. Image data is budgeted separately; actual model limits and memory usage vary.
- Generates one reply at a time and checks chat identity, message freshness, composer text, and user activity before sending.
- Saves only hashed attempt keys for up to 500 recent attempts. Failed or uncertain automatic attempts are not retried; **Generate & send** explicitly retries. In all-chat mode, a failed generation leaves monitoring enabled for future incoming messages.
- After Send, looks for a matching new outgoing message. If none appears within 12 seconds, it stops with uncertain delivery. This is a DOM observation, not a server delivery receipt; check Teams before retrying.
- The model request has a shared 60-second timeout, including image capability detection and any language correction. Warm up slow models first.
- Requires Teams to remain open in the browser/PWA with the chat sidebar available. The extension scrolls the sidebar in bounded batches to discover virtualized entries and re-finds queued rows after Teams rerenders them. Closing Teams stops execution; saved monitoring scans the inbox again on reopening. Browser suspension and Teams UI changes can delay detection. Native Teams desktop is unsupported.

Settings, monitoring preferences, and hashed attempt keys use local extension storage. Chat text, encoded previews, and replies stay in memory; session storage holds only controller coordination. Inference goes to your configured loopback server; sending uses Teams. Your server may have its own logging. No telemetry or Microsoft Graph registration is included.

## Development

Node 20+; no dependencies:

```bash
npm run check
npm test
```

Tests cover prompt bounds, endpoint restrictions, freshness, worker sender validation, window ownership, concurrent inference, duplicates, and failed attempts. With Chrome/Chromium installed, the suite also opens `tests/browser.html` in an isolated temporary headless profile to exercise DOM extraction and rich-text insertion. Set `TEAMS_TEST_BROWSER` to an absolute Chromium executable path if needed. Process-launch permission is required; the browser test skips only if no browser is installed. You can also open the fixture manually.

Tests do not sign in to Teams or contact your model. The original architecture plan is preserved in [docs/design.md](docs/design.md).

For actual reply quality, see the [local and cloud model comparison](docs/model-response-evaluation.md), including recorded API replies and tested prompts from the earlier version; these benchmarks have not been rerun for the current prompt. The standalone `tools/compare-responses.cjs` runner tests fictional conversations through Ollama; it runs separately from `npm test` and does not change extension settings. For example, `node tools/compare-responses.cjs gemma4:31b-cloud refined` repeats the strongest tested combination. A `-cloud` model sends those fictional samples to Ollama Cloud.
