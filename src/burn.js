// Burn LP (or any SPL) tokens held by the wallet. A real burn reduces the
// mint supply; for an LP mint that makes the pooled liquidity permanently
// unwithdrawable by anyone, including the creator.
import { PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createBurnCheckedInstruction, createCloseAccountInstruction } from "@solana/spl-token";
import { programs } from "./raydium.js";
import { feeLine, chargeFee } from "./fee.js";
import { header, step, info, ok, warn, fail, ask, askYes, choose, col, printTx, printError, fmtAmount, short, bar } from "./ui.js";

async function listHoldings(session) {
  const out = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await session.connection.getParsedTokenAccountsByOwner(session.pubkey, { programId });
    for (const { pubkey, account } of res.value) {
      const p = account.data.parsed.info;
      const amount = BigInt(p.tokenAmount.amount);
      if (amount === 0n) continue;
      out.push({ account: pubkey, mint: new PublicKey(p.mint), decimals: p.tokenAmount.decimals, amount, programId });
    }
  }
  return out;
}

// Mark mints that are LP mints of a Raydium pool (owner = AMM v4 or CPMM program authority is not knowable cheaply;
// instead check the mint authority: AMM v4 LP mints are owned by the AMM authority PDA, CPMM by the CPMM authority).
async function tagLp(session, holdings) {
  const P = programs(session);
  const ammAuth = PublicKey.findProgramAddressSync([Buffer.from([97, 109, 109, 32, 97, 117, 116, 104, 111, 114, 105, 116, 121])], P.AMM_V4)[0];
  const cpmmAuth = P.CREATE_CPMM_POOL_AUTH;
  const infos = await session.connection.getMultipleParsedAccounts(holdings.map((h) => h.mint));
  holdings.forEach((h, i) => {
    const auth = infos.value[i]?.data?.parsed?.info?.mintAuthority;
    h.lp = auth === ammAuth.toBase58() ? "AMM v4 LP" : auth === cpmmAuth.toBase58() ? "CPMM LP" : "";
  });
}

export async function burnTokens(session) {
  header("Burn LP / tokens");
  await session.printStatus();

  step(1, "Scanning token accounts");
  const holdings = await listHoldings(session);
  if (!holdings.length) { warn("No token balances in this wallet"); return; }
  try { await tagLp(session, holdings); } catch { /* tagging is cosmetic */ }
  const h = await choose("Which token to burn?", holdings
    .sort((a, b) => (b.lp ? 1 : 0) - (a.lp ? 1 : 0))
    .map((x) => ({
      name: `${fmtAmount(x.amount, x.decimals).padStart(22)}   ${short(x.mint.toBase58(), 10)}   ${x.lp ? col("magenta", x.lp) : ""}`,
      value: x,
    })));
  info("Mint", h.mint.toBase58());
  info("Balance", fmtAmount(h.amount, h.decimals));

  step(2, "Amount");
  const mode = await choose("Burn how much?", [
    { name: `Everything (${fmtAmount(h.amount, h.decimals)})`, value: "all" },
    { name: "A percentage", value: "pct" },
    { name: "An exact amount", value: "exact" },
  ]);
  let raw = h.amount;
  if (mode === "pct") {
    const pct = Number(await ask("Percent (1–100):", { validate: (s) => Number(s) > 0 && Number(s) <= 100 || "1–100" }));
    raw = (h.amount * BigInt(Math.round(pct * 100))) / 10_000n;
  } else if (mode === "exact") {
    const s = (await ask("Amount:", { validate: (v) => Number(v) > 0 || "Enter a number" })).trim();
    const [i, f = ""] = s.split(".");
    raw = BigInt(i || "0") * 10n ** BigInt(h.decimals) + BigInt((f + "0".repeat(h.decimals)).slice(0, h.decimals) || "0");
    if (raw > h.amount) { fail("More than you hold"); return; }
  }
  const closeAfter = raw === h.amount && (await askYes("Close the empty token account afterwards (refunds ~0.002 SOL rent)?", true));

  bar();
  info("Burning", `${fmtAmount(raw, h.decimals)} of ${h.mint.toBase58()}`);
  if (h.lp) warn(`This is a ${h.lp} token. Burning it locks the matching share of pool liquidity FOREVER.`);
  feeLine("burn");
  warn("Burning is irreversible.");
  const typed = await ask('Type  BURN  to confirm:');
  if (typed.trim() !== "BURN") { warn("Cancelled"); return; }

  step(3, "Sending");
  try {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(session.cfg.priorityFeeMicroLamports) || 0 }),
      createBurnCheckedInstruction(h.account, h.mint, session.pubkey, raw, h.decimals, [], h.programId),
    );
    if (closeAfter) tx.add(createCloseAccountInstruction(h.account, session.pubkey, session.pubkey, [], h.programId));
    const sig = await sendAndConfirmTransaction(session.connection, tx, [session.keypair], { commitment: "confirmed" });
    printTx(sig, session.cluster, "Burned");
    await chargeFee(session, "burn");
    const supply = await session.connection.getTokenSupply(h.mint);
    info("Remaining supply", supply.value.uiAmountString);
    if (h.lp && BigInt(supply.value.amount) === 0n) ok(col("bold", "LP supply is now 0 — the pool liquidity is permanently locked."));
  } catch (e) { printError(e); }
}
