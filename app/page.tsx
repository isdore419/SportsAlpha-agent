"use client"

/*
  ╔══════════════════════════════════════════════════════════════╗
  ║             SPORTS ALPHA — Arc Network AI Agent             ║
  ║                    Production page.tsx                      ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  REQUIRED .env.local variables:                             ║
  ║  NEXT_PUBLIC_ARC_RPC_URL=https://testnet-rpc.arc.network    ║
  ║  NEXT_PUBLIC_USDC_CONTRACT=0x3600000000000000000000000000000000000000 ║
  ║  NEXT_PUBLIC_ARC_CHAIN_ID=5042002                           ║
  ║  NEXT_PUBLIC_CIRCLE_APP_ID=your_circle_app_id               ║
  ║  NEXT_PUBLIC_GOOGLE_CLIENT_ID=your_google_client_id         ║
  ║  NEXT_PUBLIC_X402_PRICE=0.001                               ║
  ║  NEXT_PUBLIC_X402_PAYEE_ADDRESS=0x...receiver...            ║
  ║                                                             ║
  ║  REQUIRED packages:                                         ║
  ║  npm install @circle-fin/w3s-pw-web-sdk                     ║
  ╚══════════════════════════════════════════════════════════════╝
*/

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { W3SSdk } from '@circle-fin/w3s-pw-web-sdk'

/* ─────────────────────────────────────────────────────────────
   CONFIG  — all driven by .env.local
───────────────────────────────────────────────────────────── */
const ARC_RPC_URLS: string[] = [
  process.env.NEXT_PUBLIC_ARC_RPC_URL,
  'https://testnet-rpc.arc.network',
  'https://arc-testnet.g.alchemy.com/v2/A-_-J_DDdsCeBwnwEIXon',
].filter((u): u is string => typeof u === 'string' && u.length > 0)

const ARC_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID ?? '5042002')

const _USDC_RAW = (
  process.env.NEXT_PUBLIC_USDC_CONTRACT ?? '0x3600000000000000000000000000000000000000'
).trim()
let USDC_ADDR: string = _USDC_RAW
// Address stored as-is; validated at call sites with isEvmAddress()

const PROMPT_FEE_AMOUNT = (process.env.NEXT_PUBLIC_X402_PRICE        ?? '0.001').trim()
const RECEIVER_ADDRESS  = (process.env.NEXT_PUBLIC_X402_PAYEE_ADDRESS ?? '').trim()

const CIRCLE_WEB_CLIENT_ID = (process.env.NEXT_PUBLIC_CIRCLE_WEB_CLIENT_ID ?? '').trim()
// FIX: .trim() prevents trailing-space in .env from breaking Circle SDK init on Vercel.
// A space after the env value causes Circle SDK to receive the appId with a trailing space,
// which it rejects internally with a cryptic "invalid private key" error.
const CIRCLE_APP_ID        = (process.env.NEXT_PUBLIC_CIRCLE_APP_ID ?? 'f058d6a4-52d2-528a-b48f-38a619ba82e2').trim()
const GOOGLE_CLIENT_ID     = (process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? CIRCLE_WEB_CLIENT_ID ?? '665078515834-otn3ls8l6b2pil9i1a9igdlb6mfmdgfg.apps.googleusercontent.com').trim()

/* ─────────────────────────────────────────────────────────────
   CIRCLE SDK  — module-level singleton
───────────────────────────────────────────────────────────── */
let _circleSdkSingleton: W3SSdk | null = null
function getCircleSDK(): W3SSdk {
  if (_circleSdkSingleton) return _circleSdkSingleton
  if (!CIRCLE_APP_ID) throw new Error('NEXT_PUBLIC_CIRCLE_APP_ID is required')
  _circleSdkSingleton = new W3SSdk({ appSettings: { appId: CIRCLE_APP_ID } })
  return _circleSdkSingleton
}

/* ─────────────────────────────────────────────────────────────
   TYPES
───────────────────────────────────────────────────────────── */
interface StoredUser {
  username: string
  passwordHash: string
  walletAddress: string
  walletId?: string
  circleUserToken?: string
  circleEncryptionKey?: string
}
interface Session {
  username: string
  email: string
  walletAddress: string
  walletId?: string
  circleUserToken?: string
  circleEncryptionKey?: string
}
interface ChatMsg {
  id: string
  role: 'user' | 'ai' | 'system'
  text: string
  ts: number
}
interface WalletBal {
  usdc: string
  native: string
  loading: boolean
  error: string
}

declare global {
  interface Window { google?: any }
}

/* ─────────────────────────────────────────────────────────────
   LOCAL-STORAGE HELPERS
───────────────────────────────────────────────────────────── */
function getUsers(): Record<string, StoredUser> {
  if (typeof window === 'undefined') return {}
  try { return JSON.parse(localStorage.getItem('sa_users') || '{}') } catch { return {} }
}
function saveUsers(u: Record<string, StoredUser>) {
  localStorage.setItem('sa_users', JSON.stringify(u))
}
function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h.toString(16)
}

/* ─────────────────────────────────────────────────────────────
   ADDRESS HELPERS  (replaces ethers.getAddress / isAddress)
───────────────────────────────────────────────────────────── */
/** Lightweight EVM address validator — no ethers dependency required. */
function isEvmAddress(addr: string): boolean {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr)
}

/* ─────────────────────────────────────────────────────────────
   ARC NETWORK RPC
───────────────────────────────────────────────────────────── */
async function arcRPC(method: string, params: unknown[]): Promise<unknown> {
  let lastErr: Error = new Error('All Arc Testnet RPC endpoints failed')
  for (const rpcUrl of ARC_RPC_URLS) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      })
      if (!res.ok) throw new Error(`RPC HTTP ${res.status} from ${rpcUrl}`)
      const json = await res.json()
      if (json.error) throw new Error(json.error.message ?? 'RPC error')
      return json.result
    } catch (e: any) {
      console.warn(`[arcRPC] ${rpcUrl} failed:`, e?.message)
      lastErr = e instanceof Error ? e : new Error(String(e))
    }
  }
  throw lastErr
}

/* ─────────────────────────────────────────────────────────────
   BALANCE FETCHERS
───────────────────────────────────────────────────────────── */
async function fetchUSDCBalance(address: string): Promise<string> {
  const isZeroContract = !USDC_ADDR || USDC_ADDR.replace(/0/g, '').replace('x', '') === ''
  if (isZeroContract) return '0.00'
  const checksumAddr = address  // address already validated by isEvmAddress() at call sites
  const data = '0x70a08231' + checksumAddr.replace(/^0x/i, '').padStart(64, '0')
  let raw: string
  try {
    raw = (await arcRPC('eth_call', [{ to: USDC_ADDR, data }, 'latest'])) as string
  } catch (e: any) {
    console.error('[fetchUSDCBalance] RPC error:', e?.message ?? e)
    return '0.00'
  }
  if (!raw || raw === '0x') return '0.00'
  const bn    = BigInt(raw)
  const whole = bn / 1_000_000n
  const frac  = bn % 1_000_000n
  return `${whole}.${frac.toString().padStart(6, '0').slice(0, 2)}`
}

async function fetchNativeBalance(address: string): Promise<string> {
  const checksumAddr = address  // validated upstream
  const raw = (await arcRPC('eth_getBalance', [checksumAddr, 'latest'])) as string
  if (!raw || raw === '0x') return '0.0000'
  const wei = BigInt(raw)
  const eth = Number(wei) / 1e18
  return eth.toFixed(4)
}

/* ─────────────────────────────────────────────────────────────
   SEND USDC  (Circle MPC — no private key on client)
───────────────────────────────────────────────────────────── */
// All USDC transfers now go through the Circle Challenge flow:
// backend creates a transferChallenge → sdk.execute() shows PIN modal
// → Circle co-signs and broadcasts. No private key ever touches the
// browser. See deductPromptFee() and SendModal for the implementation.

/* ─────────────────────────────────────────────────────────────
   TOKEN REFRESH HELPER  (module-level, no React state needed)
───────────────────────────────────────────────────────────── */

/**
 * Fetch fresh userToken + encryptionKey from Circle without requiring a
 * full re-login.  Circle session tokens expire (typically ~1 h), so any
 * long-lived session will hit this.  We call initialize-user which is
 * fully idempotent — it never re-creates the user or wallet.
 */
async function refreshCircleTokens(
  email: string
): Promise<{ userToken: string; encryptionKey: string } | null> {
  try {
    const res = await fetch('/api/wallet/initialize-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const userToken     = typeof data?.userToken     === 'string' ? data.userToken     : null
    const encryptionKey = typeof data?.encryptionKey === 'string' ? data.encryptionKey : null
    if (!userToken || !encryptionKey) return null
    return { userToken, encryptionKey }
  } catch {
    return null
  }
}

/* ─────────────────────────────────────────────────────────────
   PROMPT FEE
───────────────────────────────────────────────────────────── */
async function deductPromptFee(session: Session): Promise<string> {
  if (!RECEIVER_ADDRESS) {
    console.warn('[PromptFee] NEXT_PUBLIC_X402_PAYEE_ADDRESS not set — fee skipped.')
    return 'skipped'
  }
  if (!isEvmAddress(RECEIVER_ADDRESS)) {
    throw new Error(`[PromptFee] Invalid payee address: "${RECEIVER_ADDRESS}". Check NEXT_PUBLIC_X402_PAYEE_ADDRESS.`)
  }

  if (!session.circleUserToken || !session.circleEncryptionKey || !session.walletId) {
    throw new Error('Wallet not initialised — please sign out and sign back in.')
  }

  // ── FIX: Refresh tokens before every fee deduction ───────────────────────
  // Circle session tokens expire (typically ~1 h). If we use a stale token,
  // Circle returns an auth error and we get "No challengeId returned" or
  // the Circle SDK throws "invalid private key" internally (ethers error).
  // Refreshing proactively on each message costs one cheap backend call but
  // completely eliminates the stale-token class of errors.
  let activeUserToken     = session.circleUserToken
  let activeEncryptionKey = session.circleEncryptionKey

  if (session.email) {
    const refreshed = await refreshCircleTokens(session.email)
    if (refreshed) {
      activeUserToken     = refreshed.userToken
      activeEncryptionKey = refreshed.encryptionKey
      // Persist fresh tokens to localStorage so the session survives the next
      // page refresh without immediately expiring again.
      try {
        const stored = localStorage.getItem('sa_session')
        if (stored) {
          const parsed = JSON.parse(stored)
          localStorage.setItem('sa_session', JSON.stringify({
            ...parsed,
            circleUserToken:     activeUserToken,
            circleEncryptionKey: activeEncryptionKey,
          }))
        }
      } catch { /* non-critical */ }
    }
  }

  const sdk = getCircleSDK()
  sdk.setAuthentication({
    userToken:     activeUserToken,
    encryptionKey: activeEncryptionKey,
  })

  const challengeRes = await fetch('/api/circle/create-transfer-challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userToken:       activeUserToken,
      walletId:        session.walletId,
      toAddress:       RECEIVER_ADDRESS,
      amount:          PROMPT_FEE_AMOUNT,
      contractAddress: USDC_ADDR,
    }),
  })

  if (!challengeRes.ok) {
    const errBody = await challengeRes.json().catch(() => ({}))
    const msg = (errBody as any)?.error ?? 'Failed to create Circle transfer challenge'
    // ── FIX: Detect the most common actionable failure modes ─────────────────
    if (msg.toLowerCase().includes('session expired') || msg.toLowerCase().includes('unauthorized')) {
      throw new Error('Session expired — please sign out and sign back in.')
    }
    throw new Error(msg)
  }

  const body = await challengeRes.json()
  const { challengeId } = body

  if (!challengeId) {
    throw new Error('No challengeId returned from Circle — check your USDC balance on Arc Testnet.')
  }

  return new Promise<string>((resolve, reject) => {
    sdk.execute(challengeId, (err: any, result: any) => {
      if (err) {
        // ── FIX: Translate SDK internal errors into actionable messages ────────
        // The Circle SDK uses ethers internally.  When key material is missing or
        // the chain doesn't match, ethers throws "invalid private key".  After the
        // backend fix (ARC-TESTNET wallet creation), this should not occur for new
        // wallets.  For users who signed up before the fix, they must sign out and
        // back in to re-initialize their wallet on the correct chain.
        const raw = err?.message ?? 'Circle challenge execution failed'
        const isKeyError = raw.toLowerCase().includes('private key') || raw.toLowerCase().includes('invalid argument')
        if (isKeyError) {
          reject(new Error('Wallet key error — your wallet may be on the wrong chain. Please sign out and sign back in to re-initialize on Arc Testnet.'))
        } else {
          reject(new Error(raw))
        }
      } else {
        resolve(result?.data?.signature ?? challengeId)
      }
    })
  })
}

/* ─────────────────────────────────────────────────────────────
   CHAT API
───────────────────────────────────────────────────────────── */
async function askAI(
  userMessage: string,
  history: ChatMsg[],
  userId?: string,
  walletId?: string
): Promise<string> {
  const messages = history
    .filter(m => m.role !== 'system')
    .slice(-6)
    .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
    .concat([{ role: 'user', content: userMessage }])
  const payload: any = { messages }
  if (userId)   payload.userId   = userId
  if (walletId) payload.walletId = walletId
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any)?.error ?? `Chat API returned status ${res.status}`)
  }
  const data = await res.json()
  return (data?.content ?? '').trim() || 'No response from AI.'
}

/* ─────────────────────────────────────────────────────────────
   GLOBAL CSS
───────────────────────────────────────────────────────────── */
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  html,body{height:100%;background:#050505;color:#e8e8e8;overflow-x:hidden;}
  :root{
    --green:#00ff66;--green-dim:rgba(0,255,102,0.09);--green-border:rgba(0,255,102,0.22);
    --surface:rgba(255,255,255,0.028);--surface-h:rgba(255,255,255,0.055);
    --border:rgba(255,255,255,0.07);--border-s:rgba(255,255,255,0.11);
    --muted:rgba(255,255,255,0.38);--sub:rgba(255,255,255,0.58);
    --fd:'Rajdhani',sans-serif;--fm:'Space Mono',monospace;
    --red:#ff4d6a;--blue:#4d8fff;
  }
  ::-webkit-scrollbar{width:4px;}::-webkit-scrollbar-track{background:transparent;}
  ::-webkit-scrollbar-thumb{background:var(--border-s);border-radius:2px;}
  .aw{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#050505;position:relative;overflow:hidden;}
  .aw::before{content:'';position:absolute;width:700px;height:700px;background:radial-gradient(circle,rgba(0,255,102,0.05) 0%,transparent 70%);top:-150px;left:50%;transform:translateX(-50%);pointer-events:none;}
  .ac{width:420px;background:rgba(255,255,255,0.02);border:0.5px solid var(--border-s);border-radius:20px;padding:40px;backdrop-filter:blur(24px);}
  .alogo{font-family:var(--fd);font-size:22px;font-weight:700;letter-spacing:2px;color:var(--green);text-align:center;margin-bottom:5px;text-transform:uppercase;}
  .atag{font-family:var(--fm);font-size:10px;color:var(--muted);text-align:center;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:32px;}
  .atabs{display:flex;background:rgba(255,255,255,0.03);border:0.5px solid var(--border);border-radius:10px;padding:3px;margin-bottom:26px;}
  .atab{flex:1;padding:9px;border:none;background:transparent;color:var(--muted);font-family:var(--fd);font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;border-radius:8px;cursor:pointer;transition:all 0.2s;}
  .atab.on{background:var(--green);color:#050505;}
  .af{margin-bottom:14px;}
  .al{font-family:var(--fm);font-size:10px;color:var(--muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:7px;display:block;}
  .ai{width:100%;background:rgba(255,255,255,0.04);border:0.5px solid var(--border-s);border-radius:10px;padding:11px 13px;color:#e8e8e8;font-family:var(--fm);font-size:13px;outline:none;transition:border-color 0.2s,background 0.2s;}
  .ai:focus{border-color:var(--green-border);background:rgba(0,255,102,0.04);}
  .ai::placeholder{color:var(--muted);}
  .abtn{width:100%;padding:13px;background:var(--green);color:#050505;border:none;border-radius:10px;font-family:var(--fd);font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;margin-top:6px;transition:opacity 0.2s,transform 0.15s;display:flex;align-items:center;justify-content:center;gap:8px;}
  .abtn:hover{opacity:0.87;}.abtn:active{transform:scale(0.98);}.abtn:disabled{opacity:0.43;cursor:not-allowed;}
  .aerr{font-family:var(--fm);font-size:11px;color:var(--red);text-align:center;margin-top:12px;padding:10px;background:rgba(255,77,106,0.07);border-radius:8px;border:0.5px solid rgba(255,77,106,0.2);}
  .awcr{display:flex;align-items:center;gap:8px;justify-content:center;font-family:var(--fm);font-size:10px;color:var(--green);margin-top:12px;}
  .dr{min-height:100vh;background:#050505;display:flex;flex-direction:column;position:relative;}
  .dh{position:fixed;top:0;left:0;right:0;z-index:50;height:60px;background:rgba(5,5,5,0.9);border-bottom:0.5px solid var(--border);backdrop-filter:blur(22px);display:flex;justify-content:space-between;align-items:center;padding:0 24px;}
  .ubadge{display:inline-flex;align-items:center;gap:8px;background:var(--green-dim);border:0.5px solid var(--green-border);border-radius:20px;padding:6px 14px 6px 8px;cursor:pointer;transition:background 0.2s;}
  .ubadge:hover{background:rgba(0,255,102,0.16);}
  .bdot{width:7px;height:7px;background:var(--green);border-radius:50%;box-shadow:0 0 5px var(--green);animation:pdot 2s ease-in-out infinite;}
  @keyframes pdot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.78)}}
  .btxt{font-family:var(--fm);font-size:11px;font-weight:700;color:var(--green);}
  .nbtn{background:rgba(255,255,255,0.04);border:0.5px solid var(--border-s);border-radius:8px;padding:8px 20px;color:#e8e8e8;font-family:var(--fd);font-size:13px;font-weight:600;letter-spacing:1px;cursor:pointer;transition:all 0.2s;white-space:nowrap;}
  .nbtn:hover{background:var(--surface-h);border-color:var(--green-border);color:var(--green);}
  .hr{display:flex;align-items:center;justify-content:flex-end;gap:12px;}
  .ibtn{width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:var(--surface);border:0.5px solid var(--border);border-radius:8px;cursor:pointer;color:var(--sub);font-size:16px;transition:all 0.2s;}
  .ibtn:hover{border-color:var(--green-border);color:var(--green);background:var(--green-dim);}
  .brand{display:flex;align-items:center;gap:7px;font-family:var(--fd);font-size:14px;font-weight:700;letter-spacing:2px;color:#e8e8e8;text-transform:uppercase;}
  .dm{flex:1;padding-top:80px;padding-bottom:160px;display:flex;flex-direction:column;align-items:center;}
  .ws{width:100%;max-width:700px;padding:0 20px;}
  .gp{margin-bottom:28px;animation:fup 0.5s ease both;}
  @keyframes fup{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
  .gey{font-family:var(--fm);font-size:10px;letter-spacing:3px;text-transform:uppercase;color:var(--green);margin-bottom:10px;}
  .gtit{font-family:var(--fd);font-size:44px;font-weight:700;line-height:1.1;letter-spacing:-0.5px;margin-bottom:14px;}
  .gtit em{color:var(--green);font-style:normal;}
  .gsub{font-family:var(--fm);font-size:11px;color:var(--sub);line-height:1.8;}
  .srow{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px;}
  .sc{background:var(--surface);border:0.5px solid var(--border);border-radius:13px;padding:16px 18px;transition:border-color 0.2s,background 0.2s;}
  .sc:hover{border-color:var(--green-border);background:var(--green-dim);}
  .slbl{font-family:var(--fm);font-size:9px;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin-bottom:7px;}
  .sval{font-family:var(--fd);font-size:24px;font-weight:700;color:#e8e8e8;}
  .sval.g{color:var(--green);}
  .sdlt{font-family:var(--fm);font-size:9px;color:var(--green);margin-top:4px;}
  .sdlt.m{color:var(--muted);}
  .fc{background:var(--surface);border:0.5px solid var(--border);border-radius:13px;padding:16px 18px;display:flex;align-items:center;gap:14px;transition:border-color 0.2s;cursor:pointer;margin-bottom:8px;}
  .fc:hover{border-color:var(--green-border);}
  .fi{width:40px;height:40px;background:var(--green-dim);border:0.5px solid var(--green-border);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0;}
  .ftit{font-family:var(--fd);font-size:14px;font-weight:600;color:#e8e8e8;margin-bottom:3px;}
  .fmeta{font-family:var(--fm);font-size:9px;color:var(--muted);}
  .ftag{margin-left:auto;font-family:var(--fm);font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:3px 9px;border-radius:20px;flex-shrink:0;}
  .tlive{background:rgba(0,255,102,0.08);color:var(--green);border:0.5px solid var(--green-border);}
  .tnew{background:rgba(255,200,50,0.08);color:#ffc832;border:0.5px solid rgba(255,200,50,0.2);}
  .thot{background:rgba(255,77,106,0.08);color:var(--red);border:0.5px solid rgba(255,77,106,0.2);}
  .csl{font-family:var(--fm);font-size:9px;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin:24px 0 12px;display:flex;align-items:center;gap:8px;}
  .csl::after{content:'';flex:1;height:0.5px;background:var(--border);}
  .cbw{margin-bottom:10px;display:flex;flex-direction:column;align-items:flex-start;animation:fup 0.3s ease both;}
  .cbw.u{align-items:flex-end;}
  .cb{max-width:82%;padding:11px 15px;border-radius:12px;font-family:var(--fm);font-size:12px;line-height:1.7;white-space:pre-wrap;}
  .cb.user{background:var(--green-dim);border:0.5px solid var(--green-border);color:var(--green);}
  .cb.ai{background:rgba(255,255,255,0.04);border:0.5px solid var(--border-s);color:#e8e8e8;}
  .cb.system{background:rgba(255,77,106,0.07);border:0.5px solid rgba(255,77,106,0.2);color:var(--red);}
  .cts{font-family:var(--fm);font-size:9px;color:var(--muted);margin-top:4px;padding:0 2px;}
  .typ{display:inline-flex;align-items:center;gap:4px;padding:11px 16px;background:rgba(255,255,255,0.04);border:0.5px solid var(--border-s);border-radius:12px;}
  .tdot{width:6px;height:6px;background:var(--green);border-radius:50%;animation:tping 1.2s ease-in-out infinite;}
  .tdot:nth-child(2){animation-delay:0.2s;}.tdot:nth-child(3){animation-delay:0.4s;}
  @keyframes tping{0%,60%,100%{transform:translateY(0);opacity:0.5}30%{transform:translateY(-5px);opacity:1}}
  .cbw2{position:fixed;bottom:0;left:0;right:0;z-index:40;display:flex;flex-direction:column;align-items:center;padding-bottom:20px;background:linear-gradient(to top,rgba(5,5,5,1) 55%,transparent);pointer-events:none;}
  .chint{font-family:var(--fm);font-size:10px;color:var(--muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:9px;pointer-events:none;}
  .cbar{width:100%;max-width:700px;padding:0 20px;pointer-events:all;}
  .cinn{display:flex;align-items:center;gap:9px;background:rgba(10,10,10,0.97);border:0.5px solid var(--border-s);border-radius:14px;padding:9px 11px;backdrop-filter:blur(22px);box-shadow:0 8px 36px rgba(0,0,0,0.65);}
  .cbrf{width:38px;height:38px;flex-shrink:0;background:var(--green-dim);border:0.5px solid var(--green-border);border-radius:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:17px;transition:all 0.2s;color:var(--green);}
  .cbrf:hover{background:rgba(0,255,102,0.18);}
  .cinp{flex:1;background:transparent;border:none;outline:none;color:#e8e8e8;font-family:var(--fm);font-size:13px;}
  .cinp::placeholder{color:var(--muted);}
  .csnd{background:var(--green);color:#050505;border:none;border-radius:8px;padding:9px 18px;font-family:var(--fd);font-size:12px;font-weight:700;letter-spacing:2px;cursor:pointer;transition:opacity 0.2s,transform 0.15s;flex-shrink:0;white-space:nowrap;}
  .csnd:hover{opacity:0.83;}.csnd:active{transform:scale(0.96);}.csnd:disabled{opacity:0.38;cursor:not-allowed;}
  .dov{position:fixed;inset:0;background:rgba(0,0,0,0.62);z-index:60;backdrop-filter:blur(4px);animation:fin 0.18s ease;}
  @keyframes fin{from{opacity:0}to{opacity:1}}
  .dwr{position:fixed;top:0;right:0;width:360px;height:100vh;background:#070707;border-left:0.5px solid var(--border-s);z-index:70;display:flex;flex-direction:column;animation:sli 0.26s cubic-bezier(0.22,1,0.36,1);overflow-y:auto;}
  @keyframes sli{from{transform:translateX(100%)}to{transform:translateX(0)}}
  .dhd{display:flex;align-items:center;justify-content:space-between;padding:20px 22px;border-bottom:0.5px solid var(--border);flex-shrink:0;}
  .dtit{font-family:var(--fd);font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;}
  .dcls{width:28px;height:28px;border:0.5px solid var(--border);border-radius:6px;background:transparent;color:var(--sub);display:flex;align-items:center;justify-content:center;font-size:13px;transition:all 0.2s;}
  .dcls:hover{border-color:var(--green-border);color:var(--green);}
  .dbdy{padding:22px;flex:1;}
  .nbdg{display:inline-flex;align-items:center;gap:6px;background:var(--green-dim);border:0.5px solid var(--green-border);border-radius:20px;padding:5px 12px;font-family:var(--fm);font-size:9px;color:var(--green);letter-spacing:1px;margin-bottom:20px;}
  .ndot{width:5px;height:5px;background:var(--green);border-radius:50%;animation:pdot 2s ease-in-out infinite;}
  .acd{background:rgba(255,255,255,0.022);border:0.5px solid var(--border-s);border-radius:16px;padding:22px;margin-bottom:14px;}
  .ahd{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;}
  .anr{display:flex;align-items:center;gap:10px;}
  .uic{width:40px;height:40px;background:rgba(39,117,255,0.11);border:0.5px solid rgba(39,117,255,0.26);border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--fd);font-size:10px;font-weight:700;color:var(--blue);}
  .asy{font-family:var(--fd);font-size:16px;font-weight:700;letter-spacing:1px;}
  .asn{font-family:var(--fm);font-size:9px;color:var(--muted);margin-top:1px;}
  .apg{font-family:var(--fm);font-size:9px;color:var(--green);background:var(--green-dim);border:0.5px solid var(--green-border);padding:3px 9px;border-radius:20px;}
  .bamt{font-family:var(--fd);font-size:36px;font-weight:700;letter-spacing:-1px;margin-bottom:3px;}
  .bsub{font-family:var(--fm);font-size:10px;color:var(--muted);margin-bottom:18px;}
  .bbt{height:3px;background:var(--border);border-radius:2px;overflow:hidden;margin-bottom:20px;}
  .bbf{height:100%;background:var(--green);border-radius:2px;animation:bgr 1s cubic-bezier(0.22,1,0.36,1) both;}
  @keyframes bgr{from{width:0}}
  .arow{display:grid;grid-template-columns:1fr 1fr;gap:9px;}
  .abtn2{padding:11px;border-radius:10px;font-family:var(--fd);font-size:12px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;text-align:center;transition:all 0.2s;border:none;}
  .asend{background:var(--green);color:#050505;}.asend:hover{opacity:0.83;}
  .arcv{background:transparent;color:var(--green);border:0.5px solid var(--green-border) !important;}.arcv:hover{background:var(--green-dim);}
  .ws2{margin-top:18px;padding-top:18px;border-top:0.5px solid var(--border);}
  .slb{font-family:var(--fm);font-size:9px;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;}
  .waddr{font-family:var(--fm);font-size:10px;color:var(--sub);word-break:break-all;line-height:1.6;}
  .txr{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:0.5px solid var(--border);}
  .txtp{font-family:var(--fm);font-size:11px;color:#e8e8e8;}
  .txdt{font-family:var(--fm);font-size:9px;color:var(--muted);margin-top:2px;}
  .txam{font-family:var(--fm);font-size:11px;font-weight:700;}
  .tin{color:var(--green);}.tout{color:var(--red);}
  .natrow{display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.02);border:0.5px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:14px;}
  .natl{display:flex;align-items:center;gap:10px;}
  .natic{width:32px;height:32px;background:rgba(255,255,255,0.04);border:0.5px solid var(--border-s);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;}
  .natsym{font-family:var(--fd);font-size:13px;font-weight:600;}
  .natnet{font-family:var(--fm);font-size:9px;color:var(--muted);}
  .natamt{font-family:var(--fm);font-size:13px;color:#e8e8e8;}
  .bld{display:flex;align-items:center;gap:8px;font-family:var(--fm);font-size:11px;color:var(--muted);padding:8px 0;}
  .berr{font-family:var(--fm);font-size:10px;color:var(--red);padding:8px 0;line-height:1.6;}
  .mov{position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:90;backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;animation:fin 0.18s ease;}
  .mox{background:#080808;border:0.5px solid var(--border-s);border-radius:18px;padding:28px;width:380px;animation:pin 0.22s cubic-bezier(0.22,1,0.36,1);}
  @keyframes pin{from{opacity:0;transform:scale(0.95)}to{opacity:1;transform:scale(1)}}
  .mtit{font-family:var(--fd);font-size:16px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;}
  .mf{margin-bottom:14px;}
  .ml{font-family:var(--fm);font-size:9px;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin-bottom:7px;display:block;}
  .mi{width:100%;background:rgba(255,255,255,0.04);border:0.5px solid var(--border-s);border-radius:9px;padding:11px 13px;color:#e8e8e8;font-family:var(--fm);font-size:12px;outline:none;transition:border-color 0.2s;}
  .mi:focus{border-color:var(--green-border);}
  .mi::placeholder{color:var(--muted);}
  .mb{width:100%;padding:13px;border:none;border-radius:9px;font-family:var(--fd);font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;cursor:pointer;transition:opacity 0.2s,transform 0.15s;display:flex;align-items:center;justify-content:center;gap:8px;}
  .mbp{background:var(--green);color:#050505;margin-top:6px;}.mbp:hover{opacity:0.84;}.mbp:disabled{opacity:0.38;cursor:not-allowed;}
  .mbg{background:transparent;color:var(--sub);border:0.5px solid var(--border);margin-top:8px;}.mbg:hover{border-color:var(--border-s);color:#e8e8e8;}
  .txok{font-family:var(--fm);font-size:10px;color:var(--green);margin-top:12px;padding:10px;background:var(--green-dim);border:0.5px solid var(--green-border);border-radius:8px;word-break:break-all;line-height:1.6;}
  .txng{font-family:var(--fm);font-size:10px;color:var(--red);margin-top:12px;padding:10px;background:rgba(255,77,106,0.07);border:0.5px solid rgba(255,77,106,0.2);border-radius:8px;}
  .adrd{background:rgba(255,255,255,0.03);border:0.5px solid var(--border-s);border-radius:10px;padding:14px;font-family:var(--fm);font-size:11px;color:var(--sub);word-break:break-all;line-height:1.7;margin-bottom:14px;}
  .cpbtn{width:100%;padding:12px;background:var(--green-dim);border:0.5px solid var(--green-border);border-radius:9px;color:var(--green);font-family:var(--fd);font-size:12px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;transition:all 0.2s;}
  .cpbtn:hover{background:rgba(0,255,102,0.17);}
  .cpok{font-family:var(--fm);font-size:10px;color:var(--green);text-align:center;margin-top:8px;}
  .qrpl{width:160px;height:160px;background:rgba(255,255,255,0.03);border:0.5px solid var(--border);border-radius:12px;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:6px;}
  .qrg{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;width:110px;height:110px;}
  .qrc{border-radius:1px;}
  .smenu{position:fixed;top:68px;right:16px;width:270px;background:#0b0b0b;border:0.5px solid var(--border-s);border-radius:14px;z-index:80;animation:fin 0.14s ease;overflow:hidden;}
  .shd{padding:14px 18px;border-bottom:0.5px solid var(--border);}
  .snm{font-family:var(--fd);font-size:15px;font-weight:700;}
  .sem{font-family:var(--fm);font-size:10px;color:var(--muted);margin-top:2px;}
  .snt{font-family:var(--fm);font-size:9px;color:var(--green);letter-spacing:1px;margin-top:6px;}
  .si{display:flex;align-items:center;gap:10px;padding:12px 18px;font-family:var(--fm);font-size:11px;color:var(--sub);cursor:pointer;transition:background 0.14s;border-bottom:0.5px solid var(--border);}
  .si:hover{background:var(--surface-h);color:#e8e8e8;}
  .si.dng{color:var(--red);}.si.dng:hover{background:rgba(255,77,106,0.06);}
  .sp{display:inline-block;width:13px;height:13px;border:2px solid rgba(5,5,5,0.2);border-top-color:#050505;border-radius:50%;animation:spin 0.65s linear infinite;}
  .sp.g{border-color:rgba(0,255,102,0.14);border-top-color:var(--green);}
  @keyframes spin{to{transform:rotate(360deg)}}
  .thm-btn{width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:var(--surface);border:0.5px solid var(--border);border-radius:8px;cursor:pointer;font-size:16px;transition:all 0.2s;flex-shrink:0;}
  .thm-btn:hover{border-color:var(--green-border);background:var(--green-dim);}
  .sbadges{display:flex;align-items:center;gap:7px;margin-bottom:8px;flex-wrap:wrap;justify-content:center;pointer-events:all;}
  .sbdg{font-family:var(--fm);font-size:10px;letter-spacing:0.8px;padding:5px 13px;border-radius:20px;border:0.5px solid var(--border-s);background:var(--surface);color:var(--sub);cursor:pointer;transition:all 0.18s;white-space:nowrap;}
  .sbdg:hover{border-color:var(--green-border);color:var(--green);background:var(--green-dim);}
  .light{background:#f7f7f8 !important;color:#111 !important;}
  .light .dh{background:rgba(247,247,248,0.96) !important;border-bottom-color:rgba(0,0,0,0.1) !important;}
  .light .brand{color:#111 !important;}
  .light .nbtn{background:rgba(0,0,0,0.05) !important;border-color:rgba(0,0,0,0.14) !important;color:#222 !important;}
  .light .nbtn:hover{color:var(--green) !important;border-color:var(--green-border) !important;background:var(--green-dim) !important;}
  .light .thm-btn{background:rgba(0,0,0,0.05) !important;border-color:rgba(0,0,0,0.14) !important;color:#333 !important;}
  .light .ubadge{background:rgba(0,200,80,0.1) !important;border-color:rgba(0,180,70,0.3) !important;}
  .light .btxt{color:#00bb44 !important;}
  .light .ibtn{background:rgba(0,0,0,0.05) !important;border-color:rgba(0,0,0,0.12) !important;color:#444 !important;}
  .light .dr{background:#f7f7f8 !important;}
  .light .dm{background:#f7f7f8 !important;}
  .light .gey{color:#00aa44 !important;}
  .light .gtit{color:#0a0a0a !important;}
  .light .gtit em{color:var(--green) !important;}
  .light .gsub{color:#444 !important;}
  .light .sc{background:#fff !important;border-color:rgba(0,0,0,0.1) !important;}
  .light .sc:hover{border-color:var(--green-border) !important;background:rgba(0,255,102,0.04) !important;}
  .light .slbl{color:#888 !important;}
  .light .sval{color:#0a0a0a !important;}
  .light .sval.g{color:#00aa44 !important;}
  .light .sdlt{color:#00aa44 !important;}
  .light .sdlt.m{color:#777 !important;}
  .light .fc{background:#fff !important;border-color:rgba(0,0,0,0.1) !important;}
  .light .fc:hover{border-color:var(--green-border) !important;}
  .light .ftit{color:#0a0a0a !important;}
  .light .fmeta{color:#666 !important;}
  .light .csl{color:#888 !important;}
  .light .csl::after{background:rgba(0,0,0,0.1) !important;}
  .light .cb.ai{background:#fff !important;border-color:rgba(0,0,0,0.11) !important;color:#111 !important;}
  .light .cb.user{background:rgba(0,200,80,0.09) !important;border-color:rgba(0,180,70,0.25) !important;color:#006622 !important;}
  .light .cb.system{background:rgba(255,77,106,0.06) !important;color:#cc1133 !important;}
  .light .cts{color:#888 !important;}
  .light .typ{background:#fff !important;border-color:rgba(0,0,0,0.1) !important;}
  .light .cbw2{background:linear-gradient(to top,rgba(247,247,248,1) 55%,transparent) !important;}
  .light .chint{color:#888 !important;}
  .light .cinn{background:rgba(255,255,255,0.99) !important;border-color:rgba(0,0,0,0.14) !important;box-shadow:0 8px 36px rgba(0,0,0,0.1) !important;}
  .light .cinp{color:#111 !important;}
  .light .cinp::placeholder{color:#aaa !important;}
  .light .cbrf{background:rgba(0,200,80,0.1) !important;border-color:rgba(0,180,70,0.25) !important;}
  .light .sbdg{background:#fff !important;border-color:rgba(0,0,0,0.13) !important;color:#444 !important;}
  .light .sbdg:hover{color:var(--green) !important;border-color:var(--green-border) !important;background:var(--green-dim) !important;}
  .light .smenu{background:#fff !important;border-color:rgba(0,0,0,0.11) !important;}
  .light .shd{border-bottom-color:rgba(0,0,0,0.08) !important;}
  .light .snm{color:#0a0a0a !important;}
  .light .sem{color:#666 !important;}
  .light .snt{color:#00aa44 !important;}
  .light .si{color:#333 !important;border-bottom-color:rgba(0,0,0,0.07) !important;}
  .light .si:hover{background:rgba(0,0,0,0.04) !important;color:#0a0a0a !important;}
  .light .si.dng{color:#cc1133 !important;}
  .light .dov{background:rgba(0,0,0,0.4) !important;}
  .light .dwr{background:#f4f4f5 !important;border-left-color:rgba(0,0,0,0.1) !important;}
  .light .dhd{border-bottom-color:rgba(0,0,0,0.09) !important;}
  .light .dtit{color:#0a0a0a !important;}
  .light .dcls{border-color:rgba(0,0,0,0.12) !important;color:#555 !important;}
  .light .dcls:hover{color:var(--green) !important;}
  .light .acd{background:#fff !important;border-color:rgba(0,0,0,0.1) !important;}
  .light .asy{color:#0a0a0a !important;}
  .light .asn{color:#777 !important;}
  .light .bamt{color:#0a0a0a !important;}
  .light .bsub{color:#666 !important;}
  .light .bbt{background:rgba(0,0,0,0.1) !important;}
  .light .slb{color:#888 !important;}
  .light .waddr{color:#444 !important;}
  .light .natrow{background:#fff !important;border-color:rgba(0,0,0,0.09) !important;}
  .light .natsym{color:#0a0a0a !important;}
  .light .natnet{color:#777 !important;}
  .light .natamt{color:#0a0a0a !important;}
  .light .natic{background:rgba(0,0,0,0.04) !important;border-color:rgba(0,0,0,0.1) !important;}
  .light .txr{border-bottom-color:rgba(0,0,0,0.08) !important;}
  .light .txtp{color:#222 !important;}
  .light .txdt{color:#888 !important;}
  .light .bld{color:#666 !important;}
  .light .ws2{border-top-color:rgba(0,0,0,0.09) !important;}
  .light .mox{background:#fff !important;border-color:rgba(0,0,0,0.1) !important;}
  .light .mtit{color:#0a0a0a !important;}
  .light .ml{color:#888 !important;}
  .light .mi{background:rgba(0,0,0,0.03) !important;border-color:rgba(0,0,0,0.13) !important;color:#111 !important;}
  .light .mi::placeholder{color:#bbb !important;}
  .light .mbg{color:#444 !important;border-color:rgba(0,0,0,0.14) !important;}
  .light .mbg:hover{color:#111 !important;}
  .light .adrd{background:rgba(0,0,0,0.03) !important;border-color:rgba(0,0,0,0.1) !important;color:#333 !important;}
`

/* ─────────────────────────────────────────────────────────────
   QR DISPLAY
───────────────────────────────────────────────────────────── */
function QRDisplay({ address }: { address: string }) {
  const cells = Array.from({ length: 49 }, (_, i) => {
    const c = address.charCodeAt((i * 3) % address.length) || 0
    return (c + i) % 3 !== 0
  })
  return (
    <div className="qrpl">
      <div className="qrg">
        {cells.map((on, i) => (
          <div key={i} className="qrc" style={{ background: on ? '#00ff66' : 'rgba(255,255,255,0.05)' }} />
        ))}
      </div>
      <div style={{ fontFamily: 'var(--fm)', fontSize: 9, color: 'var(--muted)', letterSpacing: 1 }}>SCAN TO RECEIVE</div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   AUTH SCREEN
───────────────────────────────────────────────────────────── */
function AuthScreen({
  mode, setMode, form, setForm, error, loading, onSignUp, onSignIn, googleButtonRef,
}: {
  mode: 'signin' | 'signup'
  setMode: (m: 'signin' | 'signup') => void
  form: { username: string; email: string; password: string }
  setForm: (f: any) => void
  error: string
  loading: boolean
  onSignUp: () => void
  onSignIn: () => void
  googleButtonRef: React.RefObject<HTMLDivElement | null>
}) {
  const set = (k: string, v: string) => setForm((p: any) => ({ ...p, [k]: v }))
  return (
    <div className="aw">
      <div className="ac">
        <div className="alogo">⚽ Sports Alpha</div>
        <div className="atag">Arc Network Testnet · AI Sports Intelligence</div>
        <div className="atabs">
          <button className={`atab ${mode === 'signin' ? 'on' : ''}`} onClick={() => setMode('signin')}>Sign In</button>
          <button className={`atab ${mode === 'signup' ? 'on' : ''}`} onClick={() => setMode('signup')}>Sign Up</button>
        </div>
        {mode === 'signup' && (
          <div className="af">
            <label className="al">Username</label>
            <input className="ai" type="text" placeholder="@yourhandle"
              value={form.username} onChange={e => set('username', e.target.value)} disabled={loading} />
          </div>
        )}
        <div className="af">
          <label className="al">Email</label>
          <input className="ai" type="email" placeholder="you@email.com"
            value={form.email} onChange={e => set('email', e.target.value)} disabled={loading} />
        </div>
        <div className="af">
          <label className="al">Password</label>
          <input className="ai" type="password" placeholder="••••••••"
            value={form.password} onChange={e => set('password', e.target.value)} disabled={loading}
            onKeyDown={e => e.key === 'Enter' && (mode === 'signup' ? onSignUp() : onSignIn())} />
        </div>
        <button className="abtn" onClick={mode === 'signup' ? onSignUp : onSignIn} disabled={loading}>
          {loading
            ? <><span className="sp" />{mode === 'signup' ? 'Creating Wallet…' : 'Signing In…'}</>
            : mode === 'signup' ? 'Create Account' : 'Sign In'}
        </button>
        <div className="af" style={{ marginTop: 18 }}>
          <div className="al">Or continue with</div>
          <div ref={googleButtonRef} />
          <div style={{ fontFamily: 'var(--fm)', fontSize: 10, color: 'var(--muted)', marginTop: 10 }}>
            {mode === 'signup'
              ? 'Sign up with Google to create your Circle wallet and complete secure setup.'
              : 'Sign in with Google to access your Circle wallet.'}
          </div>
        </div>
        {error && <div className="aerr">{error}</div>}
        {loading && mode === 'signup' && (
          <div className="awcr"><span className="sp g" />Generating EVM wallet on Arc Network Testnet…</div>
        )}
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   SEND MODAL
───────────────────────────────────────────────────────────── */
function SendModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const [toAddr,  setToAddr]  = useState('')
  const [amount,  setAmount]  = useState('')
  const [loading, setLoading] = useState(false)
  const [txHash,  setTxHash]  = useState('')
  const [err,     setErr]     = useState('')

  const handleSend = async () => {
    setErr(''); setTxHash('')
    if (!isEvmAddress(toAddr)) { setErr('Invalid recipient address.'); return }
    const amt = parseFloat(amount)
    if (isNaN(amt) || amt <= 0) { setErr('Enter a valid amount greater than 0.'); return }
    const isZeroContract = !USDC_ADDR || USDC_ADDR.replace(/0/g, '').replace('x', '').length === 0
    if (isZeroContract) { setErr('USDC contract not configured. Add NEXT_PUBLIC_USDC_CONTRACT to .env.local'); return }
    setLoading(true)
    try {
      if (!session.circleUserToken || !session.circleEncryptionKey || !session.walletId) {
        setErr('Wallet not fully initialised. Please sign out and back in.')
        return
      }

      // ── FIX: Refresh tokens before sending ─────────────────────────────────
      // Stale tokens cause the Circle SDK to throw "invalid private key"
      // (an internal ethers error).  Refreshing before each send call
      // ensures we always use a valid, non-expired session.
      let activeUserToken     = session.circleUserToken
      let activeEncryptionKey = session.circleEncryptionKey

      if (session.email) {
        const refreshed = await refreshCircleTokens(session.email)
        if (refreshed) {
          activeUserToken     = refreshed.userToken
          activeEncryptionKey = refreshed.encryptionKey
          // Persist to localStorage so future sends also use fresh tokens
          try {
            const stored = localStorage.getItem('sa_session')
            if (stored) {
              const parsed = JSON.parse(stored)
              localStorage.setItem('sa_session', JSON.stringify({
                ...parsed,
                circleUserToken:     activeUserToken,
                circleEncryptionKey: activeEncryptionKey,
              }))
            }
          } catch { /* non-critical */ }
        }
      }

      const sdk = getCircleSDK()
      sdk.setAuthentication({ userToken: activeUserToken, encryptionKey: activeEncryptionKey })

      const challengeRes = await fetch('/api/circle/create-transfer-challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userToken:       activeUserToken,
          walletId:        session.walletId,
          toAddress:       toAddr,
          amount,
          contractAddress: USDC_ADDR,
        }),
      })

      if (!challengeRes.ok) {
        const errBody = await challengeRes.json().catch(() => ({}))
        throw new Error((errBody as any)?.error ?? 'Failed to create Circle transfer challenge')
      }

      const raw = await challengeRes.json()
      const { challengeId } = { ...raw } as { challengeId: string }

      const txRef = await new Promise<string>((resolve, reject) => {
        sdk.execute(challengeId, (err: any, result: any) => {
          if (err) {
            const raw = err?.message ?? 'Circle challenge execution failed'
            const isKeyError = raw.toLowerCase().includes('private key') || raw.toLowerCase().includes('invalid argument')
            if (isKeyError) {
              reject(new Error('Wallet key error — please sign out and sign back in to re-initialize on Arc Testnet.'))
            } else {
              reject(new Error(raw))
            }
          } else {
            resolve(result?.data?.txHash ?? result?.data?.signature ?? challengeId)
          }
        })
      })
      setTxHash(txRef)
    } catch (e: any) {
      setErr(e?.message ?? 'Transaction failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mov" onClick={onClose}>
      <div className="mox" onClick={e => e.stopPropagation()}>
        <div className="mtit">Send USDC <button className="dcls" onClick={onClose}>✕</button></div>
        {!txHash ? (
          <>
            <div className="mf">
              <label className="ml">Recipient Address</label>
              <input className="mi" type="text" placeholder="0x..." value={toAddr} onChange={e => setToAddr(e.target.value)} disabled={loading} />
            </div>
            <div className="mf">
              <label className="ml">Amount (USDC)</label>
              <input className="mi" type="number" placeholder="0.00" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} disabled={loading} />
            </div>
            <button className="mb mbp" onClick={handleSend} disabled={loading}>
              {loading ? <><span className="sp" />Broadcasting…</> : 'Confirm & Send'}
            </button>
            <button className="mb mbg" onClick={onClose} disabled={loading}>Cancel</button>
            {err && <div className="txng">{err}</div>}
          </>
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>✅</div>
              <div style={{ fontFamily: 'var(--fd)', fontSize: 15, fontWeight: 700, color: 'var(--green)' }}>Transaction Sent!</div>
            </div>
            <div className="txok"><span style={{ color: 'var(--muted)' }}>TX HASH</span><br />{txHash}</div>
            <button className="mb mbg" onClick={onClose} style={{ marginTop: 14 }}>Close</button>
          </>
        )}
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   RECEIVE MODAL
───────────────────────────────────────────────────────────── */
function ReceiveModal({ address, onClose }: { address: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copyAddr = async () => {
    try {
      await navigator.clipboard.writeText(address)
    } catch {
      const el = document.createElement('textarea')
      el.value = address
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }
  return (
    <div className="mov" onClick={onClose}>
      <div className="mox" onClick={e => e.stopPropagation()}>
        <div className="mtit">Receive USDC <button className="dcls" onClick={onClose}>✕</button></div>
        <div style={{ fontFamily: 'var(--fm)', fontSize: 10, color: 'var(--muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 16 }}>
          Arc Network Testnet · Smart Wallet
        </div>
        <QRDisplay address={address} />
        <div className="adrd">{address}</div>
        <button className="cpbtn" onClick={copyAddr}>{copied ? '✓ Copied to Clipboard!' : 'Copy Wallet Address'}</button>
        {copied && <div className="cpok">Address copied ✓</div>}
        <button className="mb mbg" onClick={onClose} style={{ marginTop: 10 }}>Close</button>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   BALANCE DRAWER
───────────────────────────────────────────────────────────── */
function BalanceDrawer({
  session, onClose, onSend, onReceive,
}: {
  session: Session; onClose: () => void; onSend: () => void; onReceive: () => void
}) {
  const [bal, setBal] = useState<WalletBal>({ usdc: '—', native: '—', loading: true, error: '' })

  const isValidEVMAddress = typeof session.walletAddress === 'string'
    && session.walletAddress.startsWith('0x')
    && session.walletAddress.length === 42

  const load = useCallback(async () => {
    if (!isValidEVMAddress) {
      // Wallet address not in session yet — attempt a live lookup before giving up.
      // This handles the walletPending timeout path where the session was saved
      // before Circle finished creating the wallet.
      // We stay in loading state throughout all retries so the error banner never
      // flickers on screen while the parent useEffect is still resolving the address.
      setBal({ usdc: '—', native: '—', loading: true, error: '' })

      // Retry up to 4 times with increasing delays (0 ms, 1 s, 2 s, 3 s) to give
      // the parent useEffect time to propagate a freshly-resolved wallet address
      // into session before we give up and surface an error to the user.
      const RETRY_DELAYS = [0, 1000, 2000, 3000]
      for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
        }
        try {
          const body = session.walletId
            ? { walletId: session.walletId }
            : { userId: session.email }
          const res = await fetch('/api/circle/wallet-address', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (res.ok) {
            const data = await res.json()
            if (data?.address?.startsWith('0x')) {
              // Address resolved — explicitly clear any prior error state, then
              // fetch live balances with the newly-resolved address.
              const [usdc, native] = await Promise.all([
                fetchUSDCBalance(data.address),
                fetchNativeBalance(data.address),
              ])
              setBal({ usdc, native, loading: false, error: '' })
              return
            }
          }
        } catch {
          // Network hiccup — continue to next retry
        }
      }
      // All retries exhausted — only now surface the actionable error message.
      setBal({ usdc: '—', native: '—', loading: false, error: 'Wallet address not yet resolved. Click ↻ to retry, or sign out and back in.' })
      return
    }
    setBal(b => ({ ...b, loading: true, error: '' }))
    try {
      const [usdc, native] = await Promise.all([
        fetchUSDCBalance(session.walletAddress),
        fetchNativeBalance(session.walletAddress),
      ])
      setBal({ usdc, native, loading: false, error: '' })
    } catch (e: any) {
      setBal({ usdc: '—', native: '—', loading: false, error: e?.message ?? 'RPC connection failed' })
    }
  }, [session.walletAddress, session.walletId, session.email, isValidEVMAddress])

  useEffect(() => { load() }, [load])

  return (
    <>
      <div className="dov" onClick={onClose} />
      <div className="dwr">
        <div className="dhd">
          <span className="dtit">Account Balance</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="dcls" onClick={load} title="Refresh" style={{ fontSize: 15 }}>↻</button>
            <button className="dcls" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="dbdy">
          <div className="nbdg"><div className="ndot" />Arc Network Testnet · RPC Live</div>
          <div className="acd">
            <div className="ahd">
              <div className="anr">
                <div className="uic">USDC</div>
                <div><div className="asy">USDC</div><div className="asn">USD Coin · Arc Testnet</div></div>
              </div>
              <div className="apg">$1.00 peg</div>
            </div>
            {bal.loading ? (
              <div className="bld"><span className="sp g" />Fetching from Arc RPC…</div>
            ) : bal.error ? (
              <div className="berr">⚠ {bal.error}</div>
            ) : (
              <>
                <div className="bamt">{bal.usdc}</div>
                <div className="bsub">≈ ${bal.usdc} USD · live from Arc RPC</div>
                <div className="bbt"><div className="bbf" style={{ width: '65%' }} /></div>
              </>
            )}
            <div className="arow">
              <button className="abtn2 asend" onClick={onSend}>Send</button>
              <button className="abtn2 arcv" onClick={onReceive}>Receive</button>
            </div>
          </div>
          <div className="natrow">
            <div className="natl">
              <div className="natic">⬡</div>
              <div><div className="natsym">ARC</div><div className="natnet">Native · Gas Token</div></div>
            </div>
            <div className="natamt">{bal.loading ? '…' : bal.native}</div>
          </div>
          <div className="ws2">
            <div className="slb">Smart Wallet Address</div>
            <div className="waddr">{session.walletAddress || '—'}</div>
          </div>
          <div style={{ marginTop: 22 }}>
            <div className="slb">Recent Transactions</div>
            <div className="txr">
              <div><div className="txtp">Wallet Created</div><div className="txdt">Genesis · Arc Testnet</div></div>
              <div className="txam">—</div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

/* ─────────────────────────────────────────────────────────────
   DASHBOARD
───────────────────────────────────────────────────────────── */
const LEAGUE_TICKER = ['Champions League', 'World Cup', 'EPL', 'NBA', 'UFC']

function Dashboard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  const [drawerOpen,   setDrawerOpen]   = useState(false)
  const [sendOpen,     setSendOpen]     = useState(false)
  const [receiveOpen,  setReceiveOpen]  = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [messages,     setMessages]     = useState<ChatMsg[]>([])
  const [chatInput,    setChatInput]    = useState('')
  const [aiTyping,     setAiTyping]     = useState(false)
  const [theme,        setTheme]        = useState<'dark' | 'light'>('dark')
  const [tickerIdx,    setTickerIdx]    = useState(0)
  const chatEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = setInterval(() => setTickerIdx(i => (i + 1) % LEAGUE_TICKER.length), 3000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, aiTyping])

  const sendChat = useCallback(async () => {
    const text = chatInput.trim()
    if (!text || aiTyping) return
    setChatInput('')
    const userMsg: ChatMsg = { id: crypto.randomUUID(), role: 'user', text, ts: Date.now() }
    setMessages(prev => [...prev, userMsg])
    setAiTyping(true)
    try {
      try {
        const feeRef = await deductPromptFee(session)
        if (feeRef !== 'skipped') console.log('[PromptFee] Deducted. Ref:', feeRef)
      } catch (feeErr: any) {
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(), role: 'system',
          text: `⚠ Prompt fee failed: ${feeErr?.message ?? 'Could not deduct ' + PROMPT_FEE_AMOUNT + ' USDC'}. Please check your balance and try again.`,
          ts: Date.now(),
        }])
        setAiTyping(false)
        return
      }
      const reply = await askAI(text, [...messages, userMsg], session?.email, session?.walletId)
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'ai', text: reply, ts: Date.now() }])
    } catch (e: any) {
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'system', text: `Error: ${e?.message ?? 'Unknown'}`, ts: Date.now() }])
    } finally {
      setAiTyping(false)
    }
  }, [chatInput, messages, aiTyping, session])

  const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

  const feed = [
    { icon: '⚽', title: `${LEAGUE_TICKER[tickerIdx]} — Ask Sports Alpha AI`, meta: 'Live match analysis via Sports Alpha Engine', tag: 'live', tc: 'tlive' },
    { icon: '📊', title: 'USDC Balance — Arc RPC Connected', meta: 'Real-time testnet data · Click 💼 to view', tag: 'rpc', tc: 'tnew' },
    { icon: '🤖', title: 'Sports Alpha AI Engine Active', meta: 'Ask scores, odds & analytics', tag: 'ai', tc: 'thot' },
  ]

  return (
    <div className={`dr${theme === 'light' ? ' light' : ''}`}>
      <header className="dh">
        <div className="brand"><span>⚽</span>Sports Alpha AI</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="nbtn">Chats Pipeline</button>
          <button className="thm-btn" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <div className="ubadge" onClick={() => setSettingsOpen(s => !s)}>
            <div className="bdot" /><span className="btxt">@{session.username}</span>
          </div>
          <button className="ibtn" onClick={() => setSettingsOpen(s => !s)}>⚙</button>
        </div>
      </header>
      {settingsOpen && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 75 }} onClick={() => setSettingsOpen(false)} />
          <div className="smenu">
            <div className="shd">
              <div className="snm">{session.username}</div>
              <div className="sem">{session.email}</div>
              <div className="snt">Arc Network Testnet · Connected</div>
            </div>
            <div className="si" onClick={() => { setDrawerOpen(true); setSettingsOpen(false) }}>💼 Account Balance</div>
            <div className="si" onClick={() => { setReceiveOpen(true); setSettingsOpen(false) }}>📥 Receive USDC</div>
            <div className="si" onClick={() => { setSendOpen(true); setSettingsOpen(false) }}>📤 Send USDC</div>
            <div className="si dng" onClick={onSignOut}>→ Sign Out</div>
          </div>
        </>
      )}
      <main className="dm">
        <div className="ws">
          <div className="gp">
            <div className="gey">Arc Network Testnet · Sports Alpha AI Agent Active</div>
            <h1 className="gtit">{greeting},<br /><em>{session.username}</em>.</h1>
          </div>
          <div className="srow">
            <div className="sc"><div className="slbl">Network</div><div className="sval g">ARC</div><div className="sdlt">Testnet · Live RPC</div></div>
            <div className="sc"><div className="slbl">AI Engine</div><div className="sval">Alpha Core</div><div className="sdlt m">2.0 Flash · Ready</div></div>
            <div className="sc"><div className="slbl">Messages</div><div className="sval">{messages.filter(m => m.role === 'user').length}</div><div className="sdlt m">this session</div></div>
          </div>
          {feed.map((item, i) => (
            <div className="fc" key={i}>
              <div className="fi">{item.icon}</div>
              <div style={{ flex: 1 }}>
                <div className="ftit">{item.title}</div>
                <div className="fmeta">{item.meta}</div>
              </div>
              <span className={`ftag ${item.tc}`}>{item.tag}</span>
            </div>
          ))}
          {messages.length > 0 && (
            <>
              <div className="csl">AI Chat Pipeline</div>
              {messages.map(msg => (
                <div key={msg.id} className={`cbw ${msg.role === 'user' ? 'u' : ''}`}>
                  <div className={`cb ${msg.role}`}>{msg.text}</div>
                  <div className="cts">{fmtTime(msg.ts)}</div>
                </div>
              ))}
              {aiTyping && (
                <div className="cbw">
                  <div className="typ"><div className="tdot" /><div className="tdot" /><div className="tdot" /></div>
                </div>
              )}
              <div ref={chatEndRef} />
            </>
          )}
        </div>
      </main>
      <div className="cbw2">
        <div className="chint">What can I do for you?</div>
        <div className="sbadges">
          {['Scores', 'NBA', 'Hockey', 'Football'].map(badge => (
            <button key={badge} className="sbdg" onClick={() => setChatInput(badge)} disabled={aiTyping}>{badge}</button>
          ))}
        </div>
        <div className="cbar">
          <div className="cinn">
            <button className="cbrf" onClick={() => setDrawerOpen(true)}>💼</button>
            <input
              className="cinp"
              placeholder="Ask about scores, fixtures, standings…"
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendChat()}
              disabled={aiTyping}
            />
            <button className="csnd" onClick={sendChat} disabled={aiTyping || !chatInput.trim()}>
              {aiTyping ? <span className="sp" style={{ borderTopColor: '#050505', borderColor: 'rgba(5,5,5,0.2)' }} /> : 'SEND'}
            </button>
          </div>
        </div>
      </div>
      {drawerOpen  && <BalanceDrawer session={session} onClose={() => setDrawerOpen(false)} onSend={() => { setDrawerOpen(false); setSendOpen(true) }} onReceive={() => { setDrawerOpen(false); setReceiveOpen(true) }} />}
      {sendOpen    && <SendModal session={session} onClose={() => setSendOpen(false)} />}
      {receiveOpen && <ReceiveModal address={session.walletAddress} onClose={() => setReceiveOpen(false)} />}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────

/* ─────────────────────────────────────────────────────────────
   ROOT PAGE
───────────────────────────────────────────────────────────── */
export default function Home() {
  const router          = useRouter()
  const googleButtonRef       = useRef<HTMLDivElement>(null)
  const modeRef               = useRef<'signin' | 'signup'>('signin')
  // Tracks whether google.accounts.id.initialize() has already been called.
  // initialize() must only fire once per page load; calling it again triggers
  // the "called multiple times" console warning and can freeze state updates.
  const isGoogleInitialized   = useRef(false)
  const [session,      setSession]      = useState<Session | null>(null)
  const [booting,      setBooting]      = useState(true)
  const [mode,         setMode]         = useState<'signin' | 'signup'>('signin')
  const [form,         setForm]         = useState({ username: '', email: '', password: '' })
  const [authErr,      setAuthErr]      = useState('')
  const [loading,      setLoading]      = useState(false)
  const [googleLoaded, setGoogleLoaded] = useState(false)

  // Keep modeRef current so the Google callback never reads a stale closure value
  useEffect(() => { modeRef.current = mode }, [mode])

  const parseJwt = (token: string) => {
    try { return JSON.parse(window.atob(token.split('.')[1])) } catch { return null }
  }

  const loadGoogleIdentity = async () => {
    if (typeof window === 'undefined') return
    if (window.google?.accounts?.id) { setGoogleLoaded(true); return }
    if (document.getElementById('google-identity-script')) return
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.defer = true
      script.id = 'google-identity-script'
      script.onload = () => { setGoogleLoaded(true); resolve() }
      script.onerror = () => reject(new Error('Failed to load Google Identity script'))
      document.head.appendChild(script)
    })
  }

  const resolveCircleWalletAddress = async (walletId: string): Promise<string> => {
    try {
      const res = await fetch('/api/circle/wallet-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletId }),
      })
      if (!res.ok) return walletId
      const data = await res.json()
      return data?.address?.startsWith('0x') ? data.address : walletId
    } catch {
      return walletId
    }
  }

  // ── When the backend returns walletPending=true, the Circle user has never
  //    completed SDK initialization (PIN setup). We run sdk.execute() with the
  //    initChallengeId, which opens the Circle UI for the user to set their PIN.
  //    After that completes, wallet creation is unblocked and we re-fetch the
  //    wallet via /api/circle/wallet-address polling.
  const completePendingWalletInit = async (
    userToken: string,
    encryptionKey: string,
    initChallengeId: string | null,
    email: string
  ): Promise<{ walletId: string | null; walletAddress: string }> => {
    const sdk = getCircleSDK()
    sdk.setAuthentication({ userToken, encryptionKey })

    if (initChallengeId) {
      // Run the SDK challenge — this opens the Circle PIN UI
      await new Promise<void>((resolve, reject) => {
        sdk.execute(initChallengeId!, (err: any, sdkResult: any) => {
          if (err) {
            console.error('[WalletInit] SDK execute error:', err)
            reject(new Error(err?.message ?? 'Circle wallet initialization failed'))
          } else {
            console.log('[WalletInit] SDK execute success:', sdkResult)
            resolve()
          }
        })
      })
    } else {
      // initChallengeId is null — Circle SDK init may already be complete or
      // the /user/initialize call failed to return a challengeId.
      // Skip the SDK PIN step and go straight to wallet polling.
      console.warn('[WalletInit] initChallengeId is null — skipping sdk.execute(), polling for wallet directly.')
    }

    // Poll for the wallet to appear (Circle creates it asynchronously after SDK init)
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise(r => setTimeout(r, 1500))
      // Poll via wallet-address (by userId/email) — no idToken required
      const walletRes = await fetch('/api/circle/wallet-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: email }),
      }).catch(() => null)

      if (walletRes?.ok) {
        const walletData = await walletRes.json()
        if (walletData?.walletId && walletData?.address?.startsWith('0x')) {
          return { walletId: walletData.walletId, walletAddress: walletData.address }
        }
      }
    }

    // Wallet still not available — return pending state; BalanceDrawer shows guidance
    console.warn('[WalletInit] Wallet not yet available after polling — returning pending state.')
    return { walletId: null, walletAddress: '' }
  }

  // ── Unified Circle social-login call — type is passed in explicitly from
  //    handleGoogleResponse so it always reflects the active tab, never a
  //    stale closure or a hardcoded constant.
  // ── Sign In: looks up existing Circle user & wallet ──
  const handleGoogleCircleLogin = async (idToken: string) => {
    const sdk = getCircleSDK()
    const response = await fetch('/api/circle/social-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, type: 'signin' }),
    })
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null)
      throw new Error(errorBody?.error || 'Circle social login failed.')
    }
    // Spread the parsed JSON into a fresh plain object so that any browser-extension
    // Proxy wrapping the fetch response (e.g. TronLink's tronlinkParams setter trap)
    // cannot intercept property assignments made by the Circle SDK downstream.
    const raw = await response.json()
    const result: Record<string, any> = { ...raw }
    const userToken       = typeof result['userToken']       === 'string' ? result['userToken']       : ''
    const encryptionKey   = typeof result['encryptionKey']   === 'string' ? result['encryptionKey']   : ''
    const walletId        = result['walletId']        ?? null
    const walletAddress   = typeof result['walletAddress']   === 'string' ? result['walletAddress']   : ''
    const walletPending   = !!result['walletPending']
    const initChallengeId = result['initChallengeId'] ?? null

    if (!userToken || !encryptionKey) throw new Error('Circle login failed to return authentication tokens.')

    sdk.setAuthentication({ userToken, encryptionKey })
    return { userToken, encryptionKey, walletId, walletAddress, walletPending, initChallengeId }
  }

  // ── Sign Up: registers new Circle user & creates wallet ──
  const handleGoogleCircleSignUp = async (idToken: string) => {
    const sdk = getCircleSDK()
    const response = await fetch('/api/circle/social-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, type: 'signup' }),
    })
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null)
      throw new Error(errorBody?.error || 'Circle account registration failed.')
    }
    // Same proxy-safe extraction as handleGoogleCircleLogin above.
    const raw2 = await response.json()
    const result2: Record<string, any> = { ...raw2 }
    const userToken       = typeof result2['userToken']       === 'string' ? result2['userToken']       : ''
    const encryptionKey   = typeof result2['encryptionKey']   === 'string' ? result2['encryptionKey']   : ''
    const walletId        = result2['walletId']        ?? null
    const walletAddress   = typeof result2['walletAddress']   === 'string' ? result2['walletAddress']   : ''
    const walletPending   = !!result2['walletPending']
    const initChallengeId = result2['initChallengeId'] ?? null

    if (!userToken || !encryptionKey) throw new Error('Circle sign-up failed to return authentication tokens.')

    sdk.setAuthentication({ userToken, encryptionKey })
    return { userToken, encryptionKey, walletId, walletAddress, walletPending, initChallengeId }
  }

  // ── Unified Google callback — branches on modeRef (never stale) ──
  // The Google Identity Services SDK can fire this as a form POST in some
  // browser environments, which navigates the page to the API URL.
  // We guard against that by intercepting any pending form submissions
  // and doing everything via fetch in the background.
  const handleGoogleResponse = async (response: any) => {
    // Suppress any ambient form POST the GSI SDK may have queued
    if (typeof document !== 'undefined') {
      document.querySelectorAll('form').forEach(f => {
        f.addEventListener('submit', (e) => e.preventDefault(), { once: true })
      })
    }

    if (!response?.credential) { setAuthErr('Google authentication failed.'); return }
    setLoading(true)
    setAuthErr('')

    // modeRef is kept in sync with the `mode` state via a useEffect, so it
    // always reflects the currently-active tab even though this callback is
    // registered once by the GSI SDK.  We log it here so the payload is
    // auditable in DevTools before any network request fires.
    const currentMode = modeRef.current
    console.log('[Google Auth] active tab →', currentMode, '— will send type:', currentMode)
    try {
      const payload = parseJwt(response.credential) as any
      const email   = payload?.email || form.email
      const name    = payload?.name  || email?.split('@')[0] || 'Google User'

      if (currentMode === 'signup') {
        const users = getUsers()
        if (users[email]) {
          setAuthErr('An account with this Google email already exists. Please Sign In instead.')
          return
        }

        const circleResult = await handleGoogleCircleSignUp(response.credential)

        let finalWalletId      = circleResult.walletId
        let finalWalletAddress = circleResult.walletAddress ?? ''

        if (circleResult.walletPending) {
          setAuthErr('')
          const resolved = await completePendingWalletInit(
            circleResult.userToken,
            circleResult.encryptionKey,
            circleResult.initChallengeId ?? null,
            email
          )
          finalWalletId      = resolved.walletId
          finalWalletAddress = resolved.walletAddress
        } else if (!finalWalletAddress && finalWalletId) {
          finalWalletAddress = await resolveCircleWalletAddress(finalWalletId)
        }

        const sessionData: Session = {
          username:            name,
          email:               email || '',
          walletAddress:       finalWalletAddress,
            walletId:            finalWalletId ?? undefined,
          circleUserToken:     circleResult.userToken,
          circleEncryptionKey: circleResult.encryptionKey,
        }
        const users2 = getUsers()
        users2[email] = {
          username:            name,
          passwordHash:        '',
          walletAddress:       finalWalletAddress,
            walletId:            finalWalletId ?? undefined,
          circleUserToken:     circleResult.userToken,
          circleEncryptionKey: circleResult.encryptionKey,
        }
        saveUsers(users2)
        localStorage.setItem('sa_session', JSON.stringify(sessionData))
        setSession(sessionData)
        // Stay on this page — the session state switch renders Dashboard inline.
        // router.push would be used here if Dashboard lived at a separate route.

      } else {
        // ── SIGN IN ──
        const circleResult = await handleGoogleCircleLogin(response.credential)

        let finalWalletId      = circleResult.walletId
        let finalWalletAddress = circleResult.walletAddress ?? ''

        if (circleResult.walletPending) {
          const resolved = await completePendingWalletInit(
            circleResult.userToken,
            circleResult.encryptionKey,
            circleResult.initChallengeId ?? null,
            email
          )
          finalWalletId      = resolved.walletId
          finalWalletAddress = resolved.walletAddress
        } else if (!finalWalletAddress && finalWalletId) {
          finalWalletAddress = await resolveCircleWalletAddress(finalWalletId)
        }

        const sessionData: Session = {
          username:            name,
          email:               email || '',
          walletAddress:       finalWalletAddress,
            walletId:            finalWalletId ?? undefined,
          circleUserToken:     circleResult.userToken,
          circleEncryptionKey: circleResult.encryptionKey,
        }
        localStorage.setItem('sa_session', JSON.stringify(sessionData))
        setSession(sessionData)
        // Session state change re-renders to Dashboard inline on this page.
      }
    } catch (e: any) {
      setAuthErr(e?.message || 'Google authentication failed.')
    } finally {
      setLoading(false)
    }
  }

  const initGoogleButton = () => {
    if (!googleButtonRef.current || typeof window === 'undefined' || !window.google?.accounts?.id) return

    // Only call initialize() once per page load. Subsequent calls (e.g. on tab
    // switch) skip to renderButton() so the button re-renders with the correct
    // text while the already-registered callback is preserved unchanged.
    if (!isGoogleInitialized.current) {
      window.google.accounts.id.initialize({
        client_id:  GOOGLE_CLIENT_ID,
        callback:   handleGoogleResponse,
        ux_mode:    'popup',
        // Pin the credential delivery to this page so the GSI SDK never
        // falls back to a redirect POST that navigates to the API route.
        login_uri:  window.location.href,
        // Prevent One Tap auto-sign-in which bypasses our mode check
        auto_select: false,
        cancel_on_tap_outside: true,
      })
      isGoogleInitialized.current = true
    }

    window.google.accounts.id.renderButton(googleButtonRef.current, {
      theme: 'outline',
      size:  'large',
      text:  mode === 'signup' ? 'signup_with' : 'signin_with',
      shape: 'rectangular',
    })
  }

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        await loadGoogleIdentity()
      } catch (err) {
        if (!cancelled) console.error(err)
      }
    }
    run()
    // Cleanup flag prevents setGoogleLoaded from firing if the component
    // unmounts before the script finishes loading (avoids state-on-unmount warning).
    return () => { cancelled = true }
  }, [])

  // ── Intercept Google's redirect-mode form POST fallback ──
  // When GSI can't open a popup (e.g. blocked by browser), it falls back to
  // posting `credential` as a form field to login_uri (this page's URL).
  // We intercept that param, feed it into handleGoogleResponse ourselves,
  // and clean the URL so the raw JSON never reaches the browser's address bar.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const credential = params.get('credential')
    if (credential) {
      // Remove the credential param from the URL immediately
      params.delete('credential')
      const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '')
      window.history.replaceState({}, '', clean)
      // Feed it into the normal handler
      handleGoogleResponse({ credential })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render Google button whenever SDK loads OR tab switches
  useEffect(() => {
    if (googleLoaded) initGoogleButton()
  }, [googleLoaded, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Restore session from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem('sa_session')
      if (raw) setSession(JSON.parse(raw))
    } catch {}
    setBooting(false)
  }, [])

  // Re-resolve non-EVM wallet address after session restore or on first mount.
  // Handles two distinct cases:
  //  A) session.walletId is set but the address lookup failed during sign-up.
  //     Try resolveCircleWalletAddress(walletId) as before, with email as fallback.
  //  B) walletPending path: walletId is null because completePendingWalletInit
  //     timed out, but Circle has since created the wallet server-side.
  //     In this case walletId is falsy — fall straight through to email lookup.
  useEffect(() => {
    if (!session) return
    const needsResolution = !session.walletAddress || !session.walletAddress.startsWith('0x')
    if (!needsResolution) return

    // Helper: look up the wallet by Circle userId (= email for Google sign-ups)
    const resolveByEmail = async () => {
      if (!session.email) return
      try {
        const res = await fetch('/api/circle/wallet-address', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: session.email }),
        })
        if (!res.ok) return
        const data = await res.json()
        if (data?.address?.startsWith('0x')) {
          const updated: Session = {
            ...session,
            walletAddress: data.address,
            walletId: data.walletId ?? session.walletId,
          }
          localStorage.setItem('sa_session', JSON.stringify(updated))
          setSession(updated)
        }
      } catch {}
    }

    if (session.walletId) {
      // Case A: walletId known — try the direct lookup first, email as fallback
      resolveCircleWalletAddress(session.walletId)
        .then(addr => {
          if (addr.startsWith('0x') && addr !== session.walletAddress) {
            const updated: Session = { ...session, walletAddress: addr }
            localStorage.setItem('sa_session', JSON.stringify(updated))
            setSession(updated)
          } else {
            resolveByEmail()
          }
        })
        .catch(() => resolveByEmail())
    } else {
      // Case B: walletId is null (walletPending timed out) — go straight to email lookup
      resolveByEmail()
    }
  }, [session?.walletId, session?.walletAddress]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSignUp = async () => {
    setAuthErr('')
    const { username, email, password } = form
    if (!username || !email || !password) { setAuthErr('All fields are required.'); return }
    if (password.length < 6) { setAuthErr('Password must be at least 6 characters.'); return }
    if (!/\S+@\S+\.\S+/.test(email)) { setAuthErr('Enter a valid email address.'); return }
    setLoading(true)
    try {
      const users = getUsers()
      if (users[email]) { setAuthErr('Account already exists. Sign in instead.'); return }

      const response = await fetch('/api/wallet/initialize-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      // Spread into a plain object for the same proxy-safety reason as the
      // Google flow — prevents TronLink / extension Proxy traps on property writes.
      const raw = await response.json()
      if (!response.ok) throw new Error(raw?.error || 'Failed to initialize wallet user')
      const result: Record<string, any> = { ...raw }

      const userToken     = typeof result['userToken']     === 'string' ? result['userToken']     : ''
      const encryptionKey = typeof result['encryptionKey'] === 'string' ? result['encryptionKey'] : ''
      const challengeId   = result['challengeId'] ?? result['initChallengeId'] ?? null
      let   walletId      = result['walletId']    ?? null
      let   walletAddress = typeof result['walletAddress'] === 'string' ? result['walletAddress'] : ''

      if (!userToken || !encryptionKey) throw new Error('Wallet initialisation failed — no auth tokens returned.')

      // ── PIN / passcode challenge ──────────────────────────────────────────
      // The backend blocks wallet creation until the Circle SDK PIN modal has
      // been completed by the user (same requirement as the Google sign-up flow).
      // If the response carries a challengeId we must run sdk.execute() now;
      // skipping this step causes the -1 "user needs SDK PIN" error and leaves
      // walletAddress unresolved, which is exactly the bug being fixed here.
      if (challengeId) {
        const sdk = getCircleSDK()
        sdk.setAuthentication({ userToken, encryptionKey })
        await new Promise<void>((resolve, reject) => {
          sdk.execute(challengeId, (err: any, sdkResult: any) => {
            if (err) {
              console.error('[EmailSignUp] SDK execute error:', err)
              reject(new Error(err?.message ?? 'Circle PIN setup failed — please try again.'))
            } else {
              console.log('[EmailSignUp] SDK execute success:', sdkResult)
              resolve()
            }
          })
        })
      }

      // ── Resolve wallet address ────────────────────────────────────────────
      // Circle creates the wallet asynchronously after PIN setup, so poll
      // /api/circle/wallet-address (by email / userId) until it appears,
      // mirroring the polling loop inside completePendingWalletInit.
      if (!walletAddress || !walletAddress.startsWith('0x')) {
        for (let attempt = 0; attempt < 8; attempt++) {
          await new Promise(r => setTimeout(r, 1500))
          const walletRes = await fetch('/api/circle/wallet-address', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ userId: email }),
          }).catch(() => null)
          if (walletRes?.ok) {
            const walletData = await walletRes.json().catch(() => ({}))
            if (walletData?.address?.startsWith('0x')) {
              walletAddress = walletData.address
              walletId      = walletData.walletId ?? walletId
              break
            }
          }
        }
      }

      // ── Persist session ───────────────────────────────────────────────────
      const sess: Session = {
        username,
        email,
        walletAddress,
        walletId,
        circleUserToken:     userToken,
        circleEncryptionKey: encryptionKey,
      }
      users[email] = {
        username,
        passwordHash:        simpleHash(password),
        walletAddress:       sess.walletAddress,
        walletId:            sess.walletId,
        circleUserToken:     sess.circleUserToken,
        circleEncryptionKey: sess.circleEncryptionKey,
      }
      saveUsers(users)
      localStorage.setItem('sa_session', JSON.stringify(sess))
      setSession(sess)
    } catch (error: any) {
      setAuthErr(error?.message || 'Signup failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleSignIn = async () => {
    setAuthErr('')
    const { email, password } = form
    if (!email || !password) { setAuthErr('Email and password are required.'); return }
    setLoading(true)
    await new Promise(r => setTimeout(r, 800))
    const users = getUsers()
    const user  = users[email]
    if (!user || user.passwordHash !== simpleHash(password)) {
      setAuthErr('Invalid email or password.')
      setLoading(false)
      return
    }
    const sess: Session = {
      username:            user.username,
      email,
      walletAddress:       user.walletAddress,
      walletId:            user.walletId,
      circleUserToken:     user.circleUserToken,
      circleEncryptionKey: user.circleEncryptionKey,
    }
    localStorage.setItem('sa_session', JSON.stringify(sess))
    setSession(sess)
    setLoading(false)
  }

  const handleSignOut = () => {
    localStorage.removeItem('sa_session')
    setSession(null)
    setForm({ username: '', email: '', password: '' })
    setAuthErr('')
  }

  if (booting) {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />
        <div style={{ background: '#050505', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ fontFamily: 'monospace', color: '#00ff66', fontSize: 11, letterSpacing: 3, textTransform: 'uppercase' }}>Initialising…</div>
        </div>
      </>
    )
  }

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />
      {!session
        ? <AuthScreen mode={mode} setMode={setMode} form={form} setForm={setForm} error={authErr} loading={loading} onSignUp={handleSignUp} onSignIn={handleSignIn} googleButtonRef={googleButtonRef} />
        : <Dashboard session={session} onSignOut={handleSignOut} />
      }
    </>
  )
}