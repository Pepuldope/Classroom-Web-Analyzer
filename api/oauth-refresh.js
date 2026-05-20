import { jsonResponse } from "./_helpers.js";

export const config = { runtime: "edge" };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const CLIENT_ID = "786778645862-cejadrqj2edabpdlk0emsvb1gc2hdijs.apps.googleusercontent.com";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.result || null;
}

async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return;
  await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
}

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!CLIENT_SECRET) return jsonResponse({ error: "GOOGLE_CLIENT_SECRET not configured" }, 500);

  const body = await req.json().catch(() => null);
  const sub = body?.sub;
  if (!sub) return jsonResponse({ error: "sub required" }, 400);

  const refreshToken = await kvGet(`refresh:${sub}`);
  if (!refreshToken) return jsonResponse({ error: "no_refresh_token" }, 404);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const tokens = await r.json().catch(() => ({}));
  if (!r.ok || !tokens.access_token) {
    if (tokens.error === "invalid_grant") {
      await kvDel(`refresh:${sub}`);
      return jsonResponse({ error: "refresh_invalid" }, 401);
    }
    return jsonResponse({ error: "refresh_failed", details: tokens }, 502);
  }
  return jsonResponse({
    access_token: tokens.access_token,
    expires_in: tokens.expires_in,
  });
}
