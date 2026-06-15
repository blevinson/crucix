// Alpaca Portfolio — current account state for the trader's paper account.
//
// Surfaces buying power + open positions to the LLM prompt so trade ideas can
// account for existing exposure (avoid duplicating, recommend hedges, etc.).
//
// Reads the same Alpaca API tradefarm-paper uses. Credentials live in the
// alpaca-paper-credentials secret (qid ns) — separate from tradefarm-secrets
// so we never accidentally read the live (real-money) account.
//
// Failure mode: returns { error, ... } with empty positions; the LLM prompt
// will simply omit the portfolio section. Never throws, never blocks a sweep.

import { safeFetch } from '../utils/fetch.mjs';

const BASE = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const KEY  = process.env.ALPACA_API_KEY  || '';
const SEC  = process.env.ALPACA_API_SECRET || '';

// Cap how many positions we surface — large portfolios bloat the prompt.
const MAX_POSITIONS = parseInt(process.env.CRUCIX_PORTFOLIO_MAX_POSITIONS || '20', 10);

function _headers() {
  return {
    'APCA-API-KEY-ID':     KEY,
    'APCA-API-SECRET-KEY': SEC,
    accept:                'application/json',
  };
}

async function _get(path) {
  return safeFetch(`${BASE}${path}`, { timeout: 8000, headers: _headers() });
}

function _shapeAccount(a) {
  if (!a || typeof a !== 'object' || a.error) return null;
  const num = (v) => (v == null ? null : Number(v));
  return {
    account_number: a.account_number,
    status:         a.status,
    equity:         num(a.equity),
    last_equity:    num(a.last_equity),
    cash:           num(a.cash),
    buying_power:   num(a.buying_power),
    portfolio_value: num(a.portfolio_value),
    daytrade_count:  num(a.daytrade_count),
    pattern_day_trader: Boolean(a.pattern_day_trader),
    // Day P&L: equity - last_equity is the simple delta since last close.
    day_pl:        num(a.equity) != null && num(a.last_equity) != null
                     ? Math.round((num(a.equity) - num(a.last_equity)) * 100) / 100
                     : null,
    day_pl_pct:    num(a.equity) != null && num(a.last_equity)
                     ? Math.round(((num(a.equity) - num(a.last_equity)) / num(a.last_equity)) * 10000) / 100
                     : null,
  };
}

function _shapePosition(p) {
  const num = (v) => (v == null ? null : Number(v));
  return {
    symbol:           p.symbol,
    asset_class:      p.asset_class,
    side:             p.side,
    qty:              num(p.qty),
    avg_entry_price:  num(p.avg_entry_price),
    current_price:    num(p.current_price),
    market_value:     num(p.market_value),
    cost_basis:       num(p.cost_basis),
    unrealized_pl:    num(p.unrealized_pl),
    unrealized_plpc:  num(p.unrealized_plpc),
    change_today:     num(p.change_today),
  };
}

export async function collect() {
  if (!KEY || !SEC) {
    return {
      error: 'ALPACA_API_KEY/SECRET not set',
      account: null, positions: [], summary: 'no alpaca credentials',
    };
  }

  // Both calls in parallel — they're independent.
  const [accountRaw, positionsRaw] = await Promise.all([
    _get('/v2/account'),
    _get('/v2/positions'),
  ]);

  if (accountRaw?.error) {
    return { error: accountRaw.error, account: null, positions: [], summary: `account fetch failed: ${accountRaw.error}` };
  }

  const account = _shapeAccount(accountRaw);
  const positions = Array.isArray(positionsRaw)
    ? positionsRaw.map(_shapePosition).slice(0, MAX_POSITIONS)
    : [];

  // Roll up by asset class so the LLM sees "you hold 1 equity + 10 option contracts"
  // at a glance. Useful for "should I add another long" reasoning.
  const byClass = positions.reduce((acc, p) => {
    const k = p.asset_class || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  // Total absolute exposure across positions.
  const grossExposure = positions.reduce((s, p) => s + Math.abs(p.market_value || 0), 0);
  const totalUnrealizedPl = positions.reduce((s, p) => s + (p.unrealized_pl || 0), 0);

  const summary = account
    ? `equity=$${account.equity}, buying_power=$${account.buying_power}, ` +
      `${positions.length} positions, gross_exposure=$${grossExposure.toFixed(2)}, ` +
      `unr_pl=$${totalUnrealizedPl.toFixed(2)} ` +
      `(${Object.entries(byClass).map(([k,v]) => `${v} ${k}`).join(', ') || 'no positions'})`
    : 'no account data';

  return {
    asof: new Date().toISOString(),
    summary,
    account,
    positions,
    by_class: byClass,
    gross_exposure: Math.round(grossExposure * 100) / 100,
    total_unrealized_pl: Math.round(totalUnrealizedPl * 100) / 100,
  };
}

export async function briefing() {
  return collect();
}
