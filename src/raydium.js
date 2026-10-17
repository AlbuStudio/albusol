// Raydium SDK v2 loader + shared helpers for market / pool modules.
import { Raydium, TxVersion, ALL_PROGRAM_ID, DEVNET_PROGRAM_ID, getCpmmPdaAmmConfigId } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { ok, info, col, explorerTx, sleep } from "./ui.js";

let cached = null;

export async function getRaydium(session) {
  const key = `${session.cluster}|${session.pubkey.toBase58()}`;
  if (cached?.key === key) return cached.raydium;
  const raydium = await Raydium.load({
    connection: session.connection,
    owner: session.keypair,
    cluster: session.cluster,
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed",
  });
  cached = { key, raydium };
  return raydium;
}

export const programs = (session) => (session.cluster === "devnet" ? DEVNET_PROGRAM_ID : ALL_PROGRAM_ID);

export const computeBudget = (session, units = 600_000) => ({
  units,
  microLamports: Number(session.cfg.priorityFeeMicroLamports) || 0,
});

export async function mintInfo(connection, mintStr) {
  const mint = new PublicKey(mintStr);
  const acct = await connection.getAccountInfo(mint);
  if (!acct) throw new Error(`Mint ${mintStr} not found on this network`);
  const programId = acct.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const m = await getMint(connection, mint, "confirmed", programId);
  return { mint, decimals: m.decimals, programId, supply: m.supply, isNative: mint.equals(NATIVE_MINT) };
}

export const toRaw = (human, decimals) => {
  const [i, f = ""] = String(human).trim().split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
};

// Run every transaction the SDK built, in order, and print explorer links.
export async function executeAll(session, built, label) {
  const cluster = session.cluster;
  if (built.transactions) {
    const { txIds } = await built.execute({ sequentially: true, sendAndConfirm: true });
    txIds.forEach((id, i) => ok(`${label} tx ${i + 1}/${txIds.length}: ${col("cyan", explorerTx(id, cluster))}`));
    return txIds;
  }
  const { txId } = await built.execute({ sendAndConfirm: true });
  ok(`${label}: ${col("cyan", explorerTx(txId, cluster))}`);
  return [txId];
}

// Devnet CPMM fee configs are not served by the API; derive their PDAs as the SDK demo does.
export async function cpmmFeeConfigs(session, raydium) {
  const configs = await raydium.api.getCpmmConfigs();
  if (session.cluster === "devnet") {
    for (const c of configs) c.id = getCpmmPdaAmmConfigId(DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, c.index).publicKey.toBase58();
  }
  return configs;
}

export async function waitForAccount(connection, pubkey, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const a = await connection.getAccountInfo(pubkey, "confirmed");
    if (a) return a;
    await sleep(1500);
  }
  return null;
}

export { TxVersion, info };
