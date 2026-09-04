import { describe, expect, it } from "vitest";
import { assessSpeakerReadiness } from "../src/core/speaker-readiness";

const tier = (i: Parameters<typeof assessSpeakerReadiness>[0]) =>
	assessSpeakerReadiness(i).data!.tier as number;

/** A title that already clears the topic guide, so title flags never confound a tier test. */
const GOOD_TITLE = "From Squads to Soloists: The End of the Engineering Team as We Know It?";

describe("tier placement", () => {
	it("puts a proven speaker with a recording on Tier 1", () => {
		expect(
			tier({
				talk_title: GOOD_TITLE,
				speaker_background: "VP Engineering at Productboard. Spoke at Craft and mDevCamp, recording on YouTube.",
				prior_talks: 5,
				has_dry_run: true,
			}),
		).toBe(1);
	});

	it("puts a writer with no stage on Tier 2, the meetup audition rung", () => {
		expect(
			tier({
				talk_title: GOOD_TITLE,
				speaker_background: "Staff engineer at Rohlik. Writes a newsletter about platform work.",
				prior_talks: 0,
			}),
		).toBe(2);
	});

	it("puts someone with no evidence at all on Tier 2 with thin evidence", () => {
		const r = assessSpeakerReadiness({
			talk_title: GOOD_TITLE,
			speaker_background: "Engineering manager at Kiwi.com.",
			prior_talks: 0,
		});
		expect(r.data!.tier).toBe(2);
		expect(r.report).toContain("thin evidence");
	});

	it("skips a vendor pitch regardless of how experienced they are", () => {
		const r = assessSpeakerReadiness({
			talk_title: GOOD_TITLE,
			speaker_background: "Independent consultant and thought leader. We help companies scale engineering.",
			prior_talks: 20,
			has_dry_run: true,
		});
		expect(r.data!.tier).toBe(3);
		expect(r.report).toContain("vendor");
	});

	it("does not skip a practitioner who merely mentions coaching", () => {
		// "coach" appears, but so does a real operating role — the practitioner signal wins.
		expect(
			tier({
				talk_title: GOOD_TITLE,
				speaker_background: "CTO at Mews. Coaches first-time managers internally. Recording from Craft 2025.",
				prior_talks: 4,
				has_dry_run: true,
			}),
		).toBe(1);
	});
});

describe("composition with the topic guide", () => {
	it("does not promote to Tier 1 when the talk title fails the topic guide", () => {
		expect(
			tier({
				talk_title: "Managing distributed teams",
				speaker_background: "VP Engineering at Productboard. Recording on YouTube.",
				prior_talks: 5,
				has_dry_run: true,
			}),
		).toBe(2);
	});

	it("tells the caller to run the topic evaluator when the title is weak", () => {
		const r = assessSpeakerReadiness({
			talk_title: "Managing distributed teams",
			speaker_background: "VP Engineering at Productboard.",
		});
		expect(r.report).toContain("evaluate_meetup_topic");
	});
});

describe("dry run", () => {
	it("flags an explicitly missing dry run", () => {
		const r = assessSpeakerReadiness({
			talk_title: GOOD_TITLE,
			speaker_background: "Staff engineer at Rohlik. Writes a newsletter.",
			has_dry_run: false,
		});
		expect(r.report).toContain("No dry run scheduled");
	});

	it("asks about the dry run when it is unknown", () => {
		const r = assessSpeakerReadiness({
			talk_title: GOOD_TITLE,
			speaker_background: "Staff engineer at Rohlik. Writes a newsletter.",
		});
		expect(r.report).toContain("Is a dry run scheduled?");
	});
});

describe("honesty about logistics", () => {
	it("never implies fee or travel is committed", () => {
		const r = assessSpeakerReadiness({
			talk_title: GOOD_TITLE,
			speaker_background: "CTO at Mews. Recording from Craft 2025.",
			prior_talks: 4,
		});
		expect(r.report).toContain("will do my best to cover travel");
	});
});
