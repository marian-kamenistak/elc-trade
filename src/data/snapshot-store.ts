import { canonicalize, sha256Hex } from "../trust/jcs";
import { leaderComposition, meetupBenchmarks, memberCensus } from "./aggregate";
import { fetchSourceData, type SourcesEnv } from "./sources";
import type { MethodId, SnapshotBody, SourceData } from "./types";

/**
 * R2 store for the nightly snapshots. Each method keeps one dated file per run plus latest.json,
 * and every snapshot names the hash of the one before it, so a silently rewritten history shows
 * up as a broken chain. The hash covers the JCS-canonical body (everything except sha256 itself),
 * so it survives any re-serialisation. A missing, unparseable or tampered latest.json reads as
 * null: callers answer "not computed yet" and never throw.
 */

export interface StoredSnapshot extends SnapshotBody {
	generated_at: string;
	prev_sha256: string | null;
	sha256: string;
}

const datedKey = (method: MethodId, asOf: string) => `snapshots/${method}/${asOf}.json`;
const latestKey = (method: MethodId) => `snapshots/${method}/latest.json`;

function hashOf(snapshot: StoredSnapshot | Omit<StoredSnapshot, "sha256">): Promise<string> {
	const { sha256: _ignored, ...unsigned } = snapshot as StoredSnapshot;
	return sha256Hex(canonicalize(unsigned));
}

/** True when the stored sha256 still matches the body. False on any tampering, never throws. */
export async function verifySnapshot(snapshot: StoredSnapshot): Promise<boolean> {
	try {
		return typeof snapshot.sha256 === "string" && (await hashOf(snapshot)) === snapshot.sha256;
	} catch {
		return false;
	}
}

/**
 * The writer's view of the previous link. Unlike readLatest, only a genuinely absent object means
 * "no previous snapshot". A read error, an unparseable body or a failed hash throws, so a transient
 * R2 fault or a tampered latest.json stops the run and alerts instead of silently restarting the
 * chain and erasing the evidence.
 */
async function prevSha256(bucket: R2Bucket, method: MethodId): Promise<string | null> {
	const obj = await bucket.get(latestKey(method));
	if (!obj) return null;
	const text = await obj.text();
	let parsed: StoredSnapshot;
	try {
		parsed = JSON.parse(text) as StoredSnapshot;
	} catch {
		throw new Error(`snapshot chain: ${latestKey(method)} is not valid JSON`);
	}
	if (!parsed || typeof parsed !== "object" || parsed.method_id !== method || !(await verifySnapshot(parsed))) {
		throw new Error(`snapshot chain: ${latestKey(method)} fails hash verification`);
	}
	return parsed.sha256;
}

interface Prepared {
	stored: StoredSnapshot;
	text: string;
}

async function prepareSnapshot(bucket: R2Bucket, body: SnapshotBody): Promise<Prepared> {
	const unsigned: Omit<StoredSnapshot, "sha256"> = {
		...body,
		generated_at: new Date().toISOString(),
		prev_sha256: await prevSha256(bucket, body.method_id),
	};
	const stored: StoredSnapshot = { ...unsigned, sha256: await hashOf(unsigned) };
	return { stored, text: JSON.stringify(stored) };
}

async function putPrepared(bucket: R2Bucket, { stored, text }: Prepared): Promise<void> {
	const opts = { httpMetadata: { contentType: "application/json" } };
	await bucket.put(datedKey(stored.method_id, stored.as_of), text, opts);
	await bucket.put(latestKey(stored.method_id), text, opts);
}

/** Throws, writing nothing, when the previous latest.json cannot be read or does not verify. */
export async function writeSnapshot(bucket: R2Bucket, body: SnapshotBody): Promise<StoredSnapshot> {
	const prepared = await prepareSnapshot(bucket, body);
	await putPrepared(bucket, prepared);
	return prepared.stored;
}

export async function readLatest(bucket: R2Bucket, method: MethodId): Promise<StoredSnapshot | null> {
	try {
		const obj = await bucket.get(latestKey(method));
		if (!obj) return null;
		const parsed = JSON.parse(await obj.text()) as StoredSnapshot;
		if (!parsed || typeof parsed !== "object" || parsed.method_id !== method || typeof parsed.as_of !== "string") return null;
		return (await verifySnapshot(parsed)) ? parsed : null;
	} catch {
		return null;
	}
}

// ── Nightly job ────────────────────────────────────────────────────────────

export interface NightlyEnv extends SourcesEnv {
	SNAPSHOTS: R2Bucket;
	LEADER_SIZE_BANDS?: string;
	CONTROL_ROOM?: Fetcher;
	CONTROL_ROOM_TOKEN?: string;
	/** Test only: `wrangler deploy --var REPORT_JOB_ID:zz-...` files the run report under a zz- id. */
	REPORT_JOB_ID?: string;
}

/**
 * Fetch, aggregate all three, link all three to their chains, then write. Everything that can fail
 * on bad input runs before the first put, so a loader, suppression or chain failure leaves
 * yesterday's snapshots untouched rather than publishing a partial set.
 * Ruling R18: any failure is logged and nothing is written; nightlyScheduled reports the run as `failed` to
 * control-room, which pages #warning-bot once (merge S5, 2026-11-14: this function no longer posts to Slack
 * itself, so one break is one alert). `onFailure` receives the stage name for the run report. Never throws.
 */
export async function runNightlySnapshots(
	env: NightlyEnv,
	load: (env: SourcesEnv) => Promise<SourceData> = fetchSourceData,
	onFailure: (stage: string) => void = () => {},
): Promise<StoredSnapshot[] | null> {
	let bodies: SnapshotBody[];
	try {
		const src = await load(env);
		bodies = [memberCensus(src), leaderComposition(src, { sizeBands: env.LEADER_SIZE_BANDS === "1" }), meetupBenchmarks(src)];
	} catch (err) {
		reportFailure("fetch/aggregate", err, onFailure);
		return null;
	}
	const prepared: Prepared[] = [];
	try {
		for (const body of bodies) prepared.push(await prepareSnapshot(env.SNAPSHOTS, body));
	} catch (err) {
		reportFailure("snapshot chain", err, onFailure);
		return null;
	}
	try {
		for (const p of prepared) await putPrepared(env.SNAPSHOTS, p);
		return prepared.map((p) => p.stored);
	} catch (err) {
		reportFailure("R2 write", err, onFailure);
		return null;
	}
}

/** The Worker's `scheduled` handler. Awaited, never waitUntil (R23): the run must finish inside it. */
export async function nightlyScheduled(controller: ScheduledController, env: NightlyEnv, _ctx: ExecutionContext): Promise<void> {
	const started = Date.now();
	let failedStage = "";
	const stored = await runNightlySnapshots(env, undefined, (stage) => { failedStage = stage; });
	await reportRun(env, controller.scheduledTime ?? started, started, stored, failedStage);
}

/**
 * Every nightly run lands in control-room (automation-visibility R-W, 2026-10-26) through the
 * CONTROL_ROOM service binding: a same-account workers.dev fetch 404s. Awaited like the run (R23).
 * Never throws: a report failure must not touch the snapshots.
 */
async function reportRun(env: NightlyEnv, scheduledTime: number, started: number, stored: StoredSnapshot[] | null, failedStage = ""): Promise<void> {
	if (!env.CONTROL_ROOM || !env.CONTROL_ROOM_TOKEN) {
		// No Slack fallback since merge S5: a failure with no binding is not paged by anything, so say so in the log.
		if (!stored) console.error("[elc-trade snapshots] FAILED run not reported: CONTROL_ROOM binding or token missing");
		return;
	}
	const job = env.REPORT_JOB_ID || "elc-trade";
	try {
		const res = await env.CONTROL_ROOM.fetch("https://control-room/report", {
			method: "POST",
			headers: { "content-type": "application/json", "x-report-token": env.CONTROL_ROOM_TOKEN },
			body: JSON.stringify({
				run_id: `${job}:${scheduledTime}`,
				job_id: job,
				status: stored ? "success" : "failed",
				runtime: "worker",
				source: "worker",
				host: "elc-trade",
				finished_at: new Date().toISOString(),
				duration_s: (Date.now() - started) / 1000,
				exit_code: stored ? 0 : 1,
				kpi: `${stored?.length ?? 0} snapshots written`,
				kpi_pass: stored ? "yes" : "no",
				detail: stored
					? stored.map((s) => `${s.method_id} ${s.as_of}`).join(", ")
					: `nightly snapshots failed at ${failedStage || "an unknown stage"}, nothing new written; the error is in the Worker log`,
			}),
		});
		if (!res.ok) console.error(`[elc-trade snapshots] run report failed: HTTP ${res.status}`);
	} catch (e) {
		console.error(`[elc-trade snapshots] run report failed: ${String(e).slice(0, 200)}`);
	}
}

function reportFailure(stage: string, err: unknown, onFailure: (stage: string) => void): void {
	const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
	const outcome = stage === "R2 write" ? "earlier methods may hold today's file" : "nothing was written";
	console.error(`[elc-trade snapshots] ${stage} failed, ${outcome}: ${msg}`);
	onFailure(stage);
}
