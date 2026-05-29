# SportsAlpha

Scores agent for NFL, NBA, NHL, and football

## Architecture: Circle User-Controlled Wallets (MPC)

SportsAlpha uses Circle's **User-Controlled (non-custodial) MPC wallets**. Each
user owns their own keys — the server never holds or sees a private key, no
`ENTITY_SECRET` is involved, and no developer-managed custody exists.

All transaction signing goes through Circle's SDK running in the browser:

1. **User logs in** via Google OAuth → backend creates (or retrieves) their
   Circle user account and returns a `userToken` + `encryptionKey`
2. **Backend** calls Circle's API to create a `challengeId` for the requested
   action (wallet initialization or USDC transfer)
3. **Frontend** calls `sdk.execute(challengeId, callback)` — Circle's SDK
   presents the PIN/passcode modal directly to the user
4. Circle's MPC network co-signs and broadcasts the transaction

```
Browser                     Your Backend              Circle API
──────────────────────────────────────────────────────────────────
User clicks "Send USDC"
    │
    ├─── POST /api/circle/create-transfer-challenge ──►
    │                                                  Creates challenge
    │◄── { challengeId } ─────────────────────────────────────────
    │
    │  sdk.execute(challengeId)
    │  ┌─────────────────────────┐
    │  │  Circle PIN Modal (SDK) │  ◄── user enters their PIN
    │  └─────────────────────────┘
    │        PIN confirmed
    │
    └──────────────────────────────────────────────► Circle co-signs
                                                     & broadcasts tx
```

**What the server never touches:** user private keys, PIN, passcode, or any
signing material. The `CIRCLE_API_KEY` is used only to create users, fetch
wallet metadata, and generate challenge IDs — not to sign anything.

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your keys:

```env
# ── Circle (required) ────────────────────────────────────────────────────
# Get from https://console.circle.com → Programmable Wallets → User-Controlled
CIRCLE_API_KEY=your_circle_api_key
NEXT_PUBLIC_CIRCLE_APP_ID=your_circle_app_id

# ── Google OAuth (required for Google sign-in) ───────────────────────────
NEXT_PUBLIC_GOOGLE_CLIENT_ID=your_google_client_id

# ── Pinata IPFS (required for agent registration) ────────────────────────
# Get from https://pinata.cloud (free tier works)
PINATA_JWT=your_pinata_jwt

# ── OpenAI (required for AI chat) ────────────────────────────────────────
OPENAI_API_KEY=your_openai_key

# ── x402 payment (set to your Circle MPC wallet address) ─────────────────
NEXT_PUBLIC_X402_PAYEE_ADDRESS=0x...your_circle_wallet_address...
NEXT_PUBLIC_X402_PRICE=0.001

```

**Keys this project does NOT use:**
- No `ENTITY_SECRET` — that is for Circle Developer-Controlled Wallets only.
  SportsAlpha uses User-Controlled Wallets; users hold their own keys.
- No `PRIVATE_KEY` / `DEPLOYER_PRIVATE_KEY` — all runtime signing is done by
  users via the Circle SDK. On-chain registration can be performed with an
  external wallet tool (Foundry, Hardhat, or a browser wallet).

### 3. Fund your receiving wallet

Get testnet tokens for the address in `NEXT_PUBLIC_X402_PAYEE_ADDRESS` from:
https://www.coinbase.com/faucets/base-ethereum-goerli-faucet

### 4. Register on-chain (one-time)

```bash
npm run register
```

This registers the agent in the ERC-8004 on-chain registry. No local private
key is required — the script uses the Agent0 SDK in metadata-only mode. If the
SDK requires a signer, use an external wallet tool (e.g., Foundry `cast`) to
submit the registration transaction.

This will:
- Upload your agent metadata to IPFS via Pinata
- Register your agent on Arc Testnet (ERC-8004)
- Output your agent ID and 8004scan link

### 5. Start the A2A server

```bash
npm run start:a2a
```

Test locally: http://localhost:3000/.well-known/agent-card.json

#### Test your agent

```bash
# Discover agent capabilities
npm run a2a:discover

# Interactive chat mode
npm run a2a:chat

# Run automated tests
npm run a2a:test
```

### 6. Start the MCP server

```bash
npm run start:mcp
```

---

## Project Structure

```
sportsalpha/
├── src/
│   ├── register.ts      # One-time on-chain registration (no private key needed)
│   ├── agent.ts         # LLM logic (OpenAI)
│   ├── a2a-server.ts    # A2A server (x402 payment middleware)
│   ├── a2a-client.ts    # A2A testing client
│   ├── mcp-server.ts    # MCP server (stdio)
│   └── tools.ts         # MCP tool definitions
├── app/
│   └── page.tsx         # Next.js frontend (Circle User-Controlled Wallets)
└── .env                 # Environment variables (keep secret!)
```

---

## User Wallet Flow — Key API Routes

| Route | Purpose |
|---|---|
| `POST /api/wallet/initialize-user` | Create Circle user + return `challengeId` for PIN setup |
| `POST /api/circle/social-login` | Google OAuth → Circle user token + wallet lookup |
| `POST /api/circle/wallet-address` | Resolve wallet address from `walletId` or `userId` |
| `POST /api/circle/create-transfer-challenge` | Create USDC transfer challenge → `challengeId` |

All routes return a `challengeId`. The frontend calls `sdk.execute(challengeId)`
which opens the Circle PIN modal in the browser. Circle's MPC network handles
co-signing and broadcasting. **No private key ever reaches the server.**

### First-time user flow

1. User signs in with Google → `/api/circle/social-login` creates their Circle
   account (idempotent) and looks up any existing wallet
2. If no wallet exists yet, the backend calls `/user/initialize` to get an
   `initChallengeId` and returns `walletPending: true`
3. Frontend calls `sdk.execute(initChallengeId)` → user sets their PIN
4. Circle creates the MPC wallet; frontend polls `/api/circle/wallet-address`
   until the address is available

---

## x402 Payments

Protected endpoints require a small USDC payment per request. The payment uses
the same Circle SDK challenge flow — the user sees a PIN confirmation modal
before each fee is deducted from their wallet.

```env
NEXT_PUBLIC_X402_PAYEE_ADDRESS=0x...  # wallet that receives fees
NEXT_PUBLIC_X402_PRICE=0.001          # price per request in USDC
```

---

## OASF Skills & Domains (Optional)

Edit `src/register.ts` and add before `registerIPFS()`:

```typescript
agent.addSkill('natural_language_processing/natural_language_generation/summarization');
agent.addDomain('technology/software_engineering');
```

Browse the full taxonomy: https://schema.oasf.outshift.com/0.8.0

---

## Going Live

1. Update `AGENT_CONFIG` endpoint URLs in `src/register.ts` to your production domain
2. Re-run `npm run register`
3. Deploy to Vercel, Railway, or your preferred host
4. Ensure `CIRCLE_API_KEY`, `NEXT_PUBLIC_CIRCLE_APP_ID`, and `NEXT_PUBLIC_GOOGLE_CLIENT_ID`
   are set in your production environment

---

## Resources

- [Circle User-Controlled Wallets](https://developers.circle.com/w3s/user-controlled-wallets-overview)
- [Circle Programmable Wallets Overview](https://developers.circle.com/w3s/programmable-wallets-overview)
- [ERC-8004 Standard](https://eips.ethereum.org/EIPS/eip-8004)
- [8004scan Explorer](https://www.8004scan.io/)
- [Agent0 SDK Docs](https://sdk.ag0.xyz/)
- [OASF Taxonomy](https://github.com/8004-org/oasf)