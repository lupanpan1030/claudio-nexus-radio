#!/usr/bin/env node
// Enforces the dependency direction of the workspace packages:
//   packages/contracts      → nothing (pure data + decoders)
//   packages/playback-core  → @claudio/contracts only
// Both must stay free of DOM/Node/network/vendor knowledge and of ambient clocks.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_RULES = [
  { name: "@claudio/contracts", dir: "packages/contracts", allowedPackages: [] },
  { name: "@claudio/playback-core", dir: "packages/playback-core", allowedPackages: ["@claudio/contracts"] }
];

const FORBIDDEN_TOKENS = [
  [/\bDate\s*\.\s*now\b/, "ambient clock Date.now (inject `now`)"],
  [/\bnew\s+Date\b/, "ambient clock new Date (inject `now`)"],
  // Host parsing normalises impossible dates (Feb 30 → Mar 2); contracts parse ISO themselves.
  [/\bDate\s*\.\s*parse\b/, "host date parsing Date.parse (use parseIsoTimestamp)"],
  [/\bMath\s*\.\s*random\b/, "ambient randomness (inject an id factory)"],
  [/\bperformance\b/, "host timing API"],
  [/\b(setTimeout|setInterval|queueMicrotask|requestAnimationFrame)\b/, "host scheduling"],
  [/\bfetch\s*\(/, "network access"],
  [/\b(window|document|navigator|localStorage|sessionStorage|globalThis|self)\b/, "host global"],
  [/\b(HTMLMediaElement|HTMLAudioElement|AudioContext|MediaSource|Audio)\b/, "DOM media API"],
  [/\b(process|Buffer|require|__dirname)\b/, "Node global"],
  [/\bconsole\b/, "logging side effect"],
  [/\b(kugou|netease|qqmusic|spotify|fish|sqlite|express)\b/i, "vendor/infrastructure name"]
];

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g
];

/** Removes comments while keeping string contents (good enough for TS sources). */
export function stripComments(source) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const block = source.slice(i, end < 0 ? source.length : end + 2);
      out += block.replace(/[^\n]/g, " ");
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    out += ch;
    i += 1;
  }
  return out;
}

/** Removes string literal contents so token checks only see code. */
function blankStrings(code) {
  return code.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, (match) => match[0] + " ".repeat(match.length - 2) + match[0]);
}

export function importSpecifiers(code) {
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of code.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

async function listSources(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listSources(full)));
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

function lineOf(code, index) {
  return code.slice(0, index).split("\n").length;
}

export async function checkBoundaries(rootDir) {
  const violations = [];
  const report = (file, line, message) => violations.push({ file: path.relative(rootDir, file), line, message });

  for (const rule of PACKAGE_RULES) {
    const packageDir = path.join(rootDir, rule.dir);
    const srcDir = path.join(packageDir, "src");

    const manifestPath = path.join(packageDir, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.name !== rule.name) report(manifestPath, 1, `expected package name ${rule.name}`);
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        if (!rule.allowedPackages.includes(dep)) report(manifestPath, 1, `${field} may not include ${dep}`);
      }
    }
    if (!manifest.exports?.["."]) report(manifestPath, 1, "package must declare explicit exports");

    const tsconfigPath = path.join(packageDir, "tsconfig.json");
    const tsconfig = JSON.parse(await readFile(tsconfigPath, "utf8"));
    const lib = (tsconfig.compilerOptions?.lib ?? []).map((entry) => String(entry).toLowerCase());
    if (lib.length === 0 || lib.some((entry) => entry.startsWith("dom") || entry.startsWith("webworker"))) {
      report(tsconfigPath, 1, "lib must be set explicitly and exclude DOM/WebWorker");
    }
    if (!Array.isArray(tsconfig.compilerOptions?.types) || tsconfig.compilerOptions.types.length > 0) {
      report(tsconfigPath, 1, "types must be [] so no ambient host typings (node, dom) leak in");
    }

    for (const file of await listSources(srcDir)) {
      const raw = await readFile(file, "utf8");
      const code = stripComments(raw);
      for (const specifier of importSpecifiers(code)) {
        const at = lineOf(code, code.indexOf(specifier));
        if (specifier.startsWith(".")) {
          const target = path.resolve(path.dirname(file), specifier);
          if (!target.startsWith(srcDir + path.sep)) report(file, at, `relative import escapes ${rule.dir}/src: ${specifier}`);
        } else if (!rule.allowedPackages.includes(specifier)) {
          report(file, at, `import of ${specifier} is not allowed (allowed: ${rule.allowedPackages.join(", ") || "none"})`);
        }
      }
      const codeOnly = blankStrings(code);
      for (const [pattern, label] of FORBIDDEN_TOKENS) {
        const match = pattern.exec(codeOnly);
        if (match) report(file, lineOf(codeOnly, match.index), `${label}: ${match[0]}`);
      }
    }
  }
  return violations;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const violations = await checkBoundaries(root);
  if (violations.length > 0) {
    for (const v of violations) console.error(`${v.file}:${v.line}: ${v.message}`);
    console.error(`package boundary check failed (${violations.length} violation${violations.length === 1 ? "" : "s"})`);
    process.exit(1);
  }
  console.log("package boundaries ok");
}
