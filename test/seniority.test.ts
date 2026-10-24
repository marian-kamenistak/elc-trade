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
