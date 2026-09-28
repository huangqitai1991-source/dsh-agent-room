/**
 * Build script for dsh-agent-room (no native spawns; works under file sandboxes).
 *
 * - Host: compile src/host/index.ts (and its import graph) to ESM under lib/,
 *   using the TypeScript compiler API in-process.
 * - Client: compile src/client/index.tsx to CommonJS (react stays external),
 *   then wrap the output in the browser ModuleLoader factory shape
 *   (window.__ModuleLoader__.load), matching the dsh-univer-office artifact.
 * - Skills: copy src/skills -> lib/skills (the skill provider reads
 *   ../skills/<name>/SKILL.md relative to lib/host/skills.js).
 */

import ts from "typescript";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "lib");

function compile(entry, options) {
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2023,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    skipLibCheck: true,
    strict: true,
    isolatedModules: true,
    ...options,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    console.error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }));
    throw new Error(`compile failed: ${errors.length} error(s)`);
  }
  const emitResult = program.emit();
  const emitErrors = emitResult.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (emitErrors.length > 0) {
    console.error(ts.formatDiagnosticsWithColorAndContext(emitErrors, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }));
    throw new Error(`emit failed: ${emitErrors.length} error(s)`);
  }
}

await mkdir(outDir, { recursive: true });

// ---- host (ESM) ----
compile(join(root, "src/host/index.ts"), {
  module: ts.ModuleKind.ESNext,
  outDir: outDir,
  rootDir: join(root, "src"),
});

// ---- client (CommonJS, react external) ----
const clientBuildDir = join(outDir, "client-build");
await mkdir(clientBuildDir, { recursive: true });
compile(join(root, "src/client/index.tsx"), {
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  jsx: ts.JsxEmit.React,
  outDir: clientBuildDir,
  rootDir: join(root, "src"),
});

// Inline every emitted client module into one factory body: the browser
// ModuleLoader's synchronous require only resolves registered bundle ids /
// seed modules (react), so relative requires would fail at runtime. We assign
// each module a key (path relative to src/client, no extension) and provide a
// tiny local require that resolves relative specifiers against that registry
// while passing bare specifiers ("react") through to the loader's require.
const clientOutRoot = join(clientBuildDir, "client");
const emittedFiles = [];
async function walkClient(dir) {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const info = await statPath(full);
    if (info.isDirectory()) await walkClient(full);
    else if (entry.endsWith(".js")) emittedFiles.push(full);
  }
}
await walkClient(clientOutRoot);
const moduleFactories = [];
for (const file of emittedFiles.sort()) {
  const relative = relativePath(clientOutRoot, file).replace(/\\/g, "/").replace(/\.js$/, "");
  const source = await readFile(file, "utf8");
  moduleFactories.push({ key: relative, source });
}
const entryFactory = moduleFactories.find((m) => m.key === "index");
const rest = moduleFactories.filter((m) => m.key !== "index");
const orderedFactories = entryFactory ? [entryFactory, ...rest] : moduleFactories;
const bundleLines = [
  "var __arModules = {};",
  "function __arResolve(from, spec) {",
  "  var parts = from.split('/'); parts.pop();",
  "  for (var i = 0; i < spec.split('/').length; i++) {",
  "    var seg = spec.split('/')[i];",
  "    if (seg === '.' || seg === '') continue;",
  "    if (seg === '..') parts.pop(); else parts.push(seg);",
  "  }",
  "  var key = parts.join('/');",
  "  key = key.replace(/\.(js|ts|tsx)$/, '');",
  "  return key;",
  "}",
  "function __arRequire(from, spec) {",
  "  if (spec.charAt(0) !== '.') return require(spec);",
  "  var key = __arResolve(from, spec);",
  "  var mod = __arModules[key];",
  "  if (!mod) throw new Error('dsh-agent-room: cannot resolve ' + spec + ' from ' + from);",
  "  if (!mod.loaded) {",
  "    mod.loaded = true; mod.exports = {};",
  "    mod.factory(function (s) { return __arRequire(key, s); }, mod.exports, mod);",
  "  }",
  "  return mod.exports;",
  "}",
];
for (const m of orderedFactories) {
  bundleLines.push("__arModules[" + JSON.stringify(m.key) + "] = { loaded: false, exports: {}, factory: function (require, exports, module) {");
  bundleLines.push(m.source);
  bundleLines.push("} };");
}
bundleLines.push("module.exports = __arRequire('index', './index');");
const bundleText = bundleLines.join("\n");
// dsh's browser module system calls factory(require) with a single argument;
// `module`/`exports` are NOT in scope. Declare them inside the factory exactly
// like every shipped dsh bundle (see dsh-client-modules' own lib/client.js),
// otherwise materializing this bundle throws "exports is not defined".
const wrapped = `window.__ModuleLoader__.load({
  id: "dsh-agent-room",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
${bundleText}
    return module.exports;
  }
});
`;
await writeFile(join(outDir, "client.js"), wrapped, "utf8");
await rm(clientBuildDir, { recursive: true, force: true });

/** Stat with graceful handling for sandboxed FS quirks (returns null on error). */
async function statPath(p) {
  try {
    return await stat(p);
  } catch {
    return { isDirectory: () => false };
  }
}

/** posix-style relative path from base to target. */
function relativePath(base, target) {
  const b = base.split(/[\\/]/).filter(Boolean);
  const t = target.split(/[\\/]/).filter(Boolean);
  let i = 0;
  while (i < b.length && i < t.length && b[i] === t[i]) i += 1;
  const up = b.length - i;
  const parts = [];
  for (let k = 0; k < up; k += 1) parts.push("..");
  return parts.concat(t.slice(i)).join("/") || ".";
}

// ---- skills ----
await cp(join(root, "src/skills"), join(outDir, "skills"), { recursive: true });

console.log("built lib/host/*, lib/client.js, lib/skills/");
