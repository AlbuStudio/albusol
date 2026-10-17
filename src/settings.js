// Settings menu: network, RPC, priority fee, Pinata.
import { Connection } from "@solana/web3.js";
import { loadConfig, saveConfig, rpcUrl, DEFAULT_RPC } from "./config.js";
import { header, info, ok, warn, ask, askNum, choose, col } from "./ui.js";

export async function settingsMenu(session) {
  const cfg = session.cfg;
  while (true) {
    header("Settings");
    info("Network", cfg.network);
    info("RPC", rpcUrl(cfg) + (cfg.rpc[cfg.network] ? "" : col("grey", "  (public default)")));
    info("Priority fee", `${cfg.priorityFeeMicroLamports} µLamports / CU`);
    info("Pinata", cfg.pinataJwt ? "configured" : "not set");
    const a = await choose("Change:", [
      { name: "Network (mainnet / devnet)", value: "net" },
      { name: "RPC endpoint for this network", value: "rpc" },
      { name: "Priority fee", value: "fee" },
      { name: "Pinata JWT", value: "pinata" },
      { name: "Back", value: "back" },
    ]);
    if (a === "back") return;
    if (a === "net") {
      cfg.network = await choose("Network:", [{ name: "mainnet", value: "mainnet" }, { name: "devnet", value: "devnet" }]);
      session.resetConnection();
    } else if (a === "rpc") {
      const url = (await ask(`RPC URL for ${cfg.network} (empty = ${DEFAULT_RPC[cfg.network]}):`, { default: cfg.rpc[cfg.network] })).trim();
      if (url) {
        try { const slot = await new Connection(url).getSlot(); ok(`Reachable, slot ${slot}`); }
        catch (e) { warn(`Could not reach it: ${e.message}`); }
      }
      cfg.rpc[cfg.network] = url;
      session.resetConnection();
    } else if (a === "fee") {
      cfg.priorityFeeMicroLamports = await askNum("µLamports per compute unit (0 = none, 20000 = normal, 200000 = busy network):", { default: cfg.priorityFeeMicroLamports, min: 0 });
    } else if (a === "pinata") {
      const jwt = (await ask("Pinata JWT (empty to clear):")).trim();
      if (jwt) {
        const res = await fetch("https://api.pinata.cloud/data/testAuthentication", { headers: { Authorization: `Bearer ${jwt}` } });
        if (!res.ok) { warn(`Pinata rejected the token (${res.status}); not saved`); continue; }
        ok("Pinata authenticated");
      }
      cfg.pinataJwt = jwt;
    }
    saveConfig(cfg);
    ok("Saved");
  }
}
