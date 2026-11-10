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
  const open = positions().filter((p) => !selling.has(p.mint));
  if (open.length === 0) return;
  const mints = open.map((p) => new PublicKey(p.mint));
  const curves = await connection.getMultipleAccountsInfo(mints.map(bondingCurvePda), "processed");

  // Graduated coins: look up their PumpSwap pools in one batch.
  const gradIdx = open.map((_, i) => i).filter((i) => {
    const info = curves[i];
    return !info || decodeBondingCurve(info.data).complete;
  });
  const poolKeys = gradIdx.map((i) => canonicalPoolPda(mints[i]));
  const poolInfos = poolKeys.length ? await connection.getMultipleAccountsInfo(poolKeys, "processed") : [];
  const pools = new Map<number, { pool: PublicKey; state: PoolState }>();
  gradIdx.forEach((i, j) => {
    const info = poolInfos[j];
    if (info) pools.set(i, { pool: poolKeys[j], state: decodePool(info.data) });
  });
  // Pool vault balances, for pricing.
  const vaultKeys = [...pools.values()].flatMap((p) => [p.state.poolBaseTokenAccount, p.state.poolQuoteTokenAccount]);
  const vaultInfos = vaultKeys.length ? await connection.getMultipleAccountsInfo(vaultKeys, "processed") : [];
  const vaults = new Map<string, bigint>();
  vaultKeys.forEach((k, j) => vaultInfos[j] && vaults.set(k.toBase58(), tokenAccountAmount(vaultInfos[j]!.data)));

  for (let i = 0; i < open.length; i++) {
    const p = open[i];
    const tokens = BigInt(p.tokens);
    let venue: Venue;
    let value: bigint;

    if (!gradIdx.includes(i)) {
      venue = { kind: "curve" };
      value = solOutForTokensIn(decodeBondingCurve(curves[i]!.data), tokens, totalFeeBps());
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
      sellFailures.set(p.mint, tries + 1);
      console.log(`❌ ${p.symbol}: sell failed (${JSON.stringify(res.err)}), attempt ${tries + 1}. Will retry.`);
      updatePosition(p.mint, { tokens: amount.toString() });
    }
  } catch (e) {
    console.error(`❌ ${p.symbol}: sell error:`, (e as Error).message);
  } finally {
    selling.delete(p.mint);
  }
}
