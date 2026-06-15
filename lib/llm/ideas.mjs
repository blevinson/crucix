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

// openbb-mcp: in-cluster service. When set (default in qid namespace), the LLM
// can call openbb tools to fetch SEC insider/institutional, yield curves,
// fundamentals, etc. on tickers it sees in the sweep.
const OPENBB_MCP_URL = process.env.CRUCIX_OPENBB_MCP_URL || 'http://openbb-mcp.qid.svc.cluster.local:8000/mcp';
const OPENBB_ENABLED = process.env.CRUCIX_OPENBB_ENABLED !== 'false';

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
- REQUIRE daily dollar volume ≥ $${PREF_LIQ_FLOOR_M}M (retail order won't move the price)
- Mega-caps (NVDA, MSFT, GOOGL, META, AAPL, etc.) and high-priced names ($100+) are CONTEXT for sector mood — NOT recommendations to buy. Reference them in rationale but do not name them as the primary ticker.
- ETFs are usually too expensive ($100+) for this account size — only recommend an ETF if there is no equivalent single-name play.

PORTFOLIO AWARENESS — when PORTFOLIO_POSITIONS section is present:
- Do NOT recommend a LONG that duplicates exposure the trader already has — note it but mark as WATCH or "already long, consider adding"
- If the trader is heavily exposed to one direction/sector, prefer HEDGE *or outright SHORT* ideas over more LONGs — a borrow-cleared SHORT in a weak name is a legitimate way to balance a long-skewed book, not just an index hedge
- Account buying_power caps new GROSS positions — if buying_power is small ($<2000), recommend at most 1-2 new directional ideas total (LONG *or SHORT*), not 5-8. A SHORT consumes buying power too; size it the same way
- Day_pl context: if account is sharply down today, prefer defensive/hedge ideas; if sharply up, allow more aggressive directional ideas (LONG or SHORT)
- Reference held positions in rationale where relevant ("you're already long SLV at $66 — AG provides additional silver exposure with 2-3x operational leverage")

Rules:
- Each idea must cite specific data points from the input
- Include entry rationale, risk factors, and time horizon
- Blend geopolitical, economic, and market signals — cross-correlate across domains
- Be specific: name instruments (tickers), not vague sectors
- INDUSTRY STEER (when INDUSTRY_HOT / INDUSTRY_COLD blocks are present): these are a deterministic, RANKED industry shortlist to pick WITHIN — HOT industries are the long-candidate hunting ground (pick the strongest breakout name within one), COLD industries the short-candidate hunting ground (pick the weakest breakdown name within one). They are a STEER built from short-horizon momentum (industry mover-mean + parent-sector rotation), NOT a standalone selector and NOT a substitute for a structural trigger — a LONG still needs a TECH_BREAKOUTS-style trigger and a SHORT a TECH_BREAKDOWNS/lagging/COT trigger. Prefer candidates that sit inside a HOT (for longs) / COLD (for shorts) industry over equally-triggered names that do not; cite the industry rank ("INDUSTRY_HOT Semiconductors z=1.2") as a CONFIRMING signal. Sector-proxy rows (n=0) are coarser — treat them as a weak hint, not a confirmed industry read.
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
NOTE the integer shares_per_1k. NEVER omit this field for LONG/SHORT.${OPENBB_ENABLED ? `

OPENBB TOOLS — required workflow. DO NOT call available_tools, activate_*, get_prompt, list_resources, read_resource, install_skill, or activate_category — those are setup utilities, hard skip.

REQUIRED CALLS — make these in this order, before finalizing any ideas. Do NOT pass a "provider" argument — server-side defaults route every tool to a working free/keyed provider (sec, fred, nasdaq, benzinga, yfinance). Specifying provider="fmp" will fail (no key).

STEP 1 (always, once per sweep): mcp__openbb__fixedincome_government_yield_curve   {}
   → Cite the 30Y rate (or 10Y-2Y spread) in at least one rate-sensitive idea (banks, REITs, gold, utilities, debt-heavy small caps).

STEP 2 (always, once per sweep): mcp__openbb__equity_calendar_earnings  {start_date: today, end_date: today+7d}
   → For EVERY LONG/SHORT you draft with horizon "Days" or "Weeks", check the returned list. If your ticker reports earnings in this window:
       → If horizon=Days: downgrade to WATCH and note "earnings <date> — wait for print"
       → If horizon=Weeks and you still want it: keep but ADD "RISK: earnings on <date>" to the risk field
   → Cite the earnings check in the rationale of at least one idea ("no earnings within 7d — clear runway" or "earnings <date> — sized down accordingly").

STEP 3 (encouraged, on top 2-3 tickers from MOVERS_GAINERS or your finalized LONGs): mcp__openbb__equity_ownership_insider_trading  {symbol: "TICKER"}
   → Confirms or refutes thesis. If returns null/no-data, just move on (foreign filers + low-activity names won't have data — not an error).

STEP 4 (optional, if a top mover lacks catalyst context): mcp__openbb__news_company  {symbol: "TICKER", limit: 5}

CRITICAL RULES:
- DO NOT pass provider="fmp" anywhere — no API key configured, will error.
- DO NOT pass any "provider" argument — server defaults handle routing.
- If a tool returns an error or null, do NOT retry with same args — move on.
- Budget: 5-8 total openbb calls per sweep, COMBINED across long AND short research. Do NOT double your tool calls for the short side — the short triggers (TECH_BREAKDOWNS, SECTOR_LAGGING, NAME_LAGGARDS, COT extremes) are ALREADY in the context above; use them directly. Above 8 calls you're stalling — finalize ideas instead.` : ''}`;

  try {
    // Timeout 15min — the enriched prompt (movers + benzinga + account-aware +
    // the P4 symmetric-short mandate, which adds bearish-side research) can push
    // the agentic openbb run to ~9min; 10min brushed the ceiling and timed out
    // (a sweep that times out yields 0 ideas that hour). 15min gives headroom.
    // The real fix is P6 (deterministic data-prep + a single non-agentic call).
    const completeOpts = { maxTokens: 4096, timeout: 900000 };
    if (OPENBB_ENABLED) {
      completeOpts.mcpConfig = { mcpServers: { openbb: { type: 'http', url: OPENBB_MCP_URL } } };
      completeOpts.allowedTools = ['mcp__openbb__*'];
    }
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

  // Economic indicators
  if (data.fred?.length) {
    const key = data.fred.filter(f => ['VIXCLS', 'DFF', 'DGS10', 'DGS2', 'T10Y2Y', 'BAMLH0A0HYM2', 'DTWEXBGS', 'MORTGAGE30US'].includes(f.id));
    sections.push(`ECONOMIC: ${key.map(f => `${f.id}=${f.value}${f.momChange ? ` (${f.momChange > 0 ? '+' : ''}${f.momChange})` : ''}`).join(', ')}`);
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
