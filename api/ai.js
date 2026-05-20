import { verifyUser, checkAndIncrementRate, jsonResponse } from "./_helpers.js";

export const config = { runtime: "edge" };

const PRIMARY_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";
const BACKUP_MODEL = "nvidia/nemotron-nano-9b-v2:free";

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
      messages: body.messages,
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
