const express = require('express');
const router = express.Router();
const { db } = require('../database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Always use memory storage — upload to Cloudinary or save to disk after
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

async function saveImage(file) {
  if (!file) return 'placeholder.jpg';

  console.log('CLOUDINARY_CLOUD_NAME:', process.env.CLOUDINARY_CLOUD_NAME ? 'set' : 'NOT SET');
  console.log('CLOUDINARY_API_KEY:', process.env.CLOUDINARY_API_KEY ? 'set' : 'NOT SET');
  console.log('CLOUDINARY_API_SECRET:', process.env.CLOUDINARY_API_SECRET ? 'set' : 'NOT SET');

  if (process.env.CLOUDINARY_CLOUD_NAME) {
    const cloudinary = require('cloudinary').v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'khori-products' },
        (error, result) => {
          if (error) {
            console.error('Cloudinary upload error:', error);
            reject(error);
          } else {
            resolve(result);
          }
        }
      ).end(file.buffer);
    });
    return result.secure_url;
  } else {
    const uploadsDir = path.join(__dirname, '../public/uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const filename = Date.now() + path.extname(file.originalname);
    fs.writeFileSync(path.join(uploadsDir, filename), file.buffer);
    return filename;
  }
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) return res.redirect('/login');
  next();
}

router.get('/', requireAdmin, async (req, res) => {
  const ua = req.headers['user-agent'] || '';
  const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
  const perPage = isMobile ? 10 : 30;
  const currentPage = Math.max(1, parseInt(req.query.page) || 1);
  const offset = (currentPage - 1) * perPage;

  const countRow = await db.get('SELECT COUNT(*) as total FROM products');
  const totalProducts = countRow ? countRow.total : 0;
  const totalPages = Math.ceil(totalProducts / perPage);

  const products = await db.all('SELECT * FROM products ORDER BY created_at DESC LIMIT ? OFFSET ?', [perPage, offset]);
  const orders = await db.all('SELECT o.*, u.name AS user_name FROM orders o LEFT JOIN users u ON o.user_id = u.id ORDER BY o.created_at DESC');
  const stats = {
    totalProducts,
    totalOrders: orders.length,
    totalRevenue: orders.filter(o => o.status === 'paid').reduce((s, o) => s + o.total, 0),
    pendingOrders: orders.filter(o => o.status === 'pending').length
  };
  res.render('admin/dashboard', { products, orders, stats, user: req.session.user, currentPage, totalPages });
});

router.get('/products/new', requireAdmin, (req, res) => {
  res.render('admin/product-form', { product: null, error: req.flash('error'), user: req.session.user });
});

router.post('/products/new', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { name, description, price, stock, category, dim_l, dim_b, dim_h, material, care_instructions, origin, craft_type } = req.body;
    const dimension = (dim_l && dim_b && dim_h) ? `${dim_l.trim()} × ${dim_b.trim()} × ${dim_h.trim()}` : null;
    if (!name || !price) {
      req.flash('error', 'Name and price are required.');
      return res.redirect('/admin/products/new');
    }
    const image = await saveImage(req.file);
    await db.run(
      'INSERT INTO products (name, description, price, stock, image, category, dimension, material, care_instructions, origin, craft_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name, description, parseFloat(price), parseInt(stock) || 0, image, category || 'general', dimension || null, material || null, care_instructions || null, origin || null, craft_type || null]
    );
    res.redirect('/admin');
  } catch (err) {
    console.error('Add product error:', err);
    req.flash('error', 'Failed to save product. Please try again.');
    res.redirect('/admin/products/new');
  }
});

router.get('/products/edit/:id', requireAdmin, async (req, res) => {
  const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!product) return res.redirect('/admin');
  res.render('admin/product-form', { product, error: req.flash('error'), user: req.session.user });
});

router.post('/products/edit/:id', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { name, description, price, stock, category, dim_l, dim_b, dim_h, material, care_instructions, origin, craft_type } = req.body;
    const dimension = (dim_l && dim_b && dim_h) ? `${dim_l.trim()} × ${dim_b.trim()} × ${dim_h.trim()}` : null;
    const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!product) return res.redirect('/admin');
    const image = req.file ? await saveImage(req.file) : product.image;
    await db.run(
      'UPDATE products SET name=?, description=?, price=?, stock=?, image=?, category=?, dimension=?, material=?, care_instructions=?, origin=?, craft_type=? WHERE id=?',
      [name, description, parseFloat(price), parseInt(stock) || 0, image, category || 'general', dimension || null, material || null, care_instructions || null, origin || null, craft_type || null, req.params.id]
    );
    res.redirect('/admin');
  } catch (err) {
    console.error('Edit product error:', err);
    req.flash('error', 'Failed to update product. Please try again.');
    res.redirect('/admin/products/edit/' + req.params.id);
  }
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
