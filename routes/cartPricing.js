const { db } = require('../database');

// Combo: 1 Hand Blocked Diary + 1 Hand Blocked Bookmark = ₹259 total
const COMBO_TOTAL       = 259;
const DIARY_COMBO_PRICE    = 230; // diary's share within the combo
const BOOKMARK_COMBO_PRICE = 29;  // bookmark's share within the combo

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

function isHandBlockedDiary(product) {
  return /hand[\s-]?block/i.test(product.name) && /diar/i.test(product.name);
}

function isHandBlockedBookmark(product) {
  return /hand[\s-]?block/i.test(product.name) && product.category === 'bookmarks';
}

// Resolve cart session items into priced line items.
// Combo rule: each matched pair of (1 Hand Blocked Diary + 1 Hand Blocked Bookmark) = ₹259.
// Extra units beyond matched pairs are priced normally.
async function resolveCartItems(cart) {
  const rows = await Promise.all(cart.map(async item => {
    const product = await db.get('SELECT * FROM products WHERE id = ?', [item.id]);
    if (!product) return null;
    return { ...product, quantity: item.quantity };
  }));
  const products = rows.filter(Boolean);
  const discountMap = await getDiscountMap();

  const diaryItems    = products.filter(isHandBlockedDiary);
  const bookmarkItems = products.filter(isHandBlockedBookmark);

  const totalDiaryQty    = diaryItems.reduce((s, p) => s + p.quantity, 0);
  const totalBookmarkQty = bookmarkItems.reduce((s, p) => s + p.quantity, 0);
  const comboPairs = Math.min(totalDiaryQty, totalBookmarkQty);

  // Distribute combo quota across diary rows (in order), then bookmark rows
  let remainingDiaryCombo = comboPairs;
  for (const p of diaryItems) {
    p.comboQty = Math.min(p.quantity, remainingDiaryCombo);
    remainingDiaryCombo -= p.comboQty;
  }
  let remainingBookmarkCombo = comboPairs;
  for (const p of bookmarkItems) {
    p.comboQty = Math.min(p.quantity, remainingBookmarkCombo);
    remainingBookmarkCombo -= p.comboQty;
  }

  return products.map(p => {
    const comboQty    = p.comboQty || 0;
    const nonComboQty = p.quantity - comboQty;
    const normalPrice = applyDiscount(p.price, p.category, discountMap);

    let comboUnitPrice = 0;
    if (comboQty > 0) {
      comboUnitPrice = isHandBlockedDiary(p) ? DIARY_COMBO_PRICE : BOOKMARK_COMBO_PRICE;
    }

    const subtotal        = comboQty * comboUnitPrice + nonComboQty * normalPrice;
    // effective per-unit price for display (used in order confirmation etc.)
    const discountedPrice = p.quantity > 0 ? Math.round(subtotal / p.quantity) : normalPrice;

    return {
      ...p,
      discountedPrice,
      subtotal,
      comboQty,
      comboUnitPrice,
      nonComboQty,
      normalPrice,
      inCombo: comboQty > 0,
    };
  });
}

module.exports = { resolveCartItems, getDiscountMap, applyDiscount, COMBO_TOTAL };
