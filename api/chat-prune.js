export const config = { runtime: "edge" };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function verifyUser(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.sub || null;
}

async function kv(command, ...args) {
  const url = `${KV_URL}/${[command, ...args].map(encodeURIComponent).join("/")}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) throw new Error(`KV ${command} failed: ${r.status}`);
  const data = await r.json();
  return data.result;
}

export default async function handler(req) {
  if (!KV_URL || !KV_TOKEN) {
    return new Response(JSON.stringify({ error: "storage_not_configured" }), { status: 503 });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
  }

  const sub = await verifyUser(req);
  if (!sub) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "bad json" }), { status: 400 }); }
  if (!Array.isArray(body.keepIds)) {
    return new Response(JSON.stringify({ error: "keepIds array required" }), { status: 400 });
  }

  try {
    const keepSet = new Set(body.keepIds.map(String));
    const existing = (await kv("smembers", `chat-index:${sub}`)) || [];
    const toDelete = existing.filter((id) => !keepSet.has(String(id)));
    await Promise.all(toDelete.map(async (id) => {
      await kv("del", `chat:${sub}:${id}`);
      await kv("srem", `chat-index:${sub}`, id);
    }));
    return new Response(JSON.stringify({ ok: true, deleted: toDelete.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
