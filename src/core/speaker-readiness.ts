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
	/**
	 * 2026-09-05 persona round. These were inferred from prose by substring match, which meant
	 * "She has never given a talk, has no recording, does not blog" returned
	 * `has_recording: true, writes_publicly: true` and told the organiser "There is a recording.
	 * This is the playbook's explicit graduation criterion" — crediting an honest applicant with
	 * the exact assets she had just declared she lacks. Substring matching cannot see negation,
	 * so the facts that decide the tier are now asked for directly, exactly like `has_dry_run`.
	 * Prose inference survives only as a fallback, and only when no negation is present.
	 */
	has_recording?: boolean;
	writes_publicly?: boolean;
	/**
	 * Facts read out of the prose by src/core/extract.ts. When present these are AUTHORITATIVE
	 * over every regex below — the regexes were the reason this tool was withheld. Explicit
	 * caller-supplied booleans still win over both: a submitter who states a fact outranks a
	 * reader interpreting one.
	 */
	evidence?: {
		prior_talks: number | null;
		has_recording: boolean;
		writes_publicly: boolean;
		practitioner: boolean;
		disclaims_experience: boolean;
		commercial_intent: boolean;
		named_company: string | null;
	};
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

/**
 * Stated scope: a headcount, a team count, an org they ran. This is evidence of having done
 * the job; a job title is a claim about it. A persona got `practitioner: true` from
 * "VP of Engineering. I have never worked in tech and I made this title up", and
 * `practitioner: false` from "runs the payments group, 30 engineers across four teams" — the
 * flag was reading titles and ignoring the only sentence containing evidence.
 */
const STATED_SCOPE =
	/\b\d+\s*(\+\s*)?(engineers?|developers?|people|reports|teams?|squads?)\b|\bteams? of \d+|\borg of \d+/i;

/**
 * Evidence that a recording exists — the playbook's explicit graduation criterion.
 *
 * PAST TENSE ONLY. The old pattern matched the bare noun "keynote", so "Engineering manager.
 * Wants a sponsored keynote" was credited with a recording and a prior talk — a request read as
 * a history. Meanwhile "Has spoken at three international conferences including QCon and GOTO"
 * returned nothing, because "spoken at" was not in the list. It credited the ask and ignored
 * the fact.
 */
const HAS_RECORDING =
	/\b(recording|recorded|on youtube|video of (the|her|his|their) talk|spoke at|has spoken|keynoted|gave a (talk|keynote)|conference talk|previous talks?)\b/i;

/** A wish, not a history: "wants to keynote", "looking for a speaking slot". */
const WANTS_STAGE =
	/\b(want(s|ed)? (a |to )?|looking for (a )?|seeking (a )?|would like (a |to )?|hoping (for|to) )(sponsored |paid )?(keynote|speaking slot|stage|slot|talk)\b/i;

/** The emerging-lane profile: some public writing, not yet a stage presence. */
const HAS_WRITING = /\b(blog|blogged|writes?|writing|newsletter|substack|posts?|article|medium)\b/i;

/** Named-company signal. The guide: case studies from named companies consistently outperform. */
const NAMED_COMPANY = /\bat\s+[A-Z][A-Za-z0-9.&-]{2,}/;

/**
 * Commercial intent, stated outright. `PRACTITIONER_SHAPE` matches "vp", so "VP of Sales at
 * Acme. Career salesperson, never managed engineers. This is a paid vendor slot and the talk is
 * a sales pitch" scored `practitioner: true, blockers: 0` and got a stage recommendation — while
 * `evaluate_meetup_topic`, sitting next to it, refuses the same request in plain words. Two
 * personas walked through that gap. A commercial ROLE alone is not disqualifying (a VP Sales can
 * tell an honest story); a commercial role plus selling INTENT is.
 */
const COMMERCIAL_ROLE =
	/\b(vp|vice president|head|director) of (sales|marketing|revenue|growth|business development)\b|\b(account executive|sales (rep|lead|engineer|person)|salesperson|cro\b|sdr\b|bdr\b)/i;

const SELLING_INTENT =
	/\b(sales pitch|product (demo|pitch|deep dive)|generate leads?|lead (gen|generation|capture)|badge scan|scan badges|free trial|signup qr|sign-?up qr|paid (vendor )?slot|buying the stage|sell to the audience|pricing walkthrough)\b/i;

/** Explicit denial of an asset, e.g. "no recording", "has never blogged", "does not write". */
function denies(text: string, subject: RegExp): boolean {
	// Look for a negator within ~40 characters before the asset word — close enough to be the
	// same clause, loose enough to survive "she has no recording of any talk anywhere".
	const negated = new RegExp(
		`\\b(no|not|never|without|lacks?|zero|neither|nor|does ?n[o']t|has ?n[o']t|have ?n[o']t|is ?n[o']t)\\b[^.!?]{0,40}?${subject.source}`,
		"i",
	);
	return negated.test(text);
}

export function assessSpeakerReadiness(input: SpeakerInput): ServiceResult {
	const { talk_title, speaker_background, prior_talks, has_dry_run } = input;
	const bg = speaker_background;

	const signals: string[] = [];
	const gaps: string[] = [];
	const blockers: string[] = [];

	// ── Practitioner vs vendor: the fastest disqualifier ─────────────────────
	const ev = input.evidence;
	const consultant = ev ? !ev.practitioner && CONSULTANT_SHAPE.test(bg) : CONSULTANT_SHAPE.test(bg);
	// Scope counts as evidence on its own; a title alone is only a claim. Either establishes the
	// practitioner signal, but a stated scope is the stronger one and is called out separately.
	const scope = ev ? ev.practitioner : STATED_SCOPE.test(bg);
	// An explicit disclaimer outranks any title. "VP of Engineering. I have never worked in tech
	// and I made this title up" scored practitioner: true, because the flag read the two words
	// before the full stop and ignored the sentence after it. A title is a claim; a disclaimer
	// is the submitter telling you the claim is empty.
	const disclaimsExperience = ev
		? ev.disclaims_experience
		: /\b(never (worked|managed|led|run|ran)|no (engineering|technical|industry) (experience|background)|made (this|the) title up|not (actually|really) (an? )?(engineer|manager))\b/i.test(
				bg,
			);
	const practitioner = (ev ? ev.practitioner || PRACTITIONER_SHAPE.test(bg) : PRACTITIONER_SHAPE.test(bg) || scope) && !disclaimsExperience;

	// Selling intent is checked FIRST and outranks any title. A stated sales pitch is not a
	// readiness question at any tier.
	const commercial = COMMERCIAL_ROLE.test(bg);
	// A DENIAL is not a confession. `SELLING_INTENT` is a substring matcher, so "I am not
	// selling anything, no product pitch" fired it and blocked an honest practitioner at Tier 3,
	// while the same bio with the disclaimer deleted scored Tier 1. It punished honesty and
	// rewarded silence — in a CFP triage tool, the worst possible direction. This is the exact
	// negation bug already fixed for `has_recording`; it was never applied here.
	// The model reads denials correctly, which the regex could not: "I am not selling anything"
	// blocked an honest engineer at Tier 3 while deleting the denial scored Tier 1.
	const selling = ev
		? ev.commercial_intent
		: (SELLING_INTENT.test(bg) && !denies(bg, SELLING_INTENT)) || SELLING_INTENT.test(talk_title);

	if (selling) {
		blockers.push(
			`**This is a sales pitch, and ELC does not sell stage time.** The background or title states commercial intent outright${commercial ? " from a commercial role" : ""}. A speaker at an ELC event passes the same bar as every other speaker, whoever is paying, because the room can tell. Rewrite around what the team did and what broke, with the product incidental — or buy reach directly at https://www.engineeringleaders.io/reach/, which is an honest way to reach the same people.`,
		);
	} else if (commercial && !PRACTITIONER_SHAPE.test(bg.replace(COMMERCIAL_ROLE, ""))) {
		blockers.push(
			"**Commercial role, no engineering leadership stated.** The title given is a sales or marketing one, and nothing in the background describes running an engineering org. The topic guide's test is whether the speaker did the thing, not whether they can describe it. If they have run engineering, say so in those terms; if not, this is not a fit for the stage.",
		);
	}

	if (consultant && !practitioner) {
		blockers.push(
			"**Reads as a vendor or advisor, not a practitioner.** The topic guide is blunt: speakers must be people who have done the thing, not people who advise on it — \"your audience detects vendor pitches instantly.\" If they have actually run the org they are describing, say so in those terms instead.",
		);
	} else if (practitioner && !blockers.length) {
		signals.push("Practitioner role — they have held the job, not just advised on it.");
	} else {
		gaps.push(
			"Their role is not stated in a way the room can place. Give the title and the scope: how many engineers, how many teams, at what company.",
		);
	}

	// NAMED_COMPANY only matches the English "at X", so Czech "ve firmě Fenwick" scored none.
	if (ev ? ev.named_company !== null : NAMED_COMPANY.test(bg)) {
		signals.push("Named company — case studies from recognisable companies consistently outperform generic advice.");
	} else {
		gaps.push("No named company. The audience weights a story far more heavily when it belongs to a real org.");
	}

	// ── Stage evidence: the playbook's graduation criterion ──────────────────
	// Explicit input wins. Prose inference is the fallback, and a denial in the prose beats a
	// bare keyword match — "no recording" must never read as evidence of a recording.
	// Precedence: what the caller states > what the model reads > what a regex guesses.
	const recording =
		input.has_recording ??
		ev?.has_recording ??
		(HAS_RECORDING.test(bg) && !denies(bg, HAS_RECORDING) && !WANTS_STAGE.test(bg));
	const writing =
		input.writes_publicly ?? ev?.writes_publicly ?? (HAS_WRITING.test(bg) && !denies(bg, HAS_WRITING));
	// "spoke at three international conferences including QCon and GOTO" used to score zero.
	const talks = prior_talks ?? ev?.prior_talks ?? (recording ? 1 : 0);

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
	} else if (talks >= 3 && recording) {
		// The title used to gate this tier (`titleFlags === 0`), which made Tier 1 practically
		// unreachable: a persona swept prior_talks from 0 to 999 with a recording and public
		// writing and got Tier 2 every time, because almost every real title carries at least
		// one flag. A fixable title is not a reason to reject a proven speaker — it is a note
		// to send with the invitation, and it appears in the gaps list below either way.
		tier = 1;
		verdict = "Tier 1 — invite now, conference-ready";
		next =
			// This sentence used to hardcode "a practitioner story" regardless of the flag, so a
			// Tier 1 verdict asserted it four lines above its own data saying practitioner: false.
			// It now reads the flags it just computed.
			`Go straight to a conference or headline slot. There is a recording to point at and ${talks} prior talks${practitioner && !consultant ? ", from someone who has held the job" : ", though the background does not establish they ran the thing themselves — worth confirming before you announce them"}. ${titleFlags === 0 ? "The title holds up as it stands." : `Send the title notes below with the invitation — ${titleFlags} flag${titleFlags === 1 ? "" : "s"} to fix, which is an edit, not a reason to pass.`} Log the approach on the Speakers Pipeline board and follow the one-decision-complete-message rule.`;
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
			// Must agree with the "Working for them" bullet above, which is why it is derived
			// from the same conditions rather than recomputed: a persona caught the prose
			// printing "Practitioner role — they have held the job" while this field said false.
			practitioner: practitioner && !consultant && !blockers.length,
			commercial_intent: selling,
			title_red_flags: titleFlags,
			blockers: blockers.length,
		},
	};
}
