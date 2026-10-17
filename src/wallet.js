// Local wallet store. Private keys are encrypted at rest with
// scrypt + AES-256-GCM in ~/.albusol/wallets/<name>.json and only decrypted
// into memory for the current session after the password is entered.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "crypto";
import { Keypair, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { HOME_DIR, loadConfig, saveConfig, rpcUrl } from "./config.js";
import { retryFetch } from "./net.js";
import { ask, askPass, askYes, choose, ok, warn, fail, info, step, header, col, vNonEmpty, fmtAmount } from "./ui.js";

const WALLET_DIR = join(HOME_DIR, "wallets");
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 };

function ensureDir() { if (!existsSync(WALLET_DIR)) mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 }); }
const fileOf = (name) => join(WALLET_DIR, `${name}.json`);

export function listWallets() {
  ensureDir();
  return readdirSync(WALLET_DIR).filter((f) => f.endsWith(".json")).map((f) => {
    try { const j = JSON.parse(readFileSync(join(WALLET_DIR, f), "utf8")); return { name: f.slice(0, -5), pubkey: j.pubkey }; }
    catch { return { name: f.slice(0, -5), pubkey: "?" }; }
  });
}

function encryptSecret(secretKey, pass) {
  const salt = randomBytes(16);
  const key = scryptSync(pass, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  return { kdf: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

function decryptSecret(j, pass) {
  const key = scryptSync(pass, Buffer.from(j.salt, "base64"), SCRYPT.keyLen, { N: j.N, r: j.r, p: j.p, maxmem: SCRYPT.maxmem });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(j.iv, "base64"));
  decipher.setAuthTag(Buffer.from(j.tag, "base64"));
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(j.ct, "base64")), decipher.final()]));
}

// Accepts: base58 secret key (Phantom export), JSON byte array, or path to a Solana CLI keypair file.
export function parseSecret(raw) {
  const s = String(raw).trim();
  if (existsSync(s)) return parseSecret(readFileSync(s, "utf8"));
  if (s.startsWith("[")) {
    const arr = JSON.parse(s);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  const bytes = bs58.decode(s);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`Unexpected key length ${bytes.length}; expected 64 (secret key) or 32 (seed)`);
}

export async function importWallet(cfg = loadConfig()) {
  header("Connect wallet — import private key");
  warn("The key is encrypted with your password and stored only on this Mac.");
  const name = await ask("Wallet name:", { default: "main", validate: (s) => /^[\w.-]{1,32}$/.test(s) || "Letters, digits, - _ . only" });
  if (existsSync(fileOf(name)) && !(await askYes(`Wallet "${name}" exists. Overwrite?`))) return null;
  const raw = await askPass("Private key (base58, JSON array, or path to keypair .json):");
  let kp;
  try { kp = parseSecret(raw); } catch (e) { fail(`Could not parse key: ${e.message}`); return null; }
  ok(`Address: ${col("cyan", kp.publicKey.toBase58())}`);
  const pass = await askPass("Password to encrypt this wallet:", { validate: (s) => s.length >= 6 || "At least 6 characters" });
  const again = await askPass("Repeat password:");
  if (pass !== again) { fail("Passwords do not match"); return null; }
  ensureDir();
  writeFileSync(fileOf(name), JSON.stringify({ v: 1, pubkey: kp.publicKey.toBase58(), ...encryptSecret(kp.secretKey, pass) }, null, 2), { mode: 0o600 });
  cfg.activeWallet = name; saveConfig(cfg);
  ok(`Saved as ${col("cyan", name)} and set active`);
  return { name, keypair: kp };
}

export async function generateWallet(cfg = loadConfig()) {
  header("Create a new wallet");
  const name = await ask("Wallet name:", { default: "new", validate: (s) => /^[\w.-]{1,32}$/.test(s) || "Letters, digits, - _ . only" });
  if (existsSync(fileOf(name)) && !(await askYes(`Wallet "${name}" exists. Overwrite?`))) return null;
  const kp = Keypair.generate();
  const pass = await askPass("Password to encrypt this wallet:", { validate: (s) => s.length >= 6 || "At least 6 characters" });
  const again = await askPass("Repeat password:");
  if (pass !== again) { fail("Passwords do not match"); return null; }
  ensureDir();
  writeFileSync(fileOf(name), JSON.stringify({ v: 1, pubkey: kp.publicKey.toBase58(), ...encryptSecret(kp.secretKey, pass) }, null, 2), { mode: 0o600 });
  cfg.activeWallet = name; saveConfig(cfg);
  ok(`Address: ${col("cyan", kp.publicKey.toBase58())}`);
  warn("Back up the key now (Wallet → Export) — nobody can recover it for you.");
  return { name, keypair: kp };
}

export async function unlockWallet(name) {
  const file = fileOf(name);
  if (!existsSync(file)) throw new Error(`Wallet "${name}" not found`);
  const j = JSON.parse(readFileSync(file, "utf8"));
  for (let i = 0; i < 3; i++) {
    const pass = await askPass(`Password for wallet "${name}" (${j.pubkey.slice(0, 6)}…):`);
    try { return Keypair.fromSecretKey(decryptSecret(j, pass)); }
    catch { fail("Wrong password"); }
  }
  throw new Error("Too many failed attempts");
}

export async function exportWallet(keypair) {
  if (!(await askYes("Print the private key to this terminal?"))) return;
  console.log(`\n    ${col("red", "PRIVATE KEY (base58):")}\n    ${bs58.encode(keypair.secretKey)}\n`);
}

export async function deleteWallet(cfg = loadConfig()) {
  const list = listWallets();
  if (!list.length) { warn("No wallets stored"); return; }
  const name = await choose("Delete which wallet?", list.map((w) => ({ name: `${w.name}  ${col("grey", w.pubkey)}`, value: w.name })));
  if (!(await askYes(`Delete "${name}" from this Mac? The key is gone unless you exported it.`))) return;
  unlinkSync(fileOf(name));
  if (cfg.activeWallet === name) { cfg.activeWallet = ""; saveConfig(cfg); }
  ok("Deleted");
}

// Session object every module receives.
export class Session {
  constructor(cfg) { this.cfg = cfg; this.name = ""; this.keypair = null; this._conn = null; }
  get connection() {
    if (!this._conn) this._conn = new Connection(rpcUrl(this.cfg), { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: retryFetch });
    return this._conn;
  }
  get cluster() { return this.cfg.network === "devnet" ? "devnet" : "mainnet"; }
  get pubkey() { return this.keypair.publicKey; }
  resetConnection() { this._conn = null; }
  async balance() { return this.connection.getBalance(this.pubkey); }
  async printStatus() {
    info("Network", this.cfg.network + "  " + col("grey", rpcUrl(this.cfg)));
    info("Wallet", `${this.name}  ${col("cyan", this.pubkey.toBase58())}`);
    try { info("Balance", fmtAmount(await this.balance(), 9, "SOL")); }
    catch (e) { warn(`Balance unavailable: ${e.message}`); }
  }
}

export async function connectSession(cfg) {
  const session = new Session(cfg);
  const list = listWallets();
  let name = cfg.activeWallet && list.find((w) => w.name === cfg.activeWallet) ? cfg.activeWallet : "";
  if (!name && list.length) {
    name = await choose("Which wallet?", list.map((w) => ({ name: `${w.name}  ${col("grey", w.pubkey)}`, value: w.name })));
  }
  if (!name) {
    const how = await choose("No wallet stored yet. What do you want to do?", [
      { name: "Import an existing private key", value: "import" },
      { name: "Create a new wallet", value: "new" },
    ]);
    const r = how === "import" ? await importWallet(cfg) : await generateWallet(cfg);
    if (!r) return null;
    session.name = r.name; session.keypair = r.keypair;
    return session;
  }
  session.name = name;
  session.keypair = await unlockWallet(name);
  if (cfg.activeWallet !== name) { cfg.activeWallet = name; saveConfig(cfg); }
  return session;
}

export async function requestAirdrop(session) {
  if (session.cluster !== "devnet") { warn("Airdrops only exist on devnet"); return; }
  step(1, "Requesting 1 SOL devnet airdrop");
  try {
    const sig = await session.connection.requestAirdrop(session.pubkey, 1 * LAMPORTS_PER_SOL);
    await session.connection.confirmTransaction(sig, "confirmed");
    ok("Airdrop landed");
  } catch (e) { fail(`Airdrop failed (devnet faucet is often rate-limited): ${e.message}`); }
}
