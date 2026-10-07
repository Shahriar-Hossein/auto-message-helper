"use strict";
const form = document.getElementById("settings");
const status = document.getElementById("status");
const selectors = document.getElementById("selectors");
document.getElementById("extension-origin").value = chrome.runtime.getURL("").replace(/\/$/, "");
function display(config) {
  for (const key of Object.keys(TeamsReplyCore.DEFAULTS)) {
    if (key !== "selectors") form.elements.namedItem(key).value = config[key];
  }
  selectors.value = JSON.stringify(config.selectors, null, 2);
}
async function save() {
  if (!form.reportValidity()) throw new Error("Complete the highlighted fields.");
  const raw = Object.fromEntries(new FormData(form));
  raw.selectors = JSON.parse(selectors.value);
  raw.contextVersion = 3;
  const config = TeamsReplyCore.settings(raw);
  for (const selector of Object.values(config.selectors)) document.querySelector(selector);
  await chrome.storage.local.set({ config });
  status.textContent = "Settings saved. Active monitoring reloads the configuration automatically.";
}
form.addEventListener("submit", event => { event.preventDefault(); save().catch(error => { status.textContent = error.message; }); });
form.elements.namedItem("provider").addEventListener("change", event => {
  form.elements.namedItem("baseUrl").value = event.target.value === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234/v1";
});
document.getElementById("reset-selectors").addEventListener("click", () => {
  selectors.value = JSON.stringify(TeamsReplyCore.DEFAULT_SELECTORS, null, 2);
  status.textContent = "Default selectors restored in this form. Save to apply.";
});
document.getElementById("test").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await save(); status.textContent = "Contacting your local model…";
    const response = await chrome.runtime.sendMessage({ type: "test" });
    if (!response?.ok) throw new Error(response?.error || "No response from extension.");
    status.textContent = `Connected. Model replied:\n${response.reply}`;
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
chrome.storage.local.get("config").then(({ config }) => display(TeamsReplyCore.settings(config)))
  .catch(error => { display(TeamsReplyCore.DEFAULTS); status.textContent = error.message; });
