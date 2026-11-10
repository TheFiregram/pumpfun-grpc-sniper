# THE HAWK 🦅

**See Early. Strike Fast.** Solana launch-monitoring, wallet operations and multi-route execution terminal.

## Current milestone
- Branded responsive Next.js dashboard.
- Overview metrics, activity chart and provider health indicators.
- Multi-wallet allocation preview and route selector.
- Wallet and wallet-group read-only placeholder screens.
- Existing Yellowstone gRPC / Pump.fun worker retained for later integration.

All balances, charts, activity rows and wallet addresses shown in the interface are sample data. This milestone does not connect wallets, sign transactions or submit trades.

## Local setup
1. Use Node.js 20 or newer.
2. Run `npm install`.
3. Run `npm run dev`.
4. Open http://localhost:3000.

## Safety
- Default mode is simulation.
- Never put signing keys in browser code or NEXT_PUBLIC variables.
- Live signing requires a dedicated server-side worker, encrypted key custody, authorization, spend limits, transaction inspection, explicit confirmation and an audit trail.
- Provider credentials are not committed.

## Architecture
Next.js hosts the dashboard. The Yellowstone stream must run in a separate persistent worker, not a serverless page handler. Planned data service: read-only RPC/gRPC adapters, then transaction builder and verified simulation, then separately gated RPC and Jito execution adapters.
