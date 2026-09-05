#!/usr/bin/env node
/**
 * Persona-test harness. Bundles src/harness-entry.ts with esbuild and runs it, so testers
 * exercise the real dispatch() and the real service registry rather than a stand-in.
 *
 *   node scripts/tool.mjs list
 *   node scripts/tool.mjs <tool_name> '<json args>'
 *
 * Safe by construction: no Slack token in the harness env, so the deal notifier no-ops, and
 * nothing in the live tool surface mutates anything.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(tmpdir(), "elc-trade-harness.mjs");

if (!existsSync(CACHE) || process.env.HARNESS_REBUILD) {
  execFileSync("npx", ["esbuild", "src/harness-entry.ts", "--bundle", "--platform=node",
    "--format=esm", `--outfile=${CACHE}`, "--log-level=warning"],
    { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
}

try {
  execFileSync("node", [CACHE, ...process.argv.slice(2)], { cwd: ROOT, stdio: "inherit" });
} catch (e) {
  process.exit(e.status ?? 1);
}
