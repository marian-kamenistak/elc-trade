/**
 * Free data services: the signed member census and the registry-backed citation.
 *
 * Both are answered from stored facts, never computed on request: the census from the nightly
 * R2 snapshot, the citation from the vendored Data Points registry. Nothing in this file states
 * a figure of its own.
 */

import dataPointsFile from "../data/data-points.json";
import { readLatest } from "../data/snapshot-store";
import type { Figure } from "../data/types";
import type { ServiceResult } from "./types";

/** Why 72: the cron runs nightly, so three missed runs is the point where "latest" stops meaning latest. */
export const STALE_AFTER_HOURS = 72;

export interface CensusEnv {
	SNAPSHOTS?: R2Bucket;
}

const HOUR_MS = 3_600_000;

export async function censusHandler(_args: Record<string, unknown>, env?: CensusEnv): Promise<ServiceResult> {
	const source = "https://www.engineeringleaders.io/statistics/";
	const snapshot = env?.SNAPSHOTS ? await readLatest(env.SNAPSHOTS, "member_census") : null;

	if (!snapshot) {
		// A first deploy before the cron ran, a corrupt object, or a tampered one all land here.
		// A normal result with no figures, never a throw and never a guess.
		return {
			report: [
				"# ELC member census: not computed yet",
				"",
				"The nightly snapshot this answer is read from does not exist yet (or failed its integrity check), so there are no figures to return. Nothing has been charged. Try again after the next nightly run.",
			].join("\n"),
			source,
			verdict: "Not computed yet",
		};
	}

	// as_of is date-only, read as UTC midnight, so staleness is only accurate to +-24 h.
	// Parse failure must read as stale, never as fresh.
	const age = Date.now() - Date.parse(snapshot.as_of);
	const stale = !(age <= STALE_AFTER_HOURS * HOUR_MS);

	const lines = Object.entries(snapshot.preview).map(([key, f]: [string, Figure]) => {
		return `- ${key}: ${f.value} (n=${f.n} of ${f.denominator}, ${f.coverage_pct}% coverage)`;
	});

	return {
		report: [
			`# ELC member census, as of ${snapshot.as_of}`,
			"",
			stale
				? `**Stale:** this snapshot is more than ${STALE_AFTER_HOURS} hours old. The nightly job has not refreshed it; the figures are true as of ${snapshot.as_of}, not today.`
				: `Snapshot dated ${snapshot.as_of}.`,
			"",
			...lines,
			"",
			`Method: ${snapshot.method_url}`,
			"Cells under 10 members are suppressed. The signature covers the `data` object and verifies against the published JWKS.",
		].join("\n"),
		source,
		verdict: stale ? `Member census as of ${snapshot.as_of} (stale)` : `Member census as of ${snapshot.as_of}`,
		data: {
			figures: snapshot.preview,
			snapshot_id: `${snapshot.method_id}/${snapshot.as_of}`,
			snapshot_sha256: snapshot.sha256,
			stale,
			as_of: snapshot.as_of,
			method_url: snapshot.method_url,
		},
	};
}

// ── cite_benchmark ──────────────────────────────────────────────────────────

const CITE_SOURCE = "https://www.engineeringleaders.io/statistics/";

/**
 * The vendored file holds only the citable slice (src/data/citable-ids.json) and only
 * {label, value, display, verified, source_url}. Everything below sees nothing else, so a
 * non-allowlisted id is simply unknown: it cannot be looked up, suggested or searched.
 */
interface RegistryRow {
	label: string;
	value: unknown;
	display: string | null;
	verified: string;
	source_url?: string;
}

const REGISTRY = new Map<string, RegistryRow>(Object.entries((dataPointsFile as unknown as { rows: Record<string, RegistryRow> }).rows));

function citation(id: string, row: RegistryRow) {
	return {
		id,
		label: row.label,
		value: row.value,
		// A few rows have no display string; the raw value is the honest fallback.
		display: row.display ?? String(row.value),
		verified: row.verified,
		// The registry's free-text `source` stays private; a row without a public URL cites the page it is published on.
		source_url: row.source_url ?? CITE_SOURCE,
	};
}

function distance(a: string, b: string): number {
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = row;
	}
	return prev[b.length];
}

/** Deterministic: containment beats edit distance, then shorter id, then alphabetical. */
function nearestIds(raw: string, count: number): string[] {
	const q = raw.trim().toLowerCase();
	return [...REGISTRY.keys()]
		.map((id) => ({ id, d: q && id.toLowerCase().includes(q) ? 0 : distance(q, id.toLowerCase()) }))
		.sort((x, y) => x.d - y.d || x.id.length - y.id.length || (x.id < y.id ? -1 : 1))
		.slice(0, count)
		.map((x) => x.id);
}

function searchIds(query: string, count: number): string[] {
	const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
	if (!tokens.length) return [];
	return [...REGISTRY.entries()]
		.map(([id, row]) => {
			const hay = `${id} ${row.label}`.toLowerCase();
			return { id, score: tokens.filter((t) => hay.includes(t)).length };
		})
		.filter((x) => x.score > 0)
		.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1))
		.slice(0, count)
		.map((x) => x.id);
}

export function citeBenchmarkHandler(args: { id?: string; query?: string }): ServiceResult {
	if (args.id) {
		const row = REGISTRY.get(args.id.trim());
		if (row) {
			const c = citation(args.id.trim(), row);
			return {
				report: [
					`# ${c.label}`,
					"",
					`Value: ${c.display}`,
					`Source: ${c.source_url}`,
					`Last verified: ${c.verified}`,
					`Citation id: ${c.id}`,
				].join("\n"),
				source: CITE_SOURCE,
				verdict: `${c.display} (verified ${c.verified})`,
				data: { found: true, ...c },
			};
		}
		const nearest = nearestIds(args.id, 3);
		return {
			report: [`# No registry row with id "${args.id}"`, "", "Nothing was guessed. Nearest ids:", ...nearest.map((n) => `- ${n}: ${REGISTRY.get(n)!.label}`)].join("\n"),
			source: CITE_SOURCE,
			verdict: "Unknown citation id",
			data: { found: false, requested_id: args.id, nearest_ids: nearest },
		};
	}

	if (args.query) {
		const ids = searchIds(args.query, 3);
		return {
			report: ids.length
				? ["# Registry matches", "", ...ids.map((n) => `- ${n}: ${REGISTRY.get(n)!.label}`), "", "Call again with one of these as `id` to get the citation."].join("\n")
				: `# No registry rows match "${args.query}"`,
			source: CITE_SOURCE,
			verdict: ids.length ? `${ids.length} matching registry rows` : "No match",
			data: { found: false, query: args.query, matches: ids.map((n) => ({ id: n, label: REGISTRY.get(n)!.label })) },
		};
	}

	return {
		report: "# Pass an `id` (for example elc_community.members_live) or a `query` to search the registry.",
		source: CITE_SOURCE,
		verdict: "Needs an id or a query",
		data: { found: false, example_id: "elc_community.members_live" },
	};
}
