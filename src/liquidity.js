// Raydium pools: create AMM v4 (needs an OpenBook market), create CPMM
// (no market needed), and add liquidity to an existing pool of either kind.
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { Percent, TokenAmount, toToken } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import Decimal from "decimal.js";
import { getRaydium, programs, computeBudget, mintInfo, toRaw, executeAll, cpmmFeeConfigs, TxVersion } from "./raydium.js";
import { pickQuoteMint } from "./market.js";
import { feeLine, chargeFee } from "./fee.js";
import { header, step, info, ok, warn, fail, ask, askYes, choose, col, printError, explorerAddr, vPubkey, bar, fmtAmount } from "./ui.js";

async function walletBalance(session, m) {
  if (m.isNative) return BigInt(await session.balance());
  try {
    const ata = getAssociatedTokenAddressSync(m.mint, session.pubkey, false, m.programId);
    return (await getAccount(session.connection, ata, "confirmed", m.programId)).amount;
  } catch { return 0n; }
}

async function askAmount(label, m, bal) {
  const human = (await ask(`${label} amount (you have ${fmtAmount(bal, m.decimals)}):`, {
    validate: (s) => /^\d+(\.\d+)?$/.test(s.trim()) && Number(s) > 0 || "Enter a number",
  })).trim();
  const raw = toRaw(human, m.decimals);
  if (raw > bal) throw new Error(`Not enough balance for ${label}: need ${human}, have ${fmtAmount(bal, m.decimals)}`);
  return { human, raw };
}

function priceLine(baseHuman, quoteHuman) {
  const p = new Decimal(quoteHuman).div(baseHuman);
  info("Launch price", `1 base = ${p.toSignificantDigits(6).toString()} quote  (1 quote = ${new Decimal(1).div(p).toSignificantDigits(6)} base)`);
}

export async function createAmmV4Pool(session) {
  header("Create Raydium AMM v4 pool (from OpenBook market)");
  await session.printStatus();
  const conn = session.connection;

  step(1, "Market");
  const marketStr = (await ask("OpenBook market ID:", { validate: vPubkey })).trim();
  const raydium = await getRaydium(session);
  const P = programs(session);
  const marketAcct = await conn.getAccountInfo(new PublicKey(marketStr));
  if (!marketAcct) { fail("Market not found on this network"); return; }
  if (!marketAcct.owner.equals(P.OPEN_BOOK_PROGRAM)) { fail(`Market is owned by ${marketAcct.owner.toBase58()}, expected OpenBook ${P.OPEN_BOOK_PROGRAM.toBase58()}`); return; }
  // Serum market layout: base mint at offset 53, quote mint at 85 (after 5-byte header + 8 flags + 32 ownAddress + 8 vaultSignerNonce)
  const baseMint = new PublicKey(marketAcct.data.subarray(53, 85));
  const quoteMint = new PublicKey(marketAcct.data.subarray(85, 117));
  const base = await mintInfo(conn, baseMint.toBase58());
  const quote = await mintInfo(conn, quoteMint.toBase58());
  info("Base", `${baseMint.toBase58()} (${base.decimals} dp)`);
  info("Quote", `${quoteMint.toBase58()} (${quote.decimals} dp)`);

  step(2, "Initial liquidity (sets the launch price)");
  const bb = await walletBalance(session, base), qb = await walletBalance(session, quote);
  const bAmt = await askAmount("Base", base, bb);
  const qAmt = await askAmount("Quote", quote, qb);
  priceLine(bAmt.human, qAmt.human);

  bar();
  feeLine("pool");
  warn("Raydium charges a 0.15 SOL pool-creation fee on mainnet, plus ~0.5 SOL of account rent (mostly refundable only by Raydium, not you).");
  if (!(await askYes("Create this pool now?"))) { warn("Cancelled"); return; }

  step(3, "Building + sending");
  try {
    const built = await raydium.liquidity.createPoolV4({
      programId: P.AMM_V4,
      marketInfo: { marketId: new PublicKey(marketStr), programId: P.OPEN_BOOK_PROGRAM },
      baseMintInfo: { mint: base.mint, decimals: base.decimals },
      quoteMintInfo: { mint: quote.mint, decimals: quote.decimals },
      baseAmount: new BN(bAmt.raw.toString()),
      quoteAmount: new BN(qAmt.raw.toString()),
      startTime: new BN(0),
      ownerInfo: { useSOLBalance: true },
      associatedOnly: false,
      checkCreateATAOwner: true,
      feeDestinationId: P.FEE_DESTINATION_ID,
      txVersion: TxVersion.V0,
      computeBudgetConfig: computeBudget(session, 600_000),
    });
    const a = built.extInfo.address;
    await executeAll(session, built, "Pool");
    await chargeFee(session, "pool");
    bar();
    ok(`${col("bold", "AMM v4 pool created")}  ${col("cyan", a.ammId.toBase58())}`);
    info("LP mint", a.lpMint.toBase58());
    info("Explorer", explorerAddr(a.ammId.toBase58(), session.cluster));
    info("Next", "Burn LP tokens to lock liquidity permanently (menu → Burn LP)");
    return a.ammId.toBase58();
  } catch (e) { printError(e); }
}

export async function createCpmmPool(session) {
  header("Create Raydium CPMM pool (no OpenBook market needed)");
  await session.printStatus();
  const conn = session.connection;

  step(1, "Pair");
  const baseStr = (await ask("Token A mint (your token):", { validate: vPubkey })).trim();
  const quoteStr = await pickQuoteMint(session);
  const base = await mintInfo(conn, baseStr), quote = await mintInfo(conn, quoteStr);

  step(2, "Initial liquidity (sets the launch price)");
  const bb = await walletBalance(session, base), qb = await walletBalance(session, quote);
  const bAmt = await askAmount("Token A", base, bb);
  const qAmt = await askAmount("Token B", quote, qb);
  priceLine(bAmt.human, qAmt.human);

  step(3, "Fee tier");
  const raydium = await getRaydium(session);
  const P = programs(session);
  const configs = await cpmmFeeConfigs(session, raydium);
  const feeConfig = await choose("Trade fee:", configs.map((c) => ({
    name: `${(c.tradeFeeRate / 1e4).toFixed(2)}%   ${col("grey", `creation fee ${(Number(c.createPoolFee) / 1e9).toFixed(2)} SOL`)}`, value: c,
  })));

  bar();
  feeLine("pool");
  if (!(await askYes("Create this pool now?"))) { warn("Cancelled"); return; }

  step(4, "Building + sending");
  try {
    const built = await raydium.cpmm.createPool({
      programId: P.CREATE_CPMM_POOL_PROGRAM,
      poolFeeAccount: P.CREATE_CPMM_POOL_FEE_ACC,
      mintA: { address: base.mint.toBase58(), decimals: base.decimals, programId: base.programId.toBase58() },
      mintB: { address: quote.mint.toBase58(), decimals: quote.decimals, programId: quote.programId.toBase58() },
      mintAAmount: new BN(bAmt.raw.toString()),
      mintBAmount: new BN(qAmt.raw.toString()),
      startTime: new BN(0),
      feeConfig,
      associatedOnly: false,
      ownerInfo: { useSOLBalance: true },
      txVersion: TxVersion.V0,
      computeBudgetConfig: computeBudget(session, 600_000),
    });
    const a = built.extInfo.address;
    await executeAll(session, built, "Pool");
    await chargeFee(session, "pool");
    bar();
    ok(`${col("bold", "CPMM pool created")}  ${col("cyan", a.poolId.toBase58())}`);
    info("LP mint", a.lpMint.toBase58());
    info("Explorer", explorerAddr(a.poolId.toBase58(), session.cluster));
    return a.poolId.toBase58();
  } catch (e) { printError(e); }
}

export async function addLiquidity(session) {
  header("Add liquidity to an existing Raydium pool");
  await session.printStatus();
  const conn = session.connection;
  const poolStr = (await ask("Pool ID:", { validate: vPubkey })).trim();
  const acct = await conn.getAccountInfo(new PublicKey(poolStr));
  if (!acct) { fail("Pool not found on this network"); return; }
  const P = programs(session);
  const raydium = await getRaydium(session);
  const slippage = new Percent(Number(await ask("Slippage %:", { default: "1" })) * 100, 10_000);

  try {
    if (acct.owner.equals(P.AMM_V4)) {
      ok("Pool type: AMM v4");
      const { poolInfo, poolKeys, poolRpcData } = await raydium.liquidity.getPoolInfoFromRpc({ poolId: poolStr });
      const baseRes = new Decimal(poolRpcData.baseReserve.toString()).div(10 ** poolInfo.mintA.decimals);
      const quoteRes = new Decimal(poolRpcData.quoteReserve.toString()).div(10 ** poolInfo.mintB.decimals);
      info("Reserves", `${baseRes.toFixed(4)} A  /  ${quoteRes.toFixed(4)} B`);
      info("Mint A", poolInfo.mintA.address);
      info("Mint B", poolInfo.mintB.address);
      const side = await choose("Which amount do you want to fix?", [{ name: "Token A", value: "a" }, { name: "Token B", value: "b" }]);
      const fixedMint = side === "a" ? poolInfo.mintA : poolInfo.mintB;
      const human = (await ask(`Amount of ${side === "a" ? "A" : "B"}:`, { validate: (s) => Number(s) > 0 || "Enter a number" })).trim();
      const r = raydium.liquidity.computePairAmount({ poolInfo, amount: human, slippage, baseIn: side === "a" });
      const amountIn = new TokenAmount(toToken(fixedMint), toRaw(human, fixedMint.decimals).toString());
      info("Other side needed", `${r.anotherAmount.toExact()} ${side === "a" ? "B" : "A"}`);
      info("Max with slippage", r.maxAnotherAmount.toExact());
      {
        const mA = await mintInfo(conn, poolInfo.mintA.address), mB = await mintInfo(conn, poolInfo.mintB.address);
        const balA = await walletBalance(session, mA), balB = await walletBalance(session, mB);
        const needA = side === "a" ? BigInt(amountIn.raw.toString()) : BigInt(r.maxAnotherAmount.raw.toString());
        const needB = side === "b" ? BigInt(amountIn.raw.toString()) : BigInt(r.maxAnotherAmount.raw.toString());
        if (needA > balA) { fail(`Not enough A: need ${fmtAmount(needA, mA.decimals)}, have ${fmtAmount(balA, mA.decimals)}`); return; }
        if (needB > balB) { fail(`Not enough B: need ${fmtAmount(needB, mB.decimals)}, have ${fmtAmount(balB, mB.decimals)}`); return; }
      }
      feeLine("addLiquidity");
      if (!(await askYes("Add this liquidity?"))) { warn("Cancelled"); return; }
      const built = await raydium.liquidity.addLiquidity({
        poolInfo, poolKeys,
        amountInA: side === "a" ? amountIn : r.maxAnotherAmount,
        amountInB: side === "a" ? r.maxAnotherAmount : amountIn,
        otherAmountMin: r.minAnotherAmount,
        fixedSide: side,
        txVersion: TxVersion.V0,
        computeBudgetConfig: computeBudget(session, 400_000),
      });
      await executeAll(session, built, "Add liquidity");
    } else if (acct.owner.equals(P.CREATE_CPMM_POOL_PROGRAM)) {
      ok("Pool type: CPMM");
      const { poolInfo, poolKeys, rpcData } = await raydium.cpmm.getPoolInfoFromRpc(poolStr);
      info("Mint A", poolInfo.mintA.address);
      info("Mint B", poolInfo.mintB.address);
      info("Reserves", `${new Decimal(rpcData.baseReserve.toString()).div(10 ** poolInfo.mintA.decimals).toFixed(4)} A  /  ${new Decimal(rpcData.quoteReserve.toString()).div(10 ** poolInfo.mintB.decimals).toFixed(4)} B`);
      const side = await choose("Which amount do you want to fix?", [{ name: "Token A", value: "a" }, { name: "Token B", value: "b" }]);
      const fixedMint = side === "a" ? poolInfo.mintA : poolInfo.mintB;
      const human = (await ask(`Amount of ${side === "a" ? "A" : "B"}:`, { validate: (s) => Number(s) > 0 || "Enter a number" })).trim();
      const inputAmount = new BN(toRaw(human, fixedMint.decimals).toString());
      const r = raydium.cpmm.computePairAmount({
        poolInfo, baseReserve: rpcData.baseReserve, quoteReserve: rpcData.quoteReserve,
        amount: human, slippage, baseIn: side === "a", epochInfo: await conn.getEpochInfo(),
      });
      const otherDec = side === "a" ? poolInfo.mintB.decimals : poolInfo.mintA.decimals;
      info("Other side needed", fmtAmount(r.anotherAmount.amount.toString(), otherDec));
      info("Max with slippage", fmtAmount(r.maxAnotherAmount.amount.toString(), otherDec));
      {
        const mA = await mintInfo(conn, poolInfo.mintA.address), mB = await mintInfo(conn, poolInfo.mintB.address);
        const balA = await walletBalance(session, mA), balB = await walletBalance(session, mB);
        const needA = side === "a" ? BigInt(inputAmount.toString()) : BigInt(r.maxAnotherAmount.amount.toString());
        const needB = side === "b" ? BigInt(inputAmount.toString()) : BigInt(r.maxAnotherAmount.amount.toString());
        if (needA > balA) { fail(`Not enough A: need ${fmtAmount(needA, mA.decimals)}, have ${fmtAmount(balA, mA.decimals)}`); return; }
        if (needB > balB) { fail(`Not enough B: need ${fmtAmount(needB, mB.decimals)}, have ${fmtAmount(balB, mB.decimals)}`); return; }
      }
      feeLine("addLiquidity");
      if (!(await askYes("Add this liquidity?"))) { warn("Cancelled"); return; }
      const built = await raydium.cpmm.addLiquidity({
        poolInfo, poolKeys, inputAmount, baseIn: side === "a", slippage,
        txVersion: TxVersion.V0,
        computeBudgetConfig: computeBudget(session, 400_000),
      });
      await executeAll(session, built, "Add liquidity");
    } else {
      fail(`Unsupported pool program ${acct.owner.toBase58()} (only AMM v4 and CPMM are supported)`);
      return;
    }
    await chargeFee(session, "addLiquidity");
    ok(col("bold", "Liquidity added"));
    info("Next", "Burn the new LP tokens if you want them locked (menu → Burn LP)");
  } catch (e) { printError(e); }
}
