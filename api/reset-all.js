// POST /api/reset-all
// Resets passwords for all non-outlet users to a new password.
// Body: { firebaseApiKey, newPassword }
// This endpoint is for emergency use only. Delete or disable after use.

const crypto = require("crypto");

const PROJECT_ID = "kasu-benne";
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw).digest("hex");
}

async function getFirestoreToken(apiKey) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) }
  );
  if (!res.ok) throw new Error("Auth failed: " + res.status);
  const d = await res.json();
  return d.idToken;
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

async function fsGet(key, token) {
  const url = `${FIRESTORE_URL}/kasu/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Firestore GET failed: " + res.status);
  const doc = await res.json();
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

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { firebaseApiKey, newPassword } = req.body || {};

  if (!firebaseApiKey || !newPassword) {
    return res.status(400).json({ error: "firebaseApiKey and newPassword are required" });
  }

  // Basic password strength check
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }

  try {
    const token = await getFirestoreToken(firebaseApiKey);
    const users = await fsGet("users", token);
    if (!Array.isArray(users)) return res.status(500).json({ error: "Could not load users" });

    const newHash = hashPassword(newPassword);

    // Reset all users EXCEPT those with role "outlet"
    const reset = [];
    const skipped = [];

    const updated = users.map(u => {
      if (u.role === "outlet") {
        skipped.push(u.username || u.name);
        return u; // leave outlet users unchanged
      }
      reset.push(u.username || u.name);
      return { ...u, password: newHash };
    });

    await fsSet("users", updated, token);

    return res.status(200).json({
      ok: true,
      message: `Reset ${reset.length} users successfully.`,
      reset,
      skipped
    });
  } catch (e) {
    console.error("reset-all error:", e.message);
    return res.status(500).json({ error: e.message });
  }
};
