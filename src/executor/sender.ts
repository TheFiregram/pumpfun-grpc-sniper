import {
  BlockhashWithExpiryBlockHeight,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config, connection } from "../config";
import { HELIUS_TIP_ACCOUNTS } from "../pump/constants";
import { lamportsFromSol } from "../pump/math";

// ---------- Blockhash cache: avoids an RPC round-trip on every snipe ----------
let latest: { value: BlockhashWithExpiryBlockHeight; fetchedAt: number } | null = null;
let blockhashTimer: NodeJS.Timeout | null = null;

async function refreshBlockhash() {
  try {
    latest = { value: await connection.getLatestBlockhash("confirmed"), fetchedAt: Date.now() };
  } catch (e) {
    console.warn("Blockhash refresh failed:", (e as Error).message);
  }
}

export async function startBlockhashCache(intervalMs = 2_000) {
  await refreshBlockhash();
  if (!latest) throw new Error("Could not fetch a blockhash from RPC. Check HELIUS_API_KEY / RPC_URL.");
  blockhashTimer = setInterval(refreshBlockhash, intervalMs);
  blockhashTimer.unref();
}

export async function getBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
  // A blockhash is valid ~60s; refuse anything older than 20s so transactions don't expire in flight.
  if (!latest || Date.now() - latest.fetchedAt > 20_000) await refreshBlockhash();
  if (!latest) throw new Error("No recent blockhash available");
  return latest.value;
}

// ---------- Sender connection warming ----------
let pingTimer: NodeJS.Timeout | null = null;
export function startSenderKeepAlive(intervalMs = 4_000) {
  const pingUrl = new URL(config.senderUrl);
  pingUrl.pathname = "/ping";
  pingUrl.search = "";
  pingTimer = setInterval(() => {
    fetch(pingUrl).catch(() => undefined);
  }, intervalMs);
  pingTimer.unref();
}

// ---------- Transaction building ----------
const randomTipAccount = (): PublicKey => HELIUS_TIP_ACCOUNTS[Math.floor(Math.random() * HELIUS_TIP_ACCOUNTS.length)];

export function tipIx(from: PublicKey, tipSol: number): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: randomTipAccount(), lamports: lamportsFromSol(tipSol) });
}

export function computeBudgetIxs(): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: config.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports }),
  ];
}

export interface BuiltTx {
  tx: VersionedTransaction;
  signature: string;
  blockhash: BlockhashWithExpiryBlockHeight;
}

/** Compute budget + your instructions + Helius tip, signed and ready. */
export async function buildTx(ixs: TransactionInstruction[], payer: Keypair, tipSol: number, extraSigners: Keypair[] = []): Promise<BuiltTx> {
  const blockhash = await getBlockhash();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions: [...computeBudgetIxs(), ...ixs, tipIx(payer.publicKey, tipSol)],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer, ...extraSigners]);
  return { tx, signature: bs58.encode(tx.signatures[0]), blockhash };
}

// ---------- Simulation (dry-run) ----------
export async function simulate(tx: VersionedTransaction) {
  const res = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" });
  return { err: res.value.err, logs: res.value.logs ?? [], unitsConsumed: res.value.unitsConsumed };
}

// ---------- Sending ----------
async function senderRpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(config.senderUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`Sender ${method} failed (${res.status}): ${JSON.stringify(body.error ?? body)}`);
  }
  return body.result;
}

/** Send one signed transaction through Helius Sender. */
export async function sendViaSender(tx: VersionedTransaction): Promise<string> {
  const b64 = Buffer.from(tx.serialize()).toString("base64");
  return senderRpc("sendTransaction", [b64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
}

/** Send up to 4 signed transactions as an all-or-nothing bundle. Put the tip in the last one. */
export async function sendBundleViaSender(txs: VersionedTransaction[]): Promise<string> {
  if (txs.length === 0 || txs.length > 4) throw new Error("A bundle must hold 1 to 4 transactions");
  const b64 = txs.map((t) => Buffer.from(t.serialize()).toString("base64"));
  return senderRpc("sendBundle", [b64, { encoding: "base64" }]);
}

/**
 * Wait for a signature to land, using the SAME blockhash the transaction was signed with,
 * so expiry is judged correctly. Re-sends every 2s while waiting (Sender does not retry for you).
 */
export async function confirm(built: BuiltTx, resend = true, timeoutMs = 45_000): Promise<{ ok: boolean; err?: unknown }> {
  const start = Date.now();
  let lastResend = start;
  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([built.signature]);
    const st = value[0];
    if (st?.err) return { ok: false, err: st.err };
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { ok: true };

    const height = await connection.getBlockHeight("confirmed");
    if (height > built.blockhash.lastValidBlockHeight) return { ok: false, err: "blockhash expired" };

    if (resend && Date.now() - lastResend > 2_000) {
      lastResend = Date.now();
      sendViaSender(built.tx).catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, err: "confirmation timeout" };
}
