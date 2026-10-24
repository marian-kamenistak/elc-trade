import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSourceData, projectCompany, projectPerson, recordsById } from "../src/data/sources";
import { runNightlySnapshots } from "../src/data/snapshot-store";

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

	it("the Slack alert for that failure contains neither the name nor the email", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const calls = mockFetch((url) => {
			if (url.startsWith("https://slack.com")) return Response.json({ ok: true });
			if (url.startsWith("https://api.attio.com"))
				return new Response(JSON.stringify({ code: "validation_type", message: "Jane Doe <jane@example.com>" }), { status: 400 });
			return lumaEmpty();
		});
		const bucket = { get: async () => null, put: async () => ({}) } as unknown as R2Bucket;
		const out = await runNightlySnapshots({ ...env, SNAPSHOTS: bucket, SLACK_BOT_TOKEN_ELC: "xoxb-test", WARNING_SLACK_CHANNEL: "C0BMYMBHD32" });
		expect(out).toBeNull();
		const slack = calls.filter((c) => c.url.startsWith("https://slack.com"));
		expect(slack).toHaveLength(1);
		for (const s of PII) expect(slack[0].body).not.toContain(s);
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
