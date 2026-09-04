import { describe, expect, it } from "vitest";
import { isDealworthy, notifyDeal, stageFor } from "../src/core/deals";
import { SERVICES } from "../src/core/services";
import type { ServiceDefinition, ServiceResult } from "../src/core/types";

const svc = (id: string) => SERVICES.find((s) => s.id === id) as ServiceDefinition;
const res = (over: Partial<ServiceResult> = {}): ServiceResult => ({ report: "r", source: "s", ...over });

describe("what reaches #agent-deals-bot", () => {
	it("carries commercial services only", () => {
		expect(isDealworthy(svc("buy_reach"))).toBe(true);
		expect(isDealworthy(svc("post_job"))).toBe(true);
	});

	it("stays silent for judgment and data tools", () => {
		// These fire constantly and would bury the one message that matters.
		expect(isDealworthy(svc("evaluate_meetup_topic"))).toBe(false);
		expect(isDealworthy(svc("assess_speaker_readiness"))).toBe(false);
		expect(isDealworthy(svc("benchmark_leadership_ratio"))).toBe(false);
	});
});

describe("never overstates what happened", () => {
	it("calls a priced quote a quote, not a deal", () => {
		expect(stageFor(svc("buy_reach"), res())).toBe("quoted");
	});

	it("only says paid when money actually settled", () => {
		expect(stageFor(svc("buy_reach"), res({ data: { paid: true } }))).toBe("paid");
	});

	it("flags a submission that a human now owes an answer to", () => {
		expect(stageFor(svc("post_job"), res({ pending: true }))).toBe("requested");
	});
});

describe("degrades quietly rather than failing a request", () => {
	it("no-ops without a token or channel", async () => {
		// Must not throw: a missing secret cannot be allowed to fail a working answer.
		await expect(
			notifyDeal({}, { service: svc("buy_reach"), args: {}, result: res(), transport: "a2a" }),
		).resolves.toBeUndefined();
	});

	it("swallows a Slack outage", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;
		try {
			await expect(
				notifyDeal(
					{ SLACK_BOT_TOKEN_ELC: "xoxb-test", A2A_TRADE_SLACK_CHANNEL: "C0BUX9AP9V3" },
					{ service: svc("buy_reach"), args: {}, result: res(), transport: "mcp" },
				),
			).resolves.toBeUndefined();
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("message content", () => {
	it("says no money moved unless it did, and shows the useful fields", async () => {
		let sent = "";
		const original = globalThis.fetch;
		globalThis.fetch = ((_u: string, init: RequestInit) => {
			sent = String(init.body);
			return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
		}) as unknown as typeof fetch;
		try {
			await notifyDeal(
				{ SLACK_BOT_TOKEN_ELC: "xoxb-test", A2A_TRADE_SLACK_CHANNEL: "C0BUX9AP9V3" },
				{
					service: svc("buy_reach"),
					args: { company: "Ataccama", oneoff_ids: ["newsletter-section"], internal_note: "ignore me" },
					result: res(),
					transport: "a2a",
				},
			);
		} finally {
			globalThis.fetch = original;
		}
		expect(sent).toContain("Ataccama");
		expect(sent).toContain("newsletter-section");
		expect(sent).toContain("No money has moved");
		expect(sent).not.toContain("ignore me");
	});
});
