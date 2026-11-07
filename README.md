# Kobo: pocket money for AI agents

**Live demo:** https://kobo.nerom.site (Solana devnet, test money)
**Program:** [`2wh8evQ1cAmw3Ykcq5CY1cuTzNp9iFyW9pj7nedEHyVw`](https://explorer.solana.com/address/2wh8evQ1cAmw3Ykcq5CY1cuTzNp9iFyW9pj7nedEHyVw?cluster=devnet) on devnet
**Built for:** MLH Solana Hackathon (Nov 6–8, 2026), AI track

AI agents are starting to buy things: API calls, data, compute, other agents' work. Today that leaves two bad options. You can hand the agent a card or a hot wallet and hope, or you can approve every purchase yourself, in which case it isn't an agent.

Kobo is a third option: **an allowance on Solana.** You fund a vault and set the rules. Your agent can then pay for each API call it makes over the [x402](https://x402.org) protocol, straight from the vault, but only inside those rules. The rules are enforced by the program, not by the agent's good behaviour. A confused, buggy or prompt-injected agent still cannot spend past them.

| Rule | Enforced on chain |
|---|---|
| Max per call | `OverPerCallCap` |
| Max per UTC day | `OverDailyCap` |
| Budget per merchant (allow-list) | `OverMerchantBudget`, unlisted merchants can't be paid at all |
| Expiry | `Expired` |
| Kill switch | `Paused`, which the owner can flip at any moment |
| Take it back | `withdraw` / `close` return every unspent cent to the owner |

The agent **holds no money and no SOL.** It only has a key that can ask the vault to pay a listed merchant. The x402 facilitator pays the network fee.

## Why Solana

Pay-per-call only works when the payment costs less than the call. A Kobo payment is one instruction. It settles in about **1 second** for under **$0.001** in network fees (10,000 lamports, two signatures, at today's SOL price), which the facilitator covers. On most chains, buying $0.001 of exchange-rate data that way makes no sense. On Solana it does.

## How a call is paid (x402)

```
agent ── POST /tools/fx ─────────────────────────────▶ merchant
agent ◀── 402 Payment Required ── PAYMENT-REQUIRED ── {scheme: "kobo-allowance", amount: 1000,
                                                        payTo, asset, reference = sha256(request ‖ nonce)}
agent: build Kobo `pay(amount, reference)`, fee payer = facilitator, sign as the agent
agent ── POST /tools/fx + PAYMENT-SIGNATURE ─────────▶ facilitator
          verify: exactly one Kobo pay ix, right amount, right merchant, right reference, unused
          co-sign as fee payer → simulate (the program checks the owner's limits)
          run the tool → only if it succeeded, send the payment and wait for confirmation
agent ◀── 200 + data ── PAYMENT-RESPONSE {transaction: <signature>} ──
```

- **You only pay for answers.** The payment is simulated first, the tool runs, and only then is the payment sent. If the upstream API fails, nothing is charged.
- **Receipts are on chain.** Every payment emits a `Paid` event carrying the 32-byte request reference. The receipt tape in the UI is read back from Solana, not from a database.
- **Replay-safe.** Each challenge has a fresh reference, and the facilitator settles each reference once.
- **The facilitator can't be drained.** It signs only transactions made of compute-budget instructions plus one Kobo `pay`, and refuses any instruction that touches its own account.

`kobo-allowance` is a new x402 scheme. The headers, payload shape and CAIP-2 network id (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`) follow x402 v2. What changes is the payment itself: a call into a program that enforces the payer's own limits, instead of a bare token transfer.

## What's in the demo

1. **Owner.** A burner wallet in your browser gets $5 of test USD from the faucet. No sign-up and no SOL. You open an allowance: fund the vault, then set the per-call cap, daily cap, expiry, and which merchants the agent may pay and how much each.
2. **Agent.** A Claude agent (`claude-opus-5-5`) with seven paid tools, each a separate merchant with its own wallet and price:

   | Merchant | Price | Data |
   |---|---|---|
   | Skyline Weather | $0.002 | Open-Meteo forecast |
   | Naira Desk FX | $0.001 | exchange rates, NGN and 160 others |
   | Ticker | $0.001 | crypto spot (Kraken, CoinGecko fallback) |
   | Encyclo | $0.002 | encyclopedia summaries |
   | Wire | $0.003 | recent tech headlines |
   | Second Opinion | $0.02 | a second model fact-checks the draft |
   | Dossier Pro | $0.25 | pricey bundle, there to hit the cap |

   Ask *"Brief me on Solana… get the premium dossier too"*. The agent buys the cheap data, and **the $0.25 dossier is refused on chain** (over the $0.05 per-call cap) without the agent being charged.
3. **Kill switch.** Hit *Pause agent* and run again. Every payment is refused with `Paused`, and the agent tells you it has been cut off.

## Run it

```bash
npm install
# program (Anchor 1.0.2, Solana CLI 4.x)
anchor build -- --arch v0 && anchor idl build -o target/idl/kobo.json -t target/types/kobo.ts
npm run validator &          # local validator with the program loaded
npm run test:local           # 11 lifecycle tests: caps, budgets, pause, events, close
# app (devnet)
npm run idl
npx tsx scripts/setup.ts     # test-dollar mint + merchant wallets → app/devnet.json
echo "ANTHROPIC_API_KEY=..." > .env
npm run web:build && npx tsx --env-file=.env app/server.ts   # http://localhost:4350
npx tsx scripts/e2e.ts       # headless: new owner → faucet → open → agent run
```

Layout:
- `programs/kobo/src/lib.rs`: the allowance program (open, top_up, withdraw, set_limits, set_paused, set_merchant, pay, close).
- `app/x402.ts`: the challenge, the facilitator (verify, co-sign, simulate, settle) and the agent's paying fetch.
- `app/tools.ts`: the merchants.
- `app/agent.ts`: the Claude tool loop.
- `app/server.ts`: HTTP API, owner transactions (fee-paid by the facilitator, signed in the browser), and state and receipts read from chain.
- `app/web/`: the console.
- `tests/kobo.ts`: program tests.

## Honest notes

- This is devnet with a test-dollar mint. Moving to mainnet means swapping the mint for USDC; the program is mint-agnostic.
- The owner wallet is a browser burner so judges can try it in one click. The owner transactions are ordinary partially signed transactions, so a wallet adapter (Phantom etc.) fits without changes.
- Each owner's agent key is derived server-side from a secret, because the agent runs on the server. In production the agent would hold its own key wherever it runs.
- All code was written during the hackathon window (from Nov 7, 2026).
