import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { computeBudgetIxs, getBlockhash } from "../executor/sender";
import { execute } from "../executor/legacy";
import { saveDataToFile } from "./saveAccounts";

/** SOL each new wallet receives: its buy amount plus room for fees and token-account rent. */
const PER_WALLET_SOL = 0.11;
const TRANSFERS_PER_TX = 15; // keeps each transaction well under the size limit

export const distributeSol = async (connection: Connection, mainKp: Keypair, count: number): Promise<Keypair[] | null> => {
  if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer");
  const perWallet = Math.floor(PER_WALLET_SOL * LAMPORTS_PER_SOL);
  const txCount = Math.ceil(count / TRANSFERS_PER_TX);
  const needed = perWallet * count + txCount * 500_000; // transfers + fees margin

  const balance = await connection.getBalance(mainKp.publicKey);
  if (balance < needed) {
    console.log(`Main wallet has ${balance / LAMPORTS_PER_SOL} SOL, needs ${needed / LAMPORTS_PER_SOL} SOL`);
    return null;
  }

  const kps = Array.from({ length: count }, () => Keypair.generate());
  // Throws if saving fails, so SOL is never sent to wallets whose keys are lost.
  saveDataToFile(kps.map((kp) => bs58.encode(kp.secretKey)));

  for (let start = 0; start < kps.length; start += TRANSFERS_PER_TX) {
    const chunk = kps.slice(start, start + TRANSFERS_PER_TX);
    const ixs: TransactionInstruction[] = [
      ...computeBudgetIxs(),
      ...chunk.map((kp) => SystemProgram.transfer({ fromPubkey: mainKp.publicKey, toPubkey: kp.publicKey, lamports: perWallet })),
    ];

    let sent = false;
    for (let attempt = 0; attempt < 5 && !sent; attempt++) {
      try {
        const blockhash = await getBlockhash();
        const tx = new VersionedTransaction(
          new TransactionMessage({ payerKey: mainKp.publicKey, recentBlockhash: blockhash.blockhash, instructions: ixs }).compileToV0Message(),
        );
        tx.sign([mainKp]);
        const sig = await execute(tx, blockhash, 1);
        if (sig) {
          console.log(`Funded wallets ${start + 1}-${start + chunk.length}: https://solscan.io/tx/${sig}`);
          sent = true;
        }
      } catch (e) {
        console.log(`Distribution attempt ${attempt + 1} failed:`, (e as Error).message);
      }
    }
    if (!sent) {
      console.log(`Stopped: wallets from #${start + 1} were not funded. Keys for all wallets are in keys/.`);
      return null;
    }
  }
  console.log("Success in distribution");
  return kps;
};
