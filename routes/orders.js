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
    if (!product) return null;
    const discountedPrice = Math.floor(product.price * 0.5);
    return { ...product, discountedPrice, quantity: item.quantity, subtotal: discountedPrice * item.quantity };
  }))).filter(Boolean);
  const subtotal = items.reduce((sum, i) => sum + i.subtotal, 0);
  const shipping = subtotal < 699 ? 50 : 0;
  const total = subtotal + shipping;
  res.render('checkout', { items, subtotal, shipping, total, user: req.session.user, paypalClientId: process.env.PAYPAL_CLIENT_ID });
});

router.post('/checkout/place', requireLogin, async (req, res) => {
  try {
  const { name, email, phone, address, city, zip, country, upi_txn_id } = req.body;
  const cart = req.session.cart || [];
  if (cart.length === 0) return res.redirect('/cart');

  const items = (await Promise.all(cart.map(async item => {
    const product = await db.get('SELECT * FROM products WHERE id = ?', [item.id]);
    if (!product) return null;
    const discountedPrice = Math.floor(product.price * 0.5);
    return { ...product, discountedPrice, quantity: item.quantity };
  }))).filter(Boolean);

  const productTotal = items.reduce((sum, i) => sum + i.discountedPrice * i.quantity, 0);
  const total = productTotal + (productTotal < 699 ? 50 : 0);

  // Try with new columns first, fall back if they don't exist yet on Postgres
  let result;
  try {
    result = await db.run(
      'INSERT INTO orders (user_id, total, status, name, email, phone, address, city, zip, country, upi_txn_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.session.user.id, total, 'payment_pending', name, email, phone || null, address, city, zip, country, upi_txn_id || null]
    );
  } catch (colErr) {
    // Columns may not exist yet — insert without them and log
    console.error('Order insert with new cols failed, retrying without:', colErr.message);
    result = await db.run(
      'INSERT INTO orders (user_id, total, status, name, email, address, city, zip, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.session.user.id, total, 'payment_pending', name, email, address, city, zip, country]
    );
  }
  const orderId = result.lastInsertRowid;

  for (const item of items) {
    await db.run('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)', [orderId, item.id, item.quantity, item.discountedPrice]);
    await db.run('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity, item.id]);
  }

  // Auto-generate invoice for this order
  try {
    const invResult = await db.run(
      'INSERT INTO invoices (customer_name, customer_phone, customer_address, shipping_name, shipping_phone, shipping_address, shipping_city, shipping_state, shipping_pincode, total, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name, phone || null, `${address}, ${city}, ${zip}, ${country}`,
       name, phone || null, address, city, zip, country,
       total, `Auto-generated from online order #${orderId}`, null]
    );
    const invoiceId = invResult.lastInsertRowid;
    for (const item of items) {
      await db.run(
        'INSERT INTO invoice_items (invoice_id, product_id, product_name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)',
        [invoiceId, item.id, item.name, item.quantity, item.discountedPrice]
      );
    }
  } catch (err) {
    console.error('Auto-invoice generation failed:', err.message);
  }

  // Email notification to shop owner
  try {
    const nodemailer = require('nodemailer');
    if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
      });
      const itemLines = items.map(i => `• ${i.name} × ${i.quantity} — ₹${i.discountedPrice * i.quantity}`).join('\n');
      await transporter.sendMail({
        from: `"Hathekhori Orders" <${process.env.GMAIL_USER}>`,
        to: 'contact.hathekhori@gmail.com',
        subject: `🛍 New Order #${orderId} — ₹${total} — UTR: ${upi_txn_id || 'N/A'}`,
        text: `New order received!\n\nOrder #${orderId}\nAmount: ₹${total}\nTransaction ID / UTR: ${upi_txn_id || 'Not provided'}\n\nCustomer Details:\nName: ${name}\nEmail: ${email}\nWhatsApp: ${phone || 'Not provided'}\nAddress: ${address}, ${city}, ${zip}, ${country}\n\nItems:\n${itemLines}\n\nVerify the UTR in your UPI app and mark the order as paid in admin:\nhttps://www.hathekhori.com/admin`,
        html: `
          <h2 style="color:#898AC4;">New Order #${orderId}</h2>
          <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
            <tr><td style="padding:6px 12px;color:#888;">Amount</td><td style="padding:6px 12px;font-weight:700;font-size:16px;">₹${total}</td></tr>
            <tr style="background:#f9f7f7;"><td style="padding:6px 12px;color:#888;">Transaction ID / UTR</td><td style="padding:6px 12px;font-weight:700;color:#898AC4;">${upi_txn_id || 'Not provided'}</td></tr>
            <tr><td style="padding:6px 12px;color:#888;">Customer</td><td style="padding:6px 12px;">${name}</td></tr>
            <tr style="background:#f9f7f7;"><td style="padding:6px 12px;color:#888;">WhatsApp</td><td style="padding:6px 12px;">${phone || '—'}</td></tr>
            <tr><td style="padding:6px 12px;color:#888;">Email</td><td style="padding:6px 12px;">${email}</td></tr>
            <tr style="background:#f9f7f7;"><td style="padding:6px 12px;color:#888;">Address</td><td style="padding:6px 12px;">${address}, ${city}, ${zip}, ${country}</td></tr>
          </table>
          <h3 style="color:#898AC4;margin-top:20px;">Items Ordered</h3>
          <ul style="font-family:Arial,sans-serif;font-size:14px;">${items.map(i => `<li>${i.name} × ${i.quantity} — ₹${i.discountedPrice * i.quantity}</li>`).join('')}</ul>
          <p style="margin-top:20px;"><a href="https://www.hathekhori.com/admin" style="background:#898AC4;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-family:Arial,sans-serif;font-weight:600;">View in Admin →</a></p>
          <p style="color:#aaa;font-size:12px;margin-top:16px;">Verify UTR in your UPI app, then mark the order as <strong>paid</strong> in admin.</p>
        `
      });
    }
  } catch (err) {
    console.error('Order notification email failed:', err.message);
  }

  req.session.cart = [];
  res.redirect(`/order-confirmation/${orderId}`);
  } catch (err) {
    console.error('Checkout error:', err);
    req.flash('error', 'Something went wrong placing your order. Please try again.');
    res.redirect('/checkout');
  }
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
