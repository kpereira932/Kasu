// POST /api/recover
// Body: { recoveryKey, targetLogin, newPassword }
// Validates SUPERADMIN_RECOVERY_KEY env var, resets target user's password in Firestore.
// targetLogin can be a username or email address.

const crypto = require("crypto");

const PROJECT_ID = "kasu-benne";
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// SHA-256 hash via Node crypto (same algorithm as browser Web Crypto)
function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw).digest("hex");
}

// Fetch a Firestore document via REST using the Firebase web API key + anonymous auth token
async function getFirestoreToken() {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error("FIREBASE_API_KEY not set");
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) }
  );
  if (!res.ok) throw new Error("Auth failed: " + res.status);
  const d = await res.json();
  return d.idToken;
}

async function fsGet(key, token) {
  const url = `${FIRESTORE_URL}/kasu/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Firestore GET failed: " + res.status);
  const doc = await res.json();
  // Firestore REST value extraction
  const raw = doc.fields?.value;
  if (!raw) return null;
  return parseFirestoreValue(raw);
}

async function fsSet(key, value, token) {
  const url = `${FIRESTORE_URL}/kasu/${encodeURIComponent(key)}`;
  const body = JSON.stringify({ fields: { value: toFirestoreValue(value) } });
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error("Firestore SET failed: " + err);
  }
}

function parseFirestoreValue(v) {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.arrayValue) return (v.arrayValue.values || []).map(parseFirestoreValue);
  if (v.mapValue) {
    const obj = {};
    for (const [k, fv] of Object.entries(v.mapValue.fields || {})) obj[k] = parseFirestoreValue(fv);
    return obj;
  }
  return null;
}

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (typeof val === "string") return { stringValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === "object") {
    const fields = {};
    for (const [k, v] of Object.entries(val)) fields[k] = toFirestoreValue(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const RECOVERY_KEY = process.env.SUPERADMIN_RECOVERY_KEY;
  if (!RECOVERY_KEY) return res.status(503).json({ error: "Recovery not configured" });

  const { recoveryKey, targetLogin, newPassword } = req.body || {};
  if (!recoveryKey || !targetLogin || !newPassword) {
    return res.status(400).json({ error: "recoveryKey, targetLogin and newPassword are required" });
  }

  // Constant-time comparison to prevent timing attacks
  const provided = Buffer.from(recoveryKey.trim());
  const expected = Buffer.from(RECOVERY_KEY);
  let valid = provided.length === expected.length;
  // Still do the timingSafeEqual even if lengths differ (on a padded copy) to avoid timing leak
  const cmp = Buffer.alloc(expected.length);
  provided.copy(cmp, 0, 0, Math.min(provided.length, expected.length));
  valid = valid && crypto.timingSafeEqual(cmp, expected);
  if (!valid) return res.status(401).json({ error: "Invalid recovery key" });

  // Basic password strength: min 8 chars, at least one digit
  if (newPassword.length < 8 || !/\d/.test(newPassword)) {
    return res.status(400).json({ error: "New password must be at least 8 characters and include a number" });
  }

  try {
    const token = await getFirestoreToken();
    const users = await fsGet("users", token);
    if (!Array.isArray(users)) return res.status(500).json({ error: "Could not load users" });

    const login = targetLogin.trim().toLowerCase();
    const target = users.find(u =>
      (u.email && u.email.toLowerCase() === login) ||
      (u.username && u.username.toLowerCase() === login)
    );
    if (!target) return res.status(404).json({ error: "User not found" });

    const newHash = hashPassword(newPassword);
    const updated = users.map(u => u.id === target.id ? { ...u, password: newHash } : u);
    await fsSet("users", updated, token);

    return res.status(200).json({ ok: true, message: `Password reset for ${target.name || target.username}` });
  } catch (e) {
    console.error("recover error:", e.message);
    return res.status(500).json({ error: "Internal error. Check server logs." });
  }
};
