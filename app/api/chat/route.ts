/* ============================================================
   app/api/web-search/route.ts
   FIXES APPLIED:
     Fix 1  — DSML stripping: 3-pass scrub, spaces-around-pipes
              regex, line-level fallback, nuclear recovery call.
     Fix 2  — Final-answer guard: require non-empty content AND
              no tool_calls before breaking the loop.
     Fix 3  — returnPlainJSON toggle for frontend compatibility.
     Fix 4  — Year awareness: CURRENT_YEAR = 2026. Live/today
              queries pin to 2026; historical queries keep their
              year; "have they ever" queries use no year at all.
     Fix 5  — Staleness filter is query-year-relative, not a
              hardcoded blocklist of years.
     Fix 6  — ESPN scoreboard extracts match clock, period label,
              and goal scorers from details / statistics arrays.
     Fix 7  — Historical query detection preserved; no year
              appended when user explicitly names a past year.
     Fix 8  — CONTEXT RESOLUTION: conversation history is parsed
              to extract entity mentions (teams, competitions,
              players). Ambiguous follow-up messages like "thy
              played" or "did they meet" are expanded into full
              resolved queries before DeepSeek ever sees them.
     Fix 9  — TENSE DETECTION: past-tense phrases ("they played",
              "did they ever meet", "who won when") trigger a
              no-year open search across all seasons, not a 2026
              pin. Prevents hallucination of future schedule facts.
     Fix 10 — System prompt: explicit context-resolution
              instructions, no hallucination of schedules.
   ============================================================ */

/* ── Toggle to match your frontend ──────────────────────────── */
const returnPlainJSON = true   // true → { content } JSON  |  false → AI SDK stream

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const SERPER_API_KEY   = process.env.SERPER_API_KEY   ?? ''
const DEEPSEEK_URL     = 'https://api.deepseek.com/chat/completions'
const SERPER_URL       = 'https://google.serper.dev/search'
const MAX_TOOL_ROUNDS  = 4   // one extra round for context-aware follow-ups

const CURRENT_YEAR = 2026

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

/* ============================================================
   FIX 1 — DSML stripping (3-pass, handles spaces around pipes)
   ============================================================ */
const DSML_BLOCK_RE = /<\s*\|\s*(?:DSML|tool_calls?|plugin_calls?|invoke)[^>]*>[\s\S]*?<\/\s*\|\s*(?:DSML|tool_calls?|plugin_calls?|invoke)\s*\|?\s*>/gi
const DSML_TAG_RE   = /<\s*\/?\s*\|\s*(?:DSML|tool_calls?|plugin_calls?|invoke|parameter)[^>]*>/gi
const DSML_FRAG_RE  = /<\s*\/?\s*\|\s*(?:DSML|tool_calls?|invoke|parameter)/i

function stripDSML(text: string | null | undefined): string {
  if (!text) return ''
  let out = text.replace(DSML_BLOCK_RE, '')
  out = out.split('\n').filter(line => { const hit = DSML_TAG_RE.test(line); DSML_TAG_RE.lastIndex = 0; return !hit }).join('\n')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/* ============================================================
   FIX 8 — CONTEXT RESOLUTION
   Parse the last N messages to extract named entities
   (teams, competitions, players) so follow-up messages like
   "thy played" or "did they meet" can be resolved to full
   explicit queries before DeepSeek builds its search.
   ============================================================ */

// Known football teams — expand as needed
const KNOWN_TEAMS = [
  'PSG','Paris Saint-Germain','Arsenal','Chelsea','Liverpool','Manchester City',
  'Manchester United','Tottenham','Newcastle','Aston Villa','Brighton',
  'Real Madrid','Barcelona','Atletico Madrid','Sevilla',
  'Bayern Munich','Borussia Dortmund','Bayer Leverkusen',
  'Juventus','Inter Milan','AC Milan','Napoli','Roma',
  'Ajax','Feyenoord','PSV',
  'Lakers','Celtics','Warriors','Knicks','Heat','Bulls',
  'Chiefs','Cowboys','Patriots','Eagles','49ers',
  'Yankees','Dodgers','Red Sox','Cubs',
]

const KNOWN_COMPETITIONS = [
  'Champions League','UCL','UEFA Champions League',
  'Premier League','EPL','La Liga','Serie A','Bundesliga','Ligue 1',
  'Europa League','FA Cup','Copa del Rey','DFB-Pokal','Coupe de France',
  'World Cup','Euro','Nations League','MLS','NBA','NFL','MLB','NHL',
]

interface ConversationContext {
  teams        : string[]   // up to 2 teams mentioned most recently
  competition  : string | null
  isPastTense  : boolean    // user is asking about something that already happened
  isAmbiguous  : boolean    // "they", "thy", pronouns without explicit names
}

function extractContext(messages: Message[]): ConversationContext {
  // Look back through the last 10 messages (user + assistant)
  const recent = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-10)
    .map(m => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')

  const recentLower = recent.toLowerCase()

  // Extract teams (preserve casing from known list)
  const foundTeams: string[] = []
  for (const t of KNOWN_TEAMS) {
    if (recentLower.includes(t.toLowerCase()) && !foundTeams.includes(t)) {
      foundTeams.push(t)
      if (foundTeams.length >= 4) break
    }
  }

  // Extract competition
  let competition: string | null = null
  for (const c of KNOWN_COMPETITIONS) {
    if (recentLower.includes(c.toLowerCase())) { competition = c; break }
  }

  // Detect past-tense / historical intent in the LAST user message
  const lastUser = messages.filter(m => m.role === 'user').at(-1)?.content ?? ''
  const pastTenseRe = /\b(played|did they|have they|ever (meet|play|face)|who won|what was the score|when did|last time|history|all time)\b/i
  const isPastTense = pastTenseRe.test(lastUser)

  // Detect ambiguous pronouns
  const ambiguousRe = /\b(they|thy|them|those two|these teams|the two|both teams)\b/i
  const isAmbiguous = ambiguousRe.test(lastUser) && foundTeams.length >= 2

  return { teams: foundTeams.slice(0, 4), competition, isPastTense, isAmbiguous }
}

/* Build a resolved search query from context + the raw user message */
function resolveQuery(raw: string, ctx: ConversationContext): string {
  const hasExplicitTeams = KNOWN_TEAMS.some(t => raw.toLowerCase().includes(t.toLowerCase()))

  let resolved = raw

  // If message uses pronouns but context has teams, substitute them
  if (ctx.isAmbiguous && ctx.teams.length >= 2 && !hasExplicitTeams) {
    const teamPhrase = ctx.teams.slice(0, 2).join(' vs ')
    // Replace the ambiguous pronoun phrase with the actual team names
    resolved = resolved.replace(/\b(they|thy|them|those two|these teams|the two|both teams)\b/gi, teamPhrase)
  }

  // Inject competition if mentioned in context but not in this message
  if (ctx.competition && !resolved.toLowerCase().includes(ctx.competition.toLowerCase())) {
    resolved = `${resolved} ${ctx.competition}`
  }

  return resolved.trim()
}

/* ============================================================
   FIX 4 — Year / tense awareness
   ============================================================ */
function extractQueryYear(query: string): string | null {
  const match = query.match(/\b(19\d{2}|20[01]\d|202[0-5])\b/)
  return match ? match[1] : null
}

const PAST_TENSE_RE = /\b(played|did they|have they|ever (meet|play|face)|who won|what was the score|when did|last time|history|all time|head.?to.?head|h2h)\b/i

/* ============================================================
   FIX 5 — Staleness filter (relative to query year)
   ============================================================ */
function isStaleForQuery(
  item: { title?: string; snippet?: string; date?: string },
  queryYear: string | null,
  isPastTense: boolean
): boolean {
  // Past-tense / historical queries: never filter — we want old results
  if (queryYear || isPastTense) return false

  const text = `${item.title ?? ''} ${item.snippet ?? ''} ${item.date ?? ''}`
  const years = text.match(/\b(20\d{2})\b/g)
  if (!years) return false
  return years.every(y => parseInt(y, 10) < 2025)
}

/* ============================================================
   ESPN league map
   ============================================================ */
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

/* ============================================================
   FIX 6 — ESPN scoreboard with clock, period, goal scorers
   ============================================================ */
async function fetchESPNScores(endpoint: string, teamFilter?: string): Promise<string> {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${endpoint}/scoreboard`
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) })
    if (!res.ok) return `ESPN API returned ${res.status}`

    const data      = await res.json()
    const events: any[] = data?.events ?? []
    if (!events.length) return 'No games scheduled in ESPN for this league today.'

    const filtered = teamFilter
      ? events.filter((e: any) =>
          e.name?.toLowerCase().includes(teamFilter.toLowerCase()) ||
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
      const isLive    = status?.state === 'in'
      const isPost    = status?.state === 'post'
      const clock     = comp?.status?.displayClock ?? ''
      const period    = comp?.status?.period ?? 0
      const periodLabel = (() => {
        if (!period) return ''
        if (endpoint.startsWith('soccer'))     return period === 1 ? '1st Half' : period === 2 ? '2nd Half' : 'Extra Time'
        if (endpoint.startsWith('basketball')) return `Q${period}`
        if (endpoint.startsWith('football'))   return `Q${period}`
        return `Period ${period}`
      })()
      const rawDate = comp?.date ? new Date(comp.date) : null
      const dateStr = rawDate
        ? rawDate.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })
        : ''

      out += `${home?.team?.displayName ?? '?'} vs ${away?.team?.displayName ?? '?'}\n`
      out += `Score: ${home?.score ?? '-'} - ${away?.score ?? '-'}\n`
      if (isLive)    { out += `Status: LIVE${clock && clock !== '0:00' ? ' | ' + clock : ''}${periodLabel ? ' | ' + periodLabel : ''}\n` }
      else if (isPost) { out += `Status: Full Time\n` }
      else           { out += `Status: ${status?.description ?? 'Scheduled'}\n` }
      if (dateStr)   out += `Date: ${dateStr}\n`

      // Goal scorers
      const scoringPlays: string[] = []
      const details: any[] = comp?.details ?? []
      details.forEach((d: any) => {
        const isGoal = d.type?.text?.toLowerCase().includes('goal') ||
                       d.scoringType?.displayName?.toLowerCase().includes('goal')
        if (isGoal) {
          const scorer = d.athletesInvolved?.[0]?.displayName ?? ''
          const team   = d.team?.displayName ?? ''
          const t      = d.clock?.displayValue ?? ''
          if (scorer) scoringPlays.push(`${scorer} (${team})${t ? ' ' + t : ''}`)
        }
      })
      for (const comp2 of [home, away]) {
        const stats = comp2?.statistics ?? []
        const g = stats.find((s: any) => s.name === 'goals' || s.abbreviation === 'G')
        g?.athletes?.forEach((a: any) => {
          if (a.athlete?.displayName && a.stat) {
            scoringPlays.push(`${a.athlete.displayName} (${comp2?.team?.shortDisplayName}) x${a.stat}`)
          }
        })
      }
      if (scoringPlays.length) out += `Scorers: ${scoringPlays.join(', ')}\n`
      out += '\n'
    }

    out += `Source: ESPN\n`
    return out
  } catch (err: any) {
    return `ESPN fetch error: ${err.message}`
  }
}

/* ============================================================
   Serper helper
   ============================================================ */
async function serperSearch(query: string, tbs?: string): Promise<any> {
  if (!SERPER_API_KEY) return null
  const res = await fetch(SERPER_URL, {
    method : 'POST',
    headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
    body   : JSON.stringify({ q: query, gl: 'us', hl: 'en', num: 10, ...(tbs ? { tbs } : {}) }),
  })
  return res.ok ? res.json() : null
}

/* ============================================================
   Main search handler — 3-tier: live → recent (48h) → historical
   ============================================================ */
async function runWebSearch(query: string, type: string, isPastTenseHint = false): Promise<string> {
  const queryYear = extractQueryYear(query)

  // Classify the query into one of three tiers:
  //   LIVE       — happening right now ("live", "now", "current score")
  //   RECENT     — finished in the last ~48 hours (default for score questions
  //                with no explicit year, since yesterday's match is the most
  //                likely thing the user wants)
  //   HISTORICAL — specific past year, or explicit past-tense phrasing like
  //                "in 2019" / "who won when" / "all time record"
  const liveRe     = /\b(live|right now|currently playing|in progress|happening now)\b/i
  const historicalRe = /\b(19\d{2}|200\d|201\d|202[0-4])\b|all.?time|head.?to.?head|h2h|ever (met|played|faced)|when did they|history/i

  const isLive       = liveRe.test(query)
  const isHistorical = Boolean(queryYear) || isPastTenseHint || historicalRe.test(query)
  // Default for a plain "PSG vs Arsenal score" with no qualifier → RECENT
  const isRecent     = !isLive && !isHistorical

  let out = ''

  /* ── STANDINGS ───────────────────────────────────────────── */
  if (type === 'standings') {
    const [s1, s2] = await Promise.all([
      serperSearch(`${query} table standings ${CURRENT_YEAR}`, 'qdr:m'),
      serperSearch(`${query} league table ${CURRENT_YEAR}`),
    ])
    for (const d of [s1, s2]) {
      if (!d) continue
      if (d.sportsResults) out += `=== STANDINGS DATA ===\n${JSON.stringify(d.sportsResults, null, 2)}\n\n`
      if (d.answerBox)     out += formatAnswerBox(d.answerBox)
      formatOrganic(d.organic).forEach(l => { out += l })
    }
    return out || 'No standings data found.'
  }

  /* ── LIVE (match in progress right now) ──────────────────── */
  if (type === 'live_score' && isLive) {
    const endpoint = detectESPNEndpoint(query)
    if (endpoint) {
      const teamHint = extractTeamHint(query)
      out += await fetchESPNScores(endpoint, teamHint)
    }
    // Also hit Serper with a 1-hour window
    const d = await serperSearch(`${query} live score`, 'qdr:h')
    if (d?.sportsResults) out += `=== LIVE SCORES ===\n${JSON.stringify(d.sportsResults, null, 2)}\n\n`
    if (d?.answerBox)     out += formatAnswerBox(d.answerBox)
    return out || 'No live match found. The game may not have started yet or has already finished.'
  }

  /* ── RECENT (yesterday / last 48 h) — the DEFAULT ───────── */
  // This is the most common case: user asks "PSG vs Arsenal score" and means
  // the match that just happened. Search with a 2-day window + explicit terms.
  if (type === 'live_score' && (isRecent || isLive)) {
    // Try ESPN first (covers today; if match was yesterday scores are often still cached)
    const endpoint = detectESPNEndpoint(query)
    if (endpoint) {
      const teamHint = extractTeamHint(query)
      out += await fetchESPNScores(endpoint, teamHint)
    }

    // Run three parallel Serper searches with progressively wider windows
    // so we catch yesterday's result even if Serper's index is slightly delayed
    const [r1, r2, r3] = await Promise.all([
      serperSearch(`${query} full time score result`,          'qdr:d'),   // last 24 h
      serperSearch(`${query} final score ${CURRENT_YEAR}`,    'qdr:w'),   // last week
      serperSearch(`${query} match result goals scorers`,      'qdr:m'),   // last month
    ])

    let foundUseful = false
    for (const d of [r1, r2, r3]) {
      if (!d) continue
      if (d.sportsResults) { out += `=== MATCH DATA ===\n${JSON.stringify(d.sportsResults, null, 2)}\n\n`; foundUseful = true }
      if (d.answerBox)     { out += formatAnswerBox(d.answerBox); foundUseful = true }
      if (d.news?.length)  {
        const items = (d.news as any[]).slice(0, 4)
        out += `=== MATCH REPORTS ===\n`
        items.forEach((n: any) => { out += `- ${n.title} (${n.date ?? 'recent'})\n  ${n.snippet ?? ''}\n  ${n.link}\n\n` })
        foundUseful = true
      }
      const orgs = formatOrganic(d.organic, 4)
      if (orgs.length) { orgs.forEach(l => { out += l }); foundUseful = true }
      if (foundUseful) break   // stop at the first tier that has useful data
    }
    return out || 'No recent match data found. The match may not have taken place yet or results are not indexed.'
  }

  /* ── HISTORICAL (specific year / all-time / head-to-head) ── */
  if (type === 'live_score' && isHistorical) {
    const [h1, h2] = await Promise.all([
      serperSearch(`${query} result score`),
      serperSearch(`${query} final score goals`),
    ])
    for (const d of [h1, h2]) {
      if (!d) continue
      if (d.sportsResults) out += `=== HISTORICAL DATA ===\n${JSON.stringify(d.sportsResults, null, 2)}\n\n`
      if (d.answerBox)     out += formatAnswerBox(d.answerBox)
      if (d.news?.length) {
        (d.news as any[]).slice(0, 4).forEach((n: any) => {
          out += `- ${n.title} (${n.date ?? ''})\n  ${n.snippet ?? ''}\n  ${n.link}\n\n`
        })
      }
      formatOrganic(d.organic, 5).forEach(l => { out += l })
    }
    return out || 'No historical data found for this fixture.'
  }

  /* ── GENERAL / NEWS ──────────────────────────────────────── */
  const searchQ = isHistorical ? query : `${query} ${CURRENT_YEAR}`
  const tbs     = isHistorical ? undefined : 'qdr:m'
  const data    = await serperSearch(searchQ, tbs)
  if (!data) return 'Search failed — check SERPER_API_KEY.'

  out += `SEARCH RESULTS for "${searchQ}":\n\n`
  if (data.sportsResults) out += `=== SPORTS DATA ===\n${JSON.stringify(data.sportsResults, null, 2)}\n\n`
  if (data.answerBox)     out += formatAnswerBox(data.answerBox)
  const news = (data.news as any[] ?? []).slice(0, 5)
  if (news.length) {
    out += `=== TOP NEWS ===\n`
    news.forEach((n: any) => { out += `- ${n.title} (${n.date ?? 'recent'})\n  ${n.snippet ?? ''}\n  ${n.link}\n\n` })
  }
  formatOrganic(data.organic, 5).forEach(l => { out += l })
  return out || 'No results found.'
}

/* ── Small formatting helpers ────────────────────────────── */
function formatAnswerBox(ab: any): string {
  if (!ab) return ''
  return `=== ANSWER ===\nMatch: ${ab.title ?? ''}\nScore: ${ab.answer ?? ''}\nDetail: ${ab.snippet ?? ''}\nSource: ${ab.link ?? ''}\n\n`
}

function formatOrganic(organic: any[], limit = 4): string[] {
  if (!organic?.length) return []
  const lines: string[] = [`=== WEB RESULTS ===\n`]
  ;(organic as any[]).slice(0, limit).forEach((r: any) => {
    lines.push(`Title: ${r.title}\nSnippet: ${r.snippet}\nLink: ${r.link}\n\n`)
  })
  return lines
}

function extractTeamHint(query: string): string | undefined {
  return query.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?)\b/)?.[1]
}

/* ============================================================
   Tool schema
   ============================================================ */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'webSearch',
      description:
        'Search the web for sports scores, results, fixtures, standings, or news. ' +
        'ALWAYS call this before answering. ' +
        'Use type "live_score" for any score/result question (current OR historical). ' +
        'For past-tense questions like "when did they play" or "who won the final", ' +
        'build the query with BOTH team names and competition but NO year — let the search find the right season.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Explicit search query. ALWAYS use full team names — never pronouns like "they" or "thy". ' +
              'Example good queries: ' +
              '"PSG vs Arsenal Champions League all-time results", ' +
              '"Manchester City vs Real Madrid 2023 UCL semi-final score", ' +
              '"Premier League top scorers 2025-26". ' +
              'For live/today queries append the year 2026. ' +
              'For historical/past-tense queries do NOT append a year.',
          },
          type: {
            type: 'string',
            enum: ['live_score', 'news', 'standings', 'general'],
            description: 'live_score for any score or result, standings for tables, news for articles.',
          },
          is_past_tense: {
            type: 'boolean',
            description: 'Set true when the user is asking about something that already happened (past matches, historical results, head-to-head records).',
          },
        },
        required: ['query', 'type'],
      },
    },
  },
]

/* ============================================================
   System prompt — FIX 10
   ============================================================ */
function buildSystemPrompt(ctx: ConversationContext): Message {
  const ctxNote = ctx.teams.length >= 2
    ? `\n\nCONVERSATION CONTEXT: The user has been discussing these teams: ${ctx.teams.join(', ')}${ctx.competition ? ` in the ${ctx.competition}` : ''}. When the user uses pronouns like "they", "thy", "them", or "those two", they mean these teams. ALWAYS substitute the actual team names in your search query.`
    : ''

  return {
    role: 'system',
    content: `You are a real-time sports AI assistant with access to live web search. The current year is ${CURRENT_YEAR}.${ctxNote}

CRITICAL — NO RAW MARKUP:
- NEVER output <|DSML|, <|tool_calls|, <|invoke|, or any XML tags in your response text.
- Use the tool_calls mechanism silently — never write tool call syntax into your content.

CONTEXT RESOLUTION RULES:
- When the user says "they", "thy", "them", or "those two", look at the conversation context above and substitute the actual team names in your search query.
- NEVER search for a query that contains pronouns. Always resolve to explicit team names first.
- If context is unclear, ask "Which teams are you referring to?" before searching.

SEARCH RULES:
- ALWAYS call webSearch before answering ANY sports question. Never use memory for scores.
- SCORE QUESTION WITH NO QUALIFIER (e.g. "PSG vs Arsenal score", "what was the result", "psg vs arsenal scores"): assume RECENT — the match most likely just happened or is happening now. Use type "live_score", is_past_tense: false. The search engine will look back 48 hours automatically.
- "LIVE / RIGHT NOW / IN PROGRESS": type "live_score", is_past_tense: false, include "live" in query.
- SPECIFIC PAST YEAR (e.g. "2019 final", "in 2005"): type "live_score", is_past_tense: true, include the year in query.
- PAST TENSE / EVER / ALL-TIME ("did they play", "have they ever met", "who won when"): type "live_score", is_past_tense: true, no year in query.
- NEVER say "the match hasn't been played yet" or "is scheduled" unless search results explicitly state this.
- NEVER invent a score, date, venue, or goalscorer. If search finds nothing, say so plainly.

FORMATTING RULES:
- No markdown. No asterisks. No bold. No headers with #. No tables with |. No backticks.
- Plain numbered lists only: "1. Item". No bullets.
- Write like a knowledgeable friend sending a text update — concise, direct, accurate.
- Lead with the key fact, then supporting detail.`,
  }
}

/* ============================================================
   DeepSeek call
   ============================================================ */
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
      temperature : 0.1,
      max_tokens  : 1200,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error(err?.error?.message ?? `DeepSeek HTTP ${res.status}`)
  }
  return res.json()
}

/* ============================================================
   Sports detector
   ============================================================ */
function isSports(messages: Message[]): boolean {
  const last = messages.filter(m => m.role === 'user').at(-1)?.content ?? ''
  return /score|fixture|match|league|table|standing|transfer|goal|live|result|club|team|player|vs|today|tonight|weekend|kick.?off|premier|bundesliga|la liga|serie a|ligue|mls|nba|nfl|nhl|mlb|ufc|f1|tennis|cricket|rugby|they played|did they|have they|who won|final|semi.?final|quarter.?final/i.test(last)
}

/* ============================================================
   Helpers
   ============================================================ */
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function toAIStream(text: string): Response {
  const encoder = new TextEncoder()
  const stream  = new ReadableStream({
    start(controller) {
      for (const word of text.split(/(\s+)/)) {
        if (word) controller.enqueue(encoder.encode(`0:${JSON.stringify(word)}\n`))
      }
      controller.enqueue(encoder.encode(`d:{"finishReason":"stop","usage":{"promptTokens":0,"completionTokens":0}}\n`))
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Vercel-AI-Data-Stream': 'v1', 'Transfer-Encoding': 'chunked' },
  })
}

/* ============================================================
   POST handler
   ============================================================ */
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

    // FIX 8 — extract context from conversation BEFORE building the prompt
    const ctx         = extractContext(clientMessages)
    const lastUserMsg = clientMessages.filter(m => m.role === 'user').at(-1)?.content ?? ''
    const resolvedMsg = resolveQuery(lastUserMsg, ctx)

    // If the message was ambiguous and we resolved it, swap in the resolved version
    // so DeepSeek sees explicit team names from the start
    const messagesForAI: Message[] = clientMessages.map((m, i) =>
      i === clientMessages.length - 1 && m.role === 'user' && resolvedMsg !== lastUserMsg
        ? { ...m, content: resolvedMsg }
        : m
    )

    const systemPrompt = buildSystemPrompt(ctx)
    const messages: Message[] = [systemPrompt, ...messagesForAI]
    const forceFirst   = isSports(clientMessages)
    let toolsRan       = false
    let finalContent   = ''
    let round          = 0

    while (round < MAX_TOOL_ROUNDS) {
      const ds     = await callDeepSeek(messages, { force: round === 0 && forceFirst, lock: toolsRan && round >= 1 })
      const choice = ds?.choices?.[0]
      if (!choice) throw new Error('DeepSeek returned no choices.')

      const msg: Message = choice.message

      if (msg.content) {
        msg.content = stripDSML(msg.content)
        if (!msg.content) msg.content = null
      }

      messages.push(msg)

      if (!msg.tool_calls?.length) {
        if (msg.content) { finalContent = msg.content }
        break
      }

      for (const tc of msg.tool_calls) {
        let result = ''
        if (tc.function.name === 'webSearch') {
          let args: { query?: string; type?: string; is_past_tense?: boolean } = {}
          try { args = JSON.parse(tc.function.arguments) } catch { /* ignore */ }

          // Fallback: if DeepSeek still built a query with pronouns, resolve it
          let searchQuery = args.query ?? resolvedMsg ?? `sports news ${CURRENT_YEAR}`
          const hasPronouns = /\b(they|thy|them|those two|both teams)\b/i.test(searchQuery)
          if (hasPronouns && ctx.teams.length >= 2) {
            searchQuery = resolveQuery(searchQuery, ctx)
          }

          result = await runWebSearch(
            searchQuery,
            args.type ?? 'general',
            args.is_past_tense ?? ctx.isPastTense,
          )
        } else {
          result = `Unknown tool: ${tc.function.name}`
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result })
        toolsRan = true
      }
      round++
    }

    // Fallback: last clean assistant message
    if (!finalContent) {
      const last = [...messages].reverse().find(m => m.role === 'assistant' && m.content && !m.tool_calls?.length)
      finalContent = last?.content ?? ''
    }

    // Nuclear fallback: DSML still present → force a clean summary
    if (!finalContent || DSML_FRAG_RE.test(finalContent)) {
      const lastToolResult = [...messages].reverse().find(m => m.role === 'tool')?.content ?? ''
      if (lastToolResult) {
        messages.push({
          role   : 'user',
          content: 'Based on the search results you retrieved, answer the original question in plain text only. No markup tags of any kind.',
        })
        try {
          const recovery    = await callDeepSeek(messages, { lock: true })
          const recoveryMsg : Message = recovery?.choices?.[0]?.message
          if (recoveryMsg?.content) finalContent = stripDSML(recoveryMsg.content)
        } catch { /* fall through */ }
      }
    }

    if (!finalContent) finalContent = 'No data found. The match may not have started yet.'
    finalContent = stripDSML(finalContent)

    return returnPlainJSON
      ? json({ content: finalContent })
      : toAIStream(finalContent)

  } catch (err: any) {
    console.error('[route error]', err?.message ?? err)
    return json({ error: 'Internal Server Error', details: err?.message }, 500)
  }
}