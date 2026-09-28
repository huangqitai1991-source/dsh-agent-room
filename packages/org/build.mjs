/**
 * dsh-agent-org build script.
 *
 * The plugin is written as plain ESM/CommonJS-friendly source so DSH can load
 * it directly from src/. This script still emits the conventional lib/ layout
 * used by DSH bundles (lib/host/*.js and lib/client.js) for packagers that
 * prefer compiled output.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const lib = join(root, "lib");

await rm(lib, { recursive: true, force: true });
await mkdir(join(lib, "host"), { recursive: true });
await mkdir(join(lib, "tools"), { recursive: true });

// Host and tools are already ESM; copy them verbatim.
await cp(join(root, "src/host"), join(lib, "host"), { recursive: true });
await cp(join(root, "src/tools"), join(lib, "tools"), { recursive: true });
await cp(join(root, "src/types.js"), join(lib, "types.js"));

// The client file is already in the final ModuleLoader shape.
await cp(join(root, "src/client.js"), join(lib, "client.js"));

console.log("built lib/host/*, lib/tools/*, lib/client.js");
