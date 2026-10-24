/**
 * Statistical disclosure control for the published member statistics: a cell is only released
 * when it cannot single anyone out, and no hidden cell may be recomputable from what is published.
 * Rules: (1) k-anonymity, a cell under K_MIN people is hidden. (2) Dominance, a cell where one
 * company supplies more than half the people is hidden, because it then describes that company's
 * staff, not a segment. (3) Secondary suppression, because hiding a cell is pointless when a
 * published marginal total lets the reader subtract it back. `marginalDims` lists the dimension
 * groups whose totals are published (`[["s"]]` groups cells by their "s" value; at most two entries,
 * i.e. 1-D or 2-D tables). Per group with any hidden cell: the hidden count must not be exactly one
 * and the hidden TRUE sum must be at least K_MIN (a near-zero hidden sum reveals the cells), cured by
 * hiding the group's smallest published cell. For two entries, each hidden cell is also an edge
 * between its row group and its column group; a hidden edge that is a bridge is solvable from the
 * two marginals (hidden mass of one side minus the other), so it is cured by hiding the smallest
 * published cell that closes a cycle through it. All rules repeat to a fixed point. The smallest
 * cell is chosen by n, then by canonical key (sorted, JSON), and groups are visited in key order, so
 * the same data gives the same pattern whatever the input order. A group with nothing left to hide
 * cannot be cured: callers must check `isMarginalPublishable` before publishing a marginal (the
 * aggregation step does). Fail closed: with two groups the grid must be dense (every combination
 * present exactly once, pass n=0 cells for empty ones), keys must be unique, and any group of two
 * or more cells or any bridge that cannot be cured throws instead of returning a leaky pattern. Pure: inputs are never mutated, output order equals input order.
 *
 * PublishedCell.reason is internal audit only: "below_k" reveals n is at most 9 and "dominance"
 * reveals company concentration. Serialize only the output of `publicCells`, never PublishedCell.
 */

export const K_MIN = 10;
export const DOMINANCE_MAX_SHARE = 0.5;

export interface RawCell {
	key: Record<string, string>;
	n: number;
	companyCounts: Record<string, number>;
}

export interface PublishedCell {
	key: Record<string, string>;
	n: number | null;
	suppressed: boolean;
	reason?: "below_k" | "dominance" | "secondary";
}

type Reason = NonNullable<PublishedCell["reason"]>;

function primaryReason(cell: RawCell): Reason | undefined {
	if (cell.n < K_MIN) return "below_k";
	const top = Math.max(0, ...Object.values(cell.companyCounts));
	if (top / cell.n > DOMINANCE_MAX_SHARE) return "dominance";
	return undefined;
}

/** Canonical, input-order-independent identity of a cell: keys sorted, JSON. */
function canonical(key: Record<string, string>): string {
	return JSON.stringify(Object.entries(key).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function suppressGrid(cells: RawCell[], marginalDims: string[][]): PublishedCell[] {
	if (marginalDims.length > 2) throw new Error("suppressGrid supports at most 2 marginal groups; publish 2-D tables only");
	const reasons: Array<Reason | undefined> = cells.map(primaryReason);
	const ck = cells.map((c) => canonical(c.key));
	const duplicate = new Set(ck).size !== ck.length;
	if (duplicate && marginalDims.length !== 2) throw new Error("suppressGrid requires unique cell keys");
	const byKey = cells.map((_, i) => i).sort((a, b) => (ck[a] < ck[b] ? -1 : ck[a] > ck[b] ? 1 : a - b));
	const smaller = (a: number, b: number) => cells[a].n < cells[b].n || (cells[a].n === cells[b].n && ck[a] < ck[b]);
	const smallest = (idx: number[]) => idx.reduce((a, b) => (smaller(b, a) ? b : a));

	// Group membership never changes, so build the groups once, in canonical order.
	const nodeOf: string[][] = marginalDims.map((dims, di) => cells.map((c) => `${di}:${JSON.stringify(dims.map((d) => c.key[d] ?? null))}`));
	if (marginalDims.length === 2) {
		// Fail closed: a sparse grid can hide a cell that no published cell can shield (no cycle to close).
		const rows = new Set(nodeOf[0]).size;
		const cols = new Set(nodeOf[1]).size;
		const pairs = new Set(cells.map((_, i) => `${nodeOf[0][i]}|${nodeOf[1][i]}`)).size;
		if (duplicate || pairs !== cells.length || cells.length !== rows * cols) {
			throw new Error("suppressGrid requires a dense 2-D grid; pass n=0 cells for empty combinations");
		}
	}
	const groups: Array<{ label: string; members: number[] }> = nodeOf.flatMap((ids) => {
		const byId = new Map<string, number[]>();
		for (const i of byKey) byId.set(ids[i], [...(byId.get(ids[i]) ?? []), i]);
		return [...byId.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([label, members]) => ({ label, members }));
	});

	const isHidden = (i: number) => reasons[i] !== undefined;

	/** Group rule: hidden count exactly one, or hidden true sum under K_MIN. Returns true if it hid a cell. */
	const cureGroups = (): boolean => {
		for (const { label, members } of groups) {
			const hidden = members.filter(isHidden);
			if (hidden.length === 0) continue;
			const sum = hidden.reduce((a, i) => a + cells[i].n, 0);
			if (hidden.length !== 1 && sum >= K_MIN) continue;
			const shown = members.filter((i) => !isHidden(i));
			if (shown.length === 0) {
				// A one-cell group is gated by isMarginalPublishable; a larger one has no cure left.
				if (members.length === 1) continue;
				throw new Error(`uncurable suppression pattern: ${label}`);
			}
			reasons[smallest(shown)] = "secondary";
			return true;
		}
		return false;
	};

	/** Bridge rule (2-D): a hidden cell that is a bridge between row and column groups is solvable. */
	const cureBridges = (): boolean => {
		if (marginalDims.length !== 2) return false;
		const hidden = byKey.filter(isHidden);
		const reach = (start: string, skip: number): Set<string> => {
			const seen = new Set([start]);
			const queue = [start];
			while (queue.length) {
				const node = queue.pop()!;
				for (const j of hidden) {
					if (j === skip) continue;
					const [u, v] = [nodeOf[0][j], nodeOf[1][j]];
					const next = u === node ? v : v === node ? u : undefined;
					if (next !== undefined && !seen.has(next)) {
						seen.add(next);
						queue.push(next);
					}
				}
			}
			return seen;
		};
		for (const e of hidden) {
			const sideA = reach(nodeOf[0][e], e);
			if (sideA.has(nodeOf[1][e])) continue; // on a cycle
			const sideB = reach(nodeOf[1][e], e);
			const closers = byKey.filter(
				(i) => !isHidden(i) && ((sideA.has(nodeOf[0][i]) && sideB.has(nodeOf[1][i])) || (sideB.has(nodeOf[0][i]) && sideA.has(nodeOf[1][i]))),
			);
			if (closers.length === 0) throw new Error(`uncurable suppression pattern: ${ck[e]}`);
			reasons[smallest(closers)] = "secondary";
			return true;
		}
		return false;
	};

	while (cureGroups() || cureBridges());

	return cells.map((cell, i) => {
		const reason = reasons[i];
		return reason
			? { key: { ...cell.key }, n: null, suppressed: true, reason }
			: { key: { ...cell.key }, n: cell.n, suppressed: false };
	});
}

/** The only shape that may be serialized: no reason, no suppressed flag. */
export function publicCells(cells: PublishedCell[]): { key: Record<string, string>; n: number | null }[] {
	return cells.map((c) => ({ key: { ...c.key }, n: c.n }));
}

/**
 * Whether the marginal total for `group` (e.g. `{ s: "vp" }`) may be published: false when the
 * group's hidden cells are exactly one or their true sum (from `rawCells`, same order as `cells`)
 * is under K_MIN, since the total would then reveal them.
 */
export function isMarginalPublishable(cells: PublishedCell[], rawCells: RawCell[], group: Record<string, string>): boolean {
	const entries = Object.entries(group);
	const hidden = cells.flatMap((c, i) => (c.suppressed && entries.every(([k, v]) => c.key[k] === v) ? [rawCells[i].n] : []));
	if (hidden.length === 0) return true;
	return hidden.length > 1 && hidden.reduce((a, n) => a + n, 0) >= K_MIN;
}

export function toRange(n: number): "10–24" | "25–49" | "50–99" | "100+" | null {
	if (n < K_MIN) return null;
	if (n < 25) return "10–24";
	if (n < 50) return "25–49";
	if (n < 100) return "50–99";
	return "100+";
}
