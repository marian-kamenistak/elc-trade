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
import { SERVICES } from "./services";
import type { ServiceDefinition, ServiceResult } from "./types";
import { evaluateMeetupTopic } from "./meetup-topic";
import { assessSpeakerReadiness } from "./speaker-readiness";
import { callSibling, type BridgeBindings } from "./bridge";
import { type DealsEnv, isDealworthy, notifyDeal } from "./deals";

type Handler = (args: Record<string, unknown>) => ServiceResult | Promise<ServiceResult>;

const HANDLERS: Record<string, Handler> = {
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
		}),
};

/**
 * Carries the field list a caller needs to recover, because the agent card publishes no
 * input schema and the only other way to learn an argument name is to guess it.
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
	if (!service.withheld) {
		const shape = z.object(service.inputSchema);
		const parsed = (service.bridge ? shape.passthrough() : shape.strict()).safeParse(args);
		if (!parsed.success) throw new InvalidArgumentsError(service, parsed.error);
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
			report = await callSibling(ctx.env, service.bridge.endpoint, service.bridge.tool, args);
		} catch (err) {
			// Rewrite the sibling's internal tool name to the one the caller actually asked
			// for. Six of eleven testers were told "Invalid arguments for tool
			// quote_reach_combo" after calling buy_reach — a name absent from their tool list,
			// with nothing connecting the two.
			const raw = err instanceof Error ? err.message : String(err);
			throw new Error(raw.replaceAll(service.bridge.tool, service.id));
		}
		const bridged: ServiceResult = {
			report,
			source: `https://www.engineeringleaders.io${service.sourcePath}`,
			data: { bridged_from: `${service.bridge.endpoint}/${service.bridge.tool}` },
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
	announce(service, args, result, ctx);
	return result;
}

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
