export const config = { runtime: "edge" };

const PRIMARY_MODEL = "deepseek/deepseek-v4-flash:free";
const BACKUP_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "OPENROUTER_API_KEY not configured" }), { status: 500 });
  }

  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.messages)) {
    return new Response(JSON.stringify({ error: "messages array required" }), { status: 400 });
  }

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
      max_tokens: 2500,
      temperature: 0.4,
      stream: true,
    }),
  });

  let upstream = await callModel(PRIMARY_MODEL);
  if (!upstream.ok || !upstream.body) {
    upstream = await callModel(BACKUP_MODEL);
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(JSON.stringify({ error: "AI request failed", details: text }), { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
