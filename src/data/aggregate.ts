import { classifySeniority } from "./seniority";
import { isMarginalPublishable, K_MIN, DOMINANCE_MAX_SHARE, publicCells, suppressGrid, type RawCell } from "./suppress";
import type { EventRow, Figure, MemberRow, MethodId, SnapshotBody, SourceData } from "./types";

/**
 * Turns the raw member and event lists into the three published snapshots. Everything that leaves
 * this file is counts behind the suppression rules in suppress.ts: categories under K_MIN are merged
 * into their catch-all first (so sparse tails do not force whole rows to be hidden), each table is
 * suppressed on a dense grid with its 1-D marginals, and a marginal is published only when
 * `isMarginalPublishable` says it cannot unmask a hidden cell. If a table cannot be made safe it is
 * withheld and only its safe 1-D marginals go out; nothing here throws. Only `publicCells` output is
 * serialised, so no reason, company id or member field can reach a snapshot. Pure, no I/O.
 */

const SENIORITY_ORDER = ["c_level_founder", "vp", "director_head", "manager", "lead_staff", "ic", "other"];
const COUNTRY_ORDER = ["CZ", "SK", "PL", "other", "unknown"];
const SIZE_ORDER = ["1-50", "51-250", "251-1k", "1k+", "unknown"];

interface Row {
	dims: Record<string, string>;
	company: string;
}

interface Marginal {
	value: string;
	n: number | null;
}

interface Table {
	dimensions: [string, string];
	table_withheld: boolean;
	cells: { key: Record<string, string>; n: number | null }[];
	marginals: Record<string, Marginal[] | null>;
}

const methodUrl = (id: MethodId) => `https://www.engineeringleaders.io/agents/methods/${id}/`;
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const pct = (num: number, den: number) => (den > 0 ? round(Math.min(100, (num / den) * 100), 1) : 0);

function figure(value: number, n: number, denominator: number, coverage: number, src: SourceData, method: MethodId): Figure {
	return { value, n, denominator, coverage_pct: coverage, as_of: src.asOf, method_id: method };
}

function countryOf(m: MemberRow): string {
	const c = m.employerCountry?.trim().toUpperCase();
	if (!c) return "unknown";
	return c === "CZ" || c === "SK" || c === "PL" ? c : "other";
}

/** A member with no company id counts as their own company, so they can never dominate a cell. */
function toRows(members: MemberRow[], dims: (m: MemberRow, seniority: string | null) => Record<string, string> | null): Row[] {
	const out: Row[] = [];
	members.forEach((m, i) => {
		const d = dims(m, classifySeniority(m.title));
		if (d) out.push({ dims: d, company: m.companyId ?? `\u0000single-${i}` });
	});
	return out;
}

function sortValues(values: Iterable<string>, order?: string[]): string[] {
	const idx = (v: string) => (order && order.includes(v) ? order.indexOf(v) : order ? order.length : 0);
	return [...new Set(values)].sort((a, b) => idx(a) - idx(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Merge every category of `dim` whose total is under K_MIN into the catch-all (null = never merge). */
function mergeSmall(rows: Row[], dim: string, catchAll: string | null): Row[] {
	if (!catchAll) return rows;
	const totals = new Map<string, number>();
	for (const r of rows) totals.set(r.dims[dim], (totals.get(r.dims[dim]) ?? 0) + 1);
	return rows.map((r) => ((totals.get(r.dims[dim]) ?? 0) < K_MIN ? { ...r, dims: { ...r.dims, [dim]: catchAll } } : r));
}

function rawCell(key: Record<string, string>, rows: Row[]): RawCell {
	const companyCounts: Record<string, number> = {};
	for (const r of rows) companyCounts[r.company] = (companyCounts[r.company] ?? 0) + 1;
	return { key, n: rows.length, companyCounts };
}

/** A marginal total is itself a count: it needs K_MIN people and no majority company. */
function marginalSafe(rows: Row[]): boolean {
	if (rows.length < K_MIN) return false;
	const raw = rawCell({}, rows);
	return Math.max(...Object.values(raw.companyCounts)) / raw.n <= DOMINANCE_MAX_SHARE;
}

/** 1-D table with its own total treated as published, so no hidden cell is recoverable. null = not publishable. */
function oneD(rows: Row[], dim: string, catchAll: string | null, order?: string[]): Marginal[] | null {
	const merged = mergeSmall(rows, dim, catchAll);
	const values = sortValues(merged.map((r) => r.dims[dim]), order);
	const raws = values.map((v) => rawCell({ [dim]: v }, merged.filter((r) => r.dims[dim] === v)));
	try {
		const pub = suppressGrid(raws, [[]]);
		return publicCells(pub).map((c) => ({ value: c.key[dim], n: c.n }));
	} catch {
		return null;
	}
}

function twoD(rows: Row[], a: [string, string | null, string[] | undefined], b: [string, string | null, string[] | undefined]): Table {
	const [dimA, catchA, orderA] = a;
	const [dimB, catchB, orderB] = b;
	const merged = mergeSmall(mergeSmall(rows, dimA, catchA), dimB, catchB);
	const valsA = sortValues(merged.map((r) => r.dims[dimA]), orderA);
	const valsB = sortValues(merged.map((r) => r.dims[dimB]), orderB);
	const raws: RawCell[] = [];
	for (const va of valsA) {
		for (const vb of valsB) {
			raws.push(rawCell({ [dimA]: va, [dimB]: vb }, merged.filter((r) => r.dims[dimA] === va && r.dims[dimB] === vb)));
		}
	}
	const dimensions: [string, string] = [dimA, dimB];
	try {
		const pub = suppressGrid(raws, [[dimA], [dimB]]);
		const marginal = (dim: string, vals: string[]): Marginal[] =>
			vals.map((v) => {
				const group = merged.filter((r) => r.dims[dim] === v);
				const ok = isMarginalPublishable(pub, raws, { [dim]: v }) && marginalSafe(group);
				return { value: v, n: ok ? group.length : null };
			});
		const mA = marginal(dimA, valsA);
		const mB = marginal(dimB, valsB);
		// A nulled marginal (dominated company) is a hidden value that titled minus the other marginals
		// recovers, and the table's secondary choice would differ from the census's. Withhold, so every
		// body takes the same 1-D suppression decision.
		if ([...mA, ...mB].some((m) => m.n === null)) throw new Error("unsafe marginal: withhold");
		return { dimensions, table_withheld: false, cells: publicCells(pub), marginals: { [dimA]: mA, [dimB]: mB } };
	} catch {
		return {
			dimensions,
			table_withheld: true,
			cells: [],
			marginals: { [dimA]: oneD(rows, dimA, catchA, orderA), [dimB]: oneD(rows, dimB, catchB, orderB) },
		};
	}
}

export function memberCensus(src: SourceData): SnapshotBody {
	const method: MethodId = "member_census";
	const active = src.activeMembers;
	const titledRows = toRows(src.members, (m, s) => (s ? { seniority: s } : null));
	const countryRows = toRows(src.members, (m) => ({ employer_country: countryOf(m) }));
	const titled = titledRows.length;
	const titledCoverage = pct(titled, active);
	const countryCoverage = pct(src.members.length, active);

	const seniority = oneD(titledRows, "seniority", "other", SENIORITY_ORDER);
	const country = oneD(countryRows, "employer_country", "other", COUNTRY_ORDER);

	const preview: Record<string, Figure> = {
		active_members: figure(active, active, active, 100, src, method),
		titled: figure(titled, titled, active, titledCoverage, src, method),
	};
	for (const c of seniority ?? []) if (c.n !== null) preview[`seniority.${c.value}`] = figure(c.n, c.n, active, titledCoverage, src, method);
	for (const c of country ?? []) if (c.n !== null) preview[`employer_country.${c.value}`] = figure(c.n, c.n, active, countryCoverage, src, method);

	return {
		method_id: method,
		as_of: src.asOf,
		method_url: methodUrl(method),
		preview,
		full: {
			active_members: active,
			titled,
			titled_coverage_pct: titledCoverage,
			seniority: seniority ?? { withheld: true },
			employer_country: country ?? { withheld: true },
		},
	};
}

export function leaderComposition(src: SourceData, opts: { sizeBands: boolean }): SnapshotBody {
	const method: MethodId = "leader_composition";
	const active = src.activeMembers;
	const sen: [string, string | null, string[] | undefined] = ["seniority", "other", SENIORITY_ORDER];
	const titledRows = toRows(src.members, (m, s) => (s ? { seniority: s, size_band: m.sizeBand, employer_country: countryOf(m) } : null));
	const confRows: Row[] = [];
	src.conference.forEach((p, i) => {
		const s = classifySeniority(p.position);
		if (s) confRows.push({ dims: { seniority: s, year: String(p.year) }, company: `\u0000speaker-${i}` });
	});

	const full: Record<string, unknown> = {
		titled: titledRows.length,
		titled_coverage_pct: pct(titledRows.length, active),
	};
	const tables: Record<string, Table> = {};
	if (opts.sizeBands) tables.seniority_x_size_band = twoD(titledRows, sen, ["size_band", "unknown", SIZE_ORDER]);
	tables.seniority_x_employer_country = twoD(titledRows, sen, ["employer_country", "other", COUNTRY_ORDER]);
	full.tables = tables;
	full.conference = { titled: confRows.length, tables: { seniority_x_year: twoD(confRows, sen, ["year", null, undefined]) } };

	const titled = titledRows.length;
	return {
		method_id: method,
		as_of: src.asOf,
		method_url: methodUrl(method),
		preview: { titled: figure(titled, titled, active, pct(titled, active), src, method) },
		full,
	};
}

function median(xs: number[]): number | null {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function meetupBenchmarks(src: SourceData): SnapshotBody {
	const method: MethodId = "meetup_benchmarks";
	const events: EventRow[] = src.events;
	const total = events.length;
	const preview: Record<string, Figure> = { events: figure(total, total, total, 100, src, method) };

	const add = (key: string, value: number | null, n: number, digits: number) => {
		if (value !== null) preview[key] = figure(round(value, digits), n, total, pct(n, total), src, method);
	};
	add("median_applied", median(events.map((e) => e.applied)), total, 1);
	add("median_approved", median(events.map((e) => e.approved)), total, 1);
	// Check-in is a fraction (0..1) of approved guests, over events whose scanner was actually used.
	const reliable = events.filter((e) => e.checkInReliable && e.approved > 0);
	add("median_checkin_rate", median(reliable.map((e) => e.checkedIn / e.approved)), reliable.length, 3);

	return {
		method_id: method,
		as_of: src.asOf,
		method_url: methodUrl(method),
		preview,
		full: {
			// Named fields only: an extra loader field (host email, say) can never reach the snapshot.
			events: events.map((e) => ({
				date: e.date,
				city: e.city,
				capacity: e.capacity,
				approvalRequired: e.approvalRequired,
				applied: e.applied,
				approved: e.approved,
				waitlist: e.waitlist,
				checkedIn: e.checkInReliable ? e.checkedIn : null,
				checkInReliable: e.checkInReliable,
			})),
		},
	};
}
