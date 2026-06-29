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

// Verify CSRF token after multer has parsed the multipart body
function csrfAfterMulter(req, res, next) {
  const validate = req.app.locals.validateCsrf;
  if (!validate(req)) {
    return res.status(403).send('Invalid CSRF token.');
  }
  next();
}

async function saveImage(file) {
  if (!file) return 'placeholder.jpg';
  if (process.env.CLOUDINARY_CLOUD_NAME) {
    const { uploadBuffer } = require('../cloudinary');
    return await uploadBuffer(file.buffer, 'khori-products');
  } else {
    const uploadsDir = path.join(__dirname, '../public/uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const filename = Date.now() + path.extname(file.originalname);
    fs.writeFileSync(path.join(uploadsDir, filename), file.buffer);
    return filename;
  }
}

async function saveImages(files) {
  if (!files || files.length === 0) return [];
  const results = [];
  for (const file of files) {
    results.push(await saveImage(file));
  }
  return results;
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
  const filterCategory = req.query.category || '';

  const allCategories = (await db.all('SELECT DISTINCT category FROM products ORDER BY category')).map(r => r.category);

  let countRow, products;
  if (filterCategory) {
    countRow = await db.get('SELECT COUNT(*) as total FROM products WHERE category = ?', [filterCategory]);
    products = await db.all('SELECT * FROM products WHERE category = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [filterCategory, perPage, offset]);
  } else {
    countRow = await db.get('SELECT COUNT(*) as total FROM products');
    products = await db.all('SELECT * FROM products ORDER BY created_at DESC LIMIT ? OFFSET ?', [perPage, offset]);
  }

  const totalProducts = countRow ? countRow.total : 0;
  const totalPages = Math.ceil(totalProducts / perPage);

  const orders = await db.all('SELECT o.*, u.name AS user_name FROM orders o LEFT JOIN users u ON o.user_id = u.id ORDER BY o.created_at DESC');
  const allProductsCount = (await db.get('SELECT COUNT(*) as total FROM products')).total;
  const stats = {
    totalProducts: allProductsCount,
    totalOrders: orders.length,
    totalRevenue: orders.filter(o => o.status === 'paid').reduce((s, o) => s + o.total, 0),
    pendingOrders: orders.filter(o => o.status === 'pending').length
  };
  const flashMsg = req.flash('error')[0] || null;
  res.render('admin/dashboard', { products, orders, stats, user: req.session.user, currentPage, totalPages, flashMsg, allCategories, filterCategory });
});

router.get('/products/new', requireAdmin, (req, res) => {
  res.render('admin/product-form', { product: null, error: req.flash('error'), user: req.session.user });
});

router.post('/products/new', requireAdmin, upload.array('images', 10), csrfAfterMulter, async (req, res) => {
  try {
    const { name, description, price, stock, category, dim_l, dim_b, dim_h, material, care_instructions, origin, craft_type } = req.body;
    const dimension = (dim_l && dim_b && dim_h) ? `${dim_l.trim()} × ${dim_b.trim()} × ${dim_h.trim()}` : null;
    if (!name || !price) {
      req.flash('error', 'Name and price are required.');
      return res.redirect('/admin/products/new');
    }
    const uploadedImages = await saveImages(req.files);
    const image = uploadedImages[0] || 'placeholder.jpg';
    const images = uploadedImages.length > 0 ? JSON.stringify(uploadedImages) : null;
    await db.run(
      'INSERT INTO products (name, description, price, stock, image, images, category, dimension, material, care_instructions, origin, craft_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name, description, parseFloat(price), parseInt(stock) || 0, image, images, category || 'general', dimension || null, material || null, care_instructions || null, origin || null, craft_type || null]
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

router.post('/products/edit/:id', requireAdmin, upload.array('images', 10), csrfAfterMulter, async (req, res) => {
  try {
    const { name, description, price, stock, category, dim_l, dim_b, dim_h, material, care_instructions, origin, craft_type } = req.body;
    const dimension = (dim_l && dim_b && dim_h) ? `${dim_l.trim()} × ${dim_b.trim()} × ${dim_h.trim()}` : null;
    const product = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!product) return res.redirect('/admin');

    let image = product.image;
    let images = product.images || null;

    if (req.files && req.files.length > 0) {
      const uploadedImages = await saveImages(req.files);
      image = uploadedImages[0];
      images = JSON.stringify(uploadedImages);
    }

    await db.run(
      'UPDATE products SET name=?, description=?, price=?, stock=?, image=?, images=?, category=?, dimension=?, material=?, care_instructions=?, origin=?, craft_type=? WHERE id=?',
      [name, description, parseFloat(price), parseInt(stock) || 0, image, images, category || 'general', dimension || null, material || null, care_instructions || null, origin || null, craft_type || null, req.params.id]
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

router.post('/generate-description', requireAdmin, upload.single('image'), csrfAfterMulter, async (req, res) => {
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });

    const { name, category, material, origin, craft_type } = req.body;
    const details = [
      name && `Product: ${name}`,
      category && `Category: ${category}`,
      material && `Material: ${material}`,
      origin && `Origin: ${origin}`,
      craft_type && `Craft type: ${craft_type}`,
    ].filter(Boolean).join('\n');

    const prompt = `Write a warm, compelling 2–3 sentence product description for an Indian handmade crafts store called Hathekhori. Use the details below. Focus on the craft, the material, and the story behind it. Do not use bullet points.\n\n${details}`;

    const validImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const hasValidImage = req.file && validImageTypes.includes(req.file.mimetype);

    const parts = hasValidImage
      ? [{ inlineData: { mimeType: req.file.mimetype, data: req.file.buffer.toString('base64') } }, { text: prompt }]
      : [{ text: prompt }];

    const result = await model.generateContent(parts);
    const text = result.response.text().trim();
    res.json({ description: text });
  } catch (err) {
    console.error('Generate description error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate description.' });
  }
});

router.post('/orders/status/:id', requireAdmin, async (req, res) => {
  const { status } = req.body;
  await db.run('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
  res.redirect('/admin');
});

// ===== Bulk Export =====
router.get('/products/export', requireAdmin, async (req, res) => {
  const XLSX = require('xlsx');
  const products = await db.all('SELECT id, name, price, stock, category, description, material, origin, craft_type, care_instructions FROM products ORDER BY id');
  const rows = products.map(p => ({
    ID: p.id,
    Name: p.name,
    Price: p.price,
    Stock: p.stock,
    Category: p.category,
    Description: p.description || '',
    Material: p.material || '',
    Origin: p.origin || '',
    'Craft Type': p.craft_type || '',
    'Care Instructions': p.care_instructions || '',
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  // Column widths
  ws['!cols'] = [{ wch: 6 }, { wch: 30 }, { wch: 10 }, { wch: 8 }, { wch: 20 }, { wch: 40 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Products');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="khori-products.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ===== Bulk Import =====
router.post('/products/import', requireAdmin, upload.single('bulkFile'), csrfAfterMulter, async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);

    let updated = 0, added = 0, skipped = 0;
    for (const row of rows) {
      const id = row['ID'];
      const name = (row['Name'] || '').toString().trim();
      const price = parseFloat(row['Price']);
      const stock = parseInt(row['Stock']);
      const category = (row['Category'] || '').toString().trim();
      const description = (row['Description'] || '').toString().trim();
      const material = (row['Material'] || '').toString().trim();
      const origin = (row['Origin'] || '').toString().trim();
      const craft_type = (row['Craft Type'] || '').toString().trim();
      const care_instructions = (row['Care Instructions'] || '').toString().trim();

      if (!name) { skipped++; continue; }

      if (id) {
        const existing = await db.get('SELECT id FROM products WHERE id = ?', [id]);
        if (existing) {
          await db.run(
            'UPDATE products SET name=?, price=?, stock=?, category=?, description=?, material=?, origin=?, craft_type=?, care_instructions=? WHERE id=?',
            [name, isNaN(price) ? 0 : price, isNaN(stock) ? 0 : stock, category || 'general', description, material, origin, craft_type, care_instructions, id]
          );
          updated++;
          continue;
        }
      }
      // New row — insert
      await db.run(
        'INSERT INTO products (name, price, stock, category, description, material, origin, craft_type, care_instructions, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [name, isNaN(price) ? 0 : price, isNaN(stock) ? 0 : stock, category || 'general', description, material, origin, craft_type, care_instructions, 'placeholder.jpg']
      );
      added++;
    }
    req.flash('error', `✓ Import done — ${updated} updated, ${added} added, ${skipped} skipped.`);
  } catch (err) {
    console.error('Bulk import error:', err);
    req.flash('error', 'Import failed: ' + err.message);
  }
  res.redirect('/admin');
});


module.exports = router;
