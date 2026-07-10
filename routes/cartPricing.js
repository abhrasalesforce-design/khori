const { db } = require('../database');

const BOOKMARK_BUNDLE_PRICE = 29;

// Returns a map of { category: discount_pct } for all categories that have a discount set.
async function getDiscountMap() {
  const rows = await db.all('SELECT category, discount_pct FROM category_discounts');
  const map = {};
  for (const r of rows) map[r.category] = r.discount_pct;
  return map;
}

// Returns the discounted price for a product given the discount map.
function applyDiscount(price, category, discountMap) {
  const pct = discountMap[category] ?? discountMap['__all__'] ?? 0;
  if (pct <= 0) return price;
  return Math.floor(price * (1 - pct / 100));
}

// Returns true if the product name suggests it is a "Hand Blocked Diary"
function isHandBlockedDiary(product) {
  return /hand[\s-]?block/i.test(product.name) && /diar/i.test(product.name);
}

// Returns true if the product is a bookmark
function isBookmark(product) {
  return product.category === 'bookmarks';
}

// Resolve cart session items into priced line items.
// If a bookmark and a Hand Blocked Diary are both in the cart, each bookmark is priced at ₹29.
async function resolveCartItems(cart) {
  const rows = await Promise.all(cart.map(async item => {
    const product = await db.get('SELECT * FROM products WHERE id = ?', [item.id]);
    if (!product) return null;
    return { ...product, quantity: item.quantity };
  }));
  const products = rows.filter(Boolean);

  const hasDiary = products.some(isHandBlockedDiary);
  const discountMap = await getDiscountMap();

  return products.map(p => {
    let discountedPrice;
    if (isBookmark(p) && hasDiary) {
      discountedPrice = BOOKMARK_BUNDLE_PRICE;
    } else {
      discountedPrice = applyDiscount(p.price, p.category, discountMap);
    }
    return { ...p, discountedPrice, subtotal: discountedPrice * p.quantity };
  });
}

module.exports = { resolveCartItems, getDiscountMap, applyDiscount };
