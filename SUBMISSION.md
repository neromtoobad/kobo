# MLH Solana Hackathon submission: Kobo

Paste each block into its field on MLH Challenges. Track: **AI: Pay-per-call AI agent**.

---

**Project name**
Kobo

**Tagline** (short)
Pocket money for your AI agent. Not your card.

**Links**
- Live demo: https://kobo.nerom.site (Solana devnet, test money, no sign-up)
- Code: https://github.com/neromtoobad/kobo
- Program: `2wh8evQ1cAmw3Ykcq5CY1cuTzNp9iFyW9pj7nedEHyVw` (devnet), https://explorer.solana.com/address/2wh8evQ1cAmw3Ykcq5CY1cuTzNp9iFyW9pj7nedEHyVw?cluster=devnet
- Demo video (1:36): <YouTube link after upload>

---

**What it does**

AI agents now buy things on their own: API calls, data, other agents' work. Right now there are two bad ways to let them. You can give the agent a card or a hot wallet and hope, or you can approve every purchase yourself, which defeats the point of an agent.

Kobo gives the agent an allowance on Solana instead. You connect your Solana wallet, fund a vault and set the rules: a cap per call, a cap per day, a budget for each merchant, an expiry date, and a pause switch. The agent pays for each API call over x402 straight from the vault. The Kobo program checks every payment against your rules. A confused, buggy or prompt-injected agent can try to overspend, and the chain refuses it.

In the demo a Claude agent (claude-opus-5-5) shops a street of seven paid APIs: weather, FX, crypto prices, an encyclopedia, headlines, a second-opinion model and a $0.25 "premium dossier". Ask it to brief you on Solana and to buy the dossier too. It pays $0.001–$0.003 for the cheap data, each payment settling in about a second. The dossier costs more than your $0.05 per-call cap, so the program refuses it, the agent isn't charged, and it tells you why. Hit pause, and every later purchase is refused on chain.

**How we built it**

- **Anchor program** (`programs/kobo`): open, top_up, withdraw, set_limits, set_paused, set_merchant, pay, close. `pay` enforces `OverPerCallCap`, `OverDailyCap`, `OverMerchantBudget`, `Expired` and `Paused`, and emits a `Paid` event that carries the request's 32-byte reference. 11 lifecycle tests run on a local validator.
- **A new x402 scheme, `kobo-allowance`**: x402 v2 headers and CAIP-2 network id, but the payment is a call into a program that enforces the payer's own limits, not a bare token transfer. The agent signs, and the facilitator co-signs as fee payer, simulates, then settles. The facilitator signs only compute-budget instructions plus one Kobo `pay`, so it can't be drained.
- **Pay only for answers**: the payment is simulated first, the tool runs, and only then is the payment sent. If the upstream API fails, nothing is charged.
- **Server** (Hono, Node 24, on Railway): seven merchants, each with its own wallet and price; a Claude tool loop streamed to the browser over SSE; owner transactions built server-side, fee-paid by the facilitator, and signed by the owner's own wallet (Wallet Standard: Phantom, Solflare, Backpack). The wallet approves a browser session key once, by signing a plain message, so starting agent runs doesn't need a popup each time.
- **UI** ("Market Street"): each paid API is a stall on a street. The agent walks to the stall it's paying, a coin flies on settlement, and refused stalls get a red tag and a rope. The receipt tape is read back from `Paid` events on chain, not from a database.

**Why Solana**

Pay per call only works when the payment costs less than the call. A Kobo payment settles in about a second for about $0.001 in network fees (10,000 lamports), which the facilitator pays. Buying $0.001 of exchange-rate data with a card costs $0.30 + 2.9%. On Solana it makes sense.

**Challenges we ran into**

- Fitting x402 to a program-enforced payment. A plain token transfer can't express the payer's limits, so we defined a new scheme and a facilitator that only signs one exact transaction shape.
- Making the agent hold no money and no SOL while still signing its own payments.
- Opening an allowance with seven merchant budgets in one go. It doesn't fit in one transaction, so it's split into batches, with a client fallback that lists any shop a failed batch left out.

**Accomplishments we're proud of**

- The limits really are on chain. You can watch the refusal happen, read the error, and see that nothing moved.
- Bring your own wallet, or skip it: connect Phantom/Solflare/Backpack, or use a throwaway browser wallet. A faucet hands out test dollars, and no SOL is needed anywhere.
- Every receipt in the UI links back to a Solana transaction.

**What we learned**

x402 is a good fit for agents, but "who is allowed to spend, and how much" needs to live somewhere the agent can't argue with. A Solana program turned out to be the simplest place to put it.

**What's next for Kobo**

- Swap the test mint for USDC on mainnet (the program is mint-agnostic).
- An SDK so any x402 merchant can accept `kobo-allowance` alongside plain transfers, and so agents outside our server can hold their own keys.

**Built with**
Solana, Anchor, Rust, TypeScript, x402, Claude (Anthropic API), Hono, Node.js, esbuild, Railway
