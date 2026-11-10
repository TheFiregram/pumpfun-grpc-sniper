import { AccountMeta, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { u64Le } from "./borsh";
import { DISC, PUMP_PROGRAM_ID, TOKEN_PROGRAM, WSOL_MINT } from "./constants";
import { ata, bondingCurvePda, EVENT_AUTHORITY, FEE_CONFIG, GLOBAL, userVolumeAccumulatorPda } from "./pda";

export interface TradeAccountsArgs {
  mint: PublicKey;
  /** SPL Token for legacy `create` coins, Token-2022 for `create_v2` coins. */
  baseTokenProgram: PublicKey;
  user: PublicKey;
  /** One of the buyback fee recipient wallets from the Global account (SOL-paired coins). */
  buybackFeeRecipient: PublicKey;
}

const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

/**
 * The 17 accounts shared by buy_v3 / buy_exact_quote_in_v3 / sell_v3, for SOL-paired coins.
 * See pump-public-docs/docs/instructions/TRADE_V3.md.
 */
function v3TradeAccounts({ mint, baseTokenProgram, user, buybackFeeRecipient }: TradeAccountsArgs): AccountMeta[] {
  const bondingCurve = bondingCurvePda(mint);
  return [
    r(GLOBAL),
    r(mint),
    r(WSOL_MINT), // quote_mint: wrapped SOL for SOL-paired coins
    r(baseTokenProgram),
    r(TOKEN_PROGRAM), // quote_token_program
    w(bondingCurve),
    w(ata(mint, bondingCurve, baseTokenProgram, true)),
    w(ata(WSOL_MINT, bondingCurve, TOKEN_PROGRAM, true)), // not used for SOL coins, must still be the derived address
    { pubkey: user, isSigner: true, isWritable: true },
    w(ata(mint, user, baseTokenProgram)),
    w(ata(WSOL_MINT, user, TOKEN_PROGRAM)), // not used for SOL coins, must still be the derived address
    w(userVolumeAccumulatorPda(user)),
    r(FEE_CONFIG),
    w(buybackFeeRecipient),
    r(SystemProgram.programId),
    r(EVENT_AUTHORITY),
    r(PUMP_PROGRAM_ID),
  ];
}

/** Spend exactly `spendLamports` (fees included) and require at least `minTokensOut`. */
export function buyExactSolInV3Ix(args: TradeAccountsArgs, spendLamports: bigint, minTokensOut: bigint): TransactionInstruction {
  const data = Buffer.concat([DISC.buyExactQuoteInV3, u64Le(spendLamports), u64Le(minTokensOut)]);
  return new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys: v3TradeAccounts(args), data });
}

/** Sell `amount` raw tokens and require at least `minSolOut` lamports after fees. */
export function sellV3Ix(args: TradeAccountsArgs, amount: bigint, minSolOut: bigint): TransactionInstruction {
  const data = Buffer.concat([DISC.sellV3, u64Le(amount), u64Le(minSolOut)]);
  return new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys: v3TradeAccounts(args), data });
}

/** v3 trades do not create the buyer's token account, so create it first (no-op if it exists). */
export function createUserAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) {
  return createAssociatedTokenAccountIdempotentInstruction(payer, ata(mint, owner, tokenProgram), owner, mint, tokenProgram);
}

/** Close the (empty) token account after a full sell to get its ~0.002 SOL rent back. */
export function closeUserAtaIx(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) {
  return createCloseAccountInstruction(ata(mint, owner, tokenProgram), owner, owner, [], tokenProgram);
}
