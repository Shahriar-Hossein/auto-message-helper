const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const browser = process.env.TEAMS_TEST_BROWSER || ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
test("real Chromium DOM: extraction, baseline, drafts, stale replies, and automatic sending", { skip: browser ? false : "Chrome/Chromium not installed; open tests/browser.html manually", timeout: 60000 }, () => {
  const profile = mkdtempSync(path.join(tmpdir(), "teams-replies-browser-"));
  try {
    const result = spawnSync(browser, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--disable-background-networking",
      `--user-data-dir=${profile}`, "--virtual-time-budget=90000", "--dump-dom", pathToFileURL(path.join(__dirname, "browser.html")).href],
      { encoding: "utf8", timeout: 55000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.error?.message || result.stderr.slice(-2000));
    const report = result.stdout.match(/<pre id="test-result">([\s\S]*?)<\/pre>/)?.[1];
    assert.match(result.stdout, /data-test-result="pass"/, report || result.stdout.slice(-2000));
    console.log(report);
  } finally { rmSync(profile, { recursive: true, force: true }); }
});
