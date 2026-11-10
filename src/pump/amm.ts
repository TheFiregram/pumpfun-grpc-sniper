// PumpSwap (Pump.fun AMM): where a coin trades after its bonding curve completes.
// Selling uses `sell_v2` (17 accounts), see pump-public-docs/docs/instructions/PUMP_SWAP_TRADE_V2.md.
import { AccountMeta, Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { BorshReader, u64Le } from "./borsh";
import { FALLBACK_BUYBACK_FEE_RECIPIENTS, PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID, TOKEN_PROGRAM, WSOL_MINT, DEFAULT_PUBKEY } from "./constants";
import { ata } from "./pda";

export const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const SELL_V2_DISC = Buffer.from([93, 246, 130, 60, 231, 233, 64, 178]);
const POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const GLOBAL_CONFIG_DISC = Buffer.from([149, 8, 156, 202, 160, 252, 176, 217]);

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export const AMM_GLOBAL_CONFIG = pda([Buffer.from("global_config")], PUMP_AMM_PROGRAM_ID);
export const AMM_EVENT_AUTHORITY = pda([Buffer.from("__event_authority")], PUMP_AMM_PROGRAM_ID);
export const AMM_FEE_CONFIG = pda([Buffer.from("fee_config"), PUMP_AMM_PROGRAM_ID.toBuffer()], PUMP_FEE_PROGRAM_ID);
export const ammUserVolumeAccumulatorPda = (user: PublicKey) =>
  pda([Buffer.from("user_volume_accumulator"), user.toBuffer()], PUMP_AMM_PROGRAM_ID);

/** The pool a graduated SOL-paired Pump.fun coin migrates into (index 0, created by the Pump pool authority). */
export function canonicalPoolPda(mint: PublicKey): PublicKey {
  const poolAuthority = pda([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_PROGRAM_ID);
  const index = Buffer.alloc(2); // u16 0, little-endian
  return pda([Buffer.from("pool"), index, poolAuthority.toBuffer(), mint.toBuffer(), WSOL_MINT.toBuffer()], PUMP_AMM_PROGRAM_ID);
}

export interface PoolState {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  isCashbackCoin: boolean;
  virtualQuoteReserves: bigint; // signed, may be negative
}

export function decodePool(data: Buffer): PoolState {
  if (data.length < 8 || !data.subarray(0, 8).equals(POOL_DISC)) throw new Error("Pool: unexpected account discriminator");
  const r = new BorshReader(data.subarray(8));
  r.u8(); // pool_bump
  r.u16(); // index
  r.pubkey(); // creator
  const baseMint = r.pubkey();
  const quoteMint = r.pubkey();
  r.pubkey(); // lp_mint
  const poolBaseTokenAccount = r.pubkey();
  const poolQuoteTokenAccount = r.pubkey();
  r.u64(); // lp_supply
  r.optional(() => r.pubkey(), DEFAULT_PUBKEY); // coin_creator
  r.optional(() => r.bool(), false); // is_mayhem_mode
  const isCashbackCoin = r.optional(() => r.bool(), false);
  const virtualQuoteReserves = r.optional(() => r.i128(), 0n);
  return { baseMint, quoteMint, poolBaseTokenAccount, poolQuoteTokenAccount, isCashbackCoin, virtualQuoteReserves };
}

/** Raw `amount` of an SPL Token or Token-2022 account (same offset in both). */
export function tokenAccountAmount(data: Buffer): bigint {
  if (data.length < 72) throw new Error("not a token account");
  return data.readBigUInt64LE(64);
}

export interface AmmFees {
  totalBps: bigint; // lp + protocol + creator + buyback
  buybackFeeRecipients: PublicKey[];
}

export async function fetchAmmFees(connection: Connection): Promise<AmmFees> {
  try {
    const info = await connection.getAccountInfo(AMM_GLOBAL_CONFIG, "confirmed");
    if (!info || !info.data.subarray(0, 8).equals(GLOBAL_CONFIG_DISC)) throw new Error("GlobalConfig not found");
    const r = new BorshReader(info.data.subarray(8));
    r.pubkey(); // admin
    const lp = r.u64();
    const protocol = r.u64();
    r.u8(); // disable_flags
    r.skip(32 * 8); // protocol_fee_recipients
    const creator = r.u64();
    r.pubkey(); // admin_set_coin_creator_authority
    r.pubkey(); // whitelist_pda
    r.pubkey(); // reserved_fee_recipient
    r.bool(); // mayhem_mode_enabled
    r.skip(32 * 7); // reserved_fee_recipients
    r.bool(); // is_cashback_enabled
    const recipients: PublicKey[] = [];
    for (let i = 0; i < 8; i++) recipients.push(r.pubkey());
    const buyback = r.u64();
    const live = recipients.filter((p) => !p.equals(DEFAULT_PUBKEY));
    if (live.length === 0) throw new Error("no buyback fee recipients");
    return { totalBps: lp + protocol + creator + buyback, buybackFeeRecipients: live };
  } catch (e) {
    console.warn("⚠️  Could not read PumpSwap GlobalConfig, using fallback fees:", (e as Error).message);
    return { totalBps: 125n, buybackFeeRecipients: FALLBACK_BUYBACK_FEE_RECIPIENTS };
  }
}

/** Constant-product sell quote on effective reserves, fees taken from the SOL out. */
export function ammSolOutForTokensIn(baseReserves: bigint, effectiveQuoteReserves: bigint, tokensIn: bigint, totalFeeBps: bigint): bigint {
  if (tokensIn <= 0n || baseReserves <= 0n || effectiveQuoteReserves <= 0n) return 0n;
  const gross = (effectiveQuoteReserves * tokensIn) / (baseReserves + tokensIn);
  const fee = (gross * totalFeeBps + 9_999n) / 10_000n;
  return gross > fee ? gross - fee : 0n;
}

const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

export function ammSellV2Ix(
  pool: PublicKey,
  state: PoolState,
  user: PublicKey,
  baseTokenProgram: PublicKey,
  buybackFeeRecipientWallet: PublicKey,
  amount: bigint,
  minSolOut: bigint,
): TransactionInstruction {
  const keys: AccountMeta[] = [
    w(pool),
    { pubkey: user, isSigner: true, isWritable: true },
    r(AMM_GLOBAL_CONFIG),
    r(state.baseMint),
    r(state.quoteMint),
    w(ata(state.baseMint, user, baseTokenProgram)),
    w(ata(WSOL_MINT, user, TOKEN_PROGRAM)), // must exist: the caller creates it first
    w(state.poolBaseTokenAccount),
    w(state.poolQuoteTokenAccount),
    r(baseTokenProgram),
    r(TOKEN_PROGRAM),
    r(SystemProgram.programId),
    w(ammUserVolumeAccumulatorPda(user)),
    r(AMM_FEE_CONFIG),
    w(ata(WSOL_MINT, buybackFeeRecipientWallet, TOKEN_PROGRAM)), // the recipient's wSOL token account
    r(AMM_EVENT_AUTHORITY),
    r(PUMP_AMM_PROGRAM_ID),
  ];
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys,
    data: Buffer.concat([SELL_V2_DISC, u64Le(amount), u64Le(minSolOut)]),
  });
}
