(async () => {
  const wait = () => new Promise((resolve) => setTimeout(resolve, 0));
  const until = async (predicate) => {
    for (let i = 0; i < 100 && !predicate(); i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (!predicate()) throw new Error("Timed out waiting for panel state");
  };
  const $ = (id) => testState.shadow.getElementById(id);
  const mood = (id) => $("mood-choices").querySelector(`input[value="${id}"]`);
  const click = async (id) => {
    $(id).click();
    await wait();
    await wait();
  };
  const choose = async (id) => {
    mood(id).click();
    await until(() => !$("moods").disabled);
  };
  const checked = [];
  const check = (label, condition) => {
    if (!condition) throw new Error(`${label}: ${$("status").textContent}`);
    checked.push(label);
  };
  try {
    await until(() => !$("moods").disabled);
    const images = [...$("mood-choices").querySelectorAll("img")];
    await until(() => images.every((image) => image.complete));
    check(
      "four compact mood logos load with the saved default selected",
      images.length === 4 &&
        images.every((image) => image.naturalWidth > 0 && image.width === 28) &&
        mood("chuckles").checked,
    );
    await click("select");
    $("scope").value = "selected";
    $("mode").value = "draft";
    const selected = $("selected").textContent;
    const original = structuredClone(testState.config);
    await choose("ember");
    check(
      "a paused mood change saves immediately without losing chat selection or other settings",
      testState.config.personality === "ember" &&
        $("selected").textContent === selected &&
        !$("start").disabled &&
        !$("preview").disabled &&
        JSON.stringify({
          ...testState.config,
          personality: original.personality,
        }) === JSON.stringify(original) &&
        !testState.monitor?.enabled,
    );

    // Start must wait for the selected mood to finish persisting.
    const set = chrome.storage.local.set;
    let finishSave;
    chrome.storage.local.set = async (values) => {
      if (values.config)
        await new Promise((resolve) => {
          finishSave = resolve;
        });
      return set(values);
    };
    mood("frost").click();
    await until(() => !!finishSave);
    const claims = testState.requests.filter(
      (request) => request.type === "claim",
    ).length;
    await click("start");
    check(
      "Start waits for a pending mood save",
      testState.requests.filter((request) => request.type === "claim")
        .length === claims && !testState.monitor?.enabled,
    );
    finishSave();
    await until(() => testState.monitor?.enabled && !$("moods").disabled);
    chrome.storage.local.set = set;
    check(
      "Start uses the saved mood and keeps the selected monitoring scope",
      testState.config.personality === "frost" &&
        $("start").disabled &&
        testState.monitor.scope === "selected",
    );

    await choose("plot-twist");
    check(
      "moods can change while monitoring without restarting or dropping the chat",
      testState.monitor.enabled &&
        $("start").disabled &&
        $("selected").textContent === selected &&
        mood("plot-twist").checked,
    );
    finishSave = null;
    chrome.storage.local.set = async (values) => {
      if (values.config)
        await new Promise((resolve) => {
          finishSave = resolve;
        });
      return set(values);
    };
    const generations = testState.requests.filter(
      (request) => request.type === "generate",
    ).length;
    mood("ember").click();
    await until(() => !!finishSave);
    await click("preview");
    await click("pause");
    finishSave();
    await until(() => !$("moods").disabled);
    await wait();
    await wait();
    check(
      "Pause cancels a generation waiting for a mood save",
      !testState.monitor.enabled &&
        testState.requests.filter((request) => request.type === "generate")
          .length === generations,
    );
    chrome.storage.local.set = set;
    await choose("plot-twist");
    await click("pause");
    let finishReply, requestMood;
    testState.response = async () => {
      requestMood = testState.config.personality;
      return new Promise((resolve) => {
        finishReply = resolve;
      });
    };
    $("preview").click();
    await until(() => !!finishReply);
    await choose("ember");
    finishReply({ ok: true, reply: "A reply already in progress." });
    await until(() => $("draft").value === "A reply already in progress.");
    check(
      "changing mood preserves an in-flight reply",
      requestMood === "plot-twist" && testState.config.personality === "ember",
    );
    $("draft").value = "My edited preview";
    $("draft").dispatchEvent(new Event("input"));
    await choose("frost");
    check(
      "changing mood preserves edited drafts",
      $("draft").value === "My edited preview" && !$("send").disabled,
    );
    await click("dismiss");
    testState.response = async () => {
      requestMood = testState.config.personality;
      return { ok: true, reply: "New mood reply." };
    };
    $("preview").click();
    await until(() => $("draft").value === "New mood reply.");
    check(
      "the next generation uses the newly saved mood",
      requestMood === "frost",
    );

    await set({ config: { ...testState.config, personality: "chuckles" } });
    check(
      "a mood saved in Settings synchronizes the panel without losing its draft",
      mood("chuckles").checked &&
        $("draft").value === "New mood reply." &&
        $("selected").textContent === selected,
    );
    chrome.storage.local.set = async (values) => {
      if (values.config) throw new Error("Storage unavailable");
      return set(values);
    };
    await choose("ember");
    check(
      "failed saves restore the saved selection and report the error",
      mood("chuckles").checked &&
        testState.config.personality === "chuckles" &&
        $("mood-status").textContent.includes("Storage unavailable"),
    );
    chrome.storage.local.set = set;

    await choose("frost");
    window.dispatchEvent(new Event("pagehide"));
    document.getElementById("teams-local-replies").remove();
    testState.intervals = [];
    testState.changeListeners = [];
    const reloaded = document.createElement("script");
    reloaded.src = "../extension/content.js?mood-reload";
    const ready = new Promise((resolve) => {
      reloaded.onload = resolve;
    });
    document.body.append(reloaded);
    await ready;
    await until(() => !$("moods").disabled);
    check("the chosen mood survives a panel reload", mood("frost").checked);
    document.documentElement.dataset.testResult = "pass";
    document.getElementById("test-result").textContent =
      `PASS (${checked.length} mood checks)\n${checked.join("\n")}`;
  } catch (error) {
    document.documentElement.dataset.testResult = "fail";
    document.getElementById("test-result").textContent =
      `${error.stack}\nPassed: ${checked.join("; ")}`;
  }
})();
