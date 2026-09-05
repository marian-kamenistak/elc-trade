/**
 * assess_speaker_readiness — places a proposed speaker on ELC's own stage ladder.
 *
 * Reframed 2026-09-04 after reading the source. speakers/PLAYBOOK.md is a RECRUITMENT
 * playbook — dossiers, hooks, channel choice, the +21-day follow-up. It contains no
 * "is this person ready" rubric, so a service promising one would have been invented.
 *
 * What the playbook does encode is better: a placement ladder and an audition rung.
 *   - Tier: "1 invite now / 2 warm up first / 3 skip" (Board flow → Properties per card)
 *   - The rung: "The meetup is the audition stage: an emerging speaker who lands a 120+
 *     meetup graduates to conference-candidate with a recording we've seen."
 *     (Emerging speakers lane → Radar flow)
 *   - The emerging profile: "1-5 blog posts, first podcast appearances, engineers at
 *     admired companies. They say yes fast, cost little, promote hard."
 *
 * Two rules from elsewhere in the estate carry real weight here and are enforced:
 *   - topics/meetup-topic-guide.md Part 1 trait 3: "Speakers must be practitioners who
 *     have done the thing, not consultants who advise on the thing. Your audience detects
 *     vendor pitches instantly."
 *   - PLAYBOOK "Rules that don't bend" #2: verified numbers stay verified, targets are
 *     framed as targets. "They will check. DevTernity is why."
 *
 * So this answers the question ELC actually asks — which stage, and what closes the gap —
 * not a generic coaching score.
 */

import type { ServiceResult } from "./types";
import { evaluateMeetupTopic } from "./meetup-topic";

const PLAYBOOK = "ELC's speaker pipeline playbook";

export type Tier = 1 | 2 | 3;

export interface SpeakerInput {
	talk_title: string;
	speaker_background: string;
	prior_talks?: number;
	has_dry_run?: boolean;
}

/**
 * Vendor-pitch shape. The topic guide is explicit that the audience detects these
 * instantly, and it is the single fastest route to Tier 3.
 */
const CONSULTANT_SHAPE =
	/\b(consultant|consulting|advisor|advisory|coach|agency|our (product|platform|solution|tool)|we help companies|thought leader|evangelist|developer advocate)\b/i;

/** Practitioner signal: they ran the thing, at a named place, at a stated scale. */
const PRACTITIONER_SHAPE =
	/\b(cto|vp|vice president|head of|director|engineering manager|em\b|tech lead|team lead|staff|principal|architect|founder|co-founder)\b/i;

/** Evidence that a recording exists — the playbook's explicit graduation criterion. */
const HAS_RECORDING = /\b(recording|recorded|youtube|video|talk at|spoke at|keynoted?|conference talk)\b/i;

/** The emerging-lane profile: some public writing, not yet a stage presence. */
const HAS_WRITING = /\b(blog|blogged|writes?|writing|newsletter|substack|posts?|article|medium)\b/i;

/** Named-company signal. The guide: case studies from named companies consistently outperform. */
const NAMED_COMPANY = /\bat\s+[A-Z][A-Za-z0-9.&-]{2,}/;

export function assessSpeakerReadiness(input: SpeakerInput): ServiceResult {
	const { talk_title, speaker_background, prior_talks, has_dry_run } = input;
	const bg = speaker_background;

	const signals: string[] = [];
	const gaps: string[] = [];
	const blockers: string[] = [];

	// ── Practitioner vs vendor: the fastest disqualifier ─────────────────────
	const consultant = CONSULTANT_SHAPE.test(bg);
	const practitioner = PRACTITIONER_SHAPE.test(bg);

	if (consultant && !practitioner) {
		blockers.push(
			"**Reads as a vendor or advisor, not a practitioner.** The topic guide is blunt: speakers must be people who have done the thing, not people who advise on it — \"your audience detects vendor pitches instantly.\" If they have actually run the org they are describing, say so in those terms instead.",
		);
	} else if (practitioner) {
		signals.push("Practitioner role — they have held the job, not just advised on it.");
	} else {
		gaps.push(
			"Their role is not stated in a way the room can place. Give the title and the scope: how many engineers, how many teams, at what company.",
		);
	}

	if (NAMED_COMPANY.test(bg)) {
		signals.push("Named company — case studies from recognisable companies consistently outperform generic advice.");
	} else {
		gaps.push("No named company. The audience weights a story far more heavily when it belongs to a real org.");
	}

	// ── Stage evidence: the playbook's graduation criterion ──────────────────
	const talks = prior_talks ?? (HAS_RECORDING.test(bg) ? 1 : 0);
	const recording = HAS_RECORDING.test(bg);
	const writing = HAS_WRITING.test(bg);

	if (recording) {
		signals.push("There is a recording. This is the playbook's explicit graduation criterion for the conference lane.");
	}
	if (writing) {
		signals.push("They write in public — the emerging-lane signal (\"1-5 blog posts, first podcast appearances\").");
	}

	// ── Talk title, scored against the meetup topic guide ────────────────────
	// Reuse rather than duplicate: a speaker with a title that will not fill the room is
	// not ready regardless of their CV, and the guide already encodes that judgment.
	const topic = evaluateMeetupTopic({ title: talk_title });
	const titleFlags = topic.data!.red_flags as number;
	if (titleFlags === 0) {
		signals.push("The talk title clears the meetup topic guide with no red flags.");
	} else {
		gaps.push(
			`The talk title has ${titleFlags} red flag${titleFlags === 1 ? "" : "s"} against the topic guide. Run \`evaluate_meetup_topic\` with \`{"title": "${talk_title.replace(/"/g, "'")}"}\` for the specifics — note the argument is \`title\` there, not \`talk_title\`. A title that does not fill the room sinks a ready speaker.`,
		);
	}

	// ── Tier placement ───────────────────────────────────────────────────────
	let tier: Tier;
	let verdict: string;
	let next: string;

	if (blockers.length) {
		tier = 3;
		verdict = "Tier 3 — skip for now";
		next =
			"Not a stage placement yet. If this person has genuinely run what they want to talk about, rewrite the background around what they did and what broke, and re-submit. A vendor framing cannot be fixed by the abstract.";
	} else if (talks >= 3 && recording && titleFlags === 0) {
		tier = 1;
		verdict = "Tier 1 — invite now, conference-ready";
		next =
			"Go straight to a conference or headline slot. There is a recording to point at, a practitioner story, and a title that holds up. Log the approach on the Speakers Pipeline board and follow the one-decision-complete-message rule.";
	} else if (talks >= 1 || writing || recording) {
		tier = 2;
		verdict = "Tier 2 — warm up on a meetup stage first";
		next =
			"Put them in front of 120+ at a monthly meetup. That is the audition rung: land it, get the recording, and they graduate to conference candidate. The playbook's own framing for this invite is \"your post on X deserves a bigger room\" — the give is the stage, not the honour of their presence.";
	} else {
		tier = 2;
		verdict = "Tier 2 — meetup lane, but thin evidence";
		next =
			"No recording, no public writing, no prior stage. Ask them for one piece of public writing on the topic first — that is the cheapest possible audition and it is how the Emerging Speakers Radar sorts people.";
	}

	// ── Things the playbook insists on regardless of tier ────────────────────
	if (has_dry_run === false) {
		gaps.push("No dry run scheduled. For a first-time speaker in front of 120+ people this is the single highest-value hour anyone can spend.");
	} else if (has_dry_run === undefined) {
		gaps.push("Is a dry run scheduled? For a first meetup talk it is not optional.");
	} else {
		signals.push("Dry run scheduled.");
	}

	const report = [
		`# Speaker placement: "${talk_title}"`,
		"",
		`**${verdict}.**`,
		"",
		`## What to do next\n\n${next}`,
		blockers.length ? `## Blockers\n\n${blockers.map((b) => `- ${b}`).join("\n")}` : "",
		signals.length ? `## Working for them\n\n${signals.map((s) => `- ${s}`).join("\n")}` : "",
		gaps.length ? `## Close these first\n\n${gaps.map((g) => `- ${g}`).join("\n")}` : "",
		"",
		"## The ladder",
		"",
		"Public writing → a 120+ meetup (the audition, and where the recording comes from) → conference candidate. ELC has run this loop since 2019; the meetup rung exists precisely so nobody's first big stage is also their riskiest.",
		"",
		`Assessed against ${PLAYBOOK} and the practitioner test in the meetup topic guide. Note: ELC commits fee and travel only when confirmed per person — the playbook's default is "will do my best to cover travel", never an implied promise.`,
	]
		.filter(Boolean)
		.join("\n");

	return {
		report,
		source: "https://www.engineeringleaders.io/toolkit/",
		verdict,
		data: {
			tier,
			prior_talks: talks,
			has_recording: recording,
			writes_publicly: writing,
			practitioner: practitioner && !consultant,
			title_red_flags: titleFlags,
			blockers: blockers.length,
		},
	};
}
