// Sends email through Resend's SMTP service.
//
// Sender address: set EMAIL_FROM in Railway (e.g. "no-reply@hathekhori.com") once
// hathekhori.com is verified in Resend. Until then Resend's test sender
// onboarding@resend.dev is used, which Resend only delivers to the email address
// that owns the Resend account — fine for shop notifications to the owner, but
// customer emails (password resets) are rejected.
const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.resend.com', port: 465, secure: true,
      auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
    });
  }
  return transporter;
}

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// label: display name shown in the inbox, e.g. "Hathekhori Orders"
function fromAddress(label = 'Hathekhori') {
  const configured = (process.env.EMAIL_FROM || '').trim();
  const addr = configured || 'onboarding@resend.dev';
  return addr.includes('<') ? addr : `${label} <${addr}>`;
}

async function sendMail({ label, ...message }) {
  if (!isConfigured()) throw new Error('RESEND_API_KEY is not set');
  return getTransporter().sendMail({ from: fromAddress(label), ...message });
}

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { sendMail, isConfigured, fromAddress, escapeHtml };
