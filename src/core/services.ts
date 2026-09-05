/**
 * The service registry — every tradable service declared exactly once.
 *
 * src/mcp.ts turns each entry into an MCP tool. src/a2a.ts turns each into an A2A
 * AgentSkill plus a task handler. scripts/gen-agent-card.mjs turns the same list into the
 * static /.well-known/agent-card.json on elc-web. Three surfaces, one declaration, no drift.
 *
 * Prices here are LIST prices, ex VAT, and every one traces to a source:
 *   - one-off reach: partnerships/offers/catalog.yaml `oneoffs` (verified 2026-09-04)
 *   - metered data:  proposed, UNSOURCED until Marian confirms — flagged inline
 * Nothing in this file may state a figure that is not in the ELC Data Points registry or
 * catalog.yaml. See CLAUDE.md.
 */

import { z } from "zod";
import type { ServiceDefinition } from "./types";

/**
 * The nine one-off reach items, ids verified against catalog.yaml on 2026-09-04.
 * Prices live in the catalog, NOT here — this is the allowlist of what an agent may put
 * in a cart, so a typo'd id fails loudly instead of quoting a price that does not exist.
 * `job-listing` is excluded from combo discounts by catalog policy.
 */
export const ONEOFF_IDS = [
	"newsletter-section",
	"newsletter-dedicated",
	"meetup-hosted",
	"podcast-episode",
	"dinner",
	"survey",
	"demo-session",
	"linkedin-post",
	"job-listing",
] as const;

/**
 * The ten speaking topics, ids and slugs verified against
 * mc-web/src/data/speaking.ts on 2026-09-04. Same discipline as ONEOFF_IDS: the tool
 * offers only what the /speaker page actually publishes, so it can never invent a talk.
 */
export const SPEAKING_TOPIC_SLUGS = [
	"portfolio-of-skills",
	"12-steps-market-value",
	"ai-manager-8am-coffee",
	"learn-or-die-growth-culture",
	"developer-to-unicorn-builder",
	"90-day-ai-team-playbook",
	"dora-wont-save-you",
	"tech-lead-never-let-go-keyboard",
	"is-your-coach-worth-it",
	"fix-your-1-1s",
] as const;

const email = z.string().email().describe("Contact email for the requesting organisation.");
const company = z.string().min(1).describe("The organisation on whose behalf the agent is acting.");

export const SERVICES: ServiceDefinition[] = [
	// ─── Tier 1: ready now ────────────────────────────────────────────────────
	{
		id: "buy_reach",
		title: "Buy reach in the ELC community",
		description:
			"Answers 'how do we get in front of 3,300+ CEE engineering leaders, and what does it cost?' Builds a cart from ELC's nine published one-off reach items — newsletter section, dedicated newsletter, hosted meetup, podcast episode, decision-maker dinner, community survey, demo session, LinkedIn post, job listing — applies the published combo discount, and returns a decision-ready quote a human can sign.",
		tags: ["reach", "partnership", "pricing", "marketing"],
		examples: [
			"We want to reach engineering leaders in Prague. What can we buy and what does it cost?",
			"Quote us a newsletter section plus a podcast episode.",
		],
		kind: "access",
		price: { model: "quote", fromEur: 500 },
		fulfilment: "human_review",
		site: "elc",
		sourcePath: "/partner/reach/",
		// Bridged, never reimplemented. quote_reach_combo recomputes prices server-side from
		// the generated offer-catalog.json that offers:sync writes from catalog.yaml, and
		// applies the combo-discount rules. A local quote here would be a second source of
		// prices — exactly what the offers checklist exists to prevent.
		bridge: { endpoint: "partnership", tool: "quote_reach_combo" },
		inputSchema: {
			oneoff_ids: z
				.array(z.enum(ONEOFF_IDS))
				.min(1)
				.describe("Which one-off reach items to quote. One or more of: newsletter-section, newsletter-dedicated, meetup-hosted, podcast-episode, dinner, survey, demo-session, linkedin-post, job-listing. Combo discount applies automatically."),
		},
	},

	// ─── Bridged from elc-toolkit (/mcp) ──────────────────────────────────────
	// Live, useful, and previously advertised by the hand-written agent card. The card is
	// domain-level, so dropping them when elc-trade took it over would have been a real
	// regression in discovery. Marian chose to bridge rather than narrow the card.
	{
		id: "benchmark_leadership_ratio",
		title: "Benchmark your manager-to-senior-IC ratio",
		description:
			"Answers 'is my engineering org top-heavy?' Compares a company's manager-versus-senior-IC split against the ELC community's own composition, computed from 3,300+ CEE engineering leaders, and returns each side's percentage, the delta and a verdict.",
		tags: ["benchmarks", "engineering-management", "org-design", "data"],
		examples: [
			"We have 10 managers and 30 senior engineers. Is that healthy?",
			"Is my engineering organisation top-heavy?",
		],
		kind: "data",
		price: { model: "free" },
		fulfilment: "immediate",
		site: "elc",
		sourcePath: "/toolkit/",
		bridge: { endpoint: "toolkit", tool: "benchmark_leadership_ratio" },
		inputSchema: {
			managers: z.number().int().min(0).describe("Managers and tech leads."),
			senior_ics: z.number().int().min(0).describe("Senior and staff ICs. Leave out junior and mid ICs on both sides."),
		},
	},
	{
		id: "assess_community_launch_readiness",
		title: "Should you start a meetup in your city?",
		description:
			"Answers 'should I start an engineering-leadership meetup here?' A five-question readiness check taken from ELC's own new-city launch playbook — the one actually used to open Brno, Bratislava and Kraków — returning a verdict plus the specific gaps still open.",
		tags: ["community", "meetup", "assessment", "launch"],
		examples: ["I want to start an engineering leaders meetup in Vienna. Am I ready?"],
		kind: "judgment",
		price: { model: "free" },
		fulfilment: "immediate",
		site: "elc",
		sourcePath: "/toolkit/",
		bridge: { endpoint: "toolkit", tool: "assess_community_launch_readiness" },
		inputSchema: {
			answers: z
				.record(z.string(), z.boolean())
				.optional()
				.describe("Answers to the five readiness questions. Omit to receive the questionnaire."),
		},
	},
	{
		id: "build_partnership_business_case",
		title: "Build the internal case for an ELC partnership",
		description:
			"Answers 'how do I justify a community partnership budget internally?' Returns real reach numbers, framing specific to the goal (hiring, brand, product feedback or thought leadership), the published price range, and a forwardable approval email.",
		tags: ["business-case", "partnership", "procurement", "budget"],
		examples: ["How do I convince my CFO to fund an ELC partnership for hiring?"],
		kind: "judgment",
		price: { model: "free" },
		fulfilment: "immediate",
		site: "elc",
		sourcePath: "/partner/",
		bridge: { endpoint: "toolkit", tool: "build_partnership_business_case" },
		inputSchema: {
			goal: z.string().describe("hiring, brand, product feedback, or thought leadership."),
			company_name: z.string().optional(),
			proposed_budget_eur: z.number().optional(),
		},
	},

	// ─── Tier 2: judgment services ────────────────────────────────────────────
	{
		id: "evaluate_meetup_topic",
		title: "Evaluate a meetup topic before you commit to it",
		description:
			"Answers 'will this topic fill a room?' Scores a proposed engineering-leadership meetup title and abstract against ELC's own topic-selection criteria — the ones behind 12 meetups a year at 120+ attendees since 2019 — and returns the specific failure modes, the title formulas that would fit, and the questions only the organiser can answer.",
		tags: ["meetup", "community", "assessment", "content"],
		examples: [
			"Is 'Microservices Best Practices' a good meetup topic for engineering leaders?",
			"Score this abstract for a CTO audience and tell me what's wrong with the title.",
		],
		kind: "judgment",
		price: { model: "free" },
		fulfilment: "immediate",
		site: "elc",
		sourcePath: "/toolkit/",
		inputSchema: {
			title: z.string().min(3).describe("The proposed meetup or talk title."),
			abstract: z.string().optional().describe("The abstract, if one exists yet."),
			audience: z
				.string()
				.optional()
				.describe("Who it is aimed at, e.g. 'CTOs and VPs', 'first-time engineering managers'."),
		},
	},
	{
		id: "assess_speaker_readiness",
		title: "Assess whether a speaker is ready for the stage",
		description:
			"Answers 'is this person ready to speak, and what will go wrong if they are not?' Checks a proposed speaker and talk against ELC's speaker vetting process — seven years of putting people in front of 120+ engineering leaders — and returns a readiness verdict with the specific gaps to close before the event.",
		tags: ["speakers", "community", "assessment", "events"],
		examples: [
			"Our staff engineer wants to give her first conference talk. Is she ready?",
			"What's missing before this speaker goes on stage?",
		],
		kind: "judgment",
		price: { model: "free" },
		fulfilment: "immediate",
		site: "elc",
		sourcePath: "/toolkit/",
		inputSchema: {
			talk_title: z.string().min(3).describe("The proposed talk title."),
			speaker_background: z
				.string()
				.describe("Role, seniority, and any prior speaking experience."),
			prior_talks: z.number().int().min(0).optional().describe("How many talks they have given."),
			has_dry_run: z.boolean().optional().describe("Whether a rehearsal is scheduled."),
		},
	},

	// ─── Tier 3: needs data work ──────────────────────────────────────────────
	{
		id: "get_cee_leadership_market",
		title: "Query the CEE engineering-leadership market",
		description:
			"Answers 'what does the engineering-leadership market in Central Europe actually look like?' Returns the seniority and title distribution across ELC's 3,300+ members in Prague, Brno, Bratislava and Kraków — first-party data from a community running since 2019, not a survey panel or a scrape.",
		tags: ["data", "market", "benchmarks", "cee", "hiring"],
		examples: [
			"How many engineering directors are there in the Czech tech market?",
			"What's the seniority split of engineering leaders in Central Europe?",
		],
		kind: "data",
		// PROPOSED, UNSOURCED. The paid route. Must not go live until Marian sets the
		// price and it exists as an ELC Data Points row.
		price: { model: "metered", amountEur: 0.25 },
		fulfilment: "immediate",
		site: "elc",
		sourcePath: "/toolkit/",
		inputSchema: {
			segment: z
				.enum(["seniority", "titles", "cities", "all"])
				.default("all")
				.describe("Which cut of the member base to return."),
		},
		// Approved for build by Marian 2026-09-04. Stays withheld until the aggregation
		// actually exists — approving the build is not the same as having the data.
		withheld:
			"In build: the live Attio aggregation job is being written. Until it lands, the only figures available are one hand-computed snapshot in which 60% of member profiles carry no title, so every number is a floor rather than a share — not something to sell. The metered price is also still unset; €0.25 in this file is a placeholder, not a decision.",
	},
	{
		id: "cite_benchmark",
		title: "Cite an ELC benchmark with a verifiable reference",
		description:
			"Answers 'where did that number come from?' Returns an ELC engineering-leadership benchmark together with a citation id, the method behind it, and the date it was last verified — so an agent can put the figure in its own output and stand behind the provenance.",
		tags: ["data", "benchmarks", "citation", "provenance"],
		examples: [
			"What's the healthy manager-to-senior-IC ratio, and can I cite it?",
			"Give me a citable source for CEE engineering leadership benchmarks.",
		],
		kind: "data",
		price: { model: "free" },
		fulfilment: "immediate",
		site: "elc",
		sourcePath: "/toolkit/",
		inputSchema: {
			topic: z.string().describe("Which benchmark, e.g. 'leadership ratio', 'meetup attendance'."),
		},
		withheld:
			"Not live yet: the benchmark numbers are hardcoded TypeScript constants in elc-toolkit rather than read from the ELC Data Points registry at runtime. A citation is only worth issuing once it resolves to the registry row it claims.",
	},

	// ─── Tier 4: blocked on a decision ────────────────────────────────────────
	{
		id: "post_job",
		title: "Post a role to the ELC community",
		description:
			"Answers 'how do we get this role in front of engineering leaders in Central Europe?' Submits a role to the ELC job board plus a newsletter mention, in front of 3,300+ members.",
		tags: ["hiring", "jobs", "reach", "talent"],
		examples: ["We're hiring a VP of Engineering in Prague. Can we post it to your community?"],
		kind: "access",
		// catalog.yaml oneoffs: job-listing 500 EUR, "Live in 2 days".
		price: { model: "quote", fromEur: 500 },
		fulfilment: "human_review",
		site: "elc",
		sourcePath: "/partner/reach/",
		inputSchema: {
			role_title: z.string().min(2),
			company,
			location: z.string().describe("City, or 'remote'."),
			jd_url: z.string().url().optional(),
			email,
		},
		// Approved for build by Marian 2026-09-04: job board + a newsletter slot for the role.
		withheld:
			"In build: the job board does not exist yet — job.engineeringleaders.io returns 404 and there is no listing storage anywhere in the estate. Accepting a paid listing before there is somewhere to list it would take money for a page that does not load.",
	},
	{
		id: "request_intro",
		title: "Request a brokered introduction to an ELC member",
		description:
			"Answers 'can you introduce us to the right engineering leader?' Describes who you want to reach and why; ELC contacts matching members on your behalf. No member list is ever returned, and an introduction happens only if the member says yes.",
		tags: ["introductions", "network", "community"],
		examples: ["We'd like to talk to CTOs of Series-B companies in Prague about our product."],
		kind: "access",
		price: { model: "quote", fromEur: 500 },
		// Not merely human_review: nothing happens at all without a third party's consent.
		fulfilment: "consent_required",
		site: "elc",
		sourcePath: "/partner/reach/",
		inputSchema: {
			who: z.string().min(10).describe("The kind of person you want to reach, and why."),
			company,
			email,
		},
		// Approved by Marian 2026-09-04 and the public copy change is shipped:
		// reach.ts's not_for_sale now reads "Introductions without the member's consent",
		// so the published position and this service agree. The catalog's attendee-lists
		// entry needed no edit — it is about not selling the list, which is still true.
		withheld:
			"In build: the brokering flow itself — match against Attio, contact the member, record consent, introduce only on a yes — is not written yet. Advertising it before the consent step exists would be selling a promise with no mechanism behind it.",
	},
	{
		id: "post_li_post",
		title: "Commission a LinkedIn post",
		description:
			"Answers 'can you post about this to your audience?' Drafts a LinkedIn post for the ELC company profile or Marian's personal profile, subject to topic, language and disclosure rules, and queues it for human approval. Nothing is ever published by this tool.",
		tags: ["linkedin", "reach", "content", "marketing"],
		examples: ["Could you post about our engineering blog to your LinkedIn audience?"],
		kind: "access",
		// catalog.yaml oneoffs: linkedin-post 500 EUR, "1 week" lead time.
		price: { model: "quote", fromEur: 500 },
		fulfilment: "human_review",
		site: "elc",
		sourcePath: "/partner/reach/",
		inputSchema: {
			account: z.enum(["elc", "marian"]).describe("Which profile the post should go out from."),
			subject: z.string().min(10).describe("What the post should be about."),
			link: z.string().url().optional(),
			company,
			email,
		},
		withheld:
			"Kill switch LI_POST_ENABLED ships at '0'. A published post cannot be unpublished and reaches roughly 25k connections, so this stays off until the guardrails in strategy/08-a2a-agent-trading.md are implemented and tested: hard topic exclusions, language rules, unsourced-number rejection, rate caps, disclosure line, R2 audit log, and a human publish gate that no agent can bypass.",
	},
];

/** Everything an agent may actually see. `withheld` services are declared but not advertised. */
export const LIVE_SERVICES = SERVICES.filter((s) => !s.withheld);
