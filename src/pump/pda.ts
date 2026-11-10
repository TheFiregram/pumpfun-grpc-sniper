import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID } from "./constants";

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey = PUMP_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];

export const globalPda = () => pda([Buffer.from("global")]);
export const eventAuthorityPda = () => pda([Buffer.from("__event_authority")]);
export const bondingCurvePda = (mint: PublicKey) => pda([Buffer.from("bonding-curve"), mint.toBuffer()]);
export const userVolumeAccumulatorPda = (user: PublicKey) =>
  pda([Buffer.from("user_volume_accumulator"), user.toBuffer()]);
export const feeConfigPda = () =>
  pda([Buffer.from("fee_config"), PUMP_PROGRAM_ID.toBuffer()], PUMP_FEE_PROGRAM_ID);

/** Associated token account. `allowOwnerOffCurve` is needed when the owner is a PDA (e.g. the bonding curve). */
export const ata = (mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey, allowOwnerOffCurve = false) =>
  getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve, tokenProgram);

// Cache the PDAs that never change.
export const GLOBAL = globalPda();
export const EVENT_AUTHORITY = eventAuthorityPda();
export const FEE_CONFIG = feeConfigPda();
