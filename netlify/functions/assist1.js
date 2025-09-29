// /netlify/functions/assist1.js
import OpenAI from "openai";

// ==== Helpers ====================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function corsHeaders(event) {
  const list = (process.env.ALLOW_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = event.headers?.origin || "";
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

// ==== Netlify Lambda-style handler ===============================
export const handler = async (event) => {
  const headers = corsHeaders(event);

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  // Parse body
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Bad JSON" }) };
  }

  const {
    action,           // 'ask' | 'poll'
    message,
    email,
    session,
    threadId,
    runId
  } = body;

  // -------------------- POLL MODE --------------------
  // Chỉ kiểm tra tiến độ run → phản hồi cực nhanh
  if (action === "poll") {
    if (!threadId || !runId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing threadId or runId" }) };
    }
    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const r = await client.beta.threads.runs.retrieve(
        threadId,
        runId,
        { headers: { "OpenAI-Beta": "assistants=v2" } }
      );

      // Đã xong → lấy message cuối của assistant
      if (r.status === "completed") {
        const msgs = await client.beta.threads.messages.list(
          threadId,
          { headers: { "OpenAI-Beta": "assistants=v2" } }
        );
        const last = msgs.data.find((m) => m.role === "assistant");
        const reply = (last?.content || [])
          .map((p) => p.text?.value ?? "")
          .join("\n")
          .trim() || "No response.";
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ done: true, reply })
        };
      }

      // Kết thúc bất thường
      if (["failed", "cancelled", "expired"].includes(r.status)) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ done: true, reply: `Run status: ${r.status}` })
        };
      }

      // Vẫn đang chạy
      return {
        statusCode: 202,
        headers,
        body: JSON.stringify({ pending: true, status: r.status })
      };
    } catch (e) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: e?.message || "Poll error" })
      };
    }
  }

  // --------------------- ASK MODE ---------------------
  // Thêm message & tạo run → TRẢ 202 NGAY (không chờ 9s)
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
    // 1) Tạo hoặc tái sử dụng thread
    let realThreadId = threadId;
    if (!realThreadId) {
      const t = await client.beta.threads.create(
        {},
        { headers: { "OpenAI-Beta": "assistants=v2" } }
      );
      realThreadId = t.id;
    }

    // 2) Thêm message của user
    await client.beta.threads.messages.create(
      realThreadId,
      { role: "user", content: message },
      { headers: { "OpenAI-Beta": "assistants=v2" } }
    );

    // 3) Tạo run (không đợi hoàn tất)
    const run = await client.beta.threads.runs.create(
      realThreadId,
      {
        assistant_id: assistantId,
        // Có thể thêm instructions / truncation / max_output_tokens nếu muốn nhanh hơn
      },
      { headers: { "OpenAI-Beta": "assistants=v2" } }
    );

    // 4) TRẢ 202 NGAY để client hiện “Đang đọc tài liệu…” và bắt đầu poll
    return {
      statusCode: 202,
      headers,
      body: JSON.stringify({
        pending: true,
        threadId: realThreadId,
        runId: run.id,
        status: run.status || "queued"
      })
    };
  } catch (err) {
    console.error("assist1 error:", err?.response?.data || err?.message || err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err?.message || "Internal Server Error" })
    };
  }
};
