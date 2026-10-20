/**
 * Speaker programme (Marian 2026-10-20): /reach sells an itemised ladder for one speaker, priced
 * by the partnership builder's quote_reach_combo. elc-trade advertises it by its real name and
 * forwards the rung selection; it never carries a price of its own.
 */
import { describe, expect, it } from "vitest";
import { SERVICES } from "../src/core/services";

describe("buy_reach advertises the speaker programme", () => {
	const reach = SERVICES.find((s) => s.id === "buy_reach")!;
	it("names the programme, not the retired sprint", () => {
		expect(reach.description).toContain("speaker programme");
		expect(reach.description).not.toContain("speaker sprint");
	});
	it("accepts speaker_rungs so an agent can price a subset of the ladder", () => {
		const shape = reach.inputSchema as Record<string, unknown>;
		expect(shape.speaker_rungs).toBeDefined();
	});
	it("still carries no price of its own", () => {
		expect(reach.description).not.toMatch(/(€|EUR)\s?\d/);
	});
});
