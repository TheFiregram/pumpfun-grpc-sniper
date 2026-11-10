import { PublicKey } from "@solana/web3.js";
import { config, connection, getSigner } from "./config";
import { buildTx, confirm, sendViaSender } from "./executor/sender";
import { decodeBondingCurve } from "./pump/accounts";
import { closeUserAtaIx, sellV3Ix } from "./pump/instructions";
import { solFromLamports, solOutForTokensIn, withSlippageDown } from "./pump/math";
import { ata, bondingCurvePda } from "./pump/pda";
import { Position, positions, removePosition, updatePosition } from "./state";
import { totalFeeBps, tradeAccounts } from "./snipe";

const selling = new Set<string>();
const sellFailures = new Map<string, number>();

/**
 * Poll open positions and sell on take-profit, stop-loss or max hold time.
 * Positions are saved to disk, so they survive a restart.
 */
export function startPositionManager() {
  if (config.dryRun) return; // dry-run never opens positions
  const tick = async () => {
    try {
      await checkAll();
    } catch (e) {
      console.warn("Position check failed:", (e as Error).message);
    } finally {
      setTimeout(tick, config.positionPollMs);
    }
  };
  tick();
}

async function checkAll() {
  const open = positions().filter((p) => !selling.has(p.mint));
  if (open.length === 0) return;
  const curves = await connection.getMultipleAccountsInfo(open.map((p) => bondingCurvePda(new PublicKey(p.mint))), "processed");

  for (let i = 0; i < open.length; i++) {
    const p = open[i];
    const info = curves[i];
    if (!info) continue;
    const curve = decodeBondingCurve(info.data);
    if (curve.complete) {
      console.log(`🎓 ${p.symbol}: curve completed and is migrating to PumpSwap. Sell it there manually.`);
      removePosition(p.mint);
      continue;
    }
    const tokens = BigInt(p.tokens);
    const value = solOutForTokensIn(curve, tokens, totalFeeBps());
    const cost = BigInt(p.costLamports);
    const pnlPct = cost > 0n ? (Number(value - cost) / Number(cost)) * 100 : 0;
    const ageS = (Date.now() - p.openedAt) / 1000;

    let reason: string | null = null;
    if (pnlPct >= config.takeProfitPct) reason = `take-profit ${pnlPct.toFixed(1)}%`;
    else if (pnlPct <= -config.stopLossPct) reason = `stop-loss ${pnlPct.toFixed(1)}%`;
    else if (ageS >= config.maxHoldSeconds) reason = `max hold ${Math.round(ageS)}s (${pnlPct.toFixed(1)}%)`;
    if (reason) void sell(p, value, reason);
  }
}

async function sell(p: Position, expectedLamports: bigint, reason: string) {
  selling.add(p.mint);
  const signer = getSigner();
  const mint = new PublicKey(p.mint);
  const tokenProgram = new PublicKey(p.baseTokenProgram);
  try {
    // Sell what the wallet actually holds, not what we think it holds.
    const bal = await connection.getTokenAccountBalance(ata(mint, signer.publicKey, tokenProgram), "processed");
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
    const built = await buildTx(
      [sellV3Ix(tradeAccounts(mint, tokenProgram, signer.publicKey), amount, minOut), closeUserAtaIx(signer.publicKey, mint, tokenProgram)],
      signer,
      config.sellTipSol,
    );
    await sendViaSender(built.tx);
    console.log(`📤 ${p.symbol}: selling (${reason}), min ${solFromLamports(minOut)} SOL https://solscan.io/tx/${built.signature}`);
    const res = await confirm(built);
    if (res.ok) {
      console.log(`✅ ${p.symbol}: sold, ~${solFromLamports(scaled)} SOL back + token account rent`);
      removePosition(p.mint);
      sellFailures.delete(p.mint);
    } else {
      const n = (sellFailures.get(p.mint) ?? 0) + 1;
      sellFailures.set(p.mint, n);
      console.log(`❌ ${p.symbol}: sell failed (${JSON.stringify(res.err)}), attempt ${n}. Will retry.`);
      updatePosition(p.mint, { tokens: amount.toString() });
    }
  } catch (e) {
    console.error(`❌ ${p.symbol}: sell error:`, (e as Error).message);
  } finally {
    selling.delete(p.mint);
  }
}
