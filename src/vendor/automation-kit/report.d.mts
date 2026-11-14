// VENDORED from ops-automation-kit v1.1.1 (report.d.mts). Do not edit here: bump the kit and re-copy.
// Types for report.mjs (contract v2, REPORTING.md), so TypeScript consumers (strict, moduleResolution bundler/node16) can import it.
export type Status = "success" | "failed" | "timeout" | "killed" | "skipped" | "overdue" | "waiting" | "paused";
export type BottleneckKind = "cap" | "threshold" | "latency" | "backlog" | "rate_limit";
/** The step that limits throughput and why. `detail` is a noun phrase: "the weekly invite cap: 177 of 260". */
export interface Bottleneck { step: string; kind: BottleneckKind; detail: string }
/** Where a broken run stopped; the next run continues from here. */
export interface Checkpoint { step: string; cursor: string | number | Record<string, unknown> }
/** One step of a run: items in and out, how long, warnings. */
export interface StepSummary { n?: number; name: string; items_in?: number; items_out?: number; duration_s?: number; warnings?: string[]; detail?: string }
export interface ReportInput {
	job_id: string;
	status: Status;
	/** "start" and "step" send a live event instead of the end-of-run report; "end" or no event is the report. */
	event?: "start" | "step" | "end";
	run_id?: string;
	runtime?: string;
	source?: string;
	host?: string;
	finished_at?: string;
	started_at?: string | number;
	duration_s?: number;
	exit_code?: number;
	kpi?: string;
	kpi_pass?: "yes" | "no" | "n/a";
	detail?: string;
	url?: string;
	is_test?: boolean;
	// Contract v2 (all optional)
	/** End-to-end items carried from the first step to the last. */
	iterations?: number;
	bottleneck?: Bottleneck;
	checkpoint?: Checkpoint;
	warnings?: string[];
	errors?: string[];
	/** Commit or deploy id of the code that ran. */
	version?: string;
	/** What this run spent against the job's budget, in budget.unit. */
	usage?: number;
	usage_unit?: string;
	/** "critical" may ping at night: a sender or finance break, data loss. */
	severity?: "critical";
	steps?: StepSummary[];
}
export interface StepEventInput extends StepSummary { cursor?: string | number | Record<string, unknown> }
export interface ReportOptions {
	binding?: { fetch(input: string, init?: RequestInit): Promise<Response> };
	url?: string;
	token?: string;
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	timeoutMs?: number;
	run_id?: string;
	is_test?: boolean;
	runtime?: string;
	source?: string;
	host?: string;
	/** Only for checkUpstream: the oldest an upstream success may be, in hours. */
	max_age_h?: number;
}
export type ReportResult = { ok: true; status: number; run_id?: string } | { ok: false; error: string };
export interface PauseState { ok: boolean; paused: boolean; by?: string; why?: string; at?: string }
export interface UpstreamVerdict { id: string; ok: boolean; state: "healthy" | "failed" | "stale" | "paused" | "no_runs" | "unknown"; reason: string; last_success: string | null; age_h: number | null }
export interface UpstreamState { ok: boolean; waiting_on: string[]; reason: string; checked: UpstreamVerdict[]; unreachable?: boolean }
export type GateResult = { go: true } | { go: false; status: "paused" | "waiting"; detail: string };
export interface LiveRun {
	run_id: string;
	steps: StepEventInput[];
	step(s: StepEventInput): Promise<ReportResult>;
	end(status: Status, fields?: Partial<Omit<ReportInput, "job_id" | "status" | "run_id">>): Promise<ReportResult>;
}
export const STATUSES: Status[];
export const BOTTLENECK_KINDS: BottleneckKind[];
export function runIdFrom(...parts: unknown[]): Promise<string>;
export function v2Fields(input: Partial<ReportInput>): Record<string, unknown>;
export function buildBody(input: ReportInput, now?: Date): Record<string, unknown>;
export function buildEvent(input: { job_id: string; run_id: string; event: "start" | "step" } & Partial<StepEventInput> & { at?: string; is_test?: boolean }, now?: Date): Record<string, unknown>;
export function report(input: ReportInput | (StepEventInput & { job_id: string; run_id: string; event: "start" | "step" }), opts?: ReportOptions): Promise<ReportResult>;
export function checkPause(job_id: string, opts?: ReportOptions): Promise<PauseState>;
export function checkUpstream(ids: string | string[], opts?: ReportOptions): Promise<UpstreamState>;
export function loadCheckpoint(job_id: string, opts?: ReportOptions): Promise<{ step: string; cursor: string; run_id: string; at: string } | null>;
export function gate(job_id: string, check?: { depends_on?: string[]; max_age_h?: number }, opts?: ReportOptions): Promise<GateResult>;
export function startRun(job_id: string, opts?: ReportOptions): Promise<LiveRun>;
