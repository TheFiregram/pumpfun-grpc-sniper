import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { loadKeysFromFile } from "./lookupTable/saveAccounts";

/**
 * Wallets for bundled buys, loaded from keys/data.json (written by distributeSol).
 * Keys are never hard-coded in source, so they can't end up in git.
 */
export const loadBundleBuyerKeys = (fileName = "data.json"): Keypair[] =>
  loadKeysFromFile(fileName).map((k) => Keypair.fromSecretKey(bs58.decode(k)));
