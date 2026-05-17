const PRIMARY_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
const BACKUP_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";

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
  if (!body || !Array.isArray(body.messages)) {
    res.status(400).json({ error: "messages array required" });
    return;
  }

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
        messages: body.messages,
        max_tokens: 2500,
        temperature: 0.4,
      }),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  };

  let result = await tryModel(PRIMARY_MODEL);
  if (!result.ok) {
    const backup = await tryModel(BACKUP_MODEL);
    if (backup.ok) result = backup;
    else {
      res.status(502).json({ error: "Both models failed", primary: result.data, backup: backup.data });
      return;
    }
  }

  const reply = result.data?.choices?.[0]?.message?.content || "";
  res.status(200).json({ reply, model: result.data?.model });
}
