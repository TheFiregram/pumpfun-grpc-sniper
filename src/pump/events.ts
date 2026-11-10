import { PublicKey } from "@solana/web3.js";
import { BorshReader } from "./borsh";
import { DEFAULT_PUBKEY, EVENT_DISC, EVENT_IX_TAG, TOKEN_PROGRAM } from "./constants";

export interface CreateEvent {
  name: string;
  symbol: string;
  uri: string;
  mint: PublicKey;
  bondingCurve: PublicKey;
  user: PublicKey;
  creator: PublicKey;
  timestamp: bigint;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  tokenProgram: PublicKey;
  isMayhemMode: boolean;
  isCashbackEnabled: boolean;
  quoteMint: PublicKey;
}

export interface TradeEvent {
  mint: PublicKey;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: PublicKey;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
}

export type PumpEvent = { kind: "create"; ev: CreateEvent } | { kind: "trade"; ev: TradeEvent };

function decodeCreate(r: BorshReader): CreateEvent {
  const name = r.string();
  const symbol = r.string();
  const uri = r.string();
  const mint = r.pubkey();
  const bondingCurve = r.pubkey();
  const user = r.pubkey();
  const creator = r.pubkey();
  const timestamp = r.i64();
  const virtualTokenReserves = r.u64();
  const virtualSolReserves = r.u64();
  const realTokenReserves = r.u64();
  const tokenTotalSupply = r.u64();
  // Fields added by later program upgrades: default them so older events still decode.
  const tokenProgram = r.optional(() => r.pubkey(), TOKEN_PROGRAM);
  const isMayhemMode = r.optional(() => r.bool(), false);
  const isCashbackEnabled = r.optional(() => r.bool(), false);
  const quoteMint = r.optional(() => r.pubkey(), DEFAULT_PUBKEY);
  return {
    name, symbol, uri, mint, bondingCurve, user, creator, timestamp,
    virtualTokenReserves, virtualSolReserves, realTokenReserves, tokenTotalSupply,
    tokenProgram, isMayhemMode, isCashbackEnabled, quoteMint,
  };
}

function decodeTrade(r: BorshReader): TradeEvent {
  const mint = r.pubkey();
  const solAmount = r.u64();
  const tokenAmount = r.u64();
  const isBuy = r.bool();
  const user = r.pubkey();
  r.i64(); // timestamp
  const virtualSolReserves = r.u64();
  const virtualTokenReserves = r.u64();
  const realSolReserves = r.u64();
  const realTokenReserves = r.u64();
  return { mint, solAmount, tokenAmount, isBuy, user, virtualSolReserves, virtualTokenReserves, realSolReserves, realTokenReserves };
}

/** Decode a Pump.fun self-CPI event instruction. Returns null for anything else. */
export function decodePumpEventIx(data: Uint8Array): PumpEvent | null {
  const buf = Buffer.from(data);
  if (buf.length < 16 || !buf.subarray(0, 8).equals(EVENT_IX_TAG)) return null;
  const disc = buf.subarray(8, 16);
  const r = new BorshReader(buf.subarray(16));
  try {
    if (disc.equals(EVENT_DISC.create)) return { kind: "create", ev: decodeCreate(r) };
    if (disc.equals(EVENT_DISC.trade)) return { kind: "trade", ev: decodeTrade(r) };
  } catch (e) {
    console.warn("Could not decode pump event:", (e as Error).message);
  }
  return null;
}
