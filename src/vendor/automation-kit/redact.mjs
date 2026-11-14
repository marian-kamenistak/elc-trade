// VENDORED from ops-automation-kit v1.1.1 (redact.mjs). Do not edit here: bump the kit and re-copy.
// redact.mjs — the secret/PII scrubber control-room applies to every kpi/detail it stores
// (control-room src/lib.ts REDACTIONS, ddb796e). Reporters run it before sending too, so a secret
// never leaves the machine even if control-room's copy drifts. Keep the two lists identical until
// control-room imports this file.
export const REDACTIONS = [
	[/\b(xox[abposr]-[A-Za-z0-9-]{10,})/g, "<slack-token>"],
	[/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "<github-token>"],
	[/\b(sk-(?:ant-)?[A-Za-z0-9_-]{20,})/g, "<api-key>"],
	[/\b(ph[cx]_[A-Za-z0-9]{20,})/g, "<posthog-key>"],
	[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "$1 <redacted>"],
	[/\b((?:api[_-]?key|token|secret|password|passwd)\s*[=:]\s*)("?)[^\s"'&,]{6,}\2/gi, "$1<redacted>"],
	[/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
];

export function redact(text) {
	let out = text === undefined || text === null ? "" : String(text);
	for (const [re, sub] of REDACTIONS) out = out.replace(re, sub);
	return out;
}
