/**
 * evaluate_meetup_topic — scores a proposed meetup title and abstract against ELC's own
 * topic guide (topics/meetup-topic-guide.md), the document behind 12 meetups a year at
 * 120+ attendees since 2019.
 *
 * Everything here is deterministic on purpose. A model asked "is this a good title?"
 * produces agreeable mush; it cannot reliably tell you the title is 94 characters, that it
 * opens with "In this meetup, we will explore", or that it matches none of the five
 * formulas that work. Those are exactly the checks the guide encodes, and they are the part
 * a caller cannot get from their own model. Judgment prompts are returned as questions for
 * the caller, never faked as findings.
 *
 * Source of every rule below: topics/meetup-topic-guide.md, Parts 1-3. Line references are
 * to that file as of 2026-09-04. If the guide changes, this file changes with it.
 */

import type { ServiceResult } from "./types";

const GUIDE = "topics/meetup-topic-guide.md";

/** Part 2 → Title Mechanics: "Keep it under 80 characters (excluding the meetup number)." */
const TITLE_MAX_CHARS = 80;

/** Part 3 → Abstract Length. */
const ABSTRACT_IDEAL_MIN = 150;
const ABSTRACT_IDEAL_MAX = 250;
const ABSTRACT_HARD_MAX = 300;

/** Part 2 → Title Red Flags: "Generic buzzwords without specifics". */
const BUZZWORDS = [
	"unlocking innovation",
	"digital transformation",
	"synergy",
	"best practices",
	"next level",
	"game changer",
	"game-changer",
	"cutting edge",
	"cutting-edge",
	"thought leadership",
	"paradigm shift",
	"future-proof",
	"future proof",
	"leveraging",
	"empowering",
	"holistic",
	"seamless",
	"deep dive",
	"unlocking the power",
	"harnessing",
];

/** Part 2 → Title Criteria 1: "Not clickbait." Manufactured urgency and empty curiosity gaps. */
const CLICKBAIT = [
	"don't miss",
	"dont miss",
	"you can't afford",
	"you cant afford",
	"you won't believe",
	"wont believe",
	"this one trick",
	"what nobody tells you",
	"the secret to",
	"everything you need to know",
	"the ultimate guide",
	"must-attend",
	"must attend",
	"last chance",
];

/** Part 3 → Abstract Red Flags, verbatim. */
const ABSTRACT_RED_FLAGS: Array<{ pattern: RegExp; flag: string; fix: string }> = [
	{
		pattern: /in this (meetup|session|talk|event),? we('| wi)ll (explore|discuss|look at|dive)/i,
		flag: '"In this meetup, we will explore…"',
		fix: "Passive and boring. Open on the problem the attendee has this quarter, in their words.",
	},
	{
		pattern: /join us for an? (evening|event|session|night)/i,
		flag: '"Join us for an evening of…"',
		fix: "Generic event language. Say what they leave knowing, not what the calendar says.",
	},
	{
		pattern: /\binsights\b/i,
		flag: 'the word "insights" without specifying what they are',
		fix: "Name the actual insight. If you cannot, the talk does not have one yet.",
	},
];

/**
 * Part 1 → trait 2: the 60-vs-120-attendee difference is discussion-shaped versus
 * takeaway-shaped. These are the verbs of a topic that has not decided what it delivers.
 */
const DISCUSSION_SHAPED = [
	/^managing\s/i,
	/^understanding\s/i,
	/^exploring\s/i,
	/^introduction to\s/i,
	/^intro to\s/i,
	/\bstrategy for\b/i,
	/\ban overview\b/i,
	/\ba discussion\b/i,
	/\bpanel on\b/i,
];

/** Part 2 → Title Formulas That Work. Matching one is a positive signal, not a requirement. */
const FORMULAS: Array<{ name: string; test: (t: string) => boolean; example: string }> = [
	{
		name: "[Number] [Things] to [Outcome]",
		test: (t) => /^\s*\d+\s+\w+/.test(t) || /\b\d+\s+(steps|ways|mistakes|lessons|rules)\b/i.test(t),
		example: "12 Steps to Boost Your Value for 2027",
	},
	{
		name: "[Provocative question]",
		test: (t) => t.trim().endsWith("?"),
		example: "From Squads to Soloists: The End of the Engineering Team as We Know It?",
	},
	{
		name: "[Topic]: [Specific angle]",
		test: (t) => /:\s*\S/.test(t),
		example: "AI Dev Tools in 2025: Reality Check",
	},
	{
		name: "How [Specific Group] Actually [Does Thing]",
		test: (t) => /^how\b.*\bactually\b/i.test(t),
		example: "How Top Tech Leaders Actually Learn in 2026",
	},
	{
		name: "[Outcome]. [How/What].",
		test: (t) => /\w\.\s+\w/.test(t.replace(/\.$/, "")),
		example: "Get Unstuck. Get Promoted. 12 Steps to Boost Your Value for 2027.",
	},
];

/** Part 1 → trait 4: emotional pull. Presence is a strong signal; absence is a question, not a fail. */
const EMOTIONAL_PULL = [
	{ theme: "career frustration", re: /\b(stuck|underpaid|passed over|plateau|dead end|overlooked)\b/i },
	{ theme: "fear of irrelevance", re: /\b(replaced|obsolete|irrelevant|left behind|dying|rip|end of)\b/i },
	{ theme: "organisational dysfunction", re: /\b(broken|dysfunction|chaos|mess|fails?|failing|toxic|clash)\b/i },
	{ theme: "ambition", re: /\b(promoted|promotion|vp|director|cto|next level up|get ahead|boost)\b/i },
];

/** Part 1 → trait 3 and Title Criterion 4: named companies and hard numbers outperform. */
const HAS_NUMBER = /\d/;
const HAS_PERCENT_OR_SCALE = /\d+\s*(%|percent|x\b|k\b|\+)/i;

function words(s: string): number {
	return s.trim().split(/\s+/).filter(Boolean).length;
}

function sentences(p: string): string[] {
	return p.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

export interface MeetupTopicInput {
	title: string;
	abstract?: string;
	audience?: string;
}

export function evaluateMeetupTopic(input: MeetupTopicInput): ServiceResult {
	const { title, abstract, audience } = input;

	// The meetup number is prepended at publication ("#38 Your Title"), so strip it before
	// measuring — Title Mechanics counts the title excluding the number.
	const bare = title.replace(/^\s*#\s*\d+\s*/, "").trim();
	const lower = bare.toLowerCase();

	const pass: string[] = [];
	const fail: string[] = [];
	const ask: string[] = [];

	// ── Title: the five criteria (Part 2) ────────────────────────────────────
	const buzz = BUZZWORDS.filter((b) => lower.includes(b));
	const bait = CLICKBAIT.filter((b) => lower.includes(b));

	if (bait.length) {
		fail.push(
			`**Clickbait** — found ${bait.map((b) => `"${b}"`).join(", ")}. The guide is blunt about this: "The audience detects bait instantly and discounts the meetup."`,
		);
	} else {
		pass.push("Not clickbait — no manufactured urgency or empty curiosity gap.");
	}

	if (buzz.length) {
		fail.push(
			`**Generic buzzwords** — ${buzz.map((b) => `"${b}"`).join(", ")}. Replace each with the specific thing it is standing in for.`,
		);
	}

	const spicy =
		bare.trim().endsWith("?") ||
		EMOTIONAL_PULL.some((e) => e.re.test(bare)) ||
		/\b(stop|kill|rip|forget|wrong|myth|lie|nobody|nobody's|why most|f\*+k|dead)\b/i.test(bare);
	if (spicy) {
		pass.push("Has a pointed angle — a question, a contrarian framing, or real emotional pull.");
	} else {
		fail.push(
			"**No spice.** The guide: \"Safe titles get safe attendance.\" There is no question, no contrarian claim, and no emotional hook here. What belief does this talk challenge?",
		);
	}

	if (HAS_PERCENT_OR_SCALE.test(bare)) {
		pass.push("Backed by data in the title — a concrete number or scale.");
	} else if (HAS_NUMBER.test(bare)) {
		pass.push("Carries a number, which helps scanning on LinkedIn and Luma.");
	} else {
		ask.push(
			'Is there a real number or named company you could put in the title? The guide\'s example: "Path to 80% AI-Generated Code" beats "AI Coding at Scale".',
		);
	}

	// A discussion-shaped opener is only a problem when nothing else rescues it. The guide's
	// own weak→strong pairs keep the verb and ADD specificity: "Managing distributed teams"
	// becomes "Managing Distributed Teams: The Full Guide From Leaders Who Run 500+ People
	// Across 4 Countries". So the fail condition is the opener PLUS no angle, no scale and
	// no named company — not the opener alone.
	const hasSpecificity =
		/:\s*\S/.test(bare) || HAS_PERCENT_OR_SCALE.test(bare) || /\b[A-Z][a-z]+(?:\.[a-z]+)?\b.*\b(did|changed|broke|built|ran|runs)\b/.test(bare);
	const discussionShaped = DISCUSSION_SHAPED.some((r) => r.test(bare));
	if (discussionShaped && !hasSpecificity) {
		fail.push(
			"**Discussion-shaped, not takeaway-shaped.** This is the guide's single biggest attendance lever — the difference between 60 and 120 people. Keep the verb if you like, but add the angle: the guide turns \"Managing distributed teams\" into \"Managing Distributed Teams: The Full Guide From Leaders Who Run 500+ People Across 4 Countries\".",
		);
	} else if (discussionShaped) {
		pass.push("Opens with a broad verb but earns it with a specific angle or a hard number.");
	} else {
		pass.push("Reads as a takeaway, not a discussion.");
	}

	// ── Title mechanics (Part 2) ─────────────────────────────────────────────
	if (bare.length > TITLE_MAX_CHARS) {
		fail.push(
			`**Too long** — ${bare.length} characters, limit is ${TITLE_MAX_CHARS} excluding the meetup number. It will truncate on LinkedIn and Luma.`,
		);
	} else {
		pass.push(`Length fine — ${bare.length}/${TITLE_MAX_CHARS} characters.`);
	}

	if (!/^\s*#\s*\d+/.test(title)) {
		ask.push('Remember the meetup number goes in front at publication: "#38 Your Title Here".');
	}

	const matched = FORMULAS.filter((f) => f.test(bare));
	if (matched.length) {
		pass.push(`Matches a proven formula — ${matched.map((f) => f.name).join("; ")}.`);
	} else {
		fail.push(
			`**Matches none of the five title formulas that work.** Closest fits to try:\n${FORMULAS.slice(0, 3)
				.map((f) => `  - ${f.name} — e.g. "${f.example}"`)
				.join("\n")}`,
		);
	}

	const pull = EMOTIONAL_PULL.filter((e) => e.re.test(`${bare} ${abstract ?? ""}`));
	if (pull.length) {
		pass.push(`Taps ${pull.map((p) => p.theme).join(" and ")} — the guide's fourth attendance trait.`);
	}

	// ── Abstract (Part 3) ────────────────────────────────────────────────────
	if (abstract) {
		const w = words(abstract);
		if (w > ABSTRACT_HARD_MAX) {
			fail.push(`**Abstract too long** — ${w} words, hard maximum ${ABSTRACT_HARD_MAX}. "After that, you're losing people."`);
		} else if (w < ABSTRACT_IDEAL_MIN) {
			fail.push(`**Abstract too thin** — ${w} words, ideal is ${ABSTRACT_IDEAL_MIN}-${ABSTRACT_IDEAL_MAX}. Too short to be specific.`);
		} else if (w > ABSTRACT_IDEAL_MAX) {
			ask.push(`Abstract is ${w} words — inside the hard limit but past the ${ABSTRACT_IDEAL_MAX}-word ideal. Trim if you can.`);
		} else {
			pass.push(`Abstract length good — ${w} words, inside the ${ABSTRACT_IDEAL_MIN}-${ABSTRACT_IDEAL_MAX} ideal.`);
		}

		for (const rf of ABSTRACT_RED_FLAGS) {
			if (rf.pattern.test(abstract)) fail.push(`**Abstract red flag** — ${rf.flag}. ${rf.fix}`);
		}

		const longParas = abstract
			.split(/\n{2,}/)
			.map((p, i) => ({ i: i + 1, n: sentences(p).length }))
			.filter((p) => p.n > 3);
		if (longParas.length) {
			fail.push(
				`**Paragraphs longer than 3 sentences** — paragraph${longParas.length > 1 ? "s" : ""} ${longParas.map((p) => p.i).join(", ")}. Break them up; walls of text don't get read.`,
			);
		}

		if (!/(^|\n)\s*[-*•]\s+/.test(abstract)) {
			fail.push("**No bullet points.** The guide calls this out directly — walls of text don't get read.");
		}
	} else {
		ask.push("No abstract supplied. The 3-part abstract formula in Part 3 is where most of the registration decision is won.");
	}

	// ── Audience mix (Topic Selection Checklist) ─────────────────────────────
	if (audience) {
		// Plurals matter: a trailing \b after "cto" cannot match "CTOs", and an audience is
		// almost always written in the plural ("Engineering managers and CTOs"). Without the
		// optional s every realistic input scored zero segments.
		const segs = [
			/\b(developers?|engineers?|ics?|individual contributors?|staff|principals?)\b/i.test(audience),
			/\b(ems?|engineering managers?|team leads?|tech leads?|managers?)\b/i.test(audience),
			/\b(directors?|vps?|heads? of|ctos?|cios?|execs?|executives?)\b/i.test(audience),
		].filter(Boolean).length;
		if (segs >= 2) {
			pass.push(`Audience spans ${segs} of the 3 segments — the checklist wants at least 2.`);
		} else {
			fail.push(
				"**Audience too narrow.** The checklist: relevant to at least 2 of developers, EMs, directors+. Pure IC-only or pure exec-only topics narrow the funnel.",
			);
		}
	} else {
		ask.push("Who is this for? The checklist wants it relevant to at least 2 of: developers, EMs, directors+.");
	}

	// ── Things only the organiser can answer ─────────────────────────────────
	ask.push(
		'Would someone reply "I\'m dealing with this exact thing" if you posted it in the community Slack? That is the guide\'s own test for trait 1.',
		"Do you have 2+ confirmed speakers who have actually done this, not consultants who advise on it? Case studies from named CE companies consistently outperform generic advice.",
		"Has a similar angle run in the last 6 meetups? If so, find a genuinely different take or pick another topic.",
	);

	// ── Verdict ──────────────────────────────────────────────────────────────
	// The guide's own bar is the Topic Selection Checklist: 5 of 7 or reconsider. We apply
	// the same shape to the mechanical checks we can actually measure.
	const checks = pass.length + fail.length;
	const verdict =
		fail.length === 0
			? "Ready to publish — no mechanical red flags"
			: fail.length <= 2
				? "Fixable — a rewrite away from ready"
				: "Reconsider — too many red flags to fill the room";

	const report = [
		`# Topic evaluation: "${bare}"`,
		"",
		`**${verdict}.** ${pass.length}/${checks} mechanical checks passed, ${fail.length} red flag${fail.length === 1 ? "" : "s"}.`,
		"",
		fail.length ? `## Fix these\n\n${fail.map((f) => `- ${f}`).join("\n")}` : "",
		pass.length ? `## Working\n\n${pass.map((p) => `- ${p}`).join("\n")}` : "",
		`## Only you can answer these\n\n${ask.map((a) => `- ${a}`).join("\n")}`,
		"",
		`Scored against ELC's own topic guide (${GUIDE}) — the checklist behind 12 meetups a year at 120+ attendees since 2019. The mechanical checks are measured, not estimated; the questions above are the ones the guide says a human has to answer.`,
	]
		.filter(Boolean)
		.join("\n");

	return {
		report,
		source: "https://www.engineeringleaders.io/toolkit/",
		verdict,
		data: {
			title_chars: bare.length,
			checks_passed: pass.length,
			red_flags: fail.length,
			formulas_matched: matched.map((f) => f.name),
			emotional_pull: pull.map((p) => p.theme),
			abstract_words: abstract ? words(abstract) : null,
		},
	};
}
