/**
 * elc-trade — one service core, two transports.
 *
 *   engineeringleaders.io/mcp/trade   MCP, where the buyers actually are
 *   engineeringleaders.io/a2a/v1      A2A v1.0 JSON-RPC, the conformant endpoint
 *
 * Both call src/core/dispatch.ts and nothing else, so the same question cannot get two
 * different answers depending on how it arrived.
 *
 * The agent card is deliberately NOT served here. elc-web's assets binding shadows
 * /.well-known/*, so the card lives as a static file in elc-web/public/.well-known/,
 * generated at build time from the same registry by scripts/gen-agent-card.mjs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { getMoreToolsResult } from "@posthog/mcp";
import { z } from "zod";
import {
	AGENT_CARD_PATH,
	A2A_PROTOCOL_VERSION,
	SSE_HEADERS,
	formatSSEEvent,
} from "@a2a-js/sdk";
import {
	DefaultRequestHandler,
	InMemoryTaskStore,
	JsonRpcTransportHandler,
	ServerCallContext,
	UnauthenticatedUser,
} from "@a2a-js/sdk/server";
import { A2A_PATH, ElcTradeExecutor, ORIGIN, buildAgentCard } from "./a2a";
import { dispatch } from "./core/dispatch";
import type { DispatchContext } from "./core/dispatch";
import { LIVE_SERVICES } from "./core/services";
import {
	geoFromRequest,
	instrumentMcpUsage,
	type McpGeo,
	type McpUsageConfig,
	type McpUsageEnv,
} from "./mcp-usage";

/**
 * Every live service is a read-only lookup or calculation over first-party ELC data:
 * nothing mutates, nothing calls a third party, same input -> same output. The services
 * that WOULD mutate something (post_job, request_intro, post_li_post) are withheld, which
 * is why this annotation holds for the whole advertised surface today. Revisit when the
 * first mutating service ships.
 */
const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const REPORT_OUTPUT = {
	report: z.string().describe("The full human-readable report."),
	source: z.string().describe("Canonical engineeringleaders.io page this answer derives from."),
	verdict: z.string().optional().describe("Headline verdict, when the tool returns one."),
};

const USAGE_CONFIG: McpUsageConfig = {
	serverName: "elc-trade",
	domain: "engineeringleaders.io",
	posthogKey: "phc_waN4oTJtyBpZyMFNDNkk54QmmqmePyRDghKGcTkPfWPY",
};

/** Same greeting guard as the sibling servers: a bare "hi" gets the menu, not a dead end. */
const GREETING_PING =
	/^(hi+|hello+|hey+|yo+|sup|howdy|hola|ahoy|ping|test(ing)?|are you (there|working|alive)|is (this|anyone) (working|there)|still there|you there|greetings|what('?s| is) up)[.!?\s]*$/i;

function menuText(): string {
	return [
		"These are the Engineering Leaders Community's agent-callable services. Route the caller's actual question to one of these:",
		"",
		...LIVE_SERVICES.map((s) => `- \`${s.id}\`: ${s.description}`),
		"",
		"If none fit, ask what they are trying to figure out and pick the closest match.",
	].join("\n");
}

function asToolResult(r: Awaited<ReturnType<typeof dispatch>>) {
	return {
		content: [{ type: "text" as const, text: r.report }],
		structuredContent: { report: r.report, source: r.source, ...(r.verdict ? { verdict: r.verdict } : {}) },
	};
}

export class ElcTrade extends McpAgent<Env, unknown, McpGeo> {
	server = new McpServer({ name: "elc-trade", version: "1.0.0" });

	async init() {
		instrumentMcpUsage({
			server: this.server,
			config: USAGE_CONFIG,
			env: this.env as McpUsageEnv,
			geo: this.props ?? {},
			waitUntil: (p) => this.ctx.waitUntil(p),
		});

		this.server.registerTool(
			"get_started",
			{
				title: "Start here — what can this server do?",
				annotations: { ...READ_ONLY },
				outputSchema: REPORT_OUTPUT,
				description:
					"Call this for a greeting (hi, hello), a connectivity or liveness test, 'what can you do', or any message too general to match a specific tool. Returns the full menu of services, each mapped to the tool that answers it.",
				inputSchema: {},
			},
			async () => ({
				content: [{ type: "text" as const, text: menuText() }],
				structuredContent: { report: menuText(), source: `${ORIGIN}/agents/` },
			}),
		);

		this.server.registerTool(
			"get_more_tools",
			{
				title: "More tools? Check here first — also answers a plain hello",
				annotations: { ...READ_ONLY },
				description:
					"Check for additional specialised capabilities whenever your task might benefit from them. Also the right tool for a bare greeting or a liveness test — pass it as `context` and this returns the menu instead of a dead end.",
				inputSchema: { context: z.string().describe("What you are trying to do.") },
			},
			// getMoreToolsResult() takes no arguments and its result is unwrapped to .content —
			// same call shape as elc-toolkit. Passing `context` or returning the whole object
			// both fail to type-check against @posthog/mcp@0.11.7.
			async ({ context }) =>
				GREETING_PING.test(context.trim())
					? { content: [{ type: "text" as const, text: menuText() }] }
					: { content: getMoreToolsResult().content },
		);

		// One tool per live service, straight off the registry. A service that is withheld
		// is never registered, so it cannot be called by an agent that read the tool list.
		for (const service of LIVE_SERVICES) {
			this.server.registerTool(
				service.id,
				{
					title: service.title,
					annotations: { ...READ_ONLY },
					outputSchema: REPORT_OUTPUT,
					description: service.description,
					inputSchema: service.inputSchema,
				},
				async (args: Record<string, unknown>) =>
						asToolResult(
							await dispatch(service.id, args, {
								env: this.env as unknown as DispatchContext["env"],
								transport: "mcp",
								waitUntil: (p) => this.ctx.waitUntil(p),
							}),
						),
			);
		}
	}
}

// ─── A2A plumbing ───────────────────────────────────────────────────────────
// Built per request, not per isolate, because the executor needs the service bindings for
// bridged skills. The cost is negligible: the card is a pure function of the registry.
//
// InMemoryTaskStore is therefore per request too, which is fine only because every service
// answers synchronously before the response is written. The moment a long-running service
// lands — a brokered intro waiting on a member's reply — this must move to a Durable
// Object-backed TaskStore, or the task will not exist when the caller polls for it.
function a2aTransportFor(env: Env, ctx: ExecutionContext) {
	return new JsonRpcTransportHandler(
		new DefaultRequestHandler(
			buildAgentCard(),
			new InMemoryTaskStore(),
			new ElcTradeExecutor({
				env: env as unknown as DispatchContext["env"],
				transport: "a2a",
				waitUntil: (p) => ctx.waitUntil(p),
			}),
		),
	);
}

const isAsyncIterable = (v: unknown): v is AsyncIterable<unknown> =>
	v != null && typeof (v as Record<symbol, unknown>)[Symbol.asyncIterator] === "function";

function a2aDocsHtml(): string {
	const skills = LIVE_SERVICES.map(
		(s) => `<li><code>${s.id}</code> — ${s.description}</li>`,
	).join("\n");
	return `<!doctype html><meta charset="utf-8"><title>ELC — A2A endpoint</title>
<style>body{font:16px/1.6 system-ui;max-width:44rem;margin:3rem auto;padding:0 1.25rem;color:#111}
code{background:#f4f4f5;padding:.1em .35em;border-radius:4px}pre{background:#f4f4f5;padding:1rem;border-radius:8px;overflow-x:auto}</style>
<h1>Engineering Leaders Community — A2A</h1>
<p>A conformant <strong>A2A v${A2A_PROTOCOL_VERSION}</strong> endpoint. Agent card:
<a href="${ORIGIN}/${AGENT_CARD_PATH}">/${AGENT_CARD_PATH}</a></p>
<pre>POST ${ORIGIN}${A2A_PATH}
{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{
  "message":{"messageId":"1","role":"ROLE_USER",
    "parts":[{"text":"{\\"skill\\":\\"evaluate_meetup_topic\\",\\"args\\":{\\"title\\":\\"Your title\\"}}"}]},
  "configuration":{"blocking":true}}}</pre>
<h2>Skills</h2><ul>${skills}</ul>
<p>Prefer MCP? Same services, same answers: <code>${ORIGIN}/mcp/trade</code></p>`;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/$/, "") || "/";

		// ── A2A ────────────────────────────────────────────────────────────────
		if (path === A2A_PATH && request.method === "POST") {
			// v1.x requires a ServerCallContext; validateVersion throws for any version not
			// declared on the card, so the header is echoed rather than defaulted silently.
			const context = new ServerCallContext({
				user: new UnauthenticatedUser(),
				requestedVersion: request.headers.get("A2A-Version") ?? A2A_PROTOCOL_VERSION,
			});
			const result = await a2aTransportFor(env, ctx).handle(await request.text(), context);

			if (isAsyncIterable(result)) {
				const { readable, writable } = new TransformStream();
				const writer = writable.getWriter();
				const enc = new TextEncoder();
				// Deliberately not awaited: awaiting would buffer the whole stream and defeat SSE.
				ctx.waitUntil(
					(async () => {
						try {
							for await (const ev of result) await writer.write(enc.encode(formatSSEEvent(ev)));
						} finally {
							await writer.close();
						}
					})(),
				);
				return new Response(readable, { headers: SSE_HEADERS });
			}
			return Response.json(result);
		}

		if (path === "/a2a" || path === A2A_PATH) {
			const html = a2aDocsHtml();
			return new Response(request.method === "HEAD" ? null : html, {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"content-length": String(new TextEncoder().encode(html).length),
				},
			});
		}

		// ── MCP ────────────────────────────────────────────────────────────────
		if (path === "/mcp/trade") {
			const accept = request.headers.get("accept") ?? "";
			// Same rule as the sibling servers: HTML to every GET/HEAD that is not explicitly
			// an SSE ask, so curl, Googlebot and GPTBot get a page instead of a 406.
			if ((request.method === "GET" || request.method === "HEAD") && !accept.includes("text/event-stream")) {
				const html = a2aDocsHtml();
				return new Response(request.method === "HEAD" ? null : html, {
					headers: {
						"content-type": "text/html; charset=utf-8",
						"content-length": String(new TextEncoder().encode(html).length),
					},
				});
			}
			// request.cf only exists on the edge request; hand geo to the DO via ctx.props.
			(ctx as ExecutionContext & { props?: McpGeo }).props = geoFromRequest(request);
			return ElcTrade.serve("/mcp/trade").fetch(request, env, ctx);
		}

		return new Response(
			`Not found.\nMCP:  ${ORIGIN}/mcp/trade\nA2A:  ${ORIGIN}${A2A_PATH}\nCard: ${ORIGIN}/${AGENT_CARD_PATH}\n`,
			{ status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
		);
	},
};
