/**
 * Kāsu Weekly Backup — Vercel Serverless Function (CommonJS)
 *
 * Triggered by Vercel Cron every Sunday 8:30 PM UTC (2:00 AM IST Monday).
 * Reads all Firestore /kasu/ documents via Firebase REST API + anonymous auth,
 * then emails a JSON backup to BACKUP_EMAIL via Resend.
 *
 * Env vars required in Vercel:
 *   RESEND_API_KEY  — Resend API key (Secret)
 *   BACKUP_EMAIL    — recipient, e.g. kevin@shimowfoods.com (Config)
 */

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT   = "kasu-benne";
const FIRESTORE_BASE     = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const FIREBASE_AUTH_BASE = "https://identitytoolkit.googleapis.com/v1";

async function getAnonToken() {
  const res = await fetch(
    `${FIREBASE_AUTH_BASE}/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }),
    }
  );
  if (!res.ok) throw new Error(`Firebase auth failed: ${res.status} ${await res.text()}`);
  return (await res.json()).idToken;
}

async function listKasuDocs(token) {
  const docs = [];
  let pageToken = null;
  do {
    const url = new URL(`${FIRESTORE_BASE}/kasu`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Firestore list failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    if (data.documents) docs.push(...data.documents);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return docs;
}

function parseValue(val) {
  if (!val || typeof val !== "object") return val;
  if ("stringValue"    in val) return val.stringValue;
  if ("integerValue"   in val) return Number(val.integerValue);
  if ("doubleValue"    in val) return val.doubleValue;
  if ("booleanValue"   in val) return val.booleanValue;
  if ("nullValue"      in val) return null;
  if ("timestampValue" in val) return val.timestampValue;
  if ("arrayValue"     in val) return (val.arrayValue.values || []).map(parseValue);
  if ("mapValue"       in val) return parseFields(val.mapValue.fields || {});
  return val;
}

function parseFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) obj[k] = parseValue(v);
  return obj;
}

function parseDocs(docs) {
  const result = {};
  for (const doc of docs) {
    const key = doc.name.split("/").pop();
    result[key] = parseFields(doc.fields || {});
  }
  return result;
}

async function sendEmail(apiKey, to, data, dateStr) {
  const json   = JSON.stringify(data, null, 2);
  const base64 = Buffer.from(json).toString("base64");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Kāsu Backup <onboarding@resend.dev>",
      to:   [to],
      subject: `Kāsu Weekly Backup — ${dateStr}`,
      html: `<h2>Kāsu Weekly Backup</h2>
             <p>Date: <strong>${dateStr}</strong></p>
             <p>Documents backed up: <strong>${Object.keys(data).length}</strong></p>
             <p>Full export attached as <code>kasu_backup_${dateStr}.json</code>.</p>`,
      attachments: [{ filename: `kasu_backup_${dateStr}.json`, content: base64 }],
    }),
  });

  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
  return res.json();
}

module.exports = async function handler(req, res) {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.BACKUP_EMAIL;

  if (!apiKey || !toEmail) {
    return res.status(500).json({ error: "Missing RESEND_API_KEY or BACKUP_EMAIL env vars" });
  }

  try {
    console.log("Backup started:", new Date().toISOString());
    const token    = await getAnonToken();
    const rawDocs  = await listKasuDocs(token);
    const data     = parseDocs(rawDocs);
    const dateStr  = new Date().toISOString().slice(0, 10);
    console.log(`Docs fetched: ${Object.keys(data).length}`);
    await sendEmail(apiKey, toEmail, data, dateStr);
    console.log("Email sent to", toEmail);
    return res.status(200).json({ ok: true, date: dateStr, docs: Object.keys(data).length });
  } catch (err) {
    console.error("Backup failed:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
