// Pass-through proxy to the Suno API.
// The browser sends the user's own API key in the Authorization header on every
// request; this function forwards it upstream and never logs or stores it.
// Proxying avoids browser CORS restrictions on direct calls to api.sunoapi.org.
// Only signed-in users (valid Supabase session token in X-Supabase-Auth) are served.

import { verifyAccessToken } from "../lib/auth.mjs";

const UPSTREAM = "https://api.sunoapi.org";

// Only the endpoints the app uses are reachable, so this can't be used as an open proxy.
const ALLOWED = new Map([
  ["/api/v1/generate", "POST"],
  ["/api/v1/generate/extend", "POST"],
  ["/api/v1/generate/record-info", "GET"],
  ["/api/v1/generate/credit", "GET"],
  ["/api/v1/lyrics", "POST"],
  ["/api/v1/lyrics/record-info", "GET"],
]);

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default async (req) => {
  const url = new URL(req.url);
  const upstreamPath = url.pathname.replace(/^\/api\/suno/, "/api");

  const method = ALLOWED.get(upstreamPath);
  if (!method) return json(404, { code: 404, msg: "Unknown endpoint" });
  if (req.method !== method) return json(405, { code: 405, msg: "Method not allowed" });

  const userId = await verifyAccessToken(req.headers.get("x-supabase-auth"));
  if (!userId) return json(401, { code: 401, auth: true, msg: "Please sign in again." });

  const auth = req.headers.get("authorization");
  if (!auth || !/^Bearer\s+\S+/.test(auth)) {
    return json(401, { code: 401, msg: "Missing API key" });
  }

  const init = {
    method,
    headers: { authorization: auth, accept: "application/json" },
  };
  if (method === "POST") {
    init.headers["content-type"] = "application/json";
    init.body = await req.text();
  }

  try {
    const res = await fetch(UPSTREAM + upstreamPath + url.search, init);
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return json(502, { code: 502, msg: "Could not reach Suno API" });
  }
};

export const config = { path: "/api/suno/*" };
