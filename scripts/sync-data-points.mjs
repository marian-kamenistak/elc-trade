#!/usr/bin/env node
/**
 * Vendors the CITABLE slice of elc-web's Data Points registry into this Worker.
 *
 * Why a slice and not a copy: this repo is public, and the registry's `source` and `note` fields
 * carry member names, CRM and calendar ids and private offer prices. Only ids listed in
 * src/data/citable-ids.json are written, and only {label, value, display, verified, source_url}.
 * `source` and `note` never leave elc-web. `source_url` appears only when a row's `source` is
 * itself a bare https:// URL.
 *
 * Run:  npm run data-points              (writes)
 *       npm run data-points -- --check   (fails on drift, or if an allowlisted id vanished from
 *                                         the registry; wired into deploy like card:check)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "../../web/elc-web/src/data/data-points.generated.json");
const ALLOWLIST = join(ROOT, "src/data/citable-ids.json");
const TARGET = join(ROOT, "src/data/data-points.json");

const fail = (msg) => {
	console.error(msg);
	process.exit(1);
};

if (!existsSync(SOURCE)) fail(`Missing source: ${SOURCE}`);
const registry = JSON.parse(readFileSync(SOURCE, "utf8"));
const ids = JSON.parse(readFileSync(ALLOWLIST, "utf8"));

if (!Array.isArray(ids) || ids.some((i, n) => typeof i !== "string" || (n > 0 && ids[n - 1] >= i))) {
	fail(`${ALLOWLIST} must be a sorted array of unique id strings.`);
}

const rows = {};
const missing = [];
for (const id of ids) {
	const dot = id.indexOf(".");
	const row = registry.streams?.[id.slice(0, dot)]?.data_points?.[id.slice(dot + 1)];
	if (!row) {
		missing.push(id);
		continue;
	}
	const out = { label: row.label, value: row.value, display: row.display ?? null, verified: row.verified };
	if (typeof row.source === "string" && /^https:\/\/\S+$/.test(row.source)) out.source_url = row.source;
	rows[id] = out;
}
if (missing.length) fail(`Allowlisted ids missing from the registry:\n  ${missing.join("\n  ")}`);

const next = `${JSON.stringify({ rows }, null, "\t")}\n`;
const current = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : null;

if (process.argv.includes("--check")) {
	if (current !== next) fail(`Stale: ${TARGET}\nRun \`npm run data-points\` in mcp/elc-trade and commit the result.`);
	console.log(`data-points.json up to date (${ids.length} citable rows)`);
	process.exit(0);
}

if (current !== next) writeFileSync(TARGET, next);
console.log(current === next ? `unchanged: ${TARGET}` : `wrote: ${TARGET} (${ids.length} citable rows)`);
