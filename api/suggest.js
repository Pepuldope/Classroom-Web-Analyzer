import { verifyUser, checkAndIncrementRate, jsonResponse } from "./_helpers.js";

export const config = { runtime: "edge" };

const MODEL = "nvidia/nemotron-nano-9b-v2:free";

const SYSTEM_PROMPT = `You generate three short follow-up prompt buttons for a study chat. The student is talking to an AI tutor about ONE assignment. Look at the last assistant reply and propose 3 short next-message ideas the student might want to send.

Rules:
- Each suggestion is ONE short sentence or question, 4-10 words.
- Match the language of the conversation.
- Make them concrete and varied: a deeper-dive, a practice/test request, and a clarification or example.
- NEVER suggest off-topic prompts or roleplay.
- Output ONLY valid JSON, no prose: {"suggestions":["...","...","..."]}`;

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return jsonResponse({ error: "OPENROUTER_API_KEY not configured" }, 500);

  const sub = await verifyUser(req);
  if (!sub) return jsonResponse({ error: "unauthorized" }, 401);

  const rate = await checkAndIncrementRate(sub);
  if (!rate.ok) return jsonResponse({ error: "rate_limited" }, 429);

  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.messages)) return jsonResponse({ error: "messages array required" }, 400);

  const lastTurns = body.messages.slice(-6);

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
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Conversation so far:\n${lastTurns.map((m) => `${m.role}: ${m.content}`).join("\n\n").slice(0, 2400)}\n\nReturn three suggestions.` },
        ],
        response_format: { type: "json_object" },
        max_tokens: 300,
        temperature: 0.5,
      }),
    });
    if (!r.ok) return jsonResponse({ error: "ai_failed" }, 502);
    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    let parsed = null;
    try { parsed = JSON.parse(raw); }
    catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    const suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions.filter((s) => typeof s === "string" && s.trim()).slice(0, 3) : [];
    return jsonResponse({ suggestions });
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500);
  }
}
