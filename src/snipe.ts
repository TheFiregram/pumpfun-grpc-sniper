import { PublicKey } from "@solana/web3.js";
import { config, connection, getSigner } from "./config";
import { buildTx, confirm, sendViaSender, simulate } from "./executor/sender";
import { fetchGlobalFees, GlobalFees } from "./pump/accounts";
import { Launch } from "./pump/detect";
import { buyExactSolInV3Ix, createUserAtaIx, TradeAccountsArgs } from "./pump/instructions";
import { lamportsFromSol, solFromLamports, tokensOutForSolIn, withSlippageDown } from "./pump/math";
import { ata } from "./pump/pda";
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
      const sim = await simulate(built.tx);
      console.log(
        `🧪 DRY RUN ${tag}: spend ${config.buySol} SOL, expect ~${expected} raw tokens (min ${minTokensOut}). ` +
          (sim.err ? `Simulation FAILED: ${JSON.stringify(sim.err)}` : `Simulation OK, ${sim.unitsConsumed} CU`),
      );
      if (sim.err) console.log(sim.logs.slice(-8).join("\n"));
      return;
    }

    // Balance check: keep enough SOL for sell fees and tips.
    const balance = BigInt(await connection.getBalance(signer.publicKey, "processed"));
    const needed = cost + lamportsFromSol(config.minWalletReserveSol) + 3_000_000n; // + ATA and volume-account rent
    if (balance < needed) {
      console.log(`⏭️  ${tag}: wallet has ${solFromLamports(balance)} SOL, needs ${solFromLamports(needed)}`);
      return;
    }

    await sendViaSender(built.tx);
    console.log(`📤 ${tag}: buy sent https://solscan.io/tx/${built.signature}`);
    const res = await confirm(built);
    // A landed-but-failed tx only costs the network fee; the tip transfer is rolled back with it.
    if (!res.ok) {
      console.log(`❌ ${tag}: buy did not land (${JSON.stringify(res.err)})`);
      return;
    }

    commitSpend(cost);
    committed = true;
    const bal = await connection.getTokenAccountBalance(ata(c.mint, signer.publicKey, c.tokenProgram), "confirmed");
    addPosition({
      mint: c.mint.toBase58(),
      symbol: c.symbol,
      baseTokenProgram: c.tokenProgram.toBase58(),
      tokens: bal.value.amount,
      costLamports: spend.toString(),
      openedAt: Date.now(),
      buySignature: built.signature,
    });
    console.log(`✅ ${tag}: bought ${bal.value.uiAmountString} tokens for ${config.buySol} SOL`);
  } catch (e) {
    console.error(`❌ ${tag}: snipe error:`, (e as Error).message);
  } finally {
    inFlight--;
    if (!committed) release(cost);
  }
}
