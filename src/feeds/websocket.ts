// Launch feed for Helius plans without LaserStream gRPC (including Free).
// Uses the standard `logsSubscribe` WebSocket, filtered to transactions that mention Pump.fun's
// mint-authority account. Only coin creations touch that account, so the bot receives launches
// only, not every Pump.fun trade, which keeps WebSocket data (and credits) small.
import { Logs, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { connection } from "../config";
import { PUMP_PROGRAM_ID } from "../pump/constants";
import { buildLaunches, Launch, parseLaunches } from "../pump/detect";
import { CreateEvent, decodePumpEventData, TradeEvent } from "../pump/events";

export const MINT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PUMP_PROGRAM_ID)[0];

const PROGRAM_DATA = "Program data: ";

/** Pull launches straight out of the transaction logs (Pump.fun also logs its events there). */
export function launchesFromLogs(logs: Logs, slot: number, receivedAt: number): { launches: Launch[]; complete: boolean } {
  if (logs.err) return { launches: [], complete: true }; // failed transaction: nothing was created
  let kind: "create" | "create_v2" | null = null;
  const creates: CreateEvent[] = [];
  const trades: TradeEvent[] = [];
  let truncated = false;

  for (const line of logs.logs) {
    if (line.includes("Instruction: CreateV2")) kind = "create_v2";
    else if (line.includes("Instruction: Create")) kind = kind ?? "create";
    if (line.startsWith("Log truncated")) truncated = true;
    if (!line.startsWith(PROGRAM_DATA)) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice(PROGRAM_DATA.length), "base64");
    } catch {
      continue;
    }
    const ev = decodePumpEventData(buf);
    if (ev?.kind === "create") creates.push(ev.ev);
    else if (ev?.kind === "trade") trades.push(ev.ev);
  }
  if (!kind) return { launches: [], complete: true }; // not a Pump.fun create
  if (creates.length === 0 || truncated) return { launches: [], complete: false }; // need the full transaction
  return { launches: buildLaunches(logs.signature, String(slot), receivedAt, kind, creates, trades), complete: true };
}

/** Fallback when logs were truncated: fetch the transaction and parse it like a gRPC update. */
async function launchesFromTransaction(signature: string, receivedAt: number): Promise<Launch[]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx) {
      const msg: any = tx.transaction.message;
      const keys: PublicKey[] = msg.staticAccountKeys ?? msg.accountKeys;
      const toIx = (ix: any) => ({
        programIdIndex: ix.programIdIndex,
        accounts: Uint8Array.from(ix.accounts ?? ix.accountKeyIndexes ?? []),
        data: bs58.decode(ix.data),
      });
      const update = {
        transaction: {
          slot: tx.slot,
          transaction: {
            signature: bs58.decode(signature),
            transaction: { message: { accountKeys: keys.map((k) => k.toBytes()), instructions: (msg.compiledInstructions ?? msg.instructions).map((ix: any) => ({
              programIdIndex: ix.programIdIndex,
              accounts: Uint8Array.from(ix.accountKeyIndexes ?? ix.accounts ?? []),
              data: typeof ix.data === "string" ? bs58.decode(ix.data) : Uint8Array.from(ix.data),
            })) } },
            meta: {
              err: tx.meta?.err ?? null,
              loadedWritableAddresses: (tx.meta?.loadedAddresses?.writable ?? []).map((k) => k.toBytes()),
              loadedReadonlyAddresses: (tx.meta?.loadedAddresses?.readonly ?? []).map((k) => k.toBytes()),
              innerInstructions: (tx.meta?.innerInstructions ?? []).map((inner) => ({ index: inner.index, instructions: inner.instructions.map(toIx) })),
            },
          },
        },
      };
      return parseLaunches(update, receivedAt);
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return [];
}

/**
 * Subscribe to launches over WebSocket. web3.js reconnects the socket by itself; on top of that,
 * a watchdog re-subscribes if nothing has arrived for a while.
 */
export function startWebsocketFeed(onLaunch: (l: Launch) => void, maxFetchesPerMinute: number) {
  let subId: number | null = null;
  let lastMsg = Date.now();
  let fetching = 0;
  let fetchesThisMinute = 0;
  const stats = { launches: 0, fromLogs: 0, fetched: 0, skipped: 0 };
  setInterval(() => (fetchesThisMinute = 0), 60_000).unref();
  setInterval(() => {
    console.log(`📊 last 10 min: ${stats.launches} launch txs, ${stats.fromLogs} read from logs, ${stats.fetched} fetched, ${stats.skipped} skipped (fetch limit)`);
    Object.assign(stats, { launches: 0, fromLogs: 0, fetched: 0, skipped: 0 });
  }, 600_000).unref();

  const handle = (logs: Logs, ctx: { slot: number }) => {
    lastMsg = Date.now();
    const { launches, complete } = launchesFromLogs(logs, ctx.slot, lastMsg);
    if (launches.length) {
      stats.launches++;
      stats.fromLogs++;
    }
    for (const l of launches) onLaunch(l);
    if (complete) return;
    stats.launches++;
    // Fetching the full transaction costs a credit and time: cap it (Free plan has 1M credits/month).
    if (fetching >= 2 || fetchesThisMinute >= maxFetchesPerMinute) {
      stats.skipped++;
      return;
    }
    {
      const receivedAt = lastMsg;
      fetching++;
      fetchesThisMinute++;
      stats.fetched++;
      launchesFromTransaction(logs.signature, receivedAt)
        .then((ls) => ls.forEach(onLaunch))
        .catch((e) => console.warn("Could not fetch launch transaction:", (e as Error).message))
        .finally(() => fetching--);
    }
  };

  const subscribe = () => {
    subId = connection.onLogs(MINT_AUTHORITY, handle, "processed");
    console.log(`✓ Listening for Pump.fun launches over Helius WebSocket (logsSubscribe on ${MINT_AUTHORITY.toBase58()})`);
  };
  subscribe();

  // Pump.fun launches a coin every few seconds; 2 minutes of silence means the subscription is dead.
  setInterval(async () => {
    if (Date.now() - lastMsg < 120_000) return;
    console.warn("No launches for 2 minutes, re-subscribing...");
    lastMsg = Date.now();
    if (subId !== null) await connection.removeOnLogsListener(subId).catch(() => undefined);
    subscribe();
  }, 30_000).unref();
}
