/**
 * The one place a service id becomes an answer.
 *
 * Both transports call `dispatch`. The MCP binding calls it from a tool handler, the A2A
 * binding calls it from a task executor, and neither contains business logic of its own —
 * that is what keeps the two surfaces from drifting into different answers for the same
 * question.
 *
 * A withheld service is NOT hidden here. It is dispatchable and returns its own reason,
 * because an agent that somehow reaches a withheld id deserves to be told why it cannot
 * have it rather than getting "unknown tool". The advertising surfaces (card, tool list)
 * are what filter on `withheld`.
 */

import { z } from "zod";
import { LIVE_SERVICES, SERVICES } from "./services";
import type { ServiceDefinition, ServiceResult } from "./types";
import { evaluateMeetupTopic } from "./meetup-topic";
import { assessSpeakerReadiness } from "./speaker-readiness";
import { callSibling, type BridgeBindings } from "./bridge";
import { renderQuote, splitQuote } from "./quote-render";
import { getStarted } from "./get-started";
import { type DealsEnv, isDealworthy, notifyDeal } from "./deals";

type Handler = (args: Record<string, unknown>) => ServiceResult | Promise<ServiceResult>;

/**
 * The sibling servers end their answers by naming their OWN next tool — `book_intro_call`,
 * `get_partnership_options`, `get_reach_options`. None of those exist at this door, so the one
 * call-to-action on a paid quote was a dead pointer: six of eleven personas called it and got
 * `Unknown service`. An autonomous agent has no fallback at all there.
 *
 * Where this door has an equivalent, the name is swapped. Where it does not, the reference is
 * replaced by something the caller can actually act on — a URL, not a tool they cannot reach.
 */
const SIBLING_TOOL_REWRITES: [RegExp, string][] = [
	// Longest patterns first — the sibling's full sentence, so the replacement reads as a
	// sentence rather than leaving "…with Marian to fix the date with Marian."
	[
		/\bbook_intro_call to fix the date with Marian\.?/g,
		"Book the date with Marian at https://www.engineeringleaders.io/partner/ — this door prices, it does not hold dates.",
	],
	[
		/\bbook_intro_call\b/g,
		"book a call at https://www.engineeringleaders.io/partner/",
	],
	// The sibling writes instructions to the ASSISTANT reading its output. Those reach the buyer
	// verbatim, so across two persona rounds people read the sales script being run on them, and
	// found themselves addressed in the third person as "a visitor" inside their own quote.
	// Rewritten at the boundary rather than in the sibling, because the sibling's own MCP callers
	// are assistants and the instructions are correct for them.
	[/\bSay so and offer\b/g, "Worth raising:"],
	[/Terms \(fixed, carry these verbatim\):/g, "Terms:"],
	[
		/\s*If a visitor asks for any of these, say no plainly and say why, and never let an offer imply otherwise\./g,
		"",
	],
	// These two used to overlap on the same sentence and spliced it into
	// "…do not reconcile by hand: The 16% AI-channel discount applies to company memberships,
	// not to these —." Four personas quoted the fragment; it shipped in the Terms block of every
	// quote, which is the one place a procurement reader looks hardest.
	//
	// The "will not reconcile" claim is also simply false — a CFO checked it and 25,000 − 3,675
	// = 21,325 exactly. Telling a numerate buyer the arithmetic does not add up, when it does,
	// reads as cover for a fudge that is not there. Both claims are removed rather than reworded.
	[/\s*never apply it here, and never invent another\./g, ""],
	[/,?\s*so this will not reconcile against the list total\.?/g, "."],
	[
		/,?\s*which is why the two do not reconcile by hand:?/g,
		".",
	],
	[
		/\s*read `combo\.qualifying_items` and `combo\.saved` from the quote\.?/g,
		"",
	],
	[/\bnever add prices yourself\b/gi, "the totals shown are computed server-side"],
	[
		/\bget_partnership_options\b/g,
		"build_partnership_business_case here, or the Membership Builder at https://www.engineeringleaders.io/mcp/partnership",
	],
	[/\bget_reach_options\b/g, "buy_reach"],
	[/\bquote_reach_combo\b/g, "buy_reach"],
	[/\bmatch_package\b|\bcustomize_package\b|\bfit_to_budget\b|\bdesign_journey\b|\brequest_offer\b/g,
		"the Membership Builder at https://www.engineeringleaders.io/mcp/partnership"],
];

function rewriteSiblingNames(text: string, service: ServiceDefinition): string {
	let out = service.bridge ? text.replaceAll(service.bridge.tool, service.id) : text;
	for (const [pattern, replacement] of SIBLING_TOOL_REWRITES) out = out.replace(pattern, replacement);
	return out;
}

const HANDLERS: Record<string, Handler> = {
	get_started: (a) =>
		getStarted(
			{ context: a.context == null ? undefined : String(a.context) },
			LIVE_SERVICES.filter((s) => s.id !== "get_started"),
		),
	evaluate_meetup_topic: (a) =>
		evaluateMeetupTopic({
			title: String(a.title ?? ""),
			abstract: a.abstract == null ? undefined : String(a.abstract),
			audience: a.audience == null ? undefined : String(a.audience),
		}),
	assess_speaker_readiness: (a) =>
		assessSpeakerReadiness({
			talk_title: String(a.talk_title ?? ""),
			speaker_background: String(a.speaker_background ?? ""),
			prior_talks: a.prior_talks == null ? undefined : Number(a.prior_talks),
			has_dry_run: a.has_dry_run == null ? undefined : Boolean(a.has_dry_run),
			has_recording: a.has_recording == null ? undefined : Boolean(a.has_recording),
			writes_publicly: a.writes_publicly == null ? undefined : Boolean(a.writes_publicly),
		}),
};

/**
 * Carries the field list a caller needs to recover. The agent card publishes these schemas too
 * (the skill-schemas extension), but a caller that has already made the call is past reading it.
 */
export class InvalidArgumentsError extends Error {
	constructor(service: ServiceDefinition, cause: z.ZodError) {
		const fields = Object.entries(service.inputSchema).map(([name, schema]) => {
			const def = schema as z.ZodType;
			const optional = def.safeParse(undefined).success;
			return `  ${name}${optional ? " (optional)" : ""} — ${def.description ?? "no description"}`;
		});
		super(
			[
				`Invalid arguments for "${service.id}".`,
				"",
				...cause.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`),
				"",
				"Accepted arguments:",
				...fields,
			].join("\n"),
		);
		this.name = "InvalidArgumentsError";
	}
}

export class UnknownServiceError extends Error {
	constructor(id: string) {
		super(`Unknown service "${id}".`);
		this.name = "UnknownServiceError";
	}
}

/**
 * `env` carries the sibling service bindings. Optional so unit tests can dispatch local
 * services without a Worker environment; a bridged service without it fails loudly rather
 * than silently degrading.
 */
export interface DispatchContext {
	env: BridgeBindings & DealsEnv;
	/** Which transport asked. Only used for the Slack line, never for the answer. */
	transport: "a2a" | "mcp";
	/** Keeps the Slack post alive past the response. Without it the post may be cancelled. */
	waitUntil?: (p: Promise<unknown>) => void;
}

export async function dispatch(
	id: string,
	args: Record<string, unknown>,
	ctx?: DispatchContext,
): Promise<ServiceResult> {
	const service = SERVICES.find((s) => s.id === id);
	if (!service) throw new UnknownServiceError(id);

	// Validate BEFORE dispatching. The MCP binding validates through registerTool's zod
	// schema, but the A2A executor parses JSON and calls this directly — so until now the two
	// transports enforced different contracts and A2A enforced none. That single gap produced
	// most of the 2026-09-05 persona findings: assess_speaker_readiness graded an empty string
	// because `speaker_background` silently defaulted to "", which made has_recording,
	// writes_publicly and practitioner permanently false and left Tier 1 and Tier 3 structurally
	// unreachable. Eleven testers, and the one who brute-forced ~300 field names still never
	// found the parameter, because nothing ever told him it existed.
	//
	// .strict() is the other half: unknown keys are now an error naming the valid ones, rather
	// than being dropped in silence while the tool complains about what you did supply.
	// Bridged services are validated too, but WITHOUT .strict(): their real schema belongs to
	// the sibling, and this registry only mirrors it. Rejecting an unknown key here would
	// block an argument the owner legitimately accepts. Required fields and enums still get
	// caught, so the caller sees the nine valid reach ids before a network call is made rather
	// than a raw Zod dump afterwards.
	let unknownKeys: string[] = [];
	if (!service.withheld) {
		const shape = z.object(service.inputSchema);
		const parsed = (service.bridge ? shape.passthrough() : shape.strict()).safeParse(args);
		if (!parsed.success) throw new InvalidArgumentsError(service, parsed.error);
		// Passthrough keeps unknown keys rather than rejecting them, which is right for a
		// schema this registry only mirrors — but silence is not. An L&D buyer passed
		// `headcount: 12`, was never told it did nothing, and read the tool's hardcoded
		// "three leaders" as the answer to a question she believed she had asked. Say so.
		unknownKeys = Object.keys(args).filter((k) => !(k in service.inputSchema));
		args = parsed.data as Record<string, unknown>;
	}

	if (service.withheld) {
		// Deliberately a normal result, not an error: the caller asked a legitimate question
		// and the honest answer is "not yet, and here is exactly why".
		return {
			report: [
				`# ${service.title} — not available yet`,
				"",
				service.withheld,
				"",
				`When it opens it will be ${service.price.model === "free" ? "free" : service.price.model === "metered" ? "metered per call" : `quoted from €${service.price.fromEur}`}.`,
				"",
				"Nothing has been charged and nothing has been queued.",
			].join("\n"),
			source: `https://www.engineeringleaders.io${service.sourcePath}`,
			verdict: "Not available yet",
			data: { withheld: true, service: service.id },
		};
	}

	// Bridged services are answered by the sibling that owns them. Their output is returned
	// verbatim: reformatting another server's answer here is how two surfaces start
	// disagreeing about the same question.
	if (service.bridge) {
		if (!ctx?.env) {
			throw new Error(
				`Service "${id}" is bridged to ${service.bridge.endpoint} but dispatch was called without service bindings.`,
			);
		}
		let report: string;
		try {
			// Arguments this door adds on top of the sibling's schema. Forwarding one would be
			// rejected by the sibling's own validator, so they are stripped at the boundary.
			const LOCAL_ONLY = new Set(["budget_eur"]);
			const forwarded = Object.fromEntries(
				Object.entries(args).filter(([k]) => !LOCAL_ONLY.has(k)),
			);
			report = await callSibling(ctx.env, service.bridge.endpoint, service.bridge.tool, forwarded);
		} catch (err) {
			// Rewrite the sibling's internal tool name to the one the caller actually asked
			// for. Six of eleven testers were told "Invalid arguments for tool
			// quote_reach_combo" after calling buy_reach — a name absent from their tool list,
			// with nothing connecting the two.
			const raw = err instanceof Error ? err.message : String(err);
			throw new Error(rewriteSiblingNames(raw, service));
		}
		const ignored = unknownKeys.length
			? `\n\n---\n\n**Ignored: ${unknownKeys.map((k) => `\`${k}\``).join(", ")}.** ${unknownKeys.length === 1 ? "That argument is" : "Those arguments are"} not part of this service and had no effect on the answer above — do not read the result as a response to ${unknownKeys.length === 1 ? "it" : "them"}. Accepted arguments: ${Object.keys(service.inputSchema).join(", ")}.`
			: "";
		// buy_reach's sibling answers in JSON, which is right for an assistant composing a reply
		// and wrong for the buyer who reads it through this door. Render it, using only the
		// figures the sibling computed.
		let rewritten = rewriteSiblingNames(report, service);
		if (service.id === "buy_reach") {
			const { payload, rest } = splitQuote(rewritten);
			if (payload) {
				const budget = typeof args.budget_eur === "number" ? args.budget_eur : undefined;
				rewritten = [renderQuote(payload, budget), rest].filter(Boolean).join("\n\n");
			}
		}

		const bridged: ServiceResult = {
			report: rewritten + ignored + FREE_MEMBERSHIP_FOOTER,
			source: `https://www.engineeringleaders.io${service.sourcePath}`,
			// No `bridged_from`. Which internal server answered is this repo's plumbing and was
			// being rendered to buyers as part of their quote; renaming the key did not hide it,
			// because the whole data block is printed. It is recoverable from logs when needed.
			data: undefined,
		};
		announce(service, args, bridged, ctx);
		return bridged;
	}

	const handler = HANDLERS[id];
	if (!handler) {
		// A service is declared and not withheld, but has no implementation. That is a bug
		// in this repo, not a caller error — say so plainly rather than pretending.
		throw new Error(
			`Service "${id}" is advertised but has no handler. This is a server-side defect; it should be marked withheld until implemented.`,
		);
	}

	const result = await handler(args);
	const local: ServiceResult = { ...result, report: result.report + FREE_MEMBERSHIP_FOOTER };
	announce(service, args, local, ctx);
	return local;
}

/**
 * On every service, including the free ones.
 *
 * Two personas — an individual engineer and a new engineering manager, both exactly the people
 * ELC exists for — went through the whole surface and never learned membership is free for
 * them. The fact was in the product, buried inside a company terms block as an explanation of
 * why the room is good rather than as an offer. Three of six tools carried a `/join/` link and
 * none of them said the word "free".
 */
const FREE_MEMBERSHIP_FOOTER =
	"\n\n---\n\n_ELC membership is **free for engineering leaders** — 12 monthly meetups, the newsletter, the community Slack and every past talk. Join at https://www.engineeringleaders.io/join/. Companies fund it, which is what keeps it free for the room._";

/**
 * Fires the deal alert without making the caller wait for Slack, and without letting Slack
 * fail the request. Judgment and data services are skipped — this channel only carries
 * commercial intent.
 */
function announce(
	service: ServiceDefinition,
	args: Record<string, unknown>,
	result: ServiceResult,
	ctx?: DispatchContext,
): void {
	if (!ctx?.env || !isDealworthy(service)) return;
	const p = notifyDeal(ctx.env, { service, args, result, transport: ctx.transport });
	if (ctx.waitUntil) ctx.waitUntil(p);
}

/** Guards against advertising something we cannot answer. Asserted in the test suite. */
export function unimplementedLiveServices(): string[] {
	return SERVICES.filter((s) => !s.withheld && !s.bridge && !HANDLERS[s.id]).map((s) => s.id);
}

/** Exported for the regression test that asserts no advertised argument is silently dropped. */
export const HANDLERS_FOR_TEST = HANDLERS;
