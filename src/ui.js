// Console helpers shared by every AlbuSOL module.
import { input, select, confirm, password, number } from "@inquirer/prompts";

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m",
  red: "\x1b[31m", grey: "\x1b[90m", blue: "\x1b[34m", magenta: "\x1b[35m",
};
export const col = (c, s) => `${C[c]}${s}${C.reset}`;

export const header = (s) =>
  console.log(`\n${C.bold}${C.cyan}${"═".repeat(60)}\n  ${s}\n${"═".repeat(60)}${C.reset}`);
export const step = (n, s) => console.log(`\n${col("bold", col("blue", `[${n}]`))} ${col("bold", s)}`);
export const info = (k, v) => console.log(`    ${col("grey", String(k).padEnd(22))} ${col("yellow", String(v))}`);
export const ok   = (s) => console.log(`    ${col("green", "✓")} ${s}`);
export const warn = (s) => console.log(`    ${col("yellow", "!")} ${s}`);
export const fail = (s) => console.log(`    ${col("red", "✗")} ${s}`);
export const bar  = () => console.log(col("grey", "  " + "─".repeat(58)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const short = (s, n = 8) => { s = String(s); return s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s; };
export const fmtAmount = (raw, decimals, symbol = "") => {
  const s = (Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: Math.min(decimals, 9) });
  return symbol ? `${s} ${symbol}` : s;
};

// Prompt wrappers (thin, so modules read naturally).
// Scripted mode: ALBUSOL_ANSWERS=<path to JSON array> feeds answers in order
// instead of prompting — used for unattended runs and the devnet smoke test.
import { readFileSync } from "fs";
const scripted = process.env.ALBUSOL_ANSWERS ? JSON.parse(readFileSync(process.env.ALBUSOL_ANSWERS, "utf8")) : null;
function next(message) {
  if (!scripted.length) throw new Error(`Scripted answers exhausted at prompt: ${message}`);
  const a = scripted.shift();
  console.log(`    ${col("grey", "?")} ${message} ${col("cyan", String(typeof a === "string" && a.length > 40 ? a.slice(0, 12) + "…" : a))}`);
  return a;
}
export const ask      = (message, opts = {}) => scripted ? Promise.resolve(String(next(message) ?? opts.default ?? "")) : input({ message, ...opts });
export const askNum   = (message, opts = {}) => scripted ? Promise.resolve(Number(next(message) ?? opts.default)) : number({ message, required: true, ...opts });
export const askPass  = (message, opts = {}) => {
  if (!scripted) return password({ message, mask: "•", ...opts });
  if (!scripted.length) throw new Error(`Scripted answers exhausted at prompt: ${message}`);
  console.log(`    ${col("grey", "?")} ${message} ${col("cyan", "••••••")}`);   // never echo secrets
  return Promise.resolve(String(scripted.shift()));
};
export const askYes   = (message, def = false) => scripted ? Promise.resolve(Boolean(next(message))) : confirm({ message, default: def });
export const choose   = (message, choices, opts = {}) => {
  if (!scripted) return select({ message, choices, pageSize: 14, ...opts });
  const want = next(message);
  const hit = choices.find((c) => c.value === want) || choices.find((c) => typeof want === "string" && c.name.toLowerCase().includes(want.toLowerCase()));
  if (!hit) throw new Error(`Scripted choice "${want}" not among: ${choices.map((c) => c.value).join(", ")}`);
  return Promise.resolve(hit.value);
};

export const explorerTx   = (sig, cluster) => `https://solscan.io/tx/${sig}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
export const explorerAddr = (addr, cluster) => `https://solscan.io/account/${addr}${cluster === "devnet" ? "?cluster=devnet" : ""}`;

export function printTx(sig, cluster, label = "Transaction") {
  ok(`${label}: ${col("cyan", explorerTx(sig, cluster))}`);
}

export function printError(e) {
  let msg = e?.message || (typeof e === "object" ? JSON.stringify(e, (k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 600) : String(e));
  if (/insufficient lamports|insufficient funds|0x1\b/.test(msg)) msg += "  — not enough SOL / tokens in the wallet for this amount";
  fail(msg);
  const logs = e?.logs || e?.transactionLogs || e?.cause?.logs;
  if (Array.isArray(logs) && logs.length) {
    console.log(col("grey", "\n    Program logs (last 12):"));
    logs.slice(-12).forEach((l) => console.log(col("grey", "    " + l)));
  }
}

// Validators for inquirer prompts.
export const vPubkey = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s).trim()) || "Not a valid Solana address";
export const vPositive = (v) => (Number(v) > 0) || "Must be greater than zero";
export const vNonEmpty = (s) => String(s).trim().length > 0 || "Required";
