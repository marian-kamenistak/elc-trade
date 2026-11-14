// VENDORED from ops-automation-kit v1.1.1 (report.mjs). Do not edit here: bump the kit and re-copy.
// One line differs from the kit: DEFAULT_URL is blank (the Worker always reports through the CONTROL_ROOM service binding, never a URL).
// report.mjs — run reports to control-room (POST /report), contract v2. Never throws, never prints a secret.
// Full contract: REPORTING.md next to this file.
//
//   import { report, startRun, gate } from "automation-kit/report";
//   // Worker (service binding; a same-account workers.dev fetch 404s):
//   const opts = { binding: env.CONTROL_ROOM, token: env.CONTROL_ROOM_TOKEN };
//   const g = await gate("my-job", { depends_on: ["data-points-sync"], max_age_h: 26 }, opts);     // pause flag + upstream, fail open
//   if (!g.go) return report({ job_id: "my-job", status: g.status, detail: g.detail }, opts);       // paused / waiting, never a failure
//   const run = await startRun("my-job", opts);                                                      // start event, run_id
//   await run.step({ name: "fetch", items_in: 0, items_out: 50, cursor: "row-50" });                 // step event (+ checkpoint)
//   await run.end("success", { kpi: "12 sent", kpi_pass: "yes", iterations: 12, bottleneck: { step: "send", kind: "cap", detail: "the weekly invite cap: 177 of 260" }, version: "abc1234" });
//   // Node on the Mac / CI (reads CONTROL_ROOM_URL + CONTROL_ROOM_TOKEN from process.env when not passed):
//   await report({ job_id: "my-job", status: "failed", detail: String(err) });
//
// A v1 body ({job_id, status, kpi, kpi_pass, detail, ...}) is still valid: every v2 field is optional.
import { redact } from "./redact.mjs";

export const STATUSES = ["success", "failed", "timeout", "killed", "skipped", "overdue", "waiting", "paused"];
export const BOTTLENECK_KINDS = ["cap", "threshold", "latency", "backlog", "rate_limit"];
const DEFAULT_URL = "https://control-room.invalid";

/** Deterministic hex id (SHA-256 of the parts) — use as run_id so retries/duplicates dedupe. */
export async function runIdFrom(...parts) {
	const data = new TextEncoder().encode(parts.map((p) => String(p ?? "")).join("\u001f"));
	const hash = await globalThis.crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(hash)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const int = (v) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) || Number(v) < 0 ? undefined : Math.round(Number(v)));
const list = (v, max = 20, each = 300) => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? [v] : []).filter((x) => x !== null && x !== undefined && String(x).trim()).slice(0, max).map((x) => redact(String(x)).slice(0, each));

/** The v2 fields of a body, validated and redacted. Pure. Invalid pieces are dropped, never thrown. */
export function v2Fields(b) {
	const out = {};
	const it = int(b.iterations);
	if (it !== undefined) out.iterations = it;
	const bn = b.bottleneck;
	if (bn && typeof bn === "object" && BOTTLENECK_KINDS.includes(bn.kind)) out.bottleneck = { step: redact(String(bn.step ?? "")).slice(0, 80), kind: bn.kind, detail: redact(String(bn.detail ?? "")).slice(0, 300) };
	const cp = b.checkpoint;
	if (cp && typeof cp === "object" && String(cp.step ?? "").trim()) out.checkpoint = { step: redact(String(cp.step)).slice(0, 80), cursor: redact(typeof cp.cursor === "string" ? cp.cursor : JSON.stringify(cp.cursor ?? "")).slice(0, 500) };
	const w = list(b.warnings), e = list(b.errors);
	if (w.length) out.warnings = w;
	if (e.length) out.errors = e;
	if (b.version) out.version = redact(String(b.version)).slice(0, 80);
	const u = Number(b.usage ?? b.usage_amount);
	if (b.usage !== undefined || b.usage_amount !== undefined) if (Number.isFinite(u) && u >= 0) { out.usage_amount = u; out.usage_unit = String(b.usage_unit ?? "").slice(0, 30); }
	if (String(b.severity ?? "").toLowerCase() === "critical") out.severity = "critical";
	if (Array.isArray(b.steps)) {
		out.steps = b.steps.slice(0, 60).map((s, i) => ({
			n: int(s?.n) ?? i + 1, name: redact(String(s?.name ?? "")).slice(0, 120), items_in: int(s?.items_in), items_out: int(s?.items_out),
			duration_s: Number.isFinite(Number(s?.duration_s)) ? Number(s.duration_s) : undefined, warnings: list(s?.warnings, 10, 200), detail: redact(String(s?.detail ?? "")).slice(0, 300),
		})).filter((s) => s.name);
	}
	return out;
}

/** The JSON body control-room expects, defaults filled, text redacted. Pure. */
export function buildBody(input, now = new Date()) {
	const b = { ...input };
	const job_id = String(b.job_id ?? "").trim();
	const status = STATUSES.includes(String(b.status)) ? String(b.status) : "failed";
	const out = {
		job_id,
		status,
		runtime: b.runtime ?? "node",
		source: b.source ?? b.runtime ?? "node",
		finished_at: b.finished_at ?? now.toISOString(),
		exit_code: b.exit_code ?? (status === "failed" || status === "timeout" || status === "killed" ? 1 : 0),
		kpi: redact(b.kpi ?? "").slice(0, 500),
		kpi_pass: ["yes", "no", "n/a"].includes(b.kpi_pass) ? b.kpi_pass : "n/a",
		detail: redact(b.detail ?? "").slice(0, 2000),
		is_test: b.is_test ?? /^(zz-|test-)/.test(job_id),
		...v2Fields(b),
	};
	if (b.run_id) out.run_id = String(b.run_id);
	if (b.url) out.url = String(b.url);
	if (b.host) out.host = String(b.host);
	if (Number.isFinite(b.duration_s)) out.duration_s = b.duration_s;
	else if (b.started_at) {
		const s = typeof b.started_at === "number" ? b.started_at : Date.parse(b.started_at);
		if (Number.isFinite(s)) out.duration_s = Math.max(0, Math.round((now.getTime() - s) / 1000));
	}
	return out;
}

/** Body of a live-run event (`start` or `step`). Pure. */
export function buildEvent(input, now = new Date()) {
	const b = { ...input };
	const job_id = String(b.job_id ?? "").trim();
	const out = { job_id, run_id: String(b.run_id ?? ""), event: b.event === "start" ? "start" : "step", at: b.at ?? now.toISOString(), is_test: b.is_test ?? /^(zz-|test-)/.test(job_id) };
	if (out.event === "step") {
		Object.assign(out, { n: int(b.n), name: redact(String(b.name ?? "")).slice(0, 120), items_in: int(b.items_in), items_out: int(b.items_out), duration_s: Number.isFinite(Number(b.duration_s)) ? Number(b.duration_s) : undefined, warnings: list(b.warnings, 10, 200), detail: redact(String(b.detail ?? "")).slice(0, 300) });
		if (b.cursor !== undefined) out.cursor = typeof b.cursor === "string" ? b.cursor : JSON.stringify(b.cursor);
	}
	return out;
}

const connect = (opts) => {
	const env = globalThis.process?.env ?? {};
	return {
		token: opts.token ?? env.CONTROL_ROOM_TOKEN,
		base: opts.binding ? "https://control-room" : (opts.url ?? env.CONTROL_ROOM_URL ?? DEFAULT_URL).replace(/\/$/, ""),
		doFetch: opts.binding ? (u, i) => opts.binding.fetch(u, i) : (opts.fetch ?? globalThis.fetch),
	};
};
const withTimeout = (init, ms) => { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) init.signal = AbortSignal.timeout(ms); return init; };

async function post(body, opts) {
	try {
		const { token, base, doFetch } = connect(opts);
		if (!body.job_id) return { ok: false, error: "missing_job_id" };
		if (!token) return { ok: false, error: "no_token" };
		const res = await doFetch(`${base}/report`, withTimeout({ method: "POST", headers: { "content-type": "application/json", "x-report-token": token }, body: JSON.stringify(body) }, opts.timeoutMs ?? 10000));
		if (!res.ok) return { ok: false, error: `http_${res.status}` };
		return { ok: true, status: res.status, run_id: body.run_id };
	} catch (e) {
		return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
	}
}

/**
 * One report. A body with `event: "start"|"step"` is sent as a live event; anything else is the end-of-run report.
 * opts: { binding?: Fetcher, url?: string, token?: string, fetch?: fn, timeoutMs?: number }
 * Order: binding (Workers) → url → process.env.CONTROL_ROOM_URL → default workers.dev URL.
 */
export async function report(input, opts = {}) {
	if (input && (input.event === "start" || input.event === "step")) return post(buildEvent(input), opts);
	return post(buildBody(input ?? {}), opts);
}

async function get(path, opts) {
	const { token, base, doFetch } = connect(opts);
	if (!token) return null;
	const res = await doFetch(`${base}${path}`, withTimeout({ method: "GET", headers: { "x-report-token": token } }, opts.timeoutMs ?? 3000));
	return res.ok ? res.json() : null;
}

/** Is the job paused from the web? Fails open: control-room unreachable means "not paused" so a job never stops because of the check. */
export async function checkPause(job_id, opts = {}) {
	try {
		const r = await get(`/api/pause/${encodeURIComponent(job_id)}`, opts);
		return r ? { ok: true, paused: r.paused === true, by: r.by, why: r.why, at: r.at } : { ok: false, paused: false };
	} catch { return { ok: false, paused: false }; }
}

/** Are the upstream jobs or data keys healthy and fresh? Fails open. `waiting_on` names what blocks. */
export async function checkUpstream(ids, opts = {}) {
	try {
		const list = [].concat(ids ?? []).filter(Boolean);
		if (!list.length) return { ok: true, waiting_on: [], reason: "", checked: [] };
		const q = `/api/upstream?ids=${encodeURIComponent(list.join(","))}${opts.max_age_h ? `&max_age_h=${encodeURIComponent(opts.max_age_h)}` : ""}`;
		const r = await get(q, opts);
		return r ? { ok: r.ok === true, waiting_on: r.waiting_on ?? [], reason: r.reason ?? "", checked: r.checked ?? [] } : { ok: true, waiting_on: [], reason: "", checked: [], unreachable: true };
	} catch { return { ok: true, waiting_on: [], reason: "", checked: [], unreachable: true }; }
}

/** Where the last broken run stopped ({step, cursor, run_id, at}) or null: resume from here instead of starting over. */
export async function loadCheckpoint(job_id, opts = {}) {
	try { return (await get(`/api/checkpoint/${encodeURIComponent(job_id)}`, opts))?.checkpoint ?? null; } catch { return null; }
}

/**
 * The two checks a job makes before it does any work (rows 12 and 13 of the operating standard).
 * Returns { go: true } or { go: false, status: "paused"|"waiting", detail } to put straight into report().
 */
export async function gate(job_id, { depends_on = [], max_age_h } = {}, opts = {}) {
	const p = await checkPause(job_id, opts);
	if (p.paused) return { go: false, status: "paused", detail: `paused by ${String(p.by ?? "someone").split("@")[0]}: ${p.why ?? "no reason given"}` }; // the name, not the address: reports redact emails
	const u = await checkUpstream(depends_on, { ...opts, max_age_h });
	if (!u.ok) return { go: false, status: "waiting", detail: u.reason || `waiting on ${u.waiting_on.join(", ")}` };
	return { go: true };
}

/** A live run: `start` is sent now; `step()` sends milestones; `end()` sends the report with the steps summed up. */
export async function startRun(job_id, opts = {}) {
	const run_id = opts.run_id ?? (globalThis.crypto?.randomUUID?.() ?? `${job_id}:${Date.now()}`);
	const t0 = Date.now();
	const steps = [];
	await post(buildEvent({ job_id, run_id, event: "start", is_test: opts.is_test }), opts);
	return {
		run_id,
		steps,
		async step(s) {
			const n = int(s.n) ?? steps.length + 1;
			steps.push({ ...s, n });
			return post(buildEvent({ job_id, run_id, event: "step", is_test: opts.is_test, ...s, n }), opts);
		},
		async end(status, fields = {}) {
			return post(buildBody({ runtime: opts.runtime, source: opts.source, host: opts.host, ...fields, job_id, run_id, status, steps: fields.steps ?? steps, started_at: t0, is_test: opts.is_test ?? fields.is_test }), opts);
		},
	};
}
