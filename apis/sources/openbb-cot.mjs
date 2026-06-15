// CFTC Commitments of Traders — weekly futures positioning
//
// Pulls latest COT report for a curated set of major futures via the
// in-cluster openbb-api. Calc'd net positioning + speculator-vs-commercial
// imbalance feeds the LLM prompt as a regime overlay: when specs are
// crowded long and commercials net short, that's a contrarian top signal
// (and vice-versa for bottoms).
//
// COT data updates Friday afternoons for the prior Tuesday's positions.
// Latency-tolerant — we cache the briefing data 24h via crucix's normal
// sweep cycle (15min sweeps, but COT data only changes weekly).
//
// Free via the cftc provider — no API key needed (Socrata).

import { safeFetch } from '../utils/fetch.mjs';

const BASE = process.env.OPENBB_API_URL || 'http://openbb-api.qid.svc.cluster.local:6900';
const TOKEN = process.env.OPENBB_API_TOKEN || '';

// CFTC contract market codes — the major ones traders watch.
// Codes from publicreporting.cftc.gov. All legacy report (most data depth).
const FUTURES = [
  { code: '088691', label: 'Gold' },
  { code: '084691', label: 'Silver' },
  { code: '067651', label: 'EUR_USD' },
  { code: '098662', label: 'JPY_USD' },
  { code: '13874A', label: 'SP500_E_mini' },
  { code: '209742', label: 'Nasdaq100_E_mini' },
  { code: '023391', label: 'Corn' },
  { code: '067411', label: 'Crude_WTI' },
  { code: '023651', label: 'Wheat_HRW' },
  { code: '020601', label: 'Treasury_10Y' },
];

async function fetchCotLatest(code, label) {
  if (!TOKEN) return { label, error: 'OPENBB_API_TOKEN not set' };
  const url = `${BASE}/api/v1/regulators/cftc/cot?code=${code}&provider=cftc`;
  try {
    const res = await safeFetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const rows = res?.results || [];
    if (!rows.length) return { label, error: 'no rows' };
    const latest = rows[rows.length - 1];
    const ncL = Number(latest.noncomm_positions_long_all || 0);
    const ncS = Number(latest.noncomm_positions_short_all || 0);
    const cL = Number(latest.comm_positions_long_all || 0);
    const cS = Number(latest.comm_positions_short_all || 0);
    const oi = Number(latest.open_interest_all || 0);
    const specNet = ncL - ncS;
    const commNet = cL - cS;
    // Spec net as % of OI — a crude proxy for "crowdedness". Above ~25% =
    // historically extreme long; below -25% = extreme short.
    const specNetPctOi = oi > 0 ? Math.round((specNet / oi) * 1000) / 10 : null;
    return {
      label,
      report_date: latest.date,
      open_interest: oi,
      spec_long: ncL,
      spec_short: ncS,
      spec_net: specNet,
      spec_net_pct_oi: specNetPctOi,
      comm_long: cL,
      comm_short: cS,
      comm_net: commNet,
    };
  } catch (e) {
    return { label, error: e.message };
  }
}

export async function briefing() {
  const results = await Promise.allSettled(FUTURES.map(f => fetchCotLatest(f.code, f.label)));
  const positioning = results.map(r =>
    r.status === 'fulfilled' ? r.value : { error: r.reason?.message }
  );
  // Group: extreme long (top zone), extreme short (bottom zone), neutral
  const extremeLong = positioning.filter(p => p.spec_net_pct_oi != null && p.spec_net_pct_oi >= 25);
  const extremeShort = positioning.filter(p => p.spec_net_pct_oi != null && p.spec_net_pct_oi <= -25);
  return {
    source: 'CFTC_COT',
    note: 'Weekly futures positioning. spec_net_pct_oi >= 25% = crowded long (top zone); <= -25% = crowded short (bottom zone). Spec/comm divergence = contrarian setup.',
    report_date_latest: positioning[0]?.report_date || null,
    positioning,
    extreme_long: extremeLong.map(p => `${p.label}=${p.spec_net_pct_oi}%`),
    extreme_short: extremeShort.map(p => `${p.label}=${p.spec_net_pct_oi}%`),
  };
}
