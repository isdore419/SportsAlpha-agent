// app/api/wallet/initialize-user/route.ts
import { NextRequest, NextResponse } from 'next/server'

function parseWalletInfo(wallet: any) {
  if (!wallet) return { walletId: null, address: null }
  return {
    walletId:
      wallet?.id ??
      wallet?.walletId ??
      wallet?.wallet?.id ??
      wallet?.wallet?.walletId ??
      null,
    address:
      wallet?.address ??
      wallet?.wallet?.address ??
      wallet?.walletAddress ??
      null,
  }
}

export async function POST(req: NextRequest) {
  try {
    let body: any = null
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const email = body?.email
    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    // ─── Step 1: Create Circle user (idempotent) ──────────────────────────────
    const circleUserResponse = await fetch('https://api.circle.com/v1/w3s/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
      },
      body: JSON.stringify({ userId: email }),
    })

    let circleUserData: any = null
    try {
      circleUserData = await circleUserResponse.json()
    } catch {
      if (!circleUserResponse.ok) {
        throw new Error('Circle user creation returned a non-JSON error response')
      }
    }

    console.log('[initialize-user] RAW user creation response:', JSON.stringify(circleUserData, null, 2))

    if (!circleUserResponse.ok) {
      const isAlreadyExists =
        circleUserData?.code === 155101 ||
        circleUserData?.code === 155104 ||
        (typeof circleUserData?.message === 'string' &&
          circleUserData.message.toLowerCase().includes('already'))

      if (!isAlreadyExists) {
        throw new Error(
          `Circle user creation failed: ${circleUserData?.message ?? JSON.stringify(circleUserData)}`
        )
      }
      console.log(`[initialize-user] User ${email} already exists — continuing.`)
    }

    // ─── Step 2: Get session token ────────────────────────────────────────────
    const tokenResponse = await fetch('https://api.circle.com/v1/w3s/users/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
      },
      body: JSON.stringify({ userId: email }),
    })

    let tokenData: any = null
    try {
      tokenData = await tokenResponse.json()
    } catch {
      throw new Error('Circle token endpoint returned a non-JSON response')
    }

    console.log('[initialize-user] RAW token response:', JSON.stringify(tokenData, null, 2))

    if (!tokenResponse.ok) {
      throw new Error(
        `Failed to obtain Circle session token (HTTP ${tokenResponse.status}): ${
          tokenData?.message ?? JSON.stringify(tokenData)
        }`
      )
    }

    const userToken =
      tokenData?.data?.userToken ??
      tokenData?.userToken ??
      null

    const encryptionKey =
      tokenData?.data?.encryptionKey ??
      tokenData?.encryptionKey ??
      null

    if (!userToken || !encryptionKey) {
      throw new Error(
        `Circle session token response was malformed. Received: ${JSON.stringify(tokenData)}`
      )
    }

    // ─── Step 3: Look up existing wallets ─────────────────────────────────────
    let walletId: string | null = null
    let walletAddress: string | null = null

    const walletsResponse = await fetch(
      `https://api.circle.com/v1/w3s/wallets?userId=${encodeURIComponent(email)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${process.env.CIRCLE_API_KEY}` },
      }
    )

    let walletsData: any = null
    try {
      walletsData = await walletsResponse.json()
    } catch {
      console.warn('[initialize-user] Could not parse wallets response — assuming no wallets.')
    }

    console.log('[initialize-user] RAW wallets response:', JSON.stringify(walletsData, null, 2))

    const walletsList: any[] =
      walletsData?.data?.wallets ??
      walletsData?.wallets ??
      []

    const firstWallet = Array.isArray(walletsList) && walletsList.length > 0
      ? walletsList[0]
      : null

    if (firstWallet) {
      const parsed = parseWalletInfo(firstWallet)
      walletId = parsed.walletId
      walletAddress = parsed.address
    }

    // ─── Step 4: If no wallet, try server-side creation first ─────────────────
    //     Circle blocks this until the user completes SDK PIN setup.
    //     If it returns code -1 / "resource not found" we fall through to SDK init.
    if (!walletId) {
      console.log(`[initialize-user] No wallet found for ${email} — attempting server-side creation.`)

      const createWalletResponse = await fetch('https://api.circle.com/v1/w3s/wallets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
        },
        body: JSON.stringify({ userId: email }),
      })

      let createWalletData: any = null
      try {
        createWalletData = await createWalletResponse.json()
      } catch {
        console.warn('[initialize-user] Could not parse wallet creation response.')
      }

      console.log('[initialize-user] RAW wallet creation response:', JSON.stringify(createWalletData, null, 2))

      if (!createWalletResponse.ok) {
        // ── "Resource not found" means the user exists but hasn't run SDK init ──
        // This is NOT a hard crash — we handle it gracefully by requesting a
        // challengeId so the frontend can call sdk.execute() to complete PIN setup.
        const isResourceNotFound =
          createWalletData?.code === -1 ||
          (typeof createWalletData?.message === 'string' && (
            createWalletData.message.toLowerCase().includes('resource not found') ||
            createWalletData.message.toLowerCase().includes('not found')
          ))

        if (isResourceNotFound) {
          console.warn(
            `[initialize-user] Server-side wallet creation blocked for ${email} ` +
            `(code ${createWalletData?.code}) — user needs SDK PIN initialization. ` +
            `Fetching challengeId for frontend sdk.execute() call.`
          )

          // ── Request a challengeId from /user/initialize ──────────────────────
          let initChallengeId: string | null = null
          try {
            const initRes = await fetch('https://api.circle.com/v1/w3s/user/initialize', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
                'X-User-Token': userToken,
              },
              body: JSON.stringify({
                idempotencyKey: crypto.randomUUID(), // ✅ must be a valid UUID v4
                accountType: 'SCA',
                blockchains: ['ETH-SEPOLIA'],
              }),
            })

            let initData: any = null
            try {
              initData = await initRes.json()
            } catch {
              console.warn('[initialize-user] Could not parse /user/initialize response.')
            }

            console.log('[initialize-user] RAW initialize response:', JSON.stringify(initData, null, 2))

            initChallengeId =
              initData?.data?.challengeId ??
              initData?.challengeId ??
              null

            console.log('[initialize-user] SDK initialize challengeId:', initChallengeId)
          } catch (initErr: any) {
            console.warn('[initialize-user] Could not obtain init challengeId:', initErr?.message)
          }

          // Return walletPending so frontend knows to call sdk.execute()
          return NextResponse.json({
            success: true,
            userToken,
            encryptionKey,
            walletId: null,
            walletAddress: '',
            walletPending: true,
            initChallengeId,
          })
        }

        // Any other wallet creation error is a genuine failure
        throw new Error(
          `Circle wallet creation failed: ${createWalletData?.message ?? JSON.stringify(createWalletData)}`
        )
      }

      // Wallet created successfully — extract id and address
      const walletPayload =
        createWalletData?.data?.wallet ??
        createWalletData?.data ??
        createWalletData?.wallet ??
        createWalletData ??
        null

      const parsed = parseWalletInfo(walletPayload)
      walletId = parsed.walletId
      walletAddress = parsed.address
    }

    // ─── Step 5: Resolve address separately if still missing ──────────────────
    if (walletId && !walletAddress) {
      const walletResponse = await fetch(
        `https://api.circle.com/v1/w3s/wallets/${encodeURIComponent(walletId)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${process.env.CIRCLE_API_KEY}` },
        }
      )

      let walletData: any = null
      try {
        walletData = await walletResponse.json()
      } catch {
        console.warn('[initialize-user] Could not parse wallet detail response.')
      }

      console.log('[initialize-user] RAW wallet detail response:', JSON.stringify(walletData, null, 2))

      walletAddress =
        walletData?.data?.wallet?.address ??
        walletData?.data?.address ??
        walletData?.wallet?.address ??
        walletData?.address ??
        null
    }

    if (!walletId) {
      throw new Error('Circle wallet initialization failed to return a walletId.')
    }

    console.log(`[initialize-user] Success for ${email}. walletId: ${walletId}`)

    return NextResponse.json({
      success: true,
      userToken,
      encryptionKey,
      walletId,
      walletAddress: walletAddress ?? '',
      walletPending: false,
    })
  } catch (error: any) {
    console.error('Backend Wallet Route Error:', error)
    return NextResponse.json(
      { error: error?.message ?? 'Internal Server Error' },
      { status: 500 }
    )
  }
}