"use strict";
window.testState = { intervals: [], requests: [], sendCount: 0, now: 100000, response: null, shadow: null, changeListeners: [], monitor: null };
const originalAttachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (options) {
  const shadow = originalAttachShadow.call(this, options);
  if (this.id === "teams-local-replies") testState.shadow = shadow;
  return shadow;
};
window.setInterval = callback => { testState.intervals.push(callback); return testState.intervals.length; };
Date.now = () => testState.now;
testState.config = TeamsReplyCore.settings({ selfName: "Me", debounceMs: 1000 });
window.chrome = {
  storage: { local: {
    get: async key => key === "monitor" ? { monitor: testState.monitor } : { config: testState.config },
    set: async values => {
      if (values.monitor) testState.monitor = structuredClone(values.monitor);
      if (values.config) {
        const oldValue = testState.config;
        testState.config = structuredClone(values.config);
        for (const listener of testState.changeListeners) listener({ config: { oldValue, newValue: testState.config } }, "local");
      }
    }
  }, onChanged: { addListener: fn => testState.changeListeners.push(fn) } },
  runtime: { getURL: file => new URL(`../extension/${file}`, document.baseURI).href, sendMessage: async message => {
    testState.requests.push(message);
    if (message.type === "generate") return testState.response ? testState.response(message) : { ok: true, reply: "Sounds good!" };
    return { ok: true };
  } }
};
testState.sendFixtureReply = () => {
  testState.sendCount++;
  if (testState.suppressEcho) { document.querySelector('[data-tid="ckeditor"]').textContent = ""; return; }
  const row = document.createElement("div");
  row.dataset.tid = "chat-pane-message"; row.dataset.messageId = `outgoing-${testState.sendCount}`;
  const author = document.createElement("b"); author.dataset.tid = "message-author-name"; author.textContent = "Me";
  const body = document.createElement("p"); body.dataset.tid = "message-body";
  body.textContent = document.querySelector('[data-tid="ckeditor"]').innerText;
  row.append(author, body);
  const list = document.querySelector('[data-tid="message-pane-list-viewport"]'); list.append(row); list.scrollTop = list.scrollHeight;
  document.querySelector('[data-tid="ckeditor"]').textContent = "";
};
document.querySelector('[data-tid="send-message"]').addEventListener("click", testState.sendFixtureReply);
