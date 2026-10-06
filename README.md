# Teams Local Replies

A Chrome/Edge extension that uses your local Qwen model to write short replies in one selected Microsoft Teams chat. Controls live inside the Teams page, including an installed PWA, so a browser toolbar is unnecessary.

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

LM Studio uses `/v1/chat/completions`; enable its local server and select its actual model ID. [LM Studio chat completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)

Only HTTP endpoints on `localhost` or `127.0.0.1` are accepted. Model requests run in the extension worker, use loopback host permissions, omit credentials, and reject redirects. [Chrome extension network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)

## Use it

1. Open the intended **one-to-one chat**, scroll to the bottom, and leave it open.
2. Click **Select this chat**, then expand **Inspect loaded context**. Verify the person, order, and **Me** labels. The other sender's name must match the chat title. Groups and channels are excluded.
3. Choose **Draft** and click **Start**. Existing messages establish a baseline. New incoming text triggers generation after a short wait for consecutive messages.
4. Review/edit the reply, then choose **Insert draft**. Press Teams' own Send button. Monitoring waits while an unreviewed panel draft is present; insert or dismiss it to continue.
5. Once extraction and replies work, pause, choose **Automatic send**, and start again. This mode inserts and clicks Teams Send after checking the chat, messages, and composer again.

**Generate now** drafts a reply to the latest incoming message, including one already present at startup or a previously failed attempt. It always creates a reviewable draft, even when Automatic send is selected. If the latest message is yours, it waits for an incoming message.

**Pause** stops monitoring and discards in-flight results. It does not remove text already inserted in Teams. Switching chats or changing settings pauses operation. Reloading Teams starts paused and requires selecting the chat again. Only one window in this browser profile can control replies; an abandoned controller lease expires after 45 seconds.

## If selectors differ

The panel reports when it cannot identify a title, message, sender, ID, scroller, composer, or Send button. Failed selection automatically opens a page check and keeps Start/Generate disabled so a later click cannot hide the original error. You can also click **Check Teams page → Copy page check** and share the report here to diagnose your PWA's selectors. The report contains selector counts and DOM metadata, without message text, chat names, message/chat IDs, or model settings.

In **Settings → Teams selectors**, update the JSON CSS selectors using the PWA's DevTools. Save, select the chat again, and inspect the context. After updating extension files, reload the extension from `chrome://extensions` or `edge://extensions`, then reload the PWA; reloading only Teams does not necessarily pick up extension updates.

| Selector | Required match |
| --- | --- |
| `header` | One visible title containing only the other person's display name |
| `row` | Each visible message container with `data-message-id`, `data-mid`, or a stable `id` |
| `body` | One text body inside each row; the default also reads untagged `chat-pane-message` text after removing action/reaction controls and media previews |
| `author` | A display name inside the row or its enclosing `chat-pane-item`, which must contain exactly one message; `data-author-name` on the row is also accepted |
| `composer` | One visible Teams `contenteditable` input |
| `send` | One visible Teams Send button |
| `scroller` | The actual scrolling viewport containing the message rows |
| `identity` | An element for the **current chat** carrying `data-chat-id`, `data-conversation-id`, or `data-thread-id` |

A row explicitly marked `data-is-own-message="true"` can identify your own messages without a name. Other missing authors stop generation; a message never inherits the preceding row's sender. Attachment-only rows are skipped.

A conversation key can come from the title's ancestors or a Teams URL containing a `19:` chat ID. In the personal-account UI, exactly one `participant-` key inside `chat-title` can identify the selected recipient instead. Multiple participant keys are rejected. **Automatic sending requires a stable conversation key.** Without one, draft mode can bind to the displayed title; inspect the person carefully, since names are not unique. Do not invent a fixed ID or select unrelated sidebar items to bypass this check.

Saved original default selectors migrate automatically to newer defaults when the extension loads; custom selectors, model settings, and your display name are preserved. Reload the extension and PWA to apply updates; there is no need to reset your settings.

Virtualized lists may expose fewer than five messages. The extension uses only loaded text and does not scroll to fetch history. Scrolling away from the bottom pauses monitoring.

## Behavior and limits

- Uses the latest 5–10 loaded text messages, oldest to newest, labeled as you and the other person.
- Applies a character budget and a conservative 3,500-byte serialized prompt budget, reserving room for formatting and 128 output tokens in Qwen's 4,096-token context. Long messages/preferences may be shortened. Other model/tokenizer limits depend on your server.
- Generates one reply at a time, preserves existing composer drafts/attachments, and discards stale responses when messages change or you type during generation.
- Reserves hashed attempt keys before inference. Failed or uncertain attempts are not automatically retried; **Generate now** explicitly retries as a draft.
- After automatic Send, looks for a new matching outgoing message. If none appears within 12 seconds, pauses with uncertain delivery. This DOM observation is not a server delivery receipt; check Teams before trying again.
- Aborts inference after 25 seconds, below the worker's fetch-response timeout. Warm up slow models first. [Chrome worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- Watches only the selected open chat. Closing the PWA stops operation. Browser throttling/suspension and Teams UI changes can delay or prevent replies.

Settings use local extension storage. Chat context and replies stay in memory; session storage holds only hashed attempt keys and controller coordination. Inference goes to your loopback server; sending still uses Teams. Your server may have its own logging. No telemetry or Microsoft Graph registration is included.

## Development

Node 20+; no dependencies:

```bash
npm run check
npm test
```

Tests cover prompt bounds, endpoint restrictions, freshness, worker sender validation, window ownership, concurrent inference, duplicates, and failed attempts. With Chrome/Chromium installed, the suite also opens `tests/browser.html` in an isolated temporary headless profile to exercise DOM extraction and rich-text insertion. Set `TEAMS_TEST_BROWSER` to an absolute Chromium executable path if needed. Process-launch permission is required; the browser test skips only if no browser is installed. You can also open the fixture manually.

Tests do not sign in to Teams or contact your model. The original architecture plan is preserved in [docs/design.md](docs/design.md).
