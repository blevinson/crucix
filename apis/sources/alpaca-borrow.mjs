// Alpaca Borrow — per-symbol shortability / easy-to-borrow flags for the
// deterministic post-LLM borrow gate (P4).
//
// Piggybacks on the SAME trading-API creds alpaca-portfolio.mjs uses
// (alpaca-paper-credentials secret, qid ns). GET /v2/assets/{symbol} lives on
// the same host (paper-api.alpaca.markets) with the same two auth headers, so
// if the portfolio section is populated this endpoint authorizes too.
//
// IMPORTANT — these are PAPER-account asset flags. `shortable`/`easy_to_borrow`
// reflect Alpaca's best-effort securities-lending universe at sweep time on the
// paper venue. They are NOT a guaranteed live locate at execution and carry NO
// borrow rate. The gate is a feasibility screen, not a net-EV proof; the real
// net-of-borrow number comes from the instrumented account's realized short-leg
// return. Callers must label borrow_source accordingly.
//
// Failure mode: returns { ok:false, reason } on any error (404 unknown symbol,
// auth failure, timeout, missing creds). safeFetch never throws, so a borrow
// lookup can never crash the sweep. An unverifiable result FAILS CLOSED at the
// gate (the short is downgraded, not shipped live).

import { safeFetch } from '../utils/fetch.mjs';

const BASE = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const KEY  = process.env.ALPACA_API_KEY  || '';
const SEC  = process.env.ALPACA_API_SECRET || '';

const TIMEOUT_MS = Number(process.env.CRUCIX_BORROW_TIMEOUT_MS || 6000);

function _headers() {
  return {
    'APCA-API-KEY-ID':     KEY,
    'APCA-API-SECRET-KEY': SEC,
    accept:                'application/json',
  };
}

/**
 * True when trading creds are present. When false, the gate must skip the API
 * entirely and use the conservative liquidity fallback.
 */
export function hasBorrowCreds() {
  return Boolean(KEY && SEC);
}

/**
 * Look up Alpaca's shortability flags for a single symbol.
 *
 * @param {string} symbol
 * @returns {Promise<{ok:boolean, reason?:string, tradable?:boolean,
 *   shortable?:boolean, easy_to_borrow?:boolean, fractionable?:boolean,
 *   status?:string}>}
 *   - ok:true  with the asset flags on a 200.
 *   - ok:false with a reason on any error (treated as UNVERIFIED by the gate,
 *     which then falls to the conservative fallback — never crashes).
 */
export async function assetBorrow(symbol) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return { ok: false, reason: 'empty symbol' };
  if (!hasBorrowCreds()) return { ok: false, reason: 'no trading creds' };

  const a = await safeFetch(`${BASE}/v2/assets/${encodeURIComponent(sym)}`, {
    timeout: TIMEOUT_MS,
    headers: _headers(),
  });

  // safeFetch returns { error } on non-2xx/timeout (404 unknown symbol, auth
  // failure) and never throws. Degrade to UNVERIFIED — the gate fails closed.
  if (!a || a.error) {
    return { ok: false, reason: a?.error || 'fetch failed' };
  }

  return {
    ok:             true,
    tradable:       !!a.tradable,
    shortable:      !!a.shortable,
    easy_to_borrow: !!a.easy_to_borrow,
    fractionable:   !!a.fractionable,
    status:         a.status || null,
  };
}
