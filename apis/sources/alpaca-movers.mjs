// Alpaca Movers — top gainers, losers, and most-active US equities
//
// Source: TSDB table `crucix_movers`, populated every 30min during RTH by
// the qid `alpaca-movers-ingest` cronjob. We do not call Alpaca directly —
// the cluster already pays for that data; we just enrich it with metadata.
//
// JOIN against `ticker_metadata` provides market_cap, sector, industry,
// is_etf — enough to filter out the warrant/penny/leveraged-ETF noise and
// attribute moves to industries.

import pg from 'pg';

// Filter knobs — env-driven so tuning doesn't require a rebuild.
// All values optional; defaults below are the source-loose policy
// (let the LLM see broad context; tighten the LLM PROMPT separately
// in lib/llm/ideas.mjs to constrain *recommendations*).
const _num = (v, d) => (v == null || v === '' ? d : Number(v));

const MIN_MCAP_USD          = _num(process.env.CRUCIX_MOVERS_MIN_MCAP_B,    0.3) * 1e9;
const MAX_MCAP_USD          = _num(process.env.CRUCIX_MOVERS_MAX_MCAP_B,    0)   * 1e9;     // 0 = no ceiling
const MIN_PRICE_USD         = _num(process.env.CRUCIX_MOVERS_MIN_PRICE,     5);             // SEC penny-stock threshold
const MAX_PRICE_USD         = _num(process.env.CRUCIX_MOVERS_MAX_PRICE,     0);             // 0 = no ceiling
const MIN_DAILY_DOLLAR_VOL  = _num(process.env.CRUCIX_MOVERS_MIN_DOLLAR_VOL, 20_000_000);   // ~$20M for safe entry/exit
const MAX_ABS_CHANGE_PCT    = _num(process.env.CRUCIX_MOVERS_MAX_ABS_CHANGE_PCT, 60);       // drops pump/halt moves
const PER_CATEGORY_LIMIT    = _num(process.env.CRUCIX_MOVERS_PER_CATEGORY_LIMIT, 20);
const INDUSTRY_HEAT_MIN     = _num(process.env.CRUCIX_MOVERS_INDUSTRY_HEAT_MIN, 2);

// Lazy pool — reused across calls. max=2 because crucix runs single-process.
let _pool = null;
function pool() {
  if (_pool) return _pool;
  _pool = new pg.Pool({
    host: process.env.QID_DB_HOST || 'qid-tsdb-rw.qid.svc.cluster.local',
    port: parseInt(process.env.QID_DB_PORT || '5432'),
    database: process.env.QID_DB_NAME || 'qid_analytics',
    user: process.env.QID_DB_USER || 'qid',
    password: process.env.QID_DB_PASSWORD || '',
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return _pool;
}

// Build WHERE-clause fragments only for filters with non-zero/non-null bounds.
// Param indices stay simple: $1..$N filled in order at call site.
function buildFilters() {
  const conds = [
    'tm.market_cap >= $MIN_MCAP',
    'tm.is_etf = false',
    "tm.country = 'US'",
  ];
  const params = { MIN_MCAP: MIN_MCAP_USD };
  if (MAX_MCAP_USD > 0)  { conds.push('tm.market_cap <= $MAX_MCAP');  params.MAX_MCAP = MAX_MCAP_USD; }
  if (MIN_PRICE_USD > 0) { conds.push('m.price >= $MIN_PRICE');       params.MIN_PRICE = MIN_PRICE_USD; }
  if (MAX_PRICE_USD > 0) { conds.push('m.price <= $MAX_PRICE');       params.MAX_PRICE = MAX_PRICE_USD; }
  if (MIN_DAILY_DOLLAR_VOL > 0) {
    // Approximate daily $ volume from the snapshot's price * volume. crucix_movers
    // doesn't ship a precomputed dvol; multiply at the row level. NULL-tolerant
    // because the upstream ingest only populates volume for most_active rows
    // — directional (gainers/losers) rows have NULL volume by design.
    conds.push('(m.volume IS NULL OR (m.price * m.volume) >= $MIN_DVOL)');
    params.MIN_DVOL = MIN_DAILY_DOLLAR_VOL;
  }
  return { conds, params };
}

// Templates use named placeholders; prepare() converts to positional.
const T_DIRECTIONAL = `
  SELECT m.category, m.symbol,
         COALESCE(tm.name, m.name) AS name,
         m.price::float       AS price,
         m.change_pct::float  AS change_pct,
         m.volume,
         m.trade_count,
         (tm.market_cap / 1e9)::float AS mcap_b,
         tm.sector,
         tm.industry
  FROM crucix_movers m
  JOIN ticker_metadata tm ON tm.symbol = m.symbol
  WHERE m.time = (SELECT MAX(time) FROM crucix_movers)
    AND m.category IN ('gainers','losers')
    AND __FILTERS__
    AND m.change_pct IS NOT NULL
    AND ABS(m.change_pct) <= $MAX_ABS
  ORDER BY m.category, ABS(m.change_pct) DESC
  LIMIT $LIMIT
`;

const T_MOST_ACTIVE = `
  SELECT m.category, m.symbol,
         COALESCE(tm.name, m.name) AS name,
         m.price::float       AS price,
         m.change_pct::float  AS change_pct,
         m.volume,
         m.trade_count,
         (tm.market_cap / 1e9)::float AS mcap_b,
         tm.sector,
         tm.industry
  FROM crucix_movers m
  JOIN ticker_metadata tm ON tm.symbol = m.symbol
  WHERE m.time = (SELECT MAX(time) FROM crucix_movers)
    AND m.category = 'most_active'
    AND __FILTERS__
  ORDER BY m.trade_count DESC NULLS LAST
  LIMIT $LIMIT
`;

// Render a template by:
//  1. expanding __FILTERS__ into the AND-joined filter conditions
//  2. converting named placeholders to positional $1..$N
//  3. returning the params array in placeholder-encounter order
function prepare(template, extra = {}) {
  const { conds, params } = buildFilters();
  // Step 1: substitute __FILTERS__
  let sql = template.replace('__FILTERS__', conds.join('\n    AND '));
  // Step 2: collect placeholder order
  const order = [];
  sql.replace(/\$([A-Z_]+)/g, (_, n) => { order.push(n); return ''; });
  // Step 3: replace each named placeholder with $1, $2, ...
  let i = 0;
  sql = sql.replace(/\$([A-Z_]+)/g, () => `$${++i}`);
  // Step 4: build positional params from order
  const all = { ...params, ...extra };
  const positional = order.map(n => {
    if (!(n in all)) throw new Error(`unbound placeholder $${n}`);
    return all[n];
  });
  return { sql, params: positional };
}

const Q_ASOF = `SELECT MAX(time) AS asof FROM crucix_movers`;

function rollupByIndustry(rows) {
  // Group movers by industry. Returns sorted list of industries with at least
  // INDUSTRY_HEAT_MIN movers. Mean change_pct + member symbols included.
  const byInd = new Map();
  for (const r of rows) {
    if (!r.industry) continue;
    if (!byInd.has(r.industry)) {
      byInd.set(r.industry, { industry: r.industry, sector: r.sector, members: [] });
    }
    byInd.get(r.industry).members.push({ symbol: r.symbol, change_pct: r.change_pct });
  }
  const out = [];
  for (const v of byInd.values()) {
    if (v.members.length < INDUSTRY_HEAT_MIN) continue;
    const moves = v.members.map(m => m.change_pct).filter(x => x != null);
    const mean = moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : null;
    out.push({
      industry: v.industry,
      sector: v.sector,
      n: v.members.length,
      mean_change_pct: mean != null ? Math.round(mean * 100) / 100 : null,
      symbols: v.members.map(m => m.symbol),
    });
  }
  // Sort by absolute mean move — biggest industry-level swings first.
  out.sort((a, b) => Math.abs(b.mean_change_pct ?? 0) - Math.abs(a.mean_change_pct ?? 0));
  return out;
}

function shapeRow(r) {
  return {
    symbol: r.symbol,
    name: r.name,
    price: r.price != null ? Math.round(r.price * 100) / 100 : null,
    change_pct: r.change_pct != null ? Math.round(r.change_pct * 100) / 100 : null,
    mcap_b: r.mcap_b != null ? Math.round(r.mcap_b * 100) / 100 : null,
    sector: r.sector,
    industry: r.industry,
    volume: r.volume != null ? Number(r.volume) : null,
    trade_count: r.trade_count != null ? Number(r.trade_count) : null,
  };
}

export async function collect() {
  const p = pool();

  const dir = prepare(T_DIRECTIONAL, { MAX_ABS: MAX_ABS_CHANGE_PCT, LIMIT: PER_CATEGORY_LIMIT * 2 });
  const act = prepare(T_MOST_ACTIVE, { LIMIT: PER_CATEGORY_LIMIT });

  // Run the three queries in parallel — same snapshot, different categories.
  const [asofRes, dirRes, actRes] = await Promise.all([
    p.query(Q_ASOF),
    p.query(dir.sql, dir.params),
    p.query(act.sql, act.params),
  ]);

  const asof = asofRes.rows[0]?.asof ? new Date(asofRes.rows[0].asof).toISOString() : null;

  const directional = dirRes.rows;
  const gainers = directional
    .filter(r => r.category === 'gainers')
    .slice(0, PER_CATEGORY_LIMIT)
    .map(shapeRow);
  const losers = directional
    .filter(r => r.category === 'losers')
    .slice(0, PER_CATEGORY_LIMIT)
    .map(shapeRow);
  const mostActive = actRes.rows.map(shapeRow);

  // Industry heat from the directional set — gives crucix the
  // "hot industries today" signal. Most-active doesn't have change_pct,
  // so it's noisy for sector rotation; we deliberately exclude it here.
  const industryHeat = rollupByIndustry(directional.map(shapeRow));

  const filterDesc = [
    `mcap≥$${(MIN_MCAP_USD / 1e9).toFixed(2)}B`,
    MAX_MCAP_USD > 0 ? `mcap≤$${(MAX_MCAP_USD / 1e9).toFixed(1)}B` : null,
    MIN_PRICE_USD > 0 ? `price≥$${MIN_PRICE_USD}` : null,
    MAX_PRICE_USD > 0 ? `price≤$${MAX_PRICE_USD}` : null,
    MIN_DAILY_DOLLAR_VOL > 0 ? `dvol≥$${(MIN_DAILY_DOLLAR_VOL / 1e6).toFixed(0)}M` : null,
    `|change|≤${MAX_ABS_CHANGE_PCT}%`,
  ].filter(Boolean).join(', ');

  const summary =
    asof
      ? `${gainers.length} gainers, ${losers.length} losers, ${mostActive.length} most-active (asof ${asof}, ${filterDesc})`
      : 'no movers data available';

  return {
    asof,
    summary,
    filters: {
      min_mcap_usd: MIN_MCAP_USD,
      max_mcap_usd: MAX_MCAP_USD,
      min_price_usd: MIN_PRICE_USD,
      max_price_usd: MAX_PRICE_USD,
      min_daily_dollar_vol: MIN_DAILY_DOLLAR_VOL,
      max_abs_change_pct: MAX_ABS_CHANGE_PCT,
      per_category_limit: PER_CATEGORY_LIMIT,
    },
    gainers,
    losers,
    mostActive,
    industryHeat,
  };
}

export async function briefing() {
  return collect();
}
