import { verifyUser, checkAndIncrementRate, jsonResponse } from "./_helpers.js";

export const config = { runtime: "edge" };

const PRIMARY_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";
const BACKUP_MODEL = "nvidia/nemotron-nano-9b-v2:free";

// Archive notes (from the client's personal, locally-stored past-years bundle)
// are optional and untrusted input — validate hard, slice every field, and
// silently drop anything malformed rather than erroring the whole request.
const ARCHIVE_NOTES_MAX = 5;
const ARCHIVE_FIELD_MAX = { t: 200, course: 120, y: 20, s: 400 };
const ARCHIVE_BUDGET_BYTES = 4000;

function sanitizeArchiveNotes(input) {
  if (!Array.isArray(input)) return [];
  const notes = [];
  let budget = ARCHIVE_BUDGET_BYTES;
  for (const item of input.slice(0, ARCHIVE_NOTES_MAX)) {
    if (!item || typeof item !== "object") continue;
    const t = typeof item.t === "string" ? item.t.slice(0, ARCHIVE_FIELD_MAX.t) : "";
    const course = typeof item.course === "string" ? item.course.slice(0, ARCHIVE_FIELD_MAX.course) : "";
    const y = typeof item.y === "string" ? item.y.slice(0, ARCHIVE_FIELD_MAX.y) : "";
    const s = typeof item.s === "string" ? item.s.slice(0, ARCHIVE_FIELD_MAX.s) : "";
    if (!t) continue;
    const size = t.length + course.length + y.length + s.length;
    if (size > budget) break;
    budget -= size;
    notes.push({ t, course, y, s });
  }
  return notes;
}

function withArchiveContext(messages, archiveNotes) {
  if (archiveNotes.length === 0) return messages;
  const block = [
    "",
    "=== STUDENT'S PERSONAL ARCHIVE ===",
    "This student has a personal archive of past school materials (previous years/topics) that may be relevant here. They may already know these concepts — reference what they've already learned and build on it rather than re-explaining from scratch, where relevant:",
    ...archiveNotes.map((n) => `- "${n.t}" (${[n.course, n.y].filter(Boolean).join(" · ")})${n.s ? `: ${n.s}` : ""}`),
  ].join("\n");
  if (messages[0] && messages[0].role === "system") {
    return [{ ...messages[0], content: `${messages[0].content}\n${block}` }, ...messages.slice(1)];
  }
  return [{ role: "system", content: block.trim() }, ...messages];
}

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return jsonResponse({ error: "OPENROUTER_API_KEY not configured" }, 500);

  const sub = await verifyUser(req);
  if (!sub) return jsonResponse({ error: "unauthorized" }, 401);

  const rate = await checkAndIncrementRate(sub);
  if (!rate.ok) {
    return jsonResponse({ error: "rate_limited", count: rate.count, limit: rate.limit, message: `Daily AI limit reached (${rate.limit}). Resets at midnight UTC.` }, 429);
  }

  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.messages)) return jsonResponse({ error: "messages array required" }, 400);

  const archiveNotes = sanitizeArchiveNotes(body.archiveNotes);
  const messages = withArchiveContext(body.messages, archiveNotes);

  const callModel = (model) => fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://classroom-web-analyzer.vercel.app",
      "X-Title": "Classroom Web Analyzer",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 4000,
      temperature: 0.4,
      stream: true,
    }),
  });

  let upstream = await callModel(PRIMARY_MODEL);
  if (!upstream.ok || !upstream.body) upstream = await callModel(BACKUP_MODEL);
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return jsonResponse({ error: "AI request failed", details: text }, 502);
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "X-RateLimit-Used": String(rate.count),
      "X-RateLimit-Limit": String(rate.limit),
    },
  });
}
