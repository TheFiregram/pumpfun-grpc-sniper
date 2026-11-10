import { config } from "./config";
import { Launch } from "./pump/detect";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./pump/constants";

/**
 * Cheap checks that need no RPC call, run before every buy.
 * Pump.fun mints are created by the program with its own mint authority and no freeze authority,
 * so the usual "can the dev mint more / freeze me" rug checks are enforced by the program itself.
 * The real risks on a fresh launch are a large dev bag, odd coin types, and known bad creators.
 * Returns a reason to skip, or null to proceed.
 */
export function skipReason(l: Launch): string | null {
  const c = l.create;
  if (!l.isSolPaired) return "not paired with SOL";
  if (c.isCashbackEnabled) return "cashback coin (v3 trades not supported)";
  if (config.skipMayhem && c.isMayhemMode) return "mayhem mode coin";
  if (l.instruction === "create" && !config.snipeLegacyCreate) return "legacy create";
  if (!c.tokenProgram.equals(TOKEN_PROGRAM) && !c.tokenProgram.equals(TOKEN_2022_PROGRAM)) return "unknown token program";
  if (config.blockedCreators.has(c.creator.toBase58()) || config.blockedCreators.has(c.user.toBase58())) {
    return "blocked creator";
  }
  const name = `${c.name} ${c.symbol}`.toLowerCase();
  const hit = config.nameBlocklist.find((w) => name.includes(w));
  if (hit) return `name matches blocklist "${hit}"`;

  if (c.tokenTotalSupply > 0n) {
    const devPct = Number((l.devBuyTokens * 10_000n) / c.tokenTotalSupply) / 100;
    if (devPct > config.maxDevBuyPct) return `dev bought ${devPct.toFixed(2)}% of supply`;
  }
  if (l.curveAfterTx.realTokenReserves === 0n) return "curve already sold out";
  return null;
}
