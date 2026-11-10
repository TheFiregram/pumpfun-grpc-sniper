// Bonding-curve maths in bigint (lamports and raw token units). Constant product on the virtual reserves;
// fees are charged on the SOL side, so they are removed from the input (buy) or the output (sell).

const BPS = 10_000n;

export interface CurveReserves {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
}

/** Tokens received for spending `solIn` lamports (fees included), capped at the real reserves left. */
export function tokensOutForSolIn(curve: CurveReserves, solIn: bigint, totalFeeBps: bigint): bigint {
  if (solIn <= 0n || curve.virtualSolReserves <= 0n || curve.virtualTokenReserves <= 0n) return 0n;
  const net = (solIn * BPS) / (BPS + totalFeeBps);
  const out = (curve.virtualTokenReserves * net) / (curve.virtualSolReserves + net);
  return out < curve.realTokenReserves ? out : curve.realTokenReserves;
}

/** Lamports received for selling `tokensIn`, after fees. */
export function solOutForTokensIn(curve: CurveReserves, tokensIn: bigint, totalFeeBps: bigint): bigint {
  if (tokensIn <= 0n || curve.virtualTokenReserves <= 0n) return 0n;
  const gross = (curve.virtualSolReserves * tokensIn) / (curve.virtualTokenReserves + tokensIn);
  const fee = (gross * totalFeeBps + BPS - 1n) / BPS; // round fee up, like the program
  return gross > fee ? gross - fee : 0n;
}

/** Apply a slippage tolerance to a minimum-out amount. */
export function withSlippageDown(amount: bigint, slippageBps: bigint): bigint {
  if (slippageBps >= BPS) return 0n;
  return (amount * (BPS - slippageBps)) / BPS;
}

export function lamportsFromSol(sol: number): bigint {
  // Avoid float drift: round to the nearest lamport.
  return BigInt(Math.round(sol * 1e9));
}

export function solFromLamports(lamports: bigint): number {
  return Number(lamports) / 1e9;
}
