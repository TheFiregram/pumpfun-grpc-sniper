## Pump.fun gRPC Sniper (Solana, Helius)

Listens to Helius LaserStream (Yellowstone gRPC) for new Pump.fun coins, filters them, buys through
Helius Sender, and sells on take-profit, stop-loss or a time limit. **Starts in dry-run mode**: it
simulates every buy and sends nothing until you set `DRY_RUN=false`.

> Sniping new tokens is very high risk. Most new coins go to zero, and you pay a tip, a priority fee
> and token-account rent on every trade. Use a separate wallet with only what you can afford to lose.

### What it does
- **Detects both launch types**: legacy `create` (SPL Token) and `create_v2` (Token-2022), including
  launches made through other programs (inner instructions) and transactions that use lookup tables.
- **Reads launch data from Pump.fun's own events** (mint, creator, token program, mayhem/cashback flags,
  curve reserves after the creator's buy), so quotes are based on the real price, not a guess.
- **Trades with `buy_exact_quote_in_v3` / `sell_v3`**, the current 17-account instructions. Fee rates and
  buyback fee recipients are read from the on-chain Global account at startup, not hard-coded.
- **Sends through Helius Sender** with a tip and priority fee, re-sends while waiting, and confirms
  against the same blockhash the transaction was signed with.
- **Keeps the gRPC stream alive** with pings, a no-data watchdog and automatic reconnect with backoff.
- **Limits risk**: max SOL per trade and per day, max open positions, minimum wallet reserve, slippage
  limits on every buy and sell, and a queue that drops stale launches instead of buying late.
- **Exits**: polls open positions, sells on TP/SL/max hold, widens slippage after each failed sell, and
  closes the token account afterwards to get its rent back. Positions are saved to `state/` and resume
  after a restart.
- **Graduated coins are sold automatically on PumpSwap.** When a coin completes its bonding curve the bot
  waits for the PumpSwap pool to open, keeps tracking TP/SL/max hold on the pool price, and sells with
  PumpSwap `sell_v2`. The SOL comes back as wrapped SOL and is unwrapped in the same transaction.

### Filters (no RPC calls, run before every buy)
Skips coins that are not SOL-paired, cashback coins (v3 doesn't support them), mayhem coins
(configurable), coins where the creator bought more than `MAX_DEV_BUY_PCT` of supply, blocked creators
and blocklisted names. Pump.fun mints are controlled by the program, so classic mint/freeze-authority
rug checks don't apply here; the creator's own bag is the main risk on launch.

### Setup
```bash
npm install             # also refreshes package-lock.json for the new dev tools
cp .env.example .env    # fill in HELIUS_API_KEY and PRIVATE_KEY
npm run typecheck
npm start               # dry run: watch the simulations first
```
LaserStream mainnet needs a Helius Business or Professional plan. Pick the LaserStream and Sender
regions closest to your server in `.env`.

### Files
- `src/index.ts`: gRPC listener, dedupe, bounded queue, startup
- `src/snipe.ts`: quoting, buy transaction, dry-run simulation, spending checks
- `src/positions.ts`: take-profit / stop-loss / max-hold selling
- `src/filters.ts`: launch filters
- `src/state.ts`: daily spend and open positions, saved atomically to `state/state.json`
- `src/executor/sender.ts`: Helius Sender, tips, priority fees, blockhash cache, confirmation
- `src/pump/amm.ts`: PumpSwap pool lookup, pricing and `sell_v2`
- `src/pump/*`: Pump.fun constants, PDAs, event/account decoding, curve maths, instruction builders
- `src/bundleBuy.ts`, `src/lookupTable/*`: multi-wallet buy with a lookup table (optional)
- `IDL/`: the current official Pump.fun IDL (from pump-fun/pump-public-docs), for reference

### Bundled buys (optional)
1. `distributeSol` creates and funds wallets. Their keys are saved to `keys/data.json` **before** any
   SOL is sent, and the file is never overwritten. `keys/` is git-ignored; back it up somewhere safe.
2. `createLUT` creates a lookup table; `lookupTxs` fills it with the accounts for one mint.
3. `bundleBuyWithLookup` buys from all wallets in one transaction (respects `DRY_RUN` and spend limits).

### Not covered
- Raydium launches.
- Coins paired with USDC or another pump coin are skipped.

### License
MIT
