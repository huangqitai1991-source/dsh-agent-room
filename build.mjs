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
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

const bundleText = await readFile(join(clientBuildDir, "client/index.js"), "utf8");
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

// ---- skills ----
await cp(join(root, "src/skills"), join(outDir, "skills"), { recursive: true });

console.log("built lib/host/*, lib/client.js, lib/skills/");
