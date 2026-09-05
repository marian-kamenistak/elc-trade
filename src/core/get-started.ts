/**
 * The router. Deterministic keyword matching, deliberately.
 *
 * This is the one place where a keyword matcher is the right tool: routing is cheap to get
 * wrong. A miss falls through to the full menu, which is a good answer on its own. That is the
 * opposite of `assess_speaker_readiness`, where a keyword miss produced a confident wrong
 * verdict — which is why those two judgment tools are withheld and this one is not.
 *
 * Written after a persona test where a newly promoted engineering manager read a six-item
 * seller's menu, found nothing describing himself, and quit before calling anything. The most
 * valuable thing this server can tell most humans who reach it is that ELC is free for them,
 * and until now that fact lived inside a tool called `build_partnership_business_case`.
 */

import type { ServiceResult } from "./types";

const ORIGIN = "https://www.engineeringleaders.io";

/** A bare liveness or greeting ping, as opposed to a described need. */
const GREETING =
	/^(hi+|hello+|hey+|yo+|sup|howdy|hola|ahoy|ping|test(ing)?|are you (there|working|alive)|is (this|anyone) (working|there)|still there|you there|greetings|what('?s| is) up|what can you do\??|help)[.!?\s]*$/i;

/**
 * Intent → the tool that answers it. Order matters: the first match wins, so the most specific
 * intents come first. Czech and Slovak included — Prague, Brno and Bratislava are core cities
 * and an English-only router would send local callers to the generic menu.
 */
const ROUTES: { re: RegExp; tool: string; why: string }[] = [
	{
		re: /\b(mentor|mentoring|coach for me|career advice|should i (go into|become a) manage|mentora|kouč)\b/i,
		tool: "get_started",
		why: "You are asking for help for yourself. ELC membership is free for engineering leaders — join at "
			+ `${ORIGIN}/join/. For one-to-one mentoring you pay for yourself, that is a separate service at https://marian.coach/.`,
	},
	{
		re: /\b(reach|advertise|advertis|sponsor|newsletter|podcast|promote|campaign|get in front of|inzer|propagac)\b/i,
		tool: "buy_reach",
		why: "You want to put something in front of the community. `buy_reach` prices the nine published one-off items and takes an optional budget.",
	},
	{
		re: /\b(budget|justify|business case|approval|cfo|procurement|internal case|rozpočet|schválen)\b/i,
		tool: "build_partnership_business_case",
		why: "You need to justify a spend internally. `build_partnership_business_case` writes the case and a forwardable email — set `buying_for` to `individual` if you are a person rather than a company.",
	},
	{
		re: /\b(top-?heavy|ratio|how many managers|org (shape|design|structure)|span of control)\b/i,
		tool: "benchmark_leadership_ratio",
		why: "You are asking about the shape of an org. `benchmark_leadership_ratio` reports your split and the question it raises.",
	},
	{
		re: /\b(start a (meetup|community|chapter)|launch a meetup|new city|založit meetup)\b/i,
		tool: "assess_community_launch_readiness",
		why: "You are considering running a meetup somewhere new. `assess_community_launch_readiness` is ELC's own five-question check, and it will tell you not to launch if that is the answer.",
	},
	{
		re: /\b(hiring|recruit|open roles?|candidates?|nábor|hledáme)\b/i,
		tool: "build_partnership_business_case",
		why: "Hiring is a goal `build_partnership_business_case` covers — call it with `goal: \"hiring\"`.",
	},
	{
		re: /\b(struggling|first-time manager|new manager|grow my team|develop my (team|leaders|managers)|retention|leaving|churn|no growth)\b/i,
		tool: "get_started",
		why: "That is a people-development question. If you are asking for your own team and your employer might fund it, call `build_partnership_business_case` with `goal: \"people_development\"`. If you are asking for yourself, ELC membership is free — see below.",
	},
];

const FREE_LINE =
	`**If you are an engineering leader, ELC membership is free.** 12 monthly meetups across Prague, Brno, Bratislava and Kraków, the Leaders' Brief newsletter, the community Slack, the knowledge base and every past talk. Join at ${ORIGIN}/join/ — no company, no invoice, no approval from anyone. Companies fund it, which is what keeps it free for the room.`;

export function getStarted(
	input: { context?: string },
	liveServices: { id: string; description: string }[],
): ServiceResult {
	const raw = (input.context ?? "").trim();
	const menu = liveServices.map((s) => `- \`${s.id}\` — ${s.description}`).join("\n");

	const matched = raw && !GREETING.test(raw) ? ROUTES.find((r) => r.re.test(raw)) : undefined;

	const head = !raw
		? "# Engineering Leaders Community — agent-callable services"
		: GREETING.test(raw)
			? "# Hello — here is what this server does"
			: "# Here is where your question goes";

	const routed = matched
		? [`**${matched.why}**`, ""]
		: raw && !GREETING.test(raw)
			? [
					"Nothing here matches that exactly, so here is everything. Pick the closest, or ask the caller what outcome they are after.",
					"",
				]
			: [];

	return {
		report: [
			head,
			"",
			"ELC is a community of 3,300+ engineering leaders across Prague, Brno, Bratislava and Kraków, running since 2019.",
			"",
			...routed,
			"## What you can call",
			"",
			menu,
			"",
			"## If you are a person, not a company",
			"",
			FREE_LINE,
			"",
			"## What is never for sale",
			"",
			"Pitching from an ELC stage, member contact data for outbound, and brokered introductions. Not at any price. The room stays senior because it does not get sold to.",
		].join("\n"),
		source: `${ORIGIN}/agents/`,
	};
}
