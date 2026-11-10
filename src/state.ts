import fs from "fs";
import path from "path";
import { config } from "./config";

export interface Position {
  mint: string;
  symbol: string;
  baseTokenProgram: string;
  tokens: string; // raw units, stored as string because JSON has no bigint
  costLamports: string;
  openedAt: number;
  buySignature: string;
}

interface StateFile {
  day: string; // YYYY-MM-DD (UTC)
  spentLamportsToday: string;
  positions: Position[];
}

const today = () => new Date().toISOString().slice(0, 10);

function load(): StateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.stateFile, "utf8")) as StateFile;
    if (!Array.isArray(parsed.positions)) throw new Error("bad state file");
    return parsed;
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      // Never silently throw away open positions: keep the unreadable file for inspection.
      const backup = `${config.stateFile}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(config.stateFile, backup); } catch { /* nothing to back up */ }
      console.warn(`⚠️  Could not read ${config.stateFile} (${e?.message}). Backed it up to ${backup}.`);
    }
    return { day: today(), spentLamportsToday: "0", positions: [] };
  }
}

const state: StateFile = load();

function save() {
  const dir = path.dirname(config.stateFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${config.stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, config.stateFile); // atomic replace: a crash can't leave a half-written file
}

function rollDay() {
  if (state.day !== today()) {
    state.day = today();
    state.spentLamportsToday = "0";
    save();
  }
}

// ---------- Spending limits ----------
let reservedLamports = 0n; // in-flight buys that haven't landed yet

export function spentToday(): bigint {
  rollDay();
  return BigInt(state.spentLamportsToday);
}

/** Reserve budget before sending. Returns false if it would break the daily limit or open-position cap. */
export function tryReserve(lamports: bigint, maxPerDay: bigint, maxOpen: number, inFlight: number): boolean {
  rollDay();
  if (state.positions.length + inFlight >= maxOpen) return false;
  if (spentToday() + reservedLamports + lamports > maxPerDay) return false;
  reservedLamports += lamports;
  return true;
}

export function release(lamports: bigint) {
  reservedLamports -= lamports;
  if (reservedLamports < 0n) reservedLamports = 0n;
}

export function commitSpend(lamports: bigint) {
  release(lamports);
  rollDay();
  state.spentLamportsToday = (BigInt(state.spentLamportsToday) + lamports).toString();
  save();
}

// ---------- Positions ----------
export const positions = (): Position[] => state.positions;

export function addPosition(p: Position) {
  state.positions.push(p);
  save();
}

export function removePosition(mint: string) {
  state.positions = state.positions.filter((p) => p.mint !== mint);
  save();
}

export function updatePosition(mint: string, patch: Partial<Position>) {
  const p = state.positions.find((x) => x.mint === mint);
  if (p) {
    Object.assign(p, patch);
    save();
  }
}
