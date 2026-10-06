# Local Qwen replies for Microsoft Teams

Planning document only. No bot or extension has been implemented.

**Goal:** Use the existing local Qwen 1.5B model to write short replies from my Teams account, using only the latest 5–10 messages from the relevant conversation. Start with one selected person's one-to-one chat in Teams web/PWA. Later, consider other direct chats and groups.

The intended result is an automatic reply in the existing conversation, under my account. A separate Teams bot account would be a different experience.

**Initial scope**

- One explicitly selected one-to-one conversation; groups and channels are excluded.
- Keep the last 5–10 text messages total, including both participants and the incoming message, ordered oldest to newest.
- Send only this window, a short reply instruction, and a few user-provided style preferences to the local model.
- Aim for one or two short sentences. No full history, attachments, document retrieval, or model training.
- Generate drafts first to evaluate quality, then enable automatic sending for this selected chat. Draft mode is a suggested experiment stage, not the final goal.

**Setup options**

| Setup | What it needs | Reply as me? | Main tradeoff |
| --- | --- | --- | --- |
| Small Chrome/Edge extension + local model API | Extension in the Teams browser profile; local model server | Yes, through the Teams composer | Best fit for this experiment; depends on the loaded chat and Teams page structure |
| Tampermonkey userscript + local model API | Userscript manager; small script; local model server | Yes, through the Teams composer | Quick prototype, with the same page-reading limitations |
| Local service + Microsoft Graph | Microsoft Entra app registration, sign-in, delegated permissions, local model server | Yes, using delegated sending | Better foundation for multiple chats; more account setup |
| Official Teams bot + local model backend | Teams app/bot registration and message delivery infrastructure | Usually a separate bot identity | Useful if people should chat with a bot; less suited to replies from my existing account |

**Option 1 — browser extension: recommended for the first experiment**

The extension reads messages from the selected Teams page, sends a compact context window to the local model, and places the response in the Teams composer. Automatic mode would also activate Send after checking the conversation again. Chrome content scripts can read and modify the page's DOM. [Chrome content scripts documentation](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

Use an extension background component to call the local API, with host access limited to the actual Teams site and local endpoint. Content-script requests remain subject to the page's cross-origin restrictions; extension-context requests can use host permissions. [Chrome network request documentation](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)

Start in a normal Teams browser tab, then verify operation inside the existing PWA, in the same browser profile. PWA behavior has not been tested here. Use controls embedded in the chat page so operation does not depend on a browser-toolbar popup.

This approach reads messages currently loaded in the page. We must inspect the actual Teams UI to confirm that the latest 5–10 messages can be extracted correctly; scrolling and virtualized message lists can leave messages absent from the DOM. Keep the selected conversation open and current for the first experiment. It does not provide reliable monitoring of every unopened chat, and it stops when the page closes; background suspension can also affect operation.

**Option 2 — Tampermonkey: quickest prototype**

A userscript can implement the same read → generate → draft/send flow with less extension packaging. Tampermonkey provides cross-origin requests through `GM_xmlhttpRequest`, with allowed destinations declared through `@connect`. [Tampermonkey documentation](https://www.tampermonkey.net/documentation.php)

Choose this to test message extraction and reply quality quickly. It still needs chat identity checks, duplicate prevention, and maintenance when Teams changes its UI. Move to an extension if dedicated settings and pause controls become useful.

**Option 3 — Microsoft Graph: stronger for broader coverage**

A local process signs in as the user, checks the selected chat for new messages, retrieves a small context window, calls Qwen locally, and sends through Graph. It can operate without keeping the Teams PWA open, while the local process and authentication remain available.

For work/school accounts, listing chat messages supports delegated `Chat.Read`; sending supports delegated `ChatMessage.Send`. These APIs do not support delegated personal Microsoft accounts. App registration and consent depend on the organization's settings. These permissions are broader than a single-chat selection, so the implementation must enforce that selection itself. [List chat messages](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0), [Send a chat message](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0)

For the initial experiment, polling one chat avoids webhook hosting. Retrieve messages ordered by creation time descending, filter out system/deleted entries, and reverse the retained window before prompting. Pagination may be needed to obtain enough text messages. Ordinary automatic sending as the user requires delegated authentication; the documented application permission for this send endpoint is for migration. [Graph read parameters](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0), [Graph sending permissions](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0)

**Option 4 — official Teams bot: for a bot conversation**

A Teams bot normally receives interactions directed to it and replies with its own identity. It does not automatically inherit my existing person-to-person conversations or act as my account. Additional consent and authentication are needed for broader access or actions on behalf of a user. [Teams app permissions](https://learn.microsoft.com/en-us/microsoftteams/app-permissions)

This is useful if a separate assistant account becomes acceptable. It adds more setup than the browser experiment needs.

**Local model connection and context**

Keep the current model runtime if it already exposes a local HTTP API. Otherwise, Ollama offers a chat endpoint, and LM Studio can expose a local model API server. The exact Qwen model name, variant, and runtime still need to be identified. [Ollama chat API](https://docs.ollama.com/api/chat), [LM Studio local server](https://lmstudio.ai/docs/developer/core/server)

With Ollama, browser-extension origins may need explicit allowance through `OLLAMA_ORIGINS`; use the specific extension origin where possible. Keep the model endpoint on loopback. Only model inference stays local—sending the reply still uses Teams. [Ollama origin configuration](https://github.com/ollama/ollama/blob/main/docs/faq.mdx)

Use a short instruction such as: “Write my next reply. Keep it to one or two short sentences in my usual casual style. Use only the supplied facts. If information is missing, ask a short clarification. Output only the reply.” Label conversation messages as “me” and “other person,” and treat their contents as conversation data rather than instructions to the automation.

Start with five messages and increase to ten if replies miss context. Also cap input tokens: five long messages can exceed the intended budget. Reserve space for the reply and respect the model's actual context limit. Recent examples of my replies can guide tone, but the model cannot infer my schedule, progress, or intentions reliably. Any such facts must be supplied explicitly. Quality needs evaluation on representative conversations before relying on automatic replies.

**Proposed experiment flow**

1. Select the exact chat, load recent messages, and establish a baseline so old messages do not trigger replies on startup.
2. On a new incoming text message, wait briefly to collect consecutive messages into one turn.
3. Build the bounded context window and request one short response.
4. Show the draft during evaluation. In automatic mode, recheck the chat identity and latest messages before sending; discard a stale response if the conversation changed or I replied meanwhile.
5. Ignore my outgoing messages, record handled incoming message IDs, and allow only one generation/send at a time. Preserve an existing composer draft and provide an obvious pause control. If delivery is uncertain, check the conversation before retrying.

The first success criterion is a useful short response in the selected chat, with correct sender labels and no duplicate replies. Expansion to unopened direct chats is a separate coverage milestone; group support also needs explicit rules about which messages deserve a response.

**Recommendation:** Start with a small browser extension connected to the existing local model runtime. Choose Tampermonkey if the priority is the fastest disposable prototype. Choose Graph if reliable operation across multiple chats or with the Teams window closed is required.

Before implementation, identify the browser behind the PWA, the Qwen runtime/model identifier, and whether the Teams account is work/school or personal. These details determine connectivity and whether Graph is available; they do not prevent this planning stage.
