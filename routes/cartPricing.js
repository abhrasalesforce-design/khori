const { db } = require('../database');

// Returns a map of { category: discount_pct } for all categories that have a discount set.
async function getDiscountMap() {
  try {
    const rows = await db.all('SELECT category, discount_pct FROM category_discounts');
    const map = {};
    for (const r of rows) map[r.category] = r.discount_pct;
    return map;
  } catch (_) {
    return {};
  }
}

// Returns the discounted price for a product given the discount map.
function applyDiscount(price, category, discountMap) {
  const pct = discountMap[category] ?? discountMap['__all__'] ?? 0;
  if (pct <= 0) return price;
  return Math.floor(price * (1 - pct / 100));
}

// Resolve cart session items into priced line items.
async function resolveCartItems(cart) {
  const rows = await Promise.all(cart.map(async item => {
    const product = await db.get('SELECT * FROM products WHERE id = ?', [item.id]);
    if (!product) return null;
    return { ...product, quantity: item.quantity };
  }));
  const products = rows.filter(Boolean);
  const discountMap = await getDiscountMap();

  return products.map(p => {
    const normalPrice    = applyDiscount(p.price, p.category, discountMap);
    const subtotal       = p.quantity * normalPrice;
    const discountedPrice = normalPrice;

    return {
      ...p,
      discountedPrice,
      subtotal,
      comboQty: 0,
      comboUnitPrice: 0,
      nonComboQty: p.quantity,
      normalPrice,
      inCombo: false,
    };
  });
}

module.exports = { resolveCartItems, getDiscountMap, applyDiscount };
