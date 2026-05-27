// app/api/circle/wallet-address/route.ts
import { NextRequest, NextResponse } from 'next/server'

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
    const first = data?.data?.wallets?.[0] ?? null
    if (!first) return NextResponse.json({ address: null, walletId: null })
    const resolvedWalletId = first?.id ?? first?.walletId ?? null
    const address = first?.address ?? first?.wallet?.address ?? null
    return NextResponse.json({ address, walletId: resolvedWalletId })
  }

  return NextResponse.json({ error: 'walletId or userId is required' }, { status: 400 })
}