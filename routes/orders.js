const express = require('express');
const router = express.Router();
const { db } = require('../database');

function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.flash('error', 'Please log in to continue.');
    return res.redirect('/login');
  }
  next();
}

router.get('/checkout', requireLogin, async (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) return res.redirect('/cart');
  const items = (await Promise.all(cart.map(async item => {
    const product = await db.get('SELECT * FROM products WHERE id = ?', [item.id]);
    return product ? { ...product, quantity: item.quantity, subtotal: product.price * item.quantity } : null;
  }))).filter(Boolean);
  const subtotal = items.reduce((sum, i) => sum + i.subtotal, 0);
  const shipping = subtotal < 499 ? 50 : 0;
  const total = subtotal + shipping;
  res.render('checkout', { items, subtotal, shipping, total, user: req.session.user, paypalClientId: process.env.PAYPAL_CLIENT_ID });
});

router.post('/checkout/place', requireLogin, async (req, res) => {
  const { name, email, address, city, zip, country, paypal_order_id } = req.body;
  const cart = req.session.cart || [];
  if (cart.length === 0) return res.redirect('/cart');

  const items = (await Promise.all(cart.map(async item => {
    const product = await db.get('SELECT * FROM products WHERE id = ?', [item.id]);
    return product ? { ...product, quantity: item.quantity } : null;
  }))).filter(Boolean);

  const productTotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const total = productTotal + (productTotal < 499 ? 50 : 0);

  const result = await db.run(
    'INSERT INTO orders (user_id, total, status, paypal_order_id, name, email, address, city, zip, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [req.session.user.id, total, paypal_order_id ? 'paid' : 'pending', paypal_order_id || null, name, email, address, city, zip, country]
  );
  const orderId = result.lastInsertRowid;

  for (const item of items) {
    await db.run('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)', [orderId, item.id, item.quantity, item.price]);
    await db.run('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity, item.id]);
  }

  req.session.cart = [];
  res.redirect(`/order-confirmation/${orderId}`);
});

router.get('/order-confirmation/:id', requireLogin, async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
  if (!order) return res.redirect('/');
  const items = await db.all(`
    SELECT oi.*, p.name AS product_name, p.image FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ?
  `, [order.id]);
  res.render('confirmation', { order, items, user: req.session.user });
});

router.get('/orders', requireLogin, async (req, res) => {
  const orders = await db.all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC', [req.session.user.id]);
  res.render('orders', { orders, user: req.session.user });
});

module.exports = router;
