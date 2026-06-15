const express = require('express');
const app = express();

app.use(express.json({ limit: '10mb' }));

// CORS: GAS は googleusercontent.com iframe から呼ぶため全許可
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 画像を30分間メモリに保持（Twitter crawlerが取得できれば十分）
const store = new Map();
const TTL_MS = 30 * 60 * 1000;

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (v.expires < now) store.delete(k);
}, 5 * 60 * 1000);

// POST /share  { imageBase64, title, matchText }
// → { shareId, shareUrl, imageUrl }
app.post('/share', (req, res) => {
  const { imageBase64, title, matchText } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

  const id = genId();
  const b64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');

  store.set(id, {
    buf,
    title:     title     || 'トーナメント',
    matchText: matchText || '',
    expires:   Date.now() + TTL_MS,
  });

  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    shareId:  id,
    shareUrl: `${base}/share/${id}`,
    imageUrl: `${base}/share/${id}.jpg`,
  });
});

// GET /share/:id  → OGP + Twitter card HTML
app.get('/share/:id', (req, res) => {
  const d = store.get(req.params.id);
  if (!d || Date.now() > d.expires) return res.status(404).send('Not found or expired');

  const base     = `${req.protocol}://${req.get('host')}`;
  const imageUrl = `${base}/share/${req.params.id}.jpg`;
  const title    = escHtml(d.title);
  const desc     = escHtml(d.matchText);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="utf-8">
<title>${title}</title>
<meta property="og:type"        content="website">
<meta property="og:title"       content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image"       content="${imageUrl}">
<meta name="twitter:card"        content="summary_large_image">
<meta name="twitter:title"       content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image"       content="${imageUrl}">
</head><body>
<img src="${imageUrl}" style="max-width:100%">
<p>${desc}</p>
</body></html>`);
});

// GET /share/:id.jpg  → JPEG 画像
app.get('/share/:id.jpg', (req, res) => {
  const d = store.get(req.params.id);
  if (!d || Date.now() > d.expires) return res.status(404).send('Not found or expired');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=1800');
  res.send(d.buf);
});

app.get('/', (req, res) => res.send('serval-share OK'));

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`serval-share listening on port ${PORT}`));
