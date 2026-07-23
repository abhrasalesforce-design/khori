const express = require('express');
const router  = express.Router();
const { db }  = require('../database');
const { getDiscountMap, applyDiscount } = require('./cartPricing');

// ─── Combo definitions ────────────────────────────────────────────────────────
const BASKET_DEFS = {
  'kitty-keepsakes': {
    label: 'Kitty Keepsakes',
    tagline: 'A jewellery piece + a hand-crafted tote — the perfect duo.',
    icon: '🎀',
    slots: [
      { key: 'jewellery', label: 'Jewellery',  categories: ['earrings','pendants','terracotta'], min:1, max:1 },
      { key: 'tote',      label: 'Tote Bag',   categories: ['embroidered','hand-painted'],        min:1, max:1 },
    ],
  },
  'happy-parcel': {
    label: 'Happy Parcel',
    tagline: 'A mini canvas + a hand block keychain — cheerful & charming.',
    icon: '🎁',
    slots: [
      { key: 'canvas',   label: 'Mini Canvas', categories: ['mini-canvas','scenic'], min:1, max:1 },
      { key: 'keychain', label: 'Key Chain',   categories: ['keychains'],            min:1, max:1 },
    ],
  },
  'signature-gifting': {
    label: 'Signature Gifting',
    tagline: 'Four hand block treasures curated into one signature gift.',
    icon: '✨',
    slots: [
      { key: 'diary',    label: 'Hand Block Diary',          categories: ['diaries'],    min:1, max:1 },
      { key: 'keychain', label: 'Hand Block Diary Key Chain', categories: ['keychains'], min:1, max:1 },
      { key: 'bookmark', label: 'Bookmark',                  categories: ['bookmarks'],  min:1, max:1 },
      { key: 'frame',    label: 'Hand Block Photo Frame',    categories: ['frames'],     min:1, max:1 },
    ],
  },
  'artisan-combo': {
    label: 'Artisan Combo',
    tagline: 'Pick 2–3 round MDF art pieces and create your own mini gallery.',
    icon: '🎨',
    slots: [
      { key: 'mdf', label: 'Round MDF Art Pieces', categories: ['mdf'], min:2, max:3 },
    ],
  },
};

// ─── Ensure the gift-basket addon product exists in DB ────────────────────────
let BASKET_ADDON_ID = null;

async function getOrCreateBasketAddon() {
  if (BASKET_ADDON_ID) return BASKET_ADDON_ID;
  let row = await db.get("SELECT id FROM products WHERE category='basket-addon' LIMIT 1");
  if (!row) {
    await db.run(
      "INSERT INTO products (name, description, price, stock, category, image) VALUES (?,?,?,?,?,?)",
      ['Handcrafted Gift Basket', 'A beautiful handcrafted gift basket (+₹50 add-on)', 50, 9999, 'basket-addon', 'placeholder.jpg']
    );
    row = await db.get("SELECT id FROM products WHERE category='basket-addon' LIMIT 1");
  }
  BASKET_ADDON_ID = row.id;
  return BASKET_ADDON_ID;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Landing — show all combo types
router.get('/baskets', (req, res) => {
  res.render('baskets', {
    user: req.session.user || null,
    baskets: BASKET_DEFS,
  });
});

// Builder — pick products for one combo type
router.get('/baskets/:type', async (req, res) => {
  const def = BASKET_DEFS[req.params.type];
  if (!def) return res.redirect('/baskets');

  await getOrCreateBasketAddon();
  const discountMap = await getDiscountMap();

  const slots = await Promise.all(def.slots.map(async slot => {
    const ph = slot.categories.map(() => '?').join(',');
    const products = await db.all(
      `SELECT * FROM products WHERE category IN (${ph}) AND stock > 0 ORDER BY name ASC`,
      slot.categories
    );
    return { ...slot, products };
  }));

  res.render('basket-builder', {
    user: req.session.user || null,
    basketType: req.params.type,
    basketLabel: def.label,
    basketTagline: def.description || def.tagline,
    slots,
    discountMap,
    applyDiscount,
    errors: [],
    selected: {},
    addBasket: false,
  });
});

// Add to cart — validate and push into session cart
router.post('/baskets/:type/add', async (req, res) => {
  const def = BASKET_DEFS[req.params.type];
  if (!def) return res.redirect('/baskets');

  const discountMap = await getDiscountMap();
  const errors = [];
  const toAdd  = [];
  const addBasket = req.body.add_basket === '1';

  for (const slot of def.slots) {
    const raw        = req.body[slot.key];
    const selectedIds = (Array.isArray(raw) ? raw : raw ? [raw] : [])
                          .map(v => parseInt(v)).filter(Boolean);

    if (selectedIds.length < slot.min) {
      errors.push(`Please select at least ${slot.min} item(s) for: ${slot.label}`);
      continue;
    }
    if (selectedIds.length > slot.max) {
      errors.push(`Please select at most ${slot.max} item(s) for: ${slot.label}`);
      continue;
    }

    for (const pid of selectedIds) {
      const product = await db.get('SELECT * FROM products WHERE id = ?', [pid]);
      if (!product || !slot.categories.includes(product.category)) {
        errors.push(`Invalid product selected for: ${slot.label}`);
        continue;
      }
      if (product.stock < 1) {
        errors.push(`"${product.name}" is out of stock.`);
        continue;
      }
      toAdd.push(pid);
    }
  }

  if (errors.length) {
    const slots = await Promise.all(def.slots.map(async slot => {
      const ph = slot.categories.map(() => '?').join(',');
      const products = await db.all(
        `SELECT * FROM products WHERE category IN (${ph}) AND stock > 0 ORDER BY name ASC`,
        slot.categories
      );
      return { ...slot, products };
    }));
    return res.render('basket-builder', {
      user: req.session.user || null,
      basketType: req.params.type,
      basketLabel: def.label,
      basketTagline: def.description || def.tagline,
      slots,
      discountMap,
      applyDiscount,
      errors,
      selected: req.body,
      addBasket,
    });
  }

  if (!req.session.cart) req.session.cart = [];

  if (addBasket) {
    const addonId = await getOrCreateBasketAddon();
    const existing = req.session.cart.find(i => i.id === addonId);
    if (existing) existing.quantity += 1;
    else req.session.cart.push({ id: addonId, quantity: 1 });
  }

  for (const pid of toAdd) {
    const existing = req.session.cart.find(i => i.id === pid);
    if (existing) existing.quantity = Math.min(existing.quantity + 1, 99);
    else req.session.cart.push({ id: pid, quantity: 1 });
  }

  res.redirect('/cart');
});

module.exports = router;
module.exports.BASKET_DEFS = BASKET_DEFS;
