// Global fetch wrapper: retries HTTP 429 (rate limit) and transient network
// errors with exponential backoff. Covers web3.js, Raydium SDK, Umi and
// Pinata uploads alike, since they all go through global fetch.
import { col } from "./ui.js";

const MAX_RETRIES = 8;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let installed = false;
let noticeShown = false;

// Explicit retrying fetch — pass to web3.js `new Connection(url, { fetch })`,
// which bundles its own node-fetch and ignores the global.
const realFetch = globalThis.fetch.bind(globalThis);
export const retryFetch = async (input, init) => {
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await realFetch(input, init);
      } catch (e) {
        if (attempt >= MAX_RETRIES || !/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(e.message)) throw e;
        await sleep(backoff(attempt++)); continue;
      }
      if (res.status !== 429 || attempt >= MAX_RETRIES) return res;
      if (!noticeShown) { noticeShown = true; console.log(col("grey", "    (RPC rate-limited — retrying with backoff; a private RPC in Settings avoids this)")); }
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_DELAY_MS) : backoff(attempt++));
      if (retryAfter > 0) attempt++;
    }
};

export function installRetryFetch() {
  if (installed) return;
  installed = true;
  globalThis.fetch = retryFetch;
}

function backoff(attempt) {
  const d = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return d + Math.random() * d * 0.25;
}
