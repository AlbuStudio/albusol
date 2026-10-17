// Metaplex Umi context bound to the session wallet.
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity } from "@metaplex-foundation/umi";
import { mplCore } from "@metaplex-foundation/mpl-core";
import { mplTokenMetadata } from "@metaplex-foundation/mpl-token-metadata";
import bs58 from "bs58";
import { rpcUrl } from "./config.js";

let cached = null;

export function getUmi(session) {
  const key = `${rpcUrl(session.cfg)}|${session.pubkey.toBase58()}`;
  if (cached?.key === key) return cached.umi;
  const umi = createUmi(rpcUrl(session.cfg), { commitment: "confirmed" }).use(mplCore()).use(mplTokenMetadata());
  umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(session.keypair.secretKey)));
  cached = { key, umi };
  return umi;
}

// umi returns signatures as bytes; explorers want base58.
export const umiSig = (sig) => (typeof sig === "string" ? sig : bs58.encode(sig));
