const express = require('express');
const router = express.Router();
const { db } = require('../database');

router.get('/cart', async (req, res) => {
  const cart = req.session.cart || [];
  const items = (await Promise.all(cart.map(async item => {
    const product = await db.get('SELECT * FROM products WHERE id = ?', [item.id]);
    if (!product) return null;
    const discountedPrice = Math.floor(product.price * 0.5);
    return { ...product, discountedPrice, quantity: item.quantity, subtotal: discountedPrice * item.quantity };
  }))).filter(Boolean);
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
  res.redirect('/cart');
});

router.post('/cart/remove', (req, res) => {
  const { product_id } = req.body;
  if (req.session.cart) req.session.cart = req.session.cart.filter(i => i.id != product_id);
  res.redirect('/cart');
});

module.exports = router;
