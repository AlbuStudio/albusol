# Security

AlbuSOL is a signing tool. Its whole job is to hold a private key in memory and
sign irreversible transactions with it, so this page says exactly what it does
and does not protect against.

## What AlbuSOL protects

- **Key at rest.** Wallets live in `~/.albusol/wallets/<name>.json`, encrypted
  with scrypt (N = 2^15, r = 8, p = 1, 64 MB) and AES-256-GCM under a password
  you choose. The file holds the public key in clear and nothing else usable.
- **Key in memory.** The key is decrypted only after you type the password at
  start-up and is never written back to disk, logged or printed unless you
  explicitly choose **Wallet → Export** and confirm.
- **What gets signed.** Every transaction is built by the code in `src/` from
  the values you typed and confirmed on screen. There is no server, no remote
  configuration and no auto-update; the only outbound connections are to the
  RPC endpoint you configured and, if you set a Pinata JWT, to `api.pinata.cloud`.
- **Fee transparency.** The service fee is a plain `SystemProgram.transfer` to
  one hard-coded address in `src/fee.js`, printed before every confirmation and
  sent only after the action succeeded.

## What it does not protect

- A compromised computer. If your machine runs a keylogger or a malicious
  terminal, no local tool can help; use a dedicated launch wallet with only the
  SOL you need.
- Known advisory without a fix: `bigint-buffer` (GHSA-3gc7-fjrx-p6mg), pulled in by `@solana/spl-token`. The vulnerable code path is the pure-JS fallback of `toBigIntLE()` on attacker-controlled buffers; AlbuSOL only passes it account data returned by your own RPC. It is listed here so you can make your own call; it will be dropped the moment the Solana SDKs move off it. `stream-json` and `uuid` are pinned to patched versions through `overrides` in `package.json`.
- A compromised dependency. `npm install` pulls the Solana, Raydium and
  Metaplex SDKs. The lockfile pins exact versions; review `npm audit` and the
  lockfile diff before upgrading.
- Mistakes you confirm. Revoking authorities, burning LP and minting are
  irreversible by design. Rehearse on devnet first.
- Your legal position. You are the issuer of anything you create.

## Verifying a download

Each release zip ships with its SHA-256 in `latest.json` next to the download
on albustudio.com and on the GitHub release page. Compare before running:

```bash
shasum -a 256 albusol-<version>.zip
```

## Reporting a vulnerability

E-mail **office@albustudio.com** with "AlbuSOL security" in the subject. Please
do not open a public issue for anything that could put users' keys or funds at
risk. You will get an answer within three working days, and a fix or a
mitigation note before any public disclosure.
