import { describe, expect, it } from "vitest";
import { classifySeniority } from "../src/data/seniority";

describe("classifySeniority", () => {
	it.each([
		["CTO", "c_level_founder"], ["Co-founder & CTO", "c_level_founder"], ["Partner", "c_level_founder"],
		["VP Engineering", "vp"], ["Head of Platform", "director_head"], ["Director of Engineering", "director_head"],
		["Engineering Manager", "manager"], ["Staff Engineer", "lead_staff"], ["Principal Architect", "lead_staff"],
		["Tech Lead", "lead_staff"], ["Senior Software Engineer", "ic"], ["Recruiter", "other"],
		["ředitel vývoje", "director_head"], ["vedoucí týmu", "manager"], ["kierownik zespołu", "manager"],
		["Head of nothing, ex-CTO", "c_level_founder"], ["🚀 builder", "other"],
	])("classifies %s", (t, s) => expect(classifySeniority(t)).toBe(s));

	it("does not match cto inside director, or vp inside other words", () => {
		expect(classifySeniority("Director")).toBe("director_head");
		expect(classifySeniority("Svpx Engineer")).toBe("ic");
	});

	it("treats owner and vice president as expected", () => {
		expect(classifySeniority("Owner")).toBe("c_level_founder");
		expect(classifySeniority("Vice President of Engineering")).toBe("vp");
	});

	it.each([
		["Partner", "c_level_founder"], ["Owner", "c_level_founder"], ["Managing Partner", "c_level_founder"],
		["Founding Partner", "c_level_founder"], ["Senior Partner", "c_level_founder"], ["Co-owner", "c_level_founder"],
		["Coowner", "c_level_founder"], ["Owner & CEO", "c_level_founder"], ["Owner, Acme", "c_level_founder"],
		["Owner and Founder", "c_level_founder"],
		["Product Owner", "other"], ["Service Owner", "other"], ["Data Owner", "other"],
		["HR Business Partner", "other"], ["Partner Manager", "manager"], ["Delivery Partner", "other"],
		["Engineering Partner", "other"],
	])("owner/partner: %s", (t, s) => expect(classifySeniority(t)).toBe(s));

	it.each([
		["Projektový manažer", "manager"], ["Engineering manažerka", "manager"], ["menedżer IT", "manager"],
	])("CS/SK/PL manager: %s", (t, s) => expect(classifySeniority(t)).toBe(s));

	it.each([
		["spoluzakladatel", "c_level_founder"], ["współzałożyciel", "c_level_founder"],
	])("CS/PL co-founder: %s", (t, s) => expect(classifySeniority(t)).toBe(s));

	it.each([
		["Engineering Leader", "lead_staff"], ["Team Leader", "lead_staff"], ["Teamleader", "lead_staff"], ["Teamlead", "lead_staff"],
	])("leader: %s", (t, s) => expect(classifySeniority(t)).toBe(s));

	it.each([
		["ZAŁOŻYCIEL", "c_level_founder"], ["WSPÓŁZAŁOŻYCIEL", "c_level_founder"], ["KIEROWNIK ZESPOŁU", "manager"],
		["Partner at Acme", "c_level_founder"], ["Partner @ Acme", "c_level_founder"], ["Partner of Acme", "c_level_founder"],
		["Partner, Acme", "c_level_founder"], ["Partner - Acme", "c_level_founder"], ["Owner of Acme", "c_level_founder"],
		["Owner at Acme", "c_level_founder"], ["Owner - Acme", "c_level_founder"],
		["Senior Partner at Acme", "c_level_founder"], ["Managing Partner, Acme", "c_level_founder"],
		["Senior Partner Success Manager", "manager"], ["Product Owner", "other"], ["HR Business Partner", "other"],
		["Partner Manager", "manager"],
	])("round 2: %s", (t, s) => expect(classifySeniority(t)).toBe(s));

	it("returns null for empty", () => {
		expect(classifySeniority("")).toBeNull();
		expect(classifySeniority("  ")).toBeNull();
		expect(classifySeniority(undefined)).toBeNull();
		expect(classifySeniority(null)).toBeNull();
	});

	it("never throws on odd input", () => {
		for (const v of ["\uD800", "a".repeat(100000), "\u0000", 42 as unknown as string, {} as unknown as string]) {
			expect(() => classifySeniority(v)).not.toThrow();
		}
	});
});
