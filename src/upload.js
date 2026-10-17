// Metadata hosting through Pinata (IPFS). Optional — every flow also accepts a
// ready URI if the user hosts metadata elsewhere.
import { readFileSync, statSync } from "fs";
import { basename, extname } from "path";
import { ask, askYes, ok, warn, col } from "./ui.js";
import { saveConfig } from "./config.js";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".mp4": "video/mp4" };
export const mimeOf = (file) => MIME[extname(file).toLowerCase()] || "application/octet-stream";
export const gateway = (cid) => `https://gateway.pinata.cloud/ipfs/${cid}`;

export async function ensurePinata(cfg) {
  if (cfg.pinataJwt) return true;
  warn("No Pinata JWT configured (Settings → Pinata). Without it you must supply a hosted metadata URI.");
  if (!(await askYes("Enter a Pinata JWT now?"))) return false;
  const jwt = (await ask("Pinata JWT:")).trim();
  if (!jwt) return false;
  const res = await fetch("https://api.pinata.cloud/data/testAuthentication", { headers: { Authorization: `Bearer ${jwt}` } });
  if (!res.ok) { warn(`Pinata rejected the token (${res.status})`); return false; }
  cfg.pinataJwt = jwt; saveConfig(cfg);
  ok("Pinata token saved");
  return true;
}

export async function pinFile(cfg, filePath, name = basename(filePath)) {
  const size = statSync(filePath).size;
  const form = new FormData();
  form.append("file", new Blob([readFileSync(filePath)], { type: mimeOf(filePath) }), basename(filePath));
  form.append("pinataMetadata", JSON.stringify({ name }));
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: { Authorization: `Bearer ${cfg.pinataJwt}` }, body: form });
  if (!res.ok) throw new Error(`Pinata file upload failed: ${res.status} ${await res.text()}`);
  const { IpfsHash } = await res.json();
  const url = gateway(IpfsHash);
  ok(`File (${(size / 1024).toFixed(0)} KB) → ${col("cyan", url)}`);
  return url;
}

export async function pinJson(cfg, json, name) {
  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.pinataJwt}` },
    body: JSON.stringify({ pinataMetadata: { name }, pinataContent: json }),
  });
  if (!res.ok) throw new Error(`Pinata JSON upload failed: ${res.status} ${await res.text()}`);
  const { IpfsHash } = await res.json();
  const url = gateway(IpfsHash);
  ok(`Metadata → ${col("cyan", url)}`);
  return url;
}
