// "How was your order?" emails. Sent once when an order is marked delivered
// (or on demand from admin). Each email links to /reviews/order/:id/:token,
// where the token is an HMAC of the order id, so customers (including guests)
// can review without logging in and links can't be guessed for other orders.
const crypto = require('crypto');
const { db } = require('../database');
const { sendMail, isConfigured, escapeHtml } = require('./mailer');

const SITE = (process.env.BASE_URL || 'https://www.hathekhori.com').replace(/\/$/, '');
const secret = () => process.env.SESSION_SECRET || 'khori_dev_secret';

function reviewToken(orderId) {
  return crypto.createHmac('sha256', secret()).update('review-order:' + Number(orderId)).digest('hex').slice(0, 32);
}

function validToken(orderId, token) {
  const expected = Buffer.from(reviewToken(orderId));
  const given = Buffer.from(String(token || ''));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function reviewLink(orderId, productId, rating) {
  const q = productId ? `?p=${productId}${rating ? '&r=' + rating : ''}#p${productId}` : '';
  return `${SITE}/reviews/order/${orderId}/${reviewToken(orderId)}${q}`;
}

function imageUrl(p) {
  let imgs = [];
  try { imgs = p.images ? JSON.parse(p.images) : []; } catch (_) {}
  const img = imgs[0] || p.image;
  if (!img || img === 'placeholder.jpg') return `${SITE}/images/no-image.jpg`;
  return img.startsWith('http') ? img : `${SITE}/uploads/${img}`;
}

async function orderItems(orderId) {
  return db.all(
    `SELECT DISTINCT oi.product_id, p.name, p.image, p.images
     FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ? AND p.category != 'basket-addon'`, [orderId]);
}

function buildEmail(order, items) {
  const first = String(order.name || '').trim().split(/\s+/)[0] || 'there';
  const star = (pid, n) =>
    `<a href="${reviewLink(order.id, pid, n)}" style="text-decoration:none;color:#F5A623;font-size:26px;line-height:1;padding:0 1px;" title="${n} star${n > 1 ? 's' : ''}">★</a>`;
  const rows = items.map(it => `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #f0ebf4;width:72px;vertical-align:top;">
        <img src="${imageUrl(it)}" width="64" height="64" alt="" style="border-radius:8px;object-fit:cover;display:block;border:1px solid #eee;">
      </td>
      <td style="padding:14px 0 14px 14px;border-bottom:1px solid #f0ebf4;vertical-align:top;font-family:Arial,sans-serif;">
        <div style="font-size:15px;color:#3a3a5c;font-weight:600;margin-bottom:6px;">${escapeHtml(it.name)}</div>
        <div>${[1, 2, 3, 4, 5].map(n => star(it.product_id, n)).join('')}</div>
        <div style="font-size:12px;color:#8a8aa3;margin-top:4px;">Tap a star to rate</div>
      </td>
    </tr>`).join('');
  const html = `
  <div style="background:#F6F4E8;padding:24px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border-top:4px solid #898AC4;">
      <tr><td style="padding:28px 28px 8px;text-align:center;font-family:Arial,sans-serif;">
        <img src="${SITE}/icon-192.png" width="56" height="56" alt="Hathekhori" style="border-radius:50%;">
        <h1 style="font-family:Georgia,serif;color:#3a3a5c;font-size:24px;margin:14px 0 8px;">How was your order?</h1>
        <p style="color:#6b6b8a;font-size:15px;line-height:1.6;margin:0;">Hi ${escapeHtml(first)}, we hope you're enjoying your handmade pieces from order #${order.id}.
        Your review helps our artisans and other shoppers. It only takes a moment.</p>
      </td></tr>
      <tr><td style="padding:8px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
      <tr><td style="padding:18px 28px 30px;text-align:center;">
        <a href="${reviewLink(order.id)}" style="display:inline-block;background:#898AC4;color:#fff;text-decoration:none;font-family:Arial,sans-serif;font-weight:600;font-size:14px;padding:12px 28px;border-radius:8px;">Write a review</a>
        <p style="font-family:Arial,sans-serif;font-size:12px;color:#aaa;margin:18px 0 0;">Thank you for supporting handmade. – Team Hathekhori</p>
      </td></tr>
    </table>
  </div>`;
  const text = `Hi ${first},\n\nHow was your Hathekhori order #${order.id}? We'd love your review:\n\n` +
    items.map(it => `• ${it.name}: ${reviewLink(order.id, it.product_id)}`).join('\n') +
    `\n\nOr review everything at once: ${reviewLink(order.id)}\n\nThank you for supporting handmade.\n– Team Hathekhori`;
  return { html, text };
}

// Sends the email for one order. force=true re-sends even if already sent.
// Returns { sent: true } or { sent: false, reason }.
async function sendReviewRequest(orderId, { force = false } = {}) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) return { sent: false, reason: 'Order not found' };
  if (order.status !== 'delivered') return { sent: false, reason: 'Order is not marked delivered' };
  if (!order.email) return { sent: false, reason: 'Order has no email address' };
  if (order.review_request_sent_at && !force) return { sent: false, reason: 'Already sent' };
  if (!isConfigured()) return { sent: false, reason: 'Email is not configured' };
  const items = await orderItems(order.id);
  if (!items.length) return { sent: false, reason: 'Order has no products' };
  const { html, text } = buildEmail(order, items);
  await sendMail({ label: 'Hathekhori', to: order.email, subject: 'How was your Hathekhori order? ★★★★★', html, text });
  await db.run('UPDATE orders SET review_request_sent_at = ? WHERE id = ?', [new Date().toISOString(), order.id]);
  return { sent: true };
}

module.exports = { reviewToken, validToken, reviewLink, sendReviewRequest, orderItems, imageUrl };
