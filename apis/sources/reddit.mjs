// Reddit — social sentiment intelligence (enriched)
// Uses OAuth for API access. Fetches post body, upvotes, comment count, and
// top 3 comments per post. Applies lexical financial sentiment per ticker mention.
// To enable: register an app at https://www.reddit.com/prefs/apps/ and set
// REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env

import { safeFetch } from '../utils/fetch.mjs';
import '../utils/env.mjs';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

const SUBREDDITS = [
  'wallstreetbets',
  'stocks',
  'investing',
  'options',
  'Stockmarket',
];

// Lexical financial sentiment approximation (covers the signal FinBERT targets)
const BULLISH_TERMS = [
  'bullish', 'buy', 'long', 'calls', 'moon', 'breakout', 'upside', 'beat',
  'rally', 'squeeze', 'undervalued', 'accumulate', 'strong', 'outperform',
  'buy the dip', 'going up', 'rip', 'yolo calls',
];
const BEARISH_TERMS = [
  'bearish', 'sell', 'short', 'puts', 'crash', 'dump', 'overvalued',
  'miss', 'decline', 'rekt', 'downside', 'baghold', 'avoid', 'weak',
  'underperform', 'tank', 'drill', 'going down', 'yolo puts',
];

function lexicalSentiment(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const b = BULLISH_TERMS.filter(t => lower.includes(t)).length;
  const bear = BEARISH_TERMS.filter(t => lower.includes(t)).length;
  if (b === 0 && bear === 0) return null;
  if (b > bear) return 'bullish';
  if (bear > b) return 'bearish';
  return 'neutral';
}

async function getToken() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Crucix/1.0 intelligence-engine',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token || null;
  } catch {
    return null;
  }
}

async function getHot(subreddit, token, limit = 10) {
  const headers = { 'User-Agent': 'Crucix/1.0 intelligence-engine' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const base = token ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
  const suffix = token ? '' : '.json';
  return safeFetch(`${base}/r/${subreddit}/hot${suffix}?limit=${limit}&raw_json=1`, { headers });
}

async function getTopComments(postId, subreddit, token, limit = 3) {
  const headers = { 'User-Agent': 'Crucix/1.0 intelligence-engine' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const base = token ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
  const suffix = token ? '' : '.json';
  try {
    const data = await safeFetch(
      `${base}/r/${subreddit}/comments/${postId}${suffix}?limit=${limit}&depth=1&raw_json=1`,
      { headers }
    );
    const comments = data?.[1]?.data?.children || [];
    return comments
      .filter(c => c.kind === 't1' && c.data?.body)
      .slice(0, limit)
      .map(c => ({
        body: c.data.body.slice(0, 200),
        score: c.data.score ?? 0,
        sentiment: lexicalSentiment(c.data.body),
      }));
  } catch {
    return [];
  }
}

function enrichPost(child, subreddit) {
  const d = child?.data;
  if (!d) return null;
  const bodyText = [d.title, d.selftext || ''].join(' ');
  return {
    id: d.id,
    subreddit,
    title: d.title,
    body: (d.selftext || '').slice(0, 500),
    score: d.score ?? 0,
    comments: d.num_comments ?? 0,
    url: d.url,
    created: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
    sentiment: lexicalSentiment(bodyText),
  };
}

export async function briefing() {
  const token = await getToken();

  if (!token && !process.env.REDDIT_CLIENT_ID) {
    return {
      source: 'RedditEnriched',
      timestamp: new Date().toISOString(),
      status: 'no_key',
      message: 'Reddit requires OAuth. Register at https://www.reddit.com/prefs/apps/ (script type), set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.',
    };
  }

  const subredditResults = {};
  for (const sub of SUBREDDITS) {
    const result = await getHot(sub, token, 10);
    const children = result?.data?.children || [];
    const posts = children.map(c => enrichPost(c, sub)).filter(Boolean);

    // Fetch top comments for first 3 posts to stay within rate limits
    for (const post of posts.slice(0, 3)) {
      post.topComments = await getTopComments(post.id, sub, token, 3);
      await delay(token ? 500 : 1500);
    }
    for (const post of posts.slice(3)) {
      post.topComments = [];
    }

    subredditResults[sub] = posts;
    await delay(token ? 1000 : 2000);
  }

  // Ticker extraction: collect mentions across all posts + comments
  const tickerMentions = {};
  const TICKER_RE = /\b([A-Z]{2,5})\b/g;
  for (const [sub, posts] of Object.entries(subredditResults)) {
    for (const post of posts) {
      const allText = [post.title, post.body, ...(post.topComments || []).map(c => c.body)].join(' ');
      for (const [, ticker] of allText.matchAll(TICKER_RE)) {
        if (!tickerMentions[ticker]) tickerMentions[ticker] = { mentions: 0, subreddits: new Set(), sentiment: [] };
        tickerMentions[ticker].mentions++;
        tickerMentions[ticker].subreddits.add(sub);
        if (post.sentiment) tickerMentions[ticker].sentiment.push(post.sentiment);
      }
    }
  }

  // Top tickers by mention count (exclude common non-ticker words)
  const STOP_WORDS = new Set(['FOR', 'THE', 'AND', 'ARE', 'NOT', 'BUT', 'ALL', 'CAN', 'NEW', 'NOW', 'OUT', 'GET', 'HAS', 'HIM', 'HIS', 'HOW', 'ITS', 'MAY', 'WAS', 'WHO', 'WHY', 'YES', 'YOU', 'ANY', 'ETF', 'USD', 'CEO', 'IPO', 'EPS', 'YOY', 'TTM', 'ATH', 'ATL', 'WSB', 'DD', 'IMO', 'TBH', 'FYI', 'GDP', 'CPI', 'PPI', 'FED', 'SEC', 'VIX', 'RSI', 'MACD', 'OTM', 'ITM', 'SPY', 'QQQ', 'IWM', 'DIA', 'TLT', 'GLD', 'SLV', 'OIL', 'USO', 'XLE', 'XLF', 'XBI', 'ARK', 'USA', 'IRA', 'LLC']);
  const topTickers = Object.entries(tickerMentions)
    .filter(([t]) => !STOP_WORDS.has(t) && t.length >= 2)
    .map(([ticker, data]) => {
      const sentiments = data.sentiment;
      const bullCount = sentiments.filter(s => s === 'bullish').length;
      const bearCount = sentiments.filter(s => s === 'bearish').length;
      return {
        ticker,
        mentions: data.mentions,
        subreddits: Array.from(data.subreddits),
        bullishPct: sentiments.length > 0 ? Math.round((bullCount / sentiments.length) * 100) : null,
      };
    })
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 20);

  return {
    source: 'RedditEnriched',
    timestamp: new Date().toISOString(),
    subreddits: subredditResults,
    topTickers,
  };
}

if (process.argv[1]?.endsWith('reddit.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
