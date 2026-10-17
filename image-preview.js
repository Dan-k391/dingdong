/* Images are shared with chat as a high-quality preview that people can view and save. */
(() => {
  'use strict';

  const MAX_PREVIEW = 6000000; // data URL characters (~4.5 MB): generous, so shared images keep their quality
  const MAX_SIDE = 4096;
  const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,/;
  const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

  function isImage(meta) {
    if (!meta) return false;
    const type = typeof meta.type === 'string' ? meta.type.trim() : '';
    // A typed document cannot acquire automatic sharing by using an image filename.
    if (type) return /^image\//i.test(type);
    return typeof meta.name === 'string' && /\.(?:png|apng|jpe?g|jfif|gif|webp|avif|bmp|svg|ico|heic|heif|tiff?)$/i.test(meta.name);
  }

  function validURL(url) {
    if (typeof url !== 'string' || url.length > MAX_PREVIEW) return false;
    const match = DATA_IMAGE.exec(url);
    if (!match) return false;
    const data = url.slice(match[0].length);
    if (!data || data.length % 4 || !BASE64.test(data)) return false;
    // Require zero padding bits as well as a complete base64 shape.
    try { return btoa(atob(data)) === data; } catch { return false; }
  }

  async function createPreview(file) {
    if (!isImage(file)) throw new Error('This attachment is not an image.');
    let bitmap = null, image = null, objectURL = null, canvas = null;
    try {
      let source = null;
      if (typeof createImageBitmap === 'function') {
        try {
          bitmap = await createImageBitmap(file);
          if (bitmap && bitmap.width > 0 && bitmap.height > 0) source = bitmap;
        } catch { /* Some image formats are supported by Image but not ImageBitmap. */ }
      }
      if (!source) {
        if (bitmap && typeof bitmap.close === 'function') {
          try { bitmap.close(); } catch { }
        }
        bitmap = null;
        image = new Image();
        objectURL = URL.createObjectURL(file);
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error('This image format cannot be previewed by your browser.'));
          image.src = objectURL;
        });
        source = image;
      }
      const width = source === image ? image.naturalWidth : source.width;
      const height = source === image ? image.naturalHeight : source.height;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('This image has invalid dimensions.');
      }
      const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
      let w = Math.max(1, Math.round(width * scale));
      let h = Math.max(1, Math.round(height * scale));
      canvas = document.createElement('canvas');
      const qualities = [0.9, 0.7, 0.5];
      while (true) {
        canvas.width = w;
        canvas.height = h;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('This browser cannot create image previews.');
        context.drawImage(source, 0, 0, w, h);
        for (const quality of qualities) {
          const url = canvas.toDataURL('image/webp', quality);
          if (!/^data:image\/(?:png|jpeg|webp);base64,/.test(url)) {
            throw new Error('This browser could not encode the image preview.');
          }
          if (validURL(url)) return { url, w, h, n: url.length, preview: 1 };
          // Unsupported WebP encoders return PNG; its size does not respond to quality.
          if (url.startsWith('data:image/png;')) break;
        }
        if (w === 1 && h === 1) throw new Error('This browser could not create a bounded image preview.');
        const nextScale = Math.max(1, Math.floor(Math.max(w, h) * 0.75)) / Math.max(width, height);
        w = Math.max(1, Math.round(width * nextScale));
        h = Math.max(1, Math.round(height * nextScale));
      }
    } finally {
      if (bitmap && typeof bitmap.close === 'function') {
        try { bitmap.close(); } catch { }
      }
      if (image) {
        image.onload = null;
        image.onerror = null;
        try {
          if (typeof image.removeAttribute === 'function') image.removeAttribute('src');
          else image.src = '';
        } catch { }
      }
      if (objectURL) {
        try { URL.revokeObjectURL(objectURL); } catch { }
      }
      if (canvas) {
        try { canvas.width = 0; canvas.height = 0; } catch { }
      }
    }
  }

  window.DischordImages = Object.freeze({ isImage, createPreview, validURL, MAX_PREVIEW, MAX_SIDE });
})();
