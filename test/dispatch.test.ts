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
	it("routes a lost caller from get_started instead of leaving them at a seller's menu", async () => {
		const r = await dispatch("get_started", { context: "my team is struggling" });
		// The front door's whole job: the most useful fact for most humans who reach this server.
		expect(r.report).toContain("free for engineering leaders");
		expect(r.report).toContain("/join/");
	});

	it("answers a bare greeting without an error", async () => {
		const r = await dispatch("get_started", { context: "hi" });
		expect(r.report).toContain("Hello");
	});

	it("answers with no arguments at all", async () => {
		const r = await dispatch("get_started", {});
		expect(r.report).toContain("What you can call");
	});
});

/**
 * Evidence-backed since 2026-09-05. Both were withheld for a day because their regexes guessed
 * at meaning; they answer again now that src/core/extract.ts reads the prose into facts and
 * these scorers judge only the facts.
 *
 * The direction of the fallback is the safety property worth testing: with no extractor
 * reachable — which is the case here, no API key in the test env — they must DECLINE, not
 * quietly revert to pattern matching. A degraded path nobody can see is how the original
 * defect would come back.
 */
describe("judgment services fail closed without the extractor", () => {
	for (const [id, args] of [
		["evaluate_meetup_topic", { title: "Microservices Best Practices" }],
		[
			"assess_speaker_readiness",
			{ talk_title: "Scaling teams", speaker_background: "VP Engineering at Productboard." },
		],
	] as const) {
		// Not advertised while the extractor's API credit is exhausted — a tool that is always
		// going to decline should not be on the menu. Flip this expectation back to `toContain`
		// in the same commit that deletes the `withheld` line in services.ts.
		it(`${id} stays off the menu until the extractor can actually run`, () => {
			expect(LIVE_SERVICES.map((s) => s.id)).not.toContain(id);
		});

		it(`${id} declines rather than falling back to patterns`, async () => {
			const r = await dispatch(id, args);
			expect(r.verdict).toBe("Not available yet");
			expect(r.report).toContain("not available yet");
			// It must NOT have scored anything.
			expect(r.report).not.toContain("red flag");
			expect(r.data?.tier).toBeUndefined();
		});
	}
});


/**
 * 2026-09-05. `has_recording` and `writes_publicly` were added to the speaker schema and to the
 * function, but dispatch hand-maps arguments per service and nobody added them there — so the
 * card advertised them, validation accepted them, and they were dropped in silence. That is the
 * same silent-wrong-answer class four personas found in the bridged tools.
 *
 * A declared argument that no handler reads is always a bug, so assert the structure rather than
 * any single field: every key in a local service's inputSchema must appear in the source of the
 * handler that serves it.
 */
describe("declared arguments are actually consumed", () => {
	it("every local service's handler reads every key it advertises", async () => {
		const { HANDLERS_FOR_TEST } = await import("../src/core/dispatch");
		for (const service of LIVE_SERVICES.filter((s) => !s.bridge && !s.withheld)) {
			const handler = HANDLERS_FOR_TEST[service.id];
			expect(handler, `no handler registered for ${service.id}`).toBeDefined();
			const source = handler.toString();
			for (const key of Object.keys(service.inputSchema)) {
				expect(source, `${service.id} advertises "${key}" but its handler never reads it`).toContain(key);
			}
		}
	});
});
