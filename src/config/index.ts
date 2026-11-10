import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";

dotenv.config();

function str(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required setting ${name} in .env (see .env.example)`);
}

function num(name: string, fallback: number, { min = -Infinity, max = Infinity } = {}): number {
  const raw = process.env[name]?.trim();
  const v = raw ? Number(raw) : fallback;
  if (!Number.isFinite(v) || v < min || v > max) {
    throw new Error(`${name}=${raw} is invalid (must be a number between ${min} and ${max})`);
  }
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name}=${raw} is invalid (use true or false)`);
}

function list(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

const HELIUS_API_KEY = str("HELIUS_API_KEY");

export const config = {
  heliusApiKey: HELIUS_API_KEY,
  rpcUrl: str("RPC_URL", `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`),
  grpcEndpoint: str("GRPC_ENDPOINT", "https://laserstream-mainnet-lon.helius-rpc.com"),
  grpcToken: str("GRPC_TOKEN", HELIUS_API_KEY),
  senderUrl: str("SENDER_URL", "http://lon-sender.helius-rpc.com/fast"),

  /**
   * How to spot launches. "websocket" works on every Helius plan, including Free.
   * "laserstream" (gRPC) is faster but needs a Business or Professional plan.
   */
  feed: str("FEED", "websocket") as "websocket" | "laserstream",
  /** WebSocket feed only: max full-transaction fetches per minute when logs are incomplete. */
  maxTxFetchesPerMinute: num("MAX_TX_FETCHES_PER_MINUTE", 10, { min: 0, max: 600 }),

  // Background refresh intervals. Defaults are sized for the Helius Free plan (1M credits a month).
  blockhashRefreshMs: num("BLOCKHASH_REFRESH_MS", 15_000, { min: 1_000 }),
  balanceRefreshMs: num("BALANCE_REFRESH_MS", 30_000, { min: 1_000 }),
  /** Dry run: simulate at most one buy per this many ms (each simulation costs a credit). */
  dryRunSimulateEveryMs: num("DRY_RUN_SIMULATE_EVERY_MS", 30_000, { min: 0 }),

  /** When true (the default), trades are simulated and logged but never sent. */
  dryRun: bool("DRY_RUN", true),

  buySol: num("BUY_SOL", 0.01, { min: 0.0001 }),
  buyTipSol: num("BUY_TIP_SOL", 0.001, { min: 0.000005 }),
  sellTipSol: num("SELL_TIP_SOL", 0.0001, { min: 0.000005 }),
  priorityFeeMicroLamports: num("PRIORITY_FEE_MICROLAMPORTS", 200_000, { min: 1 }),
  computeUnitLimit: num("COMPUTE_UNIT_LIMIT", 200_000, { min: 50_000, max: 1_400_000 }),
  buySlippageBps: num("BUY_SLIPPAGE_BPS", 2_000, { min: 0, max: 9_999 }),
  sellSlippageBps: num("SELL_SLIPPAGE_BPS", 1_500, { min: 0, max: 9_999 }),
  /** Extra fee allowance on top of the on-chain fee rates, to cover tiered fees. */
  feeBufferBps: num("FEE_BUFFER_BPS", 100, { min: 0, max: 2_000 }),

  // Spending limits
  maxSolPerTrade: num("MAX_SOL_PER_TRADE", 0.05, { min: 0.0001 }),
  maxSolPerDay: num("MAX_SOL_PER_DAY", 0.5, { min: 0.0001 }),
  maxOpenPositions: num("MAX_OPEN_POSITIONS", 3, { min: 1, max: 50 }),
  minWalletReserveSol: num("MIN_WALLET_RESERVE_SOL", 0.02, { min: 0 }),

  // Exits
  takeProfitPct: num("TAKE_PROFIT_PCT", 100, { min: 1 }),
  stopLossPct: num("STOP_LOSS_PCT", 30, { min: 1, max: 100 }),
  maxHoldSeconds: num("MAX_HOLD_SECONDS", 300, { min: 5 }),
  positionPollMs: num("POSITION_POLL_MS", 3_000, { min: 250 }),

  // Launch filters
  maxDevBuyPct: num("MAX_DEV_BUY_PCT", 10, { min: 0, max: 100 }),
  skipMayhem: bool("SKIP_MAYHEM", true),
  snipeLegacyCreate: bool("SNIPE_LEGACY_CREATE", true),
  blockedCreators: new Set(list("BLOCKED_CREATORS")),
  nameBlocklist: list("NAME_BLOCKLIST").map((s) => s.toLowerCase()),

  // Pipeline
  snipeConcurrency: num("SNIPE_CONCURRENCY", 2, { min: 1, max: 16 }),
  maxQueue: num("MAX_QUEUE", 20, { min: 1 }),
  maxSignalAgeMs: num("MAX_SIGNAL_AGE_MS", 2_500, { min: 100 }),
  dedupeTtlMs: num("DEDUPE_TTL_MS", 600_000, { min: 1_000 }),

  stateFile: str("STATE_FILE", "state/state.json"),
};

if (config.feed !== "websocket" && config.feed !== "laserstream") {
  throw new Error(`FEED=${config.feed} is invalid (use websocket or laserstream)`);
}
if (config.buySol > config.maxSolPerTrade) {
  throw new Error(`BUY_SOL (${config.buySol}) is above MAX_SOL_PER_TRADE (${config.maxSolPerTrade})`);
}
if (config.buySol > config.maxSolPerDay) {
  throw new Error(`BUY_SOL (${config.buySol}) is above MAX_SOL_PER_DAY (${config.maxSolPerDay})`);
}

let cachedSigner: Keypair | null = null;
/** Loaded lazily so the private key is only decoded when actually needed. Never log this. */
export function getSigner(): Keypair {
  if (!cachedSigner) {
    const raw = str("PRIVATE_KEY");
    try {
      cachedSigner = Keypair.fromSecretKey(bs58.decode(raw));
    } catch {
      throw new Error("PRIVATE_KEY is not a valid base58 secret key");
    }
  }
  return cachedSigner;
}

export const connection = new Connection(config.rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: false });

/** Redact API keys before printing URLs. */
export const redact = (url: string) => url.replace(/(api-key=)[^&]+/i, "$1***");
