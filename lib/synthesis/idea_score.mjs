// Post-LLM idea grounding scorer — cross-checks each LLM-generated trade idea's
// free-text signals[] against the ACTUAL synthesized sweep, derives a confidence
// from signal-confluence (overriding the LLM's self-reported HIGH/MED/LOW string),
// and mechanically breaks the long-only skew by surfacing shortable evidence when
// it genuinely exists in the sweep.
//
// HONEST FRAMING: this scores GROUNDING (how many of an idea's cited numbers/claims
// are independently confirmed by the sweep), NOT expected return. A perfectly
// grounded idea can still lose money. evidence_score makes confidence MEAN something
// (signal-confluence, not narrative self-report); it is measured downstream via the
// instrumented hand-pick account, never claimed as alpha.
//
// WHY string/number matching and not a structured join: idea.signals[] are free-text
// English sentences (e.g. "COT Gold +36.1% — EXTREME LONG", "Silver +3.66% to $70.35"),
// not {field,value} tags. So we extract (entity, number) pairs from each sentence and
// confirm them against the matching sweep field within a numeric tolerance. We require
// BOTH an entity token AND a number-in-tolerance for the SAME entity before counting a
// confirmation — a bare number that merely appears somewhere in the sweep is not a confirm.
//
// FAILURE-MODE policy:
//   - "couldn't verify" (entity not in any sweep map)  -> MILD negative (the sweep is a
//     subset of the market; a true claim about an unfetched name reads as absent — do not
//     punish correct external knowledge to death).
//   - "contradicted"   (entity IS in the sweep but the cited number is out of tolerance for
//     EVERY plausible field) -> STRONG negative (fabricated specificity is the dangerous case).
//
// Mirrors sector_rank.mjs style: pure, deterministic, no async, no network.

// ─── Tunables ───────────────────────────────────────────────────────────────
// Points are intentionally small integers so evidence_score reads as a confluence
// count, not a return estimate. Financial/positioning confirms outweigh geopolitical.
const POINTS = {
  STRUCTURAL_CONFIRM: 3,   // symbol literally present in breakouts/breakdowns, or COT extreme flag matches direction
  FINANCIAL_CONFIRM: 2,    // a cited (entity, number) pair matched a financial/positioning field in tolerance
  GEO_CONFIRM: 1,          // a geopolitical/OSINT keyword present (presence-only — weak, non-numeric)
  CONTRADICTION: -3,       // entity IS in the sweep but cited number is out of tolerance everywhere
  ABSENT: -0.5,            // entity not found anywhere in the sweep (unverifiable, lenient)
};

// Numeric tolerances. Percentages compared on an absolute-points basis; prices relative.
const PCT_TOL_ABS = 0.5;   // percentage claims: within 0.5 percentage points
const PRICE_TOL_REL = 0.15; // price/level claims: within 15% relative

// Confidence thresholds expressed in DISTINCT confirmed domains (rotation, cot,
// movers, technicals, metals, energy, macro, geo) — so the LLM cannot farm
// confidence by restating one fact five different ways.
const HIGH_MIN_DOMAINS = 2;  // >=2 distinct confirmed domains AND net-positive => HIGH
const MED_MIN_DOMAINS = 1;   // >=1 distinct confirmed domain  AND net-positive => MEDIUM

// Sector name → ETF symbol (reverse of the sector_rank display map). Lets a signal
// that says "materials" or "energy" resolve to XLB / XLE for a rotation cross-check.
const SECTOR_NAME_TO_ETF = {
  energy: 'XLE',
  materials: 'XLB',
  industrials: 'XLI',
  'consumer discretionary': 'XLY',
  discretionary: 'XLY',
  'consumer staples': 'XLP',
  staples: 'XLP',
  'health care': 'XLV',
  healthcare: 'XLV',
  health: 'XLV',
  financials: 'XLF',
  financial: 'XLF',
  technology: 'XLK',
  tech: 'XLK',
  'communication services': 'XLC',
  communications: 'XLC',
  utilities: 'XLU',
  'real estate': 'XLRE',
};

// A bare sector NAME word ("materials", "energy", "tech") is also a plain-English word and
// a macro-fact label (GSCPI talks about "critical materials"; WTI talks about "energy").
// Treating an extracted number as a SECTOR-RETURN claim is only safe when a rotation CONTEXT
// token sits in the signal — a 5-day notation, an explicit sector/rotation/leading/lagging
// word, or a sector ETF ticker. Without it, demote a mismatch to ABSENT, never CONTRADICTION
// (BUG 1b). The sector ETF tickers themselves are also context.
const ROTATION_CONTEXT_RE =
  /%\s*\/\s*5d|\/\s*5d|\b5d\b|\bsector(?:s)?\b|\brotation\b|\bleading\b|\blagging\b|\breversal\b|\bXL[BECFIKPUVY]\b|\bXLRE\b/i;

// COT label aliases as they appear in free-text signals → the cot.positioning label.
const COT_ALIASES = {
  gold: 'Gold',
  silver: 'Silver',
  eur: 'EUR_USD',
  eurusd: 'EUR_USD',
  euro: 'EUR_USD',
  jpy: 'JPY_USD',
  yen: 'JPY_USD',
  sp500: 'SP500_E_mini',
  's&p': 'SP500_E_mini',
  spx: 'SP500_E_mini',
  es: 'SP500_E_mini',
  nasdaq: 'Nasdaq100_E_mini',
  ndx: 'Nasdaq100_E_mini',
  nq: 'Nasdaq100_E_mini',
  corn: 'Corn',
  crude: 'Crude_WTI',
  wti: 'Crude_WTI',
  oil: 'Crude_WTI',
  wheat: 'Wheat_HRW',
  treasury: 'Treasury_10Y',
  '10y': 'Treasury_10Y',
};

// Macro scalar keyword → { key in macroFacts, kind:'pct'|'price' }.
// ORDER MATTERS: the loop returns on the FIRST keyword whose regex tests true, so
// compound/spread entities (t10y2y, "10Y-2Y", "10s2s", "yield curve") MUST precede the
// single-leg yields (dgs10/dgs2) — otherwise "10Y-2Y spread +40bps" matches \b10y\b first,
// extracts [10,-2,40], compares against DGS10's level, and false-contradicts (BUG 2). The
// dgs10/dgs2 patterns are also tightened with a negative-lookahead so a bare "10y" inside
// "10y-2y" never matches the single-leg yield.
const MACRO_KEYWORDS = [
  { re: /\bgscpi\b/i, key: 'gscpi', kind: 'price' },
  { re: /\bvix\b/i, key: 'vix', kind: 'price' },
  { re: /\bwti\b/i, key: 'wti', kind: 'price' },
  { re: /\bbrent\b/i, key: 'brent', kind: 'price' },
  { re: /\bnat\s*gas\b|\bnatgas\b/i, key: 'natgas', kind: 'price' },
  { re: /\bgold\b/i, key: 'gold', kind: 'price' },
  { re: /\bsilver\b/i, key: 'silver', kind: 'price' },
  // Spread/curve entities FIRST (BUG 2 ordering fix).
  { re: /\b10y\s*-\s*2y\b|\b10s2s\b|\bt10y2y\b|\byield\s*curve\b/i, key: 't10y2y', kind: 'spread' },
  // Single-leg yields, lookahead-guarded so they don't fire on the "10y-2y" / "2y" of a spread.
  { re: /\b10y\b(?!\s*-\s*2y)|\b10-?year\b|\bdgs10\b/i, key: 'dgs10', kind: 'price' },
  { re: /(?<!10y\s*-\s*)\b2y\b|\b2-?year\b|\bdgs2\b/i, key: 'dgs2', kind: 'price' },
];

// Geopolitical / OSINT presence keywords — confirmable as "present in sweep" only,
// never number-graded (their numbers are free-text and not independently verifiable).
const GEO_KEYWORDS = /\b(defense|defence|dod|contract|aircraft|thermal|conflict|sanction|missile|ukraine|gaza|baltic|naval|airstrike|geopolit)/i;

// Position-sizing / buying-power / cross-idea-reference phrasing. A token extracted from one
// of these sentences is bookkeeping ("...alongside AG + KTOS", "$400 allocation", "25 shares"),
// not a claim about the sweep — so it must NOT earn an ABSENT penalty (BUG 4).
const SIZING_PHRASE_RE =
  /\bbuying\s*power\b|\balongside\b|\ballocation\b|\bshares?\b|\bshares_per_1k\b|\bposition\s*siz|\bmcap\b|\bmarket\s*cap\b|\b\$\d|\bvs\.?\b/i;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Extract candidate numbers from a signal string: percentages, $-prices, bare decimals.
 *  Returns array of plain numbers (sign-aware). */
function extractNumbers(s) {
  const out = [];
  const re = /([+-]?\d+(?:\.\d+)?)\s*(%|x|bps)?/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v)) out.push({ value: v, unit: (m[2] || '').toLowerCase() });
  }
  return out;
}

/** Extract candidate ticker tokens (1-5 uppercase letters), filtering common English
 *  all-caps words that aren't tickers. */
const STOPWORD_TICKERS = new Set([
  'A', 'I', 'AND', 'OR', 'THE', 'TO', 'OF', 'IN', 'ON', 'AT', 'BY', 'VS', 'IS',
  'COT', 'OBV', 'RSI', 'RVOL', 'MA', 'VIX', 'WTI', 'DOD', 'GSCPI', 'HIGH', 'LOW',
  'LONG', 'SHORT', 'EXTREME', 'TOP', 'BUY', 'SELL', 'PE', 'EPS', 'YOY', 'QOQ',
  'US', 'USA', 'EU', 'GDP', 'CPI', 'FOMC', 'FED', 'ETF', 'IPO', 'EV', 'AI',
  'OK', 'NO', 'YES', 'UP', 'DOWN', 'NEW', 'ALL', 'ATH',
]);
function extractTickers(s) {
  const out = [];
  const re = /\b[A-Z]{1,5}\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const t = m[0];
    if (!STOPWORD_TICKERS.has(t)) out.push(t);
  }
  return out;
}

function pctMatch(claimed, actual) {
  if (claimed == null || actual == null) return false;
  return Math.abs(claimed - actual) <= PCT_TOL_ABS;
}
function priceMatch(claimed, actual) {
  if (claimed == null || actual == null || actual === 0) return false;
  return Math.abs(claimed - actual) / Math.abs(actual) <= PRICE_TOL_REL;
}

// ─── Truth-set indexing ───────────────────────────────────────────────────────
// Build, ONCE per sweep, the numeric facts the sweep contains, keyed by entity. This
// is the only thing the per-idea cross-check reads, so all sweep-shape knowledge lives here.

/**
 * @returns {{
 *   tickerFacts: Map<string, object>,
 *   cotFacts: Map<string, {pct:number|null, extreme:'long'|'short'|null}>,
 *   macroFacts: object,
 *   shortable: {cotLong:string[], cotShort:string[], breakdownSymbols:string[], laggingNames:string[]},
 * }}
 */
function buildTruthIndex(sweep) {
  const tickerFacts = new Map();
  const upsert = (sym, patch) => {
    if (!sym) return;
    const key = String(sym).toUpperCase();
    const cur = tickerFacts.get(key) || { symbol: key, sources: new Set() };
    if (patch.source) cur.sources.add(patch.source);
    tickerFacts.set(key, { ...cur, ...patch, sources: cur.sources });
  };

  const sr = sweep?.sectorRotation || {};
  for (const r of sr.sectors || []) {
    if (r?.symbol) upsert(r.symbol, { source: 'rotation', d1: num(r.d1), d5: num(r.d5), classification: r.classification });
  }
  // leadersByName / laggardsByName carry single-name d1 + sector.
  for (const r of [...(sr.leadersByName || []), ...(sr.laggardsByName || [])]) {
    if (r?.symbol) upsert(r.symbol, { source: 'rotation', d1: num(r.d1), sector: r.sector });
  }

  const mm = sweep?.marketMovers || {};
  for (const bucket of ['gainers', 'losers', 'mostActive']) {
    for (const r of mm[bucket] || []) {
      if (r && r.symbol) {
        upsert(r.symbol, {
          source: 'movers',
          change_pct: num(r.change_pct),
          mcap_b: num(r.mcap_b),
          price: num(r.price),
          sector: r.sector,
          industry: r.industry,
        });
      }
    }
  }

  const tech = sweep?.technicals || {};
  for (const r of tech.breakouts || []) {
    if (r?.symbol) upsert(r.symbol, { source: 'technicals', inBreakouts: true, price: num(r.price), rsi: num(r.rsi) });
  }
  for (const r of tech.breakdowns || []) {
    if (r?.symbol) upsert(r.symbol, { source: 'technicals', inBreakdowns: true, price: num(r.price), rsi: num(r.rsi) });
  }
  for (const r of tech.flow || []) {
    if (r?.symbol) upsert(r.symbol, { source: 'technicals', flowNote: r.note });
  }

  // Portfolio positions — citing an existing position is grounded.
  const positions = sweep?.portfolio?.positions;
  if (Array.isArray(positions)) {
    for (const p of positions) {
      if (p?.symbol) upsert(p.symbol, { source: 'portfolio', inPortfolio: true, price: num(p.current_price) });
    }
  }

  // COT facts keyed by lowercased label.
  const cotFacts = new Map();
  const cot = sweep?.cot || {};
  for (const p of cot.positioning || []) {
    if (p && p.label && !p.error) {
      cotFacts.set(String(p.label).toLowerCase(), { pct: num(p.spec_net_pct_oi), extreme: null });
    }
  }
  // Parse "Label=NN%" extreme strings and flag direction.
  const parseExtreme = (arr, dir) => {
    for (const s of arr || []) {
      const mm2 = String(s).match(/^([^=]+)=([+-]?\d+(?:\.\d+)?)/);
      if (mm2) {
        const lbl = mm2[1].trim().toLowerCase();
        const existing = cotFacts.get(lbl) || { pct: parseFloat(mm2[2]), extreme: null };
        existing.extreme = dir;
        if (existing.pct == null) existing.pct = parseFloat(mm2[2]);
        cotFacts.set(lbl, existing);
      }
    }
  };
  parseExtreme(cot.extreme_long, 'long');
  parseExtreme(cot.extreme_short, 'short');

  // Macro scalars.
  const fredById = {};
  for (const f of sweep?.fred || []) {
    if (f && f.id) fredById[f.id] = num(f.value);
  }
  const macroFacts = {
    wti: num(sweep?.energy?.wti),
    brent: num(sweep?.energy?.brent),
    natgas: num(sweep?.energy?.natgas),
    gold: num(sweep?.metals?.gold),
    silver: num(sweep?.metals?.silver),
    goldChangePct: num(sweep?.metals?.goldChangePct),
    silverChangePct: num(sweep?.metals?.silverChangePct),
    vix: num(sweep?.markets?.vix?.value) ?? fredById.VIXCLS ?? null,
    dgs10: fredById.DGS10 ?? null,
    dgs2: fredById.DGS2 ?? null,
    t10y2y: fredById.T10Y2Y ?? null,
    gscpi: num(sweep?.gscpi?.value),
  };

  // Shortable-evidence inventory — the ONLY legitimate gate for enforcing a SHORT.
  const cotLong = (cot.extreme_long || []).map((s) => String(s));
  const cotShort = (cot.extreme_short || []).map((s) => String(s));
  const breakdownSymbols = (tech.breakdowns || []).map((r) => r?.symbol).filter(Boolean);
  const laggingNames = [
    ...(sr.laggardsByName || []).map((r) => r?.symbol),
    ...(sr.sectors || [])
      .filter((r) => r && (r.classification === 'lagging' || r.classification === 'reversal-down'))
      .map((r) => r.symbol),
  ].filter(Boolean);

  return {
    tickerFacts,
    cotFacts,
    macroFacts,
    shortable: { cotLong, cotShort, breakdownSymbols, laggingNames },
  };
}

// ─── Per-signal cross-check ────────────────────────────────────────────────────

/**
 * Cross-check a single free-text signal against the truth index.
 * @param {string} signal
 * @param {object} idx        truth index from buildTruthIndex
 * @param {{ideaTickers?:Set<string>}} [ctx]  cross-idea context (the tickers of every idea
 *                            in the set, so a sibling-idea ticker mention is not penalized — BUG 4)
 * @returns {{outcome:'confirm'|'contradict'|'absent'|'geo'|'none', domain:string|null, points:number, detail:string}}
 */
function checkSignal(signal, idx, ctx = {}) {
  const s = typeof signal === 'string' ? signal : '';
  if (!s.trim()) return { outcome: 'none', domain: null, points: 0, detail: '' };

  const ideaTickers = ctx.ideaTickers instanceof Set ? ctx.ideaTickers : null;
  const numbers = extractNumbers(s);
  const tickers = extractTickers(s);
  const lower = s.toLowerCase();

  // Helper: does any extracted number match the actual value (pct or price)?
  const anyPctHits = (actual) => numbers.some((n) => pctMatch(n.value, actual));
  const anyPriceHits = (actual) => numbers.some((n) => priceMatch(n.value, actual));

  // 1) COT positioning — strongest non-symbol financial confirm.
  //    Collect ALL referenced COT labels first (BUG 3): a single sentence can name two
  //    ("COT Nasdaq100 -0.3% — S&P vs. NDX divergence"). A CONTRADICTION is only honest when
  //    EXACTLY ONE label is referenced and its single cited number is out of tolerance. When
  //    multiple labels appear, we confirm the one whose number matches and otherwise demote
  //    to ABSENT — we never assert a -3 against a sentence whose number is correct for the
  //    OTHER label it names.
  const cotMatches = [];
  const seenLabels = new Set();
  for (const [alias, label] of Object.entries(COT_ALIASES)) {
    if (lower.includes(alias)) {
      const fact = idx.cotFacts.get(label.toLowerCase());
      if (fact && !seenLabels.has(label)) {
        seenLabels.add(label);
        cotMatches.push({ label, fact });
      }
    }
  }
  if (cotMatches.length) {
    const assertsExtreme = /extreme|crowd|top.?zone|bottom.?zone/i.test(s);
    const isCot = /cot/i.test(s);
    // Structural: signal asserts extreme + ANY referenced COT label flags that direction.
    for (const { label, fact } of cotMatches) {
      if (assertsExtreme && fact.extreme) {
        return { outcome: 'confirm', domain: 'cot', points: POINTS.STRUCTURAL_CONFIRM, detail: `COT ${label} extreme-${fact.extreme}` };
      }
    }
    // Numeric: confirm if ANY referenced label's pct matches a cited number.
    if (isCot) {
      for (const { label, fact } of cotMatches) {
        if (fact.pct != null && anyPctHits(fact.pct)) {
          return { outcome: 'confirm', domain: 'cot', points: POINTS.FINANCIAL_CONFIRM, detail: `COT ${label} ${fact.pct}%` };
        }
      }
      // No referenced label matched. CONTRADICTION only when EXACTLY ONE label is named and a
      // number was cited (unambiguous single-entity single-number out of tolerance). Otherwise
      // ABSENT (couldn't verify which label the number belongs to) — never a false -3.
      const single = cotMatches.length === 1 && cotMatches[0].fact.pct != null;
      if (single && numbers.length) {
        return { outcome: 'contradict', domain: 'cot', points: POINTS.CONTRADICTION, detail: `COT ${cotMatches[0].label} claim ≠ ${cotMatches[0].fact.pct}%` };
      }
      if (numbers.length) {
        return { outcome: 'absent', domain: null, points: POINTS.ABSENT, detail: `COT (${cotMatches.map((m) => m.label).join('/')}) number ambiguous — couldn't verify` };
      }
      // Mentioned a real COT label without a checkable number -> mild confirm of presence.
      return { outcome: 'confirm', domain: 'cot', points: POINTS.GEO_CONFIRM, detail: `COT ${cotMatches[0].label} present` };
    }
  }

  // 2) Symbol-anchored confirms (rotation / movers / technicals / portfolio).
  for (const t of tickers) {
    const fact = idx.tickerFacts.get(t);
    if (!fact) continue;
    // Structural presence: in breakouts/breakdowns is a confirmed structure signal,
    // independent of any cited number.
    if (fact.inBreakouts || fact.inBreakdowns) {
      return {
        outcome: 'confirm',
        domain: 'technicals',
        points: POINTS.STRUCTURAL_CONFIRM,
        detail: `${t} ${fact.inBreakouts ? 'breakout' : 'breakdown'}`,
      };
    }
    // Numeric confirm against any plausible field for this entity.
    const pctFields = [fact.change_pct, fact.d1, fact.d5].filter((v) => v != null);
    const priceFields = [fact.price, fact.mcap_b].filter((v) => v != null);
    const pctHit = pctFields.some((v) => anyPctHits(v));
    const priceHit = priceFields.some((v) => anyPriceHits(v));
    if (pctHit || priceHit) {
      return { outcome: 'confirm', domain: 'movers', points: POINTS.FINANCIAL_CONFIRM, detail: `${t} number confirmed` };
    }
    // Entity present, flow note present, no number cited -> presence confirm.
    if (fact.flowNote && !numbers.length) {
      return { outcome: 'confirm', domain: 'technicals', points: POINTS.GEO_CONFIRM, detail: `${t} flow: ${fact.flowNote}` };
    }
    // Entity IS in the sweep, a number WAS cited, nothing matched -> contradiction.
    if (numbers.length && (pctFields.length || priceFields.length)) {
      return { outcome: 'contradict', domain: 'movers', points: POINTS.CONTRADICTION, detail: `${t} cited number unmatched` };
    }
    // Entity present but we have nothing to check the number against -> neutral confirm of presence.
    return { outcome: 'confirm', domain: 'movers', points: POINTS.GEO_CONFIRM, detail: `${t} present in sweep` };
  }

  // 3) Macro scalars (WTI / VIX / GSCPI / yields / metals price).
  //    Runs BEFORE sector-NAME (BUG 1a): a real macro fact like GSCPI=1.76 confirms first,
  //    so the bare word "materials" in the same sentence never reaches the sector-return
  //    contradiction path. MACRO_KEYWORDS is ordered so spread entities precede single-leg
  //    yields (BUG 2).
  for (const mk of MACRO_KEYWORDS) {
    if (mk.re.test(s)) {
      const actual = idx.macroFacts[mk.key];
      if (actual != null) {
        // Spread/curve claims ("+40bps steepening", "10Y-2Y") are quoted in bps or as a
        // direction, not as a raw yield level. Comparing a +40bps move to T10Y2Y=0.39 is a
        // category error, so we confirm on SIGN agreement and otherwise stay neutral — never
        // contradict on a spread (BUG 2).
        if (mk.kind === 'spread') {
          const steepening = /steepen|widen|\bup\b|\+|positive|bull|bear\s*steep/i.test(s);
          const flattening = /flatten|narrow|invert|\bdown\b|negative/i.test(s);
          if ((actual > 0 && steepening) || (actual < 0 && flattening)) {
            return { outcome: 'confirm', domain: 'macro', points: POINTS.FINANCIAL_CONFIRM, detail: `${mk.key} sign confirmed (${actual})` };
          }
          // Same-sign-as-claimed but no directional word, or an unverifiable bps level —
          // presence-confirm, do NOT contradict.
          return { outcome: 'confirm', domain: 'macro', points: POINTS.GEO_CONFIRM, detail: `${mk.key} present (${actual})` };
        }
        const hit = mk.kind === 'pct' ? anyPctHits(actual) : anyPriceHits(actual);
        // Metals also carry a changePct — accept either price or pct match.
        const metalPct = mk.key === 'gold' ? idx.macroFacts.goldChangePct : mk.key === 'silver' ? idx.macroFacts.silverChangePct : null;
        const metalHit = metalPct != null && anyPctHits(metalPct);
        if (hit || metalHit) {
          return { outcome: 'confirm', domain: 'macro', points: POINTS.FINANCIAL_CONFIRM, detail: `${mk.key} confirmed` };
        }
        if (numbers.length) {
          return { outcome: 'contradict', domain: 'macro', points: POINTS.CONTRADICTION, detail: `${mk.key} claim ≠ ${actual}` };
        }
        return { outcome: 'confirm', domain: 'macro', points: POINTS.GEO_CONFIRM, detail: `${mk.key} present` };
      }
    }
  }

  // 4) Sector NAME rotation (e.g. "materials +4%/5d") -> resolve to ETF.
  //    A bare sector word is also plain English / a macro label, so only treat an extracted
  //    number as a sector-RETURN claim when a rotation CONTEXT token is present (BUG 1b);
  //    otherwise a mismatch demotes to ABSENT (couldn't-verify), never CONTRADICTION.
  for (const [name, etf] of Object.entries(SECTOR_NAME_TO_ETF)) {
    if (lower.includes(name)) {
      const fact = idx.tickerFacts.get(etf);
      if (fact && (fact.d1 != null || fact.d5 != null)) {
        const pctHit = [fact.d1, fact.d5].filter((v) => v != null).some((v) => anyPctHits(v));
        if (pctHit) return { outcome: 'confirm', domain: 'rotation', points: POINTS.FINANCIAL_CONFIRM, detail: `${etf} (${name}) confirmed` };
        const hasRotationContext = ROTATION_CONTEXT_RE.test(s);
        if (numbers.length && hasRotationContext) {
          return { outcome: 'contradict', domain: 'rotation', points: POINTS.CONTRADICTION, detail: `${etf} (${name}) number unmatched` };
        }
        if (numbers.length) {
          // Number present but no rotation anchor — the number is about something else
          // (a macro scalar, a price, a count). Couldn't verify as a sector claim, not a lie.
          return { outcome: 'absent', domain: null, points: POINTS.ABSENT, detail: `${etf} (${name}) no rotation anchor` };
        }
        return { outcome: 'confirm', domain: 'rotation', points: POINTS.GEO_CONFIRM, detail: `${etf} (${name}) present` };
      }
    }
  }

  // 5) Geopolitical / OSINT — presence-only, weak, never number-graded.
  if (GEO_KEYWORDS.test(s)) {
    return { outcome: 'geo', domain: 'geo', points: POINTS.GEO_CONFIRM, detail: 'geopolitical/OSINT keyword' };
  }

  // 6) Cited a ticker that exists NOWHERE in the sweep -> mild absent penalty
  //    (lenient: could be a legit external-knowledge name the sweep never fetched).
  if (tickers.length) {
    // BUG 4: a token that is itself ANOTHER idea's ticker (e.g. "...alongside AG + KTOS"),
    // or any token inside a position-sizing / buying-power / "vs" sentence, is bookkeeping —
    // not a sweep claim. Don't penalize it. Only penalize a genuinely unknown external name.
    const isSizingPhrase = SIZING_PHRASE_RE.test(s);
    const unknown = tickers.filter((t) => !(ideaTickers && ideaTickers.has(t)));
    if (isSizingPhrase || unknown.length === 0) {
      return { outcome: 'none', domain: null, points: 0, detail: `${tickers[0]} (cross-idea/sizing ref — not penalized)` };
    }
    return { outcome: 'absent', domain: null, points: POINTS.ABSENT, detail: `${unknown[0]} not in sweep` };
  }

  return { outcome: 'none', domain: null, points: 0, detail: '' };
}

// ─── Confidence derivation ─────────────────────────────────────────────────────
//
// CONCERN 5: the geo/OSINT domain is presence-only — it never reads a number out of the
// sweep, so an idea cannot earn a real tier by writing "missile"/"defense" twice. We require
// at least ONE NON-geo confirmed domain (rotation, cot, movers, technicals, macro) before an
// idea may reach MEDIUM or HIGH. Geo still ADDS to the raw score and counts as a confirmed
// domain for breadth, but it cannot lift the tier on its own.
function hasMarketGrounding(domains) {
  return [...domains].some((d) => d && d !== 'geo');
}
function tierFor(domainsCount, netScore, domains) {
  const market = hasMarketGrounding(domains);
  if (market && domainsCount >= HIGH_MIN_DOMAINS && netScore > 0) return 'GROUNDED';
  if (market && domainsCount >= MED_MIN_DOMAINS && netScore > 0) return 'PARTIAL';
  return 'NARRATIVE';
}
function confidenceFor(domainsCount, netScore, domains) {
  const market = hasMarketGrounding(domains);
  if (market && domainsCount >= HIGH_MIN_DOMAINS && netScore > 0) return 'HIGH';
  if (market && domainsCount >= MED_MIN_DOMAINS && netScore > 0) return 'MEDIUM';
  return 'LOW';
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Score and re-rank LLM-generated ideas against the synthesized sweep.
 *
 * For each idea: cross-check signals[] against the real sweep fields, accumulate a
 * grounding-based evidence_score, override idea.confidence from confluence (distinct
 * confirmed domains), preserve the LLM's self-report as idea.llm_confidence, attach a
 * grounding breakdown + tier, then sort by evidence_score desc. When shortable evidence
 * exists in the sweep but the idea set has no SHORT/AVOID/HEDGE, annotate (never fabricate).
 *
 * Defensive: any internal error returns the original ideas untouched so a scorer bug
 * cannot crash a sweep. All idea fields are preserved; only evidence_score / grounding /
 * confidence / llm_confidence are added and order changes.
 *
 * @param {Array<object>} ideas  - llmIdeas (post parseIdeasResponse). May be null.
 * @param {object} sweep         - the synthesized sweep (read-only).
 * @param {{topN?:number}} [opts]
 * @returns {Array<object>} NEW array, each idea augmented + sorted by evidence_score desc.
 */
export function scoreIdeas(ideas, sweep, opts = {}) {
  if (!Array.isArray(ideas) || ideas.length === 0) return ideas ?? [];

  try {
    const idx = buildTruthIndex(sweep || {});

    // The set of every idea's OWN ticker — used to neutralize cross-idea ticker mentions in
    // sizing/buying-power sentences (BUG 4) instead of penalizing them as "absent".
    const ideaTickers = new Set(
      ideas
        .map((i) => (i && i.ticker ? String(i.ticker).toUpperCase() : null))
        .filter(Boolean),
    );

    const scored = ideas.map((idea) => {
      const signals = Array.isArray(idea?.signals) ? idea.signals : [];
      const confirmed = [];
      const hallucinated = [];
      const absent = [];
      const domains = new Set();
      let score = 0;

      for (const sig of signals) {
        const res = checkSignal(sig, idx, { ideaTickers });
        score += res.points;
        if (res.outcome === 'confirm' || res.outcome === 'geo') {
          confirmed.push(res.detail || String(sig));
          if (res.domain) domains.add(res.domain);
        } else if (res.outcome === 'contradict') {
          hallucinated.push(res.detail || String(sig));
        } else if (res.outcome === 'absent') {
          absent.push(res.detail || String(sig));
        }
      }

      // Round so the field is clean for the archive / dashboard.
      const evidence_score = Math.round(score * 10) / 10;
      const domainArr = [...domains];
      const tier = tierFor(domainArr.length, evidence_score, domains);
      const derivedConfidence = confidenceFor(domainArr.length, evidence_score, domains);

      return {
        ...idea,
        // Preserve the LLM's self-report for calibration (self-report vs grounded).
        llm_confidence: idea?.confidence ?? null,
        // Override the live confidence with the grounding-derived value.
        confidence: derivedConfidence,
        evidence_score,
        evidence_tier: tier,
        grounding: {
          confirmed,
          hallucinated,
          absent,
          domains: domainArr,
          tier,
        },
      };
    });

    // Long/short balance — surface, never fabricate. Only act when the sweep actually
    // contains shortable evidence.
    annotateShortBalance(scored, idx.shortable);

    // Stable sort by evidence_score desc. Ties keep original relative order.
    const order = new Map(scored.map((s, i) => [s, i]));
    scored.sort((a, b) => (b.evidence_score - a.evidence_score) || (order.get(a) - order.get(b)));

    // Optional dashboard cap. We DO NOT drop ideas by default — the outcome loop needs
    // the thin/negative examples to measure that low-grounding ideas underperform.
    if (typeof opts.topN === 'number' && opts.topN > 0 && scored.length > opts.topN) {
      return scored.slice(0, opts.topN);
    }
    return scored;
  } catch (err) {
    // A scorer bug must never kill a sweep — degrade to the raw LLM ideas.
    console.error('[idea_score] scoreIdeas failed, falling back to raw ideas:', err?.message);
    return ideas;
  }
}

/**
 * If shortable evidence exists in the sweep but no idea is SHORT/AVOID/HEDGE, flag it.
 * Mutates the scored array in place (adds a `short_balance_flag` to the most-eligible
 * idea and downranks the single most-crowded LONG). NEVER injects a fabricated idea.
 *
 * Shortable evidence (any of): cot.extreme_long non-empty (contrarian short the proxy,
 * e.g. GLD for crowded-long Gold), cot.extreme_short non-empty (momentum short),
 * a name present in technicals.breakdowns, or a lagging single-name.
 */
function annotateShortBalance(scored, shortable) {
  if (!shortable) return;
  const hasShortableEvidence =
    (shortable.cotLong?.length || 0) > 0 ||
    (shortable.cotShort?.length || 0) > 0 ||
    (shortable.breakdownSymbols?.length || 0) > 0 ||
    (shortable.laggingNames?.length || 0) > 0;
  if (!hasShortableEvidence) return;

  const SHORT_TYPES = new Set(['SHORT', 'AVOID', 'HEDGE']);
  const hasBearish = scored.some((i) => SHORT_TYPES.has(String(i?.type || '').toUpperCase()));
  if (hasBearish) return; // The idea set already expresses the bearish side — nothing to surface.

  // Build a human-readable reason from the actual evidence so a downstream reader / P4
  // prompt can see WHY a short is warranted — without us inventing one.
  const reasons = [];
  if (shortable.cotShort?.length) reasons.push(`COT extreme-short: ${shortable.cotShort.join(', ')} (momentum short)`);
  if (shortable.cotLong?.length) reasons.push(`COT extreme-long: ${shortable.cotLong.join(', ')} (contrarian short the proxy)`);
  if (shortable.breakdownSymbols?.length) reasons.push(`Breakdowns: ${shortable.breakdownSymbols.join(', ')}`);
  if (shortable.laggingNames?.length) reasons.push(`Lagging names: ${shortable.laggingNames.slice(0, 5).join(', ')}`);

  const flag = {
    reason: reasons.join(' | '),
    evidence: {
      cot_extreme_long: shortable.cotLong || [],
      cot_extreme_short: shortable.cotShort || [],
      breakdowns: shortable.breakdownSymbols || [],
      lagging_names: shortable.laggingNames || [],
    },
  };

  // Attach the flag to the highest-evidence idea so it rides into the archive/graph,
  // and downrank the single most-crowded LONG (so the all-long set is mechanically
  // penalized) — but we never create a SHORT idea from nothing.
  if (scored.length) {
    scored[0].short_balance_flag = flag;
  }
  const longs = scored.filter((i) => String(i?.type || '').toUpperCase() === 'LONG');
  if (longs.length) {
    // Most-crowded = highest evidence_score LONG; nudge it down so a genuine short
    // (if one is ever generated) outranks an unbalanced long book.
    longs.sort((a, b) => (b.evidence_score || 0) - (a.evidence_score || 0));
    longs[0].evidence_score = Math.round((longs[0].evidence_score - 1) * 10) / 10;
    longs[0].long_skew_penalty = true;
  }
}
