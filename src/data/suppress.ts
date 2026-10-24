/**
 * Statistical disclosure control for the published member statistics: a cell is only released
 * when it cannot single anyone out. Three rules. (1) k-anonymity: a cell under K_MIN people is
 * hidden. (2) Dominance: a cell where one company supplies more than half the people is hidden,
 * because the cell then describes that company's staff, not a segment. (3) Secondary suppression:
 * hiding one cell is pointless if a published marginal total lets the reader subtract it back,
 * so a group with exactly one hidden cell also hides its smallest published cell. One extra
 * hidden cell can leave another group with a single hidden cell, so the pass repeats to a fixed
 * point. Caller contract: `marginalDims` lists the dimension groups whose totals are published
 * (`[["s"]]` groups cells by their "s" value). A group that holds one cell, hidden, has nothing
 * left to suppress, and its published marginal would equal that cell, so callers must not
 * publish such a marginal (the aggregation step handles marginal suppression). Pure: inputs are
 * never mutated and output order equals input order.
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

export function suppressGrid(cells: RawCell[], marginalDims: string[][]): PublishedCell[] {
	const reasons: Array<Reason | undefined> = cells.map(primaryReason);

	// Group membership never changes, so build the groups once.
	const groups: number[][] = [];
	for (const dims of marginalDims) {
		const byValue = new Map<string, number[]>();
		cells.forEach((cell, i) => {
			const id = JSON.stringify(dims.map((d) => cell.key[d] ?? null));
			const members = byValue.get(id);
			if (members) members.push(i);
			else byValue.set(id, [i]);
		});
		groups.push(...byValue.values());
	}

	for (let changed = true; changed; ) {
		changed = false;
		for (const members of groups) {
			const hidden = members.filter((i) => reasons[i] !== undefined);
			if (hidden.length !== 1) continue;
			const shown = members.filter((i) => reasons[i] === undefined);
			if (shown.length === 0) continue;
			const smallest = shown.reduce((a, b) => (cells[b].n < cells[a].n ? b : a));
			reasons[smallest] = "secondary";
			changed = true;
		}
	}

	return cells.map((cell, i) => {
		const reason = reasons[i];
		return reason
			? { key: { ...cell.key }, n: null, suppressed: true, reason }
			: { key: { ...cell.key }, n: cell.n, suppressed: false };
	});
}

export function toRange(n: number): "10–24" | "25–49" | "50–99" | "100+" | null {
	if (n < K_MIN) return null;
	if (n < 25) return "10–24";
	if (n < 50) return "25–49";
	if (n < 100) return "50–99";
	return "100+";
}
