import { Connection, PublicKey } from "@solana/web3.js";
import { BorshReader } from "./borsh";
import { ACCOUNT_DISC, DEFAULT_PUBKEY, FALLBACK_BUYBACK_FEE_RECIPIENTS } from "./constants";
import { GLOBAL } from "./pda";
import { CurveReserves } from "./math";

export interface BondingCurveState extends CurveReserves {
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: PublicKey;
}

function checkDisc(data: Buffer, disc: Buffer, what: string) {
  if (data.length < 8 || !data.subarray(0, 8).equals(disc)) {
    throw new Error(`${what}: unexpected account discriminator`);
  }
}

export function decodeBondingCurve(data: Buffer): BondingCurveState {
  checkDisc(data, ACCOUNT_DISC.bondingCurve, "BondingCurve");
  const r = new BorshReader(data.subarray(8));
  const virtualTokenReserves = r.u64();
  const virtualSolReserves = r.u64(); // named virtual_quote_reserves in the current IDL
  const realTokenReserves = r.u64();
  const realSolReserves = r.u64();
  const tokenTotalSupply = r.u64();
  const complete = r.bool();
  const creator = r.pubkey();
  const isMayhemMode = r.optional(() => r.bool(), false);
  const isCashbackCoin = r.optional(() => r.bool(), false);
  const quoteMint = r.optional(() => r.pubkey(), DEFAULT_PUBKEY);
  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
    creator,
    isMayhemMode,
    isCashbackCoin,
    quoteMint,
  };
}

export interface GlobalFees {
  feeBps: bigint;
  creatorFeeBps: bigint;
  buybackBps: bigint;
  buybackFeeRecipients: PublicKey[];
}

/** Read the parts of the on-chain Global account the bot needs, instead of hard-coding them. */
export function decodeGlobalFees(data: Buffer): GlobalFees {
  checkDisc(data, ACCOUNT_DISC.global, "Global");
  const r = new BorshReader(data.subarray(8));
  r.bool(); // initialized
  r.pubkey(); // authority
  r.pubkey(); // fee_recipient
  r.u64(); // initial_virtual_token_reserves
  r.u64(); // initial_virtual_sol_reserves
  r.u64(); // initial_real_token_reserves
  r.u64(); // token_total_supply
  const feeBps = r.u64();
  r.pubkey(); // withdraw_authority
  r.bool(); // enable_migrate
  r.u64(); // pool_migration_fee
  const creatorFeeBps = r.u64();
  r.skip(32 * 7); // fee_recipients
  r.pubkey(); // set_creator_authority
  r.pubkey(); // admin_set_creator_authority
  r.bool(); // create_v2_enabled
  r.pubkey(); // whitelist_pda
  r.pubkey(); // reserved_fee_recipient
  r.bool(); // mayhem_mode_enabled
  r.skip(32 * 7); // reserved_fee_recipients
  r.bool(); // is_cashback_enabled
  const buybackFeeRecipients: PublicKey[] = [];
  for (let i = 0; i < 8; i++) buybackFeeRecipients.push(r.pubkey());
  const buybackBps = r.u64();
  return {
    feeBps,
    creatorFeeBps,
    buybackBps,
    buybackFeeRecipients: buybackFeeRecipients.filter((p) => !p.equals(DEFAULT_PUBKEY)),
  };
}

export async function fetchGlobalFees(connection: Connection): Promise<GlobalFees> {
  try {
    const info = await connection.getAccountInfo(GLOBAL, "confirmed");
    if (!info) throw new Error("Global account not found");
    const fees = decodeGlobalFees(info.data);
    if (fees.buybackFeeRecipients.length === 0) throw new Error("no buyback fee recipients on-chain");
    return fees;
  } catch (e) {
    console.warn("⚠️  Could not read Pump.fun Global account, using fallback fee settings:", (e as Error).message);
    return {
      feeBps: 95n,
      creatorFeeBps: 30n,
      buybackBps: 0n,
      buybackFeeRecipients: FALLBACK_BUYBACK_FEE_RECIPIENTS,
    };
  }
}
