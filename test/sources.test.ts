import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSourceData, projectCompany, projectPerson, recordsById } from "../src/data/sources";
import { nightlyScheduled, runNightlySnapshots } from "../src/data/snapshot-store";

const PII = ["jane@example.com", "Jane Doe"];
const realFetch = globalThis.fetch;

/** Routes fetch by host; records every call. */
function mockFetch(route: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const calls: { url: string; body: string }[] = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), body: String(init?.body ?? "") });
		return route(String(url), init);
	}) as typeof fetch;
	return calls;
}

const lumaEmpty = () => Response.json({ entries: [], has_more: false });

afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

describe("timeouts are retried", () => {
	it("an Attio and a Luma request that time out once succeed on the retry", async () => {
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => (fn(), 0)) as never);
		const seen = new Set<string>();
		mockFetch((url) => {
			const host = new URL(url).host;
			if (!seen.has(host)) {
				seen.add(host);
				throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
			}
			return host === "api.attio.com" ? Response.json({ data: [] }) : lumaEmpty();
		});
		// Empty data then fails a later check; what matters is that it is not the timeout.
		const err = (await fetchSourceData({ ATTIO_TOKEN: "t", LUMA_API_KEY: "k" }).catch((e) => e)) as Error;
		expect(err?.name).not.toBe("TimeoutError");
		expect(seen).toEqual(new Set(["api.attio.com", "public-api.luma.com"]));
	});
});

describe("errors never carry response bodies", () => {
	const env = { ATTIO_TOKEN: "t", LUMA_API_KEY: "k" };

	it("a 400 echoing a name and email yields only method, path, status and code", async () => {
		mockFetch((url) =>
			url.startsWith("https://api.attio.com")
				? new Response(JSON.stringify({ status_code: 400, code: "validation_type", message: "Jane Doe <jane@example.com> is invalid" }), { status: 400 })
				: lumaEmpty(),
		);
		const err = (await fetchSourceData(env).catch((e) => e)) as Error;
		expect(err.message).toMatch(/^Attio POST \/\S+ -> 400 \(validation_type\)$/);
		for (const s of PII) expect(err.message).not.toContain(s);
	});

	it("an unparseable 200 says 'invalid JSON from <path>', not the V8 message quoting the body", async () => {
		mockFetch((url) => (url.startsWith("https://api.attio.com") ? new Response("Jane Doe jane@example.com {") : lumaEmpty()));
		const err = (await fetchSourceData(env).catch((e) => e)) as Error;
		expect(err.message).toMatch(/^invalid JSON from Attio POST \/\S+$/);
		for (const s of PII) expect(err.message).not.toContain(s);
	});

	it("a Luma error drops the query string with event ids", async () => {
		mockFetch((url) =>
			// Attio never answers, so the Luma failure is the one that surfaces.
			url.startsWith("https://api.attio.com") ? new Promise<Response>(() => {}) : new Response("Jane Doe jane@example.com", { status: 403 }),
		);
		const err = (await fetchSourceData(env).catch((e) => e)) as Error;
		expect(err.message).toBe("Luma GET /calendar/list-events -> 403");
		for (const s of PII) expect(err.message).not.toContain(s);
	});

	it("the control-room run report and the log for that failure contain neither the name nor the email, and no Slack post is made", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const calls = mockFetch((url) => {
			if (url.startsWith("https://api.attio.com"))
				return new Response(JSON.stringify({ code: "validation_type", message: "Jane Doe <jane@example.com>" }), { status: 400 });
			return lumaEmpty();
		});
		const bucket = { get: async () => null, put: async () => ({}) } as unknown as R2Bucket;
		const posted: string[] = [];
		const CONTROL_ROOM = { fetch: async (_u: string, init: RequestInit) => { if (init.method === "POST") posted.push(String(init.body)); return new Response("{}", { status: 202 }); } } as unknown as Fetcher;
		await nightlyScheduled({ scheduledTime: 1 } as ScheduledController, { ...env, SNAPSHOTS: bucket, CONTROL_ROOM, CONTROL_ROOM_TOKEN: "t" }, {} as ExecutionContext);
		expect(calls.filter((c) => c.url.startsWith("https://slack.com"))).toHaveLength(0);
		expect(posted.map((b) => JSON.parse(b).event ?? "end")).toEqual(["start", "end"]); // start event, then the one end report
		expect(JSON.parse(posted[1]).status).toBe("failed");
		for (const s of PII) expect(posted.join("\n")).not.toContain(s);
		for (const s of PII) expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(s);
	});
});

describe("records are projected at fetch time", () => {
	const fullPerson = (id: string) => ({
		id: { record_id: id },
		values: {
			name: [{ full_name: "Jane Doe" }],
			email_addresses: [{ email_address: "jane@example.com" }],
			job_title: [{ value: " CTO " }],
			company: [{ target_record_id: `co-${id}` }],
			primary_location: [{ locality: "Praha", country_code: "CZ" }],
		},
	});
	const fullCompany = (id: string) => ({
		id: { record_id: id },
		values: {
			name: [{ value: "Acme" }],
			domains: [{ domain: "acme.example" }],
			employee_range: [{ option: { title: "251-1K" } }],
			primary_location: [{ locality: "Brno", country_code: "CZ" }],
		},
	});

	it("keeps only {title, companyId} for people and {sizeBand, countryCode} for companies", async () => {
		mockFetch((url) => {
			const isPeople = url.includes("/objects/people/");
			return Response.json({ data: ["a", "b"].map((id) => (isPeople ? fullPerson(id) : fullCompany(id))) });
		});
		const people = await recordsById("t", "people", ["a", "b"], projectPerson);
		const companies = await recordsById("t", "companies", ["a", "b"], projectCompany);

		for (const p of people.values()) expect(Object.keys(p).sort()).toEqual(["companyId", "title"]);
		for (const c of companies.values()) expect(Object.keys(c).sort()).toEqual(["countryCode", "sizeBand"]);
		expect(people.get("a")).toEqual({ title: "CTO", companyId: "co-a" });
		expect(companies.get("a")).toEqual({ sizeBand: "251-1k", countryCode: "CZ" });
	});
});
