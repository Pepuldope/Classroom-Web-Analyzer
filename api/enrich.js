import { verifyUser, checkAndIncrementRate, jsonResponse } from "./_helpers.js";

export const config = { runtime: "edge" };

const PRIMARY_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";
const BACKUP_MODEL = "nvidia/nemotron-nano-9b-v2:free";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const SYSTEM_PROMPT = `You analyze a Google Classroom assignment and return JSON. Judge these five fields:

- weight (1-5): importance + effort. 1=trivial, 3=normal homework, 5=major exam/project.
- actionType: determined by what the student must DO, not by workType. One of:
  * "submit_online" — student must UPLOAD/TURN IN a deliverable through Classroom (essay, document, photo of work, code, completed Google Doc/Form). Description usually says "upload", "submit", "turn in", "odovzdaj", "nahraj", or attaches a Doc/Slides for the student to fill in and submit.
  * "in_person" — assessment happens IN CLASS with no upload (test, quiz, exam, presentation, oral exam, lab demo, písomka, skúška, kvíz, prezentácia, vstupný test, ústna skúška). Any task whose name or description suggests an in-class evaluation is in_person, even if Classroom shows it as a generic assignment.
  * "study_only" — preparation work for a future lesson. Read in advance, prepare to discuss, study for an upcoming quiz, work in a paper notebook, bring something to next class. Description mentions "prepare for", "pripravte sa", "na ďalšiu hodinu", "do zošita", "bring to class", "we will discuss", or asks for prep with no upload mechanism.
  * "read_only" — passive reading material, announcement, FYI post. No real task expected.

  TIEBREAKER: if the description does NOT explicitly tell the student to UPLOAD or TURN IN something, prefer "study_only" or "in_person" over "submit_online". Don't assume submission just because Classroom shows it as an assignment.
- taskKind: ONE specific noun describing what this assignment IS. Pick the MOST SPECIFIC from: "Quiz", "Test", "Exam", "Worksheet", "Essay", "Project", "Reading", "Lab", "Presentation", "Video", "Research", "Practice", "Question", "Discussion", "Interview", "Translation", "Drawing", "Recording", "Notes", "Review", "Report", "Analysis", "Problem set", "Vocabulary", "Listening". Always English, always one or two words. NEVER use generic words like "Assignment", "Task", "Homework", or "Work" — those tell the student nothing. If genuinely unclear, pick the closest specific kind.
- estimatedMinutes: realistic minutes a student needs. ALWAYS REQUIRED — return a positive integer, never null, never 0, never omit. Be CONSERVATIVE: homework 10-30, worksheets 15-25, essays 45-90, big projects 120-240, in-person tests 30-60 (for study time), quick readings 10-20. If genuinely unsure, default to 20.
- oneLineSummary: under 90 chars, plain description of what to do. IN THE SAME LANGUAGE AS THE ASSIGNMENT. Never translate. Use ONLY real existing words in that language — if you're unsure how to phrase something in Slovak (or whatever the language is), use simpler vocabulary you are 100% confident is correct. NEVER invent words, NEVER mix languages within a sentence, NEVER conjugate foreign verbs with native endings. When possible, reuse phrasing from the assignment description itself rather than paraphrasing.

Respond with ONLY this JSON, no prose:
{"weight":3,"actionType":"submit_online","taskKind":"Worksheet","estimatedMinutes":30,"oneLineSummary":"..."}`;

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

  const sub = await verifyUser(req);
  if (!sub) return jsonResponse({ error: "unauthorized" }, 401);

  const rate = await checkAndIncrementRate(sub);
  if (!rate.ok) {
    return jsonResponse({ error: "rate_limited", count: rate.count, limit: rate.limit }, 429);
  }

  let body;
  try { body = await req.json(); } catch { body = null; }
  if (!body || !Array.isArray(body.assignments) || body.assignments.length === 0) {
    return new Response(JSON.stringify({ error: "assignments array required" }), { status: 400 });
  }

  const results = await Promise.all(body.assignments.slice(0, 5).map(async (a) => {
    const hash = a.contentHash || "";
    const PROMPT_VERSION = "v5";
    const cacheKey = `enrich:${PROMPT_VERSION}:${a.id}:${hash}`;
    const cached = await kvGet(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.taskKind && Number.isFinite(parsed.estimatedMinutes) && parsed.estimatedMinutes > 0) {
          return { id: a.id, ...parsed };
        }
      } catch {}
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

    const minutes = Number(parsed.estimatedMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) parsed.estimatedMinutes = 20;
    else parsed.estimatedMinutes = Math.round(minutes);

    const title = (a.title || "").toLowerCase();
    const desc = (a.description || "").slice(0, 400).toLowerCase();
    const haystack = `${title} ${desc}`;

    // Word-boundary keyword matcher. Some keywords are multi-word; treat as substrings,
    // others as standalone words to avoid false matches like "test yourself" / "contest".
    const hasWord = (text, words) => words.some((w) => {
      if (w.includes(" ")) return text.includes(w);
      return new RegExp(`(^|[^\\p{L}\\p{N}])${w}([^\\p{L}\\p{N}]|$)`, "u").test(text);
    });

    const inPersonWords = [
      // English
      "test", "tests", "quiz", "quizzes", "exam", "exams", "midterm", "final",
      "presentation", "oral", "viva", "in-class", "in class",
      // Slovak / Czech
      "písomka", "pisomka", "písomky", "pisomky",
      "kvíz", "kviz", "kvízu", "kvizu",
      "skúška", "skuska", "skúšanie", "skusanie", "skúšky", "skusky",
      "previerka", "previerky",
      "diktát", "diktat",
      "prezentácia", "prezentacia", "prezentácie", "prezentacie",
      "vstupný test", "vstupny test", "výstupný test", "vystupny test",
      "ústna skúška", "ustna skuska", "ústne", "ustne",
      "písomné skúšanie", "pisomne skusanie",
      "lab demo", "v triede", "na hodine", "v škole", "v skole",
      "maturita", "maturity",
    ];

    const submitWords = [
      // explicit upload/turn-in verbs
      "upload", "submit", "turn in", "turned in", "hand in",
      "attach", "attached file", "google doc", "google form",
      "odovzdaj", "odovzdajte", "odovzdať", "odovzdat",
      "nahraj", "nahrajte", "nahrať", "nahrat",
      "vlož", "vloz", "vložte", "vlozte",
      "pošli", "posli", "pošlite", "poslite", "pošlite mi", "poslite mi",
      "send the file", "submit your", "upload your",
    ];

    const inTitle = hasWord(title, inPersonWords);
    const inDesc = hasWord(desc, inPersonWords);
    const hasSubmitSignal = hasWord(haystack, submitWords);

    // Title is a very strong signal; description-only matches require no submit override.
    const shouldForceInPerson = inTitle || (inDesc && !hasSubmitSignal);
    if (shouldForceInPerson) {
      parsed.actionType = "in_person";
      if (parsed.taskKind && !/^(Test|Quiz|Exam|Presentation|Interview)$/i.test(parsed.taskKind)) {
        if (/(písomk|pisomk|previerk|\btest\b|kvíz|kviz|\bquiz\b)/.test(haystack)) parsed.taskKind = "Test";
        else if (/(exam|midterm|final|skúšk|skusk|maturit)/.test(haystack)) parsed.taskKind = "Exam";
        else if (/(prezent|present)/.test(haystack)) parsed.taskKind = "Presentation";
        else if (/(ústn|ustn|oral|viva)/.test(haystack)) parsed.taskKind = "Interview";
      }
    }

    if (hash) await kvSet(cacheKey, JSON.stringify(parsed));
    return { id: a.id, ...parsed };
  }));

  const enrichments = results.filter((r) => r && !r.error);
  return new Response(JSON.stringify({ enrichments }), {
    headers: { "Content-Type": "application/json" },
  });
}
