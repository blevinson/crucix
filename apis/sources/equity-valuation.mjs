// Equity Valuation — sector-relative cheap/rich tags for the candidate universe.
//
// P3 valuation gate. crucix grounds ideas on flow + technicals but had ZERO
// valuation input, so the scorer couldn't tell cheap from expensive and P4's
// distribution-short couldn't confirm "rich". This source closes that gap:
// it fetches trailing multiples for the ~10-40 SHORTLISTED candidate names
// (movers + sector leaders/laggards, the same set technicals uses) and tags
// each one CHEAP_VS_PEERS / RICH_VS_PEERS / FAIR / UNKNOWN by where it ranks
// within its SECTOR peers on the multiples it actually has.
//
// HONEST FRAMING (load-bearing):
//   - Valuation is a GATE / CONFIRM, not a standalone winner-picker. A cheap
//     name is not a buy; a cheap name that is ALSO breaking out is a higher-
//     conviction long. Same on the short side.
//   - The percentile is WITHIN-SHORTLIST, SECTOR-RELATIVE — a relative read of
//     the day's movers, NOT an absolute market-wide fair-value claim.
//   - Trailing multiples on micro-caps are noisy and OFTEN ABSENT (a loss-making
//     name has no trailing P/E; an unprofitable name's forward P/E and EV/EBITDA
//     come back NEGATIVE and meaningless). We NEVER fabricate a multiple and
//     NEVER let a negative multiple read as "cheap". Such names are tagged
//     UNKNOWN and surfaced explicitly so the LLM sees the gap rather than
//     inventing a number.
//
// DATA PATH (deterministic, NON-FMP, no API key) — verified live from inside
// the cluster 2026-06-15. Yahoo locked down quoteSummary/quote behind a crumb;
// the v8 chart endpoint yfinance.mjs uses is the only crumb-free one, so this is
// a NEW source, not a tweak to yfinance.mjs. Three steps, crumb reused for the
// whole sweep:
//   1. GET https://fc.yahoo.com            -> 404, but Set-Cookie populates the
//      cookie jar (the 404 is expected; we only need the cookie).
//   2. GET .../v1/test/getcrumb            -> plaintext ~11-char crumb.
//   3. GET .../v10/finance/quoteSummary/{SYM}?modules=summaryDetail,
//      defaultKeyStatistics,price&crumb={crumb}  with the same Cookie header.
// safeFetch can't do this (it JSON-parses and never exposes Set-Cookie), so we
// use a thin native-fetch helper here.
//
// Fields (all .raw under the module):
//   summaryDetail.trailingPE / .forwardPE / .priceToSalesTrailing12Months / .marketCap
//   defaultKeyStatistics.enterpriseToEbitda / .priceToBook
//   price.quoteType ('EQUITY' vs 'ETF') for a deterministic ETF skip
// Yahoo does NOT return sector here — peer group comes from the movers rows.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Failover quoteSummary hosts. query2 works when query1 rate-limits.
const QS_HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];

const HANDSHAKE_TIMEOUT_MS = 8000;
const SYMBOL_TIMEOUT_MS = 8000;
const MAX_CANDIDATES = 25;      // bound Yahoo calls per sweep
const MIN_PEERS = 4;            // need >=4 valid sector peers to percentile a metric
const MIN_MULTIPLES = 2;        // need >=2 of {PE,PS,EV/EBITDA} present to rank a name
const CHEAP_PCTILE = 25;        // aggregate sector percentile <= 25 => CHEAP_VS_PEERS
const RICH_PCTILE = 75;         // aggregate sector percentile >= 75 => RICH_VS_PEERS

// Metrics we percentile-rank on. Lower multiple = cheaper = lower percentile.
// All must be POSITIVE to count — a negative trailing P/E or EV/EBITDA is not
// "cheap", it's loss-making; we drop <=0 before ranking. (The single most
// important correctness rule in this file.)
const RANK_METRICS = ['pe', 'ps', 'evEbitda', 'pb'];
// Subset used for the >=MIN_MULTIPLES "is this name rankable at all" gate. P/B
// is a bonus signal but a name with only P/B is too thin to call cheap/rich.
const CORE_METRICS = ['pe', 'ps', 'evEbitda'];

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

// ─── Thin native-fetch helper (Set-Cookie / plaintext aware) ──────────────────

async function rawGet(url, { cookie = '', timeout = SYMBOL_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = { 'User-Agent': UA };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(url, { signal: controller.signal, headers });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// One-time crumb+cookie handshake. Returns { cookie, crumb } or null on failure
// (the whole source then degrades to empty — strictly additive, never throws).
async function getCrumb() {
  try {
    // Step 1 — fc.yahoo.com returns 404 but sets the A3 cookie. We do NOT gate
    // on res.ok here; the 404 is expected and the cookie is all we need.
    const r1 = await rawGet('https://fc.yahoo.com', { timeout: HANDSHAKE_TIMEOUT_MS });
    const setCookies = typeof r1.headers.getSetCookie === 'function'
      ? r1.headers.getSetCookie()
      : (r1.headers.get('set-cookie') ? [r1.headers.get('set-cookie')] : []);
    // Keep only name=value (drop attributes like Path/Expires/Max-Age).
    const cookie = setCookies
      .map((c) => String(c).split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
    if (!cookie) return null;

    // Step 2 — crumb is the raw response text (~11 chars), NOT JSON.
    const r2res = await rawGet(`${QS_HOSTS[0]}/v1/test/getcrumb`, { cookie, timeout: HANDSHAKE_TIMEOUT_MS });
    if (!r2res.ok) return null;
    const crumb = (await r2res.text()).trim();
    // A valid crumb is short and has no whitespace / HTML. Reject error pages.
    if (!crumb || crumb.length > 40 || /[<>\s]/.test(crumb)) return null;
    return { cookie, crumb };
  } catch {
    return null;
  }
}

// Per-symbol quoteSummary fetch. Failure-tolerant: returns null on any
// fetch/parse/auth failure for that symbol (never throws). Tries query2 as a
// failover host before giving up.
async function fetchValuation(symbol, { cookie, crumb }) {
  const modules = 'summaryDetail,defaultKeyStatistics,price';
  for (const host of QS_HOSTS) {
    try {
      const url = `${host}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
        `?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
      const res = await rawGet(url, { cookie });
      if (!res.ok) continue; // try failover host
      let j;
      try { j = await res.json(); } catch { continue; }
      const result = j?.quoteSummary?.result?.[0];
      if (!result) continue;
      const sd = result.summaryDetail || {};
      const dk = result.defaultKeyStatistics || {};
      const pr = result.price || {};
      const raw = (d, k) => {
        const v = d?.[k];
        const n = (v && typeof v === 'object') ? v.raw : v;
        return (n != null && Number.isFinite(n)) ? n : null;
      };
      return {
        symbol,
        quoteType: pr.quoteType || null,
        pe: raw(sd, 'trailingPE'),
        forwardPe: raw(sd, 'forwardPE'),
        ps: raw(sd, 'priceToSalesTrailing12Months'),
        evEbitda: raw(dk, 'enterpriseToEbitda'),
        pb: raw(dk, 'priceToBook'),
        marketCap: raw(sd, 'marketCap'),
      };
    } catch {
      // try next host
    }
  }
  return null;
}

// ─── Candidate universe + sector attribution ──────────────────────────────────

// Normalize whatever ctx hands us into { symbols:[], sectorBySymbol:{} }.
// Accepts:
//   ctx.candidates       — array of strings OR {symbol[,sector]} objects
//   ctx.movers/leaders/laggards — arrays of {symbol, sector} rows
//   ctx.sectorBySymbol   — explicit {SYM: sector} map (highest priority)
// Sector rides along from the movers rows; we never re-query ticker_metadata.
function buildUniverse(ctx = {}) {
  const symbols = new Set();
  const sectorBySymbol = {};
  const add = (item) => {
    if (!item) return;
    const sym = (typeof item === 'string' ? item : item.symbol);
    if (!sym || typeof sym !== 'string') return;
    const up = sym.toUpperCase();
    symbols.add(up);
    if (typeof item === 'object' && item.sector && !sectorBySymbol[up]) {
      sectorBySymbol[up] = item.sector;
    }
  };
  for (const list of [ctx.candidates, ctx.movers, ctx.leaders, ctx.laggards]) {
    if (Array.isArray(list)) list.forEach(add);
  }
  // Explicit map wins / fills gaps.
  if (ctx.sectorBySymbol && typeof ctx.sectorBySymbol === 'object') {
    for (const [k, v] of Object.entries(ctx.sectorBySymbol)) {
      if (k && v) sectorBySymbol[String(k).toUpperCase()] = v;
    }
  }
  return { symbols: [...symbols].slice(0, MAX_CANDIDATES), sectorBySymbol };
}

// ─── Percentile / tagging math (pure, deterministic) ──────────────────────────

// Percentile rank of `value` among `peers` (lower value => lower percentile).
// Fraction of peers strictly below + half the ties, ×100. peers includes value.
function percentileRank(value, peers) {
  const valid = peers.filter((v) => v != null && Number.isFinite(v) && v > 0);
  if (valid.length < MIN_PEERS) return null;
  let below = 0;
  let equal = 0;
  for (const v of valid) {
    if (v < value) below += 1;
    else if (v === value) equal += 1;
  }
  return Math.round(((below + 0.5 * equal) / valid.length) * 1000) / 10;
}

function median(arr) {
  const v = arr.filter((x) => x != null && Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Count of {pe,ps,evEbitda} present-and-positive for a name.
function corePositiveCount(row) {
  return CORE_METRICS.reduce((n, m) => n + ((row[m] != null && row[m] > 0) ? 1 : 0), 0);
}

// ─── collect ──────────────────────────────────────────────────────────────────

export async function collect(ctx = {}) {
  const { symbols, sectorBySymbol } = buildUniverse(ctx);
  if (!symbols.length) {
    return {
      summary: 'no candidates supplied',
      cheap: [], rich: [], fair: [], unknown: [],
      method: VAL_METHOD,
    };
  }

  // One handshake per sweep, reused across every symbol.
  const auth = await getCrumb();
  if (!auth) {
    // Degrade cleanly: no valuation block this sweep. P4 falls back to
    // TECH_BREAKDOWNS-only (today's behavior); compactSweepForLLM omits the
    // cheap/rich blocks; the scorer simply finds no valuation facts.
    return {
      summary: 'valuation unavailable (Yahoo crumb handshake failed) — degraded to no-op',
      error: 'crumb_handshake_failed',
      cheap: [], rich: [], fair: [], unknown: [],
      method: VAL_METHOD,
    };
  }

  // Fetch all candidates in parallel — failure-tolerant per symbol.
  const settled = await Promise.allSettled(
    symbols.map((sym) => fetchValuation(sym, auth)),
  );

  // Build per-symbol rows. A null fetch, an ETF, or a name with <MIN_MULTIPLES
  // positive core multiples is recorded but cannot be ranked.
  const rows = [];
  let attempted = 0;
  let fetched = 0;
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    attempted += 1;
    const v = settled[i].status === 'fulfilled' ? settled[i].value : null;
    const sector = sectorBySymbol[sym] || null;
    if (!v) {
      rows.push({ symbol: sym, sector, rankable: false, reason: 'no-data', present: 0 });
      continue;
    }
    fetched += 1;
    if (v.quoteType === 'ETF') {
      rows.push({ symbol: sym, sector, rankable: false, reason: 'etf', present: 0, marketCap: v.marketCap });
      continue;
    }
    const present = corePositiveCount(v);
    rows.push({
      symbol: sym,
      sector,
      pe: (v.pe != null && v.pe > 0) ? v.pe : null,
      forwardPe: v.forwardPe,
      ps: (v.ps != null && v.ps > 0) ? v.ps : null,
      evEbitda: (v.evEbitda != null && v.evEbitda > 0) ? v.evEbitda : null,
      pb: (v.pb != null && v.pb > 0) ? v.pb : null,
      marketCap: v.marketCap,
      present,
      rankable: !!sector && present >= MIN_MULTIPLES,
      reason: !sector ? 'no-sector' : (present < MIN_MULTIPLES ? 'insufficient-multiples' : null),
    });
  }

  // Group rankable rows by sector for per-metric percentile.
  const bySector = new Map();
  for (const row of rows) {
    if (!row.rankable) continue;
    if (!bySector.has(row.sector)) bySector.set(row.sector, []);
    bySector.get(row.sector).push(row);
  }

  // Per-sector medians (for verifiable "vs sector-median" claims downstream).
  const sectorMedians = new Map();
  for (const [sector, peers] of bySector.entries()) {
    const med = {};
    for (const m of RANK_METRICS) med[m] = r2(median(peers.map((p) => p[m])));
    sectorMedians.set(sector, med);
  }

  const cheap = [];
  const rich = [];
  const fair = [];
  const unknown = [];

  for (const row of rows) {
    if (!row.rankable) {
      // Surface UNKNOWN with whatever raw multiples exist so the LLM sees data
      // without a fabricated cheap/rich verdict — but it is NEVER cheap/rich.
      unknown.push({
        symbol: row.symbol,
        sector: row.sector,
        pe: r2(row.pe ?? null),
        ps: r2(row.ps ?? null),
        evEbitda: r2(row.evEbitda ?? null),
        reason: row.reason || 'unknown',
      });
      continue;
    }
    const peers = bySector.get(row.sector) || [];
    const med = sectorMedians.get(row.sector) || {};
    // Per-metric percentile, only over metrics this name actually has.
    const perMetric = [];
    const metricLines = {};
    for (const m of RANK_METRICS) {
      const val = row[m];
      if (val == null || !(val > 0)) continue;
      const pct = percentileRank(val, peers.map((p) => p[m]));
      if (pct == null) continue; // bucket too thin on THIS metric
      perMetric.push(pct);
      metricLines[m] = { value: r2(val), sectorMedian: med[m] ?? null, pctile: pct };
    }
    if (!perMetric.length) {
      // Sector bucket too thin to rank on any of this name's metrics.
      unknown.push({
        symbol: row.symbol, sector: row.sector,
        pe: r2(row.pe ?? null), ps: r2(row.ps ?? null), evEbitda: r2(row.evEbitda ?? null),
        reason: 'thin-sector',
      });
      continue;
    }
    // Aggregate cheapness = median of available per-metric percentiles.
    const aggPctile = r2(median(perMetric.map((p) => p + 1e-9)) ?? null); // +eps so 0 isn't dropped by >0 filter
    const peer_n = peers.length;
    const entry = {
      symbol: row.symbol,
      sector: row.sector,
      pe: r2(row.pe ?? null),
      ps: r2(row.ps ?? null),
      evEbitda: r2(row.evEbitda ?? null),
      pb: r2(row.pb ?? null),
      sectorMedianPe: med.pe ?? null,
      sectorMedianPs: med.ps ?? null,
      sectorMedianEvEbitda: med.evEbitda ?? null,
      percentile: aggPctile,
      peer_n,
      metrics: metricLines,
    };
    if (aggPctile != null && aggPctile <= CHEAP_PCTILE) {
      entry.valuation_tag = 'CHEAP';
      cheap.push(entry);
    } else if (aggPctile != null && aggPctile >= RICH_PCTILE) {
      entry.valuation_tag = 'RICH';
      rich.push(entry);
    } else {
      entry.valuation_tag = 'FAIR';
      fair.push(entry);
    }
  }

  // Cheapest first; richest first.
  cheap.sort((a, b) => (a.percentile ?? 100) - (b.percentile ?? 100));
  rich.sort((a, b) => (b.percentile ?? 0) - (a.percentile ?? 0));

  const summary =
    `${cheap.length} cheap, ${rich.length} rich, ${fair.length} fair, ${unknown.length} unknown ` +
    `over ${fetched}/${attempted} fetched (${bySector.size} sectors with >=${MIN_PEERS} peers) — ` +
    `within-shortlist sector-relative trailing multiples`;

  return {
    summary,
    universeSize: symbols.length,
    fetched,
    cheap,
    rich,
    fair,
    unknown,
    method: VAL_METHOD,
  };
}

const VAL_METHOD =
  'Yahoo quoteSummary trailing multiples (P/E, P/S, EV/EBITDA, P/B), sector-percentile blend ' +
  'within the day\'s shortlist — NON-FMP, no API key. RELATIVE not absolute; trailing multiples ' +
  'on micro-caps are noisy. UNKNOWN when <2 of {PE,PS,EV/EBITDA} present-and-positive, no sector, ' +
  'or sector bucket has <4 valid peers. Negative multiples dropped (never read as cheap).';

export const briefing = collect;
