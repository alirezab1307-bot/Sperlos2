/**
 * سرور اسپرلوس — بک‌اند واقعی
 * -----------------------------------------------------------------
 * این سرور با Node.js نوشته شده و از دو حالت ذخیره‌سازی پشتیبانی می‌کند:
 *
 *   ۱) حالت فایل (پیش‌فرض): داده‌ها در data/data.json روی دیسک سرور
 *      ذخیره می‌شوند. مناسب برای میزبانی‌هایی که دیسک پایدار (persistent
 *      disk) دارند، مثل لیارا.
 *
 *   ۲) حالت MongoDB: اگر متغیر محیطی MONGODB_URI تنظیم شده باشد، داده‌ها
 *      در یک دیتابیس MongoDB (مثلاً حساب رایگان MongoDB Atlas) ذخیره
 *      می‌شوند. این حالت برای میزبانی‌های رایگانی مثل Render لازم است،
 *      چون دیسک آن‌ها بین ری‌استارت‌ها پاک می‌شود و نمی‌شود به آن اعتماد کرد.
 *
 * در هر دو حالت، بقیه‌ی برنامه (مسیرهای API، احراز هویت و ...) دقیقاً
 * یکسان کار می‌کند؛ فقط لایه‌ی ذخیره‌سازی زیرین فرق دارد.
 *
 * اجرا (حالت فایل):
 *   node server.js
 * اجرا (حالت MongoDB):
 *   MONGODB_URI="mongodb+srv://..." node server.js
 * -----------------------------------------------------------------
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSIONS_KEY = '__sessions__';
const ACCOUNTS_KEY = 'sl_accounts_v1';
const OFFICE_CUSTOMERS_KEY = 'sl_office_customers_v1'; // فقط مدیر اجازه‌ی نوشتن دارد
const OFFICE_FILES_KEY = 'sl_office_files_v1'; // فایل‌های دفتر — فقط مدیر اجازه‌ی نوشتن دارد
const MESSAGES_KEY = 'sl_messages_v1'; // گفتگوی داخلی مدیر/مشاوران — فقط از طریق مسیر اختصاصی /api/messages (نه storage عمومی) در دسترس است تا هر مشاور فقط پیام‌های خودش را ببیند
const ATTENDANCE_KEY = 'sl_attendance_v1'; // ثبت روزانه‌ی ساعت ورود/خروج مشاوران
const ACTIVITY_KEY = 'sl_activity_v1'; // ثبت روزانه‌ی تماس/بازدید/آگهی دیوار مشاوران

/* ---------------------------------------------------------------
   لایه ذخیره‌سازی (Store) — یک رابط ساده get/set که پشت آن یا
   فایل روی دیسک است یا MongoDB. بقیه‌ی کد اصلاً نمی‌داند کدام است.
   --------------------------------------------------------------- */
let BACKEND = 'file';
let cache = {}; // آینه‌ی حافظه‌ای از همه‌ی کلیدها، برای خواندن سریع بدون رفت‌وبرگشت به دیتابیس

// --- حالت فایل ---
// نکته‌ی مهم (رفع باگ کندی/گم‌شدن اطلاعات): قبلاً کل داده‌ی برنامه (همه‌ی فایل‌ها، مشتریان،
// قراردادها، تردد، فعالیت‌ها و ...) در یک فایل data.json ذخیره می‌شد و با هر تغییر کوچک —
// حتی تغییر یک فیلد در یک قرارداد — کل این فایل (که با عکس‌های قرارداد می‌تواند چند مگابایت
// باشد) به‌صورت سینک (fs.writeFileSync) دوباره نوشته می‌شد. چون Node.js تک‌رشته‌ای است،
// این نوشتن سینکِ حجیم، کل سرور را برای همه‌ی مشاوران هم‌زمان چند ثانیه «فریز» می‌کرد
// (دقیقاً همان تأخیر ۵ تا ۱۵ ثانیه‌ای که هنگام ذخیره دیده می‌شد) و هرچه داده بزرگ‌تر
// می‌شد، این تأخیر هم بیشتر می‌شد.
// راه‌حل: هر کلید (sl_files، sl_customers و ...) در فایل جداگانه‌ی خودش ذخیره می‌شود، پس
// ذخیره‌ی یک قرارداد فقط همان یک فایل کوچک را می‌نویسد نه کل دیتابیس را؛ و نوشتن روی
// دیسک به‌صورت async (fs.promises) انجام می‌شود تا رویدادحلقه‌ی Node مسدود نشود و
// درخواست‌های هم‌زمان سایر مشاوران معطل نمانند.
function keyFilePath(key) {
  const safe = String(key).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(DATA_DIR, safe + '.json');
}
function fileLoadAll() {
  const obj = {};
  if (fs.existsSync(DATA_DIR)) {
    for (const fname of fs.readdirSync(DATA_DIR)) {
      if (!fname.endsWith('.json') || fname.endsWith('.tmp.json')) continue;
      const key = fname.slice(0, -5);
      try { obj[key] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, fname), 'utf8')); }
      catch (e) { console.error(`⚠️ فایل «${fname}» خراب بود و نادیده گرفته شد:`, e.message); }
    }
  }
  // سازگاری با نسخه‌ی قدیمی: اگر هنوز data.json تک‌فایلی از قبل مانده، مقادیرش را (فقط
  // برای کلیدهایی که هنوز به قالب جدید مهاجرت نکرده‌اند) بخوان تا چیزی گم نشود.
  const legacyPath = path.join(DATA_DIR, 'data.json');
  if (fs.existsSync(legacyPath)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      Object.keys(legacy).forEach(k => { if (!(k in obj)) obj[k] = legacy[k]; });
    } catch (e) { /* نادیده گرفتن فایل قدیمی خراب */ }
  }
  return obj;
}
const __pendingWrites = new Map(); // key -> {inFlight, queued}
async function persistKeyToDisk(key) {
  let state = __pendingWrites.get(key);
  if (!state) { state = { inFlight: false, queued: false }; __pendingWrites.set(key, state); }
  if (state.inFlight) { state.queued = true; return; } // نوشتن قبلی این کلید هنوز تمام نشده؛ وقتی تمام شد دوباره با آخرین نسخه‌ی cache نوشته می‌شود
  state.inFlight = true;
  try {
    if (!fs.existsSync(DATA_DIR)) await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const fp = keyFilePath(key);
    const tmp = fp + '.tmp.json';
    await fs.promises.writeFile(tmp, JSON.stringify(cache[key]));
    await fs.promises.rename(tmp, fp); // نوشتن اتمیک تا در صورت قطعی برق دیتا خراب نشود
  } catch (e) {
    console.error(`❌ خطا در ذخیره‌ی کلید «${key}» روی دیسک:`, e);
  } finally {
    state.inFlight = false;
    if (state.queued) { state.queued = false; persistKeyToDisk(key); }
  }
}
async function migrateLegacyIfNeeded() {
  const legacyPath = path.join(DATA_DIR, 'data.json');
  if (!fs.existsSync(legacyPath)) return;
  console.log('ℹ️  در حال مهاجرت داده‌ها از قالب قدیمی (یک فایل) به قالب جدید (هر بخش، یک فایل جدا)...');
  await Promise.all(Object.keys(cache).map(k => persistKeyToDisk(k)));
  try { fs.unlinkSync(legacyPath); } catch (e) { /* بی‌اهمیت */ }
  console.log('✅ مهاجرت انجام شد — داده‌ها دیگر به data.json نیاز ندارند.');
}

// --- حالت MongoDB ---
let mongoColl = null;
async function mongoInit(uri) {
  const { MongoClient } = require('mongodb'); // فقط وقتی لازم است بارگذاری می‌شود
  const client = new MongoClient(uri);
  await client.connect();
  mongoColl = client.db('esperlous').collection('kv');
}
async function mongoLoadAll() {
  const docs = await mongoColl.find({}).toArray();
  const obj = {};
  docs.forEach(d => { obj[d._id] = d.value; });
  return obj;
}
async function mongoSaveKey(key, value) {
  await mongoColl.updateOne({ _id: key }, { $set: { value } }, { upsert: true });
}

async function storeGet(key) {
  return cache[key];
}
async function storeSet(key, value) {
  cache[key] = value;
  if (BACKEND === 'mongo') await mongoSaveKey(key, value);
  else await persistKeyToDisk(key);
}

async function initStorage() {
  if (process.env.MONGODB_URI) {
    BACKEND = 'mongo';
    await mongoInit(process.env.MONGODB_URI);
    cache = await mongoLoadAll();
    console.log('✅ اتصال به MongoDB برقرار شد — داده‌ها در دیتابیس ابری ذخیره می‌شوند');
  } else {
    BACKEND = 'file';
    cache = fileLoadAll();
    await migrateLegacyIfNeeded();
    console.log(`ℹ️  حالت فایل فعال است — داده‌ها در ${DATA_DIR} ذخیره می‌شوند (هر بخش در فایل جدای خودش)`);
  }
  if (!cache[SESSIONS_KEY]) cache[SESSIONS_KEY] = {};
  if (!cache[ACCOUNTS_KEY]) cache[ACCOUNTS_KEY] = [];
}

/* ---------------------------------------------------------------
   رمزنگاری رمز عبور (scrypt - داخلی Node، بدون کتابخانه خارجی)
   --------------------------------------------------------------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || stored.indexOf(':') === -1) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch (e) { return false; }
}
function newToken() { return crypto.randomBytes(32).toString('hex'); }

function getAccounts() { return cache[ACCOUNTS_KEY] || []; }
async function setAccounts(list) { await storeSet(ACCOUNTS_KEY, list); }
function getSessions() { return cache[SESSIONS_KEY] || {}; }
async function setSession(token, accountId) {
  const s = getSessions(); s[token] = accountId; await storeSet(SESSIONS_KEY, s);
}
async function removeSession(token) {
  const s = getSessions(); delete s[token]; await storeSet(SESSIONS_KEY, s);
}

/* ---------------------------------------------------------------
   کمک‌کننده‌های HTTP
   --------------------------------------------------------------- */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    // نکته‌ی مهم: باید تکه‌های (chunk) دریافتی را به‌صورت Buffer خام نگه داریم و فقط در پایان،
    // کل بادی را یکجا با UTF-8 دیکد کنیم. اگر هر chunk را جداگانه دیکد کنیم (مثلاً با «data += chunk»
    // که به‌صورت ضمنی chunk.toString() را روی هر تکه صدا می‌زند)، وقتی یک کاراکتر فارسی/چندبایتی
    // درست روی مرز دو chunk شکسته شود، آن کاراکتر و گاهی چند کاراکتر اطرافش به � (کاراکتر جایگزین)
    // تبدیل و برای همیشه در دیتابیس ذخیره می‌شود — دقیقاً همان باگیِ که در نام یکی از مشاوران دیده شد.
    const chunks = [];
    let totalLen = 0;
    req.on('data', (chunk) => {
      chunks.push(chunk);
      totalLen += chunk.length;
      if (totalLen > 25 * 1024 * 1024) { // سقف ۲۵ مگابایت برای هر درخواست (به‌خاطر عکس قراردادها)
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!totalLen) return resolve({});
      const data = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(data)); } catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}
function getAuthAccount(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const accountId = getSessions()[token];
  if (!accountId) return null;
  const acc = getAccounts().find(a => a.id === accountId);
  return acc ? { acc, token } : null;
}
function publicAccount(acc) {
  return { id: acc.id, name: acc.name, username: acc.username, role: acc.role, createdAt: acc.createdAt };
}

/* ---------------------------------------------------------------
   سرو فایل‌های استاتیک (خود برنامه)
   --------------------------------------------------------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      // مسیر ناشناخته -> همیشه خود برنامه را برگردان (SPA fallback)
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexContent) => {
        if (err2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(indexContent);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

/* ---------------------------------------------------------------
   روتر اصلی API
   --------------------------------------------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') { return sendJson(res, 200, { ok: true }); }

  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, backend: BACKEND });
  }

  if (!pathname.startsWith('/api/')) {
    return serveStatic(req, res, pathname);
  }

  try {
    /* ---------- راه‌اندازی اولیه: ساخت اولین حساب مدیر ---------- */
    if (pathname === '/api/setup' && req.method === 'POST') {
      const accounts = getAccounts();
      if (accounts.length > 0) return sendJson(res, 400, { error: 'already_setup' });
      const { name, username, password } = await readBody(req);
      if (!name || !username || !password || String(password).length < 4) {
        return sendJson(res, 400, { error: 'invalid_input' });
      }
      const acc = {
        id: 'acc_' + crypto.randomBytes(8).toString('hex'),
        name, username: String(username).toLowerCase(), role: 'admin',
        passwordHash: hashPassword(password), createdAt: new Date().toISOString(),
      };
      await setAccounts([acc]);
      const token = newToken();
      await setSession(token, acc.id);
      return sendJson(res, 200, { token, account: publicAccount(acc) });
    }

    /* ---------- بررسی اینکه سیستم قبلاً راه‌اندازی شده یا نه ---------- */
    if (pathname === '/api/setup-status' && req.method === 'GET') {
      return sendJson(res, 200, { needsSetup: getAccounts().length === 0 });
    }

    /* ---------- ورود ---------- */
    if (pathname === '/api/login' && req.method === 'POST') {
      const { username, password } = await readBody(req);
      const acc = getAccounts().find(a => a.username === String(username || '').toLowerCase());
      if (!acc || !verifyPassword(password, acc.passwordHash)) {
        return sendJson(res, 401, { error: 'invalid_credentials' });
      }
      const token = newToken();
      await setSession(token, acc.id);
      return sendJson(res, 200, { token, account: publicAccount(acc) });
    }

    /* ---------- از این به بعد، همه چیز نیاز به توکن معتبر دارد ---------- */
    const authed = getAuthAccount(req);
    if (!authed) return sendJson(res, 401, { error: 'unauthorized' });

    if (pathname === '/api/me' && req.method === 'GET') {
      return sendJson(res, 200, { account: publicAccount(authed.acc) });
    }
    if (pathname === '/api/me' && req.method === 'PUT') {
      if (authed.acc.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' }); // فقط مدیر حق ویرایش اطلاعات ورود خودش را دارد؛ مشاوران هیچ‌وقت
      const body = await readBody(req);
      const accounts = getAccounts();
      const acc = accounts.find(a => a.id === authed.acc.id);
      if (!acc) return sendJson(res, 404, { error: 'not_found' });
      if (body.name) acc.name = body.name;
      if (body.username) {
        const uname = String(body.username).toLowerCase();
        if (accounts.some(a => a.username === uname && a.id !== acc.id)) return sendJson(res, 400, { error: 'username_taken' });
        acc.username = uname;
      }
      if (body.password) {
        if (String(body.password).length < 4) return sendJson(res, 400, { error: 'weak_password' });
        acc.passwordHash = hashPassword(body.password);
      }
      await setAccounts(accounts);
      return sendJson(res, 200, { account: publicAccount(acc) });
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      await removeSession(authed.token);
      return sendJson(res, 200, { ok: true });
    }

    /* ---------- ساخت/ویرایش/حذف حساب مشاوران (فقط مدیر) ---------- */
    if (pathname === '/api/accounts' && req.method === 'POST') {
      if (authed.acc.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
      const { name, username, password } = await readBody(req);
      if (!name || !username || !password || String(password).length < 4) return sendJson(res, 400, { error: 'invalid_input' });
      const uname = String(username).toLowerCase();
      const accounts = getAccounts();
      if (accounts.some(a => a.username === uname)) return sendJson(res, 400, { error: 'username_taken' });
      const acc = { id: 'acc_' + crypto.randomBytes(8).toString('hex'), name, username: uname, role: 'agent', passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
      accounts.push(acc); await setAccounts(accounts);
      return sendJson(res, 200, { account: publicAccount(acc) });
    }
    if (pathname.startsWith('/api/accounts/') && req.method === 'PUT') {
      if (authed.acc.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
      const id = pathname.split('/')[3];
      const accounts = getAccounts();
      const acc = accounts.find(a => a.id === id);
      if (!acc) return sendJson(res, 404, { error: 'not_found' });
      const body = await readBody(req);
      if (body.name) acc.name = body.name;
      if (body.username) {
        const uname = String(body.username).toLowerCase();
        if (accounts.some(a => a.username === uname && a.id !== id)) return sendJson(res, 400, { error: 'username_taken' });
        acc.username = uname;
      }
      if (body.password) {
        if (String(body.password).length < 4) return sendJson(res, 400, { error: 'weak_password' });
        acc.passwordHash = hashPassword(body.password);
      }
      await setAccounts(accounts);
      return sendJson(res, 200, { account: publicAccount(acc) });
    }
    if (pathname.startsWith('/api/accounts/') && req.method === 'DELETE') {
      if (authed.acc.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
      const id = pathname.split('/')[3];
      let accounts = getAccounts();
      accounts = accounts.filter(a => a.id !== id);
      await setAccounts(accounts);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/accounts' && req.method === 'GET') {
      if (authed.acc.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
      return sendJson(res, 200, { accounts: getAccounts().map(publicAccount) });
    }

    /* ---------- گفتگوی داخلی (چت) مدیر ⇄ مشاوران ----------
       هر رشته‌ی گفتگو با agentName مشخص می‌شود (نام همان مشاور طرف گفتگو با مدیر).
       این مسیر عمداً جدا از /api/storage/ عمومی است تا هر مشاور فقط بتواند رشته‌ی
       گفتگوی خودش را بخواند/بنویسد، نه گفتگوی مشاوران دیگر با مدیر را. */
    if (pathname === '/api/messages' && req.method === 'GET') {
      const all = (await storeGet(MESSAGES_KEY)) || [];
      const list = authed.acc.role === 'admin' ? all : all.filter(m => m.agentName === authed.acc.name);
      return sendJson(res, 200, { messages: list });
    }
    if (pathname === '/api/messages' && req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'empty_message' });
      let agentName;
      if (authed.acc.role === 'admin') {
        agentName = String(body.toAgent || '').trim();
        if (!agentName) return sendJson(res, 400, { error: 'missing_agent' });
      } else {
        agentName = authed.acc.name;
      }
      const all = (await storeGet(MESSAGES_KEY)) || [];
      const msg = {
        id: 'msg_' + crypto.randomBytes(8).toString('hex'),
        agentName,
        senderRole: authed.acc.role,
        senderName: authed.acc.name,
        text,
        createdAt: new Date().toISOString(),
        readByAdmin: authed.acc.role === 'admin',
        readByAgent: authed.acc.role === 'agent',
      };
      all.push(msg);
      await storeSet(MESSAGES_KEY, all);
      return sendJson(res, 200, { message: msg });
    }
    if (pathname === '/api/messages/read' && req.method === 'POST') {
      const body = await readBody(req);
      const all = (await storeGet(MESSAGES_KEY)) || [];
      let changed = false;
      all.forEach(m => {
        if (authed.acc.role === 'admin') {
          if ((!body.agentName || m.agentName === body.agentName) && !m.readByAdmin) { m.readByAdmin = true; changed = true; }
        } else if (m.agentName === authed.acc.name && !m.readByAgent) { m.readByAgent = true; changed = true; }
      });
      if (changed) await storeSet(MESSAGES_KEY, all);
      return sendJson(res, 200, { ok: true });
    }

    /* ---------- خلاصه‌ی سبک وضعیت داده‌ها (برای بررسی دوره‌ای سریع «چیزی عوض شده یا نه؟») ----------
       این مسیر به‌جای برگرداندن کل داده‌ها (که ممکن است شامل عکس‌های حجیم قرارداد باشد)،
       فقط تعداد آیتم‌ها و جدیدترین زمان ویرایش هر بخش را برمی‌گرداند. کلاینت هر چند ثانیه
       این مسیر سبک را صدا می‌زند و فقط وقتی چیزی واقعاً عوض شده، داده‌ی کامل را می‌گیرد. */
    if (pathname === '/api/meta' && req.method === 'GET') {
      const arrayKeys = ['sl_files', 'sl_customers', 'sl_mosharekat_melk', 'sl_mosharekat_sazande_req',
        'sl_sazande_bank', 'sl_contracts_rent', 'sl_contracts_sale', 'sl_contracts_mosharekat',
        'sl_contracts_other', 'sl_opportunities', 'sl_office_customers_v1', 'sl_office_files_v1',
        ATTENDANCE_KEY, ACTIVITY_KEY, MESSAGES_KEY];
      const out = {};
      for (const k of arrayKeys) {
        const list = await storeGet(k);
        let maxU = '';
        if (Array.isArray(list)) {
          for (const item of list) { const u = item && item.updatedAt; if (u && u > maxU) maxU = u; }
          out[k] = list.length + '|' + maxU;
        } else out[k] = '0|';
      }
      out.sl_settings = JSON.stringify((await storeGet('sl_settings')) || {});
      out.sl_agent_backup_meta = JSON.stringify((await storeGet('sl_agent_backup_meta')) || {});
      return sendJson(res, 200, out);
    }

    /* ---------- تغییر سریع وضعیت یک فایل ملکی (بدون نیاز به ارسال کل آرایه فایل‌ها) ----------
       این مسیر جدا از /api/storage است چون: ۱) فقط یک فیلد کوچک رد و بدل می‌شود (نه کل
       لیست فایل‌ها که ممکن است شامل عکس‌های حجیم قرارداد باشد) پس خیلی سریع‌تر است،
       و ۲) تغییر روی نسخه‌ی معتبر سرور انجام می‌شود، نه نسخه‌ای که کلاینت از قبل نزد
       خودش داشته؛ در نتیجه اگر همزمان کاربر دیگری فایل دیگری را اضافه/ویرایش کرده باشد،
       آن تغییرات با یک ارسال قدیمی از کلاینت این یکی رونویسی (overwrite) نمی‌شوند. */
    if (/^\/api\/files\/[^/]+\/status$/.test(pathname) && (req.method === 'PATCH' || req.method === 'PUT')) {
      const id = pathname.split('/')[3];
      const { status } = await readBody(req);
      const ALLOWED_STATUSES = ['active', 'negotiating', 'contracted', 'closed', 'expired'];
      if (!ALLOWED_STATUSES.includes(status)) return sendJson(res, 400, { error: 'invalid_status' });
      const key = 'sl_files';
      const list = (await storeGet(key)) || [];
      const item = list.find(f => f.id === id);
      if (!item) return sendJson(res, 404, { error: 'not_found' });
      if (authed.acc.role !== 'admin' && item.agentName !== authed.acc.name) {
        return sendJson(res, 403, { error: 'forbidden' });
      }
      const ARCHIVE_STATUSES = ['closed', 'expired'];
      const wasArchived = ARCHIVE_STATUSES.includes(item.status || 'active');
      item.status = status;
      item.updatedAt = new Date().toISOString();
      const nowArchived = ARCHIVE_STATUSES.includes(status);
      if (nowArchived && !wasArchived) item.archivedAt = item.updatedAt;
      if (!nowArchived) item.archivedAt = null;
      await storeSet(key, list);
      return sendJson(res, 200, { ok: true, item });
    }

    /* ---------- ذخیره‌ی «تفاوت» به‌جای کل آرایه (رفع باگ گم‌شدن اطلاعات هنگام ذخیره‌ی هم‌زمان) ----------
       قبلاً کلاینت با هر ذخیره، کل آرایه (مثلاً کل sl_files) را که در حافظه‌ی خودش داشت
       به‌جای آرایه‌ی سرور می‌نشاند. اگر دو مشاور هم‌زمان (یا با فاصله‌ی چند ثانیه، به‌خاطر
       کند بودن ذخیره‌ی قبلی) دو چیز متفاوت اضافه/ویرایش می‌کردند، هرکدام که آخر ذخیره
       می‌شد، تغییرات آن‌یکی را که در نسخه‌ی محلی‌اش نبود، کامل پاک می‌کرد — همان باگِ
       «فایلی که ثبت کرده بودم، چند ساعت بعد پریده بود».
       این مسیر به‌جای «کل آرایه را جایگزین کن»، فقط عملیات مشخص (این‌ها را اضافه/ویرایش کن،
       این شناسه‌ها را حذف کن) را روی آخرین نسخه‌ی معتبرِ سرور اعمال می‌کند — نه نسخه‌ی
       قدیمی‌ای که کلاینت از قبل نزد خودش داشت — پس تغییرات هم‌زمان‌ِ بقیه هرگز رونویسی نمی‌شود. */
    if (/^\/api\/storage\/[^/]+\/batch$/.test(pathname) && req.method === 'PATCH') {
      const key = decodeURIComponent(pathname.split('/')[3]);
      if (key === ACCOUNTS_KEY || key === SESSIONS_KEY || key === MESSAGES_KEY) return sendJson(res, 403, { error: 'forbidden_key' });
      if (key === OFFICE_CUSTOMERS_KEY && authed.acc.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
      if (key === OFFICE_FILES_KEY && authed.acc.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
      const body = await readBody(req);
      const added = Array.isArray(body.added) ? body.added : [];
      const updated = Array.isArray(body.updated) ? body.updated : [];
      const removedIds = Array.isArray(body.removedIds) ? body.removedIds : [];
      // نکته: بین این خط (خواندن آخرین نسخه از cache) و ذخیره‌ی نهایی، هیچ await ای روی
      // خودِ آرایه انجام نمی‌شود؛ پس چون Node تک‌رشته‌ای است، درخواست دیگری نمی‌تواند
      // وسط این عملیات فاصله بیندازد و باعث تداخل شود (درست مثل مسیر امن status فایل).
      let list = (await storeGet(key)) || [];
      if (!Array.isArray(list)) list = [];
      if (removedIds.length) {
        const removeSet = new Set(removedIds);
        list = list.filter(it => !removeSet.has(it && it.id));
      }
      updated.forEach(u => {
        if (!u || !u.id) return;
        const idx = list.findIndex(it => it && it.id === u.id);
        if (idx !== -1) list[idx] = u; else list.push(u); // اگر پیدا نشد (مثلاً هم‌زمان توسط شخص دیگری حذف شده)، دوباره اضافه می‌شود تا ویرایش کاربر گم نشود
      });
      added.forEach(a => {
        if (!a || !a.id) return;
        const idx = list.findIndex(it => it && it.id === a.id);
        if (idx !== -1) list[idx] = a; else list.push(a);
      });
      await storeSet(key, list);
      return sendJson(res, 200, { ok: true, count: list.length });
    }

    /* ---------- ادغام (merge) به‌جای رونویسی کامل، برای کلیدهایی که آبجکت ساده هستند
       (نه آرایه) مثل تنظیمات یا متادیتای بک‌آپ — همان دلیل امنیتی مسیر batch بالا ---------- */
    if (/^\/api\/storage\/[^/]+\/merge$/.test(pathname) && req.method === 'PATCH') {
      const key = decodeURIComponent(pathname.split('/')[3]);
      if (key === ACCOUNTS_KEY || key === SESSIONS_KEY || key === MESSAGES_KEY) return sendJson(res, 403, { error: 'forbidden_key' });
      const { patch } = await readBody(req);
      const current = (await storeGet(key)) || {};
      const merged = Object.assign({}, current, (patch && typeof patch === 'object') ? patch : {});
      await storeSet(key, merged);
      return sendJson(res, 200, { ok: true, value: merged });
    }

    /* ---------- ذخیره‌سازی مشترک key-value (فایل‌ها، مشتریان، قراردادها، تنظیمات و ...) ---------- */
    if (pathname.startsWith('/api/storage/') && req.method === 'GET') {
      const key = decodeURIComponent(pathname.slice('/api/storage/'.length));
      if (key === MESSAGES_KEY) return sendJson(res, 403, { error: 'forbidden_key' }); // فقط از /api/messages در دسترس است
      const value = await storeGet(key);
      return sendJson(res, 200, { value: value === undefined ? null : JSON.stringify(value) });
    }
    if (pathname.startsWith('/api/storage/') && req.method === 'PUT') {
      const key = decodeURIComponent(pathname.slice('/api/storage/'.length));
      if (key === ACCOUNTS_KEY || key === SESSIONS_KEY || key === MESSAGES_KEY) return sendJson(res, 403, { error: 'forbidden_key' });
      if (key === OFFICE_CUSTOMERS_KEY && authed.acc.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
      if (key === OFFICE_FILES_KEY && authed.acc.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
      const { value } = await readBody(req);
      let parsed; try { parsed = JSON.parse(value); } catch (e) { parsed = value; }
      await storeSet(key, parsed);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'server_error' });
  }
});

initStorage().then(() => {
  server.listen(PORT, () => {
    console.log(`✅ سرور اسپرلوس روی پورت ${PORT} اجرا شد (حالت: ${BACKEND})`);
    console.log(`   در همین سیستم: http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('❌ اتصال به دیتابیس برقرار نشد:', err.message);
  process.exit(1);
});

