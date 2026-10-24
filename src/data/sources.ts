import type { EventRow, MemberRow, SizeBand, SourceData } from "./types";

/**
 * Read-only loaders for the nightly snapshot: Attio (members, their people and companies, the
 * conference lists) and Luma (events and guest counts). Nothing here writes to either system.
 *
 * Why it is shaped this way:
 * - People and companies are resolved by `record_id $in` queries in batches of 100 (Attio rejects
 *   larger constraint lists), never by GETting each list entry's parent one by one.
 * - Every call either succeeds or throws. There is no soft-fail: a half-loaded member list would
 *   publish wrong numbers that look right, so the caller writes nothing when anything here throws.
 * - Only the fields the aggregation needs leave this file. Names, emails and record ids stay here;
 *   companyId goes out only for the dominance check and is never serialised by aggregate.ts.
 */

export interface SourcesEnv {
	ATTIO_TOKEN?: string;
	LUMA_API_KEY?: string;
}

const ATTIO = "https://api.attio.com/v2";
const LUMA = "https://public-api.luma.com/v1";
const TIMEOUT_MS = 30_000;
/** Attio's `$in` filter refuses somewhere between 100 and 200 values. */
const IN_BATCH = 100;
const PAGE = 500;
/** Luma allows 200 req/min per calendar key. */
const LUMA_PACE_MS = 350;
/** Ruling R19: an event that scanned fewer than 10 people did not really use the scanner. */
const CHECKIN_RELIABLE_MIN = 10;
/** Same definitions as community-os/attendance-data.md: "invited" is a calendar-wide invite, not a sign-up. */
const APPLIED_STATUSES = ["approved", "declined", "waitlist", "pending_approval"] as const;
const CONFERENCE_LISTS = [
	{ slug: "elc_conference_2025_attendees", year: 2025 },
	{ slug: "elc_conference_2026_attendees", year: 2026 },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Attio ──────────────────────────────────────────────────────────────────

type AttioValues = Record<string, Array<Record<string, any>> | undefined>;
interface AttioRecord {
	id?: { record_id?: string };
	values?: AttioValues;
}
interface AttioEntry {
	parent_record_id?: string;
	entry_values?: AttioValues;
}

async function attio<T>(token: string, path: string, body: unknown, retries = 4): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(`${ATTIO}${path}`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if ((res.status === 429 || res.status >= 500) && attempt < retries) {
			const reset = Number(res.headers.get("ratelimit-reset"));
			await sleep(Math.min(Number.isFinite(reset) && reset > 0 ? reset * 1000 : 2 ** attempt * 500, 30_000));
			continue;
		}
		const text = await res.text();
		if (!res.ok) throw new Error(`Attio POST ${path} -> ${res.status}: ${text.slice(0, 200)}`);
		return JSON.parse(text) as T;
	}
}

async function attioData<T>(token: string, path: string, body: unknown): Promise<T[]> {
	const { data } = await attio<{ data?: T[] }>(token, path, body);
	if (!Array.isArray(data)) throw new Error(`Attio POST ${path}: no data array`);
	return data;
}

/** Every row of a query endpoint, paged with limit/offset. */
async function queryAll<T>(token: string, path: string, filter?: unknown): Promise<T[]> {
	const out: T[] = [];
	for (let offset = 0; ; offset += PAGE) {
		const data = await attioData<T>(token, path, filter ? { limit: PAGE, offset, filter } : { limit: PAGE, offset });
		out.push(...data);
		if (data.length < PAGE) return out;
	}
}

/** Records by id, `$in` batches, a few in flight at a time. */
async function recordsById(token: string, object: string, ids: string[]): Promise<Map<string, AttioRecord>> {
	const batches: string[][] = [];
	for (let i = 0; i < ids.length; i += IN_BATCH) batches.push(ids.slice(i, i + IN_BATCH));
	const out = new Map<string, AttioRecord>();
	let next = 0;
	const worker = async () => {
		while (next < batches.length) {
			const batch = batches[next++];
			const rows = await attioData<AttioRecord>(token, `/objects/${object}/records/query`, {
				limit: IN_BATCH,
				filter: { record_id: { $in: batch } },
			});
			for (const r of rows) if (r.id?.record_id) out.set(r.id.record_id, r);
		}
	};
	await Promise.all(Array.from({ length: Math.min(4, batches.length) }, worker));
	return out;
}

const textValue = (v: AttioValues | undefined, slug: string): string | null => {
	const s = v?.[slug]?.[0]?.value;
	return typeof s === "string" && s.trim() ? s.trim() : null;
};

/** Attio `employee_range` option title → the published band. Anything unrecognised is "unknown". */
export function sizeBandOf(range: string | null | undefined): SizeBand {
	switch ((range ?? "").trim().toUpperCase()) {
		case "1-10":
		case "11-50":
			return "1-50";
		case "51-250":
			return "51-250";
		case "251-1K":
			return "251-1k";
		case "1K-5K":
		case "5K-10K":
		case "10K-50K":
		case "50K-100K":
		case "100K+":
			return "1k+";
		default:
			return "unknown";
	}
}

async function loadMembers(token: string): Promise<{ activeMembers: number; members: MemberRow[] }> {
	const entries = await queryAll<AttioEntry>(token, "/lists/elc_members/entries/query", { member_stage: "Active" });
	// Attio allows duplicate entries for one person; a member is a person, so count people.
	const ids = [...new Set(entries.map((e) => e.parent_record_id).filter((id): id is string => !!id))];
	if (ids.length === 0) throw new Error("Attio elc_members: no Active entries (option renamed?)");

	const people = await recordsById(token, "people", ids);
	const companyOf = (pid: string) => people.get(pid)?.values?.company?.[0]?.target_record_id as string | undefined;
	const companyIds = [...new Set(ids.map(companyOf).filter((id): id is string => !!id))];
	const companies = await recordsById(token, "companies", companyIds);

	const members = ids.map((pid): MemberRow => {
		const cid = companyOf(pid) ?? null;
		const co = cid ? companies.get(cid)?.values : undefined;
		const country = co?.primary_location?.[0]?.country_code;
		return {
			title: textValue(people.get(pid)?.values, "job_title"),
			sizeBand: sizeBandOf(co?.employee_range?.[0]?.option?.title),
			employerCountry: typeof country === "string" && country ? country : null,
			companyId: cid,
		};
	});
	return { activeMembers: ids.length, members };
}

async function loadConference(token: string): Promise<SourceData["conference"]> {
	const out: SourceData["conference"] = [];
	for (const { slug, year } of CONFERENCE_LISTS) {
		const entries = await queryAll<AttioEntry>(token, `/lists/${slug}/entries/query`);
		for (const e of entries) out.push({ year, position: textValue(e.entry_values, "position") });
	}
	return out;
}

// ── Luma ───────────────────────────────────────────────────────────────────

interface LumaEvent {
	api_id?: string;
	name?: string;
	start_at?: string;
	location_type?: string;
	max_capacity?: number | null;
	require_approval?: boolean | null;
	geo_address_json?: { city?: string | null } | null;
}

function lumaClient(key: string) {
	let last = 0;
	return async function lumaAll<T>(path: string, params: Record<string, string>): Promise<T[]> {
		const out: T[] = [];
		let cursor: string | undefined;
		for (;;) {
			const qs = new URLSearchParams(cursor ? { ...params, pagination_cursor: cursor } : params);
			let page: { entries?: T[]; has_more?: boolean; next_cursor?: string } | undefined;
			for (let attempt = 0; !page; attempt++) {
				const wait = LUMA_PACE_MS - (Date.now() - last);
				if (wait > 0) await sleep(wait);
				last = Date.now();
				const res = await fetch(`${LUMA}${path}?${qs}`, {
					headers: { "x-luma-api-key": key },
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
				if ((res.status === 429 || res.status >= 500) && attempt < 4) {
					await sleep(Math.min(2 ** attempt * 1000, 30_000));
					continue;
				}
				const body = await res.text();
				if (!res.ok) throw new Error(`Luma GET ${path} -> ${res.status}: ${body.slice(0, 200)}`);
				page = JSON.parse(body);
			}
			if (!Array.isArray(page.entries)) throw new Error(`Luma GET ${path}: no entries array`);
			out.push(...page.entries);
			if (!page.has_more) return out;
			if (!page.next_cursor) throw new Error(`Luma GET ${path}: has_more without next_cursor`);
			cursor = page.next_cursor;
		}
	};
}

/**
 * Benchmarks describe in-person meetups that already happened. Online webinars, the conference
 * (its own ticketing flow, only a handful of Luma sign-ups) and future events with registration
 * still open would each drag the medians somewhere meaningless.
 */
function isPastMeetup(e: LumaEvent, now: number): boolean {
	const start = e.start_at ? Date.parse(e.start_at) : Number.NaN;
	return Number.isFinite(start) && start < now && e.location_type === "offline" && !/conference/i.test(e.name ?? "");
}

async function loadEvents(key: string, now: number): Promise<EventRow[]> {
	const lumaAll = lumaClient(key);
	const listed = await lumaAll<{ event?: LumaEvent } & LumaEvent>("/calendar/list-events", {});
	const events = listed.map((x) => x.event ?? x).filter((e) => isPastMeetup(e, now));
	events.sort((a, b) => (a.start_at! < b.start_at! ? -1 : 1));

	const rows: EventRow[] = [];
	for (const e of events) {
		if (!e.api_id) throw new Error("Luma event without api_id");
		const counts: Record<string, number> = {};
		let checkedIn = 0;
		for (const status of APPLIED_STATUSES) {
			const guests = await lumaAll<{ guest?: { checked_in_at?: string | null }; checked_in_at?: string | null }>(
				"/event/get-guests",
				{ event_api_id: e.api_id, approval_status: status, pagination_limit: "50" },
			);
			counts[status] = guests.length;
			checkedIn += guests.filter((g) => (g.guest ?? g).checked_in_at).length;
		}
		const city = e.geo_address_json?.city;
		rows.push({
			date: e.start_at!.slice(0, 10),
			city: typeof city === "string" && city ? city : null,
			capacity: typeof e.max_capacity === "number" ? e.max_capacity : null,
			approvalRequired: e.require_approval === true,
			applied: APPLIED_STATUSES.reduce((s, k) => s + counts[k], 0),
			approved: counts.approved,
			waitlist: counts.waitlist,
			checkedIn,
			checkInReliable: checkedIn >= CHECKIN_RELIABLE_MIN,
		});
	}
	return rows;
}

// ── Entry point ────────────────────────────────────────────────────────────

export async function fetchSourceData(env: SourcesEnv, now: Date = new Date()): Promise<SourceData> {
	if (!env.ATTIO_TOKEN) throw new Error("ATTIO_TOKEN not set");
	if (!env.LUMA_API_KEY) throw new Error("LUMA_API_KEY not set");
	const [{ activeMembers, members }, conference, events] = await Promise.all([
		loadMembers(env.ATTIO_TOKEN),
		loadConference(env.ATTIO_TOKEN),
		loadEvents(env.LUMA_API_KEY, now.getTime()),
	]);
	return { asOf: now.toISOString().slice(0, 10), activeMembers, members, conference, events };
}
