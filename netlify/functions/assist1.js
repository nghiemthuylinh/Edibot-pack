// /netlify/functions/assist1.js
import OpenAI from "openai";

// ===== Helpers =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function corsHeaders(event) {
  const list = (process.env.ALLOW_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = (event.headers?.origin) || "";
  const allowed = list.includes(origin) ? origin : (list[0] || "*");
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "content-type,x-log-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function isEdisonEmail(email) {
  return /@edisonschools\.edu\.vn$/i.test(email || "");
}

function vnDateTimeParts(d = new Date()) {
  const tz = "Asia/Ho_Chi_Minh";
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); // YYYY-MM-DD
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d); // HH:mm:ss
  return { date, time };
}

// ===== Handler (Lambda-style) =====
export const handler = async (event, context) => {
  const headers = corsHeaders(event);

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Bad JSON" }) };
  }

  const { message, threadId, session, email } = body || {};
  if (!message || typeof message !== "string") {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing field: message" }) };
  }
  if (!email || !isEdisonEmail(email)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "Email must end with @edisonschools.edu.vn" }) };
  }
  if (!process.env.OPENAI_API_KEY || !process.env.ASSISTANT_ID) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server not configured" }) };
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const assistantId = process.env.ASSISTANT_ID;

  try {
    // Create thread if needed, then add user message
    let realThreadId = threadId;
    if (!realThreadId) {
      const t = await client.beta.threads.create(
        {},
        { headers: { "OpenAI-Beta": "assistants=v2" } }
      );
      realThreadId = t.id;
    }

    await client.beta.threads.messages.create(
      realThreadId,
      { role: "user", content: message },
      { headers: { "OpenAI-Beta": "assistants=v2" } }
    );

    // Run assistant
    const run = await client.beta.threads.runs.create(
      realThreadId,
      { assistant_id: assistantId },
      { headers: { "OpenAI-Beta": "assistants=v2" } }
    );

    // Poll for result
    let replyText = "";
    for (let i = 0; i < 40; i++) { // ~20s
      const r = await client.beta.threads.runs.retrieve(
        realThreadId,
        run.id,
        { headers: { "OpenAI-Beta": "assistants=v2" } }
      );
      if (r.status === "completed") {
        const msgs = await client.beta.threads.messages.list(
          realThreadId,
          { headers: { "OpenAI-Beta": "assistants=v2" } }
        );
        const last = msgs.data.find(m => m.role === "assistant");
        if (last && Array.isArray(last.content)) {
          replyText = last.content.map(p => (p.text?.value ?? "")).join("\n").trim();
        }
        break;
      }
      if (["failed", "cancelled", "expired"].includes(r.status)) {
        replyText = `Run status: ${r.status}`;
        break;
      }
      await sleep(500);
    }
    if (!replyText) replyText = "No response received. Please try again.";

    // Fire-and-forget: log to Apps Script
    try {
      if (process.env.LOG_WEBHOOK_URL) {
        const { date, time } = vnDateTimeParts();
        const payload = {
          date,
          time,
          email,
          session: session || "",
          assistantId,
          threadId: realThreadId,
          runId: run.id,
          user: message,
          assistant: replyText
        };
        await fetch(process.env.LOG_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Log-Token": process.env.LOG_TOKEN || ""
          },
          body: JSON.stringify(payload)
        });
      }
    } catch (e) {
      console.error("LOG error:", e?.message || e);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: replyText, threadId: realThreadId })
    };

  } catch (err) {
    console.error("Function error:", err?.response?.data || err?.message || err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err?.message || "Internal Server Error" })
    };
  }
};
