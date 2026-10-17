#!/usr/bin/env node
// AlbuSOL — local Solana launch desk.
import { installRetryFetch } from "../src/net.js";
installRetryFetch();
import { loadConfig, saveConfig } from "../src/config.js";
import { connectSession, importWallet, generateWallet, exportWallet, deleteWallet, listWallets, requestAirdrop } from "../src/wallet.js";
import { createToken, revokeAuthorities } from "../src/token.js";
import { createMarket } from "../src/market.js";
import { createAmmV4Pool, createCpmmPool, addLiquidity } from "../src/liquidity.js";
import { burnTokens } from "../src/burn.js";
import { createNftCollection, mintNft, batchMint } from "../src/nft.js";
import { settingsMenu } from "../src/settings.js";
import { header, choose, col, info, warn, fail, printError } from "../src/ui.js";

const BANNER = `
   █████╗ ██╗     ██████╗ ██╗   ██╗███████╗ ██████╗ ██╗
  ██╔══██╗██║     ██╔══██╗██║   ██║██╔════╝██╔═══██╗██║
  ███████║██║     ██████╔╝██║   ██║███████╗██║   ██║██║
  ██╔══██║██║     ██╔══██╗██║   ██║╚════██║██║   ██║██║
  ██║  ██║███████╗██████╔╝╚██████╔╝███████║╚██████╔╝███████╗
  ╚═╝  ╚═╝╚══════╝╚═════╝  ╚═════╝ ╚══════╝ ╚═════╝ ╚══════╝
  Solana launch desk · token · market · liquidity · LP burn · NFTs`;

async function walletMenu(session) {
  while (true) {
    header("Wallet");
    await session.printStatus();
    const a = await choose("Wallet:", [
      { name: "Switch wallet", value: "switch" },
      { name: "Import another private key", value: "import" },
      { name: "Create a new wallet", value: "new" },
      { name: "Export private key", value: "export" },
      { name: "Delete a stored wallet", value: "delete" },
      ...(session.cluster === "devnet" ? [{ name: "Request devnet airdrop", value: "airdrop" }] : []),
      { name: "Back", value: "back" },
    ]);
    if (a === "back") return session;
    if (a === "switch") {
      const list = listWallets();
      const name = await choose("Wallet:", list.map((w) => ({ name: `${w.name}  ${col("grey", w.pubkey)}`, value: w.name })));
      session.cfg.activeWallet = name; saveConfig(session.cfg);
      const s = await connectSession(session.cfg); if (s) session = s;
    } else if (a === "import") {
      const r = await importWallet(session.cfg); if (r) { session.name = r.name; session.keypair = r.keypair; }
    } else if (a === "new") {
      const r = await generateWallet(session.cfg); if (r) { session.name = r.name; session.keypair = r.keypair; }
    } else if (a === "export") await exportWallet(session.keypair);
    else if (a === "delete") await deleteWallet(session.cfg);
    else if (a === "airdrop") await requestAirdrop(session);
  }
}

async function main() {
  console.log(col("cyan", BANNER));
  const cfg = loadConfig();
  let session = await connectSession(cfg);
  if (!session) { fail("No wallet — exiting"); process.exit(1); }

  while (true) {
    header(`AlbuSOL  ·  ${session.cfg.network}  ·  ${session.name} ${col("grey", session.pubkey.toBase58())}`);
    const a = await choose("What do you want to do?", [
      { name: "Create token            SPL mint + metadata, revoke authorities", value: "token" },
      { name: "Create OpenBook market  required for an AMM v4 pool", value: "market" },
      { name: "Create pool · AMM v4    from an OpenBook market", value: "ammv4" },
      { name: "Create pool · CPMM      no market needed", value: "cpmm" },
      { name: "Add liquidity           to an existing Raydium pool", value: "addliq" },
      { name: "Burn LP / tokens        lock liquidity permanently", value: "burn" },
      { name: "NFT · create collection", value: "nftcol" },
      { name: "NFT · mint one", value: "nft" },
      { name: "NFT · batch-mint folder", value: "nftbatch" },
      { name: "Revoke token authorities (existing token)", value: "revoke" },
      { name: "Wallet", value: "wallet" },
      { name: "Settings                network / RPC / fees / Pinata", value: "settings" },
      { name: "Quit", value: "quit" },
    ]);
    try {
      switch (a) {
        case "token": await createToken(session); break;
        case "market": await createMarket(session); break;
        case "ammv4": await createAmmV4Pool(session); break;
        case "cpmm": await createCpmmPool(session); break;
        case "addliq": await addLiquidity(session); break;
        case "burn": await burnTokens(session); break;
        case "nftcol": await createNftCollection(session); break;
        case "nft": await mintNft(session); break;
        case "nftbatch": await batchMint(session); break;
        case "revoke": await revokeAuthorities(session); break;
        case "wallet": session = await walletMenu(session); break;
        case "settings": await settingsMenu(session); break;
        case "quit": console.log(); process.exit(0);
      }
    } catch (e) {
      if (e?.name === "ExitPromptError") { console.log(); process.exit(0); }
      printError(e);
    }
  }
}

main().catch((e) => {
  if (e?.name === "ExitPromptError") { console.log(); process.exit(0); }
  printError(e); process.exit(1);
});
