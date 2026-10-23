/**
 * Generates the RSA-2048 key pair for Bigul session JWTs (RS256). bigul-ui
 * signs with the private key; bigul-backend verifies with the public key.
 *
 * node scripts/generate-session-keys.mjs              print the env lines
 * node scripts/generate-session-keys.mjs --out <dir>  write PEM files instead
 *
 * --out refuses any directory inside a git working tree, so the keys cannot be
 * committed by accident. Never paste the private key anywhere but the bigul-ui
 * secret store (Vercel env).
 */
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  }));
} catch (error) {
  fail(error.message);
}
if (args.help) {
  process.stdout.write(
    "usage: node scripts/generate-session-keys.mjs [--out <dir outside any git repo>]\n",
  );
  process.exit(0);
}

const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return (
    samePath(child, parent) ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

// Resolves symlinks through the nearest existing ancestor; the rest may not exist yet.
function realTarget(target) {
  let existing = target;
  const missing = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync.native(existing), ...missing);
}

function enclosingGitTree(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, ".git"))) return current;
    if (path.dirname(current) === current) return null;
  }
}

let outDir;
if (args.out !== undefined) {
  if (!args.out.trim()) fail("--out needs a directory");
  outDir = realTarget(path.resolve(args.out));
  const gitTree = enclosingGitTree(outDir);
  if (isInside(outDir, realTarget(repoRoot)) || gitTree) {
    fail(
      `refusing to write keys inside a git working tree (${gitTree ?? repoRoot}). ` +
        "Choose a directory outside every repository.",
    );
  }
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
// Same kid derivation as the session JWT header: first 16 hex of sha256(SPKI DER).
const kid = createHash("sha256")
  .update(createPublicKey(publicKey).export({ type: "spki", format: "der" }))
  .digest("hex")
  .slice(0, 16);

if (outDir === undefined) {
  const b64 = (pem) => Buffer.from(pem, "utf8").toString("base64");
  process.stdout.write(
    [
      `# Bigul session signing keys (RS256, kid ${kid}). Secrets: never commit.`,
      "",
      "# bigul-ui only (Vercel env, server-side):",
      `BIGUL_SESSION_PRIVATE_KEY_B64=${b64(privateKey)}`,
      "",
      "# bigul-backend only (LangGraph deployment env):",
      `BIGUL_SESSION_PUBLIC_KEY_B64=${b64(publicKey)}`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const privatePath = path.join(outDir, "session-private.pem");
const publicPath = path.join(outDir, "session-public.pem");
const taken = [privatePath, publicPath].find((file) => existsSync(file));
if (taken)
  fail(`${taken} already exists; move it away or pick another --out directory`);
try {
  // "wx": never overwrite an existing key.
  writeFileSync(privatePath, privateKey, { flag: "wx", mode: 0o600 });
  writeFileSync(publicPath, publicKey, { flag: "wx", mode: 0o644 });
} catch (error) {
  fail(error.message);
}

process.stdout.write(
  [
    `kid ${kid}`,
    `bigul-ui private key:     ${privatePath}`,
    `bigul-backend public key: ${publicPath}`,
    "Env values are the base64 of each file: BIGUL_SESSION_PRIVATE_KEY_B64 (bigul-ui),",
    "BIGUL_SESSION_PUBLIC_KEY_B64 (bigul-backend). The PEM text also works in",
    "BIGUL_SESSION_PRIVATE_KEY / BIGUL_SESSION_PUBLIC_KEY with newlines as \\n.",
    "",
  ].join("\n"),
);
process.stderr.write(
  "warning: session-private.pem is unencrypted. Load it into the secret store, then delete it.\n",
);
