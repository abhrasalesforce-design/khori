const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');

function configure() {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// Upload a buffer (for product uploads from admin)
async function uploadBuffer(buffer, folder = 'khori-products') {
  configure();
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image', transformation: [{ quality: 'auto', fetch_format: 'auto' }] },
      (err, result) => err ? reject(err) : resolve(result.secure_url)
    ).end(buffer);
  });
}

// Upload a local file path (for static images on startup)
async function uploadFile(filePath, publicId) {
  configure();
  const result = await cloudinary.uploader.upload(filePath, {
    public_id: publicId,
    folder: 'khori-static',
    overwrite: false,       // skip if already uploaded
    resource_type: 'image',
    transformation: [{ quality: 'auto', fetch_format: 'auto' }],
  });
  return result.secure_url;
}

// Upload all local static images and return a map of filename → CDN URL
async function uploadStaticImages() {
  const imagesDir = path.join(__dirname, 'public/images');
  const files = fs.readdirSync(imagesDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
  const map = {};
  for (const file of files) {
    if (file === 'placeholder.jpg') continue;
    const publicId = path.basename(file, path.extname(file));
    try {
      map[file] = await uploadFile(path.join(imagesDir, file), publicId);
      console.log(`[Cloudinary] ${file} → ${map[file]}`);
    } catch (err) {
      console.warn(`[Cloudinary] Failed to upload ${file}:`, err.message);
    }
  }
  return map;
}

module.exports = { uploadBuffer, uploadFile, uploadStaticImages };
