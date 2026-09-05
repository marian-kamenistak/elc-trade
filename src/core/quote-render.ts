/**
 * Renders the bridged one-off quote as prose.
 *
 * `quote_reach_combo` answers with a JSON payload because its own callers are assistants
 * composing a reply. Bridged through this door it reached buyers verbatim, and three personas
 * in the second round said the same thing: every other tool returns prose, this one dumps a
 * JSON blob with `counts_toward_combo`, `unknown_ids` and `credit_days` in it, and a
 * non-technical buyer stops reading. One called it the moment the product stopped feeling
 * finished.
 *
 * Nothing is recomputed here. Every figure is taken from the payload the sibling produced —
 * the whole point of bridging is that this door never becomes a second source of prices.
 */

export interface OneOffQuotePayload {
	items: { id: string; name: string; price: number; lead_time: string; counts_toward_combo: boolean }[];
	list_total: number;
	total: number;
	combo: { qualifying_items: number; pct: number; saved: number } | null;
	credit_days: number;
	duplicate_ids?: string[];
	duplicate_note?: string;
	discount_basis?: string;
	membership_hint?: string;
	next?: string;
}

const eur = (n: number) => `€${n.toLocaleString("en-US")}`;

/** Pulls the leading JSON object out of the sibling's report, leaving any trailing terms text. */
export function splitQuote(report: string): { payload?: OneOffQuotePayload; rest: string } {
	const start = report.indexOf("{");
	if (start !== 0) return { rest: report };
	let depth = 0;
	for (let i = 0; i < report.length; i++) {
		if (report[i] === "{") depth++;
		else if (report[i] === "}") {
			depth--;
			if (depth === 0) {
				try {
					return {
						payload: JSON.parse(report.slice(0, i + 1)) as OneOffQuotePayload,
						rest: report.slice(i + 1).trim(),
					};
				} catch {
					return { rest: report };
				}
			}
		}
	}
	return { rest: report };
}

/**
 * `budget_eur` is advisory only — it never changes a price, it says what fits. The tool that
 * knew the prices could not take a budget, and the tool that took a budget would not name a
 * price, so "what fits in 18,000?" was structurally unanswerable across the whole surface.
 */
export function renderQuote(q: OneOffQuotePayload, budgetEur?: number): string {
	const lines: string[] = [];
	lines.push(`# One-off quote — ${eur(q.total)}, excl. VAT`, "");

	for (const item of q.items) {
		lines.push(
			`- **${item.name}** — ${eur(item.price)}, ${item.lead_time.toLowerCase()}${item.counts_toward_combo ? "" : " _(job board listing: keeps its own rate card, so it neither counts toward the combo threshold nor gets discounted)_"}`,
		);
	}
	lines.push("");

	if (q.combo) {
		lines.push(
			`List price ${eur(q.list_total)}. The combo discount takes ${q.combo.pct}% off the ${q.combo.qualifying_items} qualifying items — ${eur(q.combo.saved)} — bringing it to **${eur(q.total)}**, excluding VAT.`,
		);
		if (q.items.some((i) => !i.counts_toward_combo)) {
			lines.push(
				"The job board listing sits outside the discount, so it is in the list price but not in the discounted base. The total above is the one that counts.",
			);
		}
	} else {
		lines.push(`**${eur(q.total)}**, excluding VAT. No combo discount: that needs two or more qualifying items.`);
	}

	if (budgetEur !== undefined) {
		lines.push("");
		if (q.total <= budgetEur) {
			const left = budgetEur - q.total;
			lines.push(
				`Against your ${eur(budgetEur)}: this fits, with ${eur(left)} left.${left >= 500 ? " Adding one more item may also raise the combo discount — worth re-quoting before you commit." : ""}`,
			);
		} else {
			const over = q.total - budgetEur;
			const droppable = [...q.items].sort((a, b) => a.price - b.price).find((i) => i.price >= over);
			lines.push(
				`Against your ${eur(budgetEur)}: this is ${eur(over)} over.${droppable ? ` Dropping **${droppable.name}** (${eur(droppable.price)}) would bring it inside, though removing an item can also lose the combo discount — re-quote to see the real figure.` : " Re-quote with fewer items to see what fits."}`,
			);
		}
	}

	if (q.duplicate_note) lines.push("", q.duplicate_note);
	lines.push(
		"",
		`Every one-off is credited in full against a company membership signed within ${q.credit_days} days, so buying one thing now costs nothing if you commit to a year later.`,
	);
	if (q.membership_hint) lines.push("", q.membership_hint);
	if (q.next) lines.push("", `**Next:** ${q.next}`);

	return lines.join("\n");
}
