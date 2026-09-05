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

const GUIDE = "the ELC meetup topic guide";

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
	// Czech and Slovak. Added 2026-09-05: the list was English-only, so "nejlepší praxe"
	// passed where "best practices" failed and a Czech organiser got a BETTER score for the
	// identical bad title. Prague, Brno and Bratislava are the core stages, not an edge case.
	"nejlepší praxe",
	"nejlepsi praxe",
	"osvědčené postupy",
	"osvedcene postupy",
	"digitální transformace",
	"digitalni transformace",
	"digitálna transformácia",
	"synergie",
	"efektivita a inovace",
	"posunout na další úroveň",
	"posunout na dalsi uroven",
	"komplexní řešení",
	"komplexni reseni",
	"holistický přístup",
	"holisticky pristup",
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

/**
 * Vendor-pitch detection. Added 2026-09-05 at Marian's direction after a persona test:
 * a VP of Sales submitted an abstract naming a product demo, his SDR team in the room and a
 * request for the attendee list afterwards. This scorer rated it 7/8 "Fixable" and had
 * coached him up from 5/9 — the tool built to protect the room tutored a vendor past it.
 *
 * The room's whole value is that it does not get sold to; buy_reach says so in writing
 * ("NOT FOR SALE, at any price: pitching from an ELC stage"). A quality score that ignores
 * that is worse than no score, because it launders a pitch into a compliant-looking talk.
 */
/**
 * `weak: true` means the phrase is suggestive but has an innocent reading, so it never accuses
 * on its own. "I will walk through the timeline" is how an honest post-mortem is described, and
 * on 2026-09-05 that single phrase made the tool call a real incident review a vendor pitch AND
 * upsell the speaker to buy reach — a paid-product pitch fired at a false positive, which one
 * persona named the most damaging thing in the tool. A strong hit accuses alone; weak hits need
 * a second signal.
 */
const VENDOR_PITCH: Array<{ re: RegExp; what: string; weak?: boolean }> = [
	{ re: /\b(product|platform|solution) (demo|walkthrough|walk[- ]through)\b/i, what: "a product demo or walkthrough" },
	{ re: /\b(demo|walkthrough|walk[- ]through)\b/i, what: "a demo or walkthrough", weak: true },
	{ re: /\bfree trial\b|\btrial (available|for attendees)\b/i, what: "a free trial offered to the room" },
	{ re: /\b(sign|signup|sign-up) ?(up )?(qr|link|sheet)\b/i, what: "a signup capture at the event" },
	{ re: /\ba few seats available\b|\bfirst come\b/i, what: "a scarcity close", weak: true },
	{ re: /\bpricing (tiers?|model|maps?|walkthrough)\b/i, what: "a pricing walkthrough" },
	{ re: /\b(sdr|sales team|sales rep|account executive|our sales)\b/i, what: "sales staff working the room" },
	{ re: /\battendee (list|emails?|contacts?|details)\b/i, what: "a request for the attendee list" },
	{ re: /\bcollect (attendee |their )?(emails?|contacts?|details)\b/i, what: "collecting attendee contact details" },
	{ re: /\b(book|schedule) follow[- ]?ups?\b/i, what: "booking follow-ups at the event" },
	{ re: /\bin exchange for (the )?(room|stage|slot|speaking)\b/i, what: "paying for the room or the slot" },
	{ re: /\b(sponsor|sponsoring) the (drinks|venue|room|event)\b.*\b(segment|slot|talk|stage)\b/i, what: "sponsorship traded for stage time" },
	{ re: /\bour (product|platform|tool|solution) (helped|lets|allows|enables)\b/i, what: "the product as the subject of the talk" },
	// Czech and Slovak. 2026-09-05: the buzzword list had been localised but this one had not,
	// so a Czech-language pitch — "živé demo produktu, ceníkové úrovně, bezplatnou zkušební
	// verzi, obchodní tým" — returned vendor_pitch: [] with no flag and no handoff. Prague,
	// Brno and Bratislava are the core stages; a vendor writing in Czech walked straight past
	// the gate that exists to protect exactly those rooms.
	{ re: /\b(demo|ukázk[au]|prezentac[ei]) (produktu|našeho|nášho|riešenia|řešení)\b/i, what: "a product demo (cs/sk)" },
	{ re: /\b(cen[íi]k|cenov[éeá] (úrovn[ěe]|hladiny|balíčky)|ceníkové úrovně)\b/i, what: "a pricing walkthrough (cs/sk)" },
	{ re: /\b(bezplatn[áou]|zdarma) (zkušební|skúšobn[áu]) (verz[ie]|dob[au])\b|\bzkušební verzi\b/i, what: "a free trial offered to the room (cs/sk)" },
	{ re: /\b(obchodn[íi] (tým|zástupce|oddělení)|náš obchodn[íi])\b/i, what: "sales staff working the room (cs/sk)" },
	{ re: /\b(kontakty na účastníky|seznam účastníků|zoznam účastníkov|sbírat kontakty|zbierať kontakty)\b/i, what: "collecting attendee contact details (cs/sk)" },
	{ re: /\b(sleva|zľava|slevov[ýy] k[óo]d)\b/i, what: "a discount code for the room (cs/sk)", weak: true },
];

/**
 * The literal text a pattern matched. The title checks already quote the offending words back;
 * the abstract checks did not, so a persona was told "Found a product demo or walkthrough" and
 * had to bisect a 110-word abstract by hand to discover the phrase was "I will walk through".
 * Naming the words is the difference between advice and an accusation.
 */
function quoted(re: RegExp, haystack: string): string {
	return haystack.match(re)?.[0]?.trim() ?? "";
}

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

/** Facts read from the prose by src/core/extract.ts. Authoritative over the regexes below. */
export interface TopicEvidenceInput {
	has_stakes: boolean;
	has_contrarian_angle: boolean;
	commercial_intent: boolean;
	has_specifics: boolean;
	named_company: string | null;
}

export interface MeetupTopicInput {
	title: string;
	abstract?: string;
	audience?: string;
	/** Read from the prose by src/core/extract.ts. Authoritative over the regexes above. */
	evidence?: TopicEvidenceInput;
}

export function evaluateMeetupTopic(input: MeetupTopicInput): ServiceResult {
	const { title, abstract, audience } = input;
	const ev = input.evidence;

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

	// A "?" used to be sufficient on its own, so appending one to "Microservices Best Practices"
	// lifted it a whole band. When the reader has looked at the text, stakes or a genuine
	// contrarian claim decide this, and punctuation decides nothing.
	const spicy = ev
		? ev.has_stakes || ev.has_contrarian_angle
		: bare.trim().endsWith("?") ||
			EMOTIONAL_PULL.some((e) => e.re.test(bare)) ||
			/\b(stop|kill|rip|forget|wrong|myth|lie|nobody|nobody's|why most|f\*+k|dead)\b/i.test(bare);
	// `spicy` reads the TITLE; the emotional-pull check further down reads title + abstract. When
	// the hook is in the abstract only, the old wording said "no emotional hook here" while the
	// data block reported `emotional_pull: ["ambition"]` and a bullet said "Taps ambition" — the
	// same output denying and asserting one fact. A CFO persona named that the session-ender.
	// The finding is real but it is about the title, so the message now says which.
	const pullInAbstract = abstract ? EMOTIONAL_PULL.some((e) => e.re.test(abstract)) : false;
	if (spicy) {
		pass.push("Has a pointed angle — a question, a contrarian framing, or real emotional pull.");
	} else if (pullInAbstract) {
		fail.push(
			"**The hook is in the abstract, not the title.** The abstract has real pull, but the title is where the click happens — on LinkedIn and Luma most people never reach the abstract. Pull the angle up into the title.",
		);
	} else {
		fail.push(
			"**No spice.** The guide: \"Safe titles get safe attendance.\" There is no question, no contrarian claim, and no emotional hook in the title. What belief does this talk challenge?",
		);
	}

	// A bare year is not data. "Introduction to Kubernetes in 2027" used to earn "Carries a
	// number, which helps scanning" — the check rewarded the single laziest thing you can add
	// to a stale title, and a persona used exactly that to lift a known-bad title a whole band.
	const numbersWithoutYears = bare.replace(/\b(19|20)\d{2}\b/g, "");
	if (HAS_PERCENT_OR_SCALE.test(bare)) {
		pass.push("Backed by data in the title — a concrete number or scale.");
	} else if (HAS_NUMBER.test(numbersWithoutYears)) {
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
			const hit = abstract.match(rf.pattern);
			if (!hit) continue;
			// Quote what the author actually wrote. Reporting the canonical phrase in quotes
			// reads as a quotation of their text and was called out as fabricated by a tester
			// whose abstract said "In this session we will explore" while the flag claimed
			// "In this meetup, we will explore".
			fail.push(`**Abstract red flag** — "${hit[0].trim()}" (${rf.flag}). ${rf.fix}`);
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

	// ── Is this a talk, or a pitch? ──────────────────────────────────────────
	const haystack = `${bare}\n${abstract ?? ""}`;
	// The reader outranks the keyword list in BOTH directions: it caught a Czech pitch the
	// patterns missed entirely, and it clears "I will walk through the timeline" in an honest
	// post-mortem, which the patterns could only ever demote to a hedged note.
	const patternHits = VENDOR_PITCH.filter((v) => v.re.test(haystack));
	const allHits = !ev
		? patternHits
		: !ev.commercial_intent
			? []
			: patternHits.length
				? patternHits
				: [{ re: /$^/, what: "selling from the stage, stated in the submission" }];
	const strongHits = allHits.filter((v) => !v.weak);
	// Accuse on a strong signal, or on two independent weak ones. A single weak hit is reported
	// as a question, without the accusation and without the upsell.
	const pitchHits = strongHits.length || allHits.length >= 2 ? allHits : [];

	if (pitchHits.length) {
		fail.push(
			`**This reads as a vendor pitch, not a talk.** Found ${pitchHits.map((p) => p.what).join("; ")}${pitchHits.map((p) => quoted(p.re, haystack)).filter(Boolean).length ? ` — the exact wording: ${pitchHits.map((p) => quoted(p.re, haystack)).filter(Boolean).map((q) => `"${q}"`).join(", ")}` : ""}. ELC does not sell stage time: a speaker at a meetup passes the same bar as every other speaker, because the room can tell. Rewrite around what your team did and what broke, with the product incidental — or buy reach directly instead, which is an honest way to reach the same people.`,
		);
	} else if (allHits.length === 1) {
		ask.push(
			`One phrase here — "${quoted(allHits[0].re, haystack)}" — is also how a vendor pitch is worded. It is almost certainly innocent in a real post-mortem, so this is not a flag: just make sure the talk's subject is what your team did, not what your product does.`,
		);
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
	// No X/Y score. The denominator used to be passed + red_flags, which made 6/6 and 9/9
	// tautological and non-comparable between runs — and adding an abstract flipped
	// "Ready to publish" to "Reconsider" purely because more checks existed. Red flags are
	// an absolute count and mean the same thing on every run.
	/**
	 * A content floor before any verdict is possible.
	 *
	 * 2026-09-05: "Is 🔥🚀💀 in 2027 Dead?" scored "Ready to publish — no mechanical red flags,
	 * 6 things already working", and an abstract that was largely the word "banana", correctly
	 * formatted, beat a real Rohlik post-mortem. Every check here is mechanical — length, shape,
	 * punctuation, buzzword absence — so a string with no words passes them all by having
	 * nothing to catch. Absence of red flags is not evidence of a topic; it has to clear a bar
	 * of actually being one first.
	 */
	// Count CONTENT words, not tokens. "Is 🔥🚀💀 in 2027 Dead?" has three things that look like
	// words but only one that carries meaning, while "Managing distributed teams" is a thin but
	// entirely legitimate title with three. Counting tokens cannot tell those apart; dropping
	// function words can.
	const STOPWORDS = new Set([
		"a", "an", "the", "is", "are", "was", "were", "be", "been", "in", "on", "at", "to", "for",
		"of", "and", "or", "but", "with", "from", "by", "as", "it", "its", "this", "that", "we",
		"you", "your", "our", "my", "i", "do", "does", "did", "how", "why", "what", "when", "who",
		"still", "not", "no", "yet", "now", "up", "out", "so",
	]);
	const contentWords = bare
		.split(/\s+/)
		.map((w) => w.replace(/[^\p{L}\p{N}-]/gu, "").toLowerCase())
		.filter((w) => /[\p{L}]{2,}/u.test(w) && !STOPWORDS.has(w));
	const tooThin = contentWords.length < 2;

	const verdict = tooThin
		? "Not scorable — there is no topic here yet"
		: fail.length === 0
			? "Ready to publish — no mechanical red flags"
			: fail.length <= 2
				? "Fixable — a rewrite away from ready"
				: "Reconsider — too many red flags to fill the room";

	if (tooThin) {
		// Only the positives are cleared. A real mechanical fault (too long, buzzword-stuffed)
		// is still a real fault and stays; it was the "6 things already working" on three emoji
		// that was vacuous, because those checks pass by having nothing to catch.
		pass.length = 0;
		fail.unshift(
			`**Only ${contentWords.length} content word${contentWords.length === 1 ? "" : "s"} in the title.** Every check here is mechanical — length, shape, buzzwords, formulas — so a title with almost no words passes them all by giving them nothing to catch. That is not a good title, it is an unscoreable one. Write the actual claim first, then run this again.`,
		);
	}

	const report = [
		`# Topic evaluation: "${bare}"`,
		"",
		`**${verdict}.** ${fail.length} red flag${fail.length === 1 ? "" : "s"} to fix${pass.length ? `, ${pass.length} thing${pass.length === 1 ? "" : "s"} already working` : ""}.`,
		"",
		fail.length ? `## Fix these\n\n${fail.map((f) => `- ${f}`).join("\n")}` : "",
		pass.length ? `## Working\n\n${pass.map((p) => `- ${p}`).join("\n")}` : "",
		`## Only you can answer these\n\n${ask.map((a) => `- ${a}`).join("\n")}`,
		"",
		`Scored against ${GUIDE} — the checklist behind 12 meetups a year at 120+ attendees since 2019. The mechanical checks are measured, not estimated; the questions above are the ones the guide says a human has to answer.`,
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
			vendor_pitch: pitchHits.map((p) => p.what),
			red_flags: fail.length,
			formulas_matched: matched.map((f) => f.name),
			emotional_pull: pull.map((p) => p.theme),
			abstract_words: abstract ? words(abstract) : null,
		},
	};
}
