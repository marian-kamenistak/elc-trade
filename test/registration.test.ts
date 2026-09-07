import { describe, expect, it } from "vitest";
import { z } from "zod";
import { permissiveShape } from "../src/core/permissive";
import { LIVE_SERVICES } from "../src/core/services";
import { dispatch } from "../src/core/dispatch";

/**
 * registerTool validates against its own inputSchema and throws McpError -32602 BEFORE the
 * handler runs, so dispatch's InvalidArgumentsError — which names every accepted argument —
 * was unreachable on the MCP transport and only ever fired on A2A. A bare `buy_reach {}`
 * against the deployed endpoint on 2026-09-07 returned:
 *   "expected array, received undefined"
 * naming one field, offering no menu, and 24 of the 73 bridge errors on 09-05 were that shape.
 */
describe("permissiveShape", () => {
	it("admits a bare {} so the call reaches dispatch", () => {
		for (const service of LIVE_SERVICES) {
			const parsed = z.object(permissiveShape(service.inputSchema)).safeParse({});
			expect(parsed.success, service.id).toBe(true);
		}
	});

	/**
	 * The enum has to be widened, not kept. With it in place the SDK rejects
	 * `["hosted_meetup"]` before the handler runs, so dispatch's id normalisation is
	 * unreachable on MCP and a caller who wrote the right item in the wrong word order still
	 * gets the nine-value dump. Widened, the call reaches dispatch, which normalises and then
	 * enforces the real enum itself.
	 */
	it("widens an enum so the value reaches dispatch", () => {
		const buyReach = LIVE_SERVICES.find((s) => s.id === "buy_reach")!;
		const shape = z.object(permissiveShape(buyReach.inputSchema));
		expect(shape.safeParse({ oneoff_ids: ["hosted_meetup"] }).success).toBe(true);
		expect(shape.safeParse({ oneoff_ids: ["dinner"] }).success).toBe(true);
		// The container type survives: this is still an array of strings in tools/list.
		expect(shape.safeParse({ oneoff_ids: "dinner" }).success).toBe(false);
		expect(shape.safeParse({ oneoff_ids: [7] }).success).toBe(false);
	});

	/**
	 * Widening moves the contract into the prose, so the prose has to carry it. A field added
	 * without a description would publish a bare `string` with nothing saying what goes in it.
	 */
	it("every registry field has a description to carry the contract", () => {
		for (const service of LIVE_SERVICES) {
			for (const [name, field] of Object.entries(service.inputSchema)) {
				expect((field as z.ZodType).description, `${service.id}.${name}`).toBeTruthy();
			}
		}
	});

	it("says 'Required.' in the description of a field it just made optional", () => {
		const buyReach = LIVE_SERVICES.find((s) => s.id === "buy_reach")!;
		const shape = permissiveShape(buyReach.inputSchema);
		expect(shape.oneoff_ids.description).toMatch(/^Required\./);
		// An already-optional field must not gain the word.
		expect(shape.budget_eur.description ?? "").not.toMatch(/^Required\./);
	});

	it("still refuses the call — dispatch, not the SDK, now writes the message", async () => {
		await expect(dispatch("buy_reach", {})).rejects.toThrow(/Accepted arguments:[\s\S]*oneoff_ids/);
	});
});
