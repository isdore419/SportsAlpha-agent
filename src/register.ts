import 'dotenv/config';
import { SDK } from 'agent0-sdk';

// =========================================================================
// Agent Configuration
// =========================================================================
// ─── FIX: Replace example.com placeholders with real URLs before running ──
// These values get pinned to IPFS and written on-chain permanently.
// If you register with example.com URLs your agent card will point to dead
// endpoints and other agents/clients won't be able to reach you.
const AGENT_CONFIG = {
  name: 'SportsAlpha',
  description: 'Scores agent for NFL, NBA, NHL, and football',
  image: 'https://images.unsplash.com/photo-1504450758481-7338eba7524a?w=400',
  a2aEndpoint: process.env.A2A_ENDPOINT || 'https://sportsalpha.example.com/.well-known/agent-card.json',
  mcpEndpoint: process.env.MCP_ENDPOINT || 'https://sportsalpha.example.com/mcp',
};

const ARC_CHAIN_ID = 5042002;

// ─── FIX: Correct Arc Testnet RPC URL ────────────────────────────────────────
// The old value 'https://rpc.testnet.arc.network' is incorrect and will cause
// waitMined() to time out or fail silently. The correct public RPC endpoint
// is 'https://testnet-rpc.arc.network' — consistent with the rest of the app.
const ARC_RPC_URL = process.env.RPC_URL || 'https://testnet-rpc.arc.network';

// =========================================================================
// Main Registration Flow
// =========================================================================
// This script performs a one-time on-chain registration of the SportsAlpha
// agent in the ERC-8004 registry.
//
// WALLET CUSTODY MODEL:
// SportsAlpha uses Circle User-Controlled Wallets — each user owns their
// own keys and signs via Circle's SDK PIN modal. No server ever holds or
// sees user private keys. The application does NOT require any local
// private keys at runtime.
//
// DEPLOYER KEY REQUIREMENT (one-time only):
// This script writes to the on-chain registry, which requires a signer.
// Set DEPLOYER_PRIVATE_KEY in your .env for this script only — it is never
// used at runtime and never committed to source control.
// After registration succeeds once, this script does not need to run again.
// =========================================================================
async function main() {
  const pinataJwt = process.env.PINATA_JWT;
  if (!pinataJwt) {
    throw new Error(
      'PINATA_JWT not set in .env\n' +
      '  → Get your JWT from https://app.pinata.cloud/developers/api-keys\n' +
      '  → Add it to .env as: PINATA_JWT=your_jwt_here'
    );
  }

  // ─── FIX: Guard for deployer key before attempting on-chain write ─────────
  // The SDK is initialized without a private key below (read/metadata mode),
  // but registerIPFS() is an on-chain write that requires a signer. Without
  // this guard the script throws a cryptic SDK error deep in ethers.
  // Set DEPLOYER_PRIVATE_KEY in .env (0x-prefixed) for the one-time registration.
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) {
    throw new Error(
      'DEPLOYER_PRIVATE_KEY not set in .env\n' +
      '  → This is required once to pay gas for the on-chain registry write.\n' +
      '  → Use a funded Arc Testnet wallet: export its private key and add to .env\n' +
      '  → Add it as: DEPLOYER_PRIVATE_KEY=0x...\n' +
      '  → This key is never used at runtime — only for this registration script.'
    );
  }

  // ─── FIX: Warn if placeholder endpoints are still set ────────────────────
  if (
    AGENT_CONFIG.a2aEndpoint.includes('example.com') ||
    AGENT_CONFIG.mcpEndpoint.includes('example.com')
  ) {
    console.warn(
      '\n⚠️  WARNING: Agent endpoints still point to example.com placeholders.\n' +
      '   These will be pinned to IPFS and written on-chain permanently.\n' +
      '   Set A2A_ENDPOINT and MCP_ENDPOINT in your .env before registering.\n' +
      '   Continuing in 5 seconds — Ctrl+C to abort...\n'
    );
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log('🔧 Initializing Agent0 SDK...');
  console.log(`   RPC: ${ARC_RPC_URL}`);
  console.log(`   A2A: ${AGENT_CONFIG.a2aEndpoint}`);
  console.log(`   MCP: ${AGENT_CONFIG.mcpEndpoint}`);

  const sdk = new SDK({
    chainId: ARC_CHAIN_ID,
    rpcUrl: ARC_RPC_URL,
    // ─── FIX: Pass deployer private key so registerIPFS() can sign ───────────
    // Without a signer the SDK cannot submit the on-chain transaction and will
    // throw an internal ethers "missing provider" or "no signer" error.
    privateKey: deployerKey,
    ipfs: 'pinata',
    pinataJwt,
    registryOverrides: {
      [ARC_CHAIN_ID]: {
        IDENTITY:   '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        REPUTATION: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      },
    },
  });

  console.log('🚀 Creating agent...');
  const agent = sdk.createAgent(
    AGENT_CONFIG.name,
    AGENT_CONFIG.description,
    AGENT_CONFIG.image
  );

  console.log('🔗 Setting endpoints...');
  await agent.setMCP(AGENT_CONFIG.mcpEndpoint);
  await agent.setA2A(AGENT_CONFIG.a2aEndpoint);

  console.log('🔒 Setting trust and status...');
  agent.setTrust(true, false, true);
  agent.setActive(true);
  agent.setX402Support(true);

  console.log('⚙️  Registering agent on Arc Testnet...');
  const txHandle = await agent.registerIPFS();
  const { result } = await txHandle.waitMined();

  console.log('\n✅ Agent registered successfully!');
  console.log('🆔 Agent ID:', result.agentId);
  console.log('🔗 Agent URI:', result.agentURI);
  console.log('\n   All runtime wallet operations are handled by Circle User-Controlled Wallets.');
  console.log('   Users sign their own transactions via the Circle SDK PIN modal.');
  console.log('\n   You can safely remove DEPLOYER_PRIVATE_KEY from .env now — it is not needed at runtime.');
}

main().catch((error) => {
  console.error('❌ Registration failed:', error.message || error);
  process.exit(1);
});