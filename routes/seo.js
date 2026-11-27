// Search-engine and sharing helpers: optimised image URLs, per-page titles,
// canonical URLs, noindex for private pages, robots.txt and JSON-LD data.
const SITE = 'https://www.hathekhori.com';
const DEFAULT_TITLE = 'Hathekhori – Handmade Crafts from Bengal';
const DEFAULT_DESCRIPTION = 'Hathekhori — handmade crafts rooted in Bengali tradition. Shop hand-painted mini canvases, terracotta jewellery, hand block printed diaries, totes and more, crafted by artisans across India.';

// Cloudinary images in a modern format (WebP/AVIF), auto quality, sized for where they show.
function cdnImg(src, width = 600) {
  if (!src || src === 'placeholder.jpg') return '/images/no-image.jpg';
  if (!/^https?:\/\//.test(src)) return '/uploads/' + src;
  if (src.includes('res.cloudinary.com') && src.includes('/image/upload/') && !/\/image\/upload\/[a-z]{1,2}_[^/]*\//.test(src)) {
    return src.replace('/image/upload/', `/image/upload/f_auto,q_auto,w_${width}/`);
  }
  return src;
}

// A 1200×630 JPEG for link previews (WhatsApp, Facebook, Instagram, X)
function ogImg(src) {
  if (src && src.includes('res.cloudinary.com') && src.includes('/image/upload/')) {
    return src.replace('/image/upload/', '/image/upload/c_fill,g_auto,w_1200,h_630,q_auto,f_jpg/');
  }
  if (src && /^https?:\/\//.test(src)) return src;
  return SITE + '/icon-512.png';
}

function shorten(text, max = 158) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, t.lastIndexOf(' ', max - 1) > 80 ? t.lastIndexOf(' ', max - 1) : max - 1) + '…';
}

const PRIVATE = /^\/(admin|cart|checkout|login|register|forgot-password|reset-password|orders|account|wishlist|order-confirmation|reviews|logout|version)(\/|$)/;

// Middleware: defaults every view can override (pageTitle, pageDescription, ogImage, jsonLd, noindex)
function seoMiddleware(req, res, next) {
  const sub = typeof req.query.sub === 'string' && /^[a-z0-9-]+$/.test(req.query.sub) ? `?sub=${req.query.sub}` : '';
  res.locals.canonicalUrl = SITE + (req.path === '/' ? '/' : req.path.replace(/\/$/, '')) + (req.path.startsWith('/collection/') ? sub : '');
  res.locals.noindex = PRIVATE.test(req.path);
  res.locals.seoDefaults = { title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION };
  next();
}

function robotsTxt(req, res) {
  res.type('text/plain').send([
    'User-agent: *',
    'Disallow: /admin', 'Disallow: /cart', 'Disallow: /checkout', 'Disallow: /orders', 'Disallow: /account',
    'Disallow: /order-confirmation', 'Disallow: /reviews/', 'Disallow: /wishlist',
    '', `Sitemap: ${SITE}/sitemap.xml`, '',
  ].join('\n'));
}

// Embed JSON-LD safely inside a <script> tag
function jsonLdScript(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

function productJsonLd(product, { salePrice, images, rating, reviews }) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    sku: 'HK-' + String(product.id).padStart(3, '0'),
    image: images.slice(0, 5).map(i => cdnImg(i, 1200)).map(u => (u.startsWith('http') ? u : SITE + u)),
    description: shorten(product.description, 500) || product.name,
    brand: { '@type': 'Brand', name: 'Hathekhori' },
    ...(product.material && product.material.length <= 60 ? { material: product.material } : {}),
    offers: {
      '@type': 'Offer',
      url: `${SITE}/product/${product.id}`,
      priceCurrency: 'INR',
      price: Number(salePrice).toFixed(2),
      availability: product.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: 'Hathekhori' },
    },
  };
  if (rating && rating.count) {
    data.aggregateRating = { '@type': 'AggregateRating', ratingValue: rating.avg.toFixed(1), reviewCount: rating.count };
    data.review = (reviews || []).slice(0, 5).map(r => ({
      '@type': 'Review',
      reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5 },
      author: { '@type': 'Person', name: r.first_name },
      ...(r.comment ? { reviewBody: shorten(r.comment, 500) } : {}),
    }));
  }
  return data;
}

const siteJsonLd = [
  {
    '@context': 'https://schema.org', '@type': 'Organization', name: 'Hathekhori', url: SITE,
    logo: SITE + '/icon-512.png', email: 'contact.hathekhori@gmail.com',
    sameAs: ['https://www.instagram.com/hathekhorihandcraft/'],
  },
  { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Hathekhori', url: SITE },
];

module.exports = { SITE, cdnImg, ogImg, shorten, seoMiddleware, robotsTxt, jsonLdScript, productJsonLd, siteJsonLd, DEFAULT_TITLE, DEFAULT_DESCRIPTION };
