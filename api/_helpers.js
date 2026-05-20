const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

export const DEFAULT_DAILY_LIMIT = 50;

const tokenSubCache = new Map();
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

export async function verifyUser(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const cached = tokenSubCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.sub;
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.sub) {
      tokenSubCache.set(token, { sub: data.sub, expires: Date.now() + TOKEN_CACHE_TTL_MS });
      if (tokenSubCache.size > 100) {
        const oldest = tokenSubCache.keys().next().value;
        tokenSubCache.delete(oldest);
      }
    }
    return data.sub || null;
  } catch { return null; }
}

export function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

export function rateKey(sub) {
  return `rate:${sub}:${todayUTC()}`;
}

export async function checkAndIncrementRate(sub, limit = DEFAULT_DAILY_LIMIT) {
  if (!KV_URL || !KV_TOKEN) return { ok: true, count: 0, limit };
  const key = rateKey(sub);
  try {
    const r = await fetch(`${KV_URL}/incr/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return { ok: true, count: 0, limit };
    const data = await r.json();
    const count = Number(data.result) || 0;
    if (count === 1) {
      await fetch(`${KV_URL}/expire/${encodeURIComponent(key)}/86400`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
    }
    return { ok: count <= limit, count, limit };
  } catch { return { ok: true, count: 0, limit }; }
}

export async function readRate(sub, limit = DEFAULT_DAILY_LIMIT) {
  if (!KV_URL || !KV_TOKEN) return { count: 0, limit };
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(rateKey(sub))}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return { count: 0, limit };
    const data = await r.json();
    return { count: Number(data.result) || 0, limit };
  } catch { return { count: 0, limit }; }
}

export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
