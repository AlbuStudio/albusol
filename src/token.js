// Create an SPL token with Metaplex metadata, mint supply, optionally
// revoke authorities so the token is provably fixed-supply and unfreezable.
import { generateSigner, percentAmount, some, none, publicKey as umiPk } from "@metaplex-foundation/umi";
import { createFungible, mintV1, updateV1, TokenStandard } from "@metaplex-foundation/mpl-token-metadata";
import { setAuthority, AuthorityType, getMint } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { getUmi, umiSig } from "./umi.js";
import { ensurePinata, pinFile, pinJson, mimeOf } from "./upload.js";
import { toRaw } from "./raydium.js";
import { existsSync } from "fs";
import { feeLine, chargeFee } from "./fee.js";
import { header, step, info, ok, warn, fail, ask, askNum, askYes, choose, col, printTx, printError, explorerAddr, vNonEmpty, vPositive, vPubkey, bar } from "./ui.js";

export async function metadataUriFlow(session, { name, symbol, description, kind }) {
  // Returns a hosted metadata JSON URI. Either the user already has one or we build+pin it.
  const how = await choose("Metadata JSON:", [
    { name: "Build it and upload to IPFS via Pinata (image + JSON)", value: "pinata" },
    { name: "I already have a hosted metadata URI", value: "uri" },
    { name: "No metadata URI (empty — you can update later)", value: "none" },
  ]);
  if (how === "none") return "";
  if (how === "uri") return (await ask("Metadata URI (https://… or ipfs://…):", { validate: vNonEmpty })).trim();
  if (!(await ensurePinata(session.cfg))) return (await ask("Metadata URI (https://… or ipfs://…):", { validate: vNonEmpty })).trim();

  const imgPath = (await ask("Path to logo/image file (or empty to skip):")).trim().replace(/^~/, process.env.HOME);
  let image = "";
  if (imgPath) {
    if (!existsSync(imgPath)) throw new Error(`File not found: ${imgPath}`);
    image = await pinFile(session.cfg, imgPath, `${name} image`);
  }
  const external_url = (await ask("Website (optional):")).trim();
  const json = { name, symbol, description, image, external_url };
  if (kind === "token") {
    json.extensions = {};
    const tw = (await ask("Twitter/X URL (optional):")).trim(); if (tw) json.extensions.twitter = tw;
    const tg = (await ask("Telegram URL (optional):")).trim(); if (tg) json.extensions.telegram = tg;
  }
  if (image) json.properties = { files: [{ uri: image, type: mimeOf(imgPath) }], category: "image" };
  return pinJson(session.cfg, json, `${name} metadata`);
}

export async function createToken(session) {
  header("Create token (SPL + Metaplex metadata)");
  await session.printStatus();

  step(1, "Token details");
  const name = (await ask("Name:", { validate: (s) => (s.trim().length > 0 && s.length <= 32) || "1–32 characters" })).trim();
  const symbol = (await ask("Symbol:", { validate: (s) => (s.trim().length > 0 && s.length <= 10) || "1–10 characters" })).trim().toUpperCase();
  const decimals = await askNum("Decimals:", { default: 6, min: 0, max: 9 });
  const supplyHuman = (await ask("Total supply to mint (e.g. 1000000000):", { validate: (s) => /^\d+(\.\d+)?$/.test(s.trim()) && Number(s) > 0 || "Enter a number" })).trim();
  const description = (await ask("Description:", { default: `${name} (${symbol}) on Solana` })).trim();

  step(2, "Metadata");
  const uri = await metadataUriFlow(session, { name, symbol, description, kind: "token" });

  step(3, "Authorities");
  const revokeMint = await askYes("Revoke MINT authority after minting? (fixed supply forever)", true);
  const revokeFreeze = await askYes("Revoke FREEZE authority? (nobody can freeze holders)", true);
  const makeImmutable = await askYes("Make metadata immutable? (name/symbol/URI can never change)", false);

  bar();
  info("Name / symbol", `${name} / ${symbol}`);
  info("Decimals", decimals);
  info("Supply", supplyHuman);
  info("Metadata URI", uri || "(none)");
  info("Revoke mint", revokeMint ? "yes" : "no");
  info("Revoke freeze", revokeFreeze ? "yes" : "no");
  info("Immutable", makeImmutable ? "yes" : "no");
  feeLine("token");
  warn("Network cost ≈ 0.02 SOL rent + fees.");
  if (!(await askYes("Create this token now?"))) { warn("Cancelled"); return; }

  const umi = getUmi(session);
  const mint = generateSigner(umi);
  const amount = toRaw(supplyHuman, decimals);

  step(4, "Creating mint + metadata");
  let r = await createFungible(umi, {
    mint,
    name, symbol, uri,
    sellerFeeBasisPoints: percentAmount(0),
    decimals: some(decimals),
    isMutable: true,                     // flipped below if requested, after mint
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  printTx(umiSig(r.signature), session.cluster, "Mint created");
  const mintPk = new PublicKey(mint.publicKey.toString());
  info("Mint address", col("cyan", mintPk.toBase58()));

  step(5, `Minting ${supplyHuman} ${symbol}`);
  r = await mintV1(umi, {
    mint: mint.publicKey,
    amount,
    tokenOwner: umi.identity.publicKey,
    tokenStandard: TokenStandard.Fungible,
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  printTx(umiSig(r.signature), session.cluster, "Supply minted");

  if (revokeMint) {
    step(6, "Revoking mint authority");
    try {
      const sig = await setAuthority(session.connection, session.keypair, mintPk, session.keypair, AuthorityType.MintTokens, null);
      printTx(sig, session.cluster, "Mint authority revoked");
    } catch (e) { printError(e); }
  }
  if (revokeFreeze) {
    step(7, "Revoking freeze authority");
    try {
      const sig = await setAuthority(session.connection, session.keypair, mintPk, session.keypair, AuthorityType.FreezeAccount, null);
      printTx(sig, session.cluster, "Freeze authority revoked");
    } catch (e) { printError(e); }
  }
  if (makeImmutable) {
    step(8, "Locking metadata");
    try {
      r = await updateV1(umi, { mint: mint.publicKey, isMutable: false }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
      printTx(umiSig(r.signature), session.cluster, "Metadata locked");
    } catch (e) { printError(e); }
  }

  await chargeFee(session, "token");
  bar();
  const m = await getMint(session.connection, mintPk);
  ok(`${col("bold", "Token ready")}  ${col("cyan", mintPk.toBase58())}`);
  info("Supply on chain", (Number(m.supply) / 10 ** decimals).toLocaleString("en-US"));
  info("Mint authority", m.mintAuthority ? m.mintAuthority.toBase58() : "revoked");
  info("Freeze authority", m.freezeAuthority ? m.freezeAuthority.toBase58() : "revoked");
  info("Explorer", explorerAddr(mintPk.toBase58(), session.cluster));
  return mintPk.toBase58();
}

export async function revokeAuthorities(session) {
  header("Revoke token authorities");
  const mintStr = (await ask("Token mint address:", { validate: vPubkey })).trim();
  const mintPk = new PublicKey(mintStr);
  const m = await getMint(session.connection, mintPk);
  info("Mint authority", m.mintAuthority ? m.mintAuthority.toBase58() : "already revoked");
  info("Freeze authority", m.freezeAuthority ? m.freezeAuthority.toBase58() : "already revoked");
  const me = session.pubkey.toBase58();
  if (m.mintAuthority?.toBase58() === me && (await askYes("Revoke MINT authority (irreversible)?"))) {
    const sig = await setAuthority(session.connection, session.keypair, mintPk, session.keypair, AuthorityType.MintTokens, null);
    printTx(sig, session.cluster, "Mint authority revoked");
  }
  if (m.freezeAuthority?.toBase58() === me && (await askYes("Revoke FREEZE authority (irreversible)?"))) {
    const sig = await setAuthority(session.connection, session.keypair, mintPk, session.keypair, AuthorityType.FreezeAccount, null);
    printTx(sig, session.cluster, "Freeze authority revoked");
  }
  if (await askYes("Make metadata immutable (irreversible)?", false)) {
    try {
      const umi = getUmi(session);
      const r = await updateV1(umi, { mint: umiPk(mintStr), isMutable: false }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
      printTx(umiSig(r.signature), session.cluster, "Metadata locked");
    } catch (e) { printError(e); }
  }
}
