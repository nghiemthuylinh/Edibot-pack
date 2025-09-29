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
  // messagesList: { data: [ ... ] } (OpenAI SDK format)
  const items = messagesList?.data || [];
  const last = items.find(m => m.role === "assistant") || items[0];
  if (!last || !last.content) return "";
  // Extract text
  let acc = "";
  for (const c of last.content) {
    if (c.type === "text" && c.text?.value) acc += c.text.value + "\n";
  }
  return acc.trim();
}

async function ensureThreadWithMessage({ threadId, message, email, session }) {
  let tid = threadId;
  if (!tid) {
    const t = await client.beta.threads.create({
      metadata: { email: email || "", session: session || "" },
    }, { headers: { "OpenAI-Beta": "assistants=v2" } });
    tid = t.id;
  }
  await client.beta.threads.messages.create(
    tid,
    {
      role: "user",
      content: message,
      metadata: { email: email || "", session: session || "" },
    },
    { headers: { "OpenAI-Beta": "assistants=v2" } }
  );
  return tid;
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
  // simple backoff up to ~1s
  while (Date.now() - start < budgetMs) {
    const run = await getRun(threadId, runId);
    const st = run.status;
    if (st === "completed" || st === "requires_action" || st === "failed" || st === "cancelled" || st === "expired") {
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
    return {
      statusCode: 204,
      headers: baseHeaders(origin),
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return textResp(405, "Method Not Allowed", origin);
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return jsonResp(400, { error: "Bad JSON body" }, origin);
  }

  const action = body.action || ""; // "stream" | "poll" | ""
  const message = (body.message || "").toString();
  const email = (body.email || "").toString();
  const session = (body.session || "").toString();
  let threadId = (body.threadId || "").toString();
  const runId = (body.runId || "").toString();

  if (!ASSISTANT_ID) {
    return jsonResp(500, { error: "Missing ASSISTANT_ID env" }, origin);
  }

  // --- STREAM: Assistants v2 runs.stream → SSE to client ---
  if (action === "stream") {
    if (!message && !threadId) {
      return jsonResp(400, { error: "Need message or threadId" }, origin);
    }

    // Netlify Lambda (Node 18) can return a "stream" by using a special flag.
    // We'll emulate SSE by collecting chunks as they arrive and writing via a web ReadableStream.
    // IMPORTANT: Some hosts buffer responses; if your host buffers, the client will still fallback to poll.
    const encoder = new TextEncoder();

    // Create a ReadableStream to push SSE chunks
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const tid = await ensureThreadWithMessage({ threadId, message, email, session });
          threadId = tid;

          // Notify client of threadId first
          controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify({ threadId })}\n\n`));

          const s = await client.beta.threads.runs.stream(
            tid,
            { assistant_id: ASSISTANT_ID },
            {
              headers: { "OpenAI-Beta": "assistants=v2" },
              // Global handler to be safe:
              onEvent: (ev) => {
                // You can inspect all events if needed:
                // controller.enqueue(encoder.encode(`event: evt\ndata: ${JSON.stringify(ev)}\n\n`));
              },
              // Token deltas
              onMessageDelta: ({ delta }) => {
                // Concatenate only text deltas
                if (delta?.content) {
                  for (const c of delta.content) {
                    if (c.type === "output_text_delta" && c.text) {
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "delta", text: c.text })}\n\n`));
                    }
                  }
                }
              },
              // When a message completes, we can notify end-of-message
              onMessageCompleted: () => {
                controller.enqueue(encoder.encode(`event: message_complete\ndata: {}\n\n`));
              },
              // When the run ends, we close SSE
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

          // Safety: If SDK returns early, we ensure closure
          // (Most of the time onEnd will close)
        } catch (e) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: String(e?.message || e) })}\n\n`));
          controller.close();
        }
      },
    });

    // Return Response-like object with stream body
    return {
      statusCode: 200,
      headers: {
        ...baseHeaders(origin),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        // Important for Netlify/AWS to not base64 the body
        "Transfer-Encoding": "chunked",
      },
      // netlify shim understands this special key:
      body: stream,
    };
  }

  // --- POLL: check run status & fetch reply if done (fallback) ---
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
      if (st === "failed" || st === "cancelled" || st === "expired") {
        return jsonResp(200, { done: true, reply: `Run ${st}.`, threadId, runId, status: st }, origin);
      }
      return jsonResp(202, { done: false, threadId, runId, status: st }, origin);
    } catch (e) {
      return jsonResp(500, { error: String(e?.message || e) }, origin);
    }
  }

  // --- DEFAULT: create message → create run → poll nhanh ~9s (logic cũ) ---
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
    // Chưa xong → để client tiếp tục poll
    return jsonResp(202, { threadId: tid, runId: run.id, status: st }, origin);
  } catch (e) {
    return jsonResp(500, { error: String(e?.message || e) }, origin);
  }
}
