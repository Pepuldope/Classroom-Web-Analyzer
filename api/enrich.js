export const config = { runtime: "edge" };

const PRIMARY_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";
const BACKUP_MODEL = "nvidia/nemotron-nano-9b-v2:free";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const SYSTEM_PROMPT = `You analyze a Google Classroom assignment and return JSON. Judge these four fields:

- weight (1-5): importance + effort. 1=trivial, 3=normal homework, 5=major exam/project.
- actionType: one of "submit_online" (homework to upload), "in_person" (test/quiz/presentation taken in class — no upload needed), "study_only" (study guide / prep material), "read_only" (just reading material/announcement). KEEP THIS FIELD IN ENGLISH.
- estimatedMinutes: realistic minutes. Be CONSERVATIVE: homework 10-30 min, worksheets 15-25, essays 45-90, big projects 2-4h.
- oneLineSummary: under 90 chars, plain description of what to do. IN THE SAME LANGUAGE AS THE ASSIGNMENT. Never translate.

Respond with ONLY this JSON, no prose:
{"weight":3,"actionType":"submit_online","estimatedMinutes":30,"oneLineSummary":"..."}`;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.result || null;
  } catch { return null; }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      body: value,
    });
  } catch {}
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "OPENROUTER_API_KEY not configured" }), { status: 500 });
  }

  let body;
  try { body = await req.json(); } catch { body = null; }
  if (!body || !Array.isArray(body.assignments) || body.assignments.length === 0) {
    return new Response(JSON.stringify({ error: "assignments array required" }), { status: 400 });
  }

  const results = await Promise.all(body.assignments.slice(0, 5).map(async (a) => {
    const hash = a.contentHash || "";
    const cacheKey = `enrich:${a.id}:${hash}`;
    const cached = await kvGet(cacheKey);
    if (cached) {
      try { return { id: a.id, ...JSON.parse(cached) }; } catch {}
    }

    const userMsg = `Course: ${a.courseName}\nTitle: ${a.title}\nWork type: ${a.workType || "ASSIGNMENT"}\nDescription: ${(a.description || "").slice(0, 250)}`;

    const callModel = async (model) => {
      try {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://classroom-web-analyzer.vercel.app",
            "X-Title": "Classroom Web Analyzer",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMsg },
            ],
            response_format: { type: "json_object" },
            max_tokens: 400,
            temperature: 0.2,
          }),
        });
        if (!r.ok) return null;
        const data = await r.json().catch(() => null);
        return data?.choices?.[0]?.message?.content || null;
      } catch { return null; }
    };

    let raw = await callModel(PRIMARY_MODEL);
    if (!raw) raw = await callModel(BACKUP_MODEL);
    if (!raw) return { id: a.id, error: "ai_failed" };

    let parsed = null;
    try { parsed = JSON.parse(raw); }
    catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed || typeof parsed !== "object") return { id: a.id, error: "parse_failed" };

    if (hash) await kvSet(cacheKey, JSON.stringify(parsed));
    return { id: a.id, ...parsed };
  }));

  const enrichments = results.filter((r) => r && !r.error);
  return new Response(JSON.stringify({ enrichments }), {
    headers: { "Content-Type": "application/json" },
  });
}
