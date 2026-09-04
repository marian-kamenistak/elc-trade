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
		const report = await callSibling(ctx.env, service.bridge.endpoint, service.bridge.tool, args);
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
