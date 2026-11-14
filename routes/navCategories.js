// Category tree for the site navigation and collection pages, built from the
// categories table (Admin → Manage categories). Cached briefly so every page
// view doesn't hit the database; admin category changes clear the cache.
const { db } = require('../database');

const TTL_MS = 60 * 1000;
let cache = null, cachedAt = 0;

async function getNavCategories() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const all = await db.all('SELECT id, name, slug, parent_id, sort_order FROM categories ORDER BY sort_order, id');
  const parents = all.filter(c => !c.parent_id);
  cache = parents.map(p => ({
    name: p.name,
    slug: p.slug,
    children: all.filter(c => c.parent_id === p.id).map(c => ({ name: c.name, slug: c.slug })),
  }));
  cachedAt = Date.now();
  return cache;
}

function clearNavCache() { cache = null; }

// Express middleware: exposes `navCategories` to every view.
async function navCategoriesMiddleware(req, res, next) {
  try {
    res.locals.navCategories = await getNavCategories();
  } catch (err) {
    console.error('Nav categories error:', err.message);
    res.locals.navCategories = [];
  }
  next();
}

module.exports = { getNavCategories, clearNavCache, navCategoriesMiddleware };
