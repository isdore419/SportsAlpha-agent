// app/api/circle/create-transfer-challenge/route.ts
import { NextRequest, NextResponse } from 'next/server'

// Arc Testnet USDC contract address (official, from Circle docs)
const ARC_TESTNET_USDC = '0x3600000000000000000000000000000000000000'
const ARC_BLOCKCHAIN = 'ARC-TESTNET'

export async function POST(req: NextRequest) {
  const { userToken, walletId, toAddress, amount, contractAddress } = await req.json()

  if (!userToken || !walletId || !toAddress || !amount) {
    return NextResponse.json(
      { error: 'Missing required fields: userToken, walletId, toAddress, amount' },
      { status: 400 }
    )
  }

  const tokenAddress = contractAddress || ARC_TESTNET_USDC

  const parsedAmount = parseFloat(amount)
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return NextResponse.json(
      { error: 'Invalid amount: must be a positive number' },
      { status: 400 }
    )
  }

  // ─── FIX: SCA wallets REQUIRE feeLevel — not gasPrice/gasLimit ───────────────
  // The wallet type is SCA (Smart Contract Account / circle_6900_singleowner_v3).
  // Circle error code 155232: "SCA transaction needs feeLevel provided."
  // SCA wallets do NOT accept raw gasPrice/gasLimit — they only accept:
  //   feeLevel: 'LOW' | 'MEDIUM' | 'HIGH'
  // This applies even on ARC-TESTNET when the accountType is SCA.
  const resp = await fetch('https://api.circle.com/v1/w3s/user/transactions/transfer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
      'X-User-Token': userToken,
    },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      walletId,
      destinationAddress: toAddress,
      tokenAddress,
      blockchain: ARC_BLOCKCHAIN,
      amounts: [String(parsedAmount.toFixed(6))],
      feeLevel: 'MEDIUM', // ✅ Required for SCA wallets (code 155232 fix)
    }),
  })

  let data: any = null
  try {
    data = await resp.json()
  } catch (parseErr) {
    console.error('[create-transfer-challenge] Failed to parse Circle response:', parseErr)
    return NextResponse.json({ error: 'Circle API returned a non-JSON response' }, { status: 500 })
  }

  console.log('[create-transfer-challenge] Circle API response:', JSON.stringify(data, null, 2))

  const challengeId = data?.data?.challengeId ?? data?.challengeId ?? null

  if (!challengeId) {
    const circleErrors = data?.errors ?? data?.data?.errors ?? null
    const reason =
      data?.message ??
      data?.data?.message ??
      data?.error ??
      (circleErrors ? JSON.stringify(circleErrors) : null) ??
      JSON.stringify(data)

    console.error('[create-transfer-challenge] No challengeId returned.')
    console.error('[create-transfer-challenge] HTTP status:', resp.status)
    console.error('[create-transfer-challenge] Reason:', reason)
    if (circleErrors) {
      console.error('[create-transfer-challenge] Circle errors[]:', JSON.stringify(circleErrors, null, 2))
    }

    let friendlyError = `No challengeId returned from Circle: ${reason}`

    if (typeof reason === 'string') {
      if (reason.toLowerCase().includes('insufficient') || reason.toLowerCase().includes('balance')) {
        friendlyError = 'Insufficient USDC balance to complete this transfer. Please top up your wallet.'
      } else if (reason.toLowerCase().includes('token') || reason.toLowerCase().includes('contract')) {
        friendlyError = 'Token not found on ARC-TESTNET. Ensure your wallet is funded with Arc Testnet USDC.'
      } else if (reason.toLowerCase().includes('wallet') || reason.toLowerCase().includes('not found')) {
        friendlyError = 'Wallet not found or not yet initialized. Please sign out and sign back in.'
      } else if (reason.toLowerCase().includes('unauthorized') || reason.toLowerCase().includes('token expired')) {
        friendlyError = 'Session expired. Please sign out and sign back in to refresh your credentials.'
      } else if (reason.toLowerCase().includes('feellevel') || reason.toLowerCase().includes('fee')) {
        friendlyError = 'Fee configuration error. This is a server-side issue — contact support.'
      } else if (reason.toLowerCase().includes('blockchain') || reason.toLowerCase().includes('eth-sepolia')) {
        friendlyError = 'Wallet is on the wrong chain. Please sign out and sign back in to re-initialize on Arc Testnet.'
      }
    }

    return NextResponse.json({ error: friendlyError, details: data }, { status: 500 })
  }

  return NextResponse.json({ challengeId })
}