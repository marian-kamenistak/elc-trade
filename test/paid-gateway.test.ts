import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";

// Why a local JWKS: the real one is Cloudflare's, and the gateway is closed beta. These tests pin
// the origin's contract (verify first, settle only on success); the real edge is the go-live check
// in MONETIZATION-GATEWAY.md.
import { GATEWAY_JWKS_URL, PRICE_ATOMIC, verifyGatewayPayment } from "../src/paid-gateway";
import { DATA_URL, handleDataRequest } from "../src/data-http";
import { dispatch } from "../src/core/dispatch";
import { writeSnapshot } from "../src/data/snapshot-store";
import { verifyData } from "../src/trust/sign";
import type { Figure, MethodId, SnapshotBody } from "../src/data/types";

const today = new Date().toISOString().slice(0, 10);
const AUD_LC = "https://www.engineeringleaders.io/mcp/trade/data/leader-composition";
const AUD_MB = "https://www.engineeringleaders.io/mcp/trade/data/meetup-benchmarks";

function memoryBucket() {
	const objects = new Map<string, string>();
	return {
		async get(key: string) {
			const text = objects.get(key);
			return text === undefined ? null : { text: async () => text };
		},
		async put(key: string, value: string) {
			objects.set(key, value);
			return {};
		},
	} as unknown as R2Bucket;
}

const fig = (value: number, n: number, denominator: number, method_id: MethodId): Figure => ({ value, n, denominator, coverage_pct: 60, as_of: today, method_id });

const composition: SnapshotBody = {
	method_id: "leader_composition",
	as_of: today,
	method_url: "https://www.engineeringleaders.io/agents/methods/leader_composition/",
	preview: { titled: fig(2400, 2400, 4000, "leader_composition") },
	full: {
		titled: 2400,
		tables: {
			seniority_x_employer_country: {
				dimensions: ["seniority", "employer_country"],
				table_withheld: false,
				cells: [{ key: { seniority: "manager", employer_country: "CZ" }, n: 600 }],
				marginals: { seniority: [{ value: "manager", n: 900 }], employer_country: [{ value: "CZ", n: 1500 }] },
			},
		},
	},
};

const benchmarks: SnapshotBody = {
	method_id: "meetup_benchmarks",
	as_of: today,
	method_url: "https://www.engineeringleaders.io/agents/methods/meetup_benchmarks/",
	preview: { events: fig(40, 40, 40, "meetup_benchmarks") },
	full: { events: [{ date: "2026-09-01", applied: 200, approved: 140, checkedIn: 110 }] },
};

// The gateway's key, and an impostor's.
const gw = await generateKeyPair("EdDSA", { crv: "Ed25519" });
const other = await generateKeyPair("EdDSA", { crv: "Ed25519" });
const jwks: JWTVerifyGetKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(gw.publicKey)), kid: "gw1", alg: "EdDSA" }] });

async function token(
	claims: Record<string, unknown> = {},
	opts: { aud?: string; key?: CryptoKey; exp?: number | string; jti?: string | null; alg?: string; kid?: string; iat?: number } = {},
) {
	const t = new SignJWT({ scheme: "upto", amount: "500000", ...claims })
		.setProtectedHeader({ alg: opts.alg ?? "EdDSA", kid: opts.kid ?? "gw1" })
		.setAudience(opts.aud ?? AUD_LC)
		.setIssuedAt(opts.iat)
		.setExpirationTime(opts.exp ?? "5m");
	if (opts.jti !== null) t.setJti(opts.jti ?? "jti-1");
	return t.sign(opts.key ?? gw.privateKey);
}

const req = (url: string, jwt?: string, method = "GET") => new Request(url, { method, headers: jwt ? { "PAYMENT-CONTEXT": jwt } : {} });

const check = (r: Request, aud = AUD_LC) => verifyGatewayPayment(r, { jwks }, { aud, minAtomic: PRICE_ATOMIC.leader_composition });

describe("constants", () => {
	it("pin Cloudflare's JWKS and $0.50 in atomic units", () => {
		expect(GATEWAY_JWKS_URL).toBe("https://payments.cloudflare.com/certs");
		expect(PRICE_ATOMIC).toEqual({ leader_composition: 500000n, meetup_benchmarks: 500000n });
		expect(DATA_URL.leader_composition).toBe(AUD_LC);
	});
});

describe("verifyGatewayPayment", () => {
	it("missing header → missing", async () => {
		expect(await check(req(AUD_LC))).toEqual({ ok: false, reason: "missing" });
	});
	it("a token signed by a different key → invalid", async () => {
		expect(await check(req(AUD_LC, await token({}, { key: other.privateKey })))).toEqual({ ok: false, reason: "invalid" });
	});
	it("garbage in the header → invalid, never a throw", async () => {
		expect(await check(req(AUD_LC, "not.a.jwt"))).toEqual({ ok: false, reason: "invalid" });
	});
	it("the right key but the other product's aud → wrong_aud", async () => {
		expect(await check(req(AUD_LC, await token({}, { aud: AUD_MB })))).toEqual({ ok: false, reason: "wrong_aud" });
	});
	it("an expired exp → invalid", async () => {
		expect(await check(req(AUD_LC, await token({}, { exp: Math.floor(Date.now() / 1000) - 120 })))).toEqual({ ok: false, reason: "invalid" });
	});
	it("scheme exact → wrong_scheme", async () => {
		expect(await check(req(AUD_LC, await token({ scheme: "exact" })))).toEqual({ ok: false, reason: "wrong_scheme" });
	});
	it("amount 499999 → underpaid", async () => {
		expect(await check(req(AUD_LC, await token({ amount: "499999" })))).toEqual({ ok: false, reason: "underpaid" });
	});
	it("amount '1e6' or a number → underpaid, not a crash", async () => {
		expect(await check(req(AUD_LC, await token({ amount: "1e6" })))).toEqual({ ok: false, reason: "underpaid" });
		expect(await check(req(AUD_LC, await token({ amount: 1000000 })))).toEqual({ ok: false, reason: "underpaid" });
	});
	it("a valid upto authorisation of 500000 → ok", async () => {
		const r = await check(req(AUD_LC, await token()));
		expect(r).toMatchObject({ ok: true, scheme: "upto", authorizedAtomic: 500000n, paymentId: "jti:jti-1" });
	});
	it("R33: an alg 'Ed25519' token verifies against a key with no alg tag", async () => {
		const k = await generateKeyPair("Ed25519");
		const bare = createLocalJWKSet({ keys: [{ ...(await exportJWK(k.publicKey)), kid: "gw2" }] });
		const jwt = await token({}, { alg: "Ed25519", kid: "gw2", key: k.privateKey });
		const r = await verifyGatewayPayment(req(AUD_LC, jwt), { jwks: bare }, { aud: AUD_LC, minAtomic: 500000n });
		expect(r).toMatchObject({ ok: true, authorizedAtomic: 500000n });
	});
	it("R33: iat 5 min in the future → invalid", async () => {
		const now = Math.floor(Date.now() / 1000);
		expect(await check(req(AUD_LC, await token({}, { iat: now + 300, exp: now + 900 })))).toEqual({ ok: false, reason: "invalid" });
	});
	it("R33: iat 11 min old → invalid, even with exp still ahead", async () => {
		const now = Math.floor(Date.now() / 1000);
		expect(await check(req(AUD_LC, await token({}, { iat: now - 660, exp: now + 300 })))).toEqual({ ok: false, reason: "invalid" });
	});
	it("no jti → the payment id is the token's hash", async () => {
		const jwt = await token({}, { jti: null });
		const r = await check(req(AUD_LC, jwt));
		expect(r.ok && r.paymentId).toMatch(/^token:[0-9a-f]{64}$/);
	});
});

async function setup(opts: { gateway?: string; withheldLifted?: boolean; snapshots?: boolean; rateOk?: boolean } = {}) {
	const bucket = memoryBucket();
	if (opts.snapshots !== false) {
		await writeSnapshot(bucket, composition);
		await writeSnapshot(bucket, benchmarks);
	}
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
	const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
	const limit = vi.fn(async (_: { key: string }) => ({ success: opts.rateOk !== false }));
	const lifted = opts.withheldLifted !== false;
	const env = {
		PAYMENT_GATEWAY_ENABLED: opts.gateway ?? "1",
		// The products are withheld until G1; these two lift it locally, exactly as on the MCP door.
		PAID_ROUTE_ENABLED: lifted ? "1" : "0",
		DATA_PRODUCTS_PREVIEW: lifted ? "1" : "0",
		SNAPSHOTS: bucket,
		PAID_RATE: { limit },
		SIGNING_PRIVATE_JWK: JSON.stringify(priv),
		SIGNING_KID: "k1",
	};
	return { env, pub, limit };
}

const call = (env: Awaited<ReturnType<typeof setup>>["env"], r: Request) => handleDataRequest(r, env, { jwks });

describe("handleDataRequest", () => {
	it("with PAYMENT_GATEWAY_ENABLED '0' → 404, even with a valid token", async () => {
		const { env } = await setup({ gateway: "0" });
		const res = await call(env, req(AUD_LC, await token()));
		expect(res.status).toBe(404);
		expect(res.headers.get("PAYMENT-SETTLEMENT")).toBeNull();
	});

	it("a withheld product → 404 with the withheld notice, never data, never a settlement", async () => {
		const { env } = await setup({ withheldLifted: false });
		const res = await call(env, req(AUD_LC, await token()));
		expect(res.status).toBe(404);
		expect(res.headers.get("PAYMENT-SETTLEMENT")).toBeNull();
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.data).toEqual({ withheld: true, service: "get_leader_composition" });
		expect(JSON.stringify(body)).not.toContain("seniority_x_employer_country");
	});

	it("an invalid token → 402 with the preview and the reason, no settlement", async () => {
		const { env } = await setup();
		const res = await call(env, req(AUD_LC, await token({}, { key: other.privateKey })));
		expect(res.status).toBe(402);
		expect(res.headers.get("PAYMENT-SETTLEMENT")).toBeNull();
		const body = (await res.json()) as { reason: string; how_to_pay: string; data: Record<string, unknown> };
		expect(body.reason).toBe("invalid");
		expect(body.how_to_pay).toBe("x402 via Cloudflare Monetization Gateway");
		expect(body.data.figures).toBeTruthy();
		expect(body.data.full).toBeUndefined();
	});

	it("no header at all → 402 missing", async () => {
		const { env } = await setup();
		const res = await call(env, req(AUD_LC));
		expect(res.status).toBe(402);
		expect(((await res.json()) as { reason: string }).reason).toBe("missing");
	});

	it("a valid token and no snapshot → 200, not computed yet, settlement 0 (Review Focus 3)", async () => {
		const { env } = await setup({ snapshots: false });
		const res = await call(env, req(AUD_LC, await token()));
		expect(res.status).toBe(200);
		expect(res.headers.get("PAYMENT-SETTLEMENT")).toBe('{"amount":"0"}');
		expect(((await res.json()) as { verdict: string }).verdict).toBe("Not computed yet");
	});

	it("a valid token and a snapshot → 200, the full signed answer, settlement 500000, no PAYMENT-RESPONSE", async () => {
		const { env, pub } = await setup();
		const res = await call(env, req(AUD_LC, await token()));
		expect(res.status).toBe(200);
		expect(res.headers.get("PAYMENT-SETTLEMENT")).toBe('{"amount":"500000"}');
		expect(res.headers.get("PAYMENT-RESPONSE")).toBeNull();
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = (await res.json()) as { data: Record<string, unknown>; signature: { jws: string; kid: string } };
		expect(body.data.full).toEqual(composition.full);
		expect(body.data.license_id).toMatch(/^[0-9a-f]{16}$/);
		expect(await verifyData(pub, body.data, body.signature.jws)).toBe(true);
		// The checker third parties run must verify this door's body as-is.
		const script = await import("../scripts/verify-response.mjs");
		expect(await script.verifyResult(body, { keys: [{ ...pub, kid: "k1" }] })).toEqual({ ok: true });
	});

	it("license_id is stable for one jti and differs for another", async () => {
		const { env } = await setup();
		const lic = async (jti: string) => (((await (await call(env, req(AUD_LC, await token({}, { jti })))).json()) as { data: { license_id: string } }).data.license_id);
		expect(await lic("a")).toBe(await lic("a"));
		expect(await lic("a")).not.toBe(await lic("b"));
	});

	it("meetup benchmarks serves the per-event rows", async () => {
		const { env } = await setup();
		const res = await call(env, req(AUD_MB, await token({}, { aud: AUD_MB })));
		expect(res.status).toBe(200);
		expect(((await res.json()) as { data: { full: unknown } }).data.full).toEqual({ events: benchmarks.full.events });
	});

	it("a query string on www still checks against the canonical aud", async () => {
		const { env } = await setup();
		const res = await call(env, req(`${AUD_LC}?x=1`, await token()));
		expect(res.status).toBe(200);
	});

	it("the apex host with a valid token → 308 to the identical www URL, no data, no settlement, token never read", async () => {
		const { env, limit } = await setup();
		const r = req("https://engineeringleaders.io/mcp/trade/data/leader-composition?x=1&y=2", await token());
		const read = vi.spyOn(r.headers, "get");
		const res = await call(env, r);
		expect(res.status).toBe(308);
		expect(res.headers.get("location")).toBe(`${AUD_LC}?x=1&y=2`);
		expect(res.headers.get("PAYMENT-SETTLEMENT")).toBeNull();
		expect(await res.text()).toBe("");
		expect(read).not.toHaveBeenCalled();
		expect(limit).not.toHaveBeenCalled();
	});

	it("www on a non-default port → 308 to the canonical URL without the port, token never read", async () => {
		const { env, limit } = await setup();
		const r = req("https://www.engineeringleaders.io:8443/mcp/trade/data/leader-composition?x=1", await token());
		const read = vi.spyOn(r.headers, "get");
		const res = await call(env, r);
		expect(res.status).toBe(308);
		expect(res.headers.get("location")).toBe(`${AUD_LC}?x=1`);
		expect(read).not.toHaveBeenCalled();
		expect(limit).not.toHaveBeenCalled();
	});

	it("a trailing slash or an unknown slug → 404, so each product has exactly one URL", async () => {
		const { env } = await setup();
		for (const url of [`${AUD_LC}/`, "https://www.engineeringleaders.io/mcp/trade/data/constructor"]) {
			const res = await call(env, req(url, await token()));
			expect(res.status).toBe(404);
			expect(res.headers.get("PAYMENT-SETTLEMENT")).toBeNull();
		}
	});

	it("a non-GET → 405 and no settlement", async () => {
		const { env } = await setup();
		const res = await call(env, req(AUD_LC, await token(), "POST"));
		expect(res.status).toBe(405);
		expect(res.headers.get("PAYMENT-SETTLEMENT")).toBeNull();
	});

	it("rate-limits by the payment id, and a throttled call gets 429 with no settlement", async () => {
		const { env, limit } = await setup({ rateOk: false });
		const res = await call(env, req(AUD_LC, await token({}, { jti: "j9" })));
		expect(res.status).toBe(429);
		expect(res.headers.get("PAYMENT-SETTLEMENT")).toBeNull();
		expect(limit).toHaveBeenCalledWith({ key: "gateway:jti:j9" });
	});
});

describe("buy_url on the MCP door", () => {
	const pay = async () => ({ kind: "preview" as const, reason: "payment_required" as const });
	it("appears on the MCP preview only in gateway mode", async () => {
		const on = await setup({ gateway: "1" });
		const r1 = await dispatch("get_leader_composition", {}, { env: on.env as never, transport: "mcp", pay });
		expect(r1.data?.buy_url).toBe(AUD_LC);
		const off = await setup({ gateway: "0" });
		const r0 = await dispatch("get_leader_composition", {}, { env: off.env as never, transport: "mcp", pay });
		expect(r0.data?.buy_url).toBeUndefined();
	});
});

describe("wrangler.jsonc", () => {
	it("ships the gateway door off", () => {
		expect(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")).toMatch(/"PAYMENT_GATEWAY_ENABLED":\s*"0"/);
	});
});
