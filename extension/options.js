"use strict";
const form = document.getElementById("settings");
const status = document.getElementById("status");
const selectors = document.getElementById("selectors");
document.getElementById("extension-origin").value = chrome.runtime
  .getURL("")
  .replace(/\/$/, "");
for (const [id, persona] of Object.entries(TeamsReplyCore.PERSONALITIES)) {
  const card = document.createElement("label");
  card.className = "personality-card";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = "personality";
  input.value = id;
  input.required = true;
  const image = document.createElement("img");
  image.src = persona.image;
  image.alt = "";
  image.width = 52;
  image.height = 52;
  const details = document.createElement("span");
  details.className = "personality-details";
  const name = document.createElement("strong");
  name.textContent = persona.name;
  const mood = document.createElement("span");
  mood.className = "personality-mood";
  mood.textContent = persona.mood;
  const description = document.createElement("span");
  description.className = "personality-description";
  description.textContent = persona.description;
  details.append(name, mood, description);
  card.append(input, image, details);
  document.getElementById("personalities").append(card);
}
function display(config) {
  for (const key of Object.keys(TeamsReplyCore.DEFAULTS)) {
    if (key !== "selectors") form.elements.namedItem(key).value = config[key];
  }
  selectors.value = JSON.stringify(config.selectors, null, 2);
}
async function save() {
  if (!form.reportValidity())
    throw new Error("Complete the highlighted fields.");
  const raw = Object.fromEntries(new FormData(form));
  raw.selectors = JSON.parse(selectors.value);
  raw.contextVersion = 3;
  const config = TeamsReplyCore.settings(raw);
  for (const selector of Object.values(config.selectors))
    document.querySelector(selector);
  await chrome.storage.local.set({ config });
  status.textContent =
    "Settings saved. Active monitoring reloads the configuration automatically.";
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  save().catch((error) => {
    status.textContent = error.message;
  });
});
form.elements.namedItem("provider").addEventListener("change", (event) => {
  form.elements.namedItem("baseUrl").value =
    event.target.value === "ollama"
      ? "http://127.0.0.1:11434"
      : "http://127.0.0.1:1234/v1";
});
document.getElementById("reset-selectors").addEventListener("click", () => {
  selectors.value = JSON.stringify(TeamsReplyCore.DEFAULT_SELECTORS, null, 2);
  status.textContent =
    "Default selectors restored in this form. Save to apply.";
});
document.getElementById("test").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await save();
    status.textContent = "Contacting your local model…";
    const response = await chrome.runtime.sendMessage({ type: "test" });
    if (!response?.ok)
      throw new Error(response?.error || "No response from extension.");
    status.textContent = `Connected. Model replied:\n${response.reply}`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
chrome.storage.local
  .get("config")
  .then(({ config }) => display(TeamsReplyCore.settings(config)))
  .catch((error) => {
    display(TeamsReplyCore.DEFAULTS);
    status.textContent = error.message;
  });
