// netlify/functions/assist1.js
// Node 18+ runtime. Requires env: OPENAI_API_KEY, ASSISTANT_ID
// Optional env: ALLOW_ORIGIN (comma-separated), POLL_BUDGET_MS (default 9000)

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const POLL_BUDGET_MS = Number(process.env.POLL_BUDGET_MS || "9000");

// --- CORS helpers ---
function pickOrigin(reqOrigin) {
  if (ALLOW_ORIGIN === "*") return "*";
  const allowed = ALLOW_ORIGIN.split(",").map(s => s.trim());
  return allowed.includes(reqOrigin) ? reqOrigin : allowed[0] || "*";
}
function baseHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-log-token, OpenAI-Beta",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function jsonResp(status, obj, origin, extra = {}) {
  return {
    statusCode: status,
    headers: {
      ...baseHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      ...extra,
    },
    body: JSON.stringify(obj ?? {}),
  };
}
function textResp(status, text, origin, extra = {}) {
  return {
    statusCode: status,
    headers: {
      ...baseHeaders(origin),
      "Content-Type": "text/plain; charset=utf-8",
      ...extra,
    },
    body: text ?? "",
  };
}

// --- Utilities ---
function getLatestAssistantText(messagesList) {
  const items = messagesList?.data || [];
  const lastAssistant = items.find(m => m.role === "assistant") || items[0];
  if (!lastAssistant || !lastAssistant.content) return "";
  let acc = "";
  for (const c of lastAssistant.content) {
    if (c.type === "text" && c.text?.value) acc += c.text.value + "\n";
  }
  return acc.trim();
}

// NEW: helper nhận diện lỗi "active run"
function isActiveRunError(e) {
  const s = String(e?.message || e || "");
  return /already has an active run/i.test(s);
}

// NEW: thêm message vào thread với retry tránh lỗi "active run"
async function addMessageWithRetry(threadId, payload, headers, {
  retries = 2,
  waitMs = 800,
  createNewThreadOnExhaust = true,
  metaForNewThread = {}
} = {}) {

  const tryAdd = async (tid) => {
    return client.beta.threads.messages.create(tid, payload, headers);
  };

  let tid = threadId;
  for (let i = 0; i <= retries; i++) {
    try {
      await tryAdd(tid);
      return tid; // thành công
    } catch (err) {
      if (!isActiveRunError(err)) throw err; // không phải lỗi active-run → ném ra luôn
      if (i < retries) await new Promise(r => setTimeout(r, waitMs));
      else {
        // hết lượt retry
        if (!createNewThreadOnExhaust) throw err;
        // tạo thread mới để không văng 400 (chấp nhận mất ngữ cảnh)
        const t2 = await client.beta.threads.create(
          { metadata: metaForNewThread },
          { headers: { "OpenAI-Beta": "assistants=v2" } }
        );
        tid = t2.id;
        await tryAdd(tid); // nếu văng nữa thì ném ra
        return tid;
      }
    }
  }
}

// ĐÃ SỬA: đảm bảo thêm message an toàn khi run trước còn active
async function ensureThreadWithMessage({ threadId, message, email, session }) {
  let tid = threadId;
  if (!tid) {
    const t = await client.beta.threads.create(
      { metadata: { email: email || "", session: session || "" } },
      { headers: { "OpenAI-Beta": "assistants=v2" } }
    );
    tid = t.id;
  }

  const payload = {
    role: "user",
    content: message,
    metadata: { email: email || "", session: session || "" },
  };
  const headers = { headers: { "OpenAI-Beta": "assistants=v2" } };

  // Thêm message với retry: 2 lần chờ 800ms; nếu vẫn active → tạo thread mới
  const tidFinal = await addMessageWithRetry(
    tid,
    payload,
    headers,
    {
      retries: 2,
      waitMs: 800,
      createNewThreadOnExhaust: true,
      metaForNewThread: { email: email || "", session: session || "" }
    }
  );

  return tidFinal;
}

async function createRun(threadId) {
  const run = await client.beta.threads.runs.create(
    threadId,
    { assistant_id: ASSISTANT_ID },
    { headers: { "OpenAI-Beta": "assistants=v2" } }
  );
  return run;
}

async function getRun(threadId, runId) {
  return client.beta.threads.runs.retrieve(threadId, runId, {
    headers: { "OpenAI-Beta": "assistants=v2" },
  });
}

async function listMessages(threadId, limit = 10) {
  return client.beta.threads.messages.list(threadId, {
    limit,
    order: "desc",
    headers: { "OpenAI-Beta": "assistants=v2" },
  });
}

async function pollForCompletion({ threadId, runId, budgetMs = POLL_BUDGET_MS }) {
  const start = Date.now();
  let sleep = 300;
  while (Date.now() - start < budgetMs) {
    const run = await getRun(threadId, runId);
    const st = run.status;
    if (["completed","requires_action","failed","cancelled","expired"].includes(st)) {
      return st;
    }
    await new Promise(r => setTimeout(r, sleep));
    sleep = Math.min(1000, Math.round(sleep * 1.3));
  }
  return "in_progress";
}

export async function handler(event, context) {
  const origin = pickOrigin(event.headers?.origin || event.headers?.Origin || "*");

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: baseHeaders(origin), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return textResp(405, "Method Not Allowed", origin);
  }

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch { return jsonResp(400, { error: "Bad JSON body" }, origin); }

  const action = body.action || ""; // "stream" | "poll" | ""
  const message = (body.message || "").toString();
  const email = (body.email || "").toString();
  const session = (body.session || "").toString();
  let threadId = (body.threadId || "").toString();
  const runId = (body.runId || "").toString();

  if (!ASSISTANT_ID) {
    return jsonResp(500, { error: "Missing ASSISTANT_ID env" }, origin);
  }

  // --- STREAM: Assistants v2 runs.stream → SSE ---
  if (action === "stream") {
    if (!message && !threadId) {
      return jsonResp(400, { error: "Need message or threadId" }, origin);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const tid = await ensureThreadWithMessage({ threadId, message, email, session });
          threadId = tid;
          controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify({ threadId })}\n\n`));

          // Mở stream run
          await client.beta.threads.runs.stream(
            tid,
            { assistant_id: ASSISTANT_ID },
            {
              headers: { "OpenAI-Beta": "assistants=v2" },
              onRunCreated: (ev) => {
                // gửi runId sớm cho client (nếu muốn log)
                controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify({ runId: ev.id })}\n\n`));
              },
              onMessageDelta: ({ delta }) => {
                if (delta?.content) {
                  for (const c of delta.content) {
                    if (c.type === "output_text_delta" && c.text) {
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", text: c.text })}\n\n`));
                    }
                  }
                }
              },
              onMessageCompleted: () => {
                controller.enqueue(encoder.encode(`event: message_complete\ndata: {}\n\n`));
              },
              onEnd: () => {
                controller.enqueue(encoder.encode(`event: end\ndata: {}\n\n`));
                controller.close();
              },
              onError: (err) => {
                controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: String(err?.message || err) })}\n\n`));
                controller.close();
              },
            }
          );
        } catch (e) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: String(e?.message || e) })}\n\n`));
          controller.close();
        }
      },
    });

    return {
      statusCode: 200,
      headers: {
        ...baseHeaders(origin),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Transfer-Encoding": "chunked",
      },
      body: stream,
    };
  }

  // --- POLL (fallback) ---
  if (action === "poll") {
    if (!threadId || !runId) {
      return jsonResp(400, { error: "Need threadId and runId" }, origin);
    }
    try {
      const run = await getRun(threadId, runId);
      const st = run.status;
      if (st === "completed" || st === "requires_action") {
        const msgs = await listMessages(threadId, 10);
        const reply = getLatestAssistantText(msgs);
        return jsonResp(200, { done: true, reply, threadId, runId, status: st }, origin);
      }
      if (["failed","cancelled","expired"].includes(st)) {
        return jsonResp(200, { done: true, reply: `Run ${st}.`, threadId, runId, status: st }, origin);
      }
      return jsonResp(202, { done: false, threadId, runId, status: st }, origin);
    } catch (e) {
      return jsonResp(500, { error: String(e?.message || e) }, origin);
    }
  }

  // --- DEFAULT: tạo message → tạo run → poll nhanh ~9s (logic cũ) ---
  if (!message) {
    return jsonResp(400, { error: "Missing message" }, origin);
  }
  try {
    const tid = await ensureThreadWithMessage({ threadId, message, email, session });
    const run = await createRun(tid);
    const st = await pollForCompletion({ threadId: tid, runId: run.id });

    if (st === "completed" || st === "requires_action") {
      const msgs = await listMessages(tid, 10);
      const reply = getLatestAssistantText(msgs);
      return jsonResp(200, { reply, threadId: tid, runId: run.id, status: st }, origin);
    }
    return jsonResp(202, { threadId: tid, runId: run.id, status: st }, origin);
  } catch (e) {
    return jsonResp(500, { error: String(e?.message || e) }, origin);
  }
}
