// app/api/circle/create-transfer-challenge/route.ts
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const { userToken, walletId, toAddress, amount, contractAddress } = await req.json()
  const resp = await fetch('https://api.circle.com/v1/w3s/user/transactions/contractExecution', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
      'X-User-Token': userToken,
    },
    body: JSON.stringify({
      walletId,
      contractAddress,
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters: [toAddress, String(Math.floor(parseFloat(amount) * 1_000_000))],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    }),
  })
  const data = await resp.json()
  const challengeId = data?.data?.challengeId
  if (!challengeId) return NextResponse.json({ error: 'No challengeId returned' }, { status: 500 })
  return NextResponse.json({ challengeId })
}