// app/api/circle/wallet-address/route.ts
import { NextRequest, NextResponse } from 'next/server'

// ─── FIX: Always prefer ARC-TESTNET wallets ──────────────────────────────────
// Previously walletsList[0] could return an ETH-SEPOLIA wallet if the user
// had one from before the chain fix. That caused the frontend to store the wrong
// walletId in session, making every subsequent transfer fail.
const ARC_BLOCKCHAIN = 'ARC-TESTNET'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { walletId, userId } = body

  // ── Path A: direct walletId lookup (existing callers) ──
  if (walletId) {
    const resp = await fetch(`https://api.circle.com/v1/w3s/wallets/${encodeURIComponent(walletId)}`, {
      headers: { Authorization: `Bearer ${process.env.CIRCLE_API_KEY}` },
    })
    const data = await resp.json()
    const address = data?.data?.wallet?.address ?? data?.data?.address ?? data?.address ?? null
    return NextResponse.json({ address, walletId })
  }

  // ── Path B: userId lookup (used by walletPending polling in page.tsx) ──
  if (userId) {
    const resp = await fetch(
      `https://api.circle.com/v1/w3s/wallets?userId=${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${process.env.CIRCLE_API_KEY}` } }
    )
    const data = await resp.json()
    const walletsList: any[] = data?.data?.wallets ?? data?.wallets ?? []

    if (!walletsList.length) return NextResponse.json({ address: null, walletId: null })

    // ─── FIX: Prefer ARC-TESTNET wallet; fall back to first if none found ────
    // Without this, users with an old ETH-SEPOLIA wallet would get that wallet's
    // ID back, causing transfers to target the wrong chain.
    const preferred = walletsList.find((w: any) => w?.blockchain === ARC_BLOCKCHAIN)
    const first = preferred ?? walletsList[0]

    const resolvedWalletId = first?.id ?? first?.walletId ?? null
    const address = first?.address ?? first?.wallet?.address ?? null
    return NextResponse.json({ address, walletId: resolvedWalletId })
  }

  return NextResponse.json({ error: 'walletId or userId is required' }, { status: 400 })
}