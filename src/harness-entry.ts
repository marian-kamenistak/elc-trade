/**
 * Persona-test harness entry. Bundled and run by scripts/tool.mjs.
 *
 * Calls the SAME dispatch() the Worker calls — not a reimplementation, or the testers would be
 * exercising fiction. What differs from production, deliberately:
 *
 *   - Bridged skills reach the sibling servers over plain HTTPS instead of a service binding.
 *     Same servers, same answers; a laptop is not inside the zone, so the edge WAF that blocks
 *     a Worker's own-zone subrequest does not apply here.
 *   - No SLACK_BOT_TOKEN_ELC, so the deal notifier no-ops by design. Eleven personas pricing
 *     reach must not fire eleven fake "Quote requested" alerts into #web-a2a-bot.
 *   - Nothing in the live surface mutates anyway: no email, no CRM write, no charge. The one
 *     tool that submits (request_offer) lives on the partnership server and is not exposed here.
 */

// This file runs under Node (bundled by scripts/tool.mjs), not in the Worker, so the
// Workers ambient types do not cover `process`. Declared locally rather than pulling
// @types/node into a Worker project, which would make Node globals look available in
// src/ where they are not.
declare const process: { argv: string[]; exit(code: number): never };

import { dispatch } from "./core/dispatch";
import { LIVE_SERVICES, SERVICES } from "./core/services";

const ENDPOINTS = {
	TOOLKIT: "https://www.engineeringleaders.io/mcp",
	PARTNERSHIP: "https://www.engineeringleaders.io/mcp/partnership",
} as const;

/** Stands in for a Cloudflare service binding by doing an ordinary fetch. */
const svc = () => ({ fetch: (req: Request) => fetch(req) });

const env = {
	TOOLKIT: svc(),
	PARTNERSHIP: svc(),
	// SLACK_BOT_TOKEN_ELC deliberately absent — notifyDeal returns early without it.
	A2A_TRADE_SLACK_CHANNEL: "",
};

async function main() {
	const [tool, rawArgs] = process.argv.slice(2);

	if (!tool || tool === "list") {
		console.log("Available tools:\n");
		for (const s of LIVE_SERVICES) {
			console.log(`  ${s.id}`);
			console.log(`      ${s.description}\n`);
		}
		console.log("Usage: npx tsx scripts/tool.mjs <tool_name> '<json args>'");
		return;
	}

	let args: Record<string, unknown> = {};
	if (rawArgs) {
		try {
			args = JSON.parse(rawArgs) as Record<string, unknown>;
		} catch {
			console.error(`Could not parse arguments as JSON: ${rawArgs}`);
			process.exit(1);
		}
	}

	try {
		const result = await dispatch(tool, args, { env: env as never, transport: "mcp" });
		// Mirror what an MCP client actually receives: the report text is the content block,
		// and the structured fields follow. Testers must see the real envelope, including
		// the parts that are awkward.
		console.log(result.report);
		console.log("\n---");
		console.log(`source: ${result.source}`);
		if (result.verdict) console.log(`verdict: ${result.verdict}`);
		if (result.data) console.log(`data: ${JSON.stringify(result.data)}`);
	} catch (err) {
		const known = SERVICES.map((s) => s.id);
		console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
		if (!known.includes(tool)) console.error(`\nKnown tools: ${LIVE_SERVICES.map((s) => s.id).join(", ")}`);
		process.exit(1);
	}
}

void main();
