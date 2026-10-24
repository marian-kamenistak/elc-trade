import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Why a mock: the real charge talks to the Tempo chain. These tests pin the gate's ORDER and the
// result shapes; the real rail is exercised by the testnet e2e (task 7 step 6).
const h = vi.hoisted(() => ({ created: vi.fn(), configured: vi.fn(), invoked: vi.fn() }));
vi.mock("mppx/server", () => ({
	Mppx: {
		create: (cfg: unknown) => {
			h.created(cfg);
			return {
				charge: (opts: unknown) => {
					h.configured(opts);
					return async (extra: { _meta?: Record<string, unknown> }) => {
						h.invoked(extra);
						if (extra._meta?.["org.paymentauth/credential"]) {
							return {
								status: 200,
								withReceipt: (r: Record<string, unknown>) => ({
									...r,
									_meta: { "org.paymentauth/receipt": { method: "tempo", reference: "0xtxhash", status: "success", timestamp: "2026-10-24T00:00:00Z", challengeId: "ch1" } },
								}),
							};
						}
						return {
							status: 402,
							challenge: { code: -32042, message: "Payment Required", data: { httpStatus: 402, challenges: [{ id: "ch1", method: "tempo", intent: "charge" }] } },
						};
					};
				},
			};
		},
	},
	tempo: { charge: (p: unknown) => ({ name: "tempo", intent: "charge", p }) },
	Transport: { mcpSdk: () => ({ name: "mcp-sdk" }) },
}));

import { dispatch, liveServicesFor } from "../src/core/dispatch";
import { SERVICES } from "../src/core/services";
import { paidDataHandler } from "../src/core/data-services";
import { CREDENTIAL_META, gatePaid, PAYMENT_REQUIRED_META, RECEIPT_META, withPayment, type PaidOutcome } from "../src/paid";
import { Mcp } from "mppx";
import { writeSnapshot } from "../src/data/snapshot-store";
import { sha256Hex } from "../src/trust/jcs";
import type { Figure, MethodId, SnapshotBody } from "../src/data/types";
import { verifyData } from "../src/trust/sign";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Transaction } from "viem/tempo";

const PAID_IDS = ["get_leader_composition", "get_meetup_benchmarks"] as const;
const today = new Date().toISOString().slice(0, 10);

const objectsOf = new WeakMap<object, Map<string, string>>();
function memoryBucket() {
	const objects = new Map<string, string>();
	const bucket = {
		async get(key: string) {
			const text = objects.get(key);
			return text === undefined ? null : { text: async () => text };
		},
		async put(key: string, value: string) {
			objects.set(key, value);
			return {};
		},
	};
	objectsOf.set(bucket, objects);
	return bucket as unknown as R2Bucket;
}

const fig = (value: number, n: number, denominator: number, method_id: MethodId): Figure => ({ value, n, denominator, coverage_pct: 60, as_of: today, method_id });

const composition: SnapshotBody = {
	method_id: "leader_composition",
	as_of: today,
	method_url: "https://www.engineeringleaders.io/agents/methods/leader_composition/",
	preview: { titled: fig(2400, 2400, 4000, "leader_composition") },
	full: {
		titled: 2400,
		titled_coverage_pct: 60,
		tables: {
			seniority_x_employer_country: {
				dimensions: ["seniority", "employer_country"],
				table_withheld: false,
				cells: [{ key: { seniority: "manager", employer_country: "CZ" }, n: 600 }],
				marginals: {
					seniority: [
						{ value: "manager", n: 900 },
						{ value: "vp", n: null },
						{ value: "director_head", n: 600 },
					],
					employer_country: [{ value: "CZ", n: 1500 }],
				},
			},
		},
		conference: { titled: 50, tables: {} },
	},
};

const benchmarks: SnapshotBody = {
	method_id: "meetup_benchmarks",
	as_of: today,
	method_url: "https://www.engineeringleaders.io/agents/methods/meetup_benchmarks/",
	preview: {
		events: fig(40, 40, 40, "meetup_benchmarks"),
		median_applied: fig(180, 40, 40, "meetup_benchmarks"),
		median_checkin_rate: fig(0.62, 30, 40, "meetup_benchmarks"),
	},
	full: { events: [{ date: "2026-09-01", city: "Prague", capacity: 150, approvalRequired: true, applied: 200, approved: 140, waitlist: 20, checkedIn: 110, checkInReliable: true }] },
};

async function makeKey() {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	return { priv: await crypto.subtle.exportKey("jwk", pair.privateKey), pub: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

async function setup(opts: { route?: string; preview?: string; snapshots?: boolean; rateOk?: boolean } = {}) {
	const bucket = memoryBucket();
	if (opts.snapshots !== false) {
		await writeSnapshot(bucket, composition);
		await writeSnapshot(bucket, benchmarks);
	}
	const { priv, pub } = await makeKey();
	const limit = vi.fn(async (_: { key: string }) => ({ success: opts.rateOk !== false }));
	const env = {
		PAID_ROUTE_ENABLED: opts.route ?? "1",
		DATA_PRODUCTS_PREVIEW: opts.preview ?? "1",
		SNAPSHOTS: bucket,
		PAID_RATE: { limit },
		MPP_SECRET_KEY: "k".repeat(43),
		MPP_NETWORK: "testnet",
		MPP_RECIPIENT: "0x000000000000000000000000000000000000dEaD",
		SIGNING_PRIVATE_JWK: JSON.stringify(priv),
		SIGNING_KID: "k1",
	};
	return { env, pub, limit };
}

// The real contract: a pull credential carries a signed Tempo transaction, and its `source` is only
// what the caller claims. mppx verifies the transaction's sender, never `source`.
const walletA = privateKeyToAccount(generatePrivateKey());
const walletB = privateKeyToAccount(generatePrivateKey());
const signedTx = (account: typeof walletA) =>
	account.signTransaction(
		{ chainId: 42431, calls: [{ to: "0x20c0000000000000000000000000000000000000", data: "0x" }], nonce: 0, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: "tempo" } as never,
		{ serializer: Transaction.serialize as never },
	);
const TX_A = await signedTx(walletA);
const TX_B = await signedTx(walletB);
const DID_A = `did:pkh:eip155:42431:${walletA.address}`;
/** Someone else's identity, claimed in `source` by the payer of TX_A. */
const VICTIM = "did:pkh:eip155:42431:0x1111111111111111111111111111111111111111";
const credential = (tx: string, source?: string) => ({
	_meta: { "org.paymentauth/credential": { challenge: { id: "ch1" }, payload: { type: "transaction", signature: tx }, ...(source ? { source } : {}) } },
});

/** The MCP door: dispatch with a pay hook bound to this request's `extra`, exactly as index.ts wires it. */
async function callMcp(env: Awaited<ReturnType<typeof setup>>["env"], id: string, extra: unknown = {}) {
	let outcome: PaidOutcome | undefined;
	const result = await dispatch(id, {}, {
		env: env as never,
		transport: "mcp",
		pay: async (c) => (outcome = await gatePaid(env as never, { ...c, request: extra })),
	});
	return { result, outcome };
}

beforeEach(() => {
	h.created.mockClear();
	h.configured.mockClear();
	h.invoked.mockClear();
});

describe("registry", () => {
	it("declares both paid products at $0.50 metered, withheld until G1", () => {
		for (const id of PAID_IDS) {
			const s = SERVICES.find((x) => x.id === id)!;
			expect(s.kind).toBe("data");
			expect(s.price).toEqual({ model: "metered", amountUsd: 0.5 });
			expect(s.withheld).toMatch(/G1/);
			expect(s.withheld).toMatch(/privacy-policy purpose/);
			expect(s.withheld).toMatch(/lawyer review/);
			expect(s.withheld!.length).toBeGreaterThan(40);
		}
		expect(SERVICES.map((s) => s.id)).not.toContain("get_cee_leadership_market");
	});
});

describe("wire keys", () => {
	it("match mppx's own MCP metadata keys", () => {
		expect(CREDENTIAL_META).toBe(Mcp.credentialMetaKey);
		expect(RECEIPT_META).toBe(Mcp.receiptMetaKey);
		expect(PAYMENT_REQUIRED_META).toBe(Mcp.paymentRequiredMetaKey);
	});
});

describe("gatePaid order", () => {
	it("with PAID_ROUTE_ENABLED '0' never charges, and the preview states the price", async () => {
		const { env } = await setup({ route: "0" });
		const outcome = await gatePaid(env as never, { amountUsd: 0.5, methodId: "leader_composition", request: credential(TX_A, VICTIM) });
		expect(outcome).toEqual({ kind: "preview", reason: "disabled" });
		expect(h.invoked).not.toHaveBeenCalled();
		expect(h.configured).not.toHaveBeenCalled();
		const r = await paidDataHandler("get_leader_composition", env as never, { transport: "mcp", outcome });
		expect(r.report).toContain("$0.50");
		expect(r.data?.price).toEqual({ model: "metered", amount_usd: 0.5, per: "call" });
		expect(r.data?.full).toBeUndefined();
	});

	it("with no snapshot never charges and says not computed yet (Review Focus 3)", async () => {
		const { env } = await setup({ snapshots: false });
		const outcome = await gatePaid(env as never, { amountUsd: 0.5, methodId: "meetup_benchmarks", request: credential(TX_A, VICTIM) });
		expect(outcome).toEqual({ kind: "preview", reason: "no_snapshot" });
		const { result } = await callMcp(env, "get_meetup_benchmarks", credential(TX_A, VICTIM));
		expect(result.verdict).toBe("Not computed yet");
		expect(h.invoked).not.toHaveBeenCalled();
	});

	it("rate-limits by payer identity before charging", async () => {
		const { env, limit } = await setup({ rateOk: false });
		const outcome = await gatePaid(env as never, { amountUsd: 0.5, methodId: "leader_composition", request: credential(TX_A, VICTIM) });
		expect(outcome).toEqual({ kind: "preview", reason: "rate_limited" });
		// Keyed on the claimed identity, the only one available before verification (deferred to G1).
		expect(limit).toHaveBeenCalledWith({ key: VICTIM });
		expect(h.invoked).not.toHaveBeenCalled();
	});

	it("returns the payment challenge when unpaid, with the preview and no full answer", async () => {
		const { env } = await setup();
		const { result, outcome } = await callMcp(env, "get_leader_composition");
		expect(outcome?.kind).toBe("preview");
		expect(outcome && outcome.kind === "preview" && outcome.reason).toBe("payment_required");
		expect(result.data?.full).toBeUndefined();
		expect(result.data?.license_id).toBeUndefined();
		const tool = withPayment({ content: [] }, outcome);
		const required = (tool._meta as Record<string, { challenges: unknown[] }>)["org.paymentauth/payment-required"];
		expect(required.challenges).toHaveLength(1);
		// Charged at the list price, testnet, scoped to the product so one payment cannot buy the other.
		expect(h.configured).toHaveBeenCalledWith(expect.objectContaining({ amount: "0.5", scope: "leader_composition" }));
		expect(h.created).toHaveBeenCalledWith(expect.objectContaining({ secretKey: env.MPP_SECRET_KEY }));
	});
});

describe("after payment", () => {
	it("returns the full grid with license_id inside the signed data", async () => {
		const { env, pub } = await setup();
		const { result, outcome } = await callMcp(env, "get_leader_composition", credential(TX_A, VICTIM));
		// Attributed to the wallet that signed the payment, not to the DID it claimed.
		expect(outcome).toMatchObject({ kind: "paid", payer: DID_A, receiptId: "0xtxhash" });
		const full = result.data?.full as { tables: Record<string, unknown> };
		expect(full.tables.seniority_x_employer_country).toBeDefined();
		const expected = (await sha256Hex(`${DID_A}:leader_composition:${today}`)).slice(0, 16);
		expect(result.data?.license_id).toBe(expected);
		expect(result.data?.license_id).not.toBe((await sha256Hex(`${VICTIM}:leader_composition:${today}`)).slice(0, 16));
		expect(await verifyData(pub, result.data!, result.signature!.jws)).toBe(true);
		const tampered = { ...result.data!, license_id: "0000000000000000" };
		expect(await verifyData(pub, tampered, result.signature!.jws)).toBe(false);
		const tool = withPayment({ content: [] }, outcome);
		expect((tool._meta as Record<string, { reference: string }>)["org.paymentauth/receipt"].reference).toBe("0xtxhash");
	});

	it("returns the per-event table for meetup benchmarks", async () => {
		const { env } = await setup();
		const { result } = await callMcp(env, "get_meetup_benchmarks", credential(TX_A, VICTIM));
		expect((result.data?.full as { events: unknown[] }).events).toHaveLength(1);
		expect(result.data?.license_id).toMatch(/^[0-9a-f]{16}$/);
	});

	it("derives license_id from the tx sender: stable for one sender whatever it claims, different for another", async () => {
		const { env } = await setup();
		const a = await callMcp(env, "get_leader_composition", credential(TX_A, VICTIM));
		const b = await callMcp(env, "get_leader_composition", credential(TX_A));
		const c = await callMcp(env, "get_leader_composition", credential(TX_B, VICTIM));
		expect(a.result.data?.license_id).toBe(b.result.data?.license_id);
		expect(c.result.data?.license_id).not.toBe(a.result.data?.license_id);
		expect(c.outcome).toMatchObject({ payer: `did:pkh:eip155:42431:${walletB.address}` });
	});

	it("answers from the snapshot the gate checked, even if R2 is empty after the charge", async () => {
		const { env } = await setup();
		const objects = objectsOf.get(env.SNAPSHOTS)!;
		const gated = JSON.parse(objects.get("snapshots/leader_composition/latest.json")!) as { sha256: string };
		// The charge succeeds, then the bucket goes away (a transient miss, or a cron rewrite in between).
		h.invoked.mockImplementationOnce(() => objects.clear());
		const { result, outcome } = await callMcp(env, "get_leader_composition", credential(TX_A, VICTIM));
		expect(outcome?.kind).toBe("paid");
		expect(objects.size).toBe(0);
		expect(result.verdict).not.toBe("Not computed yet");
		expect(result.data?.full).toBeDefined();
		expect(result.data?.snapshot_sha256).toBe(gated.sha256);
	});
});

describe("DATA_PRODUCTS_PREVIEW cannot unlock production", () => {
	it("with DATA_PRODUCTS_PREVIEW '1' but PAID_ROUTE_ENABLED '0' both ids still return their withheld notice", async () => {
		const { env } = await setup({ route: "0", preview: "1" });
		for (const id of PAID_IDS) {
			const { result } = await callMcp(env, id, credential(TX_A, VICTIM));
			expect(result.verdict).toBe("Not available yet");
			expect(result.data?.withheld).toBe(true);
			expect(result.report).toContain("$0.5");
		}
		expect(liveServicesFor(env).map((s) => s.id)).not.toContain("get_leader_composition");
		expect(h.invoked).not.toHaveBeenCalled();
	});

	it("the committed wrangler.jsonc keeps the route off, so the override is inert there", () => {
		const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
		const vars = JSON.parse(raw.replace(/^\s*\/\*[\s\S]*?\*\//, "").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")).vars as Record<string, string>;
		expect(vars.PAID_ROUTE_ENABLED).toBe("0");
		expect(vars.MPP_NETWORK).toBe("testnet");
		const live = liveServicesFor({ ...vars, DATA_PRODUCTS_PREVIEW: "1" }).map((s) => s.id);
		for (const id of PAID_IDS) expect(live).not.toContain(id);
	});

	it("lifts withheld for exactly the two paid ids when both flags are on", () => {
		const live = liveServicesFor({ PAID_ROUTE_ENABLED: "1", DATA_PRODUCTS_PREVIEW: "1" }).map((s) => s.id);
		for (const id of PAID_IDS) expect(live).toContain(id);
		expect(live).not.toContain("post_job");
		expect(live).not.toContain("request_intro");
	});
});

describe("the A2A door", () => {
	it("returns the preview plus pay_via, and never charges", async () => {
		const { env } = await setup();
		const r = await dispatch("get_leader_composition", {}, { env: env as never, transport: "a2a" });
		expect(r.data?.pay_via).toBe("https://www.engineeringleaders.io/mcp/trade");
		expect(r.data?.full).toBeUndefined();
		const figures = r.data?.figures as Record<string, Figure>;
		expect(figures.titled.value).toBe(2400);
		expect(figures["seniority_share.manager"].value).toBe(37.5);
		expect(figures["seniority_share.vp"]).toBeUndefined();
		expect(h.invoked).not.toHaveBeenCalled();
	});

	it("benchmarks preview carries the series medians only", async () => {
		const { env } = await setup();
		const r = await dispatch("get_meetup_benchmarks", {}, { env: env as never, transport: "a2a" });
		const figures = r.data?.figures as Record<string, Figure>;
		expect(figures.median_applied.value).toBe(180);
		expect(r.data?.full).toBeUndefined();
	});
});
