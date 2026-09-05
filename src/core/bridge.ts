/**
 * Server-side MCP client, so one A2A endpoint can answer for the whole domain.
 *
 * The agent card at /.well-known/agent-card.json is domain-level: one card for
 * engineeringleaders.io. If it only advertised elc-trade's own skills, the live and useful
 * ones on elc-toolkit and elc-partnership-builder would vanish from discovery. Advertising
 * them without being able to serve them is the exact conformance failure most published
 * cards make. So elc-trade dispatches them by calling the sibling servers.
 *
 * Verified against the live endpoints on 2026-09-04:
 *   - POST initialize returns 200 with an `mcp-session-id` response header
 *   - `notifications/initialized` is NOT required before tools/call
 *   - responses are SSE-framed even on POST ("event: message\ndata: {...}"), so the body
 *     must be parsed line-wise, not as plain JSON
 *
 * Two round trips per call. The session is cached per endpoint per isolate and re-created
 * once on failure, because a Durable Object eviction on the far side invalidates it and
 * that must not surface as an error to the caller.
 */

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT = { name: "elc-trade-bridge", version: "1.0.0" };

/** Sibling MCP endpoints. Absolute URLs: a Worker subrequest needs a real origin. */
export const ENDPOINTS = {
	toolkit: "https://www.engineeringleaders.io/mcp",
	partnership: "https://www.engineeringleaders.io/mcp/partnership",
} as const;

export type EndpointName = keyof typeof ENDPOINTS;

const sessions = new Map<string, string>();

/**
 * The two sibling Workers, bound as services. Typed structurally so this module does not
 * depend on the generated Env — the Worker entry hands them in.
 */
export interface BridgeBindings {
	TOOLKIT: { fetch: (req: Request) => Promise<Response> };
	PARTNERSHIP: { fetch: (req: Request) => Promise<Response> };
}

const BINDING: Record<EndpointName, keyof BridgeBindings> = {
	toolkit: "TOOLKIT",
	partnership: "PARTNERSHIP",
};

/** Pulls the JSON-RPC payload out of an SSE-framed body. */
function parseSse(body: string): Record<string, unknown> | null {
	for (const line of body.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		try {
			return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
		} catch {
			// keep scanning — a data: line may be a keep-alive or a partial frame
		}
	}
	// Some servers answer plain JSON when the client does not ask for SSE.
	try {
		return JSON.parse(body) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function post(
	svc: { fetch: (req: Request) => Promise<Response> },
	url: string,
	payload: unknown,
	sessionId?: string,
): Promise<Response> {
	return svc.fetch(new Request(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(sessionId ? { "mcp-session-id": sessionId } : {}),
		},
		body: JSON.stringify(payload),
	}));
}

async function openSession(
	svc: { fetch: (req: Request) => Promise<Response> },
	url: string,
): Promise<string> {
	const res = await post(svc, url, {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT },
	});
	const sid = res.headers.get("mcp-session-id");
	if (!res.ok || !sid) {
		throw new Error(`Bridge could not initialise ${url}: HTTP ${res.status}${sid ? "" : ", no mcp-session-id header"}`);
	}
	// Drain: the DO on the far side keeps the stream open until the body is consumed.
	await res.text();
	sessions.set(url, sid);
	return sid;
}

export class BridgeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BridgeError";
	}
}

/**
 * Calls a tool on a sibling MCP server and returns its text content.
 * Throws BridgeError rather than returning a plausible-looking empty answer — a bridged
 * skill that silently degrades would be worse than one that is honestly unavailable.
 */
export async function callSibling(
	env: BridgeBindings,
	endpoint: EndpointName,
	tool: string,
	args: Record<string, unknown>,
): Promise<string> {
	const url = ENDPOINTS[endpoint];
	const svc = env[BINDING[endpoint]];
	if (!svc?.fetch) {
		throw new BridgeError(`Service binding ${BINDING[endpoint]} is not configured — bridged skill "${tool}" cannot be answered.`);
	}

	const attempt = async (sid: string): Promise<string | "RETRY"> => {
		const res = await post(svc, url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }, sid);
		const body = await res.text();

		// An expired or unknown session is the one failure worth retrying once.
		if (res.status === 400 || res.status === 404) return "RETRY";
		if (!res.ok) throw new BridgeError(`${endpoint}/${tool} returned HTTP ${res.status}`);

		const rpc = parseSse(body);
		if (!rpc) throw new BridgeError(`${endpoint}/${tool} returned an unparseable body`);
		if (rpc.error) {
			const e = rpc.error as { code?: number; message?: string };
			// -32001/-32600 family from a stale session: retry once before giving up.
			if (e.code === -32600 || e.code === -32001) return "RETRY";
			throw new BridgeError(`${endpoint}/${tool}: ${e.message ?? "unknown error"}`);
		}

		// A tool-level failure comes back as a SUCCESSFUL JSON-RPC result carrying
		// isError: true — not as an rpc.error. Reading only the text meant a validation
		// failure on a sibling surfaced here as a completed task with an error string as its
		// answer, and over A2A that became TASK_STATE_COMPLETED. An autonomous caller
		// branching on task state recorded the failure as a win. Found by the A2A persona,
		// 2026-09-05, who called it the most dangerous thing in the surface.
		const result = rpc.result as
			| { content?: Array<{ type: string; text?: string }>; isError?: boolean }
			| undefined;

		if (result?.isError) {
			const detail = (result.content ?? [])
				.map((c) => c.text ?? "")
				.join("\n")
				.trim();
			throw new BridgeError(detail || `${endpoint}/${tool} reported an error with no detail`);
		}

		const text = (result?.content ?? [])
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string)
			.join("\n")
			.trim();

		if (!text) throw new BridgeError(`${endpoint}/${tool} returned no text content`);
		return text;
	};

	let sid = sessions.get(url) ?? (await openSession(svc, url));
	let out = await attempt(sid);
	if (out === "RETRY") {
		sessions.delete(url);
		sid = await openSession(svc, url);
		out = await attempt(sid);
		if (out === "RETRY") throw new BridgeError(`${endpoint}/${tool} rejected a freshly created session`);
	}
	return out;
}
