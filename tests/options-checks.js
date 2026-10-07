"use strict";
window.addEventListener("load", async () => {
  const report = document.createElement("pre"); report.id = "test-result"; document.body.append(report);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    const form = document.getElementById("settings");
    const choices = [...form.querySelectorAll('input[name="personality"]')];
    assert(choices.length === 4, "Four mood options are displayed");
    assert(choices.every(choice => choice.type === "radio" && choice.required), "Native accessible radio group");
    const logos = [...document.querySelectorAll(".personality-card img")];
    assert(logos.length === 4 && logos.every(image => image.complete && image.naturalWidth > 0), "All four mascot images load");
    if (sessionStorage.getItem("options-reload")) {
      assert(form.elements.namedItem("personality").value === "plot-twist", "Saved mood survives an actual page reload");
      assert(form.elements.namedItem("style").value === "No emojis. My favorite snack is toast.", "Custom preferences survive reload");
      assert(form.elements.namedItem("model").value === "custom-model", "Model survives reload");
      document.documentElement.dataset.testResult = "pass";
      report.textContent = "PASS: four moods and logos, legacy default, selection, saving, preserved preferences, and page reload.";
      return;
    }
    assert(form.elements.namedItem("personality").value === "chuckles", "Old installations default to Chuckles");
    for (const choice of choices) {
      choice.closest("label").click();
      assert(form.elements.namedItem("personality").value === choice.value, "Clicking the card selects its mood");
      assert(form.querySelectorAll('input[name="personality"]:checked').length === 1, "Only one mood is selected");
      form.requestSubmit(); await tick();
      assert(optionsTest.config.personality === choice.value, "Selected mood is saved");
      assert(optionsTest.config.style === "No emojis. My favorite snack is toast.", "Saving retains custom facts");
      assert(document.getElementById("status").textContent.startsWith("Settings saved"), "Save completes successfully");
    }
    sessionStorage.setItem("options-reload", "1");
    location.reload();
  } catch (error) {
    document.documentElement.dataset.testResult = "fail";
    report.textContent = error.stack;
  }
});
