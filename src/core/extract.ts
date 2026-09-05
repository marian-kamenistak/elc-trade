/**
 * Evidence extraction, model-backed.
 *
 * WHY THIS EXISTS. `evaluate_meetup_topic` and `assess_speaker_readiness` were withheld on
 * 2026-09-05 after three rounds of persona testing defeated them a different way each round:
 *
 *   - a single "?" lifted a known-bad title a whole band, because "provocative question" was
 *     `endsWith("?")`;
 *   - writing a real abstract LOWERED the verdict, so withholding information scored better;
 *   - "I am not selling anything, no product pitch" read as selling intent and blocked an
 *     honest engineer at Tier 3, while deleting the denial scored Tier 1 — a denial read as a
 *     confession;
 *   - "Has spoken at three international conferences including QCon and GOTO" scored zero
 *     prior talks, while "Wants a sponsored keynote" was credited with a recording;
 *   - a Czech-language sales pitch passed both tools untouched, in ELC's own core language.
 *
 * Every one of those is the same defect: a regex asked to read meaning. Patching each instance
 * produced the identical bug in a neighbouring check. This module is the fix — one call that
 * reads the prose and returns FACTS, which the existing deterministic scorers then judge.
 *
 * THE DIVISION OF LABOUR MATTERS AND IS DELIBERATE:
 *   - the model extracts only what is *stated* — counts, denials, intent, named companies. It
 *     never scores, ranks, or decides a tier. It is a reader, not a judge.
 *   - the scorers keep every mechanical check exactly as it was — title length, buzzwords,
 *     formulas, abstract word counts. Those were never wrong, and they are reproducible.
 * So the same input still produces the same verdict for the same facts, and the part that
 * moved is the part that was guessing.
 *
 * FAIL CLOSED, NEVER FAIL BACK. If the key is missing, the call errors, or the response does
 * not parse, this returns null and the caller returns the withheld notice. It must NEVER
 * silently fall back to the keyword scorer: that is precisely the confident-wrong-answer
 * failure the withholding was for, and a degraded path nobody can see is how it would return.
 */

const MODEL = "claude-sonnet-5";
const MAX_INPUT_CHARS = 6000;

export interface ExtractEnv {
	ANTHROPIC_API_KEY?: string;
}

/** What a speaker submission actually states. Absent evidence is `false`/`null`, never inferred. */
export interface SpeakerEvidence {
	/** Talks explicitly claimed. `null` when the text says nothing about prior speaking. */
	prior_talks: number | null;
	/** A recording is stated to EXIST. A request to speak, or a denial, is false. */
	has_recording: boolean;
	/** They publish writing. A denial ("does not blog") is false. */
	writes_publicly: boolean;
	/** They are stated to have RUN engineering work — scope, headcount, an org they led. */
	practitioner: boolean;
	/** Their own words disclaim the experience their title implies. */
	disclaims_experience: boolean;
	/** They state an intent to sell, demo, capture leads or scan badges FROM the stage. */
	commercial_intent: boolean;
	/** A named employer, in any language. */
	named_company: string | null;
	/** Short quotes backing each true flag, so a human can audit the extraction. */
	evidence: string[];
}

/** What a topic submission actually states, beyond what mechanical checks can see. */
export interface TopicEvidence {
	/** Real stakes: a named failure, a consequence, something that went wrong. */
	has_stakes: boolean;
	/** A claim that challenges a belief the audience holds — not merely a question mark. */
	has_contrarian_angle: boolean;
	/** Selling from the stage: demo, pricing, trial, lead capture, discount code. */
	commercial_intent: boolean;
	/** Specific evidence in the abstract — numbers, dates, named systems, an incident. */
	has_specifics: boolean;
	/** A named company, in any language. */
	named_company: string | null;
	/** Short quotes backing each true flag. */
	evidence: string[];
}

const SPEAKER_TOOL = {
	name: "record_speaker_evidence",
	description: "Record ONLY what the submission states. Never infer, never flatter, never guess.",
	input_schema: {
		type: "object",
		properties: {
			prior_talks: {
				type: ["integer", "null"],
				description:
					"Number of talks the text states they have GIVEN. 'three international conferences' is 3. 'a few' is null. A request or wish to speak is 0, never a count. Silence is null.",
			},
			has_recording: {
				type: "boolean",
				description:
					"True only if a recording of them speaking is stated to exist. 'wants a sponsored keynote' is false. 'no recording anywhere' is false.",
			},
			writes_publicly: { type: "boolean", description: "True only if they are stated to publish writing. A denial is false." },
			practitioner: {
				type: "boolean",
				description:
					"True if the text states they RAN the engineering work — a headcount, teams, an org they led, a migration they owned. A job title alone is a claim, not evidence: 'VP of Engineering' with nothing else is false.",
			},
			disclaims_experience: {
				type: "boolean",
				description: "True if their own words deny the experience a title implies ('I have never worked in tech').",
			},
			commercial_intent: {
				type: "boolean",
				description:
					"True only if they state an intent to SELL from the stage — a product demo, pricing, a free trial, lead capture, badge scanning, a paid vendor slot. A DENIAL ('I am not selling anything', 'no product pitch') is FALSE. Working at a vendor is not commercial intent.",
			},
			named_company: { type: ["string", "null"], description: "Employer if named, in any language. Otherwise null." },
			evidence: {
				type: "array",
				items: { type: "string" },
				description: "Short verbatim quotes justifying each true flag, so a human can audit this.",
			},
		},
		required: [
			"prior_talks",
			"has_recording",
			"writes_publicly",
			"practitioner",
			"disclaims_experience",
			"commercial_intent",
			"named_company",
			"evidence",
		],
	},
} as const;

const TOPIC_TOOL = {
	name: "record_topic_evidence",
	description: "Record ONLY what the title and abstract state. Never infer, never flatter, never guess.",
	input_schema: {
		type: "object",
		properties: {
			has_stakes: {
				type: "boolean",
				description:
					"True if something real is at stake — a failure, an outage, people leaving, a decision that cost something. 'We lost 40% of the platform team' is true. A neutral question is false.",
			},
			has_contrarian_angle: {
				type: "boolean",
				description:
					"True if it challenges a belief the audience likely holds. A question mark alone is NOT enough — 'Do Managers Still Need to Code?' is a stale panel prompt, not a contrarian claim.",
			},
			commercial_intent: {
				type: "boolean",
				description:
					"True if this sells from the stage: product demo, pricing, free trial, discount code, lead capture, sales staff in the room. In ANY language, including Czech and Slovak. Describing a talk as 'I will walk through the timeline' is NOT commercial.",
			},
			has_specifics: {
				type: "boolean",
				description: "True if the abstract carries real specifics — numbers, dates, named systems, a described incident.",
			},
			named_company: { type: ["string", "null"], description: "Company if named, in any language. Otherwise null." },
			evidence: { type: "array", items: { type: "string" }, description: "Short verbatim quotes backing each true flag." },
		},
		required: ["has_stakes", "has_contrarian_angle", "commercial_intent", "has_specifics", "named_company", "evidence"],
	},
} as const;

const SYSTEM =
	"You extract stated facts from a conference submission for the Engineering Leaders Community. " +
	"You are a reader, not a judge: never score, rank or recommend. Record only what the text states. " +
	"Treat a denial as a denial — 'no recording', 'I am not selling anything', 'never spoken' are all FALSE, " +
	"and a request to do something is never evidence of having done it. " +
	"Submissions arrive in English, Czech and Slovak; read all three the same way. " +
	"When the text is silent or ambiguous, choose the value that claims LESS.";

async function extract<T>(
	env: ExtractEnv,
	tool: { name: string },
	toolSchema: unknown,
	userText: string,
): Promise<T | null> {
	if (!env.ANTHROPIC_API_KEY) return null;
	try {
		const res = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-api-key": env.ANTHROPIC_API_KEY,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: MODEL,
				max_tokens: 1024,
				system: SYSTEM,
				tools: [toolSchema],
				tool_choice: { type: "tool", name: tool.name },
				messages: [{ role: "user", content: userText.slice(0, MAX_INPUT_CHARS) }],
			}),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { content?: { type: string; name?: string; input?: unknown }[] };
		const use = body.content?.find((c) => c.type === "tool_use" && c.name === tool.name);
		return (use?.input as T) ?? null;
	} catch {
		// Network, timeout, malformed JSON — all identical from here: no evidence, so no verdict.
		return null;
	}
}

export const extractSpeakerEvidence = (
	env: ExtractEnv,
	input: { talk_title: string; speaker_background: string },
): Promise<SpeakerEvidence | null> =>
	extract<SpeakerEvidence>(
		env,
		SPEAKER_TOOL,
		SPEAKER_TOOL,
		`Talk title: ${input.talk_title}\n\nSpeaker background:\n${input.speaker_background}`,
	);

export const extractTopicEvidence = (
	env: ExtractEnv,
	input: { title: string; abstract?: string },
): Promise<TopicEvidence | null> =>
	extract<TopicEvidence>(
		env,
		TOPIC_TOOL,
		TOPIC_TOOL,
		`Title: ${input.title}\n\nAbstract:\n${input.abstract ?? "(none supplied)"}`,
	);
