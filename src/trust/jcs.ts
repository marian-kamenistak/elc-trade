/**
 * JSON Canonicalization (RFC 8785) for the JSON-safe values this Worker hashes and signs.
 *
 * Why: MCP and A2A serialise the same object with different key order and whitespace, so a
 * hash or signature over "the transport string" breaks between them. Both sides hash these
 * canonical bytes instead. Keys sort by UTF-16 code unit (JS default sort, as RFC 8785 says),
 * numbers and strings use ECMAScript JSON.stringify (which is what RFC 8785 specifies), and
 * there is no whitespace. Anything JSON cannot carry faithfully throws rather than being
 * silently dropped or rewritten the way JSON.stringify would: undefined, functions, symbols,
 * bigint, NaN/Infinity, and non-plain objects such as Date or Map.
 */
export function canonicalize(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "string":
			return JSON.stringify(value);
		case "number":
			if (!Number.isFinite(value)) throw new TypeError(`canonicalize: non-finite number ${value}`);
			return JSON.stringify(value);
		case "object": {
			if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(",")}]`;
			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) throw new TypeError("canonicalize: not a plain object");
			const obj = value as Record<string, unknown>;
			const keys = Object.keys(obj).sort();
			return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
		}
		default:
			throw new TypeError(`canonicalize: unsupported ${typeof value}`);
	}
}

/** SHA-256 hex over UTF-8 bytes. */
export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
