// Metaplex Core NFTs: create a collection, mint one asset, or batch-mint a folder.
import { generateSigner, publicKey as umiPk } from "@metaplex-foundation/umi";
import { create, createCollection, fetchCollection, ruleSet } from "@metaplex-foundation/mpl-core";
import { readdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, extname, parse } from "path";
import { getUmi, umiSig } from "./umi.js";
import { feeLine, chargeFee } from "./fee.js";
import { ensurePinata, pinFile, pinJson, mimeOf } from "./upload.js";
import { header, step, info, ok, warn, fail, ask, askNum, askYes, choose, col, printTx, printError, explorerAddr, vNonEmpty, vPubkey, bar, sleep } from "./ui.js";

const IMG_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const safeName = (s) => (s.length <= 32 ? s : s.slice(0, 32));
const expandHome = (p) => String(p).trim().replace(/^~/, process.env.HOME);

function royaltiesPlugin(umi, bps) {
  return bps > 0 ? [{ type: "Royalties", basisPoints: bps, creators: [{ address: umi.identity.publicKey, percentage: 100 }], ruleSet: ruleSet("None") }] : [];
}

async function assetMetadataUri(session, { name, description, imagePath, imageUrl, attributes = [], external_url = "", symbol = "" }) {
  let image = imageUrl || "";
  if (imagePath) image = await pinFile(session.cfg, imagePath, `${name} image`);
  const json = { name, symbol, description, image, external_url, attributes };
  if (image) json.properties = { files: [{ uri: image, type: imagePath ? mimeOf(imagePath) : "image/png" }], category: "image" };
  return pinJson(session.cfg, json, `${name} metadata`);
}

async function uriFlow(session, fields) {
  const how = await choose("Metadata:", [
    { name: "Upload image + JSON to IPFS via Pinata", value: "pinata" },
    { name: "I already have a hosted metadata URI", value: "uri" },
  ]);
  if (how === "uri" || !(await ensurePinata(session.cfg))) return (await ask("Metadata URI:", { validate: vNonEmpty })).trim();
  const imagePath = expandHome(await ask("Path to image file:", { validate: vNonEmpty }));
  if (!existsSync(imagePath)) throw new Error(`File not found: ${imagePath}`);
  return assetMetadataUri(session, { ...fields, imagePath });
}

export async function createNftCollection(session) {
  header("Create Core collection");
  await session.printStatus();
  const name = (await ask("Collection name:", { validate: vNonEmpty })).trim();
  const description = (await ask("Description:", { default: name })).trim();
  const external_url = (await ask("Website (optional):")).trim();
  const royaltyBps = await askNum("Royalty % on secondary sales:", { default: 5, min: 0, max: 50 }) * 100;
  const uri = await uriFlow(session, { name, description, external_url });
  feeLine("collection");
  if (!(await askYes("Create the collection now?"))) { warn("Cancelled"); return; }
  try {
    const umi = getUmi(session);
    const collection = generateSigner(umi);
    const r = await createCollection(umi, { collection, name: safeName(name), uri, plugins: royaltiesPlugin(umi, royaltyBps) })
      .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    printTx(umiSig(r.signature), session.cluster, "Collection created");
    await chargeFee(session, "collection");
    ok(`${col("bold", "Collection")}  ${col("cyan", collection.publicKey.toString())}`);
    info("Explorer", explorerAddr(collection.publicKey.toString(), session.cluster));
    return collection.publicKey.toString();
  } catch (e) { printError(e); }
}

async function pickCollection(session, umi) {
  if (!(await askYes("Put it in a collection?", true))) return null;
  const addr = (await ask("Collection address:", { validate: vPubkey })).trim();
  return fetchCollection(umi, umiPk(addr));
}

export async function mintNft(session) {
  header("Mint one Core NFT");
  await session.printStatus();
  const umi = getUmi(session);
  const name = (await ask("NFT name:", { validate: vNonEmpty })).trim();
  const description = (await ask("Description:", { default: name })).trim();
  const uri = await uriFlow(session, { name, description });
  const collection = await pickCollection(session, umi);
  const owner = (await ask("Send to address (empty = my wallet):")).trim();
  const royaltyBps = collection ? 0 : (await askNum("Royalty % (collection-less asset):", { default: 0, min: 0, max: 50 })) * 100;
  feeLine("nft");
  if (!(await askYes("Mint now?"))) { warn("Cancelled"); return; }
  try {
    const asset = generateSigner(umi);
    const args = { asset, name: safeName(name), uri, plugins: royaltiesPlugin(umi, royaltyBps) };
    if (collection) args.collection = collection;
    if (owner) args.owner = umiPk(owner);
    const r = await create(umi, args).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    printTx(umiSig(r.signature), session.cluster, "Minted");
    await chargeFee(session, "nft");
    ok(`${col("bold", "Asset")}  ${col("cyan", asset.publicKey.toString())}`);
    info("Explorer", explorerAddr(asset.publicKey.toString(), session.cluster));
  } catch (e) { printError(e); }
}

export async function batchMint(session) {
  header("Batch-mint a folder of images (resumable)");
  await session.printStatus();
  if (!(await ensurePinata(session.cfg))) { fail("Batch minting needs Pinata for hosting"); return; }
  const umi = getUmi(session);

  step(1, "Source");
  const dir = expandHome(await ask("Folder with images (1.png, 2.png … or any names):", { validate: vNonEmpty }));
  if (!existsSync(dir)) { fail("Folder not found"); return; }
  const files = readdirSync(dir).filter((f) => IMG_EXTS.has(extname(f).toLowerCase()))
    .sort((a, b) => { const na = parseInt(parse(a).name, 10), nb = parseInt(parse(b).name, 10); return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b); });
  if (!files.length) { fail("No images in that folder"); return; }
  info("Images", files.length);
  const logFile = join(dir, "albusol-mint-log.json");
  const log = existsSync(logFile) ? JSON.parse(readFileSync(logFile, "utf8")) : { collection: null, assets: {} };
  const save = () => writeFileSync(logFile, JSON.stringify(log, null, 2));
  const done = Object.keys(log.assets).length;
  if (done) warn(`Resuming: ${done} already minted (log: ${logFile})`);

  step(2, "Collection + naming");
  const prefix = (await ask("Name prefix (asset = prefix + ' #' + number):", { default: "Item" })).trim();
  const description = (await ask("Description for every asset:", { default: `${prefix} collection` })).trim();
  const external_url = (await ask("Website (optional):")).trim();
  let collection = null;
  if (log.collection) {
    info("Collection (from log)", log.collection);
    collection = await fetchCollection(umi, umiPk(log.collection));
  } else {
    const how = await choose("Collection:", [
      { name: "Create a new one now (uses the first image as cover)", value: "new" },
      { name: "Use an existing collection address", value: "existing" },
      { name: "No collection", value: "none" },
    ]);
    if (how === "existing") {
      log.collection = (await ask("Collection address:", { validate: vPubkey })).trim();
      collection = await fetchCollection(umi, umiPk(log.collection)); save();
    } else if (how === "new") {
      const cname = (await ask("Collection name:", { default: prefix })).trim();
      const royaltyBps = (await askNum("Royalty %:", { default: 5, min: 0, max: 50 })) * 100;
      const uri = await assetMetadataUri(session, { name: cname, description, imagePath: join(dir, files[0]), external_url });
      const signer = generateSigner(umi);
      const r = await createCollection(umi, { collection: signer, name: safeName(cname), uri, plugins: royaltiesPlugin(umi, royaltyBps) })
        .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
      printTx(umiSig(r.signature), session.cluster, "Collection created");
      log.collection = signer.publicKey.toString(); save();
      collection = await fetchCollection(umi, umiPk(log.collection));
      ok(`Collection ${col("cyan", log.collection)}`);
    }
  }
  const delayMs = await askNum("Delay between mints (ms):", { default: 1200, min: 0 });

  bar();
  info("To mint", files.length - done);
  feeLine("nftBatch", files.length - done);
  warn(`Network cost ≈ 0.003 SOL per asset + Pinata storage.`);
  if (!(await askYes("Start minting?"))) { warn("Cancelled"); return; }

  step(3, "Minting");
  let minted = 0, failed = 0;
  for (const [i, file] of files.entries()) {
    if (log.assets[file]) continue;
    const n = parseInt(parse(file).name, 10);
    const name = safeName(`${prefix} #${isNaN(n) ? i + 1 : n}`);
    console.log(`\n  ${col("blue", `► ${i + 1}/${files.length}`)} ${col("bold", name)}`);
    try {
      const uri = await assetMetadataUri(session, { name, description, imagePath: join(dir, file), external_url, attributes: [{ trait_type: "Edition", value: `#${isNaN(n) ? i + 1 : n}` }] });
      const asset = generateSigner(umi);
      const args = { asset, name, uri };
      if (collection) args.collection = collection;
      await create(umi, args).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
      log.assets[file] = { name, asset: asset.publicKey.toString(), uri, mintedAt: new Date().toISOString() };
      save(); minted++;
      ok(`${col("cyan", asset.publicKey.toString())}`);
    } catch (e) { failed++; printError(e); }
    if (delayMs) await sleep(delayMs);
  }
  if (minted) await chargeFee(session, "nftBatch", minted);
  bar();
  info("Minted now", minted);
  info("Failed", failed + (failed ? "  (re-run to retry)" : ""));
  info("Total in log", Object.keys(log.assets).length);
  if (log.collection) info("Collection", explorerAddr(log.collection, session.cluster));
}
