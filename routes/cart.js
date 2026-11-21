const express = require('express');
const router = express.Router();
const { db } = require('../database');
const { getDiscountMap, applyDiscount } = require('./cartPricing');
const { gaItem, ecommerce, queueGaEvent } = require('./analytics');
const { checkCoupon, priceCart, couponFlash } = require('./coupons');

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
  const pricing = await priceCart(req);
  const { items, subtotal, shipping, total } = pricing;
  const gaPageEvents = items.length ? [{ name: 'view_cart', params: ecommerce(items.map(i => gaItem(i, i.quantity, i.discountedPrice))) }] : [];
  res.render('cart', { ...pricing, user: req.session.user || null, gaPageEvents, ...couponFlash(req, pricing) });
});

// ===== Coupon codes (cart and checkout pages) =====
const backTo = req => (req.body.from === 'checkout' ? '/checkout' : '/cart');

router.post('/cart/coupon', async (req, res) => {
  const check = await checkCoupon(req.body.code, req);
  if (check.ok) {
    req.session.coupon = check.code;
    req.flash('couponSuccess', `${check.code} applied — ${check.coupon.description}.`);
  } else {
    req.flash('couponError', check.error);
    if (check.login) req.flash('couponLogin', '1');
  }
  res.redirect(backTo(req));
});

router.post('/cart/coupon/remove', (req, res) => {
  req.session.coupon = null;
  res.redirect(backTo(req));
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
  const price = applyDiscount(product.price, product.category, await getDiscountMap());
  queueGaEvent(req, 'add_to_cart', ecommerce([gaItem(product, qty, price)]));
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
  const removed = (req.session.cart || []).find(i => i.id == product_id);
  if (removed) {
    const product = await db.get('SELECT * FROM products WHERE id = ?', [removed.id]);
    if (product) {
      const price = applyDiscount(product.price, product.category, await getDiscountMap());
      queueGaEvent(req, 'remove_from_cart', ecommerce([gaItem(product, removed.quantity, price)]));
    }
  }
  if (req.session.cart) req.session.cart = req.session.cart.filter(i => i.id != product_id);
  await syncCart(req);
  res.redirect('/cart');
});

module.exports = router;
