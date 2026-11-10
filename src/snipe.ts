import { PublicKey } from "@solana/web3.js";
import { config, connection, getSigner } from "./config";
import { buildTx, confirm, sendViaSender, simulate } from "./executor/sender";
import { fetchGlobalFees, GlobalFees } from "./pump/accounts";
import { Launch } from "./pump/detect";
import { buyExactSolInV3Ix, createUserAtaIx, TradeAccountsArgs } from "./pump/instructions";
import { lamportsFromSol, solFromLamports, tokensOutForSolIn, withSlippageDown } from "./pump/math";
import { ata } from "./pump/pda";
import { tokenAccountAmount } from "./pump/amm";
import { addPosition, commitSpend, release, tryReserve } from "./state";

let fees: GlobalFees | null = null;

export async function loadFees() {
  fees = await fetchGlobalFees(connection);
  console.log(
    `Pump.fun fees: protocol ${fees.feeBps} bps, creator ${fees.creatorFeeBps} bps, buyback ${fees.buybackBps} bps ` +
      `(+${config.feeBufferBps} bps buffer), ${fees.buybackFeeRecipients.length} buyback recipients`,
  );
}

export function totalFeeBps(): bigint {
  if (!fees) throw new Error("fees not loaded");
  return fees.feeBps + fees.creatorFeeBps + fees.buybackBps + BigInt(config.feeBufferBps);
}

export function tradeAccounts(mint: PublicKey, baseTokenProgram: PublicKey, user: PublicKey): TradeAccountsArgs {
  if (!fees) throw new Error("fees not loaded");
  const list = fees.buybackFeeRecipients;
  return { mint, baseTokenProgram, user, buybackFeeRecipient: list[Math.floor(Math.random() * list.length)] };
}

let inFlight = 0;
let lastDryRunSim = 0;

// ---------- Wallet balance cache ----------
let balanceCache: { lamports: bigint; at: number } | null = null;
export function startBalanceCache(intervalMs: number) {
  const refresh = () =>
    connection
      .getBalance(getSigner().publicKey, "processed")
      .then((l) => (balanceCache = { lamports: BigInt(l), at: Date.now() }))
      .catch(() => undefined);
  void refresh();
  setInterval(refresh, intervalMs).unref();
}
/** Cached balance, or null if it is missing or stale (then the check is skipped, not failed). */
function walletLamports(): bigint | null {
  return balanceCache && Date.now() - balanceCache.at < 3 * config.balanceRefreshMs ? balanceCache.lamports : null;
}

/** Raw token balance of an account: 0n if it doesn't exist, null if the RPC kept failing. */
export async function readTokenBalance(account: PublicKey, tries = 4): Promise<bigint | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const info = await connection.getAccountInfo(account, "confirmed");
      return info ? tokenAccountAmount(info.data) : 0n;
    } catch {
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  return null;
}

/**
 * Buy a freshly launched coin. Never throws: logs and returns.
 * `deadline` is checked right before signing, so a stale signal is dropped instead of bought late.
 */
export async function snipe(launch: Launch, deadline: number): Promise<void> {
  const c = launch.create;
  const tag = `${c.symbol} ${c.mint.toBase58()}`;
  const signer = getSigner();

  const spend = lamportsFromSol(config.buySol);
  const cost = spend + lamportsFromSol(config.buyTipSol);
  if (!tryReserve(cost, lamportsFromSol(config.maxSolPerDay), config.maxOpenPositions, inFlight)) {
    console.log(`⏭️  ${tag}: skipped, daily limit or max open positions reached`);
    return;
  }
  inFlight++;
  let committed = false;

  try {
    // Expected tokens from the curve state at the end of the launch tx, then the slippage floor.
    const expected = tokensOutForSolIn(launch.curveAfterTx, spend, totalFeeBps());
    const minTokensOut = withSlippageDown(expected, BigInt(config.buySlippageBps));
    if (minTokensOut <= 0n) {
      console.log(`⏭️  ${tag}: quote came out as zero tokens`);
      return;
    }

    const accts = tradeAccounts(c.mint, c.tokenProgram, signer.publicKey);
    const ixs = [
      createUserAtaIx(signer.publicKey, signer.publicKey, c.mint, c.tokenProgram),
      buyExactSolInV3Ix(accts, spend, minTokensOut),
    ];

    if (Date.now() > deadline) {
      console.log(`⏭️  ${tag}: signal too old, not buying`);
      return;
    }
    const built = await buildTx(ixs, signer, config.buyTipSol);

    if (config.dryRun) {
      if (Date.now() - lastDryRunSim < config.dryRunSimulateEveryMs) {
        console.log(`🧪 DRY RUN ${tag}: would buy ${config.buySol} SOL, expect ~${expected} raw tokens (not simulated, to save credits)`);
        return;
      }
      lastDryRunSim = Date.now();
      const sim = await simulate(built.tx);
      console.log(
        `🧪 DRY RUN ${tag}: spend ${config.buySol} SOL, expect ~${expected} raw tokens (min ${minTokensOut}). ` +
          (sim.err ? `Simulation FAILED: ${JSON.stringify(sim.err)}` : `Simulation OK, ${sim.unitsConsumed} CU`),
      );
      if (sim.err) console.log(sim.logs.slice(-8).join("\n"));
      return;
    }

    // Balance check from a cached value (refreshed in the background) so it adds no latency.
    const balance = walletLamports();
    const needed = cost + lamportsFromSol(config.minWalletReserveSol) + 3_000_000n; // + ATA and volume-account rent
    if (balance !== null && balance < needed) {
      console.log(`⏭️  ${tag}: wallet has ${solFromLamports(balance!)} SOL, needs ${solFromLamports(needed)}`);
      return;
    }

    await sendViaSender(built.tx);
    console.log(`📤 ${tag}: buy sent https://solscan.io/tx/${built.signature}`);
    const res = await confirm(built);

    // Decide by what the wallet holds, not only by the confirmation result: a buy can land
    // after confirm() gives up, and those tokens must still be tracked and sold.
    const held = await readTokenBalance(ata(c.mint, signer.publicKey, c.tokenProgram));
    if (held === 0n || (held === null && !res.ok)) {
      // A failed tx only costs the network fee; the tip transfer is rolled back with it.
      console.log(`❌ ${tag}: buy did not land (${JSON.stringify(res.err)})`);
      return;
    }

    commitSpend(cost);
    committed = true;
    // If the balance couldn't be read, record the minimum we were guaranteed; sells re-read the real balance.
    const tokens = held ?? minTokensOut;
    addPosition({
      mint: c.mint.toBase58(),
      symbol: c.symbol,
      baseTokenProgram: c.tokenProgram.toBase58(),
      tokens: tokens.toString(),
      costLamports: cost.toString(), // buy + tip, so P&L is honest
      openedAt: Date.now(),
      buySignature: built.signature,
    });
    console.log(`✅ ${tag}: bought ${Number(tokens) / 1e6} tokens for ${config.buySol} SOL`);
  } catch (e) {
    console.error(`❌ ${tag}: snipe error:`, (e as Error).message);
  } finally {
    inFlight--;
    if (!committed) release(cost);
  }
}
