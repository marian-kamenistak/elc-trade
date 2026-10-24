/**
 * GET /mcp/trade/data/<slug>: the Monetization Gateway door for the two paid data products.
 *
 * Why this order, and why it is load-bearing:
 *   1. PAYMENT_GATEWAY_ENABLED !== "1"  → 404. The door does not exist until the switch is on.
 *   1b. host is not www.engineeringleaders.io → 308 to the same www URL (path + query), before any
 *      header or token is read. The gateway rule covers www only, and the apex is routed here too:
 *      without this, a buyer could replay a www token at the apex, where nothing charges.
 *   2. not GET, trailing slash, unknown slug → 405 / 404. One URL per product = one dashboard rule.
 *   3. withheld (G1, exactly withheldFor on the MCP door) → 404 with the withheld notice. Before any
 *      token is looked at, so a withheld product never returns data or a settlement, paid or not.
 *   4. the payment is verified, then the snapshot is read ONCE; every answer below uses that object.
 *      Verification failed → 402 with the free preview. Defence in depth for a request that
 *      bypassed the gateway rule; the gateway itself answers unpaid requests at the edge.
 *   5. rate limit by the verified payment id → 429 (only a verified token has an id worth keying).
 *   6. no snapshot → 200 "not computed yet" and settles 0: nothing is charged for data that does
 *      not exist. Otherwise → 200, the full signed answer, settles the price.
 *
 * PAYMENT-SETTLEMENT is set only on those two 200s, never on a status >= 400, and PAYMENT-RESPONSE
 * is never set: that header is the gateway's to write.
 */

import type { JWTVerifyGetKey } from "jose";
import { DATA_SLUG, DATA_URL, paidDataHandler, type CensusEnv } from "./core/data-services";
import { signDataResult, withheldFor, type PreviewEnv, type SigningEnv } from "./core/dispatch";
import { SERVICES } from "./core/services";
import { readLatest } from "./data/snapshot-store";
import { gatewayJwks, PRICE_ATOMIC, verifyGatewayPayment } from "./paid-gateway";
import type { PaidEnv } from "./paid";

export { DATA_URL };

export interface DataHttpEnv extends CensusEnv, SigningEnv, PreviewEnv {
	PAYMENT_GATEWAY_ENABLED?: string;
	PAID_RATE?: PaidEnv["PAID_RATE"];
}

const SERVICE_OF = { leader_composition: "get_leader_composition", meetup_benchmarks: "get_meetup_benchmarks" } as const;

const CANONICAL_HOST = "www.engineeringleaders.io";

const PATH = /^\/mcp\/trade\/data\/([a-z-]+)$/;

// no-store: a paid answer must never sit in an edge or browser cache for the next caller.
function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
	});
}

const settle = (atomic: bigint) => ({ "PAYMENT-SETTLEMENT": JSON.stringify({ amount: String(atomic) }) });

export async function handleDataRequest(request: Request, env: DataHttpEnv, deps: { jwks: JWTVerifyGetKey } = { jwks: gatewayJwks() }): Promise<Response> {
	if (env.PAYMENT_GATEWAY_ENABLED !== "1") return new Response("Not found.\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
	const url = new URL(request.url);
	if (url.hostname !== CANONICAL_HOST || url.port !== "") {
		const to = new URL(`${url.pathname}${url.search}`, `https://${CANONICAL_HOST}`);
		return new Response(null, { status: 308, headers: { location: to.href, "cache-control": "no-store" } });
	}
	if (request.method !== "GET") return json({ error: "Method not allowed. Use GET." }, 405, { allow: "GET" });

	// The aud is the canonical URL, never rebuilt from the request: a query string or a proxy rewrite
	// cannot change what the token must have been issued for.
	const slug = PATH.exec(url.pathname)?.[1];
	const method = slug && Object.prototype.hasOwnProperty.call(DATA_SLUG, slug) ? DATA_SLUG[slug as keyof typeof DATA_SLUG] : undefined;
	if (!method) return json({ error: "Not found.", products: Object.values(DATA_URL) }, 404);

	const service = SERVICES.find((s) => s.id === SERVICE_OF[method])!;
	const withheld = withheldFor(service, env);
	if (withheld) {
		return json(
			{
				report: `# ${service.title} — not available yet\n\n${withheld}\n\nNothing has been charged.`,
				source: `https://www.engineeringleaders.io${service.sourcePath}`,
				verdict: "Not available yet",
				data: { withheld: true, service: service.id },
			},
			404,
		);
	}

	const check = await verifyGatewayPayment(request, deps, { aud: DATA_URL[method], minAtomic: PRICE_ATOMIC[method] });
	const snapshot = env.SNAPSHOTS ? await readLatest(env.SNAPSHOTS, method) : null;

	if (!check.ok) {
		const preview = await paidDataHandler(service.id, env, { transport: "http", snapshot });
		return json({ reason: check.reason, how_to_pay: "x402 via Cloudflare Monetization Gateway", ...(await signDataResult(service, preview, env)) }, 402);
	}

	// Keyed by the token's jti (or hash): it caps how often one authorisation can be replayed, at
	// no cost. No binding fails closed, as on the MCP door.
	const key = `gateway:${check.paymentId}`;
	if (!env.PAID_RATE || !(await env.PAID_RATE.limit({ key })).success) {
		return json({ error: "Too many requests for this payment. Nothing has been charged; try again shortly." }, 429);
	}

	if (!snapshot) {
		const none = await paidDataHandler(service.id, env, { transport: "http", snapshot: null });
		return json(none, 200, settle(0n));
	}

	const result = await paidDataHandler(service.id, env, {
		transport: "http",
		amountUsd: service.price.model === "metered" ? service.price.amountUsd : 0.5,
		outcome: { kind: "paid", payer: check.paymentId, receiptId: check.paymentId, snapshot },
	});
	return json(await signDataResult(service, result, env), 200, settle(PRICE_ATOMIC[method]));
}
