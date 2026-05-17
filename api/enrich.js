const PRIMARY_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
const BACKUP_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";

const SYSTEM_PROMPT = `You analyze Google Classroom assignments and return enrichment data as JSON. For each assignment you receive, judge:

- weight (1-5): combined importance + effort. 1 = quick/trivial. 5 = major project/exam.
- actionType: one of "submit_online" (homework to upload), "in_person" (test/quiz/presentation taken in class — no upload needed), "study_only" (preparation material like a study guide), "read_only" (just reading material/announcement).
- estimatedMinutes: realistic minutes a student needs to complete the task.
- actionVerb: short verb shown on a card. Examples: "Write", "Solve", "Read", "Study", "Practice", "Present", "Submit".
- oneLineSummary: under 90 chars, plain English description of what the student must actually do.

Respond with ONLY valid JSON in this exact shape, no prose:
{"enrichments":[{"id":"...","weight":3,"actionType":"submit_online","estimatedMinutes":30,"actionVerb":"Write","oneLineSummary":"..."}]}`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "OPENROUTER_API_KEY not configured" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || !Array.isArray(body.assignments) || body.assignments.length === 0) {
    res.status(400).json({ error: "assignments array required" });
    return;
  }

  const compact = body.assignments.map((a) => ({
    id: a.id,
    course: a.courseName,
    title: a.title,
    description: (a.description || "").slice(0, 800),
    materialsCount: Array.isArray(a.materials) ? a.materials.length : 0,
    workType: a.workType,
  }));

  const userMsg = `Enrich these ${compact.length} assignments. Respond with the JSON shape described.\n\n${JSON.stringify(compact)}`;

  const tryModel = async (model) => {
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
        max_tokens: 4000,
      }),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  };

  let result = await tryModel(PRIMARY_MODEL);
  if (!result.ok) result = await tryModel(BACKUP_MODEL);
  if (!result.ok) {
    res.status(502).json({ error: "AI enrichment failed", details: result.data });
    return;
  }

  const raw = result.data?.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch {}
    }
  }
  const enrichments = parsed?.enrichments;
  if (!Array.isArray(enrichments)) {
    res.status(502).json({ error: "AI returned unparseable response", raw });
    return;
  }
  res.status(200).json({ enrichments });
}
