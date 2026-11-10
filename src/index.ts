import Client, { CommitmentLevel, SubscribeRequest } from "@triton-one/yellowstone-grpc";
import { config, getSigner, redact } from "./config";
import { startBlockhashCache, startSenderKeepAlive } from "./executor/sender";
import { skipReason } from "./filters";
import { PUMP_PROGRAM_ID } from "./pump/constants";
import { Launch, parseLaunches } from "./pump/detect";
import { solFromLamports } from "./pump/math";
import { startPositionManager } from "./positions";
import { startWebsocketFeed } from "./feeds/websocket";
import { loadFees, snipe, startBalanceCache } from "./snipe";
import { positions, spentToday } from "./state";

// ---------- Bounded work queue: drops old signals instead of buying minutes late ----------
const queue: Launch[] = [];
let active = 0;

function enqueue(l: Launch) {
  if (queue.length >= config.maxQueue) {
    const dropped = queue.shift()!;
    console.log(`⏭️  ${dropped.create.symbol}: dropped, queue full`);
  }
  queue.push(l);
  pump();
}

function pump() {
  while (active < config.snipeConcurrency && queue.length) {
    const l = queue.shift()!;
    const deadline = l.receivedAt + config.maxSignalAgeMs;
    if (Date.now() > deadline) {
      console.log(`⏭️  ${l.create.symbol}: dropped, signal older than ${config.maxSignalAgeMs}ms`);
      continue;
    }
    active++;
    snipe(l, deadline).finally(() => {
      active--;
      pump();
    });
  }
}

// ---------- Dedupe ----------
const seen = new Map<string, number>();
function firstTime(mint: string): boolean {
  const now = Date.now();
  if (now - (seen.get(mint) ?? 0) < config.dedupeTtlMs) return false;
  seen.set(mint, now);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [m, t] of seen) if (now - t > config.dedupeTtlMs) seen.delete(m);
}, 60_000).unref();

function onLaunch(l: Launch) {
  const c = l.create;
  if (!firstTime(c.mint.toBase58())) return;
  const reason = skipReason(l);
  console.log(
    `🚀 ${l.instruction} ${c.name} (${c.symbol}) ${c.mint.toBase58()} creator ${c.creator.toBase58()} slot ${l.slot}` +
      (reason ? `  → skip: ${reason}` : "  → queued"),
  );
  if (!reason) enqueue(l);
}

// ---------- gRPC stream with keep-alive pings and automatic reconnect ----------
const request: SubscribeRequest = {
  accounts: {},
  slots: {},
  transactions: {
    pump: {
      vote: false,
      failed: false,
      accountInclude: [PUMP_PROGRAM_ID.toBase58()],
      accountExclude: [],
      accountRequired: [],
    },
  },
  transactionsStatus: {},
  entry: {},
  blocks: {},
  blocksMeta: {},
  commitment: CommitmentLevel.PROCESSED,
  accountsDataSlice: [],
  ping: undefined,
};

const pingRequest = (id: number): SubscribeRequest => ({
  accounts: {}, slots: {}, transactions: {}, transactionsStatus: {}, entry: {}, blocks: {}, blocksMeta: {},
  accountsDataSlice: [], ping: { id },
});

async function streamOnce(): Promise<void> {
  const client: any = new Client(config.grpcEndpoint, config.grpcToken, { "grpc.max_receive_message_length": 64 * 1024 * 1024 });
  if (typeof client.connect === "function") await client.connect(); // newer client versions need this
  const stream = await client.subscribe();

  await new Promise<void>((resolve, reject) => {
    stream.write(request, (err: unknown) => (err ? reject(err) : resolve()));
  });
  console.log(`✓ Listening for Pump.fun launches on LaserStream ${config.grpcEndpoint}`);

  let pingId = 0;
  const pinger = setInterval(() => stream.write(pingRequest(++pingId), () => undefined), 10_000);
  let lastData = Date.now();

  await new Promise<void>((resolve) => {
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > 30_000) {
        console.warn("No data for 30s, reconnecting...");
        stream.cancel?.();
        stream.destroy?.();
        done();
      }
    }, 5_000);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearInterval(pinger);
      clearInterval(watchdog);
      resolve();
    };
    stream.on("data", (data: any) => {
      lastData = Date.now();
      if (!data?.transaction) return;
      try {
        for (const l of parseLaunches(data, lastData)) onLaunch(l);
      } catch (e) {
        console.error("Error parsing transaction:", (e as Error).message);
      }
    });
    stream.on("error", (e: Error) => {
      console.error("Stream error:", e.message);
      done();
    });
    stream.on("end", done);
    stream.on("close", done);
  });
}

async function main() {
  const signer = getSigner();
  console.log("Pump.fun sniper starting");
  console.log(`  wallet   ${signer.publicKey.toBase58()}`);
  console.log(`  mode     ${config.dryRun ? "DRY RUN (simulate only, nothing is sent)" : "LIVE"}`);
  console.log(`  feed     ${config.feed === "laserstream" ? `LaserStream gRPC ${config.grpcEndpoint}` : "Helius WebSocket (works on the Free plan)"}`);
  console.log(`  rpc      ${redact(config.rpcUrl)}`);
  console.log(`  sender   ${config.senderUrl}`);
  console.log(`  buy      ${config.buySol} SOL + ${config.buyTipSol} SOL tip, slippage ${config.buySlippageBps / 100}%`);
  console.log(`  limits   ${config.maxSolPerDay} SOL/day (spent ${solFromLamports(spentToday())}), ${config.maxOpenPositions} open max, ${positions().length} open now`);
  console.log(`  exits    TP +${config.takeProfitPct}%, SL -${config.stopLossPct}%, max hold ${config.maxHoldSeconds}s`);

  const tipShare = (config.buyTipSol / config.buySol) * 100;
  if (tipShare > 5) {
    console.warn(
      `⚠️  The ${config.buyTipSol} SOL tip is ${tipShare.toFixed(0)}% of each ${config.buySol} SOL buy. With fees, every ` +
        `position starts about ${(tipShare + 2.5).toFixed(0)}% down, close to your ${config.stopLossPct}% stop-loss. ` +
        `Consider a bigger BUY_SOL or a smaller BUY_TIP_SOL.`,
    );
  }

  await loadFees();
  await startBlockhashCache(config.blockhashRefreshMs);
  if (!config.dryRun) startBalanceCache(config.balanceRefreshMs);
  startSenderKeepAlive();
  await startPositionManager();

  if (config.feed === "websocket") {
    startWebsocketFeed(onLaunch, config.maxTxFetchesPerMinute);
    return; // the WebSocket keeps the process running
  }

  let backoff = 1_000;
  for (;;) {
    const started = Date.now();
    try {
      await streamOnce();
    } catch (e) {
      const msg = (e as Error).message ?? "";
      console.error("Stream failed:", msg);
      if (/permission|unauth|denied|forbidden|401|403/i.test(msg)) {
        console.error("LaserStream mainnet needs a Helius Business or Professional plan. On Free or Developer, set FEED=websocket in .env.");
      }
    }
    if (Date.now() - started > 60_000) backoff = 1_000; // it was healthy for a while
    console.log(`Reconnecting in ${backoff / 1000}s...`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30_000);
  }
}

// A stray rejected promise must not kill the bot while it holds positions.
process.on("unhandledRejection", (e) => console.error("Unhandled error (bot keeps running):", (e as Error)?.message ?? e));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} received, stopping. Open positions are saved in ${config.stateFile} and resume on next start.`);
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("Fatal:", e.message ?? e);
  process.exit(1);
});
