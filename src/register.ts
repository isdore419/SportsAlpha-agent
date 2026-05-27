import 'dotenv/config';
import { SDK } from 'agent0-sdk';

// =========================================================================
// Agent Configuration
// =========================================================================
const AGENT_CONFIG = {
  name: 'SportsAlpha',
  description: 'Scores agent for NFL, NBA, NHL, and football',
  image: 'https://images.unsplash.com/photo-1504450758481-7338eba7524a?w=400',
  a2aEndpoint: 'https://sportsalpha.example.com/.well-known/agent-card.json',
  mcpEndpoint: 'https://sportsalpha.example.com/mcp',
};

const ARC_CHAIN_ID = 5042002;

// =========================================================================
// Main Registration Flow
// =========================================================================
async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('PRIVATE_KEY not set in .env');

  const pinataJwt = process.env.PINATA_JWT;
  if (!pinataJwt) throw new Error('PINATA_JWT not set in .env');

  const rpcUrl = process.env.RPC_URL || 'https://rpc.testnet.arc.network';

  console.log('🔧 Initializing Agent0 SDK...');
  const sdk = new SDK({
    chainId: ARC_CHAIN_ID,
    rpcUrl,
    privateKey,
    ipfs: 'pinata',
    pinataJwt,
    // ✅ FIXED: uppercase keys IDENTITY/REPUTATION match the SDK's internal format
    registryOverrides: {
      [ARC_CHAIN_ID]: {
        IDENTITY:   '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        REPUTATION: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      },
    },
  });

  console.log('🚀 Creating agent...');
  // ✅ synchronous - no await
  const agent = sdk.createAgent(
    AGENT_CONFIG.name,
    AGENT_CONFIG.description,
    AGENT_CONFIG.image
  );

  console.log('🔗 Setting endpoints...');
  await agent.setMCP(AGENT_CONFIG.mcpEndpoint);
  await agent.setA2A(AGENT_CONFIG.a2aEndpoint);

  console.log('🔒 Setting trust and status...');
  // ✅ all synchronous - no await
  agent.setTrust(true, false, true);
  agent.setActive(true);
  agent.setX402Support(true);

  console.log('⚙️ Registering agent on Arc Testnet...');
  // ✅ zero arguments, returns TransactionHandle
  const txHandle = await agent.registerIPFS();
  const { result } = await txHandle.waitMined();

  console.log('\n✅ Agent registered successfully!');
  console.log('🆔 Agent ID:', result.agentId);
  console.log('🔗 Agent URI:', result.agentURI);
}

main().catch((error) => {
  console.error('❌ Registration failed:', error.message || error);
  process.exit(1);
});