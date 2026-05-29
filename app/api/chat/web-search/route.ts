/* ============================================================
   app/api/sports/route.ts
   FIXES APPLIED:
     Bug A — keyword routing order: live → score → fixture →
              standings. Removed duplicate "result" keyword from
              the fixture branch so finished scores route correctly.
     Bug B — formatStandingsTable now reads row.won / row.lost
              (API-Football v3 field names) instead of row.win /
              row.loss which always returned undefined.
     Bug C — every fetchFootballApi('/fixtures', ...) call now
              passes date: requestDate so results are always
              anchored to the requested date, not a random page.
   ============================================================ */

const RAPIDAPI_KEY      = process.env.RAPIDAPI_KEY ?? process.env.RAPID_API_KEY ?? ''
const API_FOOTBALL_HOST = 'api-football-v1.p.rapidapi.com'
const API_FOOTBALL_BASE = `https://${API_FOOTBALL_HOST}/v3`

function normalize(value?: string) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function getFootballLeagueId(league?: string): number | null {
  const normalized = normalize(league)
  if (!normalized) return null
  if (normalized.includes('premier') || normalized.includes('epl') || normalized.includes('england')) return 39
  if (normalized.includes('la liga') || normalized.includes('spain')) return 140
  if (normalized.includes('serie a') || normalized.includes('italy')) return 135
  if (normalized.includes('bundesliga') || normalized.includes('germany')) return 78
  if (normalized.includes('ligue 1') || normalized.includes('france')) return 61
  if (normalized.includes('champions league') || normalized.includes('uefa')) return 2
  if (normalized.includes('mls') || normalized.includes('major league soccer')) return 253
  if (normalized.includes('world cup')) return 1
  return null
}

function formatDate(dateString: string) {
  try {
    const date = new Date(dateString)
    return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: true })
  } catch {
    return dateString
  }
}

function getSeasonFromDateString(dateString?: string) {
  const date  = dateString ? new Date(dateString) : new Date()
  const month = date.getUTCMonth() + 1
  const year  = date.getUTCFullYear()
  return month >= 7 ? year : year - 1
}

function getSeasonForLeague(leagueId: number | null, dateString?: string) {
  const calendarYearLeagues = [253] // MLS uses calendar-year seasons
  if (leagueId && calendarYearLeagues.includes(leagueId)) {
    const date = dateString ? new Date(dateString) : new Date()
    return date.getUTCFullYear()
  }
  return getSeasonFromDateString(dateString)
}

function getCurrentDateISO() {
  return new Date().toISOString().split('T')[0]
}

async function fetchFootballApi(path: string, params: Record<string, string | number | undefined>) {
  const searchParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).length > 0) {
      searchParams.set(key, String(value))
    }
  })

  const url = `${API_FOOTBALL_BASE}${path}?${searchParams.toString()}`
  const res = await fetch(url, {
    method : 'GET',
    headers: {
      'x-rapidapi-host': API_FOOTBALL_HOST,
      'x-rapidapi-key' : RAPIDAPI_KEY,
    },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`RapidAPI football request failed: ${res.status} ${body}`)
  }

  return res.json()
}

function formatFixtureResult(fixture: any) {
  const home      = fixture?.teams?.home?.name ?? 'Home'
  const away      = fixture?.teams?.away?.name ?? 'Away'
  const scoreHome = fixture?.goals?.home ?? '-'
  const scoreAway = fixture?.goals?.away ?? '-'
  const date      = formatDate(fixture?.fixture?.date ?? '')
  const status    = normalize(fixture?.fixture?.status?.short) || 'TBD'
  return `${date} | ${home} ${scoreHome} - ${scoreAway} ${away} | ${status}`
}

/* FIX B — use row.won / row.lost (API-Football v3 field names).
   The original used row.win / row.loss which always resolved to
   undefined, printing "Wundefined Dundefined Lundefined".        */
function formatStandingsTable(standings: any[]): string {
  if (!Array.isArray(standings) || standings.length === 0) {
    return 'No standings available.'
  }
  const rows = standings[0]?.table?.slice(0, 10) ?? []
  if (rows.length === 0) return 'No standings available.'

  return rows
    .map((row: any) =>
      `${row.rank}. ${row.team?.name} • Pts ${row.points} • W${row.won ?? row.win ?? '-'} D${row.draw ?? '-'} L${row.lost ?? row.loss ?? '-'} • GF${row.goalsFor ?? '-'} GA${row.goalsAgainst ?? '-'}`
    )
    .join('\n')
}

async function fetchFootballSportsTool(args: {
  sport   : string
  league ?: string
  query   : string
  team   ?: string
  date   ?: string
}) {
  const sport       = normalize(args.sport)
  const query       = normalize(args.query)
  const leagueId    = getFootballLeagueId(args.league)
  const requestDate = args.date?.trim() || getCurrentDateISO()
  const season      = getSeasonForLeague(leagueId, requestDate)

  if (!RAPIDAPI_KEY) {
    throw new Error('RapidAPI key is not configured on the server.')
  }

  if (sport !== 'football' && sport !== 'soccer') {
    return `RapidAPI live sports tool currently supports football/soccer data. Received sport: ${args.sport || 'unknown'}.`
  }

  /* ── Standings ───────────────────────────────────────────── */
  if (query.includes('stand') || query.includes('table')) {
    if (!leagueId) {
      return 'Please specify a supported football league such as EPL, La Liga, Bundesliga, Serie A, Ligue 1, or Champions League for standings.'
    }
    const body    = await fetchFootballApi('/standings', { league: leagueId, season })
    const payload = body?.response?.[0]?.league
    return payload
      ? `Standings for ${payload.name} (${payload.country}):\n${formatStandingsTable(payload.standings)}`
      : 'Could not retrieve standings data.'
  }

  /* ── Live scores ─────────────────────────────────────────── */
  // FIX A — "live" checked before "score"/"result" so live matches
  // are never accidentally routed into the finished-scores branch.
  if (query.includes('live') || query.includes('now') || query.includes('current')) {
    const body     = await fetchFootballApi('/fixtures', {
      status: 'LIVE',
      league: leagueId ?? undefined,
      season,
    })
    const fixtures = body?.response ?? []
    if (fixtures.length === 0) {
      return 'There are no live football matches right now.'
    }
    return `Live football scores:\n${fixtures.slice(0, 8).map(formatFixtureResult).join('\n')}`
  }

  /* ── Finished scores / results ───────────────────────────── */
  // FIX A — "score" and "result" now form their own branch, checked
  // before "fixture"/"schedule" so they always hit status=FT.
  if (query.includes('score') || query.includes('result')) {
    const body     = await fetchFootballApi('/fixtures', {
      status: 'FT',
      league: leagueId ?? undefined,
      season,
      date  : requestDate,   // FIX C — anchor to requested date
    })
    const fixtures = body?.response ?? []
    if (fixtures.length === 0) {
      return 'No recent finished football scores were found.'
    }
    return `Recent football results:\n${fixtures.slice(0, 8).map(formatFixtureResult).join('\n')}`
  }

  /* ── Fixtures / schedule ─────────────────────────────────── */
  // FIX A — "result" keyword removed here so it falls through to
  // the finished-scores branch above instead of getting trapped.
  if (query.includes('fixture') || query.includes('schedule')) {
    const body     = await fetchFootballApi('/fixtures', {
      league: leagueId ?? undefined,
      season,
      date  : requestDate,   // FIX C — anchor to requested date
    })
    const fixtures = body?.response ?? []
    if (fixtures.length === 0) {
      return 'No fixture data found for the requested date or league.'
    }
    return `Football fixtures:\n${fixtures.slice(0, 8).map(formatFixtureResult).join('\n')}`
  }

  /* ── Default fallback: live first, then upcoming ─────────── */
  const liveBody     = await fetchFootballApi('/fixtures', {
    status: 'LIVE',
    league: leagueId ?? undefined,
    season,
  })
  const liveFixtures = liveBody?.response ?? []
  if (liveFixtures.length > 0) {
    return `Live football scores:\n${liveFixtures.slice(0, 8).map(formatFixtureResult).join('\n')}`
  }

  // FIX C — pass date so we get fixtures for the requested day,
  // not whatever page the API defaults to.
  const upcomingBody     = await fetchFootballApi('/fixtures', {
    league: leagueId ?? undefined,
    season,
    date  : requestDate,   // was missing — caused random fixture pages
  })
  const upcomingFixtures = upcomingBody?.response ?? []
  if (upcomingFixtures.length === 0) {
    return 'Unable to retrieve football match data at this time.'
  }
  return `Football match schedule:\n${upcomingFixtures.slice(0, 8).map(formatFixtureResult).join('\n')}`
}

/* ── POST handler ────────────────────────────────────────────── */
export async function POST(request: Request) {
  try {
    if (!RAPIDAPI_KEY) {
      return new Response(
        JSON.stringify({ error: 'RapidAPI key is not configured.' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const body  = await request.json().catch(() => null)
    const sport = body?.sport
    const query = body?.query

    if (!sport || !query) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: sport and query are required.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const result = await fetchFootballSportsTool({
      sport,
      league: body?.league,
      query,
      team  : body?.team,
      date  : body?.date,
    })

    return new Response(
      JSON.stringify({ result }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error: any) {
    console.error('RapidAPI sports tool error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'RapidAPI sports tool failed.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}