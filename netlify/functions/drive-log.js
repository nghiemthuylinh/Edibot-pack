// netlify/functions/drive-log.js  (CommonJS – chuẩn Netlify)
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "";

function corsHeaders(event) {
  const allow = ALLOW_ORIGIN.split(",").map(s => s.trim()).filter(Boolean);
  const origin = (event.headers && event.headers.origin) || "";
  const allowed = allow.includes(origin) ? origin : (allow[0] || "*");
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "content-type,x-log-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
  };
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const WEBHOOK = process.env.LOG_WEBHOOK_URL;
    const TOKEN   = process.env.LOG_TOKEN;

    if (!WEBHOOK || !TOKEN) {
      return { statusCode: 200, headers, body: JSON.stringify({ note: "SKIP_LOG: missing env" }) };
    }

    // Frontend đã gửi đúng JSON theo schema 9 trường → chuyển nguyên vẹn sang Apps Script
    const resp = await fetch(WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Log-Token": TOKEN
      },
      body: event.body || "{}"
    });

    const text = await resp.text();
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: resp.ok, status: resp.status, text })
    };

  } catch (e) {
    return {
      statusCode: 200, // không chặn UI dù log lỗi
      headers,
      body: JSON.stringify({ ok: false, error: String(e) })
    };
  }
};
