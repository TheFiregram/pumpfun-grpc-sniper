import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { DEFAULT_PUBKEY, DISC, PUMP_PROGRAM_ID, WSOL_MINT } from "./constants";
import { CreateEvent, decodePumpEventIx, TradeEvent } from "./events";
import { CurveReserves } from "./math";

export interface Launch {
  signature: string;
  slot: string;
  receivedAt: number;
  create: CreateEvent;
  /** Curve state after everything in the create transaction (including the creator's own buy). */
  curveAfterTx: CurveReserves;
  /** Tokens the creator bought in the launch transaction, raw units. */
  devBuyTokens: bigint;
  isSolPaired: boolean;
  instruction: "create" | "create_v2";
}

interface RawIx {
  programIdIndex: number;
  accounts: Uint8Array;
  data: Uint8Array;
}

/**
 * Parse a Yellowstone/LaserStream transaction update into zero or more Pump.fun launches.
 * Looks at top-level AND inner instructions (launches made through routers are CPIs), and resolves
 * account indexes against the full key list including address-lookup-table addresses.
 */
export function parseLaunches(update: any, receivedAt: number): Launch[] {
  const txInfo = update?.transaction?.transaction;
  const message = txInfo?.transaction?.message;
  const meta = txInfo?.meta;
  if (!txInfo || !message || !meta) return [];
  if (meta.err) return []; // failed transactions created nothing

  const keys: PublicKey[] = [
    ...(message.accountKeys ?? []),
    ...(meta.loadedWritableAddresses ?? []),
    ...(meta.loadedReadonlyAddresses ?? []),
  ].map((k: Uint8Array) => new PublicKey(k));
  const isPump = (ix: RawIx) => keys[ix.programIdIndex]?.equals(PUMP_PROGRAM_ID) ?? false;

  const allIxs: RawIx[] = [...(message.instructions ?? [])];
  for (const inner of meta.innerInstructions ?? []) allIxs.push(...(inner.instructions ?? []));

  let createKind: "create" | "create_v2" | null = null;
  const creates: CreateEvent[] = [];
  const trades: TradeEvent[] = [];

  for (const ix of allIxs) {
    if (!isPump(ix) || !ix.data || ix.data.length < 8) continue;
    const head = Buffer.from(ix.data.subarray(0, 8));
    if (head.equals(DISC.createV2)) createKind = "create_v2";
    else if (head.equals(DISC.create)) createKind = createKind ?? "create";
    const ev = decodePumpEventIx(ix.data);
    if (ev?.kind === "create") creates.push(ev.ev);
    else if (ev?.kind === "trade") trades.push(ev.ev);
  }
  if (!createKind || creates.length === 0) return [];

  const signature = bs58.encode(Buffer.from(txInfo.signature));
  const slot = String(update.transaction?.slot ?? "");
  return buildLaunches(signature, slot, receivedAt, createKind, creates, trades);
}

/** Turn the create/trade events of one transaction into launches (shared by the gRPC and WebSocket feeds). */
export function buildLaunches(
  signature: string,
  slot: string,
  receivedAt: number,
  kind: "create" | "create_v2",
  creates: CreateEvent[],
  trades: TradeEvent[],
): Launch[] {
  return creates.map((create) => {
    const mintTrades = trades.filter((t) => t.mint.equals(create.mint));
    const last = mintTrades[mintTrades.length - 1];
    const curveAfterTx: CurveReserves = last
      ? { virtualTokenReserves: last.virtualTokenReserves, virtualSolReserves: last.virtualSolReserves, realTokenReserves: last.realTokenReserves }
      : { virtualTokenReserves: create.virtualTokenReserves, virtualSolReserves: create.virtualSolReserves, realTokenReserves: create.realTokenReserves };
    const devBuyTokens = mintTrades
      .filter((t) => t.isBuy && (t.user.equals(create.user) || t.user.equals(create.creator)))
      .reduce((s, t) => s + t.tokenAmount, 0n);
    const isSolPaired = create.quoteMint.equals(DEFAULT_PUBKEY) || create.quoteMint.equals(WSOL_MINT);
    return { signature, slot, receivedAt, create, curveAfterTx, devBuyTokens, isSolPaired, instruction: kind };
  });
}
