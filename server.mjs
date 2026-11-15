import { createServer } from 'node:http';
import { randomBytes, scryptSync, createHash, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withDatabase, structure, relations, tableData, columns, identifier } from './database.mjs';

process.umask(0o077);
const dataDir = process.env.DATA_DIR || './data';
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const token = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const database = new DatabaseSync(join(dataDir, 'claydb.sqlite'));
database.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, admin INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, engine TEXT NOT NULL, secret TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS permissions (
    user_id INTEGER REFERENCES users ON DELETE CASCADE,
    connection_id INTEGER REFERENCES connections ON DELETE CASCADE,
    level TEXT NOT NULL CHECK(level IN ('view','edit','sql')),
    PRIMARY KEY(user_id, connection_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY, user_id INTEGER REFERENCES users ON DELETE CASCADE, expires INTEGER NOT NULL
  );
`);

const keyPath = join(dataDir, 'vault.key');
if (!database.prepare('SELECT 1 FROM connections LIMIT 1').get()) {
  try { writeFileSync(keyPath, randomBytes(32), { flag:'wx', mode:0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
const key = readFileSync(keyPath);
if (key.length !== 32) throw new Error('Invalid vault key length');
const protect = value => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
};
const reveal = value => {
  const raw = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0,12));
  cipher.setAuthTag(raw.subarray(12,28));
  return JSON.parse(Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]));
};
const passwordHash = (password, salt = token()) =>
  salt + ':' + scryptSync(password, salt, 64, { N:32768, r:8, p:1, maxmem:64*1024*1024 }).toString('hex');
const fakeHash = passwordHash(token());
const samePassword = (candidate, hash) => timingSafeEqual(Buffer.from(hash), Buffer.from(passwordHash(candidate, hash.split(':')[0])));
const userName = value => typeof value === 'string' && /^[a-z0-9_.-]{3,48}$/i.test(value);
const passwordValid = value => typeof value === 'string' && value.length >= 12 && value.length <= 256;
const bootstrap = join(dataDir, 'initial-admin.txt');
const operation = process.argv[2];
const reset = operation === 'reset-admin';
const basicSetting = database.prepare("SELECT value FROM settings WHERE name='basic_auth'");
const saveSetting = database.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value');
if (operation === 'reset-basic' || !basicSetting.get()) {
  database.exec('BEGIN IMMEDIATE');
  try {
    if (operation === 'reset-basic' || !basicSetting.get()) {
      const secret = token();
      saveSetting.run('basic_auth',digest(secret));
      saveSetting.run('basic_recovery',protect(secret));
    }
    database.exec('COMMIT');
  } catch (error) {database.exec('ROLLBACK');throw error;}
}
if (operation === 'reset-basic') process.exit(0);
if (operation === 'show-access') {
  const entry = database.prepare("SELECT value FROM settings WHERE name='basic_recovery'").get();
  console.log('HTTP Basic Auth\nЛогин: gateway\nПароль: '+reveal(entry.value));
  console.log('\nВход в панель\nЛогин: admin');
  try {
    const password = readFileSync(bootstrap,'utf8').trim();
    console.log('Пароль: '+password);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('Используйте заданный ранее пароль администратора.');
  }
  process.exit(0);
}

function authorized(header) {
  const encoded = /^Basic ([A-Za-z0-9+/=]{1,128})$/i.exec(header || '')?.[1];
  if (!encoded) return false;
  const credentials = Buffer.from(encoded,'base64').toString('utf8');
  const secret = /^gateway:([A-Za-z0-9_-]{43})$/.exec(credentials)?.[1];
  if (!secret) return false;
  return timingSafeEqual(Buffer.from(digest(secret),'hex'),Buffer.from(basicSetting.get().value,'hex'));
}
if (reset || !database.prepare('SELECT 1 FROM users WHERE admin=1').get()) {
  const password = token();
  const hash = passwordHash(password);
  database.exec('BEGIN IMMEDIATE');
  try {
    const existing = database.prepare('SELECT id FROM users WHERE admin=1').get();
    if (reset || !existing) {
      writeFileSync(bootstrap, password + '\n', { mode:0o600 });
      if (existing) {
        database.prepare('UPDATE users SET hash=? WHERE id=?').run(hash, existing.id);
        database.prepare('DELETE FROM sessions WHERE user_id=?').run(existing.id);
      } else database.prepare("INSERT INTO users(name,hash,admin) VALUES ('admin',?,1)").run(hash);
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  console.log('Пароль администратора записан в ' + bootstrap);
}
if (reset) process.exit(0);

const secure = process.env.COOKIE_SECURE === '1';
const sessionDuration = 8 * 60 * 60 * 1000;
const rates = new Map();
const paths = {
  '/': ['index.html','text/html; charset=utf-8'],
  '/style.css': ['style.css','text/css; charset=utf-8'],
  '/app.js': ['app.js','text/javascript; charset=utf-8'],
  '/fonts/inter-latin-wght-normal.woff2': ['fonts/inter-latin-wght-normal.woff2','font/woff2'],
  '/fonts/inter-cyrillic-wght-normal.woff2': ['fonts/inter-cyrillic-wght-normal.woff2','font/woff2'],
};
class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireValue(condition, message = 'Проверьте заполнение полей', status = 400) {
  if (!condition) throw new RequestError(status, message);
}
function cookie(value, age) {
  return `claydb_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}` + (secure ? '; Secure' : '');
}
async function body(req) {
  requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', 'Ожидается JSON', 415);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    requireValue(bytes <= 131072, 'Запрос слишком большой', 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks)); } catch { throw new RequestError(400, 'Некорректный JSON'); }
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  return value;
}
function loginLimit(req) {
  const now = Date.now();
  for (const [key, entry] of rates) if (entry.until < now) rates.delete(key);
  const index = req.socket.remoteAddress || 'local';
  const ip = rates.get(index) || { count:0, until:now+60000 };
  requireValue(ip.count < 20, 'Повторите попытку через минуту', 429);
  ip.count++;
  rates.set(index, ip);
}
function configuration(input, previous) {
  const {name, engine, host, port, user, database, tls, ca = ''} = input;
  const password = typeof input.password === 'string' ? input.password : previous?.password;
  requireValue(['postgres','mysql','mariadb'].includes(engine) && typeof tls === 'boolean');
  requireValue([name,host,user,database].every(value => typeof value === 'string' && value.trim() && value.length <= 255));
  requireValue(!/[\s/\\\x00]/.test(host) && Number.isInteger(port) && port > 0 && port <= 65535);
  requireValue(typeof password === 'string' && password.length <= 4096 && typeof ca === 'string' && ca.length <= 32768);
  return {name:name.trim(), engine, host, port, user, database, password, tls, ca};
}
function access(user, id) {
  const record = user.admin
    ? database.prepare("SELECT *, 'admin' AS level FROM connections WHERE id=?").get(id)
    : database.prepare('SELECT c.*, p.level FROM connections c JOIN permissions p ON p.connection_id=c.id WHERE c.id=? AND p.user_id=?').get(id,user.id);
  requireValue(record, 'Подключение недоступно', 404);
  return record;
}
const publicProfile = ({password, ca, ...rest}) => ({...rest, customCa:Boolean(ca)});
const limitText = value => {
  if (Buffer.isBuffer(value)) return '[бинарные данные: ' + value.length + ' байт]';
  if (typeof value === 'string' && value.length > 4096) return value.slice(0,4096) + '…';
  if (value && typeof value === 'object' && !(value instanceof Date)) return limitText(JSON.stringify(value));
  return value;
};
let active = 0;
async function remote(profile, fn) {
  requireValue(active < 12, 'Слишком много одновременных запросов', 503);
  active++;
  try { return await withDatabase(profile, fn); }
  catch (error) {
    if (error instanceof RequestError) throw error;
    const messages = {
      ECONNREFUSED:'Подключение отклонено. Проверьте хост и порт БД',
      ENOTFOUND:'Хост БД не найден',
      ETIMEDOUT:'Сервер БД не ответил вовремя',
      QUERY_TIMEOUT:'Истекло время ожидания запроса',
      PROTOCOL_SEQUENCE_TIMEOUT:'Истекло время ожидания запроса',
      ER_ACCESS_DENIED_ERROR:'База отклонила вход. Проверьте пользователя и пароль',
      '28P01':'База отклонила вход. Проверьте пользователя и пароль',
      ER_BAD_DB_ERROR:'Указанная база данных не найдена',
      '3D000':'Указанная база данных не найдена',
      SELF_SIGNED_CERT_IN_CHAIN:'Сертификат БД не доверен. Проверьте PEM-сертификат CA',
      ERR_TLS_CERT_ALTNAME_INVALID:'Имя хоста не совпадает с сертификатом БД',
    };
    const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,60}$/.test(error.code) ? ' ('+error.code+')' : '';
    const message = Object.hasOwn(messages,error.code) ? messages[error.code] : 'Сервер БД не выполнил запрос';
    throw new RequestError(502, message + code);
  } finally { active--; }
}
function rowResult(result, max = 200) {
  return {...result, truncated:result.rows.length > max, rows:result.rows.slice(0,max).map(row => row.map(limitText))};
}
async function changeRow(db, schema, table, input) {
  const fields = await columns(db,schema,table);
  requireValue(fields.length, 'Таблица недоступна', 404);
  const tableType = await db.query(
    db.pg ? 'SELECT table_type FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2'
      : 'SELECT table_type FROM information_schema.tables WHERE table_schema=? AND table_name=?', [schema,table]);
  requireValue(tableType.rows[0]?.[0] === 'BASE TABLE','Операции со строками доступны для обычных таблиц',403);
  const keys = fields.filter(field => field[3]).map(field => field[0]);
  const names = fields.map(field => field[0]);
  const op = input.action;
  requireValue(['insert','update','delete'].includes(op));
  const quote = value => identifier(db.pg,value);
  const target = quote(schema) + '.' + quote(table);
  const args = [];
  const bind = value => {
    requireValue(value === null || ['string','number','boolean'].includes(typeof value));
    args.push(value);
    return db.pg ? '$'+args.length : '?';
  };
  const values = input.values ?? {};
  requireValue(typeof values === 'object' && !Array.isArray(values));
  const entries = Object.entries(values);
  requireValue(op === 'delete' || (op === 'insert' || entries.length) && entries.every(([name]) => names.includes(name)));
  let sql;
  if (op === 'insert') {
    sql = entries.length ? `INSERT INTO ${target} (${entries.map(([name])=>quote(name)).join(', ')}) VALUES (${entries.map(([,value])=>bind(value)).join(', ')})` : 'INSERT INTO '+target+(db.pg?' DEFAULT VALUES':' () VALUES ()');
  } else {
    requireValue(keys.length && keys.every(name => Object.hasOwn(input.key ?? {},name) && input.key[name] != null), 'Нужен полный первичный ключ');
    const start = op === 'delete' ? 'DELETE FROM '+target :
      'UPDATE '+target+' SET '+entries.map(([name,value])=>quote(name)+'='+bind(value)).join(', ');
    sql = start + ' WHERE ' + keys.map(name=>quote(name)+'='+bind(input.key[name])).join(' AND ');
  }
  return {affected:(await db.query(sql,args)).affected};
}
function cell(value) {
  let text = value == null ? '' : String(value);
  if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"','""') + '"';
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const [, resource, id, action] = parts;
  const method = req.method;
  if (method !== 'GET') {
    const site = req.headers['sec-fetch-site'];
    requireValue(!site || site === 'same-origin' || site === 'none', 'Запрос с другого сайта', 403);
    requireValue(req.headers['x-abdbadmin'] === '1', 'Недопустимый запрос', 403);
  }
  if (resource === 'login' && method === 'POST') {
    const {name,password} = await body(req);
    loginLimit(req);
    requireValue(userName(name) && typeof password === 'string' && password.length <= 256,'Неверный логин или пароль',401);
    const record = database.prepare('SELECT * FROM users WHERE name=?').get(name);
    requireValue(samePassword(password,record?.hash || fakeHash) && record,'Неверный логин или пароль',401);
    const session = token();
    database.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    database.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(session),record.id,Date.now()+sessionDuration);
    res.setHeader('Set-Cookie',cookie(session,sessionDuration/1000));
    return {name:record.name,admin:record.admin};
  }

  const session = /(?:^|;\s*)claydb_session=([\w-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const user = session && database.prepare('SELECT u.id,u.name,u.admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?').get(digest(session),Date.now());
  requireValue(user,'Войдите в панель',401);
  if (resource === 'session' && method === 'GET') return user;
  if (resource === 'logout' && method === 'POST') {
    database.prepare('DELETE FROM sessions WHERE hash=?').run(digest(session));
    res.setHeader('Set-Cookie',cookie('',0));
    return {};
  }
  if (resource === 'password' && method === 'POST') {
    const input = await body(req);
    const record = database.prepare('SELECT hash FROM users WHERE id=?').get(user.id);
    requireValue(typeof input.current === 'string' && input.current.length <= 256 && samePassword(input.current,record.hash),'Текущий пароль неверен',403);
    requireValue(passwordValid(input.password),'От 12 до 256 символов');
    database.prepare('UPDATE users SET hash=? WHERE id=?').run(passwordHash(input.password),user.id);
    database.prepare('DELETE FROM sessions WHERE user_id=? AND hash<>?').run(user.id,digest(session));
    if (user.admin) {
      const { unlinkSync } = await import('node:fs');
      try { unlinkSync(bootstrap); } catch (error) { if (error.code !== 'ENOENT') console.error('Unable to remove bootstrap file'); }
    }
    return {};
  }
  if (resource === 'users') {
    requireValue(user.admin,'Требуются права администратора',403);
    if (!id && method === 'GET') return database.prepare('SELECT id,name,admin FROM users ORDER BY name').all();
    if (!id && method === 'POST') {
      const {name,password} = await body(req);
      requireValue(userName(name) && passwordValid(password),'Логин: 3–48 латинских символов, пароль: 12–256 символов');
      requireValue(!database.prepare('SELECT id FROM users WHERE name=?').get(name),'Логин уже занят',409);
      database.prepare('INSERT INTO users(name,hash,admin) VALUES (?,?,0)').run(name,passwordHash(password));
      return {};
    }
    const target = database.prepare('SELECT * FROM users WHERE id=? AND admin=0').get(id);
    requireValue(target,'Пользователь недоступен',404);
    if (method === 'GET' && action === 'permissions') {
      return database.prepare('SELECT connection_id,level FROM permissions WHERE user_id=?').all(id);
    }
    if (method === 'PUT' && action === 'permissions') {
      const {connection,level} = await body(req);
      requireValue(Number.isSafeInteger(connection) && [null,'view','edit','sql'].includes(level));
      requireValue(database.prepare('SELECT 1 FROM connections WHERE id=?').get(connection),'Подключение недоступно',404);
      if (level) database.prepare('INSERT INTO permissions VALUES (?,?,?) ON CONFLICT(user_id,connection_id) DO UPDATE SET level=excluded.level').run(id,connection,level);
      else database.prepare('DELETE FROM permissions WHERE user_id=? AND connection_id=?').run(id,connection);
      return {};
    }
    if (method === 'DELETE' && !action) {
      database.prepare('DELETE FROM users WHERE id=? AND admin=0').run(id);
      return {};
    }
  }
  if (resource === 'connections') {
    if (!id && method === 'GET') {
      return user.admin ? database.prepare("SELECT id,name,engine,'admin' AS level FROM connections ORDER BY name").all()
        : database.prepare('SELECT c.id,c.name,c.engine,p.level FROM connections c JOIN permissions p ON p.connection_id=c.id WHERE p.user_id=? ORDER BY c.name').all(user.id);
    }
    if (!id && method === 'POST') {
      requireValue(user.admin,'Требуются права администратора',403);
      const profile = configuration(await body(req));
      await remote(profile,db=>db.query('SELECT 1'));
      const {lastInsertRowid} = database.prepare('INSERT INTO connections(name,engine,secret) VALUES (?,?,?)').run(profile.name,profile.engine,protect(profile));
      return {id:lastInsertRowid};
    }
    if (id) {
      const record = access(user,id);
      if (action === 'settings') {
        requireValue(user.admin,'Требуются права администратора',403);
        if (method === 'GET') return publicProfile(reveal(record.secret));
        if (method === 'PUT') {
          const previous = reveal(record.secret);
          const input = await body(req);
          const profile = configuration({...input,ca:input.ca ?? previous.ca},previous);
          await remote(profile,db=>db.query('SELECT 1'));
          const result = database.prepare('UPDATE connections SET name=?,engine=?,secret=? WHERE id=? AND secret=?').run(profile.name,profile.engine,protect(profile),id,record.secret);
          requireValue(result.changes,'Подключение было изменено. Откройте настройки снова.',409);
          return {};
        }
      }
      if (!action && method === 'DELETE') {
        requireValue(user.admin,'Требуются права администратора',403);
        database.prepare('DELETE FROM connections WHERE id=?').run(id);
        return {};
      }
      const profile = reveal(record.secret);
      if (action === 'schema' && method === 'GET') {
        return remote(profile,async db=>({tables:await structure(db),relations:await relations(db)}));
      }
      if (action === 'sql' && method === 'POST') {
        requireValue(['sql','admin'].includes(record.level),'Нет доступа к SQL',403);
        const {sql} = await body(req);
        requireValue(typeof sql === 'string' && sql.trim() && sql.length <= 65000,'Введите SQL-запрос');
        return remote(profile,async db=>rowResult(await db.query(sql,[],201)));
      }
      if (['rows','csv'].includes(action)) {
        const schema = url.searchParams.get('schema');
        const table = url.searchParams.get('table');
        requireValue(schema && table && schema.length <= 255 && table.length <= 255);
        if (method === 'GET') {
          const offset = Number(url.searchParams.get('offset') || 0);
          requireValue(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000000);
          const result = await remote(profile, db=>tableData(db,schema,table,offset,action==='csv'?501:51));
          requireValue(result,'Таблица недоступна',404);
          if (action === 'csv') {
            const page = rowResult(result,500);
            res.setHeader('Content-Type','text/csv; charset=utf-8');
            res.setHeader('Content-Disposition','attachment; filename="abdbadmin-export.csv"');
            res.end('\uFEFF' + [page.columns,...page.rows].map(row=>row.map(cell).join(',')).join('\r\n') + '\r\n');
            return;
          }
          const page = rowResult(result,50);
          for (const row of result.rows) {
            for (const [index,value] of row.entries()) {
              if (result.definition[index]?.[3] && (typeof value === 'string' && value.length > 4096 || typeof value === 'number' && !Number.isFinite(value) || Buffer.isBuffer(value) || (value && typeof value === 'object'))) {
                page.unsafeKey = true;
              }
            }
          }
          return page;
        }
        if (method === 'POST' && action === 'rows') {
          requireValue(record.level !== 'view','Нет права изменять строки',403);
          const input = await body(req);
          return remote(profile,db=>changeRow(db,schema,table,input));
        }
      }
    }
  }
  throw new RequestError(404,'Страница не найдена');
}

createServer(async (req,res) => {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Cache-Control','no-store');
  try {
    const url = new URL(req.url,'http://localhost');
    if (url.pathname === '/healthz' && req.method === 'GET') {res.end('ok'); return;}
    if (!authorized(req.headers.authorization)) {
      res.setHeader('WWW-Authenticate','Basic realm="AbDbAdmin", charset="UTF-8"');
      res.statusCode=401;
      res.setHeader('Content-Type','text/plain; charset=utf-8');
      res.end('Требуется вход через HTTP Basic Auth');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const result = await api(req,res,url);
      if (res.writableEnded) return;
      res.setHeader('Content-Type','application/json; charset=utf-8');
      res.end(JSON.stringify(result));
      return;
    }
    const asset = Object.hasOwn(paths,url.pathname) && paths[url.pathname];
    requireValue(asset && req.method === 'GET','Страница не найдена',404);
    res.setHeader('Content-Type',asset[1]);
    res.end(readFileSync(new URL('./public/'+asset[0],import.meta.url)));
  } catch (error) {
    if (res.writableEnded || res.destroyed) return;
    res.statusCode = error instanceof RequestError ? error.status : 500;
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.removeHeader('Content-Disposition');
    if (res.statusCode === 500) console.error('Application error',error.code || error.name);
    res.end(JSON.stringify({error:res.statusCode === 500 ? 'Внутренняя ошибка' : error.message}));
  }
}).listen(Number(process.env.PORT || 8099),process.env.BIND_HOST || '127.0.0.1',function () { console.log('AbDbAdmin запущен: '+this.address().port); });
