/**
 * Emit crucix trade ideas to the qid-intelligence Graphiti bridge.
 *
 * The bridge accepts POST /ideas with either a single idea object,
 * an array, or {ideas: [...]}. We send the batch each sweep produces.
 *
 * Disabled by default; set CRUCIX_BRIDGE_URL (e.g.
 * http://crucix-bridge.qid.svc.cluster.local:8090) to enable.
 * Failures are logged and swallowed — bridge outage must not break a sweep.
 */

const BRIDGE_URL = process.env.CRUCIX_BRIDGE_URL || '';
const TIMEOUT_MS = Number(process.env.CRUCIX_BRIDGE_TIMEOUT_MS || 30000);

export function isGraphitiEmitEnabled() {
  return Boolean(BRIDGE_URL);
}

export async function emitIdeas(ideas, { sweepTime } = {}) {
  if (!BRIDGE_URL) return { skipped: true };
  if (!Array.isArray(ideas) || ideas.length === 0) return { skipped: true };

  const url = BRIDGE_URL.replace(/\/+$/, '') + '/ideas';
  const ts = sweepTime || new Date().toISOString();
  const enriched = ideas.map((i) => ({ time: ts, ...i }));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ideas: enriched }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error(`[GraphitiEmit] bridge ${resp.status}: ${text.slice(0, 200)}`);
      return { ok: false, status: resp.status };
    }
    return { ok: true, count: enriched.length };
  } catch (err) {
    console.error('[GraphitiEmit] bridge POST failed:', err.message);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}
