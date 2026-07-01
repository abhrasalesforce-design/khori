const express = require('express');
const router = express.Router();
const { db } = require('../database');

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Login required' });
  next();
}

// Returns products from delivered orders that the user hasn't reviewed yet
router.get('/pending', requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const pending = await db.all(`
    SELECT DISTINCT oi.product_id, oi.order_id, p.name, p.image, p.images
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    WHERE o.user_id = ?
      AND o.status = 'delivered'
      AND NOT EXISTS (
        SELECT 1 FROM reviews r
        WHERE r.user_id = ? AND r.product_id = oi.product_id AND r.order_id = oi.order_id
      )
  `, [userId, userId]);
  res.json({ pending });
});

// Submit a review
router.post('/submit', requireLogin, async (req, res) => {
  const { product_id, order_id, rating, comment } = req.body;
  const userId = req.session.user.id;
  const r = parseInt(rating);
  if (!product_id || !order_id || !r || r < 1 || r > 5) {
    return res.status(400).json({ error: 'Invalid input' });
  }
  // Verify the order belongs to this user and is delivered
  const order = await db.get(
    'SELECT id FROM orders WHERE id = ? AND user_id = ? AND status = ?',
    [order_id, userId, 'delivered']
  );
  if (!order) return res.status(403).json({ error: 'Not eligible' });

  try {
    await db.run(
      'INSERT INTO reviews (user_id, product_id, order_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
      [userId, product_id, order_id, r, comment || null]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.json({ ok: true }); // already reviewed
    res.status(500).json({ error: 'Failed to save review' });
  }
});

module.exports = router;
