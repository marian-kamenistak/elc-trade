/**
 * The second paid rail: Cloudflare Monetization Gateway (x402 charged at the edge, per URL).
 *
 * Why plain HTTPS GET and not MCP: the gateway prices by URL and only Enterprise rules can read
 * a body, so a JSON-RPC tool call cannot be priced per product. The gateway charges, then forwards
 * a signed `PAYMENT-CONTEXT` JWT; this file is the origin's half of that contract.
 *
 * Why verify-then-read and nothing else: the token is only ever handed to jose's jwtVerify, which
 * checks the Ed25519 signature against Cloudflare's pinned JWKS before any claim is looked at.
 * No decodeJwt, no peeking at the header. A missing header means unpaid, never "trust me".
 *
 * Closed beta and US-only on 2026-10-24; built ahead so going live is a dashboard rule plus
 * PAYMENT_GATEWAY_ENABLED="1". See MONETIZATION-GATEWAY.md.
 */

import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { sha256Hex } from "./trust/jcs";

export const GATEWAY_JWKS_URL = "https://payments.cloudflare.com/certs";

/** Atomic unit = $0.000001, so 500000 = $0.50, the card floor both rails share. */
export const PRICE_ATOMIC = { leader_composition: 500000n, meetup_benchmarks: 500000n } as const;

/**
 * `paymentId` is an addition to the brief's type: the verified token's `jti`, or the token's hash
 * when it has none. It keys the rate limiter and the license, and exists only after verification.
 */
export type GatewayCheck =
	| { ok: true; scheme: "upto" | "exact"; authorizedAtomic: bigint; paymentId: string }
	| { ok: false; reason: "missing" | "invalid" | "wrong_aud" | "wrong_scheme" | "underpaid" };

let remote: JWTVerifyGetKey | undefined;

/**
 * One remote set per isolate, so the keys are fetched once and reused. jose does not read the
 * response's Cache-Control, so cacheMaxAge stands in for it: 5 min, because the endpoint served
 * `cache-control: public, max-age=300, must-revalidate` on 2026-10-24 (the brief said 10 min, which
 * would keep a revoked key twice as long as Cloudflare allows). An unknown kid still triggers a
 * refetch after jose's cooldown, which is how a key rotation gets picked up.
 */
export function gatewayJwks(): JWTVerifyGetKey {
	remote ??= createRemoteJWKSet(new URL(GATEWAY_JWKS_URL), { cacheMaxAge: 5 * 60_000 });
	return remote;
}

export async function verifyGatewayPayment(
	request: Request,
	deps: { jwks: JWTVerifyGetKey },
	expected: { aud: string; minAtomic: bigint },
): Promise<GatewayCheck> {
	const token = request.headers.get("PAYMENT-CONTEXT")?.trim();
	if (!token) return { ok: false, reason: "missing" };

	let payload: Record<string, unknown>;
	try {
		// Signature first, then exp/nbf/aud. A token without exp would never expire, so it is required.
		({ payload } = await jwtVerify(token, deps.jwks, { algorithms: ["EdDSA"], audience: expected.aud, requiredClaims: ["exp"] }));
	} catch (err) {
		// Only an authentic token gets this far with an aud failure, so wrong_aud is never a guess.
		if (err instanceof errors.JWTClaimValidationFailed && err.claim === "aud") return { ok: false, reason: "wrong_aud" };
		// A JWKS fetch failure is ours, not the buyer's. Still fail closed, but loudly.
		if (!(err instanceof errors.JOSEError) || err instanceof errors.JWKSTimeout || err instanceof errors.JWKSInvalid) {
			console.error(`[elc-trade] gateway JWKS/verify fault: ${String(err).slice(0, 200)}`);
		}
		return { ok: false, reason: "invalid" };
	}

	// Variable pricing only: the origin settles the actual amount, so "not computed yet" can be free.
	if (payload.scheme !== "upto") return { ok: false, reason: "wrong_scheme" };
	// Digits only: "1e6", "-1", " 5" or a number are underpaid, never coerced.
	const amount = payload.amount;
	if (typeof amount !== "string" || !/^\d{1,30}$/.test(amount) || BigInt(amount) < expected.minAtomic) return { ok: false, reason: "underpaid" };

	const paymentId = typeof payload.jti === "string" && payload.jti ? `jti:${payload.jti}` : `token:${await sha256Hex(token)}`;
	return { ok: true, scheme: "upto", authorizedAtomic: BigInt(amount), paymentId };
}
