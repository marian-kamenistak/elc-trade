import type { Seniority } from "./types";

/**
 * Buckets a free-text job title into a coarse seniority level for the aggregated member
 * statistics. Titles are noisy, multilingual (EN/CS/SK/PL) and often hold several roles
 * ("Head of nothing, ex-CTO"), so the rules run in strict first-match order, highest level
 * first: the most senior word anywhere in the title wins. Diacritics are stripped first so
 * "ředitel" matches "reditel". Word boundaries keep "cto" out of "director" and "vp" out of
 * longer words. Pure and total: it never throws, whatever it is given.
 */

const RULES: Array<[Seniority, RegExp]> = [
	["c_level_founder", /\b(ceo|cto|cfo|coo|cio|cpo|cmo|cso|cdo|cro|cxo|ciso|chief|founder|co-?founder|(spolu)?zakladatel\w*|(wspol)?zalozyciel\w*|(?<!vice[\s-])president|c-level|co-?owner|(managing|founding|senior)\s+partner)\b|^(partner|owner)\W*$|^owner\s*(&|,|and\b)/],
	["vp", /\b(s?vp|avp|vice[\s-]*president)\b/],
	["director_head", /\b(director|head|reditel\w*|riaditel\w*|dyrektor\w*)\b/],
	["manager", /\b(manager|managing|manazer\w*|menedzer\w*|vedouci|veduci|kierownik\w*)\b/],
	["lead_staff", /\b(lead|leader|teamlead|teamleader|staff|principal|distinguished|fellow)\b/],
	["ic", /\b(engineer|developer|programmer|architect|analyst|designer|consultant|scientist|researcher|senior|junior|intern|qa|tester|sre|devops|swe)\b/],
];

export function classifySeniority(title: string | null | undefined): Seniority | null {
	if (typeof title !== "string") return null;
	const t = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").toLowerCase().trim();
	if (!t) return null;
	for (const [level, re] of RULES) if (re.test(t)) return level;
	return "other";
}
