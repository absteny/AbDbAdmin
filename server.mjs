import { isIP } from 'node:net';
import { createServer } from 'node:http';
import { randomBytes, scryptSync, createHash, createHmac, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { translate } from './public/i18n.js';
import { parseCsv, importCsv, searchDatabase, databaseObjects, exportTableSql, exportDatabaseTables, serverOverview, objectDefinition, databasePrivileges, databaseAccountInput, databaseAccounts, applyDatabaseAccount, objectCommand } from './native-tools.mjs';
import { schemaStatement, tableDefinition, columnTypes, tableEngines, postgresColumnTypes, postgresTableDefinition, postgresColumnStatement } from './schema-editor.mjs';
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
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
    actor TEXT, action TEXT NOT NULL, connection_id INTEGER, subject_id INTEGER,
    status INTEGER NOT NULL
  );
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
  CREATE TABLE IF NOT EXISTS saved_views (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users ON DELETE CASCADE,
    connection_id INTEGER NOT NULL REFERENCES connections ON DELETE CASCADE,
    schema_name TEXT NOT NULL, table_name TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL,
    UNIQUE(user_id,connection_id,schema_name,table_name,name)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY, user_id INTEGER REFERENCES users ON DELETE CASCADE, expires INTEGER NOT NULL
  );
`);

const writeAudit = database.prepare('INSERT INTO audit(created_at,actor,action,connection_id,subject_id,status) VALUES (?,?,?,?,?,?)');
const trimAudit = database.prepare('DELETE FROM audit WHERE id <= ?');
function recordAudit(ctx,status) {
  const {lastInsertRowid} = writeAudit.run(Date.now(),ctx.actor ?? null,ctx.action,ctx.connection ?? null,ctx.subject ?? null,status);
  const id=Number(lastInsertRowid);
  if (id%100===0) trimAudit.run(id-10000);
}
function audit(ctx,status) {
  if (!ctx.action) return;
  try {
    recordAudit(ctx,status);
  } catch (error) {
    console.error('Audit write failed',error.code || error.name);
  }
}

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
const localOnly = process.env.ABDB_LOCAL_ONLY === '1';
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
if (operation === 'reset-basic') {
  audit({actor:'local-cli',action:'gateway.reset'},200);
  process.exit(0);
}
if (operation === 'show-access') {
  if (!localOnly) {
    const entry = database.prepare("SELECT value FROM settings WHERE name='basic_recovery'").get();
    console.log('HTTP Basic Auth\nUsername: gateway\nPassword: '+reveal(entry.value));
  }
  console.log('\nPanel sign-in\nUsername: admin');
  try {
    const password = readFileSync(bootstrap,'utf8').trim();
    console.log('Password: '+password);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('Use your current administrator password.');
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
  console.log('Administrator password saved to ' + bootstrap);
}
if (reset) {
  audit({actor:'local-cli',action:'admin.reset'},200);
  process.exit(0);
}

const secure = process.env.COOKIE_SECURE === '1';
function advancedUrl(user) {
  const port=Number(process.env.ABDB_ADVANCED_PORT || 8100);
  return user.admin && localOnly && process.env.ABDB_ADVANCED_ENABLED==='1' &&
    Number.isInteger(port) && port>0 && port<=65535 ? 'http://127.0.0.1:'+port : null;
}
function safeId(id) {
  return /^\d+$/.test(id ?? '') && Number.isSafeInteger(Number(id)) ? Number(id) : null;
}
const sessionDuration = 8 * 60 * 60 * 1000;
const rates = new Map();
const paths = {
  '/': ['index.html','text/html; charset=utf-8'],
  '/style.css': ['style.css','text/css; charset=utf-8'],
  '/i18n.js': ['i18n.js','text/javascript; charset=utf-8'],
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
async function body(req,maxBytes=131072) {
  requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', 'Ожидается JSON', 415);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    requireValue(bytes <= maxBytes, 'Запрос слишком большой', 413);
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
  return {name:name.trim(), engine, host, port, user, database, password, tls, ca, production:input.production===undefined ? Boolean(previous?.production) : input.production===true};
}
function access(user, id) {
  const record = user.admin
    ? database.prepare("SELECT *, 'admin' AS level FROM connections WHERE id=? AND engine<>'demo'").get(id)
    : database.prepare('SELECT c.*, p.level FROM connections c JOIN permissions p ON p.connection_id=c.id WHERE c.id=? AND p.user_id=? AND c.engine<>?').get(id,user.id,'demo');
  requireValue(record, 'Подключение недоступно', 404);
  return record;
}
const publicProfile = ({password, ca, ...rest}) => ({...rest, customCa:Boolean(ca)});
const limitText = value => {
  if (Buffer.isBuffer(value)) return '[binary: ' + value.length + ' bytes]';
  if (typeof value === 'string' && value.length > 4096) return value.slice(0,4096) + '…';
  if (value && typeof value === 'object' && !(value instanceof Date)) return limitText(JSON.stringify(value));
  return value;
};
let active = 0;
const sourceIp = isIP(process.env.ABDB_DB_SOURCE_IP || '') ? process.env.ABDB_DB_SOURCE_IP : null;
function databasePeer(value) {
  return typeof value==='string' && value.length<=253 && (isIP(value) || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value)) ? value : null;
}
async function testConnection(profile) {
  return remote(profile,async db=>{
    const {rows}=await db.query(db.pg ? 'SELECT host(inet_client_addr())' : "SELECT SUBSTRING_INDEX(USER(), '@', -1)");
    return {peer:databasePeer(rows[0]?.[0])};
  },true);
}
async function remote(profile, fn, diagnosing=false, options) {
  requireValue(active < 12, 'Слишком много одновременных запросов', 503);
  active++;
  try { return await withDatabase(profile, fn, options); }
  catch (error) {
    if (error instanceof RequestError) throw error;
    const messages = {
      ECONNREFUSED:'Подключение отклонено. Проверьте хост и порт БД',
      ENOTFOUND:'Хост БД не найден',
      ETIMEDOUT:'Сервер БД не ответил вовремя',
      EXPORT_TOO_LARGE:'Таблица превышает лимит экспорта SQL',
      QUERY_TIMEOUT:'Истекло время ожидания запроса',
      PROTOCOL_SEQUENCE_TIMEOUT:'Истекло время ожидания запроса',
      ER_ACCESS_DENIED_ERROR:'MySQL или MariaDB отклонила вход. Проверьте пароль и разрешённый хост учётной записи на сервере БД.',
      ER_HOST_NOT_PRIVILEGED:'Сервер БД не разрешает подключения с этого хоста.',
      ER_DBACCESS_DENIED_ERROR:'Учётной записи не выдан доступ к выбранной базе данных.',
      '42501':'У учётной записи недостаточно прав для этой операции.',
      EHOSTUNREACH:'Хост БД недоступен. Проверьте сеть, VPN и правила доступа.',
      EAI_AGAIN:'Не удалось разрешить имя хоста БД. Проверьте DNS и повторите попытку.',
      CERT_HAS_EXPIRED:'Срок действия TLS-сертификата БД истёк.',
      DEPTH_ZERO_SELF_SIGNED_CERT:'Сертификат БД не доверен. Проверьте PEM-сертификат CA',
      '28P01':'База отклонила вход. Проверьте пользователя и пароль',
      ER_BAD_DB_ERROR:'Указанная база данных не найдена',
      '3D000':'Указанная база данных не найдена',
      SELF_SIGNED_CERT_IN_CHAIN:'Сертификат БД не доверен. Проверьте PEM-сертификат CA',
      ERR_TLS_CERT_ALTNAME_INVALID:'Имя хоста не совпадает с сертификатом БД',
    };
    const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,60}$/.test(error.code) ? ' ('+error.code+')' : '';
    const message = Object.hasOwn(messages,error.code) ? messages[error.code] : 'Сервер БД не выполнил запрос';
    const failure=new RequestError(502,message+code);
    if (diagnosing && ['ER_ACCESS_DENIED_ERROR','ER_HOST_NOT_PRIVILEGED'].includes(error.code)) {
      const reported=error.sqlMessage || error.message;
      const match=typeof reported==='string' && (/@'([^'\r\n]+)' \(using password: (?:YES|NO)\)$/i.exec(reported) ||
        /^Host '([^'\r\n]+)' is not allowed to connect/i.exec(reported));
      failure.peer=databasePeer(match?.[1]);
    }
    throw failure;
  } finally { active--; }
}
function rowResult(result, max = 200) {
  return {...result, truncated:result.rows.length > max, rows:result.rows.slice(0,max).map(row => row.map(limitText))};
}
function tableView(input) {
  const validColumn = value => typeof value==='string' && value.length>0 && value.length<=255;
  const filters = input?.filters;
  const sort = input?.sort ?? null;
  requireValue(Array.isArray(filters) && filters.length<=8 && filters.every(filter=>
    validColumn(filter?.column) && ['eq','contains','null','not-null'].includes(filter.operator) &&
    (['null','not-null'].includes(filter.operator) || typeof filter.value==='string' && filter.value.length<=512)));
  requireValue(sort===null || validColumn(sort.column) && ['asc','desc'].includes(sort.direction));
  return {filters:filters.map(({column,operator,value})=>({column,operator,value:['null','not-null'].includes(operator)?'':value})),sort:sort===null?null:{column:sort.column,direction:sort.direction}};
}
function readView(url) {
  const raw = url.searchParams.get('filter');
  if (raw===null) return {filters:[],sort:null};
  let input;
  try {input=JSON.parse(raw);} catch {throw new RequestError(400,'Некорректный JSON');}
  return tableView(input);
}

function rowToken(record,schema,table,row) {
  return createHmac('sha256',key).update(JSON.stringify([record.id,record.secret,schema,table,row])).digest('hex');
}
async function changeRow(db, schema, table, input, record) {
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
  if (op==='insert' || input.snapshot===undefined) return {affected:(await db.query(sql,args)).affected};
  requireValue(typeof input.snapshot==='string' && /^[a-f0-9]{64}$/.test(input.snapshot));
  const condition=keys.map((name,index)=>quote(name)+'='+(db.pg?'$'+(index+1):'?')).join(' AND ');
  return db.transaction(async ()=>{
    const current=await db.query('SELECT * FROM '+target+' WHERE '+condition+' FOR UPDATE',keys.map(name=>input.key[name]),1);
    requireValue(current.rows.length && rowToken(record,schema,table,current.rows[0])===input.snapshot,
      'Строка изменилась. Обновите таблицу перед повтором.',409);
    return {affected:(await db.query(sql,args)).affected};
  });
}
function cell(value) {
  let text = value == null ? '' : String(value);
  if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"','""') + '"';
}

async function api(req, res, url, event) {
  const parts = url.pathname.split('/').filter(Boolean);
  const [, resource, id, action] = parts;
  const method = req.method;
  if (method !== 'GET') {
    const site = req.headers['sec-fetch-site'];
    requireValue(!site || site === 'same-origin' || site === 'none', 'Запрос с другого сайта', 403);
    requireValue(req.headers['x-abdbadmin'] === '1', 'Недопустимый запрос', 403);
  }
  if (resource === 'login' && method === 'POST') {
    event.action = 'login';
    const {name,password} = await body(req);
    loginLimit(req);
    requireValue(userName(name) && typeof password === 'string' && password.length <= 256,'Неверный логин или пароль',401);
    const record = database.prepare('SELECT * FROM users WHERE name=?').get(name);
    requireValue(samePassword(password,record?.hash || fakeHash) && record,'Неверный логин или пароль',401);
    event.actor = record.name;
    const session = token();
    database.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    database.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(session),record.id,Date.now()+sessionDuration);
    res.setHeader('Set-Cookie',cookie(session,sessionDuration/1000));
    return {name:record.name,admin:record.admin,advancedUrl:advancedUrl(record),sourceIp:record.admin?sourceIp:null};
  }

  const session = /(?:^|;\s*)claydb_session=([\w-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const user = session && database.prepare('SELECT u.id,u.name,u.admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?').get(digest(session),Date.now());
  requireValue(user,'Войдите в панель',401);
  event.actor = user.name;
  if (resource === 'connection-test' && method === 'POST') {
    requireValue(user.admin,'Требуются права администратора',403);
    const input=await body(req);
    let previous;
    if (input.id!==undefined && input.id!==null) {
      requireValue(Number.isSafeInteger(input.id));
      const record=access(user,input.id);
      previous=reveal(record.secret);
    }
    return testConnection(configuration({...input,ca:input.ca ?? previous?.ca},previous));
  }
  if (resource === 'audit' && method === 'GET') {
    requireValue(user.admin,'Требуются права администратора',403);
    const before = safeId(url.searchParams.get('before'));
    const entries = before === null
      ? database.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 51').all()
      : database.prepare('SELECT * FROM audit WHERE id<? ORDER BY id DESC LIMIT 51').all(before);
    return {entries:entries.slice(0,50),next:entries.length>50 ? entries[49].id : null};
  }
  if (resource === 'session' && method === 'GET') return {...user,advancedUrl:advancedUrl(user),sourceIp:user.admin?sourceIp:null};
  if (resource === 'logout' && method === 'POST') {
    event.action = 'logout';
    database.prepare('DELETE FROM sessions WHERE hash=?').run(digest(session));
    res.setHeader('Set-Cookie',cookie('',0));
    return {};
  }
  if (resource === 'password' && method === 'POST') {
    event.action = 'password.change';
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
    if (!id && method==='POST') event.action = 'user.create';
    if (id && !action && method==='DELETE') event.action = 'user.delete';
    if (id && action==='permissions' && method==='PUT') event.action = 'permission.change';
    event.subject = safeId(id);
    requireValue(user.admin,'Требуются права администратора',403);
    if (!id && method === 'GET') return database.prepare('SELECT id,name,admin FROM users ORDER BY name').all();
    if (!id && method === 'POST') {
      const {name,password} = await body(req);
      requireValue(userName(name) && passwordValid(password),'Логин: 3–48 латинских символов, пароль: 12–256 символов');
      requireValue(!database.prepare('SELECT id FROM users WHERE name=?').get(name),'Логин уже занят',409);
      event.subject = Number(database.prepare('INSERT INTO users(name,hash,admin) VALUES (?,?,0)').run(name,passwordHash(password)).lastInsertRowid);
      return {};
    }
    const target = database.prepare('SELECT * FROM users WHERE id=? AND admin=0').get(id);
    requireValue(target,'Пользователь недоступен',404);
    if (method === 'GET' && action === 'permissions') {
      return database.prepare('SELECT connection_id,level FROM permissions WHERE user_id=?').all(id);
    }
    if (method === 'PUT' && action === 'permissions') {
      const {connection,level} = await body(req);
      event.connection = Number.isSafeInteger(connection) ? connection : null;
      requireValue(Number.isSafeInteger(connection) && [null,'view','edit','sql'].includes(level));
      const targetConnection=database.prepare('SELECT 1 FROM connections WHERE id=? AND engine<>?').get(connection,'demo');
      requireValue(targetConnection,'Подключение недоступно',404);
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
    event.connection = safeId(id);
    if (!id && method==='POST') event.action = 'connection.create';
    if (id && !action && method==='DELETE') event.action = 'connection.delete';
    if (action==='settings' && method==='PUT') event.action = 'connection.update';
    if (action==='sql' && method==='POST') event.action = 'sql.execute';
    if (action==='rows' && method==='POST') event.action = 'row.write';
    if (action==='csv' && method==='GET') event.action = 'csv.export';
    if (!id && method === 'GET') {
      const entries = user.admin ? database.prepare("SELECT id,name,engine,secret,'admin' AS level FROM connections WHERE engine<>'demo' ORDER BY name").all()
        : database.prepare('SELECT c.id,c.name,c.engine,c.secret,p.level FROM connections c JOIN permissions p ON p.connection_id=c.id WHERE p.user_id=? AND c.engine<>? ORDER BY c.name').all(user.id,'demo');
      return entries.map(({secret,...entry})=>({...entry,production:Boolean(reveal(secret).production)}));
    }
    if (!id && method === 'POST') {
      requireValue(user.admin,'Требуются права администратора',403);
      const profile = configuration(await body(req));
      await testConnection(profile);
      const {lastInsertRowid} = database.prepare('INSERT INTO connections(name,engine,secret) VALUES (?,?,?)').run(profile.name,profile.engine,protect(profile));
      event.connection = Number(lastInsertRowid);
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
          await testConnection(profile);
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
      const mysql = ['mysql','mariadb'].includes(record.engine);
      if (action==='sql-script' && method==='POST') {
        requireValue(user.admin && mysql,'Требуются права администратора',403);
        const {sql,confirmation}=await body(req,6400000);
        requireValue(typeof sql==='string' && sql.trim() && Buffer.byteLength(sql)<=1048576);
        const expected=createHmac('sha256',key).update(JSON.stringify(['script',user.id,record.secret,sql])).digest('hex');
        if (confirmation===undefined) return {confirmation:expected,database:profile.database};
        requireValue(confirmation===expected,'Сначала откройте предпросмотр изменений',409);
        event.action='sql.script';
        return remote(profile,db=>db.script(sql,row=>row.map(limitText)),false,{scripts:true});
      }
      if (['sql-export','database-export'].includes(action) && method==='GET') {
        requireValue(user.admin && mysql,'Требуются права администратора',403);
        const databaseExport=action==='database-export';
        const table=url.searchParams.get('table');
        requireValue(databaseExport || table && table.length<=64);
        event.action=databaseExport?'database.export':'sql.export';
        const result=await remote(profile,db=>databaseExport?exportDatabaseTables(db,profile.database):exportTableSql(db,profile.database,table));
        requireValue(result.error!=='empty','В базе нет таблиц для выгрузки',404);
        requireValue(result.error!=='engine','Выгрузка базы поддерживает только таблицы InnoDB',400);
        requireValue(result.error!=='external','Выгрузка базы не поддерживает внешние ключи на другие базы',400);
        requireValue(result.error!=='table','Таблица недоступна',404);
        requireValue(result.error!=='type','Экспорт SQL не поддерживает этот тип столбца',400);
        requireValue(!result.error,databaseExport?'База превышает лимит выгрузки SQL':'Таблица превышает лимит экспорта SQL',413);
        audit(event,200);
        event.action=null;
        res.setHeader('Content-Type','application/sql; charset=utf-8');
        res.setHeader('Content-Disposition',databaseExport?'attachment; filename="abdbadmin-database.sql"':'attachment; filename="abdbadmin-table.sql"');
        res.end(result.sql);
        return;
      }
      if (action==='maintenance' && method==='POST') {
        requireValue(user.admin && mysql,'Требуются права администратора',403);
        const {table,operation}=await body(req);
        requireValue(typeof table==='string' && table.length>0 && table.length<=64 && ['CHECK','ANALYZE','OPTIMIZE'].includes(operation));
        const quote=name=>identifier(false,name);
        event.action='table.maintenance';
        return remote(profile,async db=>(await db.script(operation+' TABLE '+quote(profile.database)+'.'+quote(table),row=>row.map(limitText))).sets[0]);
      }
      if (action==='database-accounts') {
        requireValue(user.admin && mysql,'Требуются права администратора',403);
        if (method==='GET') {
          const data=await remote(profile,db=>databaseAccounts(db,profile.database));
          return {...data,database:profile.database,privileges:databasePrivileges};
        }
        if (method==='POST') {
          const input=await body(req);
          const operation=databaseAccountInput(input);
          requireValue(operation,'Неверные данные учётной записи БД');
          requireValue(!['grant','revoke'].includes(operation.operation) || !/[%_\\]/.test(profile.database),
            'Имя базы с символами шаблона не поддерживается редактором прав');
          const signature=expires=>createHmac('sha256',key).update(JSON.stringify(
            ['db-account',user.id,record.id,record.secret,expires,operation])).digest('hex');
          if (input.confirmation===undefined) {
            const expires=Date.now()+300000;
            return {database:profile.database,confirmation:expires+'.'+signature(expires)};
          }
          const expires=Number(String(input.confirmation).split('.')[0]);
          requireValue(Number.isSafeInteger(expires) && expires>=Date.now() && expires<=Date.now()+300000 &&
            input.confirmation===expires+'.'+signature(expires),'Сначала откройте предпросмотр изменений',409);
          event.action='db-account.'+operation.operation;
          const applied=await remote(profile,db=>applyDatabaseAccount(db,profile.database,operation,record.engine));
          requireValue(applied,'Нельзя удалить или сменить пароль учётной записи текущего подключения',409);
          return {};
        }
      }
      if (action==='server-status' && method==='GET') {
        requireValue(user.admin && mysql,'Требуются права администратора',403);
        return remote(profile,db=>serverOverview(db));
      }
      if (action==='object-definition' && method==='GET') {
        requireValue(user.admin && mysql,'Требуются права администратора',403);
        const kind=url.searchParams.get('kind');
        const name=url.searchParams.get('name');
        requireValue(['PROCEDURE','FUNCTION','TRIGGER','EVENT'].includes(kind) &&
          name && name.length<=64 && !/[\x00-\x1f]/.test(name));
        const sql=await remote(profile,db=>objectDefinition(db,profile.database,kind,name));
        requireValue(sql,'Определение объекта недоступно для этой учётной записи',403);
        return {sql};
      }
      if (action==='object-change' && method==='POST') {
        requireValue(user.admin && mysql,'Требуются права администратора',403);
        const input=await body(req,400000);
        const sql=objectCommand(profile.database,input);
        requireValue(sql,'Проверьте заполнение полей');
        const confirmation=createHmac('sha256',key).update(JSON.stringify(
          ['database-object',user.id,record.id,record.secret,sql])).digest('hex');
        if (input.preview===true) return {sql,confirmation,database:profile.database};
        requireValue(input.confirmation===confirmation,'Сначала откройте предпросмотр изменений',409);
        event.action='db-object.'+input.operation;
        await remote(profile,db=>db.script(sql,row=>row));
        return {};
      }
      if (action==='database-objects' && method==='GET') {
        requireValue(user.admin && mysql,'Требуются права администратора',403);
        return remote(profile,db=>databaseObjects(db,profile.database));
      }
      if (action==='database-search' && method==='POST') {
        requireValue(mysql,'Эта функция доступна для MySQL и MariaDB',400);
        const {text,offset=0}=await body(req);
        requireValue(typeof text==='string' && text.trim().length>0 && text.length<=200 && Number.isSafeInteger(offset) && offset>=0 && offset<=500);
        return remote(profile,db=>searchDatabase(db,text.trim(),offset));
      }
      if (action==='csv-import' && method==='POST') {
        requireValue(user.admin && mysql,'Требуются права администратора',403);
        const {csv,table,confirmation}=await body(req,420000);
        requireValue(typeof csv==='string' && Buffer.byteLength(csv)<=65536 && typeof table==='string' && table.length>0 && table.length<=64);
        let parsed;
        try {parsed=parseCsv(csv);} catch {throw new RequestError(400,'Нужен CSV с заголовком и не более чем 200 строками одинаковой ширины');}
        const [header,...rows]=parsed;
        const expected=createHmac('sha256',key).update(JSON.stringify(['csv',user.id,record.id,record.secret,table,csv])).digest('hex');
        const apply=confirmation!==undefined;
        requireValue(!apply || confirmation===expected,'Сначала откройте предпросмотр изменений',409);
        if (apply) event.action='csv.import';
        const result=await remote(profile,db=>importCsv(db,profile.database,table,header,rows,apply));
        requireValue(result,'Для импорта нужна таблица InnoDB и совпадающие названия столбцов');
        return apply?result:{...result,confirmation:expected};
      }
      if (action==='structure-editor' && record.engine==='postgres') {
        requireValue(user.admin,'Требуются права администратора',403);
        if (method==='GET') {
          const schema=url.searchParams.get('schema'), table=url.searchParams.get('table');
          if (!table) return {columnTypes:postgresColumnTypes};
          requireValue(schema && schema.length<=63 && table.length<=63);
          const definition=await remote(profile,db=>postgresTableDefinition(db,schema,table));
          requireValue(definition,'Таблица недоступна',404);
          return definition;
        }
        if (method==='POST') {
          const input=await body(req);
          requireValue(['rename-column','modify-column'].includes(input.operation) &&
            [input.schema,input.table].every(value=>typeof value==='string' && value.length>0 && value.length<=63));
          return remote(profile,async db=>{
            const definition=await postgresTableDefinition(db,input.schema,input.table);
            let sql;
            try {sql=postgresColumnStatement(input,definition);}
            catch (error) {
              if (!(error instanceof TypeError)) throw error;
              throw new RequestError(400,'Проверьте заполнение полей');
            }
            requireValue(sql,'Для этой таблицы или столбца изменение недоступно в редакторе',409);
            const confirmation=createHmac('sha256',key).update(JSON.stringify([user.id,record.id,record.secret,sql,definition])).digest('hex');
            if (input.preview===true) return {sql,confirmation};
            requireValue(input.confirmation===confirmation,'Сначала откройте предпросмотр изменений',409);
            event.action='schema.change';
            await db.query(sql);
            return {};
          });
        }
      }
      if (action==='structure-editor') {
        requireValue(user.admin && ['mysql','mariadb'].includes(record.engine),'Требуются права администратора',403);
        if (method==='GET') {
          const table=url.searchParams.get('table');
          if (!table) return {columnTypes,tableEngines,database:profile.database};
          const definition=await remote(profile,db=>tableDefinition(db,profile.database,table));
          requireValue(definition,'Таблица недоступна',404);
          return definition;
        }
        if (method==='POST') {
          const input=await body(req);
          const checkDefinition=['modify-column','change-engine'].includes(input.operation);
          if (checkDefinition) requireValue(typeof input.table==='string' && input.table.length<=64);
          return remote(profile,async db=>{
            const definition=checkDefinition?await tableDefinition(db,profile.database,input.table):null;
            let sql;
            try { sql=schemaStatement(profile.database,input,definition); }
            catch (error) {
              if (!(error instanceof TypeError)) throw error;
              throw new RequestError(400,'Проверьте заполнение полей');
            }
            requireValue(sql,'Для этой таблицы или столбца изменение недоступно в редакторе',409);
            const confirmation=createHmac('sha256',key).update(JSON.stringify([user.id,record.id,record.secret,sql,definition])).digest('hex');
            if (input.preview===true) return {sql,confirmation};
            requireValue(input.confirmation===confirmation,'Сначала откройте предпросмотр изменений',409);
            event.action='schema.change';
            if (input.operation==='modify-column') {
              await db.script("SET SESSION sql_mode=IF(FIND_IN_SET('STRICT_ALL_TABLES',@@SESSION.sql_mode),@@SESSION.sql_mode,CONCAT_WS(',',NULLIF(@@SESSION.sql_mode,''),'STRICT_ALL_TABLES'))",row=>row);
            }
            await db.query(sql);
            return {};
          });
        }
      }
      if (action === 'schema' && method === 'GET') {
        return remote(profile,async db=>({tables:await structure(db,{catalog:true}),relations:await relations(db)}));
      }
      if (action === 'sql' && method === 'POST') {
        requireValue(['sql','admin'].includes(record.level),'Нет доступа к SQL',403);
        const {sql} = await body(req);
        requireValue(typeof sql === 'string' && sql.trim() && sql.length <= 65000,'Введите SQL-запрос');
        return remote(profile,async db=>rowResult(await db.query(sql,[],201)));
      }
      if (['rows','csv','views'].includes(action)) {
        const schema = url.searchParams.get('schema');
        const table = url.searchParams.get('table');
        requireValue(schema && table && schema.length <= 255 && table.length <= 255);
        if (action==='views') {
          const scope = [user.id,record.id,schema,table];
          const where = 'user_id=? AND connection_id=? AND schema_name=? AND table_name=?';
          if (method==='GET') {
            return database.prepare('SELECT id,name,config FROM saved_views WHERE '+where+' ORDER BY name')
              .all(...scope).map(view=>({id:view.id,name:view.name,view:reveal(view.config)}));
          }
          if (method==='POST') {
            const input = await body(req);
            const name = typeof input.name==='string' ? input.name.trim() : '';
            requireValue(name.length>0 && name.length<=80);
            const view = tableView(input.view);
            const existing = database.prepare('SELECT id FROM saved_views WHERE '+where+' AND name=?').get(...scope,name);
            requireValue(existing || database.prepare('SELECT count(*) AS total FROM saved_views WHERE user_id=?').get(user.id).total<250);
            database.prepare('INSERT INTO saved_views(user_id,connection_id,schema_name,table_name,name,config) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,connection_id,schema_name,table_name,name) DO UPDATE SET config=excluded.config')
              .run(...scope,name,protect(view));
            return {};
          }
          if (method==='DELETE') {
            const id = safeId(url.searchParams.get('id'));
            requireValue(id!==null);
            database.prepare('DELETE FROM saved_views WHERE '+where+' AND id=?').run(...scope,id);
            return {};
          }
          throw new RequestError(404,'Страница не найдена');
        }
        if (method === 'GET') {
          const offset = Number(url.searchParams.get('offset') || 0);
          requireValue(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000000);
          const limit = action==='csv'?501:51;
          const view=readView(url);
          const result = await remote(profile, db=>tableData(db,schema,table,offset,limit,view));
          requireValue(!result?.invalidView,'Столбец недоступен');
          requireValue(result,'Таблица недоступна',404);
          if (action === 'csv') {
            const page = rowResult(result,500);
            res.setHeader('Content-Type','text/csv; charset=utf-8');
            res.setHeader('Content-Disposition','attachment; filename="abdbadmin-export.csv"');
            audit(event,200);
            event.action=null;
            res.end('\uFEFF' + [page.columns,...page.rows].map(row=>row.map(cell).join(',')).join('\r\n') + '\r\n');
            return;
          }
          const page = rowResult(result,50);
          if (record.level!=='view') {
            const visible=result.rows.slice(0,50);
            page.snapshots=visible.map(row=>rowToken(record,schema,table,row));
            page.limitedCells=visible.map(row=>row.map(value=>Buffer.isBuffer(value) || typeof value==='string' && value.length>4096));
          }
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
          if (['insert','update','delete'].includes(input.action)) event.action='row.'+input.action;
          return remote(profile,db=>changeRow(db,schema,table,input,record));
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
  const event = {};
  const lang = req.headers['accept-language']?.split(',')[0]?.trim().toLowerCase().startsWith('ru') ? 'ru' : 'en';
  const t = message => {
    const match = /^(.*?)( \([A-Z0-9_]+\))$/.exec(message);
    return match ? translate(lang,match[1])+match[2] : translate(lang,message);
  };
  try {
    requireValue(!localOnly || (/^127\.0\.0\.1(?::[0-9]+)?$/.test(req.headers.host || '') && !Object.keys(req.headers).some(name=>name==='forwarded' || name.startsWith('x-forwarded-'))), 'Локальный режим',403);
    const url = new URL(req.url,'http://localhost');
    if (url.pathname === '/healthz' && req.method === 'GET') {res.end('ok'); return;}
    if (!localOnly && !authorized(req.headers.authorization)) {
      res.setHeader('WWW-Authenticate','Basic realm="AbDbAdmin", charset="UTF-8"');
      res.statusCode=401;
      res.setHeader('Content-Type','text/plain; charset=utf-8');
      res.end(t('Требуется вход через HTTP Basic Auth'));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const result = await api(req,res,url,event);
      audit(event,200);
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
    audit(event,res.statusCode);
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.removeHeader('Content-Disposition');
    if (res.statusCode === 500) console.error('Application error',error.code || error.name);
    res.end(JSON.stringify({error:t(res.statusCode === 500 ? 'Внутренняя ошибка' : error.message),...(error instanceof RequestError && error.peer ? {peer:error.peer} : {})}));
  }
}).listen(Number(process.env.PORT || 8099),process.env.BIND_HOST || '127.0.0.1',function () { console.log('AbDbAdmin listening on '+this.address().port); });
