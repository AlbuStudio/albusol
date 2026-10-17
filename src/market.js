// OpenBook (Serum v3 fork) market creation through Raydium SDK v2.
// A market is required before a Raydium AMM v4 pool can exist. CPMM pools do not need one.
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { getRaydium, programs, computeBudget, mintInfo, executeAll, TxVersion } from "./raydium.js";
import { feeLine, chargeFee } from "./fee.js";
import { header, step, info, ok, warn, ask, askYes, choose, col, printError, explorerAddr, vPubkey, bar, fmtAmount } from "./ui.js";

const QUOTE_PRESETS = (cluster) => [
  { name: "SOL (wrapped)", value: NATIVE_MINT.toBase58() },
  ...(cluster === "mainnet" ? [
    { name: "USDC  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", value: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    { name: "USDT  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", value: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
    { name: "EURC  HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr", value: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr" },
  ] : []),
  { name: "Other mint…", value: "other" },
];

export async function pickQuoteMint(session) {
  const v = await choose("Quote token:", QUOTE_PRESETS(session.cluster));
  if (v !== "other") return v;
  return (await ask("Quote mint address:", { validate: vPubkey })).trim();
}

export async function createMarket(session) {
  header("Create OpenBook market");
  await session.printStatus();
  const conn = session.connection;

  step(1, "Pair");
  const baseStr = (await ask("Base token mint (your token):", { validate: vPubkey })).trim();
  const base = await mintInfo(conn, baseStr);
  info("Base decimals", base.decimals);
  const quoteStr = await pickQuoteMint(session);
  const quote = await mintInfo(conn, quoteStr);
  info("Quote decimals", quote.decimals);

  step(2, "Market parameters");
  console.log(col("grey", "    lotSize = smallest tradable base amount; tickSize = smallest price step (in quote)."));
  console.log(col("grey", "    Typical: lotSize 1 (or 100 for very cheap tokens), tickSize 0.0001 (0.00000001 for sub-cent tokens)."));
  const lotSize = Number(await ask("Lot size (base units):", { default: "1", validate: (s) => Number(s) > 0 || "Must be > 0" }));
  const tickSize = Number(await ask("Tick size (quote units):", { default: "0.0001", validate: (s) => Number(s) > 0 || "Must be > 0" }));
  const lowestFee = await askYes("Use the smallest queue sizes (≈0.35 SOL rent instead of ≈2.8 SOL)?", true);

  bar();
  info("Base", baseStr);
  info("Quote", quoteStr);
  info("Lot / tick", `${lotSize} / ${tickSize}`);
  info("Queue config", lowestFee ? "minimum (≈0.35 SOL)" : "standard (≈2.8 SOL)");
  feeLine("market");
  warn("Creation is 2 transactions; the second cannot be simulated before the first lands — that is normal.");
  const bal = await session.balance();
  if (bal < (lowestFee ? 0.4 : 3) * 1e9) warn(`Wallet has ${fmtAmount(bal, 9, "SOL")}; this may not cover rent.`);
  if (!(await askYes("Create this market now?"))) { warn("Cancelled"); return; }

  step(3, "Building + sending");
  try {
    const raydium = await getRaydium(session);
    const P = programs(session);
    const built = await raydium.marketV2.create({
      baseInfo: { mint: base.mint, decimals: base.decimals },
      quoteInfo: { mint: quote.mint, decimals: quote.decimals },
      lotSize, tickSize,
      dexProgramId: P.OPEN_BOOK_PROGRAM,
      lowestFeeMarket: lowestFee,
      txVersion: TxVersion.V0,
      computeBudgetConfig: computeBudget(session, 400_000),
    });
    const a = built.extInfo.address;
    info("Market ID", col("cyan", a.marketId.toBase58()));
    await executeAll(session, built, "Market");
    await chargeFee(session, "market");
    bar();
    ok(`${col("bold", "Market created")}  ${col("cyan", a.marketId.toBase58())}`);
    info("Explorer", explorerAddr(a.marketId.toBase58(), session.cluster));
    info("Next", "Liquidity → Create AMM v4 pool with this market ID");
    return a.marketId.toBase58();
  } catch (e) {
    printError(e);
    warn("If tx 1 landed but tx 2 failed, the vault rent (~0.004 SOL) is stranded; simply retry — a new market is derived each time.");
  }
}
