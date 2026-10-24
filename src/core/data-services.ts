/**
 * Free data services: the signed member census and the registry-backed citation.
 *
 * Both are answered from stored facts, never computed on request: the census from the nightly
 * R2 snapshot, the citation from the vendored Data Points registry. Nothing in this file states
 * a figure of its own.
 */

import dataPointsFile from "../data/data-points.json";
import { readLatest, type StoredSnapshot } from "../data/snapshot-store";
import type { Figure, MethodId } from "../data/types";
import { sha256Hex } from "../trust/jcs";
import type { PaidOutcome } from "../paid";
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

// ── Paid products: get_leader_composition, get_meetup_benchmarks ─────────────

/** Service id → snapshot method. The only ids src/paid.ts may charge for. */
export const PAID_METHODS: Readonly<Record<string, MethodId>> = {
	get_leader_composition: "leader_composition",
	get_meetup_benchmarks: "meetup_benchmarks",
};

/** Own-key lookup, so an id like "constructor" can never read as a paid product. */
export function paidMethodOf(id: string): MethodId | undefined {
	return Object.prototype.hasOwnProperty.call(PAID_METHODS, id) ? PAID_METHODS[id] : undefined;
}

/** v1 takes payment only on the MCP door: mppx has an MCP SDK transport, A2A has no payment concept (08). */
export const PAY_VIA = "https://www.engineeringleaders.io/mcp/trade";

/**
 * The Monetization Gateway door (src/data-http.ts): one canonical URL per product, which is also the
 * JWT `aud` and the dashboard rule's URL. www, no trailing slash, no query: exactly one string each.
 */
export const DATA_SLUG = { "leader-composition": "leader_composition", "meetup-benchmarks": "meetup_benchmarks" } as const;
export const DATA_URL = {
	leader_composition: "https://www.engineeringleaders.io/mcp/trade/data/leader-composition",
	meetup_benchmarks: "https://www.engineeringleaders.io/mcp/trade/data/meetup-benchmarks",
} as const;

const PAID_TITLE: Record<string, string> = {
	get_leader_composition: "ELC leader composition",
	get_meetup_benchmarks: "ELC meetup benchmarks",
};

const PREVIEW_NOTE: Record<Exclude<PaidOutcome, { kind: "paid" }>["reason"], string> = {
	disabled: "The paid route is switched off, so this is the free preview only. Nothing has been charged.",
	no_snapshot: "Nothing has been charged.",
	payment_required: "The full answer needs a payment over MPP; the challenge is in this result's `_meta`. An MPP-aware MCP client pays and retries automatically. Nothing has been charged yet.",
	rate_limited: "Too many paid calls from this payer in the last minute. Nothing has been charged; try again shortly.",
};

/** The HTTP door's preview is only ever an unpaid or unverified request; the 402 body carries the reason. */
const GATEWAY_NOTE = "This request carried no valid payment, so this is the free preview. Pay with x402 through the Cloudflare Monetization Gateway, which charges at the edge on this URL. Nothing has been charged.";

/** Composition preview: titled count plus top-line seniority shares from the already-suppressed 1-D marginal. */
function compositionPreview(s: StoredSnapshot): Record<string, Figure> {
	const out: Record<string, Figure> = {};
	const titled = s.preview.titled;
	if (!titled) return out;
	out.titled = titled;
	const full = s.full as { tables?: Record<string, { marginals?: Record<string, { value: string; n: number | null }[] | null> }> };
	const marginal = full?.tables?.seniority_x_employer_country?.marginals?.seniority ?? [];
	for (const c of marginal) {
		// A suppressed cell (n null) stays out entirely; a share of a hidden count is the hidden count.
		if (c.n === null || titled.n <= 0) continue;
		out[`seniority_share.${c.value}`] = {
			value: Math.round((c.n / titled.n) * 1000) / 10,
			n: c.n,
			denominator: titled.n,
			coverage_pct: titled.coverage_pct,
			as_of: s.as_of,
			method_id: s.method_id,
		};
	}
	return out;
}

/** The full answer: the suppressed tables, or the per-event rows, exactly as the snapshot stored them. */
function fullOf(id: string, s: StoredSnapshot): unknown {
	return id === "get_meetup_benchmarks" ? { events: (s.full as { events?: unknown[] })?.events ?? [] } : s.full;
}

/**
 * Answers a paid id from its snapshot. `outcome` is what src/paid.ts decided on the MCP door;
 * absent means a door with no payment (A2A), which gets the preview and where to pay.
 * license_id goes inside `data`, so dispatch's signature covers it.
 *
 * `snapshot`, when passed (null included), is used instead of reading R2: the HTTP door reads once
 * and answers "not computed yet" or the full answer from that same object.
 */
export async function paidDataHandler(
	id: string,
	env: (CensusEnv & { PAYMENT_GATEWAY_ENABLED?: string }) | undefined,
	opts: { transport: "a2a" | "mcp" | "http"; outcome?: PaidOutcome; amountUsd?: number; snapshot?: StoredSnapshot | null },
): Promise<ServiceResult> {
	const method = paidMethodOf(id);
	const title = PAID_TITLE[id] ?? id;
	const source = "https://www.engineeringleaders.io/statistics/";
	const amountUsd = opts.amountUsd ?? 0.5;
	// A paid answer uses the snapshot the gate checked before charging; only previews read R2.
	const snapshot =
		opts.outcome?.kind === "paid"
			? opts.outcome.snapshot
			: opts.snapshot !== undefined
				? opts.snapshot
				: env?.SNAPSHOTS && method
					? await readLatest(env.SNAPSHOTS, method)
					: null;

	if (!snapshot) {
		return {
			report: [
				`# ${title}: not computed yet`,
				"",
				"The nightly snapshot this answer is read from does not exist yet (or failed its integrity check), so there are no figures to return. Nothing has been charged. Try again after the next nightly run.",
			].join("\n"),
			source,
			verdict: "Not computed yet",
		};
	}

	const age = Date.now() - Date.parse(snapshot.as_of);
	const stale = !(age <= STALE_AFTER_HOURS * HOUR_MS);
	const figures = id === "get_leader_composition" ? compositionPreview(snapshot) : snapshot.preview;
	const lines = Object.entries(figures).map(([key, f]) => `- ${key}: ${f.value} (n=${f.n} of ${f.denominator}, ${f.coverage_pct}% coverage)`);
	const common = {
		figures,
		snapshot_id: `${snapshot.method_id}/${snapshot.as_of}`,
		snapshot_sha256: snapshot.sha256,
		stale,
		as_of: snapshot.as_of,
		method_url: snapshot.method_url,
	};
	const dated = stale
		? `**Stale:** this snapshot is more than ${STALE_AFTER_HOURS} hours old. The figures are true as of ${snapshot.as_of}, not today.`
		: `Snapshot dated ${snapshot.as_of}.`;

	if (opts.outcome?.kind === "paid") {
		const license_id = (await sha256Hex(`${opts.outcome.payer}:${snapshot.method_id}:${snapshot.as_of}`)).slice(0, 16);
		return {
			report: [
				`# ${title}, as of ${snapshot.as_of} (full answer)`,
				"",
				dated,
				"",
				...lines,
				"",
				"The full table is in `data.full`. Cells under 10 are suppressed, and so is any cell one company dominates.",
				`License ${license_id}, bound to the paying identity and this snapshot. Receipt ${opts.outcome.receiptId}.`,
				`Method: ${snapshot.method_url}`,
			].join("\n"),
			source,
			verdict: `${title} as of ${snapshot.as_of}${stale ? " (stale)" : ""}, paid`,
			data: { ...common, full: fullOf(id, snapshot), license_id, receipt_id: opts.outcome.receiptId },
		};
	}

	const note =
		opts.transport === "http"
			? GATEWAY_NOTE
			: opts.outcome
				? PREVIEW_NOTE[opts.outcome.reason]
				: `Pay for the full answer at ${PAY_VIA} (MCP). This door takes no payment. Nothing has been charged.`;
	// Gateway mode only: the MCP preview also names the HTTPS URL an x402 client can buy from.
	const buy_url = opts.transport === "mcp" && env?.PAYMENT_GATEWAY_ENABLED === "1" && method && method in DATA_URL ? DATA_URL[method as keyof typeof DATA_URL] : undefined;
	return {
		report: [
			`# ${title}, as of ${snapshot.as_of} (free preview)`,
			"",
			dated,
			"",
			...lines,
			"",
			`The full answer is $${amountUsd.toFixed(2)} per call over ${opts.transport === "http" ? "x402 (Cloudflare Monetization Gateway)" : "MPP"}. ${note}`,
			...(buy_url ? [`Or buy it over HTTPS with x402: GET ${buy_url}`] : []),
			`Method: ${snapshot.method_url}`,
		].join("\n"),
		source,
		verdict: `${title} as of ${snapshot.as_of}${stale ? " (stale)" : ""}, preview`,
		data: {
			...common,
			price: { model: "metered", amount_usd: amountUsd, per: "call" },
			...(opts.transport === "a2a" ? { pay_via: PAY_VIA } : {}),
			...(buy_url ? { buy_url } : {}),
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
