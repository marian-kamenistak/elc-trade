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
import { existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(tmpdir(), "elc-trade-harness.mjs");

/**
 * Newest mtime anywhere under src/. The cache used to rebuild only when the file was MISSING,
 * which on 2026-09-05 sent eleven persona testers through a bundle built seven minutes before
 * the fixes they were sent to verify — the harness built to catch stale behaviour was itself
 * serving it. Staleness must be impossible here, not merely unlikely.
 */
function newestSourceMtime(dir) {
	let newest = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		newest = Math.max(newest, entry.isDirectory() ? newestSourceMtime(path) : statSync(path).mtimeMs);
	}
	return newest;
}

const stale =
	!existsSync(CACHE) || newestSourceMtime(join(ROOT, "src")) > statSync(CACHE).mtimeMs;

if (stale || process.env.HARNESS_REBUILD) {
  execFileSync("npx", ["esbuild", "src/harness-entry.ts", "--bundle", "--platform=node",
    "--format=esm", `--outfile=${CACHE}`, "--log-level=warning"],
    { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
}

try {
  execFileSync("node", [CACHE, ...process.argv.slice(2)], { cwd: ROOT, stdio: "inherit" });
} catch (e) {
  process.exit(e.status ?? 1);
}
