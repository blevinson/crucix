// Earnings calendar — deterministic near-term earnings dates for the candidate
// shortlist, so the LLM can apply the earnings-risk gate WITHOUT an agentic
// openbb tool call.
//
// P6 ops-hygiene: the old idea-gen path had the agentic loop fetch
// mcp__openbb__equity_calendar_earnings inside a multi-turn tool-use run. That
// added latency + a flaky FMP-routed dependency. This source replaces that one
// fetch with a single deterministic HTTP call to Finnhub's free earnings
// calendar, filtered client-side to the candidate set.
//
// WHY NOT THE TSDB TABLE (crucix_earnings_calendar):
//   The bridge CronJob (finnhub_earnings_ingest.py) DOES populate
//   crucix_earnings_calendar in qid_analytics, BUT — verified live 2026-06-15 —
//   that table has a near-term GAP: 2205 rows present, yet min(earnings_date)
//   = 2026-08-03 and 0 rows in the next 7d, while the LIVE Finnhub API returns
//   74 reporters in the same 7d window (CCL 2026-06-22, etc.). The table is
//   missing the forward reporters the gate actually needs. Reading it would
//   silently kill the gate every sweep. So we fetch the live calendar directly.
//   (The broken ingest window is a SEPARATE follow-up bug, filed elsewhere.)
//
// DATA PATH (deterministic, single HTTP GET, no agentic loop):
//   GET https://finnhub.io/api/v1/calendar/earnings?from=<today>&to=<today+7d>
//       &token=$FINNHUB_API_KEY
//   -> { earningsCalendar: [ { symbol, date, hour, epsEstimate, ... }, ... ] }
//   FINNHUB_API_KEY is already in the crucix container env (verified live).
//
// HONEST FRAMING:
//   - Best-effort + strictly additive (mirrors equity-valuation.mjs): any
//     fetch/parse/auth failure leaves the block null and the sweep proceeds
//     exactly as before — the earnings gate is simply skipped that sweep. We
//     never throw and never zero out the sweep on an earnings failure.
//   - The whole-market calendar is filtered to the candidate set the LLM
//     actually picks from, so the EARNINGS block stays compact.

const FINNHUB_BASE = 'https://finnhub.io/api/v1/calendar/earnings';
const FETCH_TIMEOUT_MS = 8000;
const WINDOW_DAYS = 7;            // gate horizon: report within 7d
const MAX_SYMBOLS = 60;          // bound the emitted block

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

// Normalize whatever ctx hands us into an uppercase symbol set.
// Accepts ctx.candidates as array of strings OR {symbol} objects.
function candidateSet(ctx = {}) {
  const out = new Set();
  const add = (item) => {
    if (!item) return;
    const sym = typeof item === 'string' ? item : item.symbol;
    if (!sym || typeof sym !== 'string') return;
    out.add(sym.toUpperCase());
  };
  if (Array.isArray(ctx.candidates)) ctx.candidates.forEach(add);
  return out;
}

async function rawGetJson(url, { timeout = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collect near-term earnings dates for the candidate shortlist.
 * @param {object} ctx - { candidates: [SYM | {symbol}] }
 * @returns {Promise<object>} { withinWindow:[{symbol,earnings_date,days_until,hour}], window, asof, error? }
 */
export async function collect(ctx = {}) {
  const key = process.env.FINNHUB_API_KEY;
  const window = `${WINDOW_DAYS}d`;
  if (!key) {
    return {
      summary: 'earnings unavailable (no FINNHUB_API_KEY) — gate skipped',
      error: 'no_api_key',
      withinWindow: [],
      window,
    };
  }

  const cands = candidateSet(ctx);
  if (!cands.size) {
    return { summary: 'no candidates supplied', withinWindow: [], window };
  }

  const today = new Date();
  const to = new Date(today.getTime() + WINDOW_DAYS * 864e5);
  const fromStr = ymd(today);
  const toStr = ymd(to);
  const url = `${FINNHUB_BASE}?from=${fromStr}&to=${toStr}&token=${encodeURIComponent(key)}`;

  const j = await rawGetJson(url);
  if (!j || !Array.isArray(j.earningsCalendar)) {
    // Degrade cleanly — strictly additive, never throws.
    return {
      summary: 'earnings unavailable (finnhub fetch failed) — gate skipped',
      error: 'fetch_failed',
      withinWindow: [],
      window,
    };
  }

  // Filter the whole-market calendar to candidates, dedup to the soonest date
  // per symbol, compute days_until from today (date-only).
  const todayMs = Date.parse(fromStr);
  const bySym = new Map();
  for (const row of j.earningsCalendar) {
    const sym = typeof row?.symbol === 'string' ? row.symbol.toUpperCase() : null;
    if (!sym || !cands.has(sym)) continue;
    const date = typeof row.date === 'string' ? row.date : null;
    if (!date) continue;
    const ms = Date.parse(date);
    if (!Number.isFinite(ms)) continue;
    const prev = bySym.get(sym);
    if (!prev || ms < prev.ms) {
      const days_until = Math.round((ms - todayMs) / 864e5);
      bySym.set(sym, {
        ms,
        symbol: sym,
        earnings_date: date,
        days_until,
        hour: row.hour || null, // 'bmo' | 'amc' | '' per finnhub
      });
    }
  }

  const withinWindow = [...bySym.values()]
    .sort((a, b) => a.ms - b.ms)
    .slice(0, MAX_SYMBOLS)
    .map(({ ms, ...rest }) => rest); // drop the internal ms field

  const summary = withinWindow.length
    ? `${withinWindow.length} candidate(s) reporting within ${window} (asof ${fromStr})`
    : `no candidates reporting within ${window} — clear runway (asof ${fromStr})`;

  return {
    summary,
    window,
    asof: fromStr,
    withinWindow,
  };
}

export const briefing = collect;
