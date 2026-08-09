const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { resolveCartItems } = require('./cartPricing');

async function syncCart(req) {
  const sessionId = req.sessionID;
  const items = req.session.cart || [];
  const userId = req.session.user?.id || null;
  if (items.length === 0) {
    await db.run('DELETE FROM carts WHERE session_id = ?', [sessionId]);
  } else {
    await db.run(
      `INSERT INTO carts (session_id, user_id, items, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(session_id) DO UPDATE SET user_id = excluded.user_id, items = excluded.items, updated_at = CURRENT_TIMESTAMP`,
      [sessionId, userId, JSON.stringify(items)]
    );
  }
}

router.get('/cart', async (req, res) => {
  const items = await resolveCartItems(req.session.cart || []);
  const subtotal = items.reduce((sum, i) => sum + i.subtotal, 0);
  const shipping = subtotal < 699 ? 50 : 0;
  const total = subtotal + shipping;
  res.render('cart', { items, subtotal, shipping, total, user: req.session.user || null });
});

router.post('/cart/add', async (req, res) => {
  const { product_id, quantity } = req.body;
  const qty = parseInt(quantity) || 1;
  const product = await db.get('SELECT * FROM products WHERE id = ?', [product_id]);
  if (!product || product.stock < 1) return res.redirect('/');
  if (!req.session.cart) req.session.cart = [];
  const existing = req.session.cart.find(i => i.id == product_id);
  if (existing) {
    existing.quantity = Math.min(existing.quantity + qty, product.stock);
  } else {
    req.session.cart.push({ id: parseInt(product_id), quantity: qty });
  }
  await syncCart(req);
  res.redirect('/cart');
});

router.post('/cart/update', async (req, res) => {
  const { product_id, quantity } = req.body;
  const qty = parseInt(quantity);
  if (!req.session.cart) return res.redirect('/cart');
  if (qty <= 0) {
    req.session.cart = req.session.cart.filter(i => i.id != product_id);
  } else {
    const item = req.session.cart.find(i => i.id == product_id);
    if (item) item.quantity = qty;
  }
  await syncCart(req);
  res.redirect('/cart');
});

router.post('/cart/remove', async (req, res) => {
  const { product_id } = req.body;
  if (req.session.cart) req.session.cart = req.session.cart.filter(i => i.id != product_id);
  await syncCart(req);
  res.redirect('/cart');
});

module.exports = router;
