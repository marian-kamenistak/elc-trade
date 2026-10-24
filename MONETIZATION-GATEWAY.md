# Monetization Gateway runbook (second paid rail)

Cloudflare Monetization Gateway charges x402 at the edge, per URL, then forwards a signed
`PAYMENT-CONTEXT` JWT to this Worker. The origin half is built and ships **off**
(`PAYMENT_GATEWAY_ENABLED: "0"` in `wrangler.jsonc`). Going live = the dashboard rules below
plus that var flipped to `"1"`.

Code: `src/paid-gateway.ts` (JWT check), `src/data-http.ts` (the door), `test/paid-gateway.test.ts`.

## Status on 2026-10-24

- The gateway is a **closed beta, US-only for buyers and sellers**
  (developers.cloudflare.com/monetization-gateway/eligibility/, read 2026-10-24). ELC s.r.o. is
  not eligible today. This rail was built ahead, by Marian's call (2026-10-24).
- Both products are still **withheld until gate G1** (privacy-policy purpose + lawyer review).
  The door honours `withheld` exactly like the MCP door, so even with the var on it returns a
  404 withheld notice until G1 clears.

## The door

| Product | URL (= JWT `aud`) |
|---|---|
| leader composition | `https://www.engineeringleaders.io/mcp/trade/data/leader-composition` |
| meetup benchmarks | `https://www.engineeringleaders.io/mcp/trade/data/meetup-benchmarks` |

`GET` only. Each product has exactly one URL: `www`, no trailing slash. The expected `aud` is that
constant, never rebuilt from the request, so a query string does not change it.

The apex `engineeringleaders.io` is routed to this Worker too, but the gateway rule covers `www`
only. So any other host gets a **308 to the identical www URL** (path + query) before any header or
token is read: a www token replayed at the apex, where nothing charges, never reaches verification.

Order, per request: switch off → 404; host not `www` → 308 to www; not GET → 405; trailing slash or unknown slug → 404;
withheld → 404 with notice; payment not verified → 402 with the free preview and `reason`;
rate limited (`PAID_RATE`, keyed `gateway:<jti>` or the token hash) → 429; no snapshot → 200
"Not computed yet" with `PAYMENT-SETTLEMENT: {"amount":"0"}`; otherwise 200, the full signed answer,
`PAYMENT-SETTLEMENT: {"amount":"500000"}`. `PAYMENT-SETTLEMENT` only on those two 200s;
`PAYMENT-RESPONSE` never. Every response is `cache-control: no-store`.

The JWT is verified with jose against the pinned JWKS `https://payments.cloudflare.com/certs`
only (`EdDSA` or `Ed25519`, `aud`, `exp` required, `nbf` checked when present, `iat` required and
no more than 10 min old nor in the future), then `scheme` must be `upto` and
`amount` a digit string ≥ 500000.

## Dashboard rules (one per product)

| Field | leader composition | meetup benchmarks |
|---|---|---|
| Domain | `engineeringleaders.io` | `engineeringleaders.io` |
| URL | `www.engineeringleaders.io/mcp/trade/data/leader-composition` | `www.engineeringleaders.io/mcp/trade/data/meetup-benchmarks` |
| Methods | `GET` | `GET` |
| Audience | `Everyone` | `Everyone` |
| Scheme | `Variable` (upto) | `Variable` (upto) |
| Price | `$0.50` | `$0.50` |

**Receiving wallet:** the Stripe crypto deposit address from `strategy/08-a2a-agent-trading.md`
(so funds land in the ELC s.r.o. Stripe balance). **Unverified:** whether the gateway accepts a
Stripe deposit address as the receiving wallet at all, and on which network/token.

## Go-live steps

1. **Eligibility.** Confirm the gateway is open to an EU (CZ) seller. US-only on 2026-10-24.
   Also G1 must be cleared, or the door keeps answering 404 withheld.
2. **Create the two rules** above in the dashboard, with the receiving wallet.
3. **Flip `PAYMENT_GATEWAY_ENABLED` to `"1"`** in `wrangler.jsonc`, then `npm run deploy`.
4. **One real paid call** to each URL with an x402 client. Expect 200, `data.full`, a
   `signature` that `node scripts/verify-response.mjs` accepts, and `PAYMENT-SETTLEMENT:
   {"amount":"500000"}`. A call without payment must come back 402 from the edge.
   **Replay a valid token against the apex host** (`https://engineeringleaders.io/mcp/trade/data/<slug>`
   with the same `PAYMENT-CONTEXT`) → must not return 200. Expected: 308 to www.
5. **Confirm the settlement in the dashboard** (amount $0.50, right wallet). Then tail the Worker
   for 60 s: zero `console.error`, zero exceptions.

## Verified vs unverified

Verified on 2026-10-24:
- `https://payments.cloudflare.com/certs` serves one Ed25519 key, `alg: "EdDSA"`, `kid: "key-1"`,
  with `cache-control: public, max-age=300, must-revalidate`. jose does not read Cache-Control, so
  `cacheMaxAge` is set to the same 5 min (the brief said 10 min).
- Under `wrangler dev` (workerd) the door fetches that JWKS and rejects a forged token with 402
  `invalid`; jose bundles from its `webapi` build (`wrangler deploy --dry-run`).

Unverified (check at step 4):
- That the gateway's `aud` is exactly the canonical URL above (no query string, no trailing
  slash). If it differs, every paid call fails with `wrong_aud` and 402: nothing is served and,
  if the next point holds, nothing is charged.
- That an upto authorisation with no `PAYMENT-SETTLEMENT` on a status ≥ 400 settles nothing.
- Whether the gateway rule also matches the apex host or a trailing-slash variant.
- Whether a JWT is single-use. The origin cannot tell a replay of one valid token within its
  `exp` from a fresh call; `PAID_RATE` caps one token at 10 calls a minute, and each call settles
  again only if the gateway treats it as a new payment.
- The `jti` claim's presence (the license falls back to the token hash without it).
- Whether the gateway accepts the Stripe deposit address (above).
