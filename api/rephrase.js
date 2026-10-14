// ============================================================
// 一言ジェネレーター用 言い換え中継 — Vercel版（東京リージョン）
// ------------------------------------------------------------
// なぜ Vercel か:
//   Sarashina API は「日本国内から」のアクセスしか受け付けず、
//   海外IPは 403 Forbidden で弾かれる。Cloudflare Worker は
//   東京(NRT)で動いても Cloudflare の出口IPが日本と判定されず 403 だった。
//   Vercel の関数を東京リージョン(hnd1)で動かすと、出口が日本のIPになる
//   可能性が高いので、その検証を兼ねた中継。
//
// 【置き場所】
//   GitHub リポジトリ ocean-worktools/toolbox に
//       api/rephrase.js   ← このファイル
//       vercel.json       ← チャットに書いてある中身
//   を作って、Vercel にそのリポジトリを Import する。
//
// 【必要な設定】（Vercel の Settings → Environment Variables）
//   SARASHINA_API_KEY = Sarashina のAPIキー
//   ALLOW_ORIGIN      = https://ocean-worktools.github.io
//
// 【返す形】Cloudflare版とまったく同じ。
//   成功: {"ok":true,"text":"言い換えた一文"}
//   失敗: {"ok":false,"error":"...","status":403,...}
//   → HTML側は WORKER_URL を Vercel のURLに変えるだけでOK。
// ============================================================

// ============================================================
// 共通の設定
// ============================================================

// 使うモデル。まずは mini で試して、429が多く出たら nano に変える。
const MODEL = "sarashina3-mini";

// 言い換えの指示（プロンプト）。Cloudflare版とまったく同じ。
const INSTRUCTION = [
  "あなたは、塾の先生が保護者に送る、指導報告の「一言」を言い換えるアシスタントです。",
  "次の一文を、意味は変えずに、別の言い回しに書き換えてください。同じ文の使い回し（マンネリ）を防ぐのが目的です。",
  "文体のルール:",
  "- 元の文と同じ、無難な「です・ます」調にする。",
  "- 「〜ですね」「〜ましたね」のように、相手に語りかけたり同意を求めたりする語尾は使わない。",
  "- 「差し上げる」「ご〜いただけますと幸いです」のような、かしこまりすぎた言い回しは使わない。",
  "- 「ご自宅では」「焦点を当てる」のような硬い言い回しも避け、話し言葉に近い自然な表現にする。",
  "- 語や語順を変えて自然に言い換える。元の文を丸写ししない。長さも元の文と同じくらい（1文）。",
  "- 意味（できたこと・つまずき）は変えない。足さない。元の意味を超えて別の意味（例:「力になる」→「実を結ぶ」）にはしない。",
  "- 「お子様」など、主語を勝手に足さない。",
  "- 出力は書き換えた一文だけ。前置き・説明・引用符は書かない。"
].join("\n");

// --- CORS ヘッダー（Cloudflare版と同じ考え方） ---
// ALLOW_ORIGIN に許可するオリジンを入れる（カンマ区切りで複数OK）。
function corsHeaders(req) {
  const allow = (process.env.ALLOW_ORIGIN || "*")
    .split(",")
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
  const origin = (req.headers && req.headers.origin) || "";
  let allowOrigin = "*";
  if (allow.indexOf("*") === -1) {
    allowOrigin = allow.indexOf(origin) !== -1 ? origin : allow[0];
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

// --- Sarashina API を叩く ---
// 戻り値は { status, ok, data, raw }。statusを見れば 403 / 401 / 429 / 200 が分かる。
async function callSarashina(text) {
  const res = await fetch("https://api.sarashina.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // キーは Vercel の環境変数から読む。ブラウザには出さない。
      "Authorization": "Bearer " + (process.env.SARASHINA_API_KEY || "")
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: INSTRUCTION },
        { role: "user", content: text }
      ],
      // ゆらぎを持たせて言い回しにバリエーションを出す。
      // ※「未対応」で400が返ったら、この行を消して再デプロイするだけでOK。
      temperature: 0.7
    })
  });
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
  return { status: res.status, ok: res.ok, data: data, raw: raw.slice(0, 500) };
}

// ============================================================
// 本体（Vercel の Node.js 関数）
// ============================================================
module.exports = async function handler(req, res) {
  const cors = corsHeaders(req);

  // ブラウザの事前確認（プリフライト）にはヘッダーだけ返して終了
  if (req.method === "OPTIONS") {
    Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
    res.status(204).end();
    return;
  }

  // --- 診断用: ブラウザで開くと状態を教えてくれる ---
  // ?diag=1 を付けると、Sarashina を実際に1回叩いて結果を見せる。
  if (req.method === "GET") {
    const info = {
      keySet: !!process.env.SARASHINA_API_KEY,
      model: MODEL,
      allowOrigin: process.env.ALLOW_ORIGIN || null,
      region: process.env.VERCEL_REGION || null   // hnd1 なら東京で動いてる証拠
    };
    const q = (req.url || "").split("?")[1] || "";
    if (new URLSearchParams(q).get("diag") === "1") {
      try {
        const r = await callSarashina("ping");
        info.probe = { status: r.status, body: (r.data ? JSON.stringify(r.data) : r.raw).slice(0, 300) };
      } catch (e) {
        info.probe = { status: null, body: String(e) };
      }
    }
    Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
    res.status(200).json({ ok: true, info: info });
    return;
  }

  // POST 以外は弾く
  if (req.method !== "POST") {
    Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
    res.status(405).json({ ok: false, error: "POST only" });
    return;
  }

  try {
    // Vercel は JSON の本文を自動で req.body に入れてくれる
    const text = (req.body && req.body.text ? String(req.body.text) : "").trim();
    if (!text) {
      Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
      res.status(400).json({ ok: false, error: "text is required" });
      return;
    }

    const r = await callSarashina(text);

    // 2xx 以外は、理由を添えて返す（403=海外IP / 401=キー違い / 429=回数超過）
    if (!r.ok) {
      Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
      res.status(502).json({
        ok: false,
        error: "Sarashina API error (" + r.status + ")",
        status: r.status,
        detail: r.data || r.raw
      });
      return;
    }

    // 言い換え結果は choices[0].message.content に入っている
    const out = (r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message)
      ? String(r.data.choices[0].message.content || "").trim()
      : "";

    if (!out) {
      Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
      res.status(502).json({ ok: false, error: "empty response", detail: r.data });
      return;
    }

    Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
    res.status(200).json({ ok: true, text: out });
  } catch (e) {
    Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
    res.status(500).json({ ok: false, error: String(e) });
  }
};
