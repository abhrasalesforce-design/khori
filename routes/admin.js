const express = require('express');
const router = express.Router();
const { db } = require('../database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadsDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) return res.redirect('/login');
  next();
}

router.get('/', requireAdmin, async (req, res) => {
  const products = await db.all('SELECT * FROM products ORDER BY created_at DESC');
  const orders = await db.all('SELECT o.*, u.name AS user_name FROM orders o LEFT JOIN users u ON o.user_id = u.id ORDER BY o.created_at DESC');
  const stats = {
    totalProducts: products.length,
    totalOrders: orders.length,
    totalRevenue: orders.filter(o => o.status === 'paid').reduce((s, o) => s + o.total, 0),
    pendingOrders: orders.filter(o => o.status === 'pending').length
  };
  res.render('admin/dashboard', { products, orders, stats, user: req.session.user });
});

router.get('/products/new', requireAdmin, (req, res) => {
  res.render('admin/product-form', { product: null, error: req.flash('error'), user: req.session.user });
});

router.post('/products/new', requireAdmin, upload.single('image'), async (req, res) => {
  const { name, description, price, stock, category } = req.body;
  if (!name || !price) {
    req.flash('error', 'Name and price are required.');
    return res.redirect('/admin/products/new');
  }
  const image = req.file ? req.file.filename : 'placeholder.jpg';
  await db.run('INSERT INTO products (name, description, price, stock, image, category) VALUES (?, ?, ?, ?, ?, ?)', [name, description, parseFloat(price), parseInt(stock) || 0, image, category || 'general']);
  res.redirect('/admin');
});

router.get('/products/edit/:id', requireAdmin, async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) return res.redirect('/admin');
  res.render('admin/product-form', { product, error: req.flash('error'), user: req.session.user });
});

router.post('/products/edit/:id', requireAdmin, upload.single('image'), async (req, res) => {
  const { name, description, price, stock, category } = req.body;
  const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) return res.redirect('/admin');
  const image = req.file ? req.file.filename : product.image;
  await db.run('UPDATE products SET name=?, description=?, price=?, stock=?, image=?, category=? WHERE id=?', [name, description, parseFloat(price), parseInt(stock) || 0, image, category || 'general', req.params.id]);
  res.redirect('/admin');
});

router.post('/products/delete/:id', requireAdmin, async (req, res) => {
  await db.run('DELETE FROM products WHERE id = ?', [req.params.id]);
  res.redirect('/admin');
});

router.post('/orders/status/:id', requireAdmin, async (req, res) => {
  const { status } = req.body;
  await db.run('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
  res.redirect('/admin');
});

module.exports = router;
