"use strict";
window.optionsTest = {
  config: JSON.parse(sessionStorage.getItem("options-config") || "null") || {
    selfName: "Test Owner", model: "custom-model", style: "No emojis. My favorite snack is toast."
  }
};
window.chrome = {
  runtime: {
    getURL: file => `chrome-extension://test-extension/${file}`,
    sendMessage: async () => ({ ok: true, reply: "Hello!" })
  },
  storage: { local: {
    get: async () => ({ config: structuredClone(optionsTest.config) }),
    set: async values => {
      optionsTest.config = structuredClone(values.config);
      sessionStorage.setItem("options-config", JSON.stringify(values.config));
    }
  } }
};
