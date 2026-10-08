const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const directory = path.join(__dirname, "../extension");
const manifest = JSON.parse(
  fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
);
assert.equal(manifest.manifest_version, 3);
for (const name of fs.readdirSync(directory)) {
  if (name.endsWith(".js"))
    new vm.Script(fs.readFileSync(path.join(directory, name), "utf8"), {
      filename: name,
    });
}
const required = [
  manifest.background.service_worker,
  manifest.options_ui.page,
  ...manifest.content_scripts.flatMap((script) => script.js),
];
for (const name of required)
  assert.ok(
    fs.existsSync(path.join(directory, name)),
    `Missing manifest file: ${name}`,
  );
const html = fs.readFileSync(
  path.join(directory, manifest.options_ui.page),
  "utf8",
);
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g))
  assert.ok(
    fs.existsSync(path.join(directory, match[1])),
    `Missing options asset: ${match[1]}`,
  );
for (const persona of Object.values(
  require("../extension/core.js").PERSONALITIES,
)) {
  assert.ok(
    fs.existsSync(path.join(directory, persona.image)),
    `Missing personality image: ${persona.image}`,
  );
}
assert.deepEqual(
  manifest.web_accessible_resources,
  [
    {
      resources: Object.values(
        require("../extension/core.js").PERSONALITIES,
      ).map((persona) => persona.image),
      matches: manifest.content_scripts[0].matches,
    },
  ],
  "Only personality images should be exposed, limited to supported Teams hosts",
);
assert.deepEqual(manifest.permissions, ["storage"]);
assert.deepEqual(manifest.host_permissions, [
  "http://127.0.0.1/*",
  "http://localhost/*",
]);
console.log(
  "Extension JavaScript syntax, manifest assets, and permission scope passed.",
);
