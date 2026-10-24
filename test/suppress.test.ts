import { describe, expect, it } from "vitest";
import { isMarginalPublishable, publicCells, suppressGrid, toRange, type PublishedCell, type RawCell } from "../src/data/suppress";

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

	it("leaves a group alone when two or more cells are hidden and their true sum is at least K_MIN", () => {
		const cells: RawCell[] = [
			{ key: { s: "vp", b: "a" }, n: 3, companyCounts: many(3, "x") },
			{ key: { s: "vp", b: "b" }, n: 8, companyCounts: many(8, "y") },
			{ key: { s: "vp", b: "c" }, n: 30, companyCounts: many(30, "z") },
		];
		const out = suppressGrid(cells, [["s"]]);
		expect(out.map((c) => c.reason)).toEqual(["below_k", "below_k", undefined]);
	});

	it("cascades across groups in a dense 2-D grid until every group is safe", () => {
		// A is below k. Hiding it forces C (same b), which forces D (same s as C) and B (same s as A).
		const cells: RawCell[] = [
			{ key: { s: "s1", b: "b1" }, n: 4, companyCounts: many(4, "a") },
			{ key: { s: "s1", b: "b2" }, n: 20, companyCounts: many(20, "b") },
			{ key: { s: "s2", b: "b1" }, n: 25, companyCounts: many(25, "c") },
			{ key: { s: "s2", b: "b2" }, n: 30, companyCounts: many(30, "d") },
		];
		const out = suppressGrid(cells, [["b"], ["s"]]);
		expect(out.map((c) => c.reason)).toEqual(["below_k", "secondary", "secondary", "secondary"]);
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

// ---- recovery attacks -------------------------------------------------------------------------

const cell = (key: Record<string, string>, n: number): RawCell => ({ key, n, companyCounts: many(n, JSON.stringify(key)) });

/** Rank of a 0/1 matrix by Gaussian elimination (small matrices, float is exact enough). */
function rank(rows: number[][]): number {
	const m = rows.map((r) => [...r]);
	let rk = 0;
	const cols = m[0]?.length ?? 0;
	for (let c = 0; c < cols && rk < m.length; c++) {
		let p = rk;
		for (let r = rk + 1; r < m.length; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
		if (Math.abs(m[p][c]) < 1e-9) continue;
		[m[rk], m[p]] = [m[p], m[rk]];
		for (let r = 0; r < m.length; r++) {
			if (r === rk) continue;
			const f = m[r][c] / m[rk][c];
			for (let k = c; k < cols; k++) m[r][k] -= f * m[rk][k];
		}
		rk++;
	}
	return rk;
}

/**
 * Attacker model: hidden cells are unknowns; every published marginal gives one linear equation over
 * the hidden members of its group. A hidden cell is recoverable iff its unit vector lies in the row
 * space of those equations, i.e. every consistent solution assigns it the same value. Returns the
 * keys of recoverable hidden cells and the groups whose hidden true sum is below K_MIN.
 */
function attack(raw: RawCell[], out: PublishedCell[], dims: string[][]) {
	const hidden = out.map((c, i) => (c.suppressed ? i : -1)).filter((i) => i >= 0);
	const eqs: number[][] = [];
	const smallSums: string[] = [];
	for (const d of dims) {
		const groups = new Map<string, number[]>();
		for (const i of hidden) {
			const id = JSON.stringify(d.map((x) => raw[i].key[x]));
			groups.set(id, [...(groups.get(id) ?? []), i]);
		}
		for (const [id, members] of groups) {
			eqs.push(hidden.map((i) => (members.includes(i) ? 1 : 0)));
			if (members.reduce((a, i) => a + raw[i].n, 0) < 10) smallSums.push(id);
		}
	}
	const recoverable = hidden.filter((i, pos) => {
		if (eqs.length === 0) return false;
		const unit = hidden.map((_, q) => (q === pos ? 1 : 0));
		return rank([...eqs, unit]) === rank(eqs);
	});
	return { recoverable: recoverable.map((i) => raw[i].key), smallSums };
}

describe("recovery attacks", () => {
	function bridgeProbe(): RawCell[] {
		const small = new Set(["r1c1", "r1c2", "r2c1", "r2c2", "r3c3", "r3c4", "r4c3", "r4c4", "r2c3"]);
		const cells: RawCell[] = [];
		for (const r of ["r1", "r2", "r3", "r4"])
			for (const c of ["c1", "c2", "c3", "c4"]) {
				const k = r + c;
				cells.push(cell({ r, c }, small.has(k) ? (k === "r2c3" ? 7 : 3) : 40));
			}
		return cells;
	}

	it("cures bridge recovery: no hidden cell in the 2-D probe is determined by the marginals", () => {
		const raw = bridgeProbe();
		const out = suppressGrid(raw, [["r"], ["c"]]);
		const a = attack(raw, out, [["r"], ["c"]]);
		expect(a.recoverable).toEqual([]);
		expect(a.smallSums).toEqual([]);
		expect(out.some((c) => c.reason === "secondary")).toBe(true);
	});

	it("attacker model sees the probe leak when nothing but primary suppression is applied", () => {
		const raw = bridgeProbe();
		const primaryOnly = raw.map((c) => (c.n < 10 ? { key: c.key, n: null, suppressed: true } : { key: c.key, n: c.n, suppressed: false }));
		expect(attack(raw, primaryOnly, [["r"], ["c"]]).recoverable).toEqual([{ r: "r2", c: "c3" }]);
	});

	it("hides a third cell when the hidden true sum of a group is under K_MIN", () => {
		const raw = [cell({ s: "vp", b: "a" }, 0), cell({ s: "vp", b: "b" }, 1), cell({ s: "vp", b: "c" }, 30)];
		const out = suppressGrid(raw, [["s"]]);
		expect(out.map((c) => c.reason)).toEqual(["below_k", "below_k", "secondary"]);
	});

	it("keeps adding secondary cells until the hidden sum reaches K_MIN", () => {
		const raw = [cell({ s: "vp", b: "a" }, 1), cell({ s: "vp", b: "b" }, 2), cell({ s: "vp", b: "c" }, 12), cell({ s: "vp", b: "d" }, 13), cell({ s: "vp", b: "e" }, 40)];
		const out = suppressGrid(raw, [["s"]]);
		const hiddenSum = out.reduce((a, c, i) => a + (c.suppressed ? raw[i].n : 0), 0);
		expect(hiddenSum).toBeGreaterThanOrEqual(10);
		expect(out[4].suppressed).toBe(false);
	});

	it("random 2-D grids: no hidden cell recoverable and every hidden group sums to at least K_MIN", () => {
		let seed = 12345;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
		for (let t = 0; t < 40; t++) {
			const raw: RawCell[] = [];
			for (let r = 0; r < 5; r++) for (let c = 0; c < 4; c++) raw.push(cell({ r: `r${r}`, c: `c${c}` }, 3 + Math.floor(rnd() * rnd() * 58)));
			const out = suppressGrid(raw, [["r"], ["c"]]);
			const a = attack(raw, out, [["r"], ["c"]]);
			expect(a.recoverable, `grid ${t}`).toEqual([]);
			expect(a.smallSums, `grid ${t}`).toEqual([]);
		}
	});

	it("random 1-D grids: no hidden cell recoverable and sums at least K_MIN", () => {
		let seed = 777;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
		for (let t = 0; t < 40; t++) {
			const raw: RawCell[] = [];
			for (let b = 0; b < 6; b++) raw.push(cell({ s: "vp", b: `b${b}` }, 3 + Math.floor(rnd() * rnd() * 58)));
			const out = suppressGrid(raw, [["s"]]);
			const a = attack(raw, out, [["s"]]);
			expect(a.recoverable, `grid ${t}`).toEqual([]);
			expect(a.smallSums, `grid ${t}`).toEqual([]);
		}
	});

	it("fails closed on a sparse 2-D grid (reviewer minimal case: r0 holds only r0c4)", () => {
		const raw: RawCell[] = [];
		for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (r > 0 || c === 4) raw.push(cell({ r: `r${r}`, c: `c${c}` }, r === 0 ? 6 : 30));
		expect(() => suppressGrid(raw, [["r"], ["c"]])).toThrow("suppressGrid requires a dense 2-D grid; pass n=0 cells for empty combinations");
	});

	it("throws on duplicate keys, in 2-D with the dense message and in 0/1-D with its own", () => {
		const dup = [cell({ r: "a", c: "x" }, 20), cell({ r: "a", c: "x" }, 20), cell({ r: "b", c: "x" }, 20), cell({ r: "b", c: "y" }, 20)];
		expect(() => suppressGrid(dup, [["r"], ["c"]])).toThrow("dense 2-D grid");
		expect(() => suppressGrid(dup, [["r"]])).toThrow("unique cell keys");
		expect(() => suppressGrid(dup, [])).toThrow("unique cell keys");
	});

	it("accepts a dense 2-D grid with n=0 cells for empty combinations", () => {
		const raw = [cell({ r: "a", c: "x" }, 30), cell({ r: "a", c: "y" }, 0), cell({ r: "b", c: "x" }, 30), cell({ r: "b", c: "y" }, 30)];
		const a = attack(raw, suppressGrid(raw, [["r"], ["c"]]), [["r"], ["c"]]);
		expect(a.recoverable).toEqual([]);
	});

	it("throws on a group of two or more cells that cannot be cured", () => {
		const raw = [cell({ s: "vp", b: "a" }, 3), cell({ s: "vp", b: "b" }, 4)];
		expect(() => suppressGrid(raw, [["s"]])).toThrow(/^uncurable suppression pattern: /);
	});

	it("does not throw for a one-cell hidden group in 1-D; isMarginalPublishable gates it", () => {
		const raw = [cell({ s: "vp" }, 4), cell({ s: "cto" }, 30)];
		const out = suppressGrid(raw, [["s"]]);
		expect(out[0].suppressed).toBe(true);
		expect(isMarginalPublishable(out, raw, { s: "vp" })).toBe(false);
	});

	it("throws for more than two marginal groups", () => {
		expect(() => suppressGrid([cell({ a: "1", b: "1", c: "1" }, 20)], [["a"], ["b"], ["c"]])).toThrow(
			"suppressGrid supports at most 2 marginal groups; publish 2-D tables only",
		);
	});
});

describe("tie-break determinism (R11)", () => {
	it("picks the same cell whatever the input order", () => {
		const hid = cell({ s: "vp", b: "a" }, 5);
		const x = cell({ s: "vp", b: "x" }, 20);
		const y = cell({ s: "vp", b: "y" }, 20);
		const z = cell({ s: "vp", b: "z" }, 40);
		const pick = (cells: RawCell[]) => suppressGrid(cells, [["s"]]).filter((c) => c.reason === "secondary").map((c) => c.key.b);
		expect(pick([hid, x, y, z])).toEqual(["x"]);
		expect(pick([z, y, x, hid])).toEqual(["x"]);
	});
});

describe("publicCells (R10)", () => {
	it("strips reason and suppressed", () => {
		const out = suppressGrid([cell({ s: "vp" }, 4), cell({ s: "cto" }, 30)], []);
		const pub = publicCells(out);
		expect(pub).toEqual([{ key: { s: "vp" }, n: null }, { key: { s: "cto" }, n: 30 }]);
		expect(Object.keys(pub[0]).sort()).toEqual(["key", "n"]);
	});
});

describe("isMarginalPublishable (R12)", () => {
	it("is false when the only cell of the group is hidden", () => {
		const raw = [cell({ s: "vp", b: "a" }, 4), cell({ s: "cto", b: "a" }, 30)];
		expect(isMarginalPublishable(suppressGrid(raw, []), raw, { s: "vp" })).toBe(false);
	});
	it("is false when the hidden true sum is under K_MIN", () => {
		const raw = [cell({ s: "vp", b: "a" }, 3), cell({ s: "vp", b: "b" }, 4), cell({ s: "vp", b: "c" }, 30)];
		const out = suppressGrid(raw, []); // no marginals passed: caller forgot the cure
		expect(isMarginalPublishable(out, raw, { s: "vp" })).toBe(false);
	});
	it("is true when nothing is hidden or the hidden sum is safe", () => {
		const raw = [cell({ s: "vp", b: "a" }, 20), cell({ s: "vp", b: "b" }, 30), cell({ s: "cto", b: "a" }, 3), cell({ s: "cto", b: "b" }, 9), cell({ s: "cto", b: "c" }, 50)];
		const out = suppressGrid(raw, [["s"]]);
		expect(isMarginalPublishable(out, raw, { s: "vp" })).toBe(true);
		expect(isMarginalPublishable(out, raw, { s: "cto" })).toBe(true);
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
