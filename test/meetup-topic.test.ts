import { describe, expect, it } from "vitest";
import { evaluateMeetupTopic } from "../src/core/meetup-topic";

/**
 * The guide (topics/meetup-topic-guide.md, Part 1) publishes four weak/strong title pairs
 * as its own worked examples. If this scorer encodes ELC's judgment rather than a generic
 * notion of "good title", every strong title must beat its weak counterpart. That is the
 * only test here that really matters — the rest are mechanics.
 */
const PAIRS: Array<[weak: string, strong: string]> = [
	[
		"Managing distributed teams",
		"Managing Distributed Teams: The Full Guide From Leaders Who Run 500+ People Across 4 Countries",
	],
	[
		"AI strategy for leaders",
		"Enabling AI Pods in Your Org Structure. What Ataccama Changed and What Broke.",
	],
	["How to get promoted", "12 Steps to Boost Your Value for 2027. Get Unstuck. Get Promoted."],
	["Team structures", "From Squads to Soloists: The End of the Engineering Team as We Know It?"],
];

const flags = (t: string) => evaluateMeetupTopic({ title: t }).data!.red_flags as number;

describe("the guide's own weak/strong pairs", () => {
	it.each(PAIRS)("scores the strong title better than %j", (weak, strong) => {
		expect(flags(strong)).toBeLessThan(flags(weak));
	});
});

describe("title mechanics", () => {
	it("strips the meetup number before measuring length", () => {
		const withNum = evaluateMeetupTopic({ title: "#38 From Squads to Soloists: The End of the Engineering Team as We Know It?" });
		const without = evaluateMeetupTopic({ title: "From Squads to Soloists: The End of the Engineering Team as We Know It?" });
		expect(withNum.data!.title_chars).toBe(without.data!.title_chars);
	});

	it("asks for the meetup number when it is missing", () => {
		expect(evaluateMeetupTopic({ title: "Stop Hiring Unicorns. Start Growing Leaders." }).report).toContain("#38");
	});

	it("flags a title over 80 characters", () => {
		const long = "A".repeat(85);
		expect(evaluateMeetupTopic({ title: long }).report).toContain("Too long");
	});
});

describe("red flags", () => {
	it("catches clickbait", () => {
		expect(evaluateMeetupTopic({ title: "Don't Miss This: The Secret To Engineering Leadership" }).report).toContain("Clickbait");
	});

	it("catches generic buzzwords", () => {
		expect(evaluateMeetupTopic({ title: "Unlocking Innovation Through Digital Transformation" }).report).toContain("Generic buzzwords");
	});

	it("catches discussion-shaped titles", () => {
		expect(evaluateMeetupTopic({ title: "Managing distributed teams" }).report).toContain("Discussion-shaped");
	});
});

describe("abstract checks", () => {
	const body = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

	it("flags the passive opener the guide calls out", () => {
		const r = evaluateMeetupTopic({
			title: "AI Dev Tools in 2025: Reality Check",
			abstract: `In this meetup, we will explore the topic. ${body(180)}\n\n- a bullet`,
		});
		expect(r.report).toContain("In this meetup, we will explore");
	});

	it('flags unqualified "insights"', () => {
		const r = evaluateMeetupTopic({
			title: "AI Dev Tools in 2025: Reality Check",
			abstract: `Real insights from the field. ${body(180)}\n\n- a bullet`,
		});
		expect(r.report).toContain("insights");
	});

	it("flags an abstract with no bullets", () => {
		const r = evaluateMeetupTopic({
			title: "AI Dev Tools in 2025: Reality Check",
			abstract: body(200),
		});
		expect(r.report).toContain("No bullet points");
	});

	it("accepts an abstract inside the ideal band", () => {
		const r = evaluateMeetupTopic({
			title: "AI Dev Tools in 2025: Reality Check",
			abstract: `${body(180)}\n\n- a real bullet`,
		});
		expect(r.report).toContain("Abstract length good");
	});
});

describe("audience mix", () => {
	it("passes when two segments are covered", () => {
		const r = evaluateMeetupTopic({
			title: "AI Dev Tools in 2025: Reality Check",
			audience: "Engineering managers and CTOs",
		});
		expect(r.report).toContain("Audience spans 2");
	});

	it("fails a single-segment audience", () => {
		const r = evaluateMeetupTopic({
			title: "AI Dev Tools in 2025: Reality Check",
			audience: "CTOs only",
		});
		expect(r.report).toContain("Audience too narrow");
	});
});

/**
 * Second persona round, both from the same class of defect — a check whose scope did not match
 * its wording, and a keyword list that stopped at the language border.
 */
describe("second-round persona regressions", () => {
	it("does not claim 'no emotional hook' when the abstract has one", () => {
		const r = evaluateMeetupTopic({
			title: "Platform engineering at Kiwi.com",
			abstract:
				"The ambition every engineering leader has is a platform team that pays for itself. We got there in eighteen months and I will show the numbers, including the two quarters where it did not.",
		});
		const pull = (r.data!.emotional_pull as string[]) ?? [];
		if (pull.length) {
			expect(r.report, "the data says there is pull; the prose must not deny it").not.toContain(
				"no emotional hook in the title",
			);
			expect(r.report).toContain("The hook is in the abstract, not the title");
		}
	});

	it("catches a Czech vendor pitch", () => {
		const r = evaluateMeetupTopic({
			title: "Jak jsme zrychlili nasazení",
			abstract:
				"Ukážeme živé demo produktu, naše ceníkové úrovně a bezplatnou zkušební verzi. Náš obchodní tým bude na místě.",
		});
		expect(
			(r.data!.vendor_pitch as string[]).length,
			"Prague, Brno and Bratislava are the core stages — the guard cannot be English-only",
		).toBeGreaterThan(0);
		expect(r.report).toContain("vendor pitch");
	});
});
