// /netlify/functions/assist1.js
import OpenAI from "openai";

export const config = { path: "/.netlify/functions/assist1" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------- Helpers --------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function corsHeaders(req) {
  const allowList = (process.env.ALLOW_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin || "";
  const allowed = allowList.includes(origin) ? origin : (allowList[0] || "*");
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "content-type,x-log-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
  };
}

// Format ngày/giờ theo Asia/Ho_Chi_Minh → YYYY-MM-DD / HH:mm:ss
function vnDateTimeParts(d = new Date()) {
  const tz = "Asia/Ho_Chi_Minh";
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
  // en-CA gives YYYY-MM-DD; en-GB gives HH:mm:ss
  return { date, time };
}

function isEdisonEmail(email) {
  return /@edisonschools\.edu\.vn$/i.test(email || "");
}

// Sanitize text for CSV-in-TXT line (replace newlines; quote if needed)
function sanitizeText(s) {
  if (s == null) return "";
  const noNewline = String(s).replace(/\r?\n|\r/g, " ");
  // quoting for commas/quotes
  return `"${noNewline.replace(/"/g, '""')}"`;
}

// -------- Handler --------
export default async (req, res) => {
  if (req.method === "OPTIONS") {
    return res.status(204).set(corsHeaders(req)).send("");
  }
  if (req.method !== "POST") {
    return res.status(405).set(corsHeaders(req)).send(JSON.stringify({ error: "Method Not Allowed" }));
  }

  const headers = corsHeaders(req);

  try {
    const { message, threadId, session, email } = req.body || {};

    // Validate input early
    if (!message || typeof message !== "string") {
      return res.status(400).set(headers).send(JSON.stringify({ error: "Missing field: message" }));
    }
    if (!email || !isEdisonEmail(email)) {
      return res.status(403).set(headers).send(JSON.stringify({ error: "Email must end with @edisonschools.edu.vn" }));
    }
    if (!process.env.ASSISTANT_ID) {
      return res.status(500).set(headers).send(JSON.stringify({ error: "Missing ASSISTANT_ID" }));
    }

    const assistantId = process.env.ASSISTANT_ID;

    // --- Ensure thread + add message ---
    let realThreadId = threadId;
    if (!realThreadId) {
      // Create empty thread then add message (để hành vi thống nhất giữa lượt đầu & lượt sau)
      const t = await client.beta.threads.create({}, { headers: { "OpenAI-Beta": "assistants=v2" } });
      realThreadId = t.id;
    }

    // Add user message to thread
    await client.beta.threads.messages.create(
      realThreadId,
      { role: "user", content: message },
      { headers: { "OpenAI-Beta": "assistants=v2" } }
    );

    // --- Run assistant ---
    const run = await client.beta.threads.runs.create(
      realThreadId,
      { assistant_id: assistantId },
      { headers: { "OpenAI-Beta": "assistants=v2" } }
    );

    // --- Poll result ---
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
        // newest assistant message
        const last = msgs.data.find((m) => m.role === "assistant");
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

    // --- Send log to Apps Script (best-effort) ---
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
      // không làm fail phản hồi người dùng
    }

    // Success response
    return res.status(200).set(headers).send(JSON.stringify({
      reply: replyText,
      threadId: realThreadId
    }));

  } catch (err) {
    console.error("Function error:", err?.response?.data || err?.message || err);
    const msg = (err && err.message) ? err.message : "Internal Server Error";
    return res.status(500).set(headers).send(JSON.stringify({ error: msg }));
  }
};
