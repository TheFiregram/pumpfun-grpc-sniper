import { AddressLookupTableProgram, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { connection } from "../config";
import { createAndSendV0Tx } from "../executor/legacy";
import { PUMP_PROGRAM_ID, TOKEN_PROGRAM, WSOL_MINT } from "../pump/constants";
import { ata, bondingCurvePda, EVENT_AUTHORITY, FEE_CONFIG, GLOBAL, userVolumeAccumulatorPda } from "../pump/pda";

const MAX_ADDRESSES_PER_EXTEND = 20; // one extend instruction must fit in a single transaction

/**
 * Fill a lookup table with every account a v3 buy uses for `mint`, for the authority and each bundle wallet.
 * `authority` must be the same keypair that created the table (see createLUT.ts).
 */
export const lookupTxs = async (
  lookupAddress: PublicKey,
  mint: PublicKey,
  baseTokenProgram: PublicKey,
  walletKPs: Keypair[],
  authority: Keypair,
  buybackFeeRecipients: PublicKey[],
) => {
  const table = (await connection.getAddressLookupTable(lookupAddress)).value;
  if (!table) throw new Error(`Lookup table ${lookupAddress.toBase58()} not found`);
  if (!table.state.authority?.equals(authority.publicKey)) {
    throw new Error("This keypair is not the lookup table's authority; use the one that created it");
  }

  const bondingCurve = bondingCurvePda(mint);
  const shared: PublicKey[] = [
    GLOBAL,
    mint,
    WSOL_MINT,
    baseTokenProgram,
    TOKEN_PROGRAM,
    bondingCurve,
    ata(mint, bondingCurve, baseTokenProgram, true),
    ata(WSOL_MINT, bondingCurve, TOKEN_PROGRAM, true),
    FEE_CONFIG,
    SystemProgram.programId,
    EVENT_AUTHORITY,
    PUMP_PROGRAM_ID,
    ...buybackFeeRecipients,
  ];
  // Per-wallet accounts: each wallet has its OWN volume accumulator (it was hard-coded to someone else's before).
  const perWallet = walletKPs.flatMap((kp) => [
    kp.publicKey,
    ata(mint, kp.publicKey, baseTokenProgram),
    ata(WSOL_MINT, kp.publicKey, TOKEN_PROGRAM),
    userVolumeAccumulatorPda(kp.publicKey),
  ]);

  const already = new Set(table.state.addresses.map((a) => a.toBase58()));
  const toAdd = [...new Map([...shared, ...perWallet].map((a) => [a.toBase58(), a])).values()].filter((a) => !already.has(a.toBase58()));
  if (table.state.addresses.length + toAdd.length > 256) throw new Error("A lookup table holds at most 256 addresses");

  for (let i = 0; i < toAdd.length; i += MAX_ADDRESSES_PER_EXTEND) {
    const ix = AddressLookupTableProgram.extendLookupTable({
      lookupTable: lookupAddress,
      authority: authority.publicKey,
      payer: authority.publicKey,
      addresses: toAdd.slice(i, i + MAX_ADDRESSES_PER_EXTEND),
    });
    const ok = await createAndSendV0Tx([ix], authority, connection);
    if (!ok) throw new Error(`Extending lookup table failed at address #${i}`);
  }
  console.log(`Lookup table now has ${table.state.addresses.length + toAdd.length} addresses`);
};
