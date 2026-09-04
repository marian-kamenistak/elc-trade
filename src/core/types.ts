/**
 * One service registry, two transports.
 *
 * Every tradable ELC service is declared here once. The MCP binding (src/mcp.ts) turns
 * each entry into a tool; the A2A binding (src/a2a.ts) turns each into an AgentSkill and
 * a task handler; scripts/gen-agent-card.mjs turns the same list into the static
 * /.well-known/agent-card.json on elc-web. Adding a service in one place is the only way
 * to add it — the three surfaces cannot drift.
 *
 * This mirrors how elc-partnership-builder keeps catalog.yaml as the single source and
 * generates four files from it.
 */

import type { z } from "zod";

/** What the buyer is actually paying for. Drives pricing, gating and Slack wording. */
export type ServiceKind =
	/** Reads first-party ELC data. Cheap, per-call, agent pays with no human involved. */
	| "data"
	/** Applies ELC's own judgment (topic guide, speaker playbook). Free — it is the hook. */
	| "judgment"
	/** Buys attention: reach, a listing, a post. Human fulfils, so a human also closes. */
	| "access"
	/** Books scarce human time. Human confirms. */
	| "capacity";

export type PriceModel =
	/** Free. Most of the surface — free tools are the discovery channel, not a loss. */
	| { model: "free" }
	/**
	 * Metered per call over x402/MPP. `amountEur` is the list price ex VAT.
	 * Only ever applied to `kind: "data"` — see strategy/08-a2a-agent-trading.md for why
	 * the €50+ bands have no working rail in the EU.
	 */
	| { model: "metered"; amountEur: number }
	/**
	 * Quote-to-invoice. The agent assembles a decision-ready cart; a human signs.
	 * `fromEur` is the entry price, for the card and the catalog page.
	 */
	| { model: "quote"; fromEur: number };

/**
 * Fulfilment tells the caller — and the Slack notification — whether anything actually
 * happened. An agent must never be told a job is posted when a human still has to post it.
 */
export type Fulfilment =
	/** Answer is computed and returned in the response. Nothing queued, nothing pending. */
	| "immediate"
	/** Queued for a human. The response says so explicitly and gives an expected lead time. */
	| "human_review"
	/** Queued for a human AND requires the counterparty's consent before anything happens. */
	| "consent_required";

export interface ServiceDefinition<TInput extends z.ZodRawShape = z.ZodRawShape> {
	/** Stable id. Used as the MCP tool name AND the A2A skill id — they must be the same. */
	id: string;
	/** Human title, shown in the MCP tool list and the A2A card. */
	title: string;
	/**
	 * One sentence, written for a model deciding whether to call this. Leads with the
	 * question it answers, not with what it is. Same discipline as elc-toolkit's tools.
	 */
	description: string;
	/** A2A card tags. Also used to group the /agents/ page. */
	tags: string[];
	/** Example utterances that should route here. Goes into the A2A card's `examples`. */
	examples: string[];
	kind: ServiceKind;
	price: PriceModel;
	fulfilment: Fulfilment;
	/** Zod raw shape. MCP uses it directly; A2A validates the parsed message payload with it. */
	inputSchema: TInput;
	/**
	 * Which site owns it. Determines the Worker, the attribution URL and which LinkedIn
	 * account `post_li_post` targets.
	 */
	site: "elc" | "mc";
	/** Canonical page this answer derives from, for the attribution footer. */
	sourcePath: string;
	/**
	 * Answered by a sibling MCP server rather than implemented here. Set this instead of
	 * copying logic across repos: elc-toolkit and elc-partnership-builder own their own
	 * domains, and duplicating them would fork the answers (and, for anything priced, fork
	 * the prices away from catalog.yaml).
	 *
	 * The card is domain-level, so a bridged service is advertised exactly like a local one
	 * — the caller cannot tell, and should not need to.
	 */
	bridge?: { endpoint: "toolkit" | "partnership"; tool: string };

	/**
	 * Set when the service is declared but must not be advertised yet — it is omitted from
	 * the agent card, the MCP tool list and the catalog page, and calling it returns a
	 * refusal. Used for services blocked on a human decision (see `request_intro`) or on a
	 * kill switch (`post_li_post`). The string is the reason, and it is shown to the caller.
	 */
	withheld?: string;
}

/** Every service returns this shape, over both transports, so the two never diverge. */
export interface ServiceResult {
	/** Full human-readable answer. The A2A text part and the MCP text content. */
	report: string;
	/** Canonical URL this derives from. */
	source: string;
	/** Headline verdict, when there is one. */
	verdict?: string;
	/**
	 * True when a human now owes the caller an action. Drives the Slack "deal" line and
	 * makes the response honest about what has and has not happened.
	 */
	pending?: boolean;
	/** Machine-readable payload, when the service has one beyond the report. */
	data?: Record<string, unknown>;
}
