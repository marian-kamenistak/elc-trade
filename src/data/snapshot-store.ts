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
	SLACK_BOT_TOKEN_ELC?: string;
	WARNING_SLACK_CHANNEL?: string;
}

/**
 * Fetch, aggregate all three, link all three to their chains, then write. Everything that can fail
 * on bad input runs before the first put, so a loader, suppression or chain failure leaves
 * yesterday's snapshots untouched rather than publishing a partial set.
 * Ruling R18: any failure is logged, nothing is written, and #m-warning-bot gets one message, so a
 * silently stale snapshot cannot go unnoticed. Never throws.
 */
export async function runNightlySnapshots(
	env: NightlyEnv,
	load: (env: SourcesEnv) => Promise<SourceData> = fetchSourceData,
): Promise<StoredSnapshot[] | null> {
	let bodies: SnapshotBody[];
	try {
		const src = await load(env);
		bodies = [memberCensus(src), leaderComposition(src, { sizeBands: env.LEADER_SIZE_BANDS === "1" }), meetupBenchmarks(src)];
	} catch (err) {
		await reportFailure(env, "fetch/aggregate", err);
		return null;
	}
	const prepared: Prepared[] = [];
	try {
		for (const body of bodies) prepared.push(await prepareSnapshot(env.SNAPSHOTS, body));
	} catch (err) {
		await reportFailure(env, "snapshot chain", err);
		return null;
	}
	try {
		for (const p of prepared) await putPrepared(env.SNAPSHOTS, p);
		return prepared.map((p) => p.stored);
	} catch (err) {
		await reportFailure(env, "R2 write", err);
		return null;
	}
}

/** The Worker's `scheduled` handler. Awaited, never waitUntil (R23): the run must finish inside it. */
export async function nightlyScheduled(_controller: ScheduledController, env: NightlyEnv, _ctx: ExecutionContext): Promise<void> {
	await runNightlySnapshots(env);
}

async function reportFailure(env: NightlyEnv, stage: string, err: unknown): Promise<void> {
	const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
	const outcome = stage === "R2 write" ? "earlier methods may hold today's file" : "nothing was written";
	console.error(`[elc-trade snapshots] ${stage} failed, ${outcome}: ${msg}`);
	const token = env.SLACK_BOT_TOKEN_ELC;
	const channel = env.WARNING_SLACK_CHANNEL;
	if (!token || !channel) return;
	const text = `:warning: *elc-trade nightly snapshots failed* (${stage}): ${outcome}; agents keep getting the previous snapshot.\n\`${msg}\``;
	const post = () =>
		fetch("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
			body: JSON.stringify({ channel, text, unfurl_links: false }),
		});
	try {
		// Slack answers HTTP 200 on failure: data.ok is the truth.
		const data = (await (await post()).json()) as { ok?: boolean; error?: string };
		if (!data.ok && data.error === "not_in_channel") {
			await fetch("https://slack.com/api/conversations.join", {
				method: "POST",
				headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
				body: JSON.stringify({ channel }),
			});
			await post();
		} else if (!data.ok) {
			console.error(`[elc-trade snapshots] Slack alert failed: ${data.error}`);
		}
	} catch (e) {
		console.error(`[elc-trade snapshots] Slack alert failed: ${String(e).slice(0, 200)}`);
	}
}
