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
  const perPage = 10;
  const ordersPerPage = 10;
  const currentPage = Math.max(1, parseInt(req.query.page) || 1);
  const ordersPage  = Math.max(1, parseInt(req.query.opage) || 1);
  const offset = (currentPage - 1) * perPage;
  const ordersOffset = (ordersPage - 1) * ordersPerPage;
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

  const ordersCountRow = await db.get('SELECT COUNT(*) as total FROM orders');
  const totalOrders = ordersCountRow ? ordersCountRow.total : 0;
  const totalOrderPages = Math.ceil(totalOrders / ordersPerPage);
  const orders = await db.all(
    'SELECT o.*, u.name AS user_name FROM orders o LEFT JOIN users u ON o.user_id = u.id ORDER BY o.created_at DESC LIMIT ? OFFSET ?',
    [ordersPerPage, ordersOffset]
  );

  const allProductsCount = (await db.get('SELECT COUNT(*) as total FROM products')).total;
  const allOrdersRevenue = await db.all('SELECT total, status FROM orders');
  const stats = {
    totalProducts: allProductsCount,
    totalOrders,
    totalRevenue: allOrdersRevenue.filter(o => ['paid','shipped','delivered'].includes(o.status)).reduce((s, o) => s + o.total, 0),
    pendingOrders: allOrdersRevenue.filter(o => o.status === 'payment_pending' || o.status === 'pending').length
  };

  const banner = await db.get('SELECT * FROM banners WHERE active = 1 ORDER BY created_at DESC LIMIT 1');
  const flashMsg = req.flash('error')[0] || null;
  res.render('admin/dashboard', {
    products, orders, stats, user: req.session.user,
    currentPage, totalPages, flashMsg, allCategories, filterCategory,
    ordersPage, totalOrderPages, banner
  });
});

// ===== Carousel / Banner routes =====

router.get('/carousel', requireAdmin, async (req, res) => {
  const slides = await db.all('SELECT * FROM banners ORDER BY sort_order ASC, id ASC');
  res.render('admin/carousel', {
    slides,
    user: req.session.user,
    flashMsg: req.flash('error')[0] || null
  });
});

// Add new slide
router.get('/carousel/new', requireAdmin, (req, res) => {
  res.render('admin/carousel-form', { slide: null, user: req.session.user, error: req.flash('error') });
});

router.post('/carousel/new', requireAdmin, upload.single('bannerImage'), csrfAfterMulter, async (req, res) => {
  try {
    const { eyebrow, heading, subheading, cta_text, cta_link, active } = req.body;
    if (!req.file) {
      req.flash('error', 'Slide image is required.');
      return res.redirect('/admin/carousel/new');
    }
    const image = await saveImage(req.file);
    const maxOrder = await db.get('SELECT MAX(sort_order) as m FROM banners');
    const sortOrder = (maxOrder?.m ?? -1) + 1;
    await db.run(
      'INSERT INTO banners (image, eyebrow, heading, subheading, cta_text, cta_link, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [image, eyebrow || null, heading || null, subheading || null, cta_text || null, cta_link || null, active === '1' ? 1 : 0, sortOrder]
    );
    req.flash('error', '✓ Slide added.');
    res.redirect('/admin/carousel');
  } catch (err) {
    console.error('Carousel add error:', err);
    req.flash('error', 'Failed to add slide: ' + err.message);
    res.redirect('/admin/carousel/new');
  }
});

// Edit slide
router.get('/carousel/edit/:id', requireAdmin, async (req, res) => {
  const slide = await db.get('SELECT * FROM banners WHERE id = ?', [req.params.id]);
  if (!slide) return res.redirect('/admin/carousel');
  res.render('admin/carousel-form', { slide, user: req.session.user, error: req.flash('error') });
});

router.post('/carousel/edit/:id', requireAdmin, upload.single('bannerImage'), csrfAfterMulter, async (req, res) => {
  try {
    const { eyebrow, heading, subheading, cta_text, cta_link, active, sort_order } = req.body;
    const slide = await db.get('SELECT * FROM banners WHERE id = ?', [req.params.id]);
    if (!slide) return res.redirect('/admin/carousel');
    const image = req.file ? await saveImage(req.file) : slide.image;
    await db.run(
      'UPDATE banners SET image=?, eyebrow=?, heading=?, subheading=?, cta_text=?, cta_link=?, active=?, sort_order=? WHERE id=?',
      [image, eyebrow || null, heading || null, subheading || null, cta_text || null, cta_link || null, active === '1' ? 1 : 0, parseInt(sort_order) || 0, req.params.id]
    );
    req.flash('error', '✓ Slide updated.');
    res.redirect('/admin/carousel');
  } catch (err) {
    console.error('Carousel edit error:', err);
    req.flash('error', 'Failed to update slide: ' + err.message);
    res.redirect('/admin/carousel/edit/' + req.params.id);
  }
});

// Delete slide
router.post('/carousel/delete/:id', requireAdmin, async (req, res) => {
  await db.run('DELETE FROM banners WHERE id = ?', [req.params.id]);
  req.flash('error', '✓ Slide deleted.');
  res.redirect('/admin/carousel');
});

// Legacy — keep old banner/new working, redirect to new carousel
router.get('/banner/new', requireAdmin, (req, res) => res.redirect('/admin/carousel/new'));
router.post('/banner/clear', requireAdmin, async (req, res) => {
  await db.run('UPDATE banners SET active = 0');
  req.flash('error', '✓ All slides hidden.');
  res.redirect('/admin');
});

// ===== Clear all orders =====
router.post('/orders/clear', requireAdmin, async (req, res) => {
  await db.run('DELETE FROM order_items');
  await db.run('DELETE FROM orders');
  req.flash('error', '✓ All orders cleared.');
  res.redirect('/admin');
});

async function getProductSuggestions() {
  const rows = await db.all('SELECT description, material, origin, craft_type, care_instructions FROM products');
  const uniq = (field) => [...new Set(rows.map(r => r[field]).filter(Boolean))];
  return {
    descriptions:  uniq('description'),
    materials:     uniq('material'),
    origins:       uniq('origin'),
    craftTypes:    uniq('craft_type'),
    careInstructions: uniq('care_instructions'),
  };
}

async function getCategoryTree() {
  const all = await db.all('SELECT * FROM categories ORDER BY sort_order');
  const parents = all.filter(c => !c.parent_id);
  return parents.map(p => ({ ...p, children: all.filter(c => c.parent_id === p.id) }));
}

router.get('/products/new', requireAdmin, async (req, res) => {
  const suggestions = await getProductSuggestions();
  const categoryTree = await getCategoryTree();
  res.render('admin/product-form', { product: null, error: req.flash('error'), user: req.session.user, suggestions, categoryTree });
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
  const suggestions = await getProductSuggestions();
  const categoryTree = await getCategoryTree();
  res.render('admin/product-form', { product, error: req.flash('error'), user: req.session.user, suggestions, categoryTree });
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

router.get('/orders/:id', requireAdmin, async (req, res) => {
  const order = await db.get(
    'SELECT o.*, u.name AS user_name FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE o.id = ?',
    [req.params.id]
  );
  if (!order) return res.redirect('/admin');
  const items = await db.all(
    'SELECT oi.*, p.name AS product_name, p.image, p.images FROM order_items oi LEFT JOIN products p ON oi.product_id = p.id WHERE oi.order_id = ?',
    [order.id]
  );
  res.render('admin/order-detail', { order, items, user: req.session.user });
});

router.post('/orders/status/:id', requireAdmin, async (req, res) => {
  const { status } = req.body;
  const ref = req.get('Referer') || '/admin';
  await db.run('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
  res.redirect(ref);
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


// ── Category Discounts ────────────────────────────────────────────────────
router.get('/discounts', requireAdmin, async (req, res) => {
  try {
    // Ensure table exists (in case migration hasn't run yet on this environment)
    await db.run('CREATE TABLE IF NOT EXISTS category_discounts (category TEXT PRIMARY KEY, discount_pct REAL NOT NULL DEFAULT 0)');
    const allCategories = (await db.all('SELECT DISTINCT category FROM products ORDER BY category')).map(r => r.category);
    const discountRows = await db.all('SELECT category, discount_pct FROM category_discounts');
    const discountMap = {};
    for (const r of discountRows) discountMap[r.category] = r.discount_pct;
    res.render('admin/discounts', {
      allCategories,
      discountMap,
      globalDiscount: discountMap['__all__'] ?? '',
      flashMsg: req.flash('error')[0] || null,
      user: req.session.user
    });
  } catch (err) {
    console.error('[Discounts] Load error:', err.message);
    res.status(500).send('Error loading discounts: ' + err.message);
  }
});

router.post('/discounts', requireAdmin, async (req, res) => {
  try {
    const { global_discount, ...categoryDiscounts } = req.body;

    if (global_discount !== undefined && global_discount !== '') {
      const pct = parseFloat(global_discount);
      if (isNaN(pct) || pct < 0 || pct > 100) {
        req.flash('error', 'Invalid discount percentage.');
        return res.redirect('/admin/discounts');
      }
      await db.run(
        'INSERT INTO category_discounts (category, discount_pct) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET discount_pct = excluded.discount_pct',
        ['__all__', pct]
      );
      await db.run("DELETE FROM category_discounts WHERE category != '__all__'");
    } else {
      await db.run("DELETE FROM category_discounts WHERE category = '__all__'");
      for (const [cat, val] of Object.entries(categoryDiscounts)) {
        if (!cat.startsWith('cat_')) continue;
        const category = cat.slice(4);
        const pct = parseFloat(val);
        if (isNaN(pct) || pct < 0 || pct > 100) continue;
        if (pct === 0) {
          await db.run('DELETE FROM category_discounts WHERE category = ?', [category]);
        } else {
          await db.run(
            'INSERT INTO category_discounts (category, discount_pct) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET discount_pct = excluded.discount_pct',
            [category, pct]
          );
        }
      }
    }

    req.flash('error', 'Discounts saved.');
    res.redirect('/admin/discounts');
  } catch (err) {
    console.error('[Discounts] Save error:', err.message);
    req.flash('error', 'Error saving discounts: ' + err.message);
    res.redirect('/admin/discounts');
  }
});

// ── Categories ──────────────────────────────────────────────────────────────

router.get('/categories', requireAdmin, async (req, res) => {
  const categories = await db.all(`
    SELECT c.*, p.name AS parent_name
    FROM categories c
    LEFT JOIN categories p ON c.parent_id = p.id
    ORDER BY COALESCE(c.parent_id, c.id), c.parent_id IS NOT NULL, c.sort_order
  `);
  res.render('admin/categories', {
    categories,
    user: req.session.user,
    flashMsg: req.flash('error')[0] || null
  });
});

router.get('/categories/new', requireAdmin, async (req, res) => {
  const parents = await db.all('SELECT id, name, slug FROM categories WHERE parent_id IS NULL ORDER BY sort_order');
  res.render('admin/category-form', {
    category: null,
    parents,
    user: req.session.user,
    error: req.flash('error')[0] || null
  });
});

router.post('/categories/new', requireAdmin, async (req, res) => {
  try {
    const { name, slug, parent_id, sort_order } = req.body;
    if (!name || !slug) {
      req.flash('error', 'Name and slug are required.');
      return res.redirect('/admin/categories/new');
    }
    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    await db.run(
      'INSERT INTO categories (name, slug, parent_id, sort_order) VALUES (?, ?, ?, ?)',
      [name.trim(), cleanSlug, parent_id || null, parseInt(sort_order) || 0]
    );
    req.flash('error', '✓ Category created.');
    res.redirect('/admin/categories');
  } catch (err) {
    req.flash('error', err.message.includes('UNIQUE') ? 'Slug already exists.' : 'Failed: ' + err.message);
    res.redirect('/admin/categories/new');
  }
});

router.get('/categories/edit/:id', requireAdmin, async (req, res) => {
  const category = await db.get('SELECT * FROM categories WHERE id = ?', [req.params.id]);
  if (!category) return res.redirect('/admin/categories');
  const parents = await db.all('SELECT id, name, slug FROM categories WHERE parent_id IS NULL AND id != ? ORDER BY sort_order', [req.params.id]);
  res.render('admin/category-form', {
    category,
    parents,
    user: req.session.user,
    error: req.flash('error')[0] || null
  });
});

router.post('/categories/edit/:id', requireAdmin, async (req, res) => {
  try {
    const { name, slug, parent_id, sort_order } = req.body;
    if (!name || !slug) {
      req.flash('error', 'Name and slug are required.');
      return res.redirect('/admin/categories/edit/' + req.params.id);
    }
    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    await db.run(
      'UPDATE categories SET name=?, slug=?, parent_id=?, sort_order=? WHERE id=?',
      [name.trim(), cleanSlug, parent_id || null, parseInt(sort_order) || 0, req.params.id]
    );
    req.flash('error', '✓ Category updated.');
    res.redirect('/admin/categories');
  } catch (err) {
    req.flash('error', err.message.includes('UNIQUE') ? 'Slug already exists.' : 'Failed: ' + err.message);
    res.redirect('/admin/categories/edit/' + req.params.id);
  }
});

router.post('/categories/delete/:id', requireAdmin, async (req, res) => {
  const inUse = await db.get('SELECT COUNT(*) as n FROM products WHERE category = (SELECT slug FROM categories WHERE id = ?)', [req.params.id]);
  const hasChildren = await db.get('SELECT COUNT(*) as n FROM categories WHERE parent_id = ?', [req.params.id]);
  if ((inUse && inUse.n > 0) || (hasChildren && hasChildren.n > 0)) {
    req.flash('error', 'Cannot delete: category has products or subcategories assigned to it.');
    return res.redirect('/admin/categories');
  }
  await db.run('DELETE FROM categories WHERE id = ?', [req.params.id]);
  req.flash('error', '✓ Category deleted.');
  res.redirect('/admin/categories');
});

module.exports = router;
