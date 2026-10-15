import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(serverDir);

function sourceFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function imports(file) {
  const text = fs.readFileSync(file, "utf8");
  return [...text.matchAll(/(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] ?? match[2]);
}

test("use cases and ports depend only on contracts, node built-ins and each other", () => {
  const inner = [path.join(serverDir, "application"), path.join(serverDir, "ports")];
  const violations = [];
  for (const file of inner.flatMap(sourceFiles)) {
    for (const specifier of imports(file)) {
      if (specifier === "@claudio/contracts" || specifier === "node:crypto") continue;
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(file), specifier);
        if (inner.some((dir) => target.startsWith(dir + path.sep))) continue;
      }
      violations.push(`${path.relative(serverDir, file)} → ${specifier}`);
    }
  }
  assert.deepEqual(violations, [], "no Express, SQLite, HTTP clients, adapters or legacy modules in the application layer");
});

test("use cases never branch on a provider's name", () => {
  const offenders = [path.join(serverDir, "application"), path.join(serverDir, "ports")]
    .flatMap(sourceFiles)
    .filter((file) => /["'`](kugou|local|fish|kugou-api)["'`]/i.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(serverDir, file));
  assert.deepEqual(offenders, []);
});

test("importing the app factory or the composition module has no side effects", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-import-probe-"));
  try {
    const dataDir = path.join(work, "data");
    const script = path.join(work, "probe.mjs");
    fs.writeFileSync(
      script,
      `await import(${JSON.stringify(path.join(serverDir, "http/app.ts"))});\n` +
        `await import(${JSON.stringify(path.join(serverDir, "composition.ts"))});\n` +
        `await import(${JSON.stringify(path.join(serverDir, "playback-assembly.ts"))});\n` +
        `console.log("imported");\n`
    );
    const result = spawnSync(
      process.execPath,
      ["--import", path.join(repoRoot, "node_modules/tsx/dist/esm/index.mjs"), "--import", path.join(serverDir, "testing/register-workspace.mjs"), script],
      { cwd: work, env: { PATH: process.env.PATH, DATA_DIR: dataDir, HOME: work }, encoding: "utf8", timeout: 60_000 }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "imported", "the process exits: nothing is listening");
    assert.equal(fs.existsSync(dataDir), false, "no database or data directory was created");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
