/**
 * #agent-deals-bot — the low-volume channel.
 *
 * Every tool call already goes to #web-mcp-usage-bot via the shared mcp-usage.ts. This is
 * deliberately NOT that: it fires only when an agent shows commercial intent, so any
 * message here means something happened. Mixing the two would bury a €4,000 booking under
 * a hundred scanner pings, which is exactly how the one message that matters gets missed.
 *
 * Honesty rule, and the reason `stage` exists: an agent asking for a quote is not a closed
 * deal. Slack says which one it is. Nothing here may imply money moved when it did not —
 * today nothing can close in-protocol at all, because every commercial service is
 * quote-to-invoice and the paid route ships disabled.
 */

import type { ServiceDefinition, ServiceResult } from "./types";

export interface DealsEnv {
	SLACK_BOT_TOKEN_ELC?: string;
	A2A_TRADE_SLACK_CHANNEL?: string;
}

/** What actually happened, in the order it can happen. */
export type DealStage =
	/** An agent priced something. Interest, not commitment. */
	| "quoted"
	/** An agent submitted something a human now owes an answer to. */
	| "requested"
	/** Money settled. Only reachable once the paid route is enabled. */
	| "paid";

const STAGE_LABEL: Record<DealStage, string> = {
	quoted: ":mag: Quote requested",
	requested: ":inbox_tray: Request submitted — a human owes an answer",
	paid: ":moneybag: Paid",
};

/** Only commercial services are worth a deal alert. Judgment and data tools are noise here. */
export function isDealworthy(service: ServiceDefinition): boolean {
	return service.kind === "access" || service.kind === "capacity";
}

export function stageFor(service: ServiceDefinition, result: ServiceResult): DealStage {
	if (result.data?.paid) return "paid";
	// A service a human must fulfil, that actually got submitted rather than just priced.
	if (result.pending || service.fulfilment !== "immediate") {
		return service.kind === "access" && result.pending === undefined ? "quoted" : "requested";
	}
	return "quoted";
}

/** Keys worth showing a human deciding whether to care. Everything else is noise. */
const INTERESTING = new Set([
	"company",
	"email",
	"goal",
	"oneoff_ids",
	"role_title",
	"location",
	"account",
	"subject",
	"who",
	"topic_slug",
	"event_date",
	"audience_size",
]);

function summarise(args: Record<string, unknown>): string {
	const lines = Object.entries(args)
		.filter(([k, v]) => INTERESTING.has(k) && v != null && v !== "")
		.map(([k, v]) => `• *${k}*: ${Array.isArray(v) ? v.join(", ") : String(v).slice(0, 200)}`);
	return lines.length ? lines.join("\n") : "_no details supplied_";
}

/**
 * Posts one message. Never throws into the request path: a Slack outage must not turn a
 * working answer into a failed one. Degrades silently when unconfigured, exactly like
 * mcp-usage.ts — the channel id ships empty until the channel exists.
 */
export async function notifyDeal(
	env: DealsEnv,
	input: {
		service: ServiceDefinition;
		args: Record<string, unknown>;
		result: ServiceResult;
		transport: "a2a" | "mcp";
	},
): Promise<void> {
	const token = env.SLACK_BOT_TOKEN_ELC;
	const channel = env.A2A_TRADE_SLACK_CHANNEL;
	if (!token || !channel) return;

	const { service, args, result, transport } = input;
	const stage = stageFor(service, result);

	const price =
		service.price.model === "quote"
			? `from €${service.price.fromEur}`
			: service.price.model === "metered"
				? `€${service.price.amountEur}/call`
				: "free";

	const text = [
		`${STAGE_LABEL[stage]} — *${service.title}*`,
		"",
		summarise(args),
		"",
		`_${service.id} · ${price} · via ${transport.toUpperCase()} · fulfilment: ${service.fulfilment}_`,
		stage !== "paid" ? "_No money has moved. Every commercial service here is quote-to-invoice._" : "",
	]
		.filter(Boolean)
		.join("\n");

	try {
		const res = await fetch("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ channel, text, unfurl_links: false }),
		});
		// Slack answers HTTP 200 on failure — res.ok lies, data.ok is the truth.
		const data = (await res.json()) as { ok?: boolean; error?: string };
		if (!data.ok && data.error === "not_in_channel") {
			// Public channels only; a private channel needs a manual /invite and this will
			// keep failing until someone does it. Deliberately not retried forever.
			await fetch("https://slack.com/api/conversations.join", {
				method: "POST",
				headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
				body: JSON.stringify({ channel }),
			});
			await fetch("https://slack.com/api/chat.postMessage", {
				method: "POST",
				headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
				body: JSON.stringify({ channel, text, unfurl_links: false }),
			});
		}
	} catch {
		// Swallowed on purpose. The caller already has their answer.
	}
}
