// Verifies Supabase user access tokens (ES256 JWTs) against the project's public JWKS.
// No secrets needed: the signing keys are public and verification is done locally.

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://bfrjsojsgxaadijkfmsk.supabase.co").replace(/\/+$/, "");
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 30 * 1000;

let cache = { keys: new Map(), fetchedAt: 0 };

async function loadJwks() {
  const res = await fetch(JWKS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys = [] } = await res.json();
  const map = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.kid) continue;
    const { kty, crv, x, y } = jwk;
    const key = await crypto.subtle.importKey("jwk", { kty, crv, x, y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    map.set(jwk.kid, key);
  }
  cache = { keys: map, fetchedAt: Date.now() };
}

async function getKey(kid) {
  const age = Date.now() - cache.fetchedAt;
  // Refresh when stale, or when an unknown kid shows up (key rotation), but not more than every 30s.
  if (age > JWKS_TTL_MS || (!cache.keys.has(kid) && age > JWKS_MIN_REFRESH_MS)) {
    await loadJwks();
  }
  return cache.keys.get(kid) || null;
}

const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/** Returns the user's id if the token is a valid, unexpired Supabase session token; otherwise null. */
export async function verifyAccessToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let header, payload;
  try {
    header = decode(parts[0]);
    payload = decode(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "ES256" || !header.kid) return null;

  let key;
  try {
    key = await getKey(header.kid);
  } catch {
    return null;
  }
  if (!key) return null;

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(parts[2], "base64url"),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== ISSUER) return null;
  if (!aud.includes("authenticated") || payload.role !== "authenticated") return null;
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (!payload.sub) return null;
  return payload.sub;
}
