import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { config, connection } from "./config";
import { getBlockhash, sendBundleViaSender, simulate, tipIx } from "./executor/sender";
import { decodeBondingCurve } from "./pump/accounts";
import { buyExactSolInV3Ix, createUserAtaIx } from "./pump/instructions";
import { lamportsFromSol, tokensOutForSolIn, withSlippageDown } from "./pump/math";
import { bondingCurvePda } from "./pump/pda";
import { loadFees, totalFeeBps, tradeAccounts } from "./snipe";

/**
 * Buy one coin from several wallets in one transaction (uses a lookup table to fit).
 * Respects DRY_RUN: simulates only unless DRY_RUN=false.
 * Note: buying your own launch from many wallets to look like independent demand can be
 * treated as market manipulation. Use this for your own wallets' positions, not to mislead buyers.
 */
export const bundleBuyWithLookup = async (
  lookupAddress: PublicKey,
  mint: PublicKey,
  baseTokenProgram: PublicKey,
  wallets: Keypair[],
  solPerWallet: number,
) => {
  if (wallets.length === 0) throw new Error("No wallets to buy with");
  if (solPerWallet > config.maxSolPerTrade) throw new Error(`solPerWallet is above MAX_SOL_PER_TRADE (${config.maxSolPerTrade})`);
  if (solPerWallet * wallets.length > config.maxSolPerDay) throw new Error("Bundle total is above MAX_SOL_PER_DAY");

  const table = (await connection.getAddressLookupTable(lookupAddress)).value;
  if (!table) throw new Error("Lookup table not found");

  await loadFees();
  const curveInfo = await connection.getAccountInfo(bondingCurvePda(mint), "processed");
  if (!curveInfo) throw new Error("Bonding curve not found for this mint");
  const curve = decodeBondingCurve(curveInfo.data);
  if (curve.complete) throw new Error("Curve is complete; this coin trades on PumpSwap now");

  const spend = lamportsFromSol(solPerWallet);
  // Each wallet's buy moves the price for the next one, so quote them in order.
  let sim = { ...curve };
  const ixs = [
    // Each buy needs roughly 100k CU, so size the limit to the number of wallets.
    ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, 40_000 + 110_000 * wallets.length) }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports }),
  ];
  for (const kp of wallets) {
    const out = tokensOutForSolIn(sim, spend, totalFeeBps());
    ixs.push(
      createUserAtaIx(kp.publicKey, kp.publicKey, mint, baseTokenProgram),
      buyExactSolInV3Ix(tradeAccounts(mint, baseTokenProgram, kp.publicKey), spend, withSlippageDown(out, BigInt(config.buySlippageBps))),
    );
    sim = {
      ...sim,
      virtualSolReserves: sim.virtualSolReserves + spend,
      virtualTokenReserves: sim.virtualTokenReserves - out,
      realTokenReserves: sim.realTokenReserves - out,
    };
  }
  ixs.push(tipIx(wallets[0].publicKey, config.buyTipSol));

  const blockhash = await getBlockhash();
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: wallets[0].publicKey, recentBlockhash: blockhash.blockhash, instructions: ixs }).compileToV0Message([table]),
  );
  const size = tx.serialize().byteLength; // throws if too large, before signing
  tx.sign(wallets);
  console.log(`Bundle transaction: ${wallets.length} wallets, ${size} bytes`);

  const res = await simulate(tx);
  if (res.err) {
    console.log("Simulation failed:", JSON.stringify(res.err), "\n" + res.logs.slice(-10).join("\n"));
    return null;
  }
  console.log(`Simulation OK (${res.unitsConsumed} CU)`);
  if (config.dryRun) {
    console.log("DRY_RUN is on, not sending.");
    return null;
  }
  const id = await sendBundleViaSender([tx]);
  console.log("Bundle sent:", id);
  return id;
};
