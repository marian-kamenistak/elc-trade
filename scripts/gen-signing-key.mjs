#!/usr/bin/env node
/**
 * Generates the Ed25519 key that signs elc-trade answers.
 *
 * Prints ONLY the public JWK (it goes into wrangler.jsonc as SIGNING_PUBLIC_JWK). The private
 * JWK is appended to ~/.env as SIGNING_PRIVATE_JWK=<compact JSON> and never printed or written
 * anywhere in the repo; from there `add-secret.sh` moves it to 1Password and secret-sync to
 * the Worker. Refuses to run if the key already exists, because rotating silently would
 * orphan every signature already published against the old public key.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";

const ENV = join(homedir(), ".env");
const NAME = "SIGNING_PRIVATE_JWK";

const current = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
if (new RegExp(`^${NAME}=`, "m").test(current)) {
	console.error(`${NAME} already exists in ${ENV}; refusing to overwrite. Rotate deliberately (new kid) instead.`);
	process.exit(1);
}

const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const priv = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
const pub = await webcrypto.subtle.exportKey("jwk", pair.publicKey);

appendFileSync(ENV, `${current === "" || current.endsWith("\n") ? "" : "\n"}${NAME}=${JSON.stringify(priv)}\n`);
console.log(JSON.stringify(pub));
