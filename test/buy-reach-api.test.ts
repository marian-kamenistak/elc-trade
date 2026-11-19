import { describe, expect, it } from "vitest";
import { dispatch, type DispatchContext } from "../src/core/dispatch";

// buy_reach reads the partnership builder's REST quote, not its MCP briefing (2026-11-19).
const QUOTE = {
	items: [
		{ id: "newsletter-dedicated", name: "A dedicated newsletter", price: 5000, lead_time: "2 weeks", counts_toward_combo: true },
		{ id: "podcast-episode", name: "An ELC podcast episode", price: 3000, lead_time: "1 month", counts_toward_combo: true },
	],
	unknown_ids: [], unknown_rungs: [], duplicate_ids: [],
	list_total: 8000, combo: { qualifying_items: 2, pct: 10, saved: 800 }, total: 7200, credit_days: 90,
};

function ctxWith(fetch: (req: Request) => Promise<Response>): DispatchContext {
	const unused = { fetch: async () => new Response("unused", { status: 500 }) };
	return { env: { PARTNERSHIP: { fetch }, TOOLKIT: unused } as unknown as DispatchContext["env"], transport: "mcp" };
}

describe("buy_reach via the partnership REST API", () => {
	it("renders the quote with the budget fit", async () => {
		let asked = "";
		const ctx = ctxWith(async (req) => { asked = req.url; return Response.json(QUOTE); });
		const r = await dispatch("buy_reach", { oneoff_ids: ["newsletter-dedicated", "podcast-episode"], budget_eur: 7000 }, ctx);
		expect(asked).toContain("/mcp/partnership/api/reach/quote?oneoff_ids=newsletter-dedicated%2Cpodcast-episode");
		expect(r.report).toContain("€7,200");
		expect(r.report).toContain("Against your €7,000: this is €200 over.");
		expect(r.report).toContain("**Next:**");
		expect(r.report).not.toContain('"items"');
	});

	it("passes the sibling's 400 message through", async () => {
		const ctx = ctxWith(async () => Response.json({ error: "no known one-offs — valid: dinner" }, { status: 400 }));
		await expect(dispatch("buy_reach", { oneoff_ids: ["dinner"] }, ctx)).rejects.toThrow(/valid: dinner/);
	});
});
