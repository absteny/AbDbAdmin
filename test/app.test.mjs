import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { get } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withDatabase } from '../database.mjs';

test('First run, access control, demo, and audit', {timeout:90000}, async t=>{
  const directory = await mkdtemp(join(tmpdir(),'claydb-test-'));
  const server = spawn(process.execPath,['server.mjs'],{env:{...process.env,DATA_DIR:directory,PORT:'0',BIND_HOST:'127.0.0.1',COOKIE_SECURE:'0',ABDB_LOCAL_ONLY:'1'}});
  t.after(async ()=>{
    if (server.exitCode==null && server.signalCode==null) {
      const exited = once(server,'exit');
      server.kill();
      await exited;
    }
    await rm(directory,{recursive:true,force:true});
  });
  const port = await new Promise((resolve,reject)=>{
    let stdout='';
    server.stdout.on('data',chunk=>{
      stdout+=chunk;
      const port=/AbDbAdmin listening on (\d+)/.exec(stdout)?.[1];
      if (port) resolve(port);
    });
    server.once('error',reject);
    server.once('exit',code=>reject(new Error('Server stopped with code '+code)));
  });
  const base = 'http://127.0.0.1:'+port;
  function command(name) {
    return execFileSync(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs',name],{
      env:{...process.env,DATA_DIR:directory},encoding:'utf8',
    });
  }
  function gatewayPassword() {
    return /Username: gateway\nPassword: ([A-Za-z0-9_-]{43})/.exec(command('show-access'))?.[1];
  }
  const basic = gatewayPassword();
  assert.ok(basic);
  assert.equal((await readFile(join(directory,'claydb.sqlite-wal'))).includes(basic),false);
  const auth = 'Basic '+Buffer.from('gateway:'+basic).toString('base64');
  async function request(path, method='GET', data, cookie='', code=200, csrf=true) {
    const response = await fetch(base+'/api/'+path,{
      method,
      headers:{
        Authorization:auth, Cookie:cookie, ...(csrf?{'X-AbDbAdmin':'1'}:{}),
        ...(data===undefined?{}:{'Content-Type':'application/json'}),
      },
      body:data===undefined?undefined:JSON.stringify(data),
    });
    const content = response.headers.get('Content-Type')?.startsWith('text/csv')
      ? await response.text() : await response.json();
    assert.equal(response.status,code,JSON.stringify(content));
    return {body:content,cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
  }
  const initial = (await readFile(join(directory,'initial-admin.txt'),'utf8')).trim();
  assert.match(initial,/^[\w-]{43}$/);
  assert.equal(await (await fetch(base+'/healthz')).text(),'ok');
  for (const path of ['/', '/style.css', '/app.js', '/api/connections']) {
    const denied = await fetch(base+path);
    assert.equal(denied.status,401);
    assert.match(denied.headers.get('WWW-Authenticate'),/^Basic realm="AbDbAdmin"/);
  }
  const wrong = await fetch(base,{headers:{Authorization:'Basic '+Buffer.from('gateway:'+'0'.repeat(43)).toString('base64')}});
  assert.equal(wrong.status,401);
  assert.match(await (await fetch(base,{headers:{Authorization:auth}})).text(),/<html lang="en">/);
  const outsideHost = await new Promise((resolve,reject)=>{
    get(base,{headers:{Authorization:auth,Host:'remote.example'}},response=>{
      response.resume();
      resolve(response.statusCode);
    }).on('error',reject);
  });
  assert.equal(outsideHost,403);
  assert.equal((await fetch(base,{headers:{Authorization:auth,'X-Forwarded-For':'192.0.2.10'}})).status,403);
  assert.equal((await fetch(base+'/i18n.js',{headers:{Authorization:auth}})).status,200);
  const unauthenticated = language => fetch(base+'/api/session',{headers:{Authorization:auth,'Accept-Language':language}}).then(res=>res.json());
  assert.deepEqual(await unauthenticated('en'),{error:'Sign in to the panel'});
  assert.deepEqual(await unauthenticated('ru'),{error:'Войдите в панель'});
  await request('connections','GET',undefined,'',401);
  await request('login','POST',{name:'admin',password:initial},'',403,false);
  const {cookie:admin} = await request('login','POST',{name:'admin',password:initial});
  await request('users','POST',{name:'reader',password:'test-reader-pass'},admin);
  const {cookie:reader} = await request('login','POST',{name:'reader',password:'test-reader-pass'});
  const {body:users} = await request('users','GET',undefined,admin);
  const readerId = users.find(user=>user.name==='reader').id;
  await request('users','GET',undefined,reader,403);
  assert.deepEqual((await request('connections','GET',undefined,reader)).body,[]);

  await request('audit','GET',undefined,reader,403);
  await request('demo','POST',undefined,reader,403);
  const {body:{id:demoId}} = await request('demo','POST',undefined,admin);
  assert.equal((await request('demo','POST',undefined,admin)).body.id,demoId);
  const demo = 'connections/'+demoId;
  const grant = 'users/'+readerId+'/permissions';
  await request(demo+'/schema','GET',undefined,reader,404);
  await request(grant,'PUT',{connection:demoId,level:'edit'},admin,403);
  await request(grant,'PUT',{connection:demoId,level:'view'},admin);
  const {body:demoConnections} = await request('connections','GET',undefined,reader);
  assert.deepEqual(demoConnections.map(item=>[item.id,item.level]),[[demoId,'view']]);
  const {body:sampleSchema} = await request(demo+'/schema','GET',undefined,reader);
  assert.equal(sampleSchema.tables.length,4);
  assert.ok(sampleSchema.relations.some(edge=>edge.join('.')==='store.orders.store.customers'));
  const orders = demo+'/rows?schema=store&table=orders';
  assert.deepEqual((await request(orders,'GET',undefined,reader)).body.rows[0],[101,1,'paid']);
  const {body:customers} = await request(demo+'/rows?schema=store&table=customers','GET',undefined,reader);
  assert.deepEqual(customers.rows[0],[1,'Northwind Workshop']);
  const row = {action:'update',key:{id:101},values:{status:'secret-row-marker'}};
  await request(orders,'POST',row,reader,403);
  await request(orders,'POST',row,admin,403);
  await request(demo+'/sql','POST',{sql:'SELECT secret-sql-marker'},admin,403);
  await request(demo+'/csv?schema=store&table=orders','GET',undefined,reader);
  await request(demo,'DELETE',undefined,admin);
  await request(orders,'GET',undefined,reader,404);

  await t.test('Database integration', {skip:!process.env.TEST_DB_ENGINE}, async ()=>{
    const engine = process.env.TEST_DB_ENGINE;
    const pg = engine==='postgres';
    const schema = pg?'public':'clay';
    const profile = {
      engine, name:'Интеграционная БД', host:'127.0.0.1', port:Number(process.env.TEST_DB_PORT),
      user:'clay', database:'clay', password:'clay-db-test', tls:false,
    };
    await withDatabase(profile,async db=>{
      await db.query('DROP TABLE IF EXISTS clay_child');
      await db.query('DROP TABLE IF EXISTS clay_parent');
      await db.query('CREATE TABLE clay_parent (id INT PRIMARY KEY, label VARCHAR(80) DEFAULT NULL)');
      await db.query('CREATE TABLE clay_child (id INT PRIMARY KEY, parent_id INT, FOREIGN KEY (parent_id) REFERENCES clay_parent(id))');
      await db.query("INSERT INTO clay_parent(id,label) VALUES (1,'original')");
    });
    const {body:{id}} = await request('connections','POST',profile,admin);
    const saved = await readFile(join(directory,'claydb.sqlite-wal'));
    assert.equal(saved.includes(profile.password),false);
    const conn = 'connections/'+id;
    const userPermission = 'users/'+readerId+'/permissions';
    const rows = conn+'/rows?schema='+schema+'&table=clay_parent';
    const csv = conn+'/csv?schema='+schema+'&table=clay_parent';
    await request(conn+'/schema','GET',undefined,reader,404);
    await request(userPermission,'PUT',{connection:id,level:'view'},admin);
    const structure = (await request(conn+'/schema','GET',undefined,reader)).body;
    assert.ok(structure.tables.some(table=>table[1]==='clay_child'));
    assert.deepEqual(structure.relations.find(edge=>edge[1]==='clay_child'),[schema,'clay_child',schema,'clay_parent']);
    const page = (await request(rows,'GET',undefined,reader)).body;
    assert.deepEqual(page.rows,[[1,'original']]);
    assert.ok(page.definition[0][3]);
    assert.match((await request(csv,'GET',undefined,reader)).body,/"1","original"/);
    await request(rows,'POST',{action:'update',key:{id:1},values:{label:'changed'}},reader,403);
    await request(conn+'/sql','POST',{sql:'SELECT 1'},reader,403);
    await request(conn+'/settings','GET',undefined,reader,403);
    const settings = (await request(conn+'/settings','GET',undefined,admin)).body;
    assert.ok(!Object.hasOwn(settings,'password'));
    await request(conn+'/settings','PUT',{...settings,name:'Переименовано'},admin);
    await request(userPermission,'PUT',{connection:id,level:'edit'},admin);
    await request(rows,'POST',{action:'update',key:{id:1},values:{label:'=changed'}},reader);
    assert.match((await request(csv,'GET',undefined,reader)).body,/"1","'=changed"/);
    await request(rows,'POST',{action:'insert',values:{id:2,label:'new'}},reader);
    await request(rows,'POST',{action:'delete',key:{id:2}},reader);
    await request(conn+'/sql','POST',{sql:'SELECT 1'},reader,403);
    await request(userPermission,'PUT',{connection:id,level:'sql'},admin);
    assert.deepEqual((await request(conn+'/sql','POST',{sql:'SELECT id FROM clay_parent'},reader)).body.rows,[[1]]);
    await request(conn+'/sql','POST',{sql:'SELECT 1; SELECT 2'},reader,502);
    await request(userPermission,'PUT',{connection:id,level:null},admin);
    await request(rows,'GET',undefined,reader,404);
    await request(conn,'DELETE',undefined,admin);
  });

  await request('password','POST',{current:initial,password:'replacement-password-123'},admin);
  await assert.rejects(readFile(join(directory,'initial-admin.txt')),{code:'ENOENT'});
  await request('login','POST',{name:'admin',password:initial},'',401);
  const {body:log} = await request('audit','GET',undefined,admin);
  assert.ok(log.entries.some(e=>e.action==='login' && e.status===401 && e.actor===null));
  assert.ok(log.entries.some(e=>e.action==='permission.change' && e.actor==='admin' && e.connection_id===demoId && e.subject_id===readerId && e.status===200));
  assert.ok(log.entries.some(e=>e.action==='sql.execute' && e.status===403));
  assert.ok(log.entries.some(e=>e.action==='csv.export' && e.actor==='reader' && e.status===200));
  assert.ok(log.entries.some(e=>e.action==='row.write' && e.actor==='reader' && e.status===403));
  for (const secret of ['secret-row-marker','secret-sql-marker',initial,basic,'test-reader-pass']) {
    assert.equal(JSON.stringify(log).includes(secret),false);
  }
  const oldest=log.entries.at(-1).id;
  const older=(await request('audit?before='+oldest,'GET',undefined,admin)).body;
  assert.ok(older.entries.every(entry=>entry.id<oldest));
  await request('users/'+readerId,'DELETE',undefined,admin);
  await request('session','GET',undefined,reader,401);
  await request('logout','POST',undefined,admin);
  await request('session','GET',undefined,admin,401);
  command('reset-basic');
  const replacement = gatewayPassword();
  assert.ok(replacement && replacement!==basic);
  assert.equal((await fetch(base,{headers:{Authorization:auth}})).status,401);
  assert.equal((await fetch(base,{headers:{Authorization:'Basic '+Buffer.from('gateway:'+replacement).toString('base64')}})).status,200);
});
