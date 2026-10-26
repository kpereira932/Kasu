/**
 * Kāsu Weekly Backup — Vercel Serverless Function (CommonJS)
 *
 * Triggered by Vercel Cron every Sunday 8:30 PM UTC (2:00 AM IST Monday).
 * Reads all Firestore /kasu/ documents via Firebase REST API + anonymous auth,
 * then emails a gzipped JSON backup to all addresses in BACKUP_EMAILS via Resend.
 *
 * Required env vars (Vercel → Project → Settings → Environment Variables):
 *   RESEND_API_KEY   — Resend API key (Secret)
 *   FIREBASE_API_KEY — Firebase web API key (Secret)
 *   BACKUP_EMAILS    — comma-separated recipient list, e.g. kevin@shimowfoods.com,coo@shimowfoods.com
 *
 * Optional:
 *   BACKUP_FROM      — sending address, e.g. backup@shimowfoods.com
 *                      (falls back to onboarding@resend.dev if not set)
 */

const { gzipSync } = require("zlib");

const FIREBASE_PROJECT   = "kasu-benne";
const FIRESTORE_BASE     = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const FIREBASE_AUTH_BASE = "https://identitytoolkit.googleapis.com/v1";

// ── Step 1: Anonymous sign-in via Firebase Auth REST ──────────────────────────
async function getAnonToken(apiKey) {
  const res = await fetch(
    `${FIREBASE_AUTH_BASE}/accounts:signUp?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }),
    }
  );
  if (!res.ok) throw new Error(`Firebase auth failed: ${res.status} ${await res.text()}`);
  return (await res.json()).idToken;
}

// ── Step 2: List all documents in /kasu/ (paginated) ─────────────────────────
async function listKasuDocs(token) {
  const docs = [];
  let pageToken = null;
  do {
    const url = new URL(`${FIRESTORE_BASE}/kasu`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Firestore list failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    if (data.documents) docs.push(...data.documents);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return docs;
}

// ── Step 3: Parse Firestore wire format into plain JS ─────────────────────────
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

// ── Step 4: Integrity check — verify one random doc matches Firestore ─────────
async function verifyIntegrity(token, backupData) {
  const keys = Object.keys(backupData);
  if (keys.length === 0) return { ok: false, reason: "backup is empty" };

  const sampleKey = keys[Math.floor(Math.random() * keys.length)];
  const res = await fetch(`${FIRESTORE_BASE}/kasu/${encodeURIComponent(sampleKey)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { ok: false, reason: `live fetch failed for ${sampleKey}: ${res.status}` };
  const liveDoc = await res.json();
  const liveData = parseFields(liveDoc.fields || {});

  // Compare document key count as a quick sanity check
  const backupKeys  = Object.keys(backupData[sampleKey] || {}).length;
  const liveKeys    = Object.keys(liveData).length;
  if (backupKeys !== liveKeys) {
    return { ok: false, reason: `field count mismatch on '${sampleKey}': backup=${backupKeys}, live=${liveKeys}` };
  }
  return { ok: true, checkedDoc: sampleKey };
}

// ── Step 5: Send backup email (gzipped attachment) via Resend ─────────────────
async function sendBackupEmail(resendKey, toAddresses, fromAddress, data, dateStr, integrityResult) {
  const json       = JSON.stringify(data, null, 2);
  const compressed = gzipSync(Buffer.from(json));
  const base64     = compressed.toString("base64");
  const docCount   = Object.keys(data).length;

  const integrityBadge = integrityResult.ok
    ? `<span style="color:#166534;font-weight:600">✔ Passed</span> (checked doc: <code>${integrityResult.checkedDoc}</code>)`
    : `<span style="color:#C0392B;font-weight:600">⚠ Failed</span> — ${integrityResult.reason}`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from:    fromAddress,
      to:      toAddresses,
      subject: `Kāsu Weekly Backup — ${dateStr}`,
      html: `
        <h2 style="font-family:sans-serif">Kāsu Weekly Backup</h2>
        <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
          <tr><td style="padding:4px 12px 4px 0;color:#888">Date</td><td><strong>${dateStr}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#888">Documents</td><td><strong>${docCount}</strong></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#888">Integrity check</td><td>${integrityBadge}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#888">Attachment</td><td><code>kasu_backup_${dateStr}.json.gz</code></td></tr>
        </table>
        <p style="font-family:sans-serif;font-size:12px;color:#888;margin-top:20px">
          Covers all documents under /kasu/ in the kasu-benne Firebase project.<br>
          Sent automatically every Sunday by the Kāsu backup function on Vercel.
        </p>
      `,
      attachments: [{
        filename: `kasu_backup_${dateStr}.json.gz`,
        content:  base64,
      }],
    }),
  });
  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Step 6: Send alert email on integrity failure ─────────────────────────────
async function sendAlertEmail(resendKey, toAddresses, fromAddress, dateStr, reason) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from:    fromAddress,
      to:      toAddresses,
      subject: `⚠ Kāsu Backup Integrity Warning — ${dateStr}`,
      html: `
        <h2 style="font-family:sans-serif;color:#C0392B">⚠ Backup Integrity Check Failed</h2>
        <p style="font-family:sans-serif">The weekly backup ran on <strong>${dateStr}</strong> but the integrity check did not pass.</p>
        <p style="font-family:sans-serif"><strong>Reason:</strong> ${reason}</p>
        <p style="font-family:sans-serif">The backup file has still been attached — please verify it manually before relying on it for recovery.</p>
        <p style="font-family:sans-serif;font-size:12px;color:#888">Kāsu backup function — Vercel</p>
      `,
    }),
  });
  if (!res.ok) console.error("Alert email failed:", res.status, await res.text());
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const resendKey  = process.env.RESEND_API_KEY;
  const firebaseKey = process.env.FIREBASE_API_KEY;
  // Support comma-separated list: "kevin@shimowfoods.com,coo@shimowfoods.com"
  const emailsRaw  = process.env.BACKUP_EMAILS || process.env.BACKUP_EMAIL || "";
  const toAddresses = emailsRaw.split(",").map(e => e.trim()).filter(Boolean);
  const fromAddress = process.env.BACKUP_FROM || "Kāsu Backup <onboarding@resend.dev>";

  if (!resendKey || !firebaseKey || toAddresses.length === 0) {
    return res.status(500).json({ error: "Missing env vars: RESEND_API_KEY, FIREBASE_API_KEY, or BACKUP_EMAILS" });
  }

  try {
    console.log("Backup started:", new Date().toISOString());

    const token    = await getAnonToken(firebaseKey);
    const rawDocs  = await listKasuDocs(token);
    const data     = parseDocs(rawDocs);
    const dateStr  = new Date().toISOString().slice(0, 10);
    const docCount = Object.keys(data).length;
    console.log(`Fetched ${docCount} documents`);

    // Integrity check
    const integrity = await verifyIntegrity(token, data);
    console.log("Integrity check:", integrity);
    if (!integrity.ok) {
      // Send alert but still send the backup with a warning
      await sendAlertEmail(resendKey, toAddresses, fromAddress, dateStr, integrity.reason);
    }

    // Send backup email (includes integrity badge)
    await sendBackupEmail(resendKey, toAddresses, fromAddress, data, dateStr, integrity);
    console.log("Email sent to", toAddresses.join(", "));

    return res.status(200).json({
      ok:        true,
      date:      dateStr,
      docs:      docCount,
      integrity: integrity,
      emailedTo: toAddresses,
    });
  } catch (err) {
    console.error("Backup failed:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
