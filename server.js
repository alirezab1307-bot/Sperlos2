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
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSIONS_KEY = '__sessions__';
const ACCOUNTS_KEY = 'sl_accounts_v1';
const OFFICE_CUSTOMERS_KEY = 'sl_office_customers_v1'; // فقط مدیر اجازه‌ی نوشتن دارد

/* ---------------------------------------------------------------
   لایه ذخیره‌سازی (Store) — یک رابط ساده get/set که پشت آن یا
   فایل روی دیسک است یا MongoDB. بقیه‌ی کد اصلاً نمی‌داند کدام است.
   --------------------------------------------------------------- */
let BACKEND = 'file';
let cache = {}; // آینه‌ی حافظه‌ای از همه‌ی کلیدها، برای خواندن سریع بدون رفت‌وبرگشت به دیتابیس

// --- حالت فایل ---
function fileLoadAll() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { return {}; }
}
function fileSaveAll() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DATA_FILE); // نوشتن اتمیک تا در صورت قطعی برق دیتا خراب نشود
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
  else fileSaveAll();
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
    console.log(`ℹ️  حالت فایل فعال است — داده‌ها در ${DATA_FILE} ذخیره می‌شوند`);
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
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 25 * 1024 * 1024) { // سقف ۲۵ مگابایت برای هر درخواست (به‌خاطر عکس قراردادها)
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
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
    return sendJson(res, 200, { ok: true, backend: BACKEND, smsConfigured: SMS_CONFIGURED });
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

    /* ---------- تست ارسال پیامک (فقط مدیر) ---------- */
    if (pathname === '/api/sms/test' && req.method === 'POST') {
      if (authed.acc.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
      const { phone, message } = await readBody(req);
      if (!phone || !message) return sendJson(res, 400, { error: 'invalid_input' });
      const result = await sendSms(phone, message);
      return sendJson(res, 200, result);
    }

    /* ---------- ذخیره‌سازی مشترک key-value (فایل‌ها، مشتریان، قراردادها، تنظیمات و ...) ---------- */
    if (pathname.startsWith('/api/storage/') && req.method === 'GET') {
      const key = decodeURIComponent(pathname.slice('/api/storage/'.length));
      const value = await storeGet(key);
      return sendJson(res, 200, { value: value === undefined ? null : JSON.stringify(value) });
    }
    if (pathname.startsWith('/api/storage/') && req.method === 'PUT') {
      const key = decodeURIComponent(pathname.slice('/api/storage/'.length));
      if (key === ACCOUNTS_KEY || key === SESSIONS_KEY) return sendJson(res, 403, { error: 'forbidden_key' });
      if (key === OFFICE_CUSTOMERS_KEY && authed.acc.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
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

/* =================================================================
   پیامک خودکار (کاوه‌نگار) — یادآوری پایان قرارداد رهن‌واجاره و
   پیگیری بانک فرصت‌های آینده. با متغیرهای محیطی زیر پیکربندی می‌شود:
     KAVENEGAR_API_KEY   (اجباری برای فعال شدن ارسال واقعی)
     KAVENEGAR_SENDER    (اختیاری؛ اگر ندهید، خط پیش‌فرض حساب کاوه‌نگار استفاده می‌شود)
   اگر KAVENEGAR_API_KEY تنظیم نشده باشد، سرور بالا می‌آید ولی به‌جای
   ارسال واقعی فقط در لاگ می‌نویسد (تا هیچ خطایی کاربر را متوقف نکند).
   ================================================================= */
const SMS_API_KEY = process.env.KAVENEGAR_API_KEY || '';
const SMS_SENDER = process.env.KAVENEGAR_SENDER || '';
const SMS_CONFIGURED = !!SMS_API_KEY;

function normalizeIranPhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[^\d+]/g, '');
  if (p.startsWith('+98')) p = '0' + p.slice(3);
  else if (p.startsWith('98') && p.length === 12) p = '0' + p.slice(2);
  if (!/^09\d{9}$/.test(p)) return null; // فقط شماره موبایل معتبر ایران
  return p;
}

async function sendSms(toRaw, message) {
  const to = normalizeIranPhone(toRaw);
  if (!to) { console.log('⚠️ شماره نامعتبر برای پیامک، رد شد:', toRaw); return { ok: false, error: 'invalid_phone' }; }
  if (!SMS_CONFIGURED) {
    console.log(`ℹ️ (شبیه‌سازی — کاوه‌نگار پیکربندی نشده) پیامک به ${to}:\n${message}`);
    return { ok: false, error: 'not_configured' };
  }
  try {
    const params = new URLSearchParams({ receptor: to, message });
    if (SMS_SENDER) params.set('sender', SMS_SENDER);
    const url = `https://api.kavenegar.com/v1/${SMS_API_KEY}/sms/send.json?${params.toString()}`;
    const r = await fetch(url);
    const body = await r.json().catch(() => null);
    if (!r.ok || !body || body.return?.status !== 200) {
      console.error('❌ خطای ارسال پیامک کاوه‌نگار:', to, body || r.status);
      return { ok: false, error: 'provider_error', body };
    }
    console.log('✅ پیامک ارسال شد به', to);
    return { ok: true, body };
  } catch (err) {
    console.error('❌ خطای شبکه هنگام ارسال پیامک:', err.message);
    return { ok: false, error: 'network_error' };
  }
}

function fillTemplate(tpl, vars) {
  let out = String(tpl || '');
  Object.keys(vars).forEach(k => { out = out.split('{' + k + '}').join(vars[k] == null ? '' : String(vars[k])); });
  return out;
}
function faDateSimple(iso) {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleDateString('fa-IR'); } catch (e) { return iso; }
}
function daysUntil(iso) {
  if (!iso) return Infinity;
  const d = new Date(iso); d.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / (1000 * 60 * 60 * 24));
}

async function processRentContractsSms() {
  const key = 'sl_contracts_rent';
  const list = (await storeGet(key)) || [];
  let changed = false;
  for (const c of list) {
    if (!c.smsEnabled || c.smsSent || !c.endDate) continue;
    const threshold = c.renewalAlarmDays !== undefined && c.renewalAlarmDays !== '' ? Number(c.renewalAlarmDays) : 30;
    const left = daysUntil(c.endDate);
    if (left <= threshold) {
      const vars = { نام_مالک: c.ownerName || '', نام_مستاجر: c.tenantName || '', آدرس: c.address || '', تاریخ_پایان: faDateSimple(c.endDate), رهن: c.rahnPrice || '', اجاره: c.ejarePrice || '' };
      const msg = fillTemplate(c.smsMessage || 'یادآوری اسپرلوس: قرارداد اجاره ملک شما به آدرس {آدرس} در تاریخ {تاریخ_پایان} به پایان می‌رسد.', vars);
      const results = [];
      if (c.ownerPhone) results.push(await sendSms(c.ownerPhone, msg));
      if (c.tenantPhone) results.push(await sendSms(c.tenantPhone, msg));
      c.smsSent = true;
      c.smsSentAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) await storeSet(key, list);
}

async function processOpportunitiesSms() {
  const key = 'sl_opportunities';
  const list = (await storeGet(key)) || [];
  let changed = false;
  for (const o of list) {
    if (!o.smsEnabled || o.smsSent || !o.nextFollowupDate) continue;
    if (daysUntil(o.nextFollowupDate) <= 0) {
      const vars = { نام_مالک: o.ownerName || '', آدرس: o.address || '', تاریخ_پیگیری: faDateSimple(o.nextFollowupDate) };
      const msg = fillTemplate(o.smsMessage || 'یادآوری اسپرلوس: پیگیری ملک شما به آدرس {آدرس} در تاریخ {تاریخ_پیگیری}.', vars);
      if (o.ownerPhone) await sendSms(o.ownerPhone, msg);
      o.smsSent = true;
      o.smsSentAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) await storeSet(key, list);
}

async function runSmsScheduler() {
  try { await processRentContractsSms(); } catch (e) { console.error('خطا در پردازش پیامک قراردادها:', e.message); }
  try { await processOpportunitiesSms(); } catch (e) { console.error('خطا در پردازش پیامک فرصت‌های آینده:', e.message); }
}

initStorage().then(() => {
  server.listen(PORT, () => {
    console.log(`✅ سرور اسپرلوس روی پورت ${PORT} اجرا شد (حالت: ${BACKEND})`);
    console.log(`   در همین سیستم: http://localhost:${PORT}`);
    console.log(SMS_CONFIGURED ? '✅ پیامک کاوه‌نگار پیکربندی شده' : 'ℹ️  پیامک پیکربندی نشده (KAVENEGAR_API_KEY تنظیم نیست) — فقط در لاگ شبیه‌سازی می‌شود');
    setTimeout(runSmsScheduler, 10000); // ۱۰ ثانیه بعد از بالا آمدن، اولین بررسی
    setInterval(runSmsScheduler, 5 * 60 * 1000); // هر ۵ دقیقه یک‌بار بررسی پیامک‌های موعدرسیده
  });
}).catch((err) => {
  console.error('❌ اتصال به دیتابیس برقرار نشد:', err.message);
  process.exit(1);
});

