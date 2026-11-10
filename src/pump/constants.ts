import { PublicKey } from "@solana/web3.js";

// Program IDs (from the official pump-fun/pump-public-docs IDL)
export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_FEE_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const DEFAULT_PUBKEY = PublicKey.default; // 1111...1111, used as quote_mint for SOL-paired coins

// Instruction discriminators
export const DISC = {
  create: Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]),
  createV2: Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]),
  buyExactQuoteInV3: Buffer.from([225, 247, 80, 30, 213, 179, 132, 136]),
  sellV3: Buffer.from([28, 146, 222, 119, 38, 196, 105, 213]),
};

// Anchor `emit_cpi!` events are self-CPIs whose data starts with this tag, then the event discriminator.
export const EVENT_IX_TAG = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);
export const EVENT_DISC = {
  create: Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]),
  trade: Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
};

// Account discriminators
export const ACCOUNT_DISC = {
  bondingCurve: Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]),
  global: Buffer.from([167, 232, 232, 177, 200, 108, 114, 127]),
};

// Fallback buyback fee recipients (docs/FEE_RECIPIENTS.md). At startup the bot reads the live list
// from the on-chain Global account and only falls back to these if that read fails.
export const FALLBACK_BUYBACK_FEE_RECIPIENTS = [
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
].map((a) => new PublicKey(a));

// Helius Sender tip accounts (mainnet)
export const HELIUS_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
].map((a) => new PublicKey(a));

export const TOKEN_DECIMALS = 6;
