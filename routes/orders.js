const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../database');
const { gaItem, ecommerce, queueGaEvent } = require('./analytics');
const { priceCart, couponFlash } = require('./coupons');

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

// Owner notification for a paid order: customer details + product table.
function ownerOrderEmail(o) {
  const { escapeHtml: e } = require('./mailer');
  const SITE = 'https://www.hathekhori.com';
  const digits = String(o.phone || '').replace(/\D/g, '');
  const wa = digits ? (digits.length === 10 ? '91' + digits : digits) : '';
  const subtotal = o.items.reduce((s, i) => s + i.price * i.quantity, 0);
  const shipping = Math.max(0, Number(o.total) + Number(o.discount || 0) - subtotal);
  const addr = [o.address, o.city, o.zip, o.country].filter(Boolean).join(', ');
  const td = 'padding:8px 10px;border-bottom:1px solid #eee;';
  const row = (label, value) => `<tr><td style="padding:6px 12px;color:#888;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:6px 12px;">${value}</td></tr>`;
  const itemRows = o.items.map(i => `
    <tr>
      <td style="${td}color:#999;font-size:12px;">HK-${String(i.id).padStart(3, '0')}</td>
      <td style="${td}"><a href="${SITE}/product/${i.id}" style="color:#3a3a5c;">${e(i.name)}</a></td>
      <td style="${td}text-align:center;">${i.quantity}</td>
      <td style="${td}text-align:right;">₹${i.price}</td>
      <td style="${td}text-align:right;font-weight:600;">₹${i.price * i.quantity}</td>
    </tr>`).join('');
  const sumRow = (label, value, bold) => `<tr><td colspan="4" style="padding:6px 10px;text-align:right;color:#666;">${label}</td><td style="padding:6px 10px;text-align:right;${bold ? 'font-weight:700;font-size:15px;' : ''}">${value}</td></tr>`;
  const html = `
  <div style="font-family:Arial,sans-serif;font-size:14px;color:#3a3a5c;max-width:640px;">
    <h2 style="color:#898AC4;margin:0 0 4px;">✅ New Paid Order #${o.orderId}</h2>
    <p style="margin:0 0 16px;color:#666;">₹${o.total} paid via Razorpay · ${o.items.reduce((s, i) => s + i.quantity, 0)} item(s)</p>

    <h3 style="color:#898AC4;margin:18px 0 6px;">Customer</h3>
    <table style="border-collapse:collapse;font-size:14px;">
      ${row('Name', `<strong>${e(o.name)}</strong>`)}
      ${row('Phone', o.phone ? `<a href="tel:${e(o.phone)}" style="color:#3a3a5c;">${e(o.phone)}</a>${wa ? ` &nbsp;·&nbsp; <a href="https://wa.me/${wa}" style="color:#25a244;">WhatsApp</a>` : ''}` : '—')}
      ${row('Email', o.email ? `<a href="mailto:${e(o.email)}" style="color:#3a3a5c;">${e(o.email)}</a>` : '—')}
      ${row('Ship to', e(addr) || '—')}
    </table>

    <h3 style="color:#898AC4;margin:22px 0 6px;">Products</h3>
    <table style="border-collapse:collapse;width:100%;font-size:14px;">
      <tr style="background:#f6f4fb;">
        <th style="padding:8px 10px;text-align:left;font-size:12px;color:#888;">Code</th>
        <th style="padding:8px 10px;text-align:left;font-size:12px;color:#888;">Product</th>
        <th style="padding:8px 10px;font-size:12px;color:#888;">Qty</th>
        <th style="padding:8px 10px;text-align:right;font-size:12px;color:#888;">Price</th>
        <th style="padding:8px 10px;text-align:right;font-size:12px;color:#888;">Total</th>
      </tr>
      ${itemRows}
      ${sumRow('Subtotal', `₹${subtotal}`)}
      ${o.couponCode ? sumRow(`Coupon ${e(o.couponCode)}`, `−₹${o.discount}`) : ''}
      ${sumRow('Shipping', shipping ? `₹${shipping}` : 'Free')}
      ${sumRow('Total paid', `₹${o.total}`, true)}
    </table>

    <p style="margin:16px 0 0;font-size:12px;color:#999;">Razorpay payment ID: ${e(o.razorpay_payment_id)}</p>
    <p style="margin-top:20px;"><a href="${SITE}/admin/orders/${o.orderId}" style="background:#898AC4;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;">View order in Admin →</a></p>
    <p style="font-size:12px;color:#999;">Reply to this email to contact the customer directly.</p>
  </div>`;
  const text = [
    `New paid order #${o.orderId} — ₹${o.total}`, '',
    'CUSTOMER', `Name: ${o.name}`, `Phone: ${o.phone || '—'}${wa ? ` (WhatsApp: https://wa.me/${wa})` : ''}`, `Email: ${o.email || '—'}`, `Ship to: ${addr || '—'}`, '',
    'PRODUCTS', ...o.items.map(i => `• HK-${String(i.id).padStart(3, '0')} ${i.name} × ${i.quantity} @ ₹${i.price} = ₹${i.price * i.quantity}`), '',
    `Subtotal: ₹${subtotal}`, ...(o.couponCode ? [`Coupon ${o.couponCode}: −₹${o.discount}`] : []), `Shipping: ${shipping ? '₹' + shipping : 'Free'}`, `Total paid: ₹${o.total}`, '',
    `Razorpay payment ID: ${o.razorpay_payment_id}`, `${SITE}/admin/orders/${o.orderId}`,
  ].join('\n');
  return { html, text };
}

router.get('/checkout', async (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) return res.redirect('/cart');
  const pricing = await priceCart(req);
  const { items } = pricing;
  res.render('checkout', {
    gaPageEvents: [{ name: 'begin_checkout', params: ecommerce(items.map(i => gaItem(i, i.quantity, i.discountedPrice)), pricing.couponCode ? { coupon: pricing.couponCode } : {}) }],
    ...pricing,
    ...couponFlash(req, pricing),
    user: req.session.user || null,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || ''
  });
});

// Step 1 — create a Razorpay order (called via AJAX before showing the popup)
router.post('/checkout/create-order', async (req, res) => {
  try {
    const cart = req.session.cart || [];
    if (cart.length === 0) return res.status(400).json({ error: 'Cart is empty' });

    // Same pricing as the cart/checkout pages, coupon re-checked on the server
    const { items, total, discount, couponCode } = await priceCart(req);

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
      discount,
      couponCode,
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
    const discount = pending.discount || 0;
    const couponCode = pending.couponCode || null;

    // Save order (user_id is null for guest checkouts)
    const result = await db.run(
      'INSERT INTO orders (user_id, total, status, name, email, phone, address, city, zip, country, upi_txn_id, coupon_code, discount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.session.user?.id || null, total, 'paid', name, email, phone || null, address, city, zip, country, razorpay_payment_id, couponCode, discount]
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
        'INSERT INTO invoices (customer_name, customer_phone, customer_address, shipping_name, shipping_phone, shipping_address, shipping_city, shipping_state, shipping_pincode, total, discount_amount, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [name, phone || null, `${address}, ${city}, ${zip}, ${country}`,
         name, phone || null, address, city, zip, country,
         total, discount, `Razorpay payment ${razorpay_payment_id} — order #${orderId}${couponCode ? ` — coupon ${couponCode} (−₹${discount})` : ''}`, null]
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

    // Email the shop owner about the new order (Resend HTTPS API)
    try {
      const { sendMail, isConfigured } = require('./mailer');
      if (!isConfigured()) {
        console.warn('[Email] RESEND_API_KEY not set — skipping order notification.');
      } else {
        const { html, text } = ownerOrderEmail({ orderId, total, discount, couponCode, razorpay_payment_id, name, email, phone, address, city, zip, country, items });
        await sendMail({
          label: 'Hathekhori Orders',
          to: 'contact.hathekhori@gmail.com',
          replyTo: email || undefined,
          subject: `✅ New Order #${orderId} — ₹${total} — ${name}`,
          html, text,
        });
        console.log(`[Email] Order #${orderId} notification sent.`);
      }
    } catch (err) {
      console.error('Order notification email failed:', err.message);
    }

    // GA4 purchase — queued so it fires once, on the confirmation page
    try {
      const products = await Promise.all(items.map(i => db.get('SELECT id, name, category FROM products WHERE id = ?', [i.id])));
      const gaItems = items.map((i, k) => gaItem({ ...(products[k] || {}), id: i.id, name: i.name }, i.quantity, i.price));
      const itemsTotal = gaItems.reduce((s, i) => s + i.price * i.quantity, 0);
      queueGaEvent(req, 'purchase', ecommerce(gaItems, {
        transaction_id: String(orderId),
        value: Number(total),
        shipping: Math.max(0, Number(total) + discount - itemsTotal),
        ...(couponCode ? { coupon: couponCode } : {}),
      }));
    } catch (err) {
      console.error('GA purchase event failed:', err.message);
    }

    req.session.cart = [];
    req.session.coupon = null;
    req.session.pendingOrder = null;
    req.session.lastOrderId = orderId;
    await db.run('DELETE FROM carts WHERE session_id = ?', [req.sessionID]);
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
  const userId = req.session.user.id;
  const orders = await db.all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  // Items per order, with the customer's review (if any) so delivered items can be reviewed
  const items = orders.length ? await db.all(`
    SELECT oi.order_id, oi.product_id, oi.quantity, p.name, p.image, p.images, r.rating AS my_rating
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    LEFT JOIN reviews r ON r.order_id = oi.order_id AND r.product_id = oi.product_id AND r.user_id = ?
    WHERE o.user_id = ?
    ORDER BY oi.id`, [userId, userId]) : [];
  for (const o of orders) {
    o.items = items.filter(i => i.order_id === o.id).map(i => {
      let imgs = [];
      try { imgs = i.images ? JSON.parse(i.images) : []; } catch (_) {}
      const img = imgs[0] || i.image || 'placeholder.jpg';
      return { ...i, imageUrl: img.startsWith('http') ? img : '/uploads/' + img };
    });
  }
  res.render('orders', { orders, user: req.session.user, success: req.flash('success'), error: req.flash('error') });
});

module.exports = router;
