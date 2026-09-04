import { describe, expect, it } from "vitest";
import { dispatch, UnknownServiceError, unimplementedLiveServices } from "../src/core/dispatch";
import { LIVE_SERVICES, SERVICES } from "../src/core/services";

describe("the advertising contract", () => {
	/**
	 * The one invariant that matters: anything we advertise, we can answer. If this fails,
	 * an agent is being offered a tool that throws — mark the service withheld instead.
	 */
	it("has a handler for every live service", () => {
		expect(unimplementedLiveServices()).toEqual([]);
	});

	it("advertises fewer services than it declares, and says why for each", () => {
		const withheld = SERVICES.filter((s) => s.withheld);
		expect(withheld.length).toBeGreaterThan(0);
		for (const s of withheld) expect(s.withheld!.length).toBeGreaterThan(40);
	});
});

describe("withheld services", () => {
	it("answers with the reason rather than an error", async () => {
		const r = await dispatch("post_job", {});
		expect(r.verdict).toBe("Not available yet");
		expect(r.report).toContain("job board");
		expect(r.data!.withheld).toBe(true);
	});

	it("states plainly that nothing was charged or queued", async () => {
		const r = await dispatch("request_intro", {});
		expect(r.report).toContain("Nothing has been charged and nothing has been queued.");
	});

	it("is not reachable through the advertised list", () => {
		expect(LIVE_SERVICES.map((s) => s.id)).not.toContain("post_job");
	});
});

describe("unknown ids", () => {
	it("throws rather than guessing", async () => {
		await expect(dispatch("definitely_not_a_service", {})).rejects.toBeInstanceOf(UnknownServiceError);
	});
});

describe("bridged services", () => {
	/**
	 * Bridged services make a real network call, so these assert the WIRING rather than
	 * invoking it — a unit test that hits engineeringleaders.io would be flaky and would
	 * make the suite depend on production being up.
	 */
	const bridged = SERVICES.filter((s) => s.bridge);

	it("bridges the four services that other servers own", () => {
		expect(bridged.map((s) => s.id).sort()).toEqual([
			"assess_community_launch_readiness",
			"benchmark_leadership_ratio",
			"build_partnership_business_case",
			"buy_reach",
		]);
	});

	it("never implements a bridged service locally — that would fork the answer", () => {
		for (const s of bridged) expect(unimplementedLiveServices()).not.toContain(s.id);
	});

	it("quotes reach through the partnership builder, so prices stay in catalog.yaml", () => {
		const reach = SERVICES.find((s) => s.id === "buy_reach")!;
		expect(reach.bridge).toEqual({ endpoint: "partnership", tool: "quote_reach_combo" });
	});

	it("holds no prices of its own anywhere in the registry", () => {
		// Only `fromEur`/`amountEur` may carry a number, and those are entry-price signals
		// for the card. No service may embed a quotable figure in its description.
		for (const s of SERVICES) expect(s.description).not.toMatch(/€\s*\d|\b\d{3,5}\s*(EUR|eur)\b/);
	});
});

describe("live services answer for real", () => {
	it("evaluates a topic", async () => {
		const r = await dispatch("evaluate_meetup_topic", { title: "Managing distributed teams" });
		expect(r.report).toContain("Discussion-shaped");
	});

	it("places a speaker", async () => {
		const r = await dispatch("assess_speaker_readiness", {
			talk_title: "From Squads to Soloists: The End of the Engineering Team as We Know It?",
			speaker_background: "VP Engineering at Productboard. Recording on YouTube.",
			prior_talks: 5,
		});
		expect(r.data!.tier).toBe(1);
	});
});
