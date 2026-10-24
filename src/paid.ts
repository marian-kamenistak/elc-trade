/**
 * The paid gate: charges per call over MPP (Machine Payments Protocol) on the MCP door only.
 *
 * Why the order inside gatePaid is load-bearing: switch → snapshot → rate limit → charge. Nothing
 * is ever charged for data that does not exist, and a throttled caller is never charged at all.
 *
 * ── mppx@0.9.2 API, verified from node_modules/mppx/dist/**.d.ts on 2026-10-24 ──────────────
 * (the brief's research had usage examples only; these are the real signatures)
 *
 *   import { Mppx, tempo, Transport } from "mppx/server"
 *   Mppx.create<methods, transport>(config: {
 *     methods: methods; secretKey?: string (≥32 bytes, HMAC-binds challenge ids);
 *     realm?: string; transport?: transport (default Transport.http()); ...
 *   }): Mppx
 *   mppx.charge(options: { amount: string (human units, parseUnits(amount, decimals));
 *     description?; expires?; meta?: Record<string,string>; scope?: string (bound into the
 *     challenge; a credential for another scope is rejected); supportedModes?: ("pull"|"push")[];
 *     currency?; decimals?; ... }) => (input: Transport.InputOf<transport>) =>
 *       Promise<{ status: 402; challenge: ChallengeOutput } | { status: 200; withReceipt: WithReceipt }>
 *   tempo.charge(p?: { testnet?: boolean (chainId 42431 Moderato, currency pathUSD
 *     0x20c0…0000, 6 decimals); recipient?: `0x${string}`; store?: Store.AtomicStore
 *     (replay store, default Store.memory()); waitForConfirmation?; feePayer?; ... })
 *   Transport.mcpSdk(): Transport<Extra, McpError, CallToolResult>
 *     - getCredential reads extra._meta["org.paymentauth/credential"] (a Credential object)
 *     - respondChallenge → McpError(code -32042 required | -32043 verification failed,
 *         data: { httpStatus, challenges: Challenge[], problem? })
 *     - respondReceipt → { ...result, _meta: { "org.paymentauth/receipt": Receipt & { challengeId } } }
 *   Credential = { challenge: Challenge; payload; source?: string (payer DID,
 *     did:pkh:eip155:<chainId>:<address>; tempo's client always sets it) }
 *   Receipt = { method; reference (tx hash for tempo); status: "success"; timestamp; externalId? }
 *   Client: import { McpClient } from "mppx/mcp/client"; import { tempo } from "mppx/client";
 *     McpClient.wrap(sdkClient, { methods: [tempo({ account })] }) — callTool then pays any
 *     challenge that arrives as a -32042 error OR as result._meta["org.paymentauth/payment-required"].
 *   Stripe SPT also exists (mppx/stripe/server, stripe.charge({ secretKey | client, ... })); not used
 *   in v1, Task 7b is the second rail.
 *
 * Deviation from the brief, forced by the real stack: @modelcontextprotocol/sdk 1.29's McpServer
 * catches every McpError a tool throws (except UrlElicitationRequired) and turns it into an
 * isError text result, which drops the challenge. So the challenge is NOT thrown: the tool returns
 * the free preview with the challenge in `_meta["org.paymentauth/payment-required"]`, the second
 * shape mppx's client accepts. See withPayment below.
 */

import { Mppx, tempo, Transport } from "mppx/server";
import { readLatest } from "./data/snapshot-store";
import type { MethodId } from "./data/types";

// mppx's Mcp.credentialMetaKey / receiptMetaKey / paymentRequiredMetaKey, as literals so this file
// does not pull the whole mppx root (evm, x402) into the bundle. test/paid.test.ts pins them.
export const CREDENTIAL_META = "org.paymentauth/credential";
export const RECEIPT_META = "org.paymentauth/receipt";
export const PAYMENT_REQUIRED_META = "org.paymentauth/payment-required";

export type PaidOutcome =
	| { kind: "preview"; reason: "disabled" | "no_snapshot" | "payment_required" | "rate_limited"; challenge?: unknown }
	| { kind: "paid"; payer: string; receiptId: string; receipt?: Record<string, unknown> };

/** Secrets and the rate limiter are not all in the generated Env, so the gate names what it reads. */
export interface PaidEnv {
	PAID_ROUTE_ENABLED?: string;
	SNAPSHOTS?: R2Bucket;
	PAID_RATE?: { limit(options: { key: string }): Promise<{ success: boolean }> };
	MPP_SECRET_KEY?: string;
	MPP_NETWORK?: string;
	MPP_RECIPIENT?: string;
}

type Extra = { _meta?: Record<string, unknown>; sessionId?: unknown };

function payerOf(extra: Extra): string | undefined {
	const source = (extra._meta?.[CREDENTIAL_META] as { source?: unknown } | undefined)?.source;
	return typeof source === "string" && source ? source : undefined;
}

function createMppx(secretKey: string, recipient: `0x${string}`) {
	return Mppx.create({
		methods: [tempo.charge({ testnet: true, recipient })],
		secretKey,
		realm: "engineeringleaders.io",
		transport: Transport.mcpSdk(),
	});
}

// One instance per isolate: its default replay store is in memory, and a fresh instance per call
// would forget every spent credential.
let cached: { key: string; mppx: ReturnType<typeof createMppx> } | undefined;

function mppxFor(env: PaidEnv): ReturnType<typeof createMppx> | null {
	// Testnet only in v1. Anything else fails closed, so no config slip can take real money.
	if (env.MPP_NETWORK !== "testnet" || !env.MPP_SECRET_KEY || !/^0x[0-9a-fA-F]{40}$/.test(env.MPP_RECIPIENT ?? "")) return null;
	const key = `${env.MPP_NETWORK}:${env.MPP_RECIPIENT}:${env.MPP_SECRET_KEY}`;
	if (cached?.key !== key) cached = { key, mppx: createMppx(env.MPP_SECRET_KEY, env.MPP_RECIPIENT as `0x${string}`) };
	return cached.mppx;
}

export async function gatePaid(env: PaidEnv, ctx: { amountUsd: number; methodId: MethodId; request: unknown }): Promise<PaidOutcome> {
	// 1. The switch.
	if (env.PAID_ROUTE_ENABLED !== "1") return { kind: "preview", reason: "disabled" };

	// 2. The data must exist before anyone pays for it (Review Focus 3).
	const snapshot = env.SNAPSHOTS ? await readLatest(env.SNAPSHOTS, ctx.methodId) : null;
	if (!snapshot) return { kind: "preview", reason: "no_snapshot" };

	// 3. Rate limit, keyed by payer identity. Before payment the only identity is the credential's
	// claimed DID; a call with no credential is keyed by its MCP session.
	const extra = (ctx.request ?? {}) as Extra;
	const key = payerOf(extra) ?? (typeof extra.sessionId === "string" ? `session:${extra.sessionId}` : "anonymous");
	// No binding fails closed: an unthrottled paid route is the thing the limiter exists to prevent.
	if (!env.PAID_RATE || !(await env.PAID_RATE.limit({ key })).success) return { kind: "preview", reason: "rate_limited" };

	// 4. Charge.
	const mppx = mppxFor(env);
	if (!mppx) {
		console.error("[elc-trade] paid route enabled but MPP is not configured for testnet (MPP_NETWORK, MPP_SECRET_KEY, MPP_RECIPIENT)");
		return { kind: "preview", reason: "disabled" };
	}
	try {
		const r = await mppx.charge({
			amount: String(ctx.amountUsd),
			description: `ELC ${ctx.methodId}, full answer`,
			// Binds the challenge to the product, so a payment for one cannot be replayed on the other.
			scope: ctx.methodId,
			// Pull only: the server broadcasts the signed transaction, so the chain rejects a replay
			// even across isolates. Push (a bare tx hash) would rely on the per-isolate memory store.
			supportedModes: ["pull"],
		})(extra);
		if (r.status === 402) return { kind: "preview", reason: "payment_required", challenge: r.challenge };
		const tool = r.withReceipt({ content: [] }) as { _meta?: Record<string, unknown> };
		const receipt = (tool._meta?.[RECEIPT_META] ?? {}) as Record<string, unknown>;
		const receiptId = String(receipt.reference ?? receipt.challengeId ?? "");
		return { kind: "paid", payer: payerOf(extra) ?? `tx:${receiptId}`, receiptId, receipt };
	} catch (err) {
		console.error(`[elc-trade] paid charge failed: ${String(err).slice(0, 200)}`);
		return { kind: "preview", reason: "payment_required" };
	}
}

/** Puts the receipt, or the challenge, where an MPP client looks for it on an MCP tool result. */
export function withPayment<T extends { _meta?: Record<string, unknown> }>(result: T, outcome?: PaidOutcome): T {
	if (outcome?.kind === "paid" && outcome.receipt) return { ...result, _meta: { ...result._meta, [RECEIPT_META]: outcome.receipt } };
	if (outcome?.kind === "preview" && outcome.reason === "payment_required") {
		const data = (outcome.challenge as { data?: unknown } | undefined)?.data;
		if (data) return { ...result, _meta: { ...result._meta, [PAYMENT_REQUIRED_META]: data } };
	}
	return result;
}
