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
  if (!KV_URL || !KV_TOKEN) throw new Error("KV not configured");
  const url = `${KV_URL}/${[command, ...args].map(encodeURIComponent).join("/")}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) throw new Error(`KV ${command} failed: ${r.status}`);
  const data = await r.json();
  return data.result;
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) throw new Error("KV not configured");
  const url = `${KV_URL}/set/${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body: value,
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`KV set failed: ${r.status} ${errText}`);
  }
}

function chatKey(sub, assignmentId) {
  return `chat:${sub}:${assignmentId}`;
}
function indexKey(sub) {
  return `chat-index:${sub}`;
}

export default async function handler(req) {
  if (!KV_URL || !KV_TOKEN) {
    return new Response(JSON.stringify({ error: "storage_not_configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sub = await verifyUser(req);
  if (!sub) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const assignmentId = url.searchParams.get("assignmentId");

  if (req.method === "GET") {
    if (!assignmentId) return new Response(JSON.stringify({ error: "assignmentId required" }), { status: 400 });
    try {
      const raw = await kv("get", chatKey(sub, assignmentId));
      let messages = [];
      if (raw) {
        try {
          let parsed = JSON.parse(raw);
          if (typeof parsed === "string") parsed = JSON.parse(parsed);
          if (Array.isArray(parsed)) messages = parsed;
        } catch {}
      }
      return new Response(JSON.stringify({ messages }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  if (req.method === "POST") {
    if (!assignmentId) return new Response(JSON.stringify({ error: "assignmentId required" }), { status: 400 });
    let body;
    try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "bad json" }), { status: 400 }); }
    if (!Array.isArray(body.messages)) return new Response(JSON.stringify({ error: "messages array required" }), { status: 400 });
    try {
      await kvSet(chatKey(sub, assignmentId), JSON.stringify(body.messages));
      await kv("sadd", indexKey(sub), assignmentId);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  if (req.method === "DELETE") {
    if (!assignmentId) return new Response(JSON.stringify({ error: "assignmentId required" }), { status: 400 });
    try {
      await kv("del", chatKey(sub, assignmentId));
      await kv("srem", indexKey(sub), assignmentId);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
}
