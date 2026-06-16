// LLM-Powered Trade Ideas — generates actionable ideas from sweep data + delta context

// Account-aware prompting: env-driven knobs steer the LLM toward names that
// fit the trader's actual account size. Set in deploy/k8s/.../configmap.yaml.
const _envNum = (v, d) => (v == null || v === '' ? d : Number(v));
const ACCOUNT_MIN_USD     = _envNum(process.env.CRUCIX_ACCOUNT_MIN_USD,     500);
const ACCOUNT_MAX_USD     = _envNum(process.env.CRUCIX_ACCOUNT_MAX_USD,     2000);
const PREF_MCAP_MIN_B     = _envNum(process.env.CRUCIX_PREF_MCAP_MIN_B,     0.3);   // small caps in
const PREF_MCAP_MAX_B     = _envNum(process.env.CRUCIX_PREF_MCAP_MAX_B,     5);     // mid caps in, mega out
const PREF_PRICE_MIN      = _envNum(process.env.CRUCIX_PREF_PRICE_MIN,      5);
const PREF_PRICE_MAX      = _envNum(process.env.CRUCIX_PREF_PRICE_MAX,      50);
const PREF_LIQ_FLOOR_M    = _envNum(process.env.CRUCIX_LIQUIDITY_FLOOR_M,   20);    // $M daily dollar volume

// P6: the agentic openbb-mcp tool-use path was REMOVED. idea-gen is now a single
// non-agentic completion over a fully-deterministic context (yield curve via FRED,
// earnings via the EARNINGS_NEXT_7D block from the Finnhub fetch in synthesize,
// news via Benzinga). No mcpConfig/allowedTools are passed, so claude_code.mjs
// locks tools with --disallowedTools '*'. The OPENBB_MCP_URL / OPENBB_ENABLED
// consts and the agentic STEP1-4 prompt block are intentionally gone.

/**
 * Generate LLM-enhanced trade ideas from sweep data.
 * @param {LLMProvider} provider - configured LLM provider
 * @param {object} sweepData - synthesized dashboard data
 * @param {object|null} delta - delta from last sweep
 * @param {Array} previousIdeas - ideas from previous runs (for dedup)
 * @returns {Promise<Array>} - array of idea objects
 */
export async function generateLLMIdeas(provider, sweepData, delta, previousIdeas = []) {
  if (!provider?.isConfigured) return null;

  let context;
  try {
    context = compactSweepForLLM(sweepData, delta, previousIdeas);
  } catch (err) {
    console.error('[LLM Ideas] Failed to compact sweep data:', err.message);
    return null;
  }

  const systemPrompt = `You are a quantitative analyst at a macro intelligence firm. You receive structured OSINT + economic data from 31 sources and produce 5-8 actionable trade ideas for a small-account retail trader.

ACCOUNT CONTEXT — applies to every LONG / SHORT recommendation:
- Capital per position: $${ACCOUNT_MIN_USD}–$${ACCOUNT_MAX_USD}
- PREFER tickers with market cap $${PREF_MCAP_MIN_B}B–$${PREF_MCAP_MAX_B}B (small/mid caps move more on real catalysts; mega-caps don't budge for retail capital)
- PREFER share price $${PREF_PRICE_MIN}–$${PREF_PRICE_MAX} (so $1K = ${Math.round(1000 / PREF_PRICE_MAX)}–${Math.round(1000 / PREF_PRICE_MIN)} shares — meaningful position, room to scale in/out)
- PREFER daily dollar volume ≥ $${PREF_LIQ_FLOOR_M}M so a retail order won't move the price. NOTE: the movers feed does NOT pre-screen for this (volume isn't co-reported with price in the source, so no hard $-vol floor is applied upstream) — YOU are the liquidity gate. Favor names that are clearly liquid (large mcap, well-known, high price×typical-volume) and be wary of thin small-caps; treat a name you cannot confirm as liquid as higher-risk and size it down or mark WATCH.
- Mega-caps (NVDA, MSFT, GOOGL, META, AAPL, etc.) and high-priced names ($100+) are CONTEXT for sector mood — NOT recommendations to buy. Reference them in rationale but do not name them as the primary ticker.
- ETFs are usually too expensive ($100+) for this account size — only recommend an ETF if there is no equivalent single-name play.

PORTFOLIO AWARENESS — when PORTFOLIO_POSITIONS section is present:
- Do NOT recommend a LONG that duplicates exposure the trader already has — note it but mark as WATCH or "already long, consider adding"
- If the trader is heavily exposed to one direction/sector, prefer HEDGE *or outright SHORT* ideas over more LONGs — a borrow-cleared SHORT in a weak name is a legitimate way to balance a long-skewed book, not just an index hedge
- Account buying_power caps new GROSS positions — if buying_power is small ($<2000), recommend at most 1-2 new directional ideas total (LONG *or SHORT*), not 5-8. A SHORT consumes buying power too; size it the same way
- Day_pl context: if account is sharply down today, prefer defensive/hedge ideas; if sharply up, allow more aggressive directional ideas (LONG or SHORT)
- Reference held positions in rationale where relevant ("you're already long SLV at $66 — AG provides additional silver exposure with 2-3x operational leverage")

Rules:
- EMPIRICAL EDGE GUARDRAIL (read FIRST — it overrides any pattern-chasing instinct below): pure price-pattern timing has been backtested on our full ~2,246-name equity panel (2021-2026, net of cost, adversarially verified) and has NO edge over simply owning the market. Specifically: 20-day-high BREAKOUTS — both chasing the breakout AND buying the pullback — lose ~0.7-0.8%/trade vs SPY; a LOW-VOLATILITY factor and a short-term cross-sectional MOMENTUM factor both deliver LOWER risk-adjusted return than just equal-weighting the universe. So a chart pattern (breakout / breakdown / "momentum" / cheap-vs-peers) is a TIMING or CONFIRMATION overlay — it is NEVER, by itself, an edge or a sufficient reason to trade. Every LONG/SHORT must rest on a STRUCTURAL or CATALYST thesis that explains WHY the name is mispriced AND why that won't be instantly arbitraged away: a concrete re-rating catalyst (earnings/guidance inflection, contract win, M&A, regulatory or supply shock), forced / price-insensitive flow (index rebalance, distress, policy), a genuine macro/geopolitical supply-demand dislocation, or a valuation gap PAIRED with such a catalyst. The technical breakout/breakdown then confirms TIMING; it does not manufacture the edge. If the only thing you can say for an idea is "it broke out" / "it's the strongest momentum name" / "it's cheap", it is a WATCH, not a LONG/SHORT.
- Each idea must cite specific data points from the input
- Include entry rationale, risk factors, and time horizon
- Blend geopolitical, economic, and market signals — cross-correlate across domains
- Be specific: name instruments (tickers), not vague sectors
- INDUSTRY STEER (when INDUSTRY_HOT / INDUSTRY_COLD blocks are present): these are a deterministic, RANKED industry shortlist to pick WITHIN — HOT industries are the long-candidate hunting ground (pick the strongest breakout name within one), COLD industries the short-candidate hunting ground (pick the weakest breakdown name within one). They are a STEER built from short-horizon momentum (industry mover-mean + parent-sector rotation), NOT a standalone selector and NOT a substitute for a structural/CATALYST thesis (see EMPIRICAL EDGE GUARDRAIL) — a LONG still needs a structural/catalyst reason WITH a TECH_BREAKOUTS pattern as TIMING confirmation (the breakout is never the thesis), and a SHORT a structural/catalyst reason WITH a TECH_BREAKDOWNS/lagging/COT trigger as confirmation. Prefer candidates that sit inside a HOT (for longs) / COLD (for shorts) industry over equally-triggered names that do not; cite the industry rank ("INDUSTRY_HOT Semiconductors z=1.2") as a CONFIRMING signal. Sector-proxy rows (n=0) are coarser — treat them as a weak hint, not a confirmed industry read.
- If delta shows significant changes, lead with those
- Do NOT repeat ideas from the "previous ideas" list unless conditions have materially changed
- Rate confidence: HIGH (multiple confirming signals), MEDIUM (thesis supported), LOW (speculative)
- VALUATION (when CHEAP_VS_PEERS / RICH_VS_PEERS blocks are present): these are sector-relative trailing-multiple reads (within today's shortlist), a CONFIRM/gate — never a standalone trigger. A LONG that is ALSO in CHEAP_VS_PEERS (cheap on P/E/P/S/EV-EBITDA vs its sector) is higher-conviction: cite the multiple vs the sector median ("cheap P/E 8.1 vs sector-median 14.7, 12th pctile") as a confirming signal alongside the structural trigger. A SHORT that is ALSO in RICH_VS_PEERS is higher-conviction — see DISTRIBUTION SHORT below. NEVER call a name cheap or rich unless it appears in those blocks, and NEVER invent or cite a P/E for a name listed in VALUATION_UNKNOWN (no trailing multiple exists — usually a loss-maker; using one is fabrication). Cheapness alone is not a buy and richness alone is not a short; both must pair with a structural trigger.
- MANDATORY for every LONG/SHORT idea: include "shares_per_1k" field as an integer = floor(1000 / current_price). Example: at $25/share, shares_per_1k=40. This proves you considered position-ability.
- If a strong setup exists in a name OUTSIDE the account-friendly bands above, mark it WATCH (not LONG) and explain why

SHORT SETUPS — you are mandated to look for the bearish side with the same rigor as the long side. Generate an outright SHORT (not just AVOID/WATCH) when the evidence is symmetric to a LONG:
- COLDEST-INDUSTRY SHORT: the industry the global situation is HURTING most -> SHORT its WEAKEST name. Use INDUSTRY_COLD (the deterministic ranked coldest industries — pick the weakest name WITHIN one of them), INDUSTRY_HEAT (legacy most-negative mean), SECTOR_LAGGING / classification=lagging|reversal-down, and NAME_LAGGARDS as the trigger — the mirror of the leading-sector LONG. INDUSTRY_HOT/INDUSTRY_COLD are a STEER (short-horizon momentum, NOT a standalone selector): they narrow WHERE to hunt; a SHORT still REQUIRES its own structural trigger (TECH_BREAKDOWNS membership / lagging classification / COT extreme).
- DISTRIBUTION SHORT: confirmed technical BREAKDOWN -> SHORT. A name in TECH_BREAKDOWNS (price < MA50 AND < MA200, falling RSI, near 52w LOW on rising RVOL) that is also a sector laggard is a momentum short, the direct mirror of the breakout LONG. TECH_BREAKDOWNS membership is the REQUIRED structural trigger here. If that breakdown name ALSO appears in RICH_VS_PEERS (expensive on trailing multiples vs its sector), that is a STRONGER, higher-conviction distribution short — expensive AND breaking down — so prefer it and cite the rich multiple ("RICH_VS_PEERS: P/E 41 vs sector-median 15, 88th pctile") as a confirmer. Valuation is a CONFIRM/gate, never a standalone short trigger: a rich name that is NOT in TECH_BREAKDOWNS stays WATCH, not SHORT.
- POSITIONING SHORTS: COT_EXTREME_SHORT = momentum short the future's weak side; COT_EXTREME_LONG = contrarian short the crowded proxy (e.g. crowded-long Gold -> short the GLD-correlated miner only if it ALSO shows a breakdown — crowding alone is not a short trigger).
- A SHORT must cite at least one STRUCTURAL trigger (TECH_BREAKDOWNS membership, lagging classification, or a COT extreme) in signals[] — narrative bearishness alone stays AVOID/WATCH, never SHORT.
- Honesty gate (do NOT skip): shorting is asymmetric — borrow cost, hard-to-borrow squeezes, and the market's structural up-drift all bleed a short that 'looks sharp'. Only emit SHORT for a name liquid and large enough to borrow (prefer mcap inside the account band and dvol >= the liquidity floor). A deterministic borrow gate runs AFTER you; thin-float micro-caps you mark SHORT will be downgraded to WATCH with a borrow_block reason — so don't waste a slot shorting an unborrowable name. Propose the real short on the evidence and let the gate enforce borrowability.

Output ONLY valid JSON array. Each object:
{
  "title": "Short title (max 10 words)",
  "type": "LONG|SHORT|HEDGE|WATCH|AVOID",
  "ticker": "Primary instrument",
  "confidence": "HIGH|MEDIUM|LOW",
  "rationale": "2-3 sentence explanation citing specific data",
  "risk": "Key risk factor",
  "horizon": "Intraday|Days|Weeks|Months",
  "signals": ["signal1", "signal2"],
  "shares_per_1k": 40
}

Concrete example object:
{"title":"Silver miner leverage","type":"LONG","ticker":"AG","confidence":"HIGH","rationale":"...","risk":"...","horizon":"Weeks","signals":["..."],"shares_per_1k":67}

Concrete SHORT example object:
{"title":"Lagging E&P breakdown short","type":"SHORT","ticker":"XYZ","confidence":"MEDIUM","rationale":"XYZ (Oil & Gas E&P, $1.2B mcap, $18) is the weakest name in the coldest industry: XLE -3.1%/-2.9%5d is the worst sector, INDUSTRY_HEAT Oil&Gas E&P mean -4.2%, and XYZ sits in TECH_BREAKDOWNS (px $18 < MA50 $21 < MA200 $24, RSI 31, 102% of 52w low on RVOL 2.1x). WTI failing to rally on active Middle East confirms no commodity bid to rescue it. Structural breakdown + sector laggard = momentum short, not a dip.","risk":"Energy is a squeeze-prone short — a Hormuz/Iran shock spikes WTI and the whole sector; sized small. Earnings <date> if in window.","horizon":"Weeks","signals":["XYZ in TECH_BREAKDOWNS: px<MA50<MA200, RSI 31, 52wL 102%, RVOL 2.1x","XLE -3.1%/-2.9%5d worst sector; INDUSTRY_HEAT E&P mean -4.2%","WTI no rally on active conflict = no commodity floor","COT WTI +3.8% — no squeeze fuel building"],"shares_per_1k":55}

NOTE the SHORT example cites a STRUCTURAL breakdown trigger and acknowledges squeeze risk — both required for type:SHORT.
NOTE the integer shares_per_1k. NEVER omit this field for LONG/SHORT.

DETERMINISTIC RULES (read these from the context above — you have NO tools, do not attempt to fetch anything; everything you need is already in the input):

RATE GATE — the yield curve is in ECONOMIC (DGS2=2Y, DGS10=10Y, DGS30=30Y, T10Y2Y=10Y-2Y spread, T10Y3M=10Y-3M spread). Cite the 30Y rate (DGS30) or the 10Y-2Y spread (T10Y2Y) from ECONOMIC in at least one rate-sensitive idea (banks, REITs, gold, utilities, debt-heavy small caps). Do NOT invent a curve number — use only what ECONOMIC shows.

EARNINGS GATE — the EARNINGS_NEXT_7D block (when present) lists candidate tickers reporting within 7 days, with date + session (bmo/amc). For EVERY LONG/SHORT you draft:
   → If your ticker appears in EARNINGS_NEXT_7D and horizon="Days": downgrade to WATCH and note "earnings <date> — wait for print".
   → If your ticker appears in EARNINGS_NEXT_7D and horizon="Weeks" and you still want it: keep it but ADD "RISK: earnings on <date>" to the risk field.
   → If a ticker is NOT in EARNINGS_NEXT_7D, it has no earnings inside 7d — clear runway. Cite the earnings check in the rationale of at least one idea ("no earnings within 7d — clear runway" or "earnings <date> — sized down accordingly"). If the EARNINGS_NEXT_7D block is ABSENT entirely, the earnings feed was unavailable this sweep — skip the gate and do not assert anything about earnings dates you do not have.`;

  try {
    // P6: single NON-AGENTIC completion. We no longer pass mcpConfig/allowedTools,
    // so claude_code.mjs locks tools with --disallowedTools '*' — one --print call,
    // no multi-turn openbb tool-use. The old agentic path ran ~8-9min (the P4
    // short mandate pushed it to brush/exceed the 10min ceiling; one sweep
    // produced 0 ideas), driven by openbb-mcp FMP rate-limiting + tool-use
    // latency. The data the agent loop fetched is now deterministic in the
    // context: yield curve via FRED (DGS30/T10Y3M added to the ECONOMIC
    // whitelist), earnings via the EARNINGS_NEXT_7D block (Finnhub fetch in
    // synthesize), news via Benzinga MOVER_CATALYSTS. Insider (the old STEP3)
    // was confirming-only and is dropped. So this is ONE Sonnet completion (no
    // agentic tool-use). The context is large now (technicals + valuation +
    // industry + earnings + COT + movers + news + macro), so the single call
    // runs a few minutes, not seconds — 240s timed out and yielded 0 ideas.
    // 600s gives the single completion real headroom while still well under the
    // old 15min agentic ceiling (and with no flaky multi-turn openbb tool-use).
    const completeOpts = { maxTokens: 4096, timeout: 900000 };
    const result = await provider.complete(systemPrompt, context, completeOpts);
    const ideas = parseIdeasResponse(result.text);
    if (ideas && ideas.length > 0) {
      return ideas;
    }
    console.warn('[LLM Ideas] No valid ideas parsed from response');
    return null;
  } catch (err) {
    console.error('[LLM Ideas] Generation failed:', err.message);
    return null;
  }
}

/**
 * Compact sweep data to ~8KB for token efficiency.
 */
function compactSweepForLLM(data, delta, previousIdeas) {
  const sections = [];

  // Economic indicators. P6: DGS30 (30Y) + T10Y3M (10Y-3M spread) added so the
  // single non-agentic call sees the SAME long-end / curve the old agentic STEP1
  // yield-curve tool fetched. FRED already carries them (fred.mjs fetches
  // DGS2/DGS10/DGS30/T10Y2Y/T10Y3M; they ride into data.fred); they were just
  // filtered out of this whitelist. data.fred only includes non-null indicators,
  // so a missing print on a holiday simply omits the field — no crash.
  if (data.fred?.length) {
    const key = data.fred.filter(f => ['VIXCLS', 'DFF', 'DGS2', 'DGS10', 'DGS30', 'T10Y2Y', 'T10Y3M', 'BAMLH0A0HYM2', 'DTWEXBGS', 'MORTGAGE30US'].includes(f.id));
    sections.push(`ECONOMIC [yield curve: DGS2=2Y, DGS10=10Y, DGS30=30Y, T10Y2Y=10Y-2Y spread, T10Y3M=10Y-3M spread]: ${key.map(f => `${f.id}=${f.value}${f.momChange ? ` (${f.momChange > 0 ? '+' : ''}${f.momChange})` : ''}`).join(', ')}`);
  }

  // Energy
  if (data.energy) {
    sections.push(`ENERGY: WTI=$${data.energy.wti}, Brent=$${data.energy.brent}, NatGas=$${data.energy.natgas}, CrudeStocks=${data.energy.crudeStocks}bbl`);
  }

  // Metals
  if (data.metals?.gold != null || data.metals?.silver != null) {
    const gold = data.metals?.gold != null ? `$${data.metals.gold}` : 'n/a';
    const silver = data.metals?.silver != null ? `$${data.metals.silver}` : 'n/a';
    const goldChg = data.metals?.goldChangePct != null ? ` (${data.metals.goldChangePct >= 0 ? '+' : ''}${data.metals.goldChangePct}%)` : '';
    const silverChg = data.metals?.silverChangePct != null ? ` (${data.metals.silverChangePct >= 0 ? '+' : ''}${data.metals.silverChangePct}%)` : '';
    sections.push(`METALS: Gold=${gold}${goldChg}, Silver=${silver}${silverChg}`);
  }

  // BLS
  if (data.bls?.length) {
    sections.push(`LABOR: ${data.bls.map(b => `${b.id}=${b.value}`).join(', ')}`);
  }

  // Treasury
  if (data.treasury) {
    sections.push(`TREASURY: totalDebt=$${data.treasury}T`);
  }

  // Supply chain
  if (data.gscpi) {
    sections.push(`SUPPLY_CHAIN: GSCPI=${data.gscpi.value} (${data.gscpi.interpretation})`);
  }

  // Sector rotation (1d + 5d, top-3 leading / bottom-3 lagging)
  const rot = data.sectorRotation;
  if (rot?.leading?.length) {
    const fmt = r => `${r.symbol}(${r.d1?.toFixed(1) ?? 'n/a'}%/${r.d5?.toFixed(1) ?? 'n/a'}%5d,${r.classification})`;
    sections.push(`SECTOR_LEADING: ${rot.leading.map(fmt).join(', ')}`);
    sections.push(`SECTOR_LAGGING: ${rot.lagging.map(fmt).join(', ')}`);
    if (rot.leadersByName?.length) {
      sections.push(
        `NAME_LEADERS: ${rot.leadersByName.map(e =>
          `${e.symbol}${e.sector ? `(${e.sector})` : ''} ${e.d1.toFixed(2)}%`
        ).join(', ')}`
      );
    }
    if (rot.laggardsByName?.length) {
      sections.push(
        `NAME_LAGGARDS: ${rot.laggardsByName.map(e =>
          `${e.symbol}${e.sector ? `(${e.sector})` : ''} ${e.d1.toFixed(2)}%`
        ).join(', ')}`
      );
    }
  }

  // Current portfolio — what the trader actually holds. Critical context for
  // ideation: prevents duplicate-exposure recommendations, enables hedge ideas
  // ("you're long X, here's a hedge"), and limits new LONGs when buying power
  // is constrained.
  const pf = data.portfolio;
  if (pf && !pf.error && pf.account) {
    const a = pf.account;
    const acctLine =
      `equity=$${a.equity}, cash=$${a.cash}, buying_power=$${a.buying_power}` +
      (a.day_pl != null ? `, day_pl=$${a.day_pl} (${a.day_pl_pct}%)` : '');
    sections.push(`PORTFOLIO_ACCOUNT: ${acctLine}`);

    if (pf.positions?.length) {
      const lines = pf.positions.slice(0, 15).map(p =>
        `- ${p.symbol} ${p.side === 'long' ? 'LONG' : 'SHORT'} ${p.qty} @ $${p.avg_entry_price?.toFixed(2)} ` +
        `now=$${p.current_price?.toFixed(2)} mv=$${p.market_value?.toFixed(2)} ` +
        `unr_pl=$${p.unrealized_pl?.toFixed(2)} (${(p.unrealized_plpc * 100)?.toFixed(2)}%)`
      );
      sections.push(`PORTFOLIO_POSITIONS (${pf.positions.length}):\n${lines.join('\n')}`);
    } else {
      sections.push('PORTFOLIO_POSITIONS: (no open positions)');
    }
  }

  // Alpaca movers — broader equity universe with industry attribution.
  // Filtered to mcap >= $1B, non-ETF, US. Caps at 10 per side to keep
  // prompt under control; rest is in marketMovers.industryHeat.
  // CFTC Commitments of Traders — futures positioning regime overlay.
  // spec_net_pct_oi >= +25% = crowded long (top zone risk for that future);
  // <= -25% = crowded short (bottom zone setup). Helps Sonnet contrarian-check
  // ideas in metals, energy, FX, indices, rates, ag.
  const cot = data.cot;
  if (cot && !cot.error && cot.positioning?.length) {
    const fmt = p =>
      p.spec_net_pct_oi != null
        ? `${p.label}=${p.spec_net_pct_oi >= 0 ? '+' : ''}${p.spec_net_pct_oi}%`
        : `${p.label}=?`;
    sections.push(
      `COT_POSITIONING (${cot.report_date_latest || '?'}): ${cot.positioning.map(fmt).join(', ')}`
    );
    if (cot.extreme_long?.length) {
      sections.push(`COT_EXTREME_LONG (top-zone risk): ${cot.extreme_long.join(', ')}`);
    }
    if (cot.extreme_short?.length) {
      sections.push(`COT_EXTREME_SHORT (bottom-zone setup): ${cot.extreme_short.join(', ')}`);
    }
  }

  const mv = data.marketMovers;
  if (mv && !mv.error) {
    const fmtMover = m =>
      `${m.symbol}${m.industry ? `(${m.industry})` : ''} ${m.change_pct >= 0 ? '+' : ''}${m.change_pct?.toFixed(1) ?? '?'}% mcap=$${m.mcap_b?.toFixed(1) ?? '?'}B`;
    if (mv.gainers?.length) {
      sections.push(`MOVERS_GAINERS: ${mv.gainers.slice(0, 10).map(fmtMover).join(', ')}`);
    }
    if (mv.losers?.length) {
      sections.push(`MOVERS_LOSERS: ${mv.losers.slice(0, 10).map(fmtMover).join(', ')}`);
    }
    if (mv.mostActive?.length) {
      const fmtAct = m => `${m.symbol}${m.industry ? `(${m.industry})` : ''}`;
      sections.push(`MOVERS_MOST_ACTIVE: ${mv.mostActive.slice(0, 10).map(fmtAct).join(', ')}`);
    }
    if (mv.industryHeat?.length) {
      sections.push(
        `INDUSTRY_HEAT: ${mv.industryHeat.slice(0, 5).map(h =>
          `${h.industry}: n=${h.n}, mean=${h.mean_change_pct >= 0 ? '+' : ''}${h.mean_change_pct?.toFixed(1) ?? '?'}% [${h.symbols.join(',')}]`
        ).join('; ')}`
      );
    }
  }

  // Industry HOT/COLD ranker (P5) — a RANKED, SPLIT industry shortlist to pick
  // WITHIN, so the LLM stops free-associating tickers. HOT industries steer LONG
  // candidates, COLD industries steer SHORT candidates (a STEER — the structural
  // triggers in TECH_BREAKOUTS/TECH_BREAKDOWNS + the borrow gate still GATE the
  // actual idea). HONEST: this is short-horizon momentum (industry mover-mean +
  // parent-sector composite), NOT a standalone selector; sector-proxy rows have
  // n=0 (sector-derived, movers were thin). When industryRank is absent/degraded,
  // the legacy INDUSTRY_HEAT block above remains the fallback (nothing regresses).
  const ir = data.industryRank;
  if (ir && !ir.degraded && (ir.hot?.length || ir.cold?.length)) {
    const fmtI = h =>
      `${h.industry}(${h.sector || '?'}): ` +
      `${h.mean_change_pct == null ? 'proxy(n=0)' : `mean=${h.mean_change_pct >= 0 ? '+' : ''}${h.mean_change_pct.toFixed(1)}% n=${h.n}`} ` +
      `z=${h.score?.toFixed(2) ?? '?'}` +
      `${h.cot ? ` COT:${h.cot}` : ''}` +
      `${h.symbols?.length ? ` [${h.symbols.slice(0, 4).join(',')}]` : ''}`;
    if (ir.hot?.length) {
      sections.push(
        `INDUSTRY_HOT [long-candidate hunting ground — momentum: industry RS + sector rotation` +
        `${ir.someCot ? ' + COT where mapped' : ''}; pick within, NOT a standalone selector]: ` +
        `${ir.hot.map(fmtI).join('; ')}`
      );
    }
    if (ir.cold?.length) {
      sections.push(
        `INDUSTRY_COLD [short-candidate hunting ground — coldest industries; pick the weakest name within, ` +
        `breakdown trigger + borrow gate still required]: ${ir.cold.map(fmtI).join('; ')}`
      );
    }
  } else if (ir?.degraded) {
    sections.push(
      `INDUSTRY_RANK: degraded (${ir.note}) — fall back to SECTOR_LAGGING / NAME_LAGGARDS for the cold side`
    );
  }

  // Equity technicals — real bar-derived breakouts / breakdowns / flow so the
  // LLM sees momentum structure (price vs MA50/MA200, RSI, RVOL, distance to 52w
  // extreme), not just raw big-% movers. FLOW_HEAT is daily-bar OBV/$-vol —
  // NOT institutional or dark-pool data; labeled as such for the model.
  const tech = data.technicals;
  if (tech && !tech.error) {
    if (tech.breakouts?.length) {
      const fmtBO = b =>
        `${b.symbol} px=$${b.price?.toFixed(2) ?? '?'} >MA50=${b.ma50?.toFixed(2) ?? '?'}/MA200=${b.ma200?.toFixed(2) ?? '?'} ` +
        `RSI=${b.rsi?.toFixed(0) ?? '?'} RVOL=${b.rvol?.toFixed(1) ?? '?'}x 52wH=${b.pct_of_52w_high?.toFixed(1) ?? '?'}%`;
      sections.push(`TECH_BREAKOUTS: ${tech.breakouts.slice(0, 10).map(fmtBO).join('; ')}`);
    }
    if (tech.breakdowns?.length) {
      const fmtBD = b =>
        `${b.symbol} px=$${b.price?.toFixed(2) ?? '?'} <MA50=${b.ma50?.toFixed(2) ?? '?'}/MA200=${b.ma200?.toFixed(2) ?? '?'} ` +
        `RSI=${b.rsi?.toFixed(0) ?? '?'} RVOL=${b.rvol?.toFixed(1) ?? '?'}x 52wL=${b.pct_of_52w_low?.toFixed(1) ?? '?'}%`;
      sections.push(`TECH_BREAKDOWNS: ${tech.breakdowns.slice(0, 10).map(fmtBD).join('; ')}`);
    }
    if (tech.flow?.length) {
      const fmtFlow = f => `${f.symbol}(${f.note})`;
      sections.push(`FLOW_HEAT [daily-bar OBV/$vol, NOT dark-pool]: ${tech.flow.slice(0, 10).map(fmtFlow).join(', ')}`);
    }
  }

  // Equity valuation (P3) — sector-relative cheap/rich tags from Yahoo trailing
  // multiples (P/E, P/S, EV/EBITDA). WITHIN-SHORTLIST, SECTOR-RELATIVE — a
  // relative read of the day's movers, NOT an absolute fair-value claim, and
  // trailing multiples on micro-caps are noisy. Valuation is a GATE/CONFIRM:
  // CHEAP + TECH_BREAKOUTS = higher-conviction value-breakout LONG; RICH +
  // TECH_BREAKDOWNS = higher-conviction distribution SHORT. NEVER treat a name
  // as cheap/rich on valuation alone, and NEVER invent a multiple for a
  // VALUATION_UNKNOWN name (loss-makers have no trailing P/E — that's a real gap).
  const val = data.valuation;
  if (val && !val.error) {
    const fmtVal = v => {
      const parts = [`P/E=${v.pe ?? '?'} vs sectMed ${v.sectorMedianPe ?? '?'}`];
      if (v.ps != null) parts.push(`P/S=${v.ps}${v.sectorMedianPs != null ? ` vs ${v.sectorMedianPs}` : ''}`);
      if (v.evEbitda != null) parts.push(`EV/EBITDA=${v.evEbitda}${v.sectorMedianEvEbitda != null ? ` vs ${v.sectorMedianEvEbitda}` : ''}`);
      return `${v.symbol}(${v.sector || '?'}) ${parts.join(', ')} [${v.percentile ?? '?'}pctile, n=${v.peer_n ?? '?'}]`;
    };
    if (val.cheap?.length) {
      sections.push(`CHEAP_VS_PEERS [sector-relative trailing multiples; cheap=lower pctile]: ${val.cheap.slice(0, 10).map(fmtVal).join('; ')}`);
    }
    if (val.rich?.length) {
      sections.push(`RICH_VS_PEERS [sector-relative trailing multiples; rich=higher pctile]: ${val.rich.slice(0, 10).map(fmtVal).join('; ')}`);
    }
    if (val.unknown?.length) {
      // Surface the coverage gap explicitly so the model sees valuation was
      // ATTEMPTED but absent — and does NOT invent a multiple for these names.
      sections.push(
        `VALUATION_UNKNOWN [no reliable trailing multiple — loss-making / thin sector / no data; do NOT cite a P/E here]: ` +
        `${val.unknown.slice(0, 12).map(u => u.symbol).join(', ')}`
      );
    }
  }

  // Earnings calendar (P6) — deterministic replacement for the old agentic STEP2
  // earnings tool call. EARNINGS_NEXT_7D lists candidate tickers reporting within
  // 7 days (date + bmo/amc session). The LLM applies the earnings-risk gate from
  // here (Days->WATCH, Weeks->add "RISK: earnings <date>"). Strictly additive:
  // when earnings is null/errored or no candidate reports in-window, the block is
  // OMITTED and the prompt's earnings rule treats its absence as "skip the gate"
  // — matching the old agentic behavior on a quiet/failed earnings fetch.
  const earn = data.earnings;
  if (earn && !earn.error && earn.withinWindow?.length) {
    const fmtEarn = e => {
      const sess = e.hour ? `(${e.hour})` : '';
      const d = e.days_until != null ? ` +${e.days_until}d` : '';
      return `${e.symbol} ${e.earnings_date}${sess}${d}`;
    };
    sections.push(
      `EARNINGS_NEXT_7D [candidates reporting within 7d — gate: LONG/SHORT horizon=Days reporting here -> WATCH; horizon=Weeks -> add "RISK: earnings <date>"]: ` +
      `${earn.withinWindow.map(fmtEarn).join(', ')}`
    );
  }

  // Benzinga news — catalyst attribution. Two slices:
  // (1) headlines for tickers that ALSO appear in movers (highest leverage —
  //     explains the WHY behind a price move) — preferred when present.
  // (2) general top headlines (broad context).
  // Cap total bytes around ~2KB so the prompt doesn't balloon.
  const nws = data.marketNews;
  if (nws && !nws.error) {
    const moverSymbols = new Set([
      ...(mv?.gainers || []),
      ...(mv?.losers || []),
      ...(mv?.mostActive || []),
    ].map(m => m.symbol));

    const moverNews = [];
    if (nws.byTicker && moverSymbols.size > 0) {
      for (const sym of moverSymbols) {
        const arts = nws.byTicker[sym] || [];
        if (arts.length) moverNews.push({ symbol: sym, article: arts[0] });
      }
    }
    if (moverNews.length) {
      const lines = moverNews.slice(0, 8).map(n =>
        `- ${n.symbol}: ${n.article.title}${n.article.teaser ? ` — ${n.article.teaser.slice(0, 160)}` : ''}`
      );
      sections.push(`MOVER_CATALYSTS:\n${lines.join('\n')}`);
    } else if (nws.articles?.length) {
      // No mover overlap — fall back to top general headlines for context.
      const lines = nws.articles.slice(0, 5).map(a =>
        `- [${(a.tickers || []).slice(0, 4).join(',') || '-'}] ${a.title}`
      );
      sections.push(`TOP_NEWS:\n${lines.join('\n')}`);
    }
  }

  // Geopolitical signals (cap total OSINT text to ~1500 chars to keep prompt compact)
  const urgentPosts = (data.tg?.urgent || []).slice(0, 5);
  if (urgentPosts.length) {
    const MAX_OSINT_CHARS = 1500;
    let remaining = MAX_OSINT_CHARS;
    const lines = [];
    for (const p of urgentPosts) {
      const text = p.text || '';
      if (remaining <= 0) break;
      const trimmed = text.length > remaining ? text.substring(0, remaining) + '…' : text;
      lines.push(`- ${trimmed}`);
      remaining -= trimmed.length;
    }
    sections.push(`URGENT_OSINT:\n${lines.join('\n')}`);
  }

  // Thermal / fire detections
  if (data.thermal?.length) {
    const hotRegions = data.thermal.filter(t => t.det > 10).map(t => `${t.region}: ${t.det} detections (${t.hc} high-conf)`);
    if (hotRegions.length) sections.push(`THERMAL: ${hotRegions.join(', ')}`);
  }

  // Air activity
  if (data.air?.length) {
    const airSum = data.air.map(a => `${a.region}: ${a.total} aircraft`);
    sections.push(`AIR_ACTIVITY: ${airSum.join(', ')}`);
  }

  // Nuclear
  if (data.nuke?.length) {
    const anomalies = data.nuke.filter(n => n.anom);
    if (anomalies.length) sections.push(`NUCLEAR_ANOMALY: ${anomalies.map(n => `${n.site}: ${n.cpm}cpm`).join(', ')}`);
  }

  // WHO alerts
  if (data.who?.length) {
    sections.push(`WHO_ALERTS: ${data.who.slice(0, 3).map(w => w.title).join('; ')}`);
  }

  // Defense spending
  if (data.defense?.length) {
    const topContracts = data.defense.slice(0, 3).map(d => `$${((d.amount || 0) / 1e6).toFixed(0)}M to ${d.recipient}`);
    sections.push(`DEFENSE_CONTRACTS: ${topContracts.join(', ')}`);
  }

  // Delta context
  if (delta?.summary) {
    sections.push(`\nDELTA_SINCE_LAST_SWEEP: direction=${delta.summary.direction}, changes=${delta.summary.totalChanges}, critical=${delta.summary.criticalChanges}`);
    if (delta.signals?.escalated?.length) {
      sections.push(`ESCALATED: ${delta.signals.escalated.map(s => `${s.label}: ${s.previous}→${s.current} (${(s.changePct||0) > 0 ? '+' : ''}${(s.changePct||0).toFixed(1)}%)`).join(', ')}`);
    }
    if (delta.signals?.new?.length) {
      sections.push(`NEW_SIGNALS: ${delta.signals.new.map(s => s.label || s.text?.substring(0, 60)).join('; ')}`);
    }
  }

  // Previous ideas (for dedup)
  if (previousIdeas.length) {
    sections.push(`\nPREVIOUS_IDEAS (avoid repeating):\n${previousIdeas.map(i => `- ${i.title} [${i.type}]`).join('\n')}`);
  }

  return sections.join('\n');
}

/**
 * Parse LLM response into ideas array. Handles markdown code blocks.
 */
function parseIdeasResponse(text) {
  if (!text) return null;

  // Strip markdown code block wrappers
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return null;

    // Validate each idea has required fields
    return parsed.filter(idea =>
      idea.title && idea.type && idea.confidence
    ).map(idea => {
      const sharesPer1k = typeof idea.shares_per_1k === 'number' ? idea.shares_per_1k : null;
      // Embed shares_per_1k in the rationale string so it survives the bridge's
      // text-only narrative serialization (the bridge writes episode_body=thesis;
      // unknown structured fields would otherwise be dropped at the graphiti
      // boundary). This makes the integer queryable downstream by tradefarm
      // via simple regex on the episode body.
      const rationale = idea.rationale || '';
      const rationaleAugmented =
        sharesPer1k != null && (idea.type === 'LONG' || idea.type === 'SHORT')
          ? `${rationale} [Position size: shares_per_1k=${sharesPer1k}]`
          : rationale;
      return {
        title: idea.title,
        type: idea.type,
        ticker: idea.ticker || '',
        confidence: idea.confidence,
        rationale: rationaleAugmented,
        risk: idea.risk || '',
        horizon: idea.horizon || '',
        signals: idea.signals || [],
        // Account-aware sizing — preserves the integer the LLM emits per the
        // prompt. Allows downstream filtering by position-ability without
        // re-parsing rationale (in case bridge later supports structured fields).
        shares_per_1k: sharesPer1k,
        source: 'llm',
      };
    });
  } catch {
    // Try to extract JSON array from mixed text
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]);
        return arr.filter(i => i.title && i.type).map(idea => ({
          ...idea,
          source: 'llm',
        }));
      } catch { /* give up */ }
    }
    return null;
  }
}
