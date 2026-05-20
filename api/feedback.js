import { verifyUser, jsonResponse } from "./_helpers.js";

export const config = { runtime: "edge" };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvLpush(key, value) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/lpush/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      body: value,
    });
  } catch {}
}

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const sub = await verifyUser(req);
  if (!sub) return jsonResponse({ error: "unauthorized" }, 401);

  let body;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "bad json" }, 400); }
  const text = (body?.text || "").toString().trim().slice(0, 4000);
  const category = (body?.category || "general").toString().slice(0, 32);
  if (!text) return jsonResponse({ error: "text required" }, 400);

  const entry = {
    sub,
    category,
    text,
    userAgent: req.headers.get("user-agent") || "",
    at: new Date().toISOString(),
  };
  await kvLpush("feedback:queue", JSON.stringify(entry));
  return jsonResponse({ ok: true });
}
