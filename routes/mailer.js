// Sends email through Resend's HTTPS API (https://resend.com/docs/api-reference/emails/send-email).
// The HTTPS API is used instead of SMTP because Railway blocks outgoing SMTP
// connections on its Free/Trial/Hobby plans, which made sends hang (502).
//
// Sender address: EMAIL_FROM in Railway (e.g. "no-reply@hathekhori.com"), which
// must be on a domain verified in Resend. Without it Resend's test sender
// onboarding@resend.dev is used, which only delivers to the Resend account owner.
const RESEND_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
const TIMEOUT_MS = 15000;

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// label: display name shown in the inbox, e.g. "Hathekhori Orders"
function fromAddress(label = 'Hathekhori') {
  const configured = (process.env.EMAIL_FROM || '').trim();
  const addr = configured || 'onboarding@resend.dev';
  return addr.includes('<') ? addr : `${label} <${addr}>`;
}

async function sendMail({ label, to, subject, text, html, replyTo }) {
  if (!isConfigured()) throw new Error('RESEND_API_KEY is not set');
  const body = { from: fromAddress(label), to: Array.isArray(to) ? to : [to], subject };
  if (text) body.text = text;
  if (html) body.html = html;
  if (replyTo) body.reply_to = replyTo;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? `Resend did not respond within ${TIMEOUT_MS / 1000}s` : `Could not reach Resend: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${data.message || data.name || 'unknown error'}`);
  return data; // { id }
}

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { sendMail, isConfigured, fromAddress, escapeHtml };
