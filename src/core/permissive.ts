/**
 * The schema `registerTool` gets, which is not the schema this door enforces.
 *
 * The MCP SDK validates arguments against registerTool's own inputSchema and throws
 * McpError -32602 before the handler runs. So dispatch's InvalidArgumentsError — which lists
 * every accepted argument with its description, written precisely so a caller can recover —
 * was unreachable on MCP and only ever fired on A2A. What a caller actually got was a raw Zod
 * dump: `"expected array, received undefined"`, one field named, no menu. On 2026-09-05, 24
 * of the 73 errors the bridge provoked were exactly that: a bare `{}` probing what the tool
 * wants, answered with a type error instead of an answer.
 *
 * Making every field optional here hands the call to dispatch, which validates against the
 * real schema and writes the useful message. Enums are widened to their base type for the
 * same reason: left in place, the SDK rejects `hosted_meetup` before dispatch can recognise
 * it as `meetup-hosted`, and the id normalisation is dead code on this transport.
 *
 * The cost is deliberate. MCP's `tools/list` no longer marks a field required and no longer
 * publishes the nine reach ids as a JSON Schema enum, so the contract moves into the
 * description — which is where a model reading a tool actually looks, and which the registry
 * already writes out in full ("One or more of: newsletter-section, …"). A test asserts every
 * field has one. Container types survive, so an array is still an array. And the A2A card is
 * unaffected: a2a.ts builds it from `service.inputSchema` directly, not from this.
 */

import { z } from "zod";

/** Drops value constraints, keeps the shape. Recurses for array-of-enum and optional-of-enum. */
function widen(field: z.ZodType): z.ZodType {
	const def = (field as unknown as { def: { type: string; element?: z.ZodType; innerType?: z.ZodType } }).def;
	if (def.type === "enum") return z.string();
	if (def.type === "array" && def.element) return z.array(widen(def.element));
	// Unwrapped rather than passed through: the caller re-applies .optional(), and an enum
	// inside an existing optional would otherwise keep its values and reject at the SDK.
	if (def.type === "optional" && def.innerType) return widen(def.innerType);
	return field;
}

export function permissiveShape(schema: z.ZodRawShape): z.ZodRawShape {
	return Object.fromEntries(
		Object.entries(schema).map(([name, raw]) => {
			const field = raw as z.ZodType;
			const description = field.description ?? "";
			// safeParse, not a def check: a field's optionality can come from .optional(),
			// .default() or a union with undefined, and all three must count.
			if (field.safeParse(undefined).success) {
				return [name, widen(field).optional().describe(description)];
			}
			return [name, widen(field).optional().describe(`Required. ${description}`.trim())];
		}),
	);
}
