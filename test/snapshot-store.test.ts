import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/trust/jcs";
import { nightlyScheduled, readLatest, runNightlySnapshots, verifySnapshot, writeSnapshot } from "../src/data/snapshot-store";
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

	it("writes nothing and posts no Slack message when a fetch fails (control-room pages it once)", async () => {
		const { bucket, objects } = memoryBucket();
		const calls: { url: string; body: string }[] = [];
		const realFetch = globalThis.fetch;
		const realError = console.error;
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			calls.push({ url: String(url), body: String(init?.body) });
			return new Response(JSON.stringify({ ok: true }));
		}) as typeof fetch;
		console.error = () => {};
		let stage = "";
		try {
			const out = await runNightlySnapshots(
				{ SNAPSHOTS: bucket },
				async () => {
					throw new Error("Attio POST /lists -> 503");
				},
				(s) => { stage = s; },
			);
			expect(out).toBeNull();
		} finally {
			globalThis.fetch = realFetch;
			console.error = realError;
		}
		expect(objects.size).toBe(0);
		expect(stage).toBe("fetch/aggregate");
		expect(calls.filter((c) => c.url.includes("slack.com"))).toHaveLength(0);
	});
});

describe("size bands from Attio employee_range", () => {
	it("collapses the real option labels and sends anything else to unknown", () => {
		expect(["1-10", "11-50", "51-250", "251-1K", "1K-5K", "100K+", "", null, "huge"].map((r) => sizeBandOf(r))).toEqual([
			"1-50", "1-50", "51-250", "251-1k", "1k+", "1k+", "unknown", "unknown", "unknown",
		]);
	});
});

describe("the writer never restarts the hash chain silently", () => {
	it("throws and writes nothing when latest.json is tampered", async () => {
		const { bucket, objects } = memoryBucket();
		const stored = await writeSnapshot(bucket, body("2026-10-23"));
		const tampered = JSON.stringify({ ...stored, full: { active_members: 9999 } });
		objects.set("snapshots/member_census/latest.json", tampered);
		const before = new Map(objects);

		await expect(writeSnapshot(bucket, body("2026-10-24"))).rejects.toThrow(/hash verification/);
		expect(objects).toEqual(before);
		expect(objects.has("snapshots/member_census/2026-10-24.json")).toBe(false);
	});

	it("throws and writes nothing when the R2 read fails", async () => {
		const { bucket, objects } = memoryBucket();
		(bucket as unknown as { get: () => Promise<never> }).get = async () => {
			throw new Error("R2 internal error");
		};
		await expect(writeSnapshot(bucket, body("2026-10-24"))).rejects.toThrow(/R2 internal error/);
		expect(objects.size).toBe(0);
	});

	it("a broken chain in one method stops the nightly run before any method is written", async () => {
		const { bucket, objects } = memoryBucket();
		objects.set("snapshots/meetup_benchmarks/latest.json", "{not json");
		const realError = console.error;
		const logged: string[] = [];
		console.error = (m: string) => void logged.push(m);
		try {
			const out = await runNightlySnapshots({ SNAPSHOTS: bucket }, async () => ({
				asOf: "2026-10-24",
				activeMembers: 0,
				members: [],
				conference: [],
				events: [],
			}));
			expect(out).toBeNull();
		} finally {
			console.error = realError;
		}
		expect([...objects.keys()]).toEqual(["snapshots/meetup_benchmarks/latest.json"]);
		expect(logged.join("\n")).toMatch(/snapshot chain failed.*meetup_benchmarks\/latest\.json is not valid JSON/);
	});
});

describe("scheduled handler (R23)", () => {
	it("awaits the run itself instead of handing it to waitUntil", async () => {
		const { bucket, objects } = memoryBucket();
		const ctx = {
			waitUntil: () => {
				throw new Error("waitUntil must not be used");
			},
		} as unknown as ExecutionContext;
		const realError = console.error;
		const logged: string[] = [];
		console.error = (m: string) => void logged.push(m);
		try {
			// No ATTIO_TOKEN: the run fails and logs. A fire-and-forget handler resolves before the
			// log line exists; only an awaited one has already logged when it returns.
			await nightlyScheduled({} as ScheduledController, { SNAPSHOTS: bucket }, ctx);
			expect(logged.join("\n")).toMatch(/fetch\/aggregate failed.*ATTIO_TOKEN not set/);
		} finally {
			console.error = realError;
		}
		expect(objects.size).toBe(0);
	});
});

describe("run report (automation-visibility R-W)", () => {
	it("reports a failed nightly run to control-room through the service binding", async () => {
		const { bucket } = memoryBucket();
		const posted: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
		const CONTROL_ROOM = {
			fetch: async (url: string, init: RequestInit) => {
				posted.push({ url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null });
				return new Response("{}", { status: 202 });
			},
		} as unknown as Fetcher;
		const realError = console.error;
		console.error = () => {};
		try {
			await nightlyScheduled({ scheduledTime: 1_761_448_500_000 } as ScheduledController, { SNAPSHOTS: bucket, CONTROL_ROOM, CONTROL_ROOM_TOKEN: "t" }, {} as ExecutionContext);
		} finally {
			console.error = realError;
		}
		// The pause check (GET), the start event and the end report; the end report is the last POST.
		posted.splice(0, posted.length, ...posted.filter((p) => p.body && (p.body as { event?: string }).event === undefined && p.url === "https://control-room/report"));
		expect(posted).toHaveLength(1);
		expect(posted[0].url).toBe("https://control-room/report");
		expect(posted[0].headers["x-report-token"]).toBe("t");
		expect(posted[0].body).toMatchObject({
			run_id: "elc-trade:1761448500000",
			job_id: "elc-trade",
			status: "failed",
			runtime: "worker",
			source: "worker",
			kpi: "0 snapshots written",
			kpi_pass: "no",
		});
		expect(String(posted[0].body.detail)).toContain("failed at ");
	});

	it("a failed run with no control-room binding says so in the log (nothing else would page it)", async () => {
		const { bucket } = memoryBucket();
		const errors: string[] = [];
		const realError = console.error;
		console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
		try {
			await nightlyScheduled({} as ScheduledController, { SNAPSHOTS: bucket }, {} as ExecutionContext);
		} finally {
			console.error = realError;
		}
		expect(errors.some((e) => e.includes("FAILED run not reported"))).toBe(true);
	});

	it("never throws when control-room is down", async () => {
		const { bucket } = memoryBucket();
		const CONTROL_ROOM = { fetch: async () => { throw new Error("down"); } } as unknown as Fetcher;
		const realError = console.error;
		console.error = () => {};
		try {
			await expect(
				nightlyScheduled({} as ScheduledController, { SNAPSHOTS: bucket, CONTROL_ROOM, CONTROL_ROOM_TOKEN: "t" }, {} as ExecutionContext),
			).resolves.toBeUndefined();
		} finally {
			console.error = realError;
		}
	});
});

describe("operating standard v2 (2026-11-14)", () => {
	const src = (): SourceData => ({
		asOf: "2026-11-14",
		activeMembers: 40,
		members: Array.from({ length: 40 }, (_, i) => ({ title: i % 2 ? "Engineering Manager" : "CTO", sizeBand: "1k+" as const, employerCountry: "CZ", companyId: `c${i}` })),
		conference: [],
		events: [],
	});
	function controlRoom(pause?: { by: string; why: string }) {
		const calls: { method: string; path: string; body: Record<string, any> | null }[] = [];
		const binding = {
			fetch: async (u: string, init: RequestInit = {}) => {
				const path = new URL(u).pathname;
				calls.push({ method: init.method ?? "GET", path, body: init.body ? JSON.parse(String(init.body)) : null });
				if (path.startsWith("/api/pause/")) return new Response(JSON.stringify({ ok: true, paused: !!pause, ...pause }), { status: 200 });
				return new Response("{}", { status: 202 });
			},
		} as unknown as Fetcher;
		return { binding, calls, posts: () => calls.filter((c) => c.method === "POST").map((c) => c.body as Record<string, any>) };
	}
	const sched = { scheduledTime: Date.UTC(2026, 10, 14, 3, 15) } as ScheduledController;

	it("a good night is a live run: pause check, start, a step per stage, one end report with iterations, steps and the deploy version", async () => {
		const { bucket } = memoryBucket(); const cr = controlRoom();
		await nightlyScheduled(sched, { SNAPSHOTS: bucket, CONTROL_ROOM: cr.binding, CONTROL_ROOM_TOKEN: "t", CF_VERSION_METADATA: { id: "ver-1" } } as never, {} as ExecutionContext, async () => src());
		expect(cr.calls[0].path).toBe("/api/pause/elc-trade");
		expect(cr.posts().map((b) => b.event ?? "end")).toEqual(["start", "step", "step", "step", "step", "end"]);
		expect(cr.posts().at(-1)).toMatchObject({ job_id: "elc-trade", status: "success", kpi: "3 snapshots written", kpi_pass: "yes", iterations: 3, version: "ver-1", run_id: `elc-trade:${sched.scheduledTime}` });
		expect(cr.posts().at(-1)!.steps).toHaveLength(4);
	});

	it("gate path: paused from the web keeps yesterday's snapshots, reads nothing, writes nothing and reports paused (not a failure)", async () => {
		const { bucket, objects } = memoryBucket(); const cr = controlRoom({ by: "marian@kamenistak.com", why: "Attio schema change" });
		let loaded = 0;
		await nightlyScheduled(sched, { SNAPSHOTS: bucket, CONTROL_ROOM: cr.binding, CONTROL_ROOM_TOKEN: "t" } as never, {} as ExecutionContext, async () => (loaded++, src()));
		expect(loaded).toBe(0); expect(objects.size).toBe(0);
		expect(cr.posts()).toHaveLength(1);
		expect(cr.posts()[0]).toMatchObject({ status: "paused" });
		expect(cr.posts()[0].detail).toMatch(/paused by marian: Attio schema change/);
	});

	it("failure path: a failing source reports failed with the stage and the error, after the start event", async () => {
		const { bucket, objects } = memoryBucket(); const cr = controlRoom();
		const realError = console.error; console.error = () => {};
		try {
			await nightlyScheduled(sched, { SNAPSHOTS: bucket, CONTROL_ROOM: cr.binding, CONTROL_ROOM_TOKEN: "t" } as never, {} as ExecutionContext, async () => { throw new Error("Attio POST /lists -> 503"); });
		} finally { console.error = realError; }
		expect(objects.size).toBe(0);
		expect(cr.posts().map((b) => b.event ?? "end")).toEqual(["start", "end"]);
		const end = cr.posts()[1];
		expect(end).toMatchObject({ status: "failed", kpi_pass: "no", iterations: 0 });
		expect(end.errors[0]).toMatch(/^fetch\/aggregate: Attio POST \/lists -> 503/);
	});

	it("resume: a run that broke after the first R2 put continues with the missing methods and never re-chains the one already written", async () => {
		const { bucket, objects } = memoryBucket();
		const real = (bucket as unknown as { put: (k: string, v: string) => Promise<unknown> }).put.bind(bucket);
		let puts = 0;
		(bucket as unknown as { put: (k: string, v: string) => Promise<unknown> }).put = async (k, v) => {
			// the first method's two puts (dated + latest) succeed, the next one fails
			if (puts++ >= 2) throw new Error("R2 503");
			return real(k, v);
		};
		const realError = console.error; console.error = () => {};
		try { expect(await runNightlySnapshots({ SNAPSHOTS: bucket }, async () => src())).toBeNull(); } finally { console.error = realError; }
		const first = JSON.parse(objects.get("snapshots/member_census/latest.json")!);
		expect(objects.has("snapshots/leader_composition/latest.json")).toBe(false);

		(bucket as unknown as { put: typeof real }).put = real;
		const stored = await runNightlySnapshots({ SNAPSHOTS: bucket }, async () => src());
		expect(stored?.map((s) => s.method_id)).toEqual(["member_census", "leader_composition", "meetup_benchmarks"]);
		const after = JSON.parse(objects.get("snapshots/member_census/latest.json")!);
		expect(after.sha256).toBe(first.sha256); expect(after.prev_sha256).toBe(first.prev_sha256); // untouched, not linked to itself
		expect(objects.has("snapshots/leader_composition/latest.json")).toBe(true);
		expect(await readLatest(bucket, "member_census")).not.toBeNull();
	});

	it("idempotent: a second run the same day writes nothing new", async () => {
		const { bucket, objects } = memoryBucket();
		await runNightlySnapshots({ SNAPSHOTS: bucket }, async () => src());
		const before = new Map(objects);
		let puts = 0;
		const real = (bucket as unknown as { put: (k: string, v: string) => Promise<unknown> }).put.bind(bucket);
		(bucket as unknown as { put: typeof real }).put = async (k, v) => (puts++, real(k, v));
		const again = await runNightlySnapshots({ SNAPSHOTS: bucket }, async () => src());
		expect(puts).toBe(0); expect(again).toHaveLength(3);
		expect([...objects.entries()]).toEqual([...before.entries()]);
	});
});
