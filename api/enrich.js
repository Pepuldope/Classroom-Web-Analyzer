export const config = { runtime: "edge" };

const PRIMARY_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";
const BACKUP_MODEL = "nvidia/nemotron-nano-9b-v2:free";

const SYSTEM_PROMPT = `You analyze Google Classroom assignments and return enrichment data as JSON. For each assignment you receive, judge:

- weight (1-5): combined importance + effort. 1 = quick/trivial. 5 = major project/exam.
- actionType: one of "submit_online" (homework to upload), "in_person" (test/quiz/presentation taken in class — no upload needed), "study_only" (preparation material like a study guide), "read_only" (just reading material/announcement). KEEP THIS FIELD IN ENGLISH — it is a programmatic enum.
- estimatedMinutes: realistic minutes a student needs. Be CONSERVATIVE — most homework is 10-30 min, worksheets 15-25 min, essays 45-90 min, big projects 2-4h.
- actionVerb: short verb shown on a card. WRITE IN THE SAME LANGUAGE AS THE ASSIGNMENT TITLE/DESCRIPTION. Slovak: "Napísať", "Vyriešiť", "Prečítať", "Naučiť sa", "Precvičiť", "Prezentovať", "Odovzdať". English: "Write", "Solve", "Read", "Study", "Practice", "Present", "Submit". Match the assignment's language.
- oneLineSummary: under 90 chars, plain description of what the student must do. WRITE IN THE SAME LANGUAGE AS THE ASSIGNMENT. Never translate.

Respond with ONLY valid JSON in this exact shape, no prose:
{"enrichments":[{"id":"...","weight":3,"actionType":"submit_online","estimatedMinutes":30,"actionVerb":"Napísať","oneLineSummary":"..."}]}`;

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

  const compact = body.assignments.slice(0, 15).map((a) => ({
    id: a.id,
    course: a.courseName,
    title: a.title,
    desc: (a.description || "").slice(0, 250),
    workType: a.workType,
  }));

  const userMsg = `Enrich these ${compact.length} assignments. Respond with the JSON shape described.\n\n${JSON.stringify(compact)}`;

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
          max_tokens: 6000,
          temperature: 0.2,
        }),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: String(e) } };
    }
  };

  let result = await callModel(PRIMARY_MODEL);
  if (!result.ok) result = await callModel(BACKUP_MODEL);
  if (!result.ok) {
    return new Response(JSON.stringify({ error: "AI enrichment failed", upstreamStatus: result.status, details: result.data }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const raw = result.data?.choices?.[0]?.message?.content || "";
  let enrichments = tryParse(raw);
  if (!Array.isArray(enrichments)) {
    enrichments = salvageItems(raw);
  }
  if (!Array.isArray(enrichments) || enrichments.length === 0) {
    return new Response(JSON.stringify({ error: "AI returned unparseable response", raw: raw.slice(0, 500) }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ enrichments }), {
    headers: { "Content-Type": "application/json" },
  });
}

function tryParse(raw) {
  try { return JSON.parse(raw)?.enrichments; } catch {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0])?.enrichments; } catch {} }
  return null;
}

function salvageItems(raw) {
  const items = [];
  const re = /\{[^{}]*"id"\s*:\s*"[^"]+"[^{}]*\}/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && typeof obj.id === "string") items.push(obj);
    } catch {}
  }
  return items;
}
