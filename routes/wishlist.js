const express = require('express');
const router = express.Router();
const { db } = require('../database');

// Middleware: require login
function requireLogin(req, res, next) {
  if (!req.session.user) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Login required' });
    }
    return res.redirect('/login');
  }
  next();
}

// POST /wishlist/toggle — toggle a product in/out of wishlist
router.post('/wishlist/toggle', requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const productId = parseInt(req.body.product_id, 10);

  if (!productId) return res.status(400).json({ error: 'Invalid product' });

  try {
    // Try inserting — if duplicate, catch and delete instead
    await db.run(
      'INSERT INTO wishlists (user_id, product_id) VALUES (?, ?)',
      [userId, productId]
    );
    return res.json({ wishlisted: true });
  } catch (err) {
    // UNIQUE constraint violation = already in wishlist → remove it
    const isDuplicate =
      (err.message && (
        err.message.includes('UNIQUE constraint failed') ||
        err.message.includes('unique_violation') ||
        err.code === '23505'
      ));

    if (isDuplicate) {
      await db.run(
        'DELETE FROM wishlists WHERE user_id = ? AND product_id = ?',
        [userId, productId]
      );
      return res.json({ wishlisted: false });
    }

    console.error('Wishlist toggle error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /wishlist — show wishlist page
router.get('/wishlist', requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const products = await db.all(
    `SELECT p.* FROM products p
     INNER JOIN wishlists w ON w.product_id = p.id
     WHERE w.user_id = ?
     ORDER BY w.created_at DESC`,
    [userId]
  );
  res.render('wishlist', { products, user: req.session.user });
});

module.exports = router;
