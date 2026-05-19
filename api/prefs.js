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

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.result || null;
}

async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body: value,
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`KV set failed: ${r.status} ${errText}`);
  }
}

function prefsKey(sub) {
  return `prefs:${sub}`;
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

  if (req.method === "GET") {
    try {
      const raw = await kvGet(prefsKey(sub));
      let prefs = {};
      if (raw) {
        try {
          let parsed = JSON.parse(raw);
          if (typeof parsed === "string") parsed = JSON.parse(parsed);
          if (parsed && typeof parsed === "object") prefs = parsed;
        } catch {}
      }
      return new Response(JSON.stringify({ prefs }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); }
    catch { return new Response(JSON.stringify({ error: "bad json" }), { status: 400 }); }
    if (!body || typeof body.prefs !== "object" || body.prefs === null) {
      return new Response(JSON.stringify({ error: "prefs object required" }), { status: 400 });
    }
    try {
      await kvSet(prefsKey(sub), JSON.stringify(body.prefs));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
}
