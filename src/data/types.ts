/** Shared types for the nightly member-statistics pipeline. */

export type Seniority = "c_level_founder" | "vp" | "director_head" | "manager" | "lead_staff" | "ic" | "other";

/** Employee-count band collapsed from Attio `employee_range`; mapping is done upstream (Task 4). */
export type SizeBand = "1-50" | "51-250" | "251-1k" | "1k+" | "unknown";

export type MethodId = "member_census" | "leader_composition" | "meetup_benchmarks";

/** Every number returned to an agent carries its own denominator, coverage and provenance. */
export interface Figure {
	value: number;
	n: number;
	denominator: number;
	coverage_pct: number;
	as_of: string;
	method_id: MethodId;
}

/** One active member as the pipeline sees it. `companyId` feeds dominance only and is never serialised. */
export interface MemberRow {
	title: string | null;
	sizeBand: SizeBand;
	employerCountry: string | null;
	companyId: string | null;
}

export interface EventRow {
	date: string;
	city: string | null;
	capacity: number | null;
	approvalRequired: boolean;
	applied: number;
	approved: number;
	waitlist: number;
	checkedIn: number;
	checkInReliable: boolean;
}

export interface SourceData {
	asOf: string;
	activeMembers: number;
	members: MemberRow[];
	conference: { year: number; position: string | null }[];
	events: EventRow[];
}

export interface SnapshotBody {
	method_id: MethodId;
	as_of: string;
	method_url: string;
	preview: Record<string, Figure>;
	full: unknown;
}
