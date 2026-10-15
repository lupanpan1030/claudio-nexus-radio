import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkBoundaries, importSpecifiers, stripComments } from "./check-package-boundaries.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixtureRepo(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claudio-boundaries-"));
  const base = {
    "packages/contracts/package.json": JSON.stringify({ name: "@claudio/contracts", exports: { ".": "./dist/index.js" } }),
    "packages/contracts/tsconfig.json": JSON.stringify({ compilerOptions: { lib: ["ES2022"], types: [] } }),
    "packages/contracts/src/index.ts": "export const ok = 1;\n",
    "packages/playback-core/package.json": JSON.stringify({
      name: "@claudio/playback-core",
      exports: { ".": "./dist/index.js" },
      dependencies: { "@claudio/contracts": "0.1.0" }
    }),
    "packages/playback-core/tsconfig.json": JSON.stringify({ compilerOptions: { lib: ["ES2022"], types: [] } }),
    "packages/playback-core/src/index.ts": 'import { ok } from "@claudio/contracts";\nexport const value = ok;\n'
  };
  for (const [rel, content] of Object.entries({ ...base, ...files })) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

test("the real workspace packages respect their boundaries", async () => {
  assert.deepEqual(await checkBoundaries(repoRoot), []);
});

test("a clean fixture passes", async () => {
  const root = await fixtureRepo({});
  try {
    assert.deepEqual(await checkBoundaries(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host, vendor, reverse and ambient-clock dependencies are reported", async () => {
  const root = await fixtureRepo({
    "packages/playback-core/src/bad.ts": [
      'import React from "react";',
      'import { db } from "../../../server/db.js";',
      'export { thing } from "node:fs";',
      "export const t = Date.now();",
      "export const el = document.createElement('audio');",
      "export const vendor = { kugou: true };"
    ].join("\n"),
    "packages/contracts/src/bad.ts": 'import { step } from "@claudio/playback-core";\nexport const x = step;\nexport const at = Date.parse("2026-02-30T00:00:00Z");\n',
    "packages/contracts/tsconfig.json": JSON.stringify({ compilerOptions: { lib: ["ES2022", "DOM"], types: ["node"] } }),
    "packages/playback-core/package.json": JSON.stringify({
      name: "@claudio/playback-core",
      exports: { ".": "./dist/index.js" },
      dependencies: { "@claudio/contracts": "0.1.0", express: "5" }
    })
  });
  try {
    const messages = (await checkBoundaries(root)).map((v) => `${v.file}: ${v.message}`).join("\n");
    assert.match(messages, /bad\.ts: import of react is not allowed/);
    assert.match(messages, /relative import escapes packages\/playback-core\/src/);
    assert.match(messages, /import of node:fs is not allowed/);
    assert.match(messages, /Date\.now/);
    assert.match(messages, /host global: document/);
    assert.match(messages, /vendor\/infrastructure name: kugou/);
    assert.match(messages, /contracts\/src\/bad\.ts: import of @claudio\/playback-core is not allowed/);
    assert.match(messages, /contracts\/src\/bad\.ts: host date parsing Date\.parse/);
    assert.match(messages, /lib must be set explicitly and exclude DOM/);
    assert.match(messages, /types must be \[\]/);
    assert.match(messages, /dependencies may not include express/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("comments and string contents do not count as code", () => {
  const code = stripComments('// import x from "react"\n/* Date.now() */\nconst path = "/api/v1/now";\nimport y from "./y.js";\n');
  assert.deepEqual(importSpecifiers(code), ["./y.js"]);
  assert.doesNotMatch(code, /Date\.now/);
  assert.match(code, /\/api\/v1\/now/);
});
