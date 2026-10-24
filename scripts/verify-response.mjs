#!/usr/bin/env node
/**
 * Verifies the signature on an elc-trade answer. Standalone: Node 18+, no dependencies.
 *
 *   node verify-response.mjs response.json                 # fetches the published JWKS
 *   cat response.json | node verify-response.mjs           # from stdin
 *   node verify-response.mjs response.json --jwks jwks.json   # local JWKS file
 *
 * The input is the ServiceResult JSON ({ data, signature: { jws, kid, ... } }). The JWS is a
 * detached RFC 7797 signature over the JCS (RFC 8785) canonical form of `data`, so it holds
 * however the transport reordered or re-spaced the JSON.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_JWKS = "https://www.engineeringleaders.io/.well-known/jwks.json";

// Mirrors src/trust/jcs.ts (a test asserts the two agree).
export function canonicalize(value) {
	if (value === null) return "null";
	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "string":
			return JSON.stringify(value);
		case "number":
			if (!Number.isFinite(value)) throw new TypeError("non-finite number");
			return JSON.stringify(value);
		case "object":
			if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
			return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
		default:
			throw new TypeError(`unsupported ${typeof value}`);
	}
}

const unb64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Returns { ok: true } or { ok: false, reason }. */
export async function verifyResult(result, jwks) {
	const sig = result?.signature;
	if (!sig?.jws || !sig?.kid) return { ok: false, reason: "no signature on this result" };
	if (!result.data || typeof result.data !== "object") return { ok: false, reason: "no data to verify" };
	const jwk = jwks?.keys?.find((k) => k.kid === sig.kid);
	if (!jwk) return { ok: false, reason: `kid ${sig.kid} not found in JWKS` };
	const parts = sig.jws.split(".");
	if (parts.length !== 3 || parts[1] !== "") return { ok: false, reason: "malformed detached JWS" };
	let header;
	try {
		header = JSON.parse(unb64u(parts[0]).toString("utf8"));
	} catch {
		return { ok: false, reason: "unreadable protected header" };
	}
	if (header.alg !== "EdDSA" || header.b64 !== false || !header.crit?.includes("b64")) {
		return { ok: false, reason: "unexpected protected header" };
	}
	if (header.kid !== sig.kid) return { ok: false, reason: "header kid does not match signature.kid" };
	try {
		const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
		const input = new TextEncoder().encode(`${parts[0]}.${canonicalize(result.data)}`);
		const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, unb64u(parts[2]), input);
		return ok ? { ok: true } : { ok: false, reason: "signature does not match data" };
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	}
}

async function main() {
	const args = process.argv.slice(2);
	const ji = args.indexOf("--jwks");
	const jwksSrc = ji >= 0 ? args.splice(ji, 2)[1] : null;
	const file = args[0];
	const raw = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
	try {
		const result = JSON.parse(raw);
		const jwks = jwksSrc ? JSON.parse(readFileSync(jwksSrc, "utf8")) : await (await fetch(DEFAULT_JWKS)).json();
		const r = await verifyResult(result, jwks);
		console.log(r.ok ? "signature: valid" : `signature: INVALID (${r.reason})`);
		process.exit(r.ok ? 0 : 1);
	} catch (e) {
		console.log(`signature: INVALID (${e instanceof Error ? e.message : String(e)})`);
		process.exit(1);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
