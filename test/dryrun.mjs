// Dev check: builds every transaction type against devnet WITHOUT sending.
// Run: ALBUSOL_HOME=/tmp/albusol-dry node test/dryrun.mjs   (pool builds need a funded wallet with token accounts)
import { Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { NATIVE_MINT, createBurnCheckedInstruction, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { generateSigner, percentAmount, some } from "@metaplex-foundation/umi";
import { createFungible, mintV1, TokenStandard } from "@metaplex-foundation/mpl-token-metadata";
import { create, createCollection, ruleSet } from "@metaplex-foundation/mpl-core";
import { Session } from "../src/wallet.js";
import { loadConfig } from "../src/config.js";
import { getRaydium, programs, computeBudget, mintInfo, cpmmFeeConfigs, TxVersion } from "../src/raydium.js";
import { getUmi } from "../src/umi.js";

const cfg = loadConfig(); cfg.network = "devnet";
const s = new Session(cfg); s.name = "dry"; s.keypair = Keypair.generate();
const conn = s.connection;
const USDC_DEV = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const res = {};
const t = async (name, fn) => { try { res[name] = await fn(); console.log("OK  ", name, res[name]); } catch (e) { console.log("FAIL", name, e.message.slice(0, 300)); } };

await t("mintInfo USDC", async () => { const m = await mintInfo(conn, USDC_DEV); return `${m.decimals} dp`; });
const raydium = await getRaydium(s); const P = programs(s);
const base = await mintInfo(conn, USDC_DEV), quote = await mintInfo(conn, NATIVE_MINT.toBase58());

await t("market build", async () => {
  const b = await raydium.marketV2.create({ baseInfo: { mint: base.mint, decimals: base.decimals }, quoteInfo: { mint: quote.mint, decimals: quote.decimals }, lotSize: 1, tickSize: 0.0001, dexProgramId: P.OPEN_BOOK_PROGRAM, lowestFeeMarket: true, txVersion: TxVersion.V0, computeBudgetConfig: computeBudget(s, 400_000) });
  return `${b.transactions.length} txs, market ${b.extInfo.address.marketId.toBase58().slice(0,8)}`;
});
await t("cpmm configs", async () => { const c = await cpmmFeeConfigs(s, raydium); return `${c.length} tiers, first id ${c[0].id.slice(0,8)} fee ${c[0].tradeFeeRate}`; });
await t("cpmm pool build", async () => {
  const configs = await cpmmFeeConfigs(s, raydium);
  const b = await raydium.cpmm.createPool({ programId: P.CREATE_CPMM_POOL_PROGRAM, poolFeeAccount: P.CREATE_CPMM_POOL_FEE_ACC,
    mintA: { address: base.mint.toBase58(), decimals: base.decimals, programId: base.programId.toBase58() },
    mintB: { address: quote.mint.toBase58(), decimals: quote.decimals, programId: quote.programId.toBase58() },
    mintAAmount: new BN(1_000_000), mintBAmount: new BN(10_000_000), startTime: new BN(0), feeConfig: configs[0], associatedOnly: false, ownerInfo: { useSOLBalance: true }, txVersion: TxVersion.V0, computeBudgetConfig: computeBudget(s) });
  return `pool ${b.extInfo.address.poolId.toBase58().slice(0,8)} lp ${b.extInfo.address.lpMint.toBase58().slice(0,8)} ixs ${b.builder.allInstructions.length}`;
});
await t("ammv4 pool build (fake market id → expect SDK to fetch and fail cleanly)", async () => {
  const b = await raydium.liquidity.createPoolV4({ programId: P.AMM_V4, marketInfo: { marketId: Keypair.generate().publicKey, programId: P.OPEN_BOOK_PROGRAM }, baseMintInfo: { mint: base.mint, decimals: base.decimals }, quoteMintInfo: { mint: quote.mint, decimals: quote.decimals }, baseAmount: new BN(1_000_000), quoteAmount: new BN(10_000_000), startTime: new BN(0), ownerInfo: { useSOLBalance: true }, associatedOnly: false, checkCreateATAOwner: true, feeDestinationId: P.FEE_DESTINATION_ID, txVersion: TxVersion.V0, computeBudgetConfig: computeBudget(s) });
  return `amm ${b.extInfo.address.ammId.toBase58().slice(0,8)} lp ${b.extInfo.address.lpMint.toBase58().slice(0,8)}`;
});
const umi = getUmi(s);
await t("token create build", async () => {
  const mint = generateSigner(umi);
  const tx = await createFungible(umi, { mint, name: "Dry", symbol: "DRY", uri: "", sellerFeeBasisPoints: percentAmount(0), decimals: some(6), isMutable: true }).buildWithLatestBlockhash(umi);
  const tx2 = await mintV1(umi, { mint: mint.publicKey, amount: 1000n, tokenOwner: umi.identity.publicKey, tokenStandard: TokenStandard.Fungible }).buildWithLatestBlockhash(umi);
  return `create ${tx.message.instructions.length} ixs, mint ${tx2.message.instructions.length} ixs`;
});
await t("nft collection+asset build", async () => {
  const c = generateSigner(umi);
  const tx = await createCollection(umi, { collection: c, name: "Dry", uri: "https://x/y.json", plugins: [{ type: "Royalties", basisPoints: 500, creators: [{ address: umi.identity.publicKey, percentage: 100 }], ruleSet: ruleSet("None") }] }).buildWithLatestBlockhash(umi);
  const a = generateSigner(umi);
  const tx2 = await create(umi, { asset: a, name: "Dry #1", uri: "https://x/1.json" }).buildWithLatestBlockhash(umi);
  return `collection ${tx.message.instructions.length} ixs, asset ${tx2.message.instructions.length} ixs`;
});
await t("burn build", async () => {
  const ata = getAssociatedTokenAddressSync(base.mint, s.pubkey);
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), createBurnCheckedInstruction(ata, base.mint, s.pubkey, 1n, 6, [], TOKEN_PROGRAM_ID));
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.feePayer = s.pubkey; tx.sign(s.keypair);
  return `${tx.instructions.length} ixs, ${tx.serialize().length} bytes`;
});
process.exit(0);
