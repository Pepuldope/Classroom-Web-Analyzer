import { jsonResponse } from "./_helpers.js";

export const config = { runtime: "edge" };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const CLIENT_ID = "786778645862-cejadrqj2edabpdlk0emsvb1gc2hdijs.apps.googleusercontent.com";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return;
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body: value,
  });
}

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!CLIENT_SECRET) return jsonResponse({ error: "GOOGLE_CLIENT_SECRET not configured" }, 500);

  const body = await req.json().catch(() => null);
  const code = body?.code;
  const redirectUri = body?.redirectUri || "postmessage";
  if (!code) return jsonResponse({ error: "code required" }, 400);

  const params = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.access_token) {
    return jsonResponse({ error: "token_exchange_failed", details: tokens }, 502);
  }

  const userinfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userinfoRes.ok) return jsonResponse({ error: "userinfo_failed" }, 502);
  const userinfo = await userinfoRes.json();

  if (tokens.refresh_token) {
    await kvSet(`refresh:${userinfo.sub}`, tokens.refresh_token);
  }

  return jsonResponse({
    access_token: tokens.access_token,
    expires_in: tokens.expires_in,
    sub: userinfo.sub,
    email: userinfo.email,
    name: userinfo.given_name || userinfo.name,
    has_refresh: !!tokens.refresh_token,
  });
}
