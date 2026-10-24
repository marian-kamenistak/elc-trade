import { describe, expect, it } from "vitest";
import { signData, verifyData } from "../src/trust/sign";

// Why: one throwaway Ed25519 pair per run; the real private key never appears in tests.
async function makeKey() {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
	const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
	return { priv, pub };
}

const data = { figures: [{ value: 42, n: 120, as_of: "2026-10-23" }], title: "Leaders", nested: { b: 1, a: [1, 2] } };

describe("signData / verifyData", () => {
	it("signs then verifies", async () => {
		const { priv, pub } = await makeKey();
		const sig = await signData({ SIGNING_PRIVATE_JWK: JSON.stringify(priv), SIGNING_KID: "k1" }, data);
		expect(sig).toMatchObject({ kid: "k1", signed: "data", jwks_url: "https://www.engineeringleaders.io/.well-known/jwks.json" });
		expect(await verifyData(pub, data, sig!.jws)).toBe(true);
	});

	it("emits a detached RFC 7797 JWS with the expected protected header", async () => {
		const { priv } = await makeKey();
		const sig = await signData({ SIGNING_PRIVATE_JWK: JSON.stringify(priv), SIGNING_KID: "k1" }, data);
		const [h, payload, s] = sig!.jws.split(".");
		expect(payload).toBe("");
		expect(s.length).toBeGreaterThan(0);
		expect(JSON.parse(atob(h.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({ alg: "EdDSA", kid: "k1", b64: false, crit: ["b64"] });
	});

	it("still verifies after keys are re-ordered and re-serialised (MCP vs A2A)", async () => {
		const { priv, pub } = await makeKey();
		const sig = await signData({ SIGNING_PRIVATE_JWK: JSON.stringify(priv), SIGNING_KID: "k1" }, data);
		const reordered = JSON.parse('{"nested":{"a":[1,2],"b":1},"title":"Leaders","figures":[{"as_of":"2026-10-23","n":120,"value":42}]}');
		expect(await verifyData(pub, reordered, sig!.jws)).toBe(true);
		expect(await verifyData(pub, JSON.parse(JSON.stringify(data, null, 4)), sig!.jws)).toBe(true);
	});

	it("fails when one figure's n changes", async () => {
		const { priv, pub } = await makeKey();
		const sig = await signData({ SIGNING_PRIVATE_JWK: JSON.stringify(priv), SIGNING_KID: "k1" }, data);
		const tampered = { ...data, figures: [{ value: 42, n: 121, as_of: "2026-10-23" }] };
		expect(await verifyData(pub, tampered, sig!.jws)).toBe(false);
	});

	it("fails with a different key", async () => {
		const a = await makeKey();
		const b = await makeKey();
		const sig = await signData({ SIGNING_PRIVATE_JWK: JSON.stringify(a.priv), SIGNING_KID: "k1" }, data);
		expect(await verifyData(b.pub, data, sig!.jws)).toBe(false);
	});

	it("returns false (never throws) for malformed JWS input", async () => {
		const { pub } = await makeKey();
		expect(await verifyData(pub, data, "not-a-jws")).toBe(false);
		expect(await verifyData(pub, data, "a.b.c")).toBe(false);
		expect(await verifyData(pub, data, "")).toBe(false);
	});

	it("rejects a JWS whose protected header lacks b64:false / crit", async () => {
		const { priv, pub } = await makeKey();
		const key = await crypto.subtle.importKey("jwk", priv, { name: "Ed25519" }, false, ["sign"]);
		const header = btoa(JSON.stringify({ alg: "EdDSA", kid: "k1" })).replace(/=+$/, "");
		const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(`${header}.{}`)));
		const b64 = btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		expect(await verifyData(pub, {}, `${header}..${b64}`)).toBe(false);
	});
});

// verify-response.mjs is the standalone checker third parties run; keep it honest against the Worker's signer.
describe("scripts/verify-response.mjs", () => {
	it("agrees with the Worker's canonicalize and signer, and rejects tampering", async () => {
		const { canonicalize } = await import("../src/trust/jcs");
		// @ts-expect-error plain .mjs script, no types
		const script = await import("../scripts/verify-response.mjs");
		expect(script.canonicalize(data)).toBe(canonicalize(data));

		const { priv, pub } = await makeKey();
		const signature = await signData({ SIGNING_PRIVATE_JWK: JSON.stringify(priv), SIGNING_KID: "k1" }, data);
		const jwks = { keys: [{ ...pub, kid: "k1", alg: "EdDSA", use: "sig" }] };
		expect(await script.verifyResult({ data, signature }, jwks)).toEqual({ ok: true });
		const bad = await script.verifyResult({ data: { ...data, title: "x" }, signature }, jwks);
		expect(bad.ok).toBe(false);
		expect((await script.verifyResult({ data }, jwks)).ok).toBe(false);
		expect((await script.verifyResult({ data, signature: { ...signature, kid: "zz" } }, jwks)).reason).toMatch(/not found/);
	});

	it("CLI prints valid/INVALID with exit code 0/1", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { spawnSync } = await import("node:child_process");
		const dir = mkdtempSync(`${tmpdir()}/sign-`);
		const { priv, pub } = await makeKey();
		const signature = await signData({ SIGNING_PRIVATE_JWK: JSON.stringify(priv), SIGNING_KID: "k1" }, data);
		writeFileSync(`${dir}/jwks.json`, JSON.stringify({ keys: [{ ...pub, kid: "k1" }] }));
		writeFileSync(`${dir}/ok.json`, JSON.stringify({ data, signature }));
		writeFileSync(`${dir}/bad.json`, JSON.stringify({ data: { ...data, title: "x" }, signature }));
		const run = (f: string) => spawnSync("node", ["scripts/verify-response.mjs", `${dir}/${f}`, "--jwks", `${dir}/jwks.json`], { encoding: "utf8" });
		const ok = run("ok.json");
		expect([ok.status, ok.stdout.trim()]).toEqual([0, "signature: valid"]);
		const bad = run("bad.json");
		expect(bad.status).toBe(1);
		expect(bad.stdout).toMatch(/^signature: INVALID \(/);
	});
});
