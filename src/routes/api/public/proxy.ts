import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade",
  "content-encoding", "content-length",
  "content-security-policy", "content-security-policy-report-only",
  "x-frame-options", "strict-transport-security",
  "cross-origin-opener-policy", "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
]);

function buildProxiedUrl(req: Request, target: string): string {
  const u = new URL(req.url);
  return `${u.origin}/api/public/proxy?url=${encodeURIComponent(target)}`;
}

function rewriteHtml(html: string, baseUrl: string, req: Request): string {
  const base = new URL(baseUrl);
  const rewriteOne = (raw: string): string => {
    try {
      if (!raw || raw.startsWith("data:") || raw.startsWith("blob:") || raw.startsWith("javascript:") || raw.startsWith("#") || raw.startsWith("mailto:") || raw.startsWith("tel:")) return raw;
      const abs = new URL(raw, base).toString();
      return buildProxiedUrl(req, abs);
    } catch { return raw; }
  };
  // attributes: src, href, action, srcset (partial), poster, data-src
  html = html.replace(/\b(src|href|action|poster|data-src)\s*=\s*(["'])([^"']+)\2/gi,
    (_m, attr, q, val) => `${attr}=${q}${rewriteOne(val)}${q}`);
  // srcset
  html = html.replace(/\bsrcset\s*=\s*(["'])([^"']+)\1/gi, (_m, q, val) => {
    const parts = val.split(",").map((p: string) => {
      const trimmed = p.trim();
      const sp = trimmed.split(/\s+/);
      sp[0] = rewriteOne(sp[0]);
      return sp.join(" ");
    });
    return `srcset=${q}${parts.join(", ")}${q}`;
  });
  // inject a <base> + helper script that intercepts fetch/XHR/WebSocket
  const helper = `<script>(function(){var P=${JSON.stringify(new URL(req.url).origin + "/api/public/proxy?url=")};var B=${JSON.stringify(baseUrl)};function abs(u){try{return new URL(u,B).toString()}catch(e){return u}}function wrap(u){if(!u)return u;u=String(u);if(u.indexOf(P)===0)return u;if(u.startsWith("data:")||u.startsWith("blob:")||u.startsWith("javascript:")||u.startsWith("#"))return u;return P+encodeURIComponent(abs(u))}var of=window.fetch;window.fetch=function(i,init){if(typeof i==="string")i=wrap(i);else if(i&&i.url)i=new Request(wrap(i.url),i);return of.call(this,i,init)};var ox=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){return ox.apply(this,[m,wrap(u)].concat([].slice.call(arguments,2)))};try{var OW=window.WebSocket;window.WebSocket=function(u,p){try{var au=new URL(u,B);var wp=new URL(P+encodeURIComponent(au.toString()),location.href);wp.protocol=wp.protocol==="https:"?"wss:":"ws:";return p?new OW(wp.toString(),p):new OW(wp.toString())}catch(e){return p?new OW(u,p):new OW(u)}};window.WebSocket.prototype=OW.prototype}catch(e){}})();</script>`;
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>${helper}`);
  } else {
    html = helper + html;
  }
  return html;
}

function rewriteCss(css: string, baseUrl: string, req: Request): string {
  const base = new URL(baseUrl);
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_m, q, val) => {
    try {
      if (val.startsWith("data:")) return `url(${q}${val}${q})`;
      const abs = new URL(val, base).toString();
      return `url(${q}${buildProxiedUrl(req, abs)}${q})`;
    } catch { return `url(${q}${val}${q})`;}
  });
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) return new Response("Missing url param", { status: 400, headers: CORS });
  let targetUrl: URL;
  try { targetUrl = new URL(target); } catch { return new Response("Invalid url", { status: 400, headers: CORS }); }
  if (!/^https?:$/.test(targetUrl.protocol)) return new Response("Bad protocol", { status: 400, headers: CORS });

  const reqHeaders = new Headers();
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === "host" || lk === "origin" || lk === "referer" || lk === "cookie") continue;
    reqHeaders.set(k, v);
  }
  reqHeaders.set("Referer", targetUrl.origin + "/");
  reqHeaders.set("Origin", targetUrl.origin);
  if (!reqHeaders.has("user-agent")) {
    reqHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36");
  }

  let body: BodyInit | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
  }

  const friendly = (title: string, msg: string) => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0;height:100%;background:#0a0a0a;color:#eaeaea;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center}.b{max-width:520px;text-align:center;padding:32px}h1{font-weight:500;font-size:22px;margin:0 0 10px}p{color:#999;font-size:14px;line-height:1.6}code{color:#ffb86b;word-break:break-all}button{margin-top:18px;background:#1a1a1a;color:#fff;border:1px solid #333;padding:10px 18px;border-radius:8px;cursor:pointer}</style></head><body><div class="b"><h1>${title}</h1><p>${msg}</p><p><code>${targetUrl.toString()}</code></p><button onclick="location.reload()">Retry</button></div></body></html>`;
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...CORS } });
  };

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: reqHeaders,
      body,
      redirect: "follow",
    });
  } catch (e) {
    return friendly("Upstream unreachable", "We couldn't reach the target site. It may be down or blocking the proxy.");
  }
  if (upstream.status >= 500) {
    return friendly("Upstream error " + upstream.status, "The target site returned an error. Try again in a moment.");
  }

  const ct = (upstream.headers.get("content-type") || "").toLowerCase();
  const outHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === "set-cookie") continue;
    if (k.toLowerCase() === "location") {
      try {
        const abs = new URL(v, targetUrl).toString();
        outHeaders.set("location", buildProxiedUrl(request, abs));
        continue;
      } catch {}
    }
    outHeaders.set(k, v);
  }
  for (const [k, v] of Object.entries(CORS)) outHeaders.set(k, v);

  if (ct.includes("text/html")) {
    const text = await upstream.text();
    const rewritten = rewriteHtml(text, upstream.url || targetUrl.toString(), request);
    outHeaders.set("content-type", "text/html; charset=utf-8");
    return new Response(rewritten, { status: upstream.status, headers: outHeaders });
  }
  if (ct.includes("text/css")) {
    const text = await upstream.text();
    const rewritten = rewriteCss(text, upstream.url || targetUrl.toString(), request);
    outHeaders.set("content-type", "text/css; charset=utf-8");
    return new Response(rewritten, { status: upstream.status, headers: outHeaders });
  }

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

export const Route = createFileRoute("/api/public/proxy")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
      PUT: async ({ request }) => handle(request),
      DELETE: async ({ request }) => handle(request),
    },
  },
});
