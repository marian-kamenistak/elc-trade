// Dry run of the real nightly handler (nightlyScheduled) with no outside effect.
//   set -a; . ~/.env; set +a; npx vite-node scripts/dry-run.ts
// Reads Attio (query endpoints) and Luma (GET); R2 is an in-memory stub; Slack and control-room are
// not configured; any other request is blocked and counted. Exit 1 if anything was blocked or the run failed.
import { nightlyScheduled, type NightlyEnv } from "../src/data/snapshot-store";

const realFetch = globalThis.fetch;
const blocked: string[] = [];
let reads = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	const method = (init?.method ?? "GET").toUpperCase();
	const attioQuery = url.startsWith("https://api.attio.com/v2/") && /\/query$/.test(url.split("?")[0]) && method === "POST";
	const lumaRead = url.startsWith("https://public-api.luma.com/v1/") && method === "GET";
	if (attioQuery || lumaRead) {
		reads++;
		return realFetch(input, init);
	}
	blocked.push(`${method} ${url}`);
	return new Response("{}", { status: 200 });
}) as typeof fetch;

const objects = new Map<string, string>();
const bucket = {
	async get(key: string) {
		const text = objects.get(key);
		return text === undefined ? null : { text: async () => text };
	},
	async put(key: string, value: string) {
		objects.set(key, value);
		return {};
	},
} as unknown as R2Bucket;

let errors = 0;
const origError = console.error;
console.error = (...a: unknown[]) => {
	errors++;
	origError(...a);
};

const env: NightlyEnv = { ATTIO_TOKEN: process.env.ATTIO_TOKEN, LUMA_API_KEY: process.env.LUMA_API_KEY, SNAPSHOTS: bucket };
await nightlyScheduled({ scheduledTime: Date.now(), cron: "15 3 * * *" } as ScheduledController, env, {} as ExecutionContext);
console.log(`dry-run summary: reads=${reads} stub_r2_keys=${objects.size} blocked=${blocked.length} errors=${errors}`);
for (const b of blocked) console.log(`BLOCKED ${b}`);
process.exit(errors || blocked.length || objects.size === 0 ? 1 : 0);
