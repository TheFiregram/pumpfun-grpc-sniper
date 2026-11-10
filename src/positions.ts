import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { config, connection, getSigner } from "./config";
import { buildTx, confirm, sendViaSender } from "./executor/sender";
import { decodeBondingCurve } from "./pump/accounts";
import { ammSellV2Ix, ammSolOutForTokensIn, AmmFees, canonicalPoolPda, decodePool, fetchAmmFees, PoolState, tokenAccountAmount } from "./pump/amm";
import { TOKEN_PROGRAM, WSOL_MINT } from "./pump/constants";
import { closeUserAtaIx, createUserAtaIx, sellV3Ix } from "./pump/instructions";
import { solFromLamports, solOutForTokensIn, withSlippageDown } from "./pump/math";
import { ata, bondingCurvePda } from "./pump/pda";
import { Position, positions, removePosition, updatePosition } from "./state";
import { totalFeeBps, tradeAccounts } from "./snipe";

/** Where a position can be sold right now. */
type Venue =
  | { kind: "curve" }
  | { kind: "amm"; pool: PublicKey; state: PoolState }
  | { kind: "migrating" }; // curve complete, pool not created yet: nothing can trade

const MAX_SELL_ATTEMPTS = 8;
const selling = new Set<string>();
const sellFailures = new Map<string, number>();
const migratingSince = new Map<string, number>();
let ammFees: AmmFees | null = null;

/**
 * Poll open positions and sell on take-profit, stop-loss or max hold time.
 * Coins still on the bonding curve are sold there; coins that graduated are sold on PumpSwap.
 * Positions are saved to disk, so they survive a restart.
 */
export async function startPositionManager() {
  if (config.dryRun) return; // dry-run never opens positions
  ammFees = await fetchAmmFees(connection);
  console.log(`PumpSwap fees: ${ammFees.totalBps} bps total`);
  const tick = async () => {
    try {
      await checkAll();
    } catch (e) {
      console.warn("Position check failed:", (e as Error).message);
    } finally {
      setTimeout(tick, config.positionPollMs);
    }
  };
  void tick();
}

async function checkAll() {
  const open = positions().filter((p) => !selling.has(p.mint) && !p.stuck);
  if (open.length === 0) return;
  const mints = open.map((p) => new PublicKey(p.mint));
  const curveInfos = await connection.getMultipleAccountsInfo(mints.map(bondingCurvePda), "processed");
  // Decode each curve on its own so one bad account can't block the other positions.
  const curves = curveInfos.map((info, i) => {
    if (!info) return null;
    try {
      return decodeBondingCurve(info.data);
    } catch (e) {
      console.warn(`${open[i].symbol}: could not read bonding curve:`, (e as Error).message);
      return undefined; // skip this position this tick
    }
  });

  // Graduated coins (curve complete or closed): look up their PumpSwap pools in one batch.
  const gradIdx = open.map((_, i) => i).filter((i) => curves[i] === null || curves[i]?.complete === true);
  const poolKeys = gradIdx.map((i) => canonicalPoolPda(mints[i]));
  const poolInfos = poolKeys.length ? await connection.getMultipleAccountsInfo(poolKeys, "processed") : [];
  const pools = new Map<number, { pool: PublicKey; state: PoolState }>();
  gradIdx.forEach((i, j) => {
    const info = poolInfos[j];
    if (!info) return;
    try {
      pools.set(i, { pool: poolKeys[j], state: decodePool(info.data) });
    } catch (e) {
      console.warn(`${open[i].symbol}: could not read PumpSwap pool:`, (e as Error).message);
    }
  });
  // Pool vault balances, for pricing.
  const vaultKeys = [...pools.values()].flatMap((p) => [p.state.poolBaseTokenAccount, p.state.poolQuoteTokenAccount]);
  const vaultInfos = vaultKeys.length ? await connection.getMultipleAccountsInfo(vaultKeys, "processed") : [];
  const vaults = new Map<string, bigint>();
  vaultKeys.forEach((k, j) => {
    const info = vaultInfos[j];
    if (info && info.data.length >= 72) vaults.set(k.toBase58(), tokenAccountAmount(info.data));
  });

  for (let i = 0; i < open.length; i++) {
    const p = open[i];
    const tokens = BigInt(p.tokens);
    let venue: Venue;
    let value: bigint;

    const curve = curves[i];
    if (curve === undefined) continue;
    if (!gradIdx.includes(i)) {
      venue = { kind: "curve" };
      value = solOutForTokensIn(curve!, tokens, totalFeeBps());
      migratingSince.delete(p.mint);
    } else if (pools.has(i)) {
      const { pool, state } = pools.get(i)!;
      const base = vaults.get(state.poolBaseTokenAccount.toBase58());
      const quote = vaults.get(state.poolQuoteTokenAccount.toBase58());
      if (base === undefined || quote === undefined) continue;
      if (migratingSince.delete(p.mint)) console.log(`🎓 ${p.symbol}: now trading on PumpSwap`);
      venue = { kind: "amm", pool, state };
      value = ammSolOutForTokensIn(base, quote + state.virtualQuoteReserves, tokens, ammFees!.totalBps + BigInt(config.feeBufferBps));
    } else {
      if (!migratingSince.has(p.mint)) {
        migratingSince.set(p.mint, Date.now());
        console.log(`🎓 ${p.symbol}: bonding curve complete, waiting for the PumpSwap pool to open`);
      }
      continue; // nothing can trade until migration finishes; check again next tick
    }

    const cost = BigInt(p.costLamports);
    const pnlPct = cost > 0n ? (Number(value - cost) / Number(cost)) * 100 : 0;
    const ageS = (Date.now() - p.openedAt) / 1000;

    let reason: string | null = null;
    if (pnlPct >= config.takeProfitPct) reason = `take-profit ${pnlPct.toFixed(1)}%`;
    else if (pnlPct <= -config.stopLossPct) reason = `stop-loss ${pnlPct.toFixed(1)}%`;
    else if (ageS >= config.maxHoldSeconds) reason = `max hold ${Math.round(ageS)}s (${pnlPct.toFixed(1)}%)`;
    if (reason) void sell(p, venue, value, reason);
  }
}

async function sell(p: Position, venue: Venue, expectedLamports: bigint, reason: string) {
  if (venue.kind === "migrating") return;
  selling.add(p.mint);
  const signer = getSigner();
  const user = signer.publicKey;
  const mint = new PublicKey(p.mint);
  const tokenProgram = new PublicKey(p.baseTokenProgram);
  try {
    // Sell what the wallet actually holds, not what we think it holds.
    const bal = await connection.getTokenAccountBalance(ata(mint, user, tokenProgram), "processed");
    const amount = BigInt(bal.value.amount);
    if (amount === 0n) {
      removePosition(p.mint);
      return;
    }
    const scaled = amount === BigInt(p.tokens) ? expectedLamports : (expectedLamports * amount) / BigInt(p.tokens);
    // Each failed attempt widens slippage by 10 points (max 90%) so a falling coin still gets out.
    const tries = sellFailures.get(p.mint) ?? 0;
    const slip = Math.min(config.sellSlippageBps + tries * 1_000, 9_000);
    const minOut = withSlippageDown(scaled, BigInt(slip));

    let ixs: TransactionInstruction[];
    if (venue.kind === "curve") {
      ixs = [sellV3Ix(tradeAccounts(mint, tokenProgram, user), amount, minOut), closeUserAtaIx(user, mint, tokenProgram)];
    } else {
      // PumpSwap pays out wrapped SOL: open a wSOL account, sell, then close both accounts
      // (closing the wSOL account unwraps it back to plain SOL and returns both rents).
      const list = ammFees!.buybackFeeRecipients;
      const recipient = list[Math.floor(Math.random() * list.length)];
      ixs = [
        createUserAtaIx(user, user, WSOL_MINT, TOKEN_PROGRAM),
        ammSellV2Ix(venue.pool, venue.state, user, tokenProgram, recipient, amount, minOut),
        closeUserAtaIx(user, mint, tokenProgram),
        closeUserAtaIx(user, WSOL_MINT, TOKEN_PROGRAM),
      ];
    }

    const built = await buildTx(ixs, signer, config.sellTipSol);
    await sendViaSender(built.tx);
    const where = venue.kind === "curve" ? "bonding curve" : "PumpSwap";
    console.log(`📤 ${p.symbol}: selling on ${where} (${reason}), min ${solFromLamports(minOut)} SOL https://solscan.io/tx/${built.signature}`);
    const res = await confirm(built);
    if (res.ok) {
      console.log(`✅ ${p.symbol}: sold, ~${solFromLamports(scaled)} SOL back + token account rent`);
      removePosition(p.mint);
      sellFailures.delete(p.mint);
    } else {
      failed(p, tries + 1, JSON.stringify(res.err), amount);
    }
  } catch (e) {
    failed(p, (sellFailures.get(p.mint) ?? 0) + 1, (e as Error).message);
  } finally {
    selling.delete(p.mint);
  }
}

/** Count a failed sell. After MAX_SELL_ATTEMPTS, stop retrying (each try costs a fee) and flag it. */
function failed(p: Position, attempt: number, why: string, amount?: bigint) {
  sellFailures.set(p.mint, attempt);
  if (attempt >= MAX_SELL_ATTEMPTS) {
    console.error(`🛑 ${p.symbol}: ${attempt} sells failed (${why}). Stopped retrying; sell ${p.mint} manually, then remove it from ${config.stateFile}.`);
    updatePosition(p.mint, { stuck: true, ...(amount !== undefined ? { tokens: amount.toString() } : {}) });
  } else {
    console.log(`❌ ${p.symbol}: sell failed (${why}), attempt ${attempt}/${MAX_SELL_ATTEMPTS}. Will retry.`);
    if (amount !== undefined) updatePosition(p.mint, { tokens: amount.toString() });
  }
}
