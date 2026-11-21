const express = require('express');
const router = express.Router();
const { db } = require('../database');

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Login required' });
  next();
}

// Returns products from delivered orders that the user hasn't reviewed yet
router.get('/pending', requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const pending = await db.all(`
    SELECT DISTINCT oi.product_id, oi.order_id, p.name, p.image, p.images
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    WHERE o.user_id = ?
      AND o.status = 'delivered'
      AND NOT EXISTS (
        SELECT 1 FROM reviews r
        WHERE r.user_id = ? AND r.product_id = oi.product_id AND r.order_id = oi.order_id
      )
  `, [userId, userId]);
  res.json({ pending });
});

// Submit a review
router.post('/submit', requireLogin, async (req, res) => {
  const { product_id, order_id, rating, comment } = req.body;
  const userId = req.session.user.id;
  const r = parseInt(rating);
  if (!product_id || !order_id || !r || r < 1 || r > 5) {
    return res.status(400).json({ error: 'Invalid input' });
  }
  // Verify the order belongs to this user and is delivered
  const order = await db.get(
    'SELECT id FROM orders WHERE id = ? AND user_id = ? AND status = ?',
    [order_id, userId, 'delivered']
  );
  if (!order) return res.status(403).json({ error: 'Not eligible' });

  try {
    await db.run(
      'INSERT INTO reviews (user_id, product_id, order_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
      [userId, product_id, order_id, r, comment || null]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.json({ ok: true }); // already reviewed
    res.status(500).json({ error: 'Failed to save review' });
  }
});

// ===== Shared helpers (product pages, collection cards) =====

// { productId: { avg, count } } for visible reviews of the given products
async function getRatingMap(productIds) {
  const ids = [...new Set((productIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return {};
  const ph = ids.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT product_id, AVG(rating) AS avg, COUNT(*) AS count FROM reviews
     WHERE COALESCE(hidden, 0) = 0 AND product_id IN (${ph}) GROUP BY product_id`, ids);
  const map = {};
  for (const r of rows) map[r.product_id] = { avg: Number(r.avg), count: Number(r.count) };
  return map;
}

// Visible reviews for one product, newest first, with the reviewer's first name
async function getProductReviews(productId) {
  const rows = await db.all(
    `SELECT r.id, r.rating, r.comment, r.created_at, COALESCE(u.name, r.reviewer_name) AS user_name
     FROM reviews r LEFT JOIN users u ON u.id = r.user_id
     WHERE r.product_id = ? AND COALESCE(r.hidden, 0) = 0
     ORDER BY r.created_at DESC, r.id DESC`, [productId]);
  return rows.map(r => ({ ...r, first_name: String(r.user_name || 'Customer').trim().split(/\s+/)[0] }));
}

// ===== Write / edit a review (linked from My Orders) =====
function requireLoginPage(req, res, next) {
  if (!req.session.user) {
    req.flash('error', 'Please log in to write a review.');
    return res.redirect('/login');
  }
  next();
}

// The order must belong to the user, be delivered, and contain the product
async function eligibleItem(userId, orderId, productId) {
  return db.get(
    `SELECT oi.product_id, oi.order_id, p.name, p.image, p.images
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products p ON p.id = oi.product_id
     WHERE o.id = ? AND o.user_id = ? AND o.status = 'delivered' AND oi.product_id = ?
     LIMIT 1`, [orderId, userId, productId]);
}

router.get('/write/:orderId/:productId', requireLoginPage, async (req, res) => {
  const item = await eligibleItem(req.session.user.id, req.params.orderId, req.params.productId);
  if (!item) {
    req.flash('error', 'You can review products from your delivered orders.');
    return res.redirect('/orders');
  }
  const existing = await db.get('SELECT rating, comment FROM reviews WHERE user_id = ? AND product_id = ? AND order_id = ?',
    [req.session.user.id, item.product_id, item.order_id]);
  let imgs = [];
  try { imgs = item.images ? JSON.parse(item.images) : []; } catch (_) {}
  const img = imgs[0] || item.image || 'placeholder.jpg';
  res.render('review-form', {
    user: req.session.user, item, existing,
    imageUrl: img.startsWith('http') ? img : '/uploads/' + img,
    error: req.flash('error'),
  });
});

router.post('/write/:orderId/:productId', requireLoginPage, async (req, res) => {
  const userId = req.session.user.id;
  const item = await eligibleItem(userId, req.params.orderId, req.params.productId);
  if (!item) return res.redirect('/orders');
  const rating = parseInt(req.body.rating);
  const comment = String(req.body.comment || '').trim().slice(0, 2000) || null;
  if (!(rating >= 1 && rating <= 5)) {
    req.flash('error', 'Please choose a star rating.');
    return res.redirect(`/reviews/write/${item.order_id}/${item.product_id}`);
  }
  const existing = await db.get('SELECT id FROM reviews WHERE user_id = ? AND product_id = ? AND order_id = ?',
    [userId, item.product_id, item.order_id]);
  if (existing) {
    await db.run('UPDATE reviews SET rating = ?, comment = ? WHERE id = ?', [rating, comment, existing.id]);
  } else {
    await db.run('INSERT INTO reviews (user_id, product_id, order_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
      [userId, item.product_id, item.order_id, rating, comment]);
  }
  req.flash('success', existing ? 'Your review has been updated.' : 'Thank you! Your review is now live on the product page.');
  res.redirect('/orders');
});

// ===== One-click review page from the "How was your order?" email =====
// No login needed: the link's token proves it came from the email for this order.
async function loadOrderForReview(req) {
  const { validToken, orderItems, imageUrl } = require('./reviewRequests');
  const orderId = parseInt(req.params.orderId);
  if (!orderId || !validToken(orderId, req.params.token)) return null;
  const order = await db.get('SELECT id, user_id, name, status FROM orders WHERE id = ?', [orderId]);
  if (!order || order.status !== 'delivered') return null;
  const reviewerId = order.user_id || 0; // 0 = guest checkout
  const items = (await orderItems(order.id)).map(it => ({ ...it, imageUrl: imageUrl(it) }));
  const existing = await db.all('SELECT product_id, rating, comment FROM reviews WHERE order_id = ? AND user_id = ?', [order.id, reviewerId]);
  for (const it of items) {
    const e = existing.find(x => x.product_id === it.product_id);
    it.rating = e ? e.rating : null;
    it.comment = e ? e.comment : '';
  }
  return { order, reviewerId, items };
}

router.get('/order/:orderId/:token', async (req, res) => {
  const data = await loadOrderForReview(req);
  if (!data) return res.status(404).render('review-order', { user: req.session.user || null, invalid: true });
  // Pre-select the star the customer tapped in the email
  const p = parseInt(req.query.p), r = parseInt(req.query.r);
  if (p && r >= 1 && r <= 5) {
    const it = data.items.find(i => i.product_id === p);
    if (it && !it.rating) it.rating = r;
  }
  res.render('review-order', { user: req.session.user || null, invalid: false, saved: false, focus: p || null, ...data, token: req.params.token });
});

router.post('/order/:orderId/:token', async (req, res) => {
  const data = await loadOrderForReview(req);
  if (!data) return res.status(404).render('review-order', { user: req.session.user || null, invalid: true });
  const { order, reviewerId, items } = data;
  const reviewerName = String(order.name || '').trim().slice(0, 100) || null;
  let saved = 0;
  for (const it of items) {
    const rating = parseInt(req.body['rating_' + it.product_id]);
    if (!(rating >= 1 && rating <= 5)) continue;
    const comment = String(req.body['comment_' + it.product_id] || '').trim().slice(0, 2000) || null;
    const existing = await db.get('SELECT id FROM reviews WHERE user_id = ? AND product_id = ? AND order_id = ?', [reviewerId, it.product_id, order.id]);
    if (existing) {
      await db.run('UPDATE reviews SET rating = ?, comment = ?, reviewer_name = ? WHERE id = ?', [rating, comment, reviewerName, existing.id]);
    } else {
      await db.run('INSERT INTO reviews (user_id, product_id, order_id, rating, comment, reviewer_name) VALUES (?, ?, ?, ?, ?, ?)',
        [reviewerId, it.product_id, order.id, rating, comment, reviewerName]);
    }
    it.rating = rating; it.comment = comment || '';
    saved++;
  }
  res.render('review-order', { user: req.session.user || null, invalid: false, saved, focus: null, ...data, token: req.params.token,
    error: saved ? null : 'Please tap the stars for at least one product.' });
});

module.exports = router;
module.exports.getRatingMap = getRatingMap;
module.exports.getProductReviews = getProductReviews;
