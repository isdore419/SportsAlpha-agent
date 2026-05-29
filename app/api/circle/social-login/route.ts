// app/api/circle/social-login/route.ts
import { NextRequest, NextResponse } from 'next/server'

// ─── FIX: Circle's official identifier for Arc Testnet ───────────────────────
// Previously hardcoded as 'ETH-SEPOLIA' inside the /user/initialize call.
// That created wallets on Ethereum Sepolia (chainId 11155111), not Arc Testnet
// (chainId 5042002).  All USDC transfers and balance checks were hitting the
// wrong chain, which is why Circle returned no challengeId and the SDK threw
// "invalid private key" when it couldn't find the key material for the chain.
const ARC_BLOCKCHAIN = 'ARC-TESTNET'

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const payload = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')
    const decoded = Buffer.from(payload, 'base64').toString('utf-8')
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

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

async function getCircleSessionToken(
  userId: string
): Promise<{ userToken: string; encryptionKey: string }> {
  const tokenResponse = await fetch('https://api.circle.com/v1/w3s/users/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
    },
    body: JSON.stringify({ userId }),
  })

  let tokenData: any = null
  try {
    tokenData = await tokenResponse.json()
  } catch (parseErr) {
    console.error('[social-login] Failed to parse token response as JSON:', parseErr)
    throw new Error('Circle token endpoint returned non-JSON response')
  }

  console.log('[social-login] RAW token response:', JSON.stringify(tokenData, null, 2))

  if (!tokenResponse.ok) {
    console.error('[social-login] Token fetch failed:', tokenResponse.status, tokenData)
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
    console.error('[social-login] Malformed token response (could not find userToken/encryptionKey):', tokenData)
    throw new Error(
      `Circle session token response was malformed. Received: ${JSON.stringify(tokenData)}`
    )
  }

  return { userToken, encryptionKey }
}

async function lookupWallet(
  userId: string
): Promise<{ walletId: string | null; walletAddress: string | null }> {
  const walletsResponse = await fetch(
    `https://api.circle.com/v1/w3s/wallets?userId=${encodeURIComponent(userId)}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.CIRCLE_API_KEY}` },
    }
  )

  let walletsData: any = null
  try {
    walletsData = await walletsResponse.json()
  } catch (parseErr) {
    console.error('[social-login] Failed to parse wallets response as JSON:', parseErr)
    return { walletId: null, walletAddress: null }
  }

  console.log('[social-login] RAW wallets response:', JSON.stringify(walletsData, null, 2))

  const walletsList: any[] =
    walletsData?.data?.wallets ??
    walletsData?.wallets ??
    []

  // ─── FIX: Prefer ARC-TESTNET wallet; ignore wallets on other chains ─────────
  // Previously: walletsList[0] — could grab an ETH-SEPOLIA wallet created before
  // this fix, causing all operations to run on the wrong chain.
  const firstWallet = Array.isArray(walletsList) && walletsList.length > 0
    ? (walletsList.find((w: any) => w?.blockchain === ARC_BLOCKCHAIN) ?? walletsList[0])
    : null

  if (!firstWallet) return { walletId: null, walletAddress: null }

  const parsed = parseWalletInfo(firstWallet)
  return { walletId: parsed.walletId, walletAddress: parsed.address }
}

async function resolveWalletAddress(walletId: string): Promise<string | null> {
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
  } catch (parseErr) {
    console.error('[social-login] Failed to parse wallet detail response as JSON:', parseErr)
    return null
  }

  console.log('[social-login] RAW wallet detail response:', JSON.stringify(walletData, null, 2))

  return (
    walletData?.data?.wallet?.address ??
    walletData?.data?.address ??
    walletData?.wallet?.address ??
    walletData?.address ??
    null
  )
}

export async function POST(req: NextRequest) {
  try {
    let body: any = null
    try {
      body = await req.json()
    } catch (parseErr) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const idToken = body?.idToken

    const rawType = body?.type ?? body?.intent
    const type: 'signup' | 'signin' = rawType === 'signup' ? 'signup' : 'signin'

    console.log('[social-login] received type:', type, '(raw:', rawType, ')')

    if (!idToken || typeof idToken !== 'string') {
      return NextResponse.json({ error: 'idToken is required' }, { status: 400 })
    }

    const tokenPayload = decodeJwtPayload(idToken)
    const email = tokenPayload?.email

    if (!email || typeof email !== 'string') {
      return NextResponse.json(
        { error: 'Google idToken must include an email address' },
        { status: 400 }
      )
    }

    // Step 1: Create Circle user (idempotent)
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
    } catch (parseErr) {
      console.error('[social-login] Failed to parse user creation response as JSON:', parseErr)
      if (!circleUserResponse.ok) {
        throw new Error('Circle user creation returned a non-JSON error response')
      }
    }

    console.log('[social-login] RAW user creation response:', JSON.stringify(circleUserData, null, 2))

    if (!circleUserResponse.ok) {
      const isAlreadyExists =
        circleUserData?.code === 155101 ||
        circleUserData?.code === 155104 ||
        (typeof circleUserData?.message === 'string' &&
          circleUserData.message.toLowerCase().includes('already'))

      if (isAlreadyExists) {
        if (type === 'signup') {
          return NextResponse.json(
            { error: 'An account with this Google email already exists. Please use Sign In.' },
            { status: 409 }
          )
        }
        console.log(`[social-login] Circle user ${email} already exists (${type}) — continuing.`)
      } else {
        console.error('[social-login] Circle user creation error:', circleUserData)
        throw new Error(
          `Circle user creation failed: ${circleUserData?.message ?? JSON.stringify(circleUserData)}`
        )
      }
    } else {
      console.log(`[social-login] Circle user created for ${email} (${type})`)
    }

    // Step 2: Obtain session token
    const { userToken, encryptionKey } = await getCircleSessionToken(email)

    // Step 3: Look up existing wallets
    let { walletId, walletAddress } = await lookupWallet(email)

    // Step 4: Create wallet if none found
    if (!walletId) {
      console.log(`[social-login] No wallet found for ${email} — attempting creation.`)

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
      } catch (parseErr) {
        console.error('[social-login] Failed to parse wallet creation response as JSON:', parseErr)
        if (!createWalletResponse.ok) {
          throw new Error('Circle wallet creation returned a non-JSON error response')
        }
      }

      console.log('[social-login] RAW wallet creation response:', JSON.stringify(createWalletData, null, 2))

      if (!createWalletResponse.ok) {
        const isResourceNotFound =
          createWalletData?.code === -1 ||
          (typeof createWalletData?.message === 'string' && (
            createWalletData.message.toLowerCase().includes('resource not found') ||
            createWalletData.message.toLowerCase().includes('not found')
          ))

        if (isResourceNotFound) {
          console.warn(
            `[social-login] Wallet creation blocked (code ${createWalletData?.code}) — ` +
            `user ${email} has not completed Circle SDK initialization. ` +
            `Returning walletPending=true so frontend can call sdk.execute().`
          )

          // ─── FIX: Pass ARC-TESTNET to /user/initialize ───────────────────────
          // Previously: blockchains: ['ETH-SEPOLIA']
          // Circle's /user/initialize binds the MPC key material to a specific chain.
          // Using ETH-SEPOLIA here was creating wallets that couldn't interact with
          // Arc Testnet USDC, causing every challengeId call to fail.
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
                idempotencyKey: crypto.randomUUID(),
                accountType: 'SCA',
                blockchains: [ARC_BLOCKCHAIN], // ← FIX: was 'ETH-SEPOLIA'
              }),
            })

            let initData: any = null
            try {
              initData = await initRes.json()
            } catch (parseErr) {
              console.warn('[social-login] Failed to parse init response as JSON:', parseErr)
            }

            console.log('[social-login] RAW initialize response:', JSON.stringify(initData, null, 2))

            initChallengeId =
              initData?.data?.challengeId ??
              initData?.challengeId ??
              null

            console.log('[social-login] SDK initialize challengeId:', initChallengeId)
          } catch (initErr: any) {
            console.warn('[social-login] Could not obtain init challengeId:', initErr?.message)
          }

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

        console.error('[social-login] Wallet creation failed:', createWalletData)
        throw new Error(createWalletData?.message || 'Failed to create Circle wallet')
      }

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

    // Step 5: Resolve address if missing
    if (walletId && !walletAddress) {
      walletAddress = await resolveWalletAddress(walletId)
    }

    if (!walletId) {
      throw new Error(
        'Circle login failed to return a walletId. Please contact support or try again.'
      )
    }

    console.log(`[social-login] Success for ${email}. walletId: ${walletId}`)

    return NextResponse.json({
      success: true,
      userToken,
      encryptionKey,
      walletId,
      walletAddress: walletAddress ?? '',
      walletPending: false,
    })
  } catch (error: any) {
    console.error('[social-login] Unhandled error:', error)
    return NextResponse.json(
      { error: error?.message ?? 'Internal server error' },
      { status: 500 }
    )
  }
}