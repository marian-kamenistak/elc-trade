import { describe, expect, it } from "vitest";
import { leaderComposition, meetupBenchmarks, memberCensus } from "../src/data/aggregate";
import type { EventRow, Figure, MemberRow, SizeBand, SnapshotBody, SourceData } from "../src/data/types";

const AS_OF = "2026-10-23";
const TITLES: Record<string, string> = {
	c: "CTO",
	vp: "VP Engineering",
	dir: "Director of Engineering",
	mgr: "Engineering Manager",
	lead: "Tech Lead",
	ic: "Software Engineer",
	other: "Coach",
};

/** Deterministic PRNG so the realistic fixture is stable. */
function rng(seed: number) {
	return () => {
		seed = (seed * 1664525 + 1013904223) % 4294967296;
		return seed / 4294967296;
	};
}

function pick<T>(r: () => number, weighted: [T, number][]): T {
	let x = r() * weighted.reduce((a, [, w]) => a + w, 0);
	for (const [v, w] of weighted) if ((x -= w) < 0) return v;
	return weighted[weighted.length - 1][0];
}

const event = (over: Partial<EventRow> = {}): EventRow => ({
	date: "2026-09-01", city: "Prague", capacity: 150, approvalRequired: true, applied: 200, approved: 120, waitlist: 10, checkedIn: 90, checkInReliable: true, ...over,
});

function realistic(total: number, companies: number): SourceData {
	const r = rng(42);
	const members: MemberRow[] = [];
	for (let i = 0; i < total; i++) {
		const t = pick(r, [["c", 26], ["vp", 6], ["dir", 13], ["mgr", 20], ["lead", 11], ["ic", 20], ["other", 4]] as [string, number][]);
		members.push({
			title: TITLES[t],
			sizeBand: pick<SizeBand>(r, [["1-50", 30], ["51-250", 30], ["251-1k", 20], ["1k+", 15], ["unknown", 5]]),
			employerCountry: pick<string | null>(r, [["CZ", 62], ["SK", 20], ["PL", 8], ["DE", 5], [null, 5]]),
			companyId: `co${Math.floor(companies * r() ** 1.6)}`,
		});
	}
	return { asOf: AS_OF, activeMembers: total + 200, members, conference: [], events: [event()] };
}

// 40 members: 36 titled (some untitled), 2 conference years, 3 events (one with unreliable check-in).
function fixture(): SourceData {
	const members: MemberRow[] = [];
	for (let i = 0; i < 40; i++) {
		members.push({
			title: i < 4 ? null : i < 20 ? "Engineering Manager" : i < 30 ? "CTO" : "Software Engineer",
			sizeBand: i % 2 ? "51-250" : "1k+",
			employerCountry: i % 5 ? "CZ" : "SK",
			companyId: `c${i % 15}`,
		});
	}
	return {
		asOf: AS_OF,
		activeMembers: 50,
		members,
		conference: [
			{ year: 2025, position: "CTO" }, { year: 2025, position: "VP of Eng" }, { year: 2026, position: "Head of Platform" }, { year: 2026, position: null },
		],
		events: [
			event({ applied: 100, approved: 80, checkedIn: 60 }),
			event({ applied: 300, approved: 100, checkedIn: 50 }),
			event({ applied: 500, approved: 200, checkedIn: 0, checkInReliable: false }),
		],
	};
}

const figures = (b: SnapshotBody) => Object.values(b.preview);
const allBodies = (src: SourceData) => [memberCensus(src), leaderComposition(src, { sizeBands: true }), meetupBenchmarks(src)];

/** Every table cell and marginal in a composition body. */
function collectTables(body: SnapshotBody) {
	const full = body.full as { tables: Record<string, any>; conference: { tables: Record<string, any> } };
	return [...Object.values(full.tables), ...Object.values(full.conference.tables)];
}

describe("memberCensus", () => {
	it("states coverage as titled / activeMembers, rounded to one decimal", () => {
		const b = memberCensus(fixture());
		expect(b.preview.titled.value).toBe(36);
		expect(b.preview.titled.coverage_pct).toBe(72);
		const odd = { ...fixture(), activeMembers: 47 };
		expect(memberCensus(odd).preview.titled.coverage_pct).toBe(76.6);
		expect(b.preview.active_members).toMatchObject({ value: 50, n: 50, denominator: 50, coverage_pct: 100 });
	});

	it("publishes seniority and country cuts with the title coverage and omits suppressed ones", () => {
		const b = memberCensus(fixture());
		expect(b.preview["seniority.manager"]).toMatchObject({ value: 16, n: 16, denominator: 50, coverage_pct: 72 });
		expect(b.preview["seniority.c_level_founder"].value).toBe(10);
		// 32 CZ + 8 SK: SK is under K and merges into "other", which is hidden. One hidden cell beside a
		// published total is recoverable, so the secondary rule hides CZ too. Conservative, by design.
		expect(b.preview["employer_country.CZ"]).toBeUndefined();
		expect(b.preview["employer_country.SK"]).toBeUndefined();
		expect(b.preview["employer_country.other"]).toBeUndefined();
	});
});

describe("leaderComposition", () => {
	it("has no size_band key anywhere when size bands are off", () => {
		const b = leaderComposition(fixture(), { sizeBands: false });
		expect(JSON.stringify(b.full)).not.toContain("size_band");
		expect(JSON.stringify(leaderComposition(fixture(), { sizeBands: true }).full)).toContain("size_band");
	});

	it("never lets a non-null cell or marginal fall under 10", () => {
		for (const src of [fixture(), realistic(1000, 400), realistic(30, 20)]) {
			for (const t of collectTables(leaderComposition(src, { sizeBands: true }))) {
				for (const c of t.cells) if (c.n !== null) expect(c.n).toBeGreaterThanOrEqual(10);
				for (const m of Object.values(t.marginals) as ({ n: number | null }[] | null)[]) {
					for (const x of m ?? []) if (x.n !== null) expect(x.n).toBeGreaterThanOrEqual(10);
				}
			}
		}
	});

	it("publishes every 2-D table for a realistic population (about 1,000 titled, 400 companies)", () => {
		const src = realistic(1000, 400);
		const b = leaderComposition(src, { sizeBands: true });
		expect(b.preview.titled.value).toBe(1000);
		const tables = Object.values((b.full as any).tables) as any[];
		expect(tables).toHaveLength(2);
		for (const t of tables) {
			expect(t.table_withheld).toBe(false);
			expect(t.cells.some((c: any) => c.n !== null)).toBe(true);
		}
	});

	it("falls back to marginals or withholds a tiny population without throwing", () => {
		const src = realistic(30, 20);
		const b = leaderComposition(src, { sizeBands: true });
		for (const t of collectTables(b)) {
			if (t.table_withheld) expect(t.cells).toEqual([]);
			else for (const c of t.cells) if (c.n !== null) expect(c.n).toBeGreaterThanOrEqual(10);
		}
	});

	it("withholds a table it cannot make safe and still publishes safe 1-D marginals", () => {
		// 30 CTOs spread over CZ/SK plus 8 coaches: the "other" seniority row (8 < K) has nothing left to shield it.
		const members: MemberRow[] = [
			...Array.from({ length: 30 }, (_, i) => ({ title: "CTO", sizeBand: "1k+" as const, employerCountry: i % 2 ? "CZ" : "SK", companyId: `a${i}` })),
			...Array.from({ length: 8 }, (_, i) => ({ title: "Coach", sizeBand: "1k+" as const, employerCountry: i % 2 ? "CZ" : "SK", companyId: `b${i}` })),
		];
		const b = leaderComposition({ ...fixture(), members, activeMembers: 38 }, { sizeBands: false });
		const t = (b.full as any).tables.seniority_x_employer_country;
		expect(t.table_withheld).toBe(true);
		expect(t.cells).toEqual([]);
		expect(t.marginals.employer_country).not.toBeUndefined();
	});

	it("survives empty and untitled inputs", () => {
		const empty: SourceData = { asOf: AS_OF, activeMembers: 0, members: [], conference: [], events: [] };
		expect(() => allBodies(empty)).not.toThrow();
		expect(memberCensus(empty).preview.titled.coverage_pct).toBe(0);
	});

	it("never lets a single-company cell through even when it is large", () => {
		const members: MemberRow[] = Array.from({ length: 60 }, (_, i) => ({
			title: "CTO", sizeBand: "1k+" as const, employerCountry: "CZ", companyId: i < 40 ? "big" : `o${i}`,
		}));
		const b = leaderComposition({ ...fixture(), members, activeMembers: 60 }, { sizeBands: true });
		for (const t of collectTables(b)) for (const c of t.cells) expect(c.n).toBeNull();
	});
});

describe("meetupBenchmarks", () => {
	it("counts only reliable check-ins in median_checkin_rate", () => {
		const b = meetupBenchmarks(fixture());
		// rates 0.75 and 0.5 -> median 0.625; the unreliable 0/200 event is excluded
		expect(b.preview.median_checkin_rate.value).toBe(0.625);
		expect(b.preview.median_checkin_rate.n).toBe(2);
		expect(b.preview.median_applied.value).toBe(300);
		expect(b.preview.events.value).toBe(3);
	});

	it("nulls checkedIn for unreliable events in full and keeps the rest as-is", () => {
		const full = meetupBenchmarks(fixture()).full as { events: EventRow[] };
		expect(full.events.map((e) => e.checkedIn)).toEqual([60, 50, null]);
		expect(full.events[0].city).toBe("Prague");
	});
});

describe("all snapshots", () => {
	it("stamps every Figure with the source as_of and its own method_id", () => {
		for (const b of allBodies(fixture())) {
			expect(b.as_of).toBe(AS_OF);
			for (const f of figures(b) as Figure[]) {
				expect(f.as_of).toBe(AS_OF);
				expect(f.method_id).toBe(b.method_id);
			}
		}
	});

	it("uses the reserved method URL", () => {
		for (const b of allBodies(fixture())) expect(b.method_url).toBe(`https://www.engineeringleaders.io/agents/methods/${b.method_id}/`);
	});

	it("serialises no company id, record id, email, suppression reason or flag", () => {
		for (const src of [fixture(), realistic(1000, 400), realistic(30, 20)]) {
			const json = JSON.stringify(allBodies(src));
			for (const word of ["companyId", "record_id", "email", "reason", "suppressed"]) expect(json).not.toContain(word);
			expect(json).not.toMatch(/co\d+|single-/);
		}
	});
});
