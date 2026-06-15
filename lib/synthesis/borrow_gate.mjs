// Borrow Gate (P4) — deterministic, post-LLM RISK gate for SHORT ideas.
//
// WHY: crucix's prompt now mandates the symmetric short side, but shorting a
// micro-cap without checking borrow generates confident, well-narrated,
// NEGATIVE-net-EV shorts (borrow cost + hard-to-borrow squeeze + structural
// up-drift). "Looks symmetric and sharp" is exactly how a short loses money net
// of borrow. So every SHORT must clear borrowability before it ships live.
//
// WHAT IT IS: a deterministic tradability/risk gate, NOT a hand-coded trading
// threshold. The MODEL still picks which names to short — the gate only refuses
// the uninvestable ones. This stays inside the "model owns all trading
// decisions" rule (it's a risk gate, like a borrow desk saying "no locate").
//
// PRIMARY PATH (real): GET /v2/assets/{symbol} on the Alpaca trading API — read
// shortable / easy_to_borrow / tradable. Verified reachable from crucix (same
// creds that populate the live portfolio section).
// FALLBACK PATH (degraded, only when creds absent OR every API call errors): a
// conservative LIQUIDITY proxy using mcap_b from marketMovers (the only size
// field crucix has on directional names — their volume is NULL by design). This
// is honestly a liquidity proxy, NOT a borrow check: it reduces, not
// eliminates, unborrowable-short risk, and says so via borrow_status.
//
// FAIL CLOSED: any Alpaca error, missing data, or unfindable ticker results in a
// DOWNGRADE (SHORT -> WATCH with borrow_block), never a live SHORT shipped on
// faith. A gate failure degrades shorts; it must NEVER crash the sweep.
//
// PERSISTENCE: mutates each idea object in place. emitIdeas spreads all
// top-level idea fields ({ time, ...i }), so borrow_block / borrow_block_reason
// / squeeze_risk / borrow_verified / borrow_source / borrow_status all archive
// into the graphiti episode automatically — no bridge change. It ALSO prepends a
// short human-readable tag into `risk` (same trick lib/llm/ideas.mjs uses for
// shares_per_1k) so the flag survives any text-only narrative serialization and
// is regex-queryable downstream by the outcome loop.

import { assetBorrow, hasBorrowCreds } from '../../apis/sources/alpaca-borrow.mjs';

const _envNum = (v, d) => (v == null || v === '' ? d : Number(v));

// Master switch — disable without a rebuild if the gate ever misbehaves.
const GATE_ENABLED = process.env.CRUCIX_BORROW_GATE_ENABLED !== 'false';

// Fallback liquidity floor (creds-absent / API-down path). A SHORT-specific
// mcap floor, ABOVE the movers source floor (0.3B) because small-caps are the
// squeeze / hard-to-borrow zone. Env-driven, not a magic constant.
const SHORT_MIN_MCAP_B = _envNum(process.env.CRUCIX_SHORT_MIN_MCAP_B, 2.0);
const SHORT_MIN_PRICE  = _envNum(process.env.CRUCIX_SHORT_MIN_PRICE, 5);

// Squeeze advisory (does NOT block; thin-float rich names get flagged sized-small).
const SQUEEZE_MCAP_B   = _envNum(process.env.CRUCIX_SHORT_SQUEEZE_MCAP_B, 2.0);

function isShort(idea) {
  return String(idea?.type || '').toUpperCase() === 'SHORT';
}

/**
 * Look a ticker up in the sweep's marketMovers buckets to recover mcap_b / price
 * for the fallback liquidity floor (the only size field crucix has on
 * directional names). Returns null when the name isn't in the sweep universe.
 */
function findMoverFacts(sweep, ticker) {
  const sym = String(ticker || '').trim().toUpperCase();
  if (!sym) return null;
  const mm = sweep?.marketMovers || {};
  for (const bucket of ['gainers', 'losers', 'mostActive']) {
    for (const r of mm[bucket] || []) {
      if (r && String(r.symbol || '').toUpperCase() === sym) {
        return { mcap_b: r.mcap_b ?? null, price: r.price ?? null };
      }
    }
  }
  return null;
}

/** Prepend a queryable tag to `risk` without losing the original text. */
function prependRisk(idea, tag) {
  const cur = idea.risk ? String(idea.risk) : '';
  idea.risk = cur ? `${tag} — ${cur}` : tag;
}

/**
 * Downgrade a SHORT to WATCH with a borrow_block. Preserves the short thesis
 * (title/rationale/signals) so the outcome loop can later measure "borrow-blocked
 * shorts had grounding X but were uninvestable". Does NOT touch evidence_score /
 * grounding / confidence — only tradability changed, not the analysis.
 */
function downgrade(idea, reason, source) {
  idea.type = 'WATCH';
  idea.borrow_block = true;
  idea.borrow_block_reason = reason;
  idea.borrow_source = source;
  prependRisk(idea, `BORROW BLOCK: ${reason} — downgraded SHORT->WATCH [borrow_block]`);
}

/** Keep a SHORT but flag it (squeeze risk, or unverified borrow). Advisory only. */
function flagSqueeze(idea, reason, source) {
  idea.squeeze_risk = true;
  idea.squeeze_risk_reason = reason;
  idea.borrow_source = source;
  prependRisk(idea, `SQUEEZE RISK: ${reason} [squeeze_risk]`);
}

/**
 * Resolve a borrow verdict for one SHORT ticker.
 *  - Tries the REAL Alpaca asset flags first.
 *  - On any API error / missing creds, falls to the conservative liquidity
 *    fallback (mcap floor) — labeled 'borrow-unverified', never silently
 *    treated as borrowable.
 * Returns the verdict; the caller applies it to the idea.
 */
async function resolveVerdict(idea, sweep, credsPresent) {
  const ticker = idea?.ticker;

  // PRIMARY: real Alpaca shortability flags.
  if (credsPresent && ticker) {
    const a = await assetBorrow(ticker);
    if (a.ok) {
      // Not shortable / not tradable / not active -> hard block.
      if (!a.shortable || !a.tradable || (a.status && a.status !== 'active')) {
        return {
          action: 'block',
          source: 'alpaca-paper',
          reason: `not shortable per Alpaca asset flags (shortable=${a.shortable}, tradable=${a.tradable}, status=${a.status || '?'})`,
        };
      }
      // Shortable but hard-to-borrow -> ALLOW with squeeze flag (advisory, not a veto).
      if (!a.easy_to_borrow) {
        return {
          action: 'allow-squeeze',
          source: 'alpaca-paper',
          reason: 'hard-to-borrow per Alpaca (easy_to_borrow=false)',
        };
      }
      // Clean: shortable + easy_to_borrow.
      return { action: 'allow', source: 'alpaca-paper' };
    }
    // a.ok === false -> API unreachable / unknown symbol. FALL THROUGH to fallback.
  }

  // FALLBACK (degraded): liquidity proxy from marketMovers mcap_b. Honest label.
  const reasonPrefix = credsPresent
    ? 'borrow-unverified (Alpaca asset lookup unreachable)'
    : 'borrow-unverified (no trading creds)';
  const facts = findMoverFacts(sweep, ticker);
  if (!facts) {
    // Can't even size the float -> fail closed.
    return {
      action: 'block',
      source: 'fallback-liquidity',
      reason: `${reasonPrefix} and ticker not in sweep universe — borrow-unverifiable, manual check`,
    };
  }
  const { mcap_b, price } = facts;
  if (mcap_b != null && mcap_b < SHORT_MIN_MCAP_B) {
    return {
      action: 'block',
      source: 'fallback-liquidity',
      reason: `${reasonPrefix}; mcap $${mcap_b}B < $${SHORT_MIN_MCAP_B}B short floor (squeeze/hard-to-borrow zone) — manual check`,
    };
  }
  if (price != null && price < SHORT_MIN_PRICE) {
    return {
      action: 'block',
      source: 'fallback-liquidity',
      reason: `${reasonPrefix}; price $${price} < $${SHORT_MIN_PRICE} short floor — manual check`,
    };
  }
  // Passed the liquidity floor, but borrow is UNVERIFIED — say so, do not claim verified.
  // This is a liquidity proxy, NOT a borrow check: a large liquid name can still
  // be hard-to-borrow. The flag must carry that residual risk, never hide it.
  return {
    action: 'allow-unverified',
    source: 'fallback-liquidity',
    reason: `${reasonPrefix}; passes mcap/price liquidity floor — borrow-unverified, manual check before shorting`,
  };
}

/**
 * Apply the borrow gate to a SCORED idea array. Mutates ideas in place and also
 * returns the same array for convenience. Runs AFTER scoreIdeas so evidence_score
 * / grounding are already computed on the original SHORT thesis (preserved even
 * when we downgrade for feasibility).
 *
 * Crash-safe: wrapped in try/catch; on any internal error the input is returned
 * unchanged (ungated) rather than killing the sweep — but the per-ticker
 * resolution itself fails CLOSED (unverifiable shorts are downgraded).
 *
 * @param {Array<object>} ideas  scored idea array (from scoreIdeas)
 * @param {object} sweep         synthesized sweep (read-only; for fallback floor)
 * @returns {Promise<Array<object>>} the same array, gated in place
 */
export async function applyBorrowGate(ideas, sweep = {}) {
  if (!GATE_ENABLED) return ideas;
  if (!Array.isArray(ideas) || ideas.length === 0) return ideas ?? [];

  try {
    const shorts = ideas.filter(isShort);
    if (shorts.length === 0) return ideas; // nothing to gate

    const credsPresent = hasBorrowCreds();

    // Cache verdicts per unique ticker so a name appearing in several shorts hits
    // Alpaca once. Resolve all unique tickers in parallel (0-3 typically).
    const uniqueTickers = [...new Set(
      shorts.map((i) => String(i?.ticker || '').toUpperCase()).filter(Boolean),
    )];
    const verdictByTicker = new Map();
    await Promise.all(uniqueTickers.map(async (sym) => {
      // Use the first short with this ticker as the representative for resolution
      // (resolveVerdict only reads idea.ticker, which is the same for all).
      const rep = shorts.find((i) => String(i?.ticker || '').toUpperCase() === sym);
      try {
        verdictByTicker.set(sym, await resolveVerdict(rep, sweep, credsPresent));
      } catch (err) {
        // Per-ticker failure fails CLOSED — block rather than ship unverified.
        verdictByTicker.set(sym, {
          action: 'block',
          source: 'fallback-liquidity',
          reason: `borrow check errored (${err?.message || 'unknown'}) — fail closed, manual check`,
        });
      }
    }));

    let blocked = 0, squeeze = 0, unverified = 0, clean = 0;
    for (const idea of shorts) {
      const sym = String(idea?.ticker || '').toUpperCase();
      const v = verdictByTicker.get(sym) || {
        action: 'block', source: 'fallback-liquidity',
        reason: 'no verdict resolved — fail closed',
      };

      // Thin-float + rich squeeze advisory (applies on top of an allowed short).
      const facts = findMoverFacts(sweep, idea?.ticker);
      const thinFloat = facts && facts.mcap_b != null && facts.mcap_b < SQUEEZE_MCAP_B;

      switch (v.action) {
        case 'block':
          downgrade(idea, v.reason, v.source);
          blocked++;
          break;
        case 'allow-squeeze':
          flagSqueeze(idea, v.reason, v.source);
          idea.borrow_verified = true;
          squeeze++;
          break;
        case 'allow-unverified':
          idea.borrow_verified = false;
          idea.borrow_status = 'borrow-unverified, manual check';
          idea.borrow_source = v.source;
          prependRisk(idea, `BORROW UNVERIFIED: ${v.reason} [borrow_unverified]`);
          if (thinFloat) flagSqueeze(idea, `thin float (mcap < $${SQUEEZE_MCAP_B}B), borrow unverified`, v.source);
          unverified++;
          break;
        case 'allow':
        default:
          idea.borrow_verified = true;
          idea.borrow_source = v.source;
          if (thinFloat) {
            flagSqueeze(idea, `thin float (mcap < $${SQUEEZE_MCAP_B}B) on a borrowable name — size small`, v.source);
            squeeze++;
          } else {
            clean++;
          }
          break;
      }
    }

    console.log(
      `[Crucix] Borrow gate: ${shorts.length} SHORT(s) -> ${clean} clean, ` +
      `${squeeze} squeeze-flagged, ${unverified} borrow-unverified, ${blocked} blocked->WATCH ` +
      `(source: ${credsPresent ? 'alpaca-paper' : 'fallback-liquidity (no creds)'})`,
    );

    return ideas;
  } catch (err) {
    // A gate bug must not kill a sweep. Degrade to ungated shorts — but log loudly
    // so a silent "all shorts ungated" is visible, not mistaken for "no shorts".
    console.error('[Crucix] borrow gate failed (non-fatal, shorts ungated):', err?.message);
    return ideas;
  }
}
