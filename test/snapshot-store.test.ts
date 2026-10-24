import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/trust/jcs";
import { readLatest, runNightlySnapshots, verifySnapshot, writeSnapshot } from "../src/data/snapshot-store";
import { sizeBandOf } from "../src/data/sources";
import type { SnapshotBody, SourceData } from "../src/data/types";

/** In-memory stand-in for the two R2 calls the store makes. */
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

const body = (asOf: string, value = 4000): SnapshotBody => ({
	method_id: "member_census",
	as_of: asOf,
	method_url: "https://www.engineeringleaders.io/agents/methods/member_census/",
	preview: {
		active_members: { value, n: value, denominator: value, coverage_pct: 100, as_of: asOf, method_id: "member_census" },
	},
	full: { active_members: value },
});

describe("canonicalize (RFC 8785 subset)", () => {
	it("sorts keys at every depth and drops whitespace", () => {
		expect(canonicalize({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
	});

	it("gives the same bytes whatever the insertion order", () => {
		expect(canonicalize({ x: 1, y: { q: "é", p: null } })).toBe(canonicalize({ y: { p: null, q: "é" }, x: 1 }));
	});

	it("throws on values JSON cannot carry faithfully", () => {
		expect(() => canonicalize({ x: undefined })).toThrow();
		expect(() => canonicalize([undefined])).toThrow();
		expect(() => canonicalize({ f: () => 1 })).toThrow();
		expect(() => canonicalize(Number.NaN)).toThrow();
		expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow();
	});
});

describe("snapshot store", () => {
	it("writes the dated file and latest.json, and chains the second write to the first", async () => {
		const { bucket, objects } = memoryBucket();
		const first = await writeSnapshot(bucket, body("2026-10-23"));
		const second = await writeSnapshot(bucket, body("2026-10-24", 4010));

		expect(first.prev_sha256).toBeNull();
		expect(second.prev_sha256).toBe(first.sha256);
		expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect([...objects.keys()].sort()).toEqual([
			"snapshots/member_census/2026-10-23.json",
			"snapshots/member_census/2026-10-24.json",
			"snapshots/member_census/latest.json",
		]);
		expect(await readLatest(bucket, "member_census")).toEqual(second);
	});

	it("returns null on an empty bucket", async () => {
		const { bucket } = memoryBucket();
		expect(await readLatest(bucket, "member_census")).toBeNull();
	});

	it("returns null on a corrupt latest.json instead of throwing", async () => {
		const { bucket, objects } = memoryBucket();
		objects.set("snapshots/member_census/latest.json", "{not json");
		expect(await readLatest(bucket, "member_census")).toBeNull();
		objects.set("snapshots/member_census/latest.json", JSON.stringify({ method_id: "member_census" }));
		expect(await readLatest(bucket, "member_census")).toBeNull();
	});

	it("detects a tampered body: the stored sha256 no longer recomputes", async () => {
		const { bucket, objects } = memoryBucket();
		const stored = await writeSnapshot(bucket, body("2026-10-23"));
		expect(await verifySnapshot(stored)).toBe(true);

		const tampered = { ...stored, full: { active_members: 9999 } };
		expect(await verifySnapshot(tampered)).toBe(false);

		objects.set("snapshots/member_census/latest.json", JSON.stringify(tampered));
		expect(await readLatest(bucket, "member_census")).toBeNull();
	});
});

describe("nightly job", () => {
	const source = (): SourceData => ({
		asOf: "2026-10-24",
		activeMembers: 40,
		members: Array.from({ length: 40 }, (_, i) => ({
			title: i % 2 ? "Engineering Manager" : "CTO",
			sizeBand: "1k+" as const,
			employerCountry: "CZ",
			companyId: `c${i}`,
		})),
		conference: [],
		events: [],
	});

	it("writes all three methods on success", async () => {
		const { bucket, objects } = memoryBucket();
		const stored = await runNightlySnapshots({ SNAPSHOTS: bucket }, async () => source());
		expect(stored?.map((s) => s.method_id)).toEqual(["member_census", "leader_composition", "meetup_benchmarks"]);
		for (const m of ["member_census", "leader_composition", "meetup_benchmarks"]) {
			expect(objects.has(`snapshots/${m}/latest.json`)).toBe(true);
		}
		expect(JSON.stringify([...objects.values()])).not.toMatch(/companyId|"c\d+"/);
	});

	it("writes nothing and posts one Slack alert when a fetch fails", async () => {
		const { bucket, objects } = memoryBucket();
		const calls: { url: string; body: string }[] = [];
		const realFetch = globalThis.fetch;
		const realError = console.error;
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			calls.push({ url: String(url), body: String(init?.body) });
			return new Response(JSON.stringify({ ok: true }));
		}) as typeof fetch;
		console.error = () => {};
		try {
			const out = await runNightlySnapshots(
				{ SNAPSHOTS: bucket, SLACK_BOT_TOKEN_ELC: "xoxb-test", WARNING_SLACK_CHANNEL: "C0BMYMBHD32" },
				async () => {
					throw new Error("Attio POST /lists -> 503");
				},
			);
			expect(out).toBeNull();
		} finally {
			globalThis.fetch = realFetch;
			console.error = realError;
		}
		expect(objects.size).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://slack.com/api/chat.postMessage");
		expect(JSON.parse(calls[0].body).channel).toBe("C0BMYMBHD32");
	});
});

describe("size bands from Attio employee_range", () => {
	it("collapses the real option labels and sends anything else to unknown", () => {
		expect(["1-10", "11-50", "51-250", "251-1K", "1K-5K", "100K+", "", null, "huge"].map((r) => sizeBandOf(r))).toEqual([
			"1-50", "1-50", "51-250", "251-1k", "1k+", "1k+", "unknown", "unknown", "unknown",
		]);
	});
});
