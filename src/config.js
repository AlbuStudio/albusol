// Persistent settings in ~/.albusol/config.json. Nothing secret lives here
// except an optional Pinata JWT, which the user chooses to store.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const HOME_DIR = process.env.ALBUSOL_HOME || join(homedir(), ".albusol");
const CONFIG_FILE = join(HOME_DIR, "config.json");

export const DEFAULT_RPC = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet:  "https://api.devnet.solana.com",
};

const DEFAULTS = {
  network: "mainnet",            // "mainnet" | "devnet"
  rpc: { mainnet: "", devnet: "" }, // empty = public default
  priorityFeeMicroLamports: 20_000, // per compute unit
  pinataJwt: "",
  activeWallet: "",
};

export function loadConfig() {
  if (!existsSync(HOME_DIR)) mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try {
    const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return { ...DEFAULTS, ...saved, rpc: { ...DEFAULTS.rpc, ...(saved.rpc || {}) } };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg) {
  if (!existsSync(HOME_DIR)) mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function rpcUrl(cfg) {
  return cfg.rpc?.[cfg.network] || DEFAULT_RPC[cfg.network];
}

export const clusterOf = (cfg) => (cfg.network === "devnet" ? "devnet" : "mainnet");
