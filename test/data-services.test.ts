import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch, InvalidArgumentsError, signDataResult } from "../src/core/dispatch";
import { LIVE_SERVICES } from "../src/core/services";
import { STALE_AFTER_HOURS } from "../src/core/data-services";
import { writeSnapshot } from "../src/data/snapshot-store";
import type { Figure, SnapshotBody } from "../src/data/types";
import { verifyData } from "../src/trust/sign";

/** In-memory stand-in for the R2 calls the store makes. */
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
	return { bucket: bucket as unknown as R2Bucket, objects };
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

const fig = (value: number, asOf: string, denominator = 4000): Figure => ({
	value,
	n: value,
	denominator,
	coverage_pct: 100,
	as_of: asOf,
	method_id: "member_census",
});

const body = (asOf: string): SnapshotBody => ({
	method_id: "member_census",
	as_of: asOf,
	method_url: "https://www.engineeringleaders.io/agents/methods/member_census/",
	preview: { active_members: fig(4000, asOf), titled: fig(2400, asOf), "seniority.manager": fig(900, asOf) },
	full: {},
});

async function makeKey() {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	return {
		priv: await crypto.subtle.exportKey("jwk", pair.privateKey),
		pub: await crypto.subtle.exportKey("jwk", pair.publicKey),
	};
}

async function ctxWith(asOf: string | null, signing = true) {
	const { bucket } = memoryBucket();
	if (asOf) await writeSnapshot(bucket, body(asOf));
	const { priv, pub } = await makeKey();
	const env = {
		SNAPSHOTS: bucket,
		...(signing ? { SIGNING_PRIVATE_JWK: JSON.stringify(priv), SIGNING_KID: "k1" } : {}),
	} as never;
	return { ctx: { env, transport: "mcp" as const }, pub };
}

describe("get_member_census", () => {
	it("is advertised and free", () => {
		const s = LIVE_SERVICES.find((x) => x.id === "get_member_census");
		expect(s?.price).toEqual({ model: "free" });
		expect(s?.kind).toBe("data");
		expect(LIVE_SERVICES.map((x) => x.id)).toContain("cite_benchmark");
	});

	it("says 'Not computed yet' with no snapshot, without throwing or signing", async () => {
		const { ctx } = await ctxWith(null);
		const r = await dispatch("get_member_census", {}, ctx);
		expect(r.verdict).toBe("Not computed yet");
		expect(r.data?.figures).toBeUndefined();
		expect(r.signature).toBeUndefined();
	});

	it("says 'Not computed yet' when no bucket is bound at all", async () => {
		const r = await dispatch("get_member_census", {});
		expect(r.verdict).toBe("Not computed yet");
	});

	it("says 'Not computed yet' for a corrupt snapshot", async () => {
		const { bucket, objects } = memoryBucket();
		objects.set("snapshots/member_census/latest.json", "{not json");
		const r = await dispatch("get_member_census", {}, { env: { SNAPSHOTS: bucket } as never, transport: "mcp" });
		expect(r.verdict).toBe("Not computed yet");
	});

	it("carries the snapshot's own as_of and stale:true after 72 h, never today's date", async () => {
		const asOf = daysAgo(4);
		const { ctx } = await ctxWith(asOf);
		const r = await dispatch("get_member_census", {}, ctx);
		expect(STALE_AFTER_HOURS).toBe(72);
		expect(r.data?.stale).toBe(true);
		expect(r.data?.as_of).toBe(asOf);
		expect(r.data?.snapshot_id).toBe(`member_census/${asOf}`);
		expect(r.report).toContain(asOf);
	});

	it("is not stale for a fresh snapshot", async () => {
		const { ctx } = await ctxWith(daysAgo(0));
		const r = await dispatch("get_member_census", {}, ctx);
		expect(r.data?.stale).toBe(false);
		expect(r.data?.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("passes every figure through with n, denominator, coverage_pct, as_of and method_id", async () => {
		const { ctx } = await ctxWith(daysAgo(0));
		const r = await dispatch("get_member_census", {}, ctx);
		const figures = r.data?.figures as Record<string, Figure>;
		expect(Object.keys(figures).length).toBeGreaterThan(0);
		for (const f of Object.values(figures)) {
			for (const k of ["value", "n", "denominator", "coverage_pct", "as_of", "method_id"] as const) expect(f[k]).toBeDefined();
		}
	});

	it("signs data so the signature verifies, also after re-ordering (transport round trip)", async () => {
		const { ctx, pub } = await ctxWith(daysAgo(0));
		const r = await dispatch("get_member_census", {}, ctx);
		expect(r.signature?.kid).toBe("k1");
		expect(await verifyData(pub, r.data!, r.signature!.jws)).toBe(true);
		const reverseKeys = (v: unknown): unknown =>
			Array.isArray(v)
				? v.map(reverseKeys)
				: v && typeof v === "object"
					? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]))
					: v;
		const wire = JSON.parse(JSON.stringify(reverseKeys(r.data), null, 4));
		expect(await verifyData(pub, wire, r.signature!.jws)).toBe(true);
		const tampered = JSON.parse(JSON.stringify(r.data));
		tampered.figures.active_members.n += 1;
		expect(await verifyData(pub, tampered, r.signature!.jws)).toBe(false);
	});

	it("without a signing key returns the answer unsigned and says so (R26)", async () => {
		const { ctx } = await ctxWith(daysAgo(0), false);
		const r = await dispatch("get_member_census", {}, ctx);
		expect(r.signature).toBeUndefined();
		expect(r.data?.signature_status).toBe("unavailable");
		expect(r.data?.figures).toBeDefined();
	});

	it("with an unusable key returns the answer unsigned and says so, without throwing", async () => {
		const { bucket } = memoryBucket();
		await writeSnapshot(bucket, body(daysAgo(0)));
		const env = { SNAPSHOTS: bucket, SIGNING_PRIVATE_JWK: "garbage", SIGNING_KID: "k1" } as never;
		const r = await dispatch("get_member_census", {}, { env, transport: "mcp" });
		expect(r.signature).toBeUndefined();
		expect(r.data?.signature_status).toBe("unavailable");
	});

	it("rejects an unknown argument inside dispatch", async () => {
		await expect(dispatch("get_member_census", { city: "Prague" })).rejects.toBeInstanceOf(InvalidArgumentsError);
		await expect(dispatch("get_member_census", { city: "Prague" })).rejects.toThrow(/Accepted arguments/);
	});
});

describe("signing in dispatch", () => {
	const service = LIVE_SERVICES.find((x) => x.id === "get_member_census")!;

	it("signs data that carries an undefined field, and what is returned is what was signed", async () => {
		const { priv, pub } = await makeKey();
		const env = { SIGNING_PRIVATE_JWK: JSON.stringify(priv), SIGNING_KID: "k1" };
		const r = await signDataResult(service, { report: "x", source: "s", data: { a: 1, gone: undefined, nested: { b: undefined, c: 2 } } }, env);
		expect(r.data).toEqual({ a: 1, nested: { c: 2 } });
		expect("gone" in r.data!).toBe(false);
		expect(await verifyData(pub, r.data!, r.signature!.jws)).toBe(true);
	});

	it("leaves a result without data alone", async () => {
		const r = await signDataResult(service, { report: "x", source: "s" }, undefined);
		expect(r.signature).toBeUndefined();
		expect(r.data).toBeUndefined();
	});

	it("signs cite_benchmark answers too, as every kind:data result", async () => {
		const { ctx, pub } = await ctxWith(null);
		const r = await dispatch("cite_benchmark", { id: "elc_community.members_live" }, ctx);
		expect(await verifyData(pub, r.data!, r.signature!.jws)).toBe(true);
	});
});

describe("cite_benchmark", () => {
	it("returns the registry value, source and verified date for a known id", async () => {
		const r = await dispatch("cite_benchmark", { id: "elc_community.members_live" });
		expect(r.data?.found).toBe(true);
		expect(r.data?.id).toBe("elc_community.members_live");
		expect(typeof r.data?.value).toBe("number");
		expect(r.data?.source_url).toBe("https://www.engineeringleaders.io/statistics/");
		expect(r.data?.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(r.data).not.toHaveProperty("note");
		expect(r.data).not.toHaveProperty("source");
	});

	it("lists the nearest 3 ids for an unknown id instead of guessing", async () => {
		const r = await dispatch("cite_benchmark", { id: "elc_community.members_lve" });
		expect(r.data?.found).toBe(false);
		const nearest = r.data?.nearest_ids as string[];
		expect(nearest).toHaveLength(3);
		expect(nearest[0]).toBe("elc_community.members_live");
		expect(r.data).not.toHaveProperty("value");
		// deterministic
		const again = await dispatch("cite_benchmark", { id: "elc_community.members_lve" });
		expect(again.data?.nearest_ids).toEqual(nearest);
	});

	it("treats a registry row outside the allowlist as unknown, in lookup, nearest and search", async () => {
		const id = "partnerships.ataccama_members";
		const r = await dispatch("cite_benchmark", { id });
		expect(r.data?.found).toBe(false);
		expect(r.data).not.toHaveProperty("value");
		for (const probe of [{ id: "partnerships.ataccama_member" }, { query: "ataccama members" }, { query: "partnerships" }]) {
			const d = (await dispatch("cite_benchmark", probe)).data!;
			expect(JSON.stringify([d.nearest_ids, d.matches])).not.toContain("partnerships.");
		}
	});

	it("searches by words when given a query", async () => {
		const r = await dispatch("cite_benchmark", { query: "meetup attendance" });
		expect((r.data?.matches as unknown[]).length).toBeGreaterThan(0);
	});

	it("asks for an id or query when given neither, without throwing", async () => {
		const r = await dispatch("cite_benchmark", {});
		expect(r.verdict).toBe("Needs an id or a query");
	});

	it("rejects an unknown argument and names the accepted fields", async () => {
		await expect(dispatch("cite_benchmark", { topic: "x" })).rejects.toThrow(/Accepted arguments:[\s\S]*id[\s\S]*query/);
	});
});

describe("the vendored registry slice", () => {
	const raw = readFileSync("src/data/data-points.json", "utf8");
	const ids = JSON.parse(readFileSync("src/data/citable-ids.json", "utf8")) as string[];
	const rows = JSON.parse(raw).rows as Record<string, Record<string, unknown>>;

	it("holds exactly the allowlist, sorted", () => {
		expect(Object.keys(rows)).toEqual(ids);
		expect([...ids].sort()).toEqual(ids);
	});

	it("has no source or note keys, and only the five public fields", () => {
		expect(raw).not.toMatch(/"(source|note)"\s*:/);
		for (const row of Object.values(rows)) {
			for (const k of Object.keys(row)) expect(["label", "value", "display", "verified", "source_url"]).toContain(k);
		}
	});

	it("leaks no email, CRM, Drive or calendar reference", () => {
		for (const needle of ["@", "attio.com", "docs.google.com", "lu.ma/calendar"]) expect(raw).not.toContain(needle);
	});

	it("excludes the rows ruled out of citation", () => {
		for (const id of ["elc_community.meetup_registrations_median", "elc_community.youtube_channel"]) expect(ids).not.toContain(id);
		expect(ids.some((i) => i.startsWith("partnerships."))).toBe(false);
	});
});

describe("census staleness boundary", () => {
	afterEach(() => vi.useRealTimers());

	// as_of is date-only (UTC midnight), so the 72 h boundary is only accurate to +-24 h in practice;
	// the tests pin the arithmetic against the date itself.
	const asOf = "2026-10-20";
	const at = (hours: number) => new Date(Date.parse(asOf) + hours * 3_600_000);

	async function censusAt(hours: number) {
		const { bucket } = memoryBucket();
		await writeSnapshot(bucket, body(asOf));
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(at(hours));
		return dispatch("get_member_census", {}, { env: { SNAPSHOTS: bucket } as never, transport: "mcp" });
	}

	it("is not stale at 71 h", async () => {
		expect((await censusAt(71)).data?.stale).toBe(false);
	});

	it("is stale at 73 h and still reports the snapshot's own date", async () => {
		const r = await censusAt(73);
		expect(r.data?.stale).toBe(true);
		expect(r.data?.as_of).toBe(asOf);
	});
});
