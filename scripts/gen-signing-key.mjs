#!/usr/bin/env node
/**
 * Generates the Ed25519 key that signs elc-trade answers.
 *
 * Prints ONLY the public JWK (it goes into wrangler.jsonc as SIGNING_PUBLIC_JWK). The private
 * JWK is stored in ~/.env as SIGNING_PRIVATE_JWK=<base64url(JSON)> (no quotes or braces, so
 * `source ~/.env` cannot mangle it) and never printed or written
 * anywhere in the repo; from there `add-secret.sh` moves it to 1Password and secret-sync to
 * the Worker. Refuses to run if the key already exists, because rotating silently would
 * orphan every signature already published against the old public key. `--replace` rewrites
 * that one line in place (atomic, no other line touched) for a deliberate rotation.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";

const ENV = join(homedir(), ".env");
const NAME = "SIGNING_PRIVATE_JWK";

const current = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
const LINE = new RegExp(`^${NAME}=.*$`, "m");
const replace = process.argv.includes("--replace");
if (LINE.test(current) && !replace) {
	console.error(`${NAME} already exists in ${ENV}; refusing to overwrite. Pass --replace to rotate deliberately.`);
	process.exit(1);
}

const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const priv = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
const pub = await webcrypto.subtle.exportKey("jwk", pair.publicKey);

const line = `${NAME}=${Buffer.from(JSON.stringify(priv)).toString("base64url")}`;
const next = LINE.test(current)
	? current.replace(LINE, () => line)
	: `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`;
// Atomic: write a sibling then rename, so a crash never leaves a truncated ~/.env.
writeFileSync(`${ENV}.tmp`, next, { mode: 0o600 });
renameSync(`${ENV}.tmp`, ENV);
console.log(JSON.stringify(pub));
