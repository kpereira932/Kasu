const ALLOWED_EVENTS = new Set(["LOGIN_LOCKED","ROLE_CHANGE_ADMIN","DAY_END_ODD_HOURS"]);
const EVENT_META = {
  LOGIN_LOCKED:      { label: "🔒 Account Locked",      color: "#C0392B" },
  ROLE_CHANGE_ADMIN: { label: "👤 Admin Role Changed",  color: "#E67E22" },
  DAY_END_ODD_HOURS: { label: "🌙 Day End – Odd Hours", color: "#8E44AD" },
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const alertSecret = process.env.ALERT_SECRET;
  if (alertSecret && req.headers["x-alert-secret"] !== alertSecret)
    return res.status(401).json({ error: "Unauthorized" });

  const resendKey   = process.env.RESEND_API_KEY;
  const emailsRaw   = process.env.BACKUP_EMAILS || process.env.BACKUP_EMAIL || "";
  const toAddresses = emailsRaw.split(",").map(e => e.trim()).filter(Boolean);
  const fromAddress = process.env.BACKUP_FROM || "Kāsu Alerts <onboarding@resend.dev>";

  if (!resendKey || toAddresses.length === 0) {
    console.warn("alert.js: missing env vars — alert not sent");
    return res.status(200).json({ ok: false, reason: "not configured" });
  }

  const { event, detail, userId, outlet } = req.body || {};
  if (!event || !ALLOWED_EVENTS.has(event))
    return res.status(400).json({ error: "Unknown or missing event type" });

  const meta   = EVENT_META[event];
  const nowUTC = new Date().toISOString();
  const nowIST = new Date(Date.now() + 5.5*60*60*1000).toISOString().replace("T"," ").slice(0,19)+" IST";

  try {
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromAddress, to: toAddresses,
        subject: `${meta.label} — Kāsu Security Alert`,
        html: `<div style="font-family:sans-serif;max-width:520px">
          <h2 style="color:${meta.color}">${meta.label}</h2>
          <p style="color:#888;font-size:13px">${nowIST}</p>
          <table style="font-size:14px">
            <tr><td style="padding:4px 16px 4px 0;color:#888">Event</td><td><strong>${event}</strong></td></tr>
            <tr><td style="padding:4px 16px 4px 0;color:#888">Detail</td><td>${detail||"—"}</td></tr>
            ${userId?`<tr><td style="padding:4px 16px 4px 0;color:#888">User</td><td><code>${userId}</code></td></tr>`:""}
            ${outlet?`<tr><td style="padding:4px 16px 4px 0;color:#888">Outlet</td><td>${outlet}</td></tr>`:""}
            <tr><td style="padding:4px 16px 4px 0;color:#888">UTC</td><td><code>${nowUTC}</code></td></tr>
          </table>
          <p style="font-size:12px;color:#aaa;margin-top:20px">Kāsu alert function · Vercel</p>
        </div>`,
      }),
    });
    if (!emailRes.ok) return res.status(502).json({ error: `Resend: ${emailRes.status}` });
    return res.status(200).json({ ok: true, event, sentTo: toAddresses });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};
