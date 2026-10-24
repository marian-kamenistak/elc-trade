#!/usr/bin/env node
/**
 * Generates elc-web's /.well-known/jwks.json from the public key in wrangler.jsonc.
 *
 * Same shape as gen-agent-card.mjs: elc-web's assets binding shadows /.well-known/*, so the
 * JWKS is a static file there, generated so it cannot drift from the key the Worker signs with.
 *
 * Run:  npm run jwks                (writes)
 *       npm run jwks -- --check     (fails on drift; wired into `deploy`)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TARGET = join(ROOT, "../../web/elc-web/public/.well-known/jwks.json");
const check = process.argv.includes("--check");

// JSONC -> JSON: drop // and /* */ comments outside strings, then trailing commas.
function parseJsonc(text) {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (c === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2) + 2;
		} else {
			out += c;
			i++;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const vars = parseJsonc(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")).vars ?? {};
if (!vars.SIGNING_PUBLIC_JWK || !vars.SIGNING_KID) {
	console.error("wrangler.jsonc vars must define SIGNING_PUBLIC_JWK and SIGNING_KID");
	process.exit(1);
}
const pub = JSON.parse(vars.SIGNING_PUBLIC_JWK);
if (pub.d !== undefined) {
	console.error("SIGNING_PUBLIC_JWK contains a private component (d); refusing.");
	process.exit(1);
}
if (pub.kty !== "OKP" || pub.crv !== "Ed25519" || !pub.x) {
	console.error("SIGNING_PUBLIC_JWK must be an Ed25519 OKP key with x");
	process.exit(1);
}

const jwks = { keys: [{ kty: pub.kty, crv: pub.crv, x: pub.x, kid: vars.SIGNING_KID, alg: "EdDSA", use: "sig" }] };
const next = `${JSON.stringify(jwks, null, "\t")}\n`;
const current = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : null;

if (check) {
	if (current !== next) {
		console.error(`Stale: ${TARGET}\nRun \`npm run jwks\` in mcp/elc-trade and commit the result.`);
		process.exit(1);
	}
	console.log(`jwks.json up to date (kid ${vars.SIGNING_KID})`);
	process.exit(0);
}

writeFileSync(TARGET, next);
console.log(current === next ? `unchanged: ${TARGET}` : `wrote: ${TARGET} (kid ${vars.SIGNING_KID})`);
