import { canonicalize } from "./jcs";
import type { ServiceResult } from "../core/types";

/**
 * Detached JWS (RFC 7797, unencoded payload) over the JCS-canonical bytes of a result's `data`.
 *
 * Why canonical bytes and not the transport string: MCP and A2A serialise the same object
 * with different key order and whitespace; signing the JCS form means either transport's
 * copy verifies. Why detached: the payload already travels as `data`, so the compact JWS
 * carries an empty payload segment instead of repeating it.
 */

const JWKS_URL = "https://www.engineeringleaders.io/.well-known/jwks.json" as const;

const enc = new TextEncoder();

function b64u(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64u(s: string): Uint8Array {
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// RFC 7797 signing input: BASE64URL(header) || "." || payload (raw, unencoded).
function signingInput(protectedB64: string, data: Record<string, unknown>): Uint8Array {
	return enc.encode(`${protectedB64}.${canonicalize(data)}`);
}

// Why two forms: the secret is stored base64url (no quotes or braces, so any ~/.env loader keeps it
// intact; a raw JSON line is mangled by `source`). Raw JSON is still accepted for local .dev.vars.
//
// Why only kty/crv/x(/d): the Workers runtime rejects an Ed25519 JWK carrying `alg: "Ed25519"`
// (and sometimes key_ops/ext) which Node's export emits and accepts. Handing importKey just the
// key material is portable to both; vitest on Node alone would never catch the difference.
function parsePrivateJwk(value: string): JsonWebKey {
	const v = value.trim();
	const { kty, crv, x, d } = JSON.parse(v.startsWith("{") ? v : new TextDecoder().decode(unb64u(v)));
	return { kty, crv, x, d };
}

function publicJwk(jwk: JsonWebKey): JsonWebKey {
	const { kty, crv, x } = jwk;
	return { kty, crv, x };
}

export async function signData(
	env: { SIGNING_PRIVATE_JWK: string; SIGNING_KID: string },
	data: Record<string, unknown>,
): Promise<ServiceResult["signature"]> {
	const key = await crypto.subtle.importKey("jwk", parsePrivateJwk(env.SIGNING_PRIVATE_JWK), { name: "Ed25519" }, false, ["sign"]);
	const header = b64u(enc.encode(JSON.stringify({ alg: "EdDSA", kid: env.SIGNING_KID, b64: false, crit: ["b64"] })));
	const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, signingInput(header, data)));
	return { jws: `${header}..${b64u(sig)}`, kid: env.SIGNING_KID, jwks_url: JWKS_URL, signed: "data" };
}

/** True only for a valid signature over `data`. Malformed input is false, never a throw. */
export async function verifyData(jwk: JsonWebKey, data: Record<string, unknown>, jws: string): Promise<boolean> {
	try {
		const parts = jws.split(".");
		if (parts.length !== 3 || parts[1] !== "") return false;
		const header = JSON.parse(new TextDecoder().decode(unb64u(parts[0])));
		if (header.alg !== "EdDSA" || header.b64 !== false || !Array.isArray(header.crit) || !header.crit.includes("b64")) return false;
		const key = await crypto.subtle.importKey("jwk", publicJwk(jwk), { name: "Ed25519" }, false, ["verify"]);
		return await crypto.subtle.verify({ name: "Ed25519" }, key, unb64u(parts[2]), signingInput(parts[0], data));
	} catch {
		return false;
	}
}
