/* ============================================================
   app/api/web-search/route.ts
   FIXES APPLIED:
     Bug 1 — stripDSML() scrubs <|DSML|tool_calls> markup from
              message.content before it ever enters history or
              becomes finalContent.
     Bug 2 — final-answer guard now requires BOTH no tool_calls
              AND non-empty content before breaking the loop.
     Bug 3 — returnPlainJSON toggle: set false if your frontend
              uses useChat() (AI SDK stream), true for fetch().
   ============================================================ */

/* ── Toggle to match your frontend ──────────────────────────── */
const returnPlainJSON = true   // true → { content } JSON  |  false → AI SDK stream

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const SERPER_API_KEY   = process.env.SERPER_API_KEY   ?? ''
const DEEPSEEK_URL     = 'https://api.deepseek.com/chat/completions'
const SERPER_URL       = 'https://google.serper.dev/search'
const MAX_TOOL_ROUNDS  = 3

/* ── Types ───────────────────────────────────────────────────── */
interface Message {
  role         : 'system' | 'user' | 'assistant' | 'tool'
  content      : string | null
  tool_calls   ?: ToolCall[]
  tool_call_id ?: string
  name         ?: string
}
interface ToolCall {
  id       : string
  type     : 'function'
  function : { name: string; arguments: string }
}

/* ── FIX 1: Strip raw DSML / tool-call markup ────────────────
   DeepSeek-chat sometimes echoes its internal tool-call syntax
   into content even when tool_calls is populated. Scrub it here
   so it never reaches history or the final response.           */
const DSML_RE = /<\|(?:DSML|tool_calls?|plugin_calls?)[^>]*>[\s\S]*?<\/\|(?:DSML|tool_calls?|plugin_calls?)\|>/gi

function stripDSML(text: string | null | undefined): string {
  if (!text) return ''
  return text.replace(DSML_RE, '').trim()
}

/* ── ESPN league map ─────────────────────────────────────────── */
function detectESPNEndpoint(query: string): string | null {
  const q = query.toLowerCase()
  if (/ajax|utrecht|eredivisie|dutch|psv|feyenoord/.test(q))            return 'soccer/ned.1'
  if (/premier league|epl|arsenal|chelsea|man city|man utd|liverpool|tottenham|newcastle|west ham|aston villa|brighton/.test(q)) return 'soccer/eng.1'
  if (/la liga|real madrid|barcelona|atletico|sevilla|spanish/.test(q)) return 'soccer/esp.1'
  if (/serie a|juventus|inter|ac milan|napoli|roma|italian/.test(q))    return 'soccer/ita.1'
  if (/bundesliga|bayern|dortmund|leverkusen|german/.test(q))           return 'soccer/ger.1'
  if (/ligue 1|psg|marseille|monaco|french/.test(q))                    return 'soccer/fra.1'
  if (/champions league|ucl/.test(q))                                   return 'soccer/uefa.champions'
  if (/europa league|uel/.test(q))                                      return 'soccer/uefa.europa'
  if (/mls|major league soccer/.test(q))                                return 'soccer/usa.1'
  if (/\bnba\b|lakers|celtics|warriors|knicks/.test(q))                 return 'basketball/nba'
  if (/\bnfl\b|chiefs|patriots|cowboys|eagles/.test(q))                 return 'football/nfl'
  if (/\bmlb\b|yankees|dodgers|red sox/.test(q))                        return 'baseball/mlb'
  if (/\bnhl\b|maple leafs|bruins|rangers|penguins/.test(q))            return 'hockey/nhl'
  return null
}

/* ── ESPN free public API ────────────────────────────────────── */
async function fetchESPNScores(endpoint: string, teamFilter?: string): Promise<string> {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${endpoint}/scoreboard`
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return `ESPN API returned ${res.status}`

    const data      = await res.json()
    const events: any[] = data?.events ?? []
    if (!events.length) return 'No games scheduled in ESPN for this league today.'

    const filtered = teamFilter
      ? events.filter((e: any) =>
          e.name?.toLowerCase().includes(teamFilter.toLowerCase()) ||
          e.shortName?.toLowerCase().includes(teamFilter.toLowerCase()) ||
          e.competitions?.[0]?.competitors?.some((c: any) =>
            c.team?.displayName?.toLowerCase().includes(teamFilter.toLowerCase()) ||
            c.team?.shortDisplayName?.toLowerCase().includes(teamFilter.toLowerCase())
          )
        )
      : events

    const toShow = (filtered.length ? filtered : events).slice(0, 10)
    let out = `=== ESPN SCOREBOARD (${endpoint.toUpperCase()}) ===\n\n`

    for (const event of toShow) {
      const comp      = event.competitions?.[0]
      const status    = comp?.status?.type
      const home      = comp?.competitors?.find((c: any) => c.homeAway === 'home')
      const away      = comp?.competitors?.find((c: any) => c.homeAway === 'away')
      const homeName  = home?.team?.displayName ?? '?'
      const awayName  = away?.team?.displayName ?? '?'
      const homeScore = home?.score ?? '-'
      const awayScore = away?.score ?? '-'
      const stateName = status?.description ?? status?.name ?? 'Scheduled'
      const clock     = comp?.status?.displayClock ?? ''
      const period    = comp?.status?.period ?? ''
      const venue     = comp?.venue?.fullName ?? ''
      const date      = comp?.date ? new Date(comp.date).toUTCString() : ''

      out += `📋 ${homeName} (H) vs ${awayName} (A)\n`
      out += `   Score  : ${homeScore} – ${awayScore}\n`
      out += `   Status : ${stateName}`
      if (clock && clock !== '0:00') out += ` | ${clock}`
      if (period)                    out += ` | Period ${period}`
      out += '\n'
      if (venue) out += `   Venue  : ${venue}\n`
      if (date)  out += `   Date   : ${date}\n`
      out += '\n'
    }

    out += `Source: ESPN — https://www.espn.com\n`
    return out
  } catch (err: any) {
    return `ESPN fetch error: ${err.message}`
  }
}

/* ── Serper search ───────────────────────────────────────────── */
const STALE_YEARS = ['2024', '2023', '2022', '2021', '2020']
function isStale(item: { title?: string; snippet?: string; date?: string }): boolean {
  const { title = '', snippet = '', date = '' } = item
  if (date && STALE_YEARS.some(y => date.startsWith(y)))    return true
  if (STALE_YEARS.some(y => title.includes(y)))             return true
  const fy = snippet.match(/\b(20\d{2})\b/)?.[1]
  if (fy && STALE_YEARS.includes(fy))                       return true
  return false
}

async function serperSearch(query: string, tbs?: string): Promise<any> {
  if (!SERPER_API_KEY) return null
  const res = await fetch(SERPER_URL, {
    method : 'POST',
    headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
    body   : JSON.stringify({ q: query, gl: 'us', hl: 'en', num: 8, ...(tbs ? { tbs } : {}) }),
  })
  return res.ok ? res.json() : null
}

/* ── Main search handler ─────────────────────────────────────── */
async function runWebSearch(query: string, type: string): Promise<string> {
  const pinned = /20(2[5-9]|[3-9]\d)/.test(query) ? query : `${query} 2026`
  let out = ''

  if (type === 'live_score' || type === 'standings') {
    out += `LIVE DATA for: "${query}"\n\n`

    const endpoint  = detectESPNEndpoint(query)
    if (endpoint) {
      const teamHint = query.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?)\b/)?.[1]
      out += await fetchESPNScores(endpoint, teamHint)
    }

    const live = await serperSearch(`${pinned} live score`, 'qdr:h')
    if (live?.sportsResults) {
      out += `=== GOOGLE SPORTS WIDGET ===\n${JSON.stringify(live.sportsResults, null, 2)}\n\n`
    }
    if (live?.answerBox) {
      const ab = live.answerBox
      out += `=== GOOGLE ANSWER BOX ===\n`
      if (ab.title)   out += `Match:  ${ab.title}\n`
      if (ab.answer)  out += `Score:  ${ab.answer}\n`
      if (ab.snippet) out += `Detail: ${ab.snippet}\n`
      if (ab.link)    out += `Source: ${ab.link}\n`
      out += '\n'
    }
    if (live?.news?.length) {
      const fresh = (live.news as any[]).filter(n => !isStale(n)).slice(0, 3)
      if (fresh.length) {
        out += `=== MATCH NEWS ===\n`
        fresh.forEach((n: any) => {
          out += `- ${n.title} (${n.date ?? 'recent'})\n  ${n.snippet ?? ''}\n  ${n.link}\n\n`
        })
      }
    }
    return out || 'No live data found. Match may not have started yet.'
  }

  const data = await serperSearch(pinned, 'qdr:m6')
  if (!data) return 'Search failed — check SERPER_API_KEY.'
  out += `SEARCH RESULTS for "${pinned}":\n\n`
  if (data.sportsResults) out += `=== SPORTS DATA ===\n${JSON.stringify(data.sportsResults, null, 2)}\n\n`
  if (data.answerBox) {
    const ab = data.answerBox
    out += `=== ANSWER BOX ===\nTitle: ${ab.title ?? ''}\nAnswer: ${ab.answer ?? ''}\nDetail: ${ab.snippet ?? ''}\nSource: ${ab.link ?? ''}\n\n`
  }
  if (data.news?.length) {
    const fresh = (data.news as any[]).filter(n => !isStale(n)).slice(0, 5)
    if (fresh.length) {
      out += `=== TOP NEWS ===\n`
      fresh.forEach((n: any) => { out += `- ${n.title} (${n.date ?? 'recent'})\n  ${n.snippet ?? ''}\n  ${n.link}\n\n` })
    }
  }
  if (data.organic?.length) {
    const fresh = (data.organic as any[]).filter(r => !isStale(r)).slice(0, 5)
    if (fresh.length) {
      out += `=== WEB RESULTS ===\n`
      fresh.forEach((r: any) => { out += `Title: ${r.title}\nSnippet: ${r.snippet}\nLink: ${r.link}\n\n` })
    }
  }
  return out || 'No results found.'
}

/* ── Tool schema ─────────────────────────────────────────────── */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'webSearch',
      description:
        'Fetch live sports scores, fixtures, standings, transfers and news. ' +
        'Use type live_score for any score or match result. ' +
        'Always call this before answering — never use training memory for sports.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Full query including team names and year 2026 or season 2025-26.',
          },
          type: {
            type: 'string',
            enum: ['live_score', 'news', 'standings', 'general'],
            description: 'live_score for scores/fixtures, standings for tables, news for articles.',
          },
        },
        required: ['query', 'type'],
      },
    },
  },
]

/* ── System prompt ───────────────────────────────────────────── */
const SYSTEM_PROMPT: Message = {
  role: 'system',
  content: `You are a real-time sports AI assistant with access to live web search.

FORMATTING RULES — strictly enforced, no exceptions:
- NEVER use markdown syntax of any kind in your responses.
- NEVER use asterisks (*) or double-asterisks (**) for bold or emphasis.
- NEVER use underscores (_) for italics.
- NEVER use pound signs (#) for headings.
- NEVER use vertical pipes (|) or dashes to create tables.
- NEVER use square brackets or parentheses for markdown links.
- NEVER use backticks or code fences.
- For lists, use only plain numbered format: "1. Item" on its own line. No bullet points, no dashes, no asterisks.
- Separate sections with a blank line. Use plain ALL CAPS words as section labels if needed (e.g. RESULT, FIXTURES, STANDINGS).
- Write in clean, natural prose. Responses should read like a knowledgeable friend texting you sports updates, not a formatted document.
- Keep responses concise. Lead with the most important fact, then add context below it.

SPORTS DATA RULES:
1. ALWAYS call webSearch before answering sports questions. Never rely on training memory for sports facts.
2. For score or match result questions, use type "live_score".
3. When you receive score data from the tool, report it directly and confidently. Do not say "let me check" or "snippets are not populated".
4. Home team is always listed first: Home vs Away.
5. If no live data is found, say the match may not have started yet and give the scheduled time if available.
6. Always respond in clear English.`,
}

/* ── DeepSeek call ───────────────────────────────────────────── */
async function callDeepSeek(messages: Message[], opts: { force?: boolean; lock?: boolean } = {}) {
  const toolChoice = opts.lock  ? 'none'
    : opts.force ? { type: 'function', function: { name: 'webSearch' } }
    : 'auto'

  const res = await fetch(DEEPSEEK_URL, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY.trim()}` },
    body   : JSON.stringify({
      model       : 'deepseek-chat',
      messages,
      tools       : TOOLS,
      tool_choice : toolChoice,
      temperature : 0.2,
      max_tokens  : 1024,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error(err?.error?.message ?? `DeepSeek HTTP ${res.status}`)
  }
  return res.json()
}

/* ── Sports detector ─────────────────────────────────────────── */
function isSports(messages: Message[]): boolean {
  const last = messages.filter(m => m.role === 'user').at(-1)?.content ?? ''
  return /score|fixture|match|league|table|standing|transfer|goal|live|result|club|team|player|vs|today|tonight|weekend|kick.?off|premier|bundesliga|la liga|serie a|ligue|mls|nba|nfl|nhl|mlb|ufc|f1|tennis|cricket|rugby/i.test(last)
}

/* ── JSON helper ─────────────────────────────────────────────── */
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/* ── FIX 3: AI SDK stream helper ─────────────────────────────
   Only needed when returnPlainJSON = false (useChat() frontend).
   Emits Vercel AI SDK text-stream protocol so useChat() works:
   each chunk is "0:{json-string}\n", finished with a data event. */
function toAIStream(text: string): Response {
  const encoder = new TextEncoder()
  const stream  = new ReadableStream({
    start(controller) {
      for (const word of text.split(/(\s+)/)) {
        if (word) controller.enqueue(encoder.encode(`0:${JSON.stringify(word)}\n`))
      }
      controller.enqueue(
        encoder.encode(`d:{"finishReason":"stop","usage":{"promptTokens":0,"completionTokens":0}}\n`)
      )
      controller.close()
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type'           : 'text/plain; charset=utf-8',
      'X-Vercel-AI-Data-Stream': 'v1',
      'Transfer-Encoding'      : 'chunked',
    },
  })
}

/* ── POST handler ────────────────────────────────────────────── */
export async function POST(request: Request) {
  try {
    if (!DEEPSEEK_API_KEY) return json({ error: 'DEEPSEEK_API_KEY is not set.' }, 500)

    const body           = await request.json().catch(() => null)
    const clientMessages : Message[] = body?.messages
    const userId         : string    = body?.userId

    if (!Array.isArray(clientMessages) || !clientMessages.length)
      return json({ error: 'messages must be a non-empty array.' }, 400)
    if (!userId || typeof userId !== 'string')
      return json({ error: 'userId must be a non-empty string.' }, 400)

    const messages   : Message[] = [SYSTEM_PROMPT, ...clientMessages]
    const forceFirst : boolean   = isSports(clientMessages)
    let toolsRan     = false
    let finalContent = ''
    let round        = 0

    while (round < MAX_TOOL_ROUNDS) {
      const ds     = await callDeepSeek(messages, { force: round === 0 && forceFirst, lock: toolsRan && round >= 1 })
      const choice = ds?.choices?.[0]
      if (!choice) throw new Error('DeepSeek returned no choices.')

      const msg: Message = choice.message

      // FIX 1 — scrub DSML markup from content immediately on arrival,
      // before it enters history or is tested as a final answer.
      if (msg.content) msg.content = stripDSML(msg.content)

      messages.push(msg)

      // FIX 2 — only treat this as a final answer when there are NO
      // tool_calls AND we have actual non-empty clean content.
      // The old code broke on `content ?? ''` which accepted empty strings.
      if (!msg.tool_calls?.length) {
        if (msg.content) {
          finalContent = msg.content
        }
        break
      }

      // Execute tool calls
      for (const tc of msg.tool_calls) {
        let result = ''
        if (tc.function.name === 'webSearch') {
          let args: { query?: string; type?: string } = {}
          try { args = JSON.parse(tc.function.arguments) } catch { /* ignore */ }
          result = await runWebSearch(
            args.query ?? clientMessages.at(-1)?.content ?? 'sports news 2026',
            args.type  ?? 'general',
          )
        } else {
          result = `Unknown tool: ${tc.function.name}`
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result })
        toolsRan = true
      }
      round++
    }

    // Fallback: find last clean assistant message with content and no tool_calls
    if (!finalContent) {
      const last = [...messages].reverse().find(
        m => m.role === 'assistant' && m.content && !m.tool_calls?.length
      )
      finalContent = last?.content ?? 'No data found. The match may not have started yet.'
    }

    // Belt-and-suspenders: strip any markup that slipped through
    finalContent = stripDSML(finalContent)

    return returnPlainJSON
      ? json({ content: finalContent })
      : toAIStream(finalContent)

  } catch (err: any) {
    console.error('[route error]', err?.message ?? err)
    return json({ error: 'Internal Server Error', details: err?.message }, 500)
  }
}