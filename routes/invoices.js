const express = require('express');
const router = express.Router();
const { db } = require('../database');

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) return res.redirect('/login');
  next();
}

// List all invoices
router.get('/', requireAdmin, async (req, res) => {
  const invoices = await db.all('SELECT * FROM invoices ORDER BY created_at DESC');
  const flashMsg = req.flash('error')[0] || null;
  res.render('admin/invoices', { invoices, user: req.session.user, flashMsg });
});

// New invoice form
router.get('/new', requireAdmin, async (req, res) => {
  const products = await db.all('SELECT id, name, price, stock FROM products WHERE stock > 0 ORDER BY name');
  res.render('admin/invoice-form', { products, user: req.session.user });
});

// Create invoice
router.post('/new', requireAdmin, async (req, res) => {
  try {
    const { customer_name, customer_phone, customer_address, notes, product_id, quantity, unit_price } = req.body;

    // product_id, quantity, unit_price can be arrays (multiple rows)
    const ids      = Array.isArray(product_id)  ? product_id  : [product_id];
    const qtys     = Array.isArray(quantity)     ? quantity    : [quantity];
    const prices   = Array.isArray(unit_price)   ? unit_price  : [unit_price];

    if (!customer_name) {
      req.flash('error', 'Customer name is required.');
      return res.redirect('/admin/invoices/new');
    }

    // Validate and build line items
    const items = [];
    for (let i = 0; i < ids.length; i++) {
      const pid = parseInt(ids[i]);
      const qty = parseInt(qtys[i]);
      const price = parseFloat(prices[i]);
      if (!pid || !qty || qty < 1 || isNaN(price)) continue;

      const product = await db.get('SELECT * FROM products WHERE id = ?', [pid]);
      if (!product) continue;
      if (product.stock < qty) {
        req.flash('error', `Not enough stock for "${product.name}". Available: ${product.stock}`);
        return res.redirect('/admin/invoices/new');
      }
      items.push({ pid, qty, price, name: product.name });
    }

    if (items.length === 0) {
      req.flash('error', 'Add at least one product.');
      return res.redirect('/admin/invoices/new');
    }

    const total = items.reduce((sum, it) => sum + it.price * it.qty, 0);

    const result = await db.run(
      'INSERT INTO invoices (customer_name, customer_phone, customer_address, total, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [customer_name, customer_phone || null, customer_address || null, total, notes || null, req.session.user.id]
    );
    const invoiceId = result.lastInsertRowid;

    for (const it of items) {
      await db.run(
        'INSERT INTO invoice_items (invoice_id, product_id, product_name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)',
        [invoiceId, it.pid, it.name, it.qty, it.price]
      );
      await db.run('UPDATE products SET stock = stock - ? WHERE id = ?', [it.qty, it.pid]);
    }

    res.redirect('/admin/invoices/' + invoiceId + '/print');
  } catch (err) {
    console.error('Invoice create error:', err);
    req.flash('error', 'Failed to create invoice: ' + err.message);
    res.redirect('/admin/invoices/new');
  }
});

// Print / view invoice
router.get('/:id/print', requireAdmin, async (req, res) => {
  const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
  if (!invoice) return res.redirect('/admin/invoices');
  const items = await db.all('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoice.id]);
  res.render('admin/invoice-print', { invoice, items, user: req.session.user });
});

// Delete invoice (does NOT restore stock)
router.post('/:id/delete', requireAdmin, async (req, res) => {
  await db.run('DELETE FROM invoice_items WHERE invoice_id = ?', [req.params.id]);
  await db.run('DELETE FROM invoices WHERE id = ?', [req.params.id]);
  res.redirect('/admin/invoices');
});

module.exports = router;
