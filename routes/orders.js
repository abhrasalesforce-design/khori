const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../database');
const { resolveCartItems } = require('./cartPricing');

function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.flash('error', 'Please log in to continue.');
    return res.redirect('/login');
  }
  next();
}

function getRazorpay() {
  const Razorpay = require('razorpay');
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
}

router.get('/checkout', async (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) return res.redirect('/cart');
  const items = await resolveCartItems(cart);
  const subtotal = items.reduce((sum, i) => sum + i.subtotal, 0);
  const shipping = subtotal < 699 ? 50 : 0;
  const total = subtotal + shipping;
  res.render('checkout', {
    items, subtotal, shipping, total,
    user: req.session.user || null,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || ''
  });
});

// Step 1 — create a Razorpay order (called via AJAX before showing the popup)
router.post('/checkout/create-order', async (req, res) => {
  try {
    const cart = req.session.cart || [];
    if (cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    const items = await resolveCartItems(cart);

    const productTotal = items.reduce((sum, i) => sum + i.discountedPrice * i.quantity, 0);
    const total = productTotal + (productTotal < 699 ? 50 : 0);

    const razorpay = getRazorpay();
    const rzpOrder = await razorpay.orders.create({
      amount: total * 100, // paise
      currency: 'INR',
      receipt: `khori_${Date.now()}`
    });

    // Store pending order details in session for verification step
    req.session.pendingOrder = {
      rzpOrderId: rzpOrder.id,
      total,
      items: items.map(i => ({ id: i.id, name: i.name, quantity: i.quantity, price: i.discountedPrice }))
    };
    req.session.save(() => {
      res.json({ orderId: rzpOrder.id, amount: rzpOrder.amount, currency: rzpOrder.currency });
    });
  } catch (err) {
    console.error('Create Razorpay order failed:', err);
    res.status(500).json({ error: 'Could not initiate payment. Please try again.' });
  }
});

// Step 2 — verify signature and save order after Razorpay payment success
router.post('/checkout/place', async (req, res) => {
  try {
    const { name, email, phone, address, city, zip, country,
            razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // Verify Razorpay signature
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      console.error('[Razorpay] Signature mismatch — possible tamper attempt');
      req.flash('error', 'Payment verification failed. Please contact support.');
      return res.redirect('/checkout');
    }

    // Signature valid — retrieve pending order from session
    const pending = req.session.pendingOrder;
    if (!pending || pending.rzpOrderId !== razorpay_order_id) {
      req.flash('error', 'Session expired. Please try again.');
      return res.redirect('/checkout');
    }

    const { total, items } = pending;

    // Save order (user_id is null for guest checkouts)
    const result = await db.run(
      'INSERT INTO orders (user_id, total, status, name, email, phone, address, city, zip, country, upi_txn_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.session.user?.id || null, total, 'paid', name, email, phone || null, address, city, zip, country, razorpay_payment_id]
    );
    const orderId = result.lastInsertRowid;

    for (const item of items) {
      await db.run('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)',
        [orderId, item.id, item.quantity, item.price]);
      await db.run('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity, item.id]);
    }

    // Auto-generate invoice
    try {
      const invResult = await db.run(
        'INSERT INTO invoices (customer_name, customer_phone, customer_address, shipping_name, shipping_phone, shipping_address, shipping_city, shipping_state, shipping_pincode, total, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [name, phone || null, `${address}, ${city}, ${zip}, ${country}`,
         name, phone || null, address, city, zip, country,
         total, `Razorpay payment ${razorpay_payment_id} — order #${orderId}`, null]
      );
      const invoiceId = invResult.lastInsertRowid;
      for (const item of items) {
        await db.run(
          'INSERT INTO invoice_items (invoice_id, product_id, product_name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)',
          [invoiceId, item.id, item.name, item.quantity, item.price]
        );
      }
    } catch (err) {
      console.error('Auto-invoice failed:', err.message);
    }

    // Email notification via Resend
    try {
      if (!process.env.RESEND_API_KEY) {
        console.warn('[Email] RESEND_API_KEY not set — skipping notification.');
      } else {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: 'smtp.resend.com', port: 465, secure: true,
          auth: { user: 'resend', pass: process.env.RESEND_API_KEY }
        });
        const itemLines = items.map(i => `• ${i.name} × ${i.quantity} — ₹${i.price * i.quantity}`).join('\n');
        await transporter.sendMail({
          from: 'Hathekhori Orders <onboarding@resend.dev>',
          to: 'contact.hathekhori@gmail.com',
          subject: `✅ New Order #${orderId} — ₹${total} — PAID`,
          text: `New paid order!\n\nOrder #${orderId}\nAmount: ₹${total}\nRazorpay Payment ID: ${razorpay_payment_id}\n\nCustomer:\nName: ${name}\nEmail: ${email}\nPhone: ${phone || '—'}\nAddress: ${address}, ${city}, ${zip}, ${country}\n\nItems:\n${itemLines}\n\nhttps://www.hathekhori.com/admin`,
          html: `
            <h2 style="color:#898AC4;">✅ New Paid Order #${orderId}</h2>
            <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
              <tr><td style="padding:6px 12px;color:#888;">Amount</td><td style="padding:6px 12px;font-weight:700;font-size:16px;">₹${total}</td></tr>
              <tr style="background:#f9f7f7;"><td style="padding:6px 12px;color:#888;">Payment ID</td><td style="padding:6px 12px;color:#898AC4;">${razorpay_payment_id}</td></tr>
              <tr><td style="padding:6px 12px;color:#888;">Customer</td><td style="padding:6px 12px;">${name}</td></tr>
              <tr style="background:#f9f7f7;"><td style="padding:6px 12px;color:#888;">Phone</td><td style="padding:6px 12px;">${phone || '—'}</td></tr>
              <tr><td style="padding:6px 12px;color:#888;">Email</td><td style="padding:6px 12px;">${email}</td></tr>
              <tr style="background:#f9f7f7;"><td style="padding:6px 12px;color:#888;">Address</td><td style="padding:6px 12px;">${address}, ${city}, ${zip}, ${country}</td></tr>
            </table>
            <h3 style="color:#898AC4;margin-top:20px;">Items</h3>
            <ul style="font-family:Arial,sans-serif;font-size:14px;">${items.map(i => `<li>${i.name} × ${i.quantity} — ₹${i.price * i.quantity}</li>`).join('')}</ul>
            <p style="margin-top:20px;"><a href="https://www.hathekhori.com/admin" style="background:#898AC4;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-family:Arial,sans-serif;font-weight:600;">View in Admin →</a></p>
          `
        });
        console.log(`[Email] Order #${orderId} notification sent.`);
      }
    } catch (err) {
      console.error('Order notification email failed:', err.message);
    }

    req.session.cart = [];
    req.session.pendingOrder = null;
    req.session.lastOrderId = orderId;
    req.session.save(() => {
      res.redirect(`/order-confirmation/${orderId}`);
    });

  } catch (err) {
    console.error('Checkout place error:', err);
    req.flash('error', 'Something went wrong. Please contact support.');
    res.redirect('/checkout');
  }
});

router.get('/order-confirmation/:id', async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order) return res.redirect('/');
  // Allow access if logged in as the order's owner, or if this is the session's just-placed order
  const isOwner = req.session.user && order.user_id === req.session.user.id;
  const isGuestSession = req.session.lastOrderId == req.params.id;
  if (!isOwner && !isGuestSession) return res.redirect('/');
  const items = await db.all(`
    SELECT oi.*, p.name AS product_name, p.image FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ?
  `, [order.id]);
  order.phone = order.phone || null;
  order.upi_txn_id = order.upi_txn_id || null;
  res.render('confirmation', { order, items, user: req.session.user });
});

router.get('/orders', requireLogin, async (req, res) => {
  const orders = await db.all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC', [req.session.user.id]);
  res.render('orders', { orders, user: req.session.user });
});

module.exports = router;
