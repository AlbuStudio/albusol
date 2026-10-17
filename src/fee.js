// AlbuSOL service fee. A flat SOL amount per completed action, sent to the
// Albu Studio wallet in its own transaction AFTER the action succeeds, so a
// failed action is never charged. The fee is always shown in the confirmation.
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { info, ok, warn, col, explorerTx } from "./ui.js";

export const FEE_WALLET = new PublicKey("CGoCBQgPAYTPH29pYgLx6E6FbWRN1dSJbct4UijQJe3g");

// SOL per action
export const FEES = {
  token:        0.05,
  market:       0.05,
  pool:         0.10,
  addLiquidity: 0.02,
  burn:         0.01,
  collection:   0.02,
  nft:          0.005,
  nftBatch:     0.002,   // per asset
};

export const feeOf = (action, count = 1) => FEES[action] * count;

export function feeLine(action, count = 1) {
  info("AlbuSOL fee", `${feeOf(action, count)} SOL  ${col("grey", "→ " + FEE_WALLET.toBase58().slice(0, 8) + "… (charged only on success)")}`);
}

export async function chargeFee(session, action, count = 1) {
  const sol = feeOf(action, count);
  if (!sol) return;
  if (session.pubkey.equals(FEE_WALLET)) return;
  try {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: session.pubkey, toPubkey: FEE_WALLET, lamports: Math.round(sol * LAMPORTS_PER_SOL),
    }));
    const sig = await sendAndConfirmTransaction(session.connection, tx, [session.keypair], { commitment: "confirmed" });
    ok(`AlbuSOL fee ${sol} SOL paid: ${col("cyan", explorerTx(sig, session.cluster))}`);
  } catch (e) {
    warn(`Fee transfer failed (${e.message}); the action itself already succeeded.`);
  }
}
