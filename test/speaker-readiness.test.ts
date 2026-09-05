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
	/**
	 * Changed 2026-09-05. The title used to gate Tier 1, and a persona proved that made Tier 1
	 * effectively unreachable: sweeping prior_talks from 0 to 999 with a recording and public
	 * writing returned Tier 2 every time, because almost every real title carries a flag. All 35
	 * of that tester's submissions — from the single character "a" to a Zalando CTO — came back
	 * Tier 2, which is not a classifier.
	 *
	 * A weak title is an edit to send with the invitation, not grounds to reject a proven
	 * speaker, so it now lands in the gaps list instead of capping the tier.
	 */
	it("promotes a proven speaker to Tier 1 even when the title needs work, and says so", () => {
		const input = {
			talk_title: "Managing distributed teams",
			speaker_background: "VP Engineering at Productboard. Recording on YouTube.",
			prior_talks: 5,
			has_dry_run: true,
		};
		expect(tier(input)).toBe(1);
		const r = assessSpeakerReadiness(input);
		expect(r.data!.title_red_flags as number).toBeGreaterThan(0);
		// The invitation must carry the title notes rather than silently ignoring them.
		expect(r.report).toContain("an edit, not a reason to pass");
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

/**
 * 2026-09-05 persona round. `has_recording` and `writes_publicly` were inferred by substring
 * match, which cannot see a negation — so a bio reading "has never given a talk, has no
 * recording, does not blog" was credited with BOTH assets and told the organiser "There is a
 * recording. This is the playbook's explicit graduation criterion." The honest applicant who
 * declared her gaps was scored as if she had filled them.
 */
describe("evidence is not a keyword count", () => {
	const honest = {
		talk_title: "Rebuilding trust after a failed reorg",
		speaker_background:
			"Astrid is an EM at Oda leading 11 engineers. She has never given a talk, has no recording, does not blog and has no social media presence.",
	};

	it("a denied asset is never counted as evidence of that asset", () => {
		const d = assessSpeakerReadiness(honest).data!;
		expect(d.has_recording, "'no recording' must not read as a recording").toBe(false);
		expect(d.writes_publicly, "'does not blog' must not read as public writing").toBe(false);
	});

	it("explicit booleans beat any prose inference", () => {
		const d = assessSpeakerReadiness({ ...honest, has_recording: true, writes_publicly: true }).data!;
		expect(d.has_recording).toBe(true);
		expect(d.writes_publicly).toBe(true);
	});
});

/**
 * A self-declared sales pitch scored Tier 2, `practitioner: true`, `blockers: 0` and got a stage
 * recommendation — the word "VP" in "VP of Sales" carried the practitioner test. Meanwhile
 * `evaluate_meetup_topic`, sitting next to it, refuses the same request in plain words.
 */
describe("stage-selling is refused, not placed", () => {
	it("blocks an outright vendor slot regardless of title", () => {
		const r = assessSpeakerReadiness({
			talk_title: "Vantyr Product Deep Dive: Live Demo and Pricing Walkthrough",
			speaker_background:
				"Greg Halloran, VP of Sales at Vantyr. Career salesperson, never managed engineers. This is a paid vendor slot and the talk is a sales pitch. We will scan badges at the door.",
		});
		expect(r.data!.tier).toBe(3);
		expect(r.data!.blockers as number).toBeGreaterThan(0);
		expect(r.data!.commercial_intent).toBe(true);
		expect(r.data!.practitioner, "a salesperson must not read as a practitioner").toBe(false);
	});

	it("catches a pitch disguised in practitioner language", () => {
		const r = assessSpeakerReadiness({
			talk_title: "How we cut MTTR by 60 percent",
			speaker_background:
				"Head of Platform Engineering at Datadog, leading 15 engineers. Live demo of the setup. Free trial available for attendees.",
			prior_talks: 8,
			has_dry_run: true,
		});
		expect(r.data!.tier, "'free trial available for attendees' is the tell").toBe(3);
	});

	it("does not block a genuine practitioner who merely works at a vendor", () => {
		const r = assessSpeakerReadiness({
			talk_title: "What broke when we sharded the write path",
			speaker_background: "Director of Engineering at Datadog, leading 15 engineers through an 18-month migration.",
			prior_talks: 2,
		});
		expect(r.data!.blockers).toBe(0);
		expect(r.data!.commercial_intent).toBe(false);
	});
});

/**
 * Second persona round. The negation fix worked, but the POSITIVE inference was backwards in
 * both directions: "Wants a sponsored keynote" was credited with a recording and a prior talk
 * (a request read as a history), while "Has spoken at three international conferences including
 * QCon and GOTO" returned nothing. And `practitioner` read job titles rather than evidence —
 * a self-declared fake title passed, a stated 30-engineer scope did not.
 */
describe("evidence, not keywords", () => {
	it("a request for a stage is not a speaking history", () => {
		const d = assessSpeakerReadiness({
			talk_title: "Scaling payments",
			speaker_background: "Engineering manager. Wants a sponsored keynote.",
		}).data!;
		expect(d.has_recording, "'wants a keynote' must not read as having one").toBe(false);
		expect(d.prior_talks).toBe(0);
	});

	it("a stated speaking history is read", () => {
		const d = assessSpeakerReadiness({
			talk_title: "Scaling payments",
			speaker_background: "Has spoken at three international conferences including QCon and GOTO.",
		}).data!;
		expect(d.has_recording).toBe(true);
	});

	it("stated scope establishes a practitioner without a matching title", () => {
		const d = assessSpeakerReadiness({
			talk_title: "Rebuilding the payments platform",
			speaker_background: "Runs the payments group at a Norwegian bank, 30 engineers across four teams.",
		}).data!;
		expect(d.practitioner).toBe(true);
	});

	it("an explicit disclaimer outranks an impressive title", () => {
		const d = assessSpeakerReadiness({
			talk_title: "Scaling teams",
			speaker_background: "VP of Engineering. I have never worked in tech and I made this title up.",
		}).data!;
		expect(d.practitioner).toBe(false);
	});
});
