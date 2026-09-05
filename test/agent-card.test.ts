/**
 * The agent card is the whole discovery surface for the A2A door — it is what a crawling agent
 * reads before it has ever called us. These assert the two things persona testing found missing
 * or wrong there, not the card's general shape (gen-agent-card.mjs validates that at build time).
 */
import { describe, expect, it } from "vitest";
import { buildAgentCard, PRICING_EXTENSION_URI, SCHEMA_EXTENSION_URI } from "../src/a2a";
import { LIVE_SERVICES } from "../src/core/services";

const extension = (uri: string) =>
	buildAgentCard().capabilities?.extensions?.find((e) => e.uri === uri);

describe("agent card", () => {
	// 2026-09-05: A2A v1.0's AgentSkill has no inputSchema field, so an agent could see a skill
	// existed but had to guess its arguments and read the error. The schemas now ride in an
	// extension.
	it("publishes a JSON Schema for every live skill", () => {
		const params = extension(SCHEMA_EXTENSION_URI)?.params as
			| { skills?: Record<string, { properties?: Record<string, unknown>; required?: string[] }> }
			| undefined;
		expect(params?.skills, "the schema extension must be present").toBeDefined();

		for (const s of LIVE_SERVICES) {
			const schema = params!.skills![s.id];
			expect(schema, `no schema published for ${s.id}`).toBeDefined();
			// Every argument the dispatcher accepts must be discoverable from the card.
			expect(Object.keys(schema.properties ?? {}).sort()).toEqual(Object.keys(s.inputSchema).sort());
		}
	});

	// 2026-09-05: an autonomous agent reported that the extension note misdocumented the wire
	// format — it described the args object but not the {skill, args} envelope, so its first
	// call routed correctly and had every argument silently dropped. Three wasted calls, and a
	// stricter agent abandons there.
	it("documents the envelope, not just the argument shape", () => {
		const note = (extension(SCHEMA_EXTENSION_URI)?.params as { note: string }).note;
		expect(note).toContain('"skill"');
		expect(note).toContain('"args"');
	});

	it("advertises the front door first", () => {
		// tools/list, the card and the harness all render in registry order. A lost human needs
		// to meet get_started before six seller-side tools.
		expect(buildAgentCard().skills[0]?.id).toBe("get_started");
	});

	it("keeps a price for every live skill", () => {
		const params = extension(PRICING_EXTENSION_URI)?.params as {
			skills: Record<string, { model: string }>;
		};
		for (const s of LIVE_SERVICES) {
			expect(params.skills[s.id]?.model, `no price published for ${s.id}`).toBeTruthy();
		}
	});
});
