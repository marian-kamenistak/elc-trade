import { describe, expect, it } from "vitest";
import { suppressGrid, toRange, type RawCell } from "../src/data/suppress";

const many = (n: number, prefix: string): Record<string, number> => {
	const out: Record<string, number> = {};
	for (let i = 0; i < n; i++) out[`${prefix}${i}`] = 1;
	return out;
};

describe("suppressGrid", () => {
	it("suppresses cells below 10", () => {
		const out = suppressGrid([{ key: { s: "vp", b: "1k+" }, n: 9, companyCounts: { a: 9 } }], []);
		expect(out[0]).toMatchObject({ n: null, suppressed: true, reason: "below_k" });
	});

	it("suppresses a cell one company dominates", () => {
		const out = suppressGrid([{ key: { s: "manager", b: "1k+" }, n: 12, companyCounts: { a: 7, b: 5 } }], []);
		expect(out[0].reason).toBe("dominance");
	});

	it("does not suppress a cell where the top company holds exactly half", () => {
		const out = suppressGrid([{ key: { s: "manager" }, n: 12, companyCounts: { a: 6, b: 6 } }], []);
		expect(out[0]).toMatchObject({ n: 12, suppressed: false });
	});

	it("below_k takes precedence over dominance", () => {
		const out = suppressGrid([{ key: { s: "vp" }, n: 5, companyCounts: { a: 5 } }], []);
		expect(out[0].reason).toBe("below_k");
	});

	it("adds secondary suppression so no hidden cell is recoverable from a published marginal", () => {
		const cells = [
			{ key: { s: "vp", b: "1-50" }, n: 4, companyCounts: { a: 1, b: 1, c: 1, d: 1 } },
			{ key: { s: "vp", b: "51-250" }, n: 20, companyCounts: { e: 5, f: 5, g: 5, h: 5 } },
			{ key: { s: "vp", b: "1k+" }, n: 30, companyCounts: { i: 10, j: 10, k: 10 } },
		];
		const out = suppressGrid(cells, [["s"]]);
		expect(out.filter((c) => c.suppressed).length).toBeGreaterThanOrEqual(2);
		expect(out.some((c) => c.reason === "secondary")).toBe(true);
		// the smallest still-published cell (n=20) is the one hidden
		expect(out[1]).toMatchObject({ n: null, suppressed: true, reason: "secondary" });
		expect(out[2]).toMatchObject({ n: 30, suppressed: false });
	});

	it("leaves a group alone when two or more cells are already suppressed", () => {
		const cells: RawCell[] = [
			{ key: { s: "vp", b: "a" }, n: 3, companyCounts: many(3, "x") },
			{ key: { s: "vp", b: "b" }, n: 4, companyCounts: many(4, "y") },
			{ key: { s: "vp", b: "c" }, n: 30, companyCounts: many(30, "z") },
		];
		const out = suppressGrid(cells, [["s"]]);
		expect(out.map((c) => c.reason)).toEqual(["below_k", "below_k", undefined]);
	});

	it("runs to a fixed point: a secondary suppression in one group forces another in the next", () => {
		// Grid: A(s1,b1) small; B(s1,b2); D(s2,b2). Groups by "b" run first, so a single pass would stop
		// after hiding B; hiding B then exposes D through the b2 total.
		const cells: RawCell[] = [
			{ key: { s: "s1", b: "b1" }, n: 4, companyCounts: many(4, "a") },
			{ key: { s: "s1", b: "b2" }, n: 20, companyCounts: many(20, "b") },
			{ key: { s: "s2", b: "b2" }, n: 30, companyCounts: many(30, "d") },
		];
		const out = suppressGrid(cells, [["b"], ["s"]]);
		expect(out.map((c) => c.reason)).toEqual(["below_k", "secondary", "secondary"]);
		expect(out.every((c) => c.n === null)).toBe(true);
	});

	it("preserves input order and does not mutate inputs", () => {
		const cells: RawCell[] = [
			{ key: { s: "vp", b: "z" }, n: 50, companyCounts: many(50, "p") },
			{ key: { s: "vp", b: "y" }, n: 2, companyCounts: many(2, "q") },
			{ key: { s: "vp", b: "x" }, n: 15, companyCounts: many(15, "r") },
		];
		const marginals = [["s"]];
		const cellsBefore = JSON.parse(JSON.stringify(cells));
		const marginalsBefore = JSON.parse(JSON.stringify(marginals));
		const out = suppressGrid(cells, marginals);
		expect(out.map((c) => c.key.b)).toEqual(["z", "y", "x"]);
		expect(out.map((c) => c.reason)).toEqual([undefined, "below_k", "secondary"]);
		expect(cells).toEqual(cellsBefore);
		expect(marginals).toEqual(marginalsBefore);
	});
});

describe("toRange", () => {
	it("buckets counts", () => {
		expect(toRange(9)).toBeNull();
		expect(toRange(10)).toBe("10–24");
		expect(toRange(24)).toBe("10–24");
		expect(toRange(25)).toBe("25–49");
		expect(toRange(49)).toBe("25–49");
		expect(toRange(50)).toBe("50–99");
		expect(toRange(99)).toBe("50–99");
		expect(toRange(100)).toBe("100+");
	});
});
