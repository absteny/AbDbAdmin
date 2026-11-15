import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { get } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withDatabase } from '../database.mjs';

for (const local of [false,true]) test(local ? 'Local access, demo, and audit' : 'Remote Basic Auth and rotation', {timeout:90000}, async t=>{
  const directory = await mkdtemp(join(tmpdir(),'claydb-test-'));
  const server = spawn(process.execPath,['server.mjs'],{env:{...process.env,DATA_DIR:directory,PORT:'0',BIND_HOST:'127.0.0.1',COOKIE_SECURE:'0',ABDB_LOCAL_ONLY:local?'1':'0'}});
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
      env:{...process.env,DATA_DIR:directory,ABDB_LOCAL_ONLY:local?'1':'0'},encoding:'utf8',
    });
  }
  function gatewayPassword() {
    return /Username: gateway\nPassword: ([A-Za-z0-9_-]{43})/.exec(command('show-access'))?.[1];
  }
  if (!local) {
    const basic=gatewayPassword();
    assert.ok(basic);
    assert.equal((await readFile(join(directory,'claydb.sqlite-wal'))).includes(basic),false);
    const auth=secret=>'Basic '+Buffer.from('gateway:'+secret).toString('base64');
    for (const path of ['/','/style.css','/app.js','/api/connections']) {
      const denied=await fetch(base+path);
      assert.equal(denied.status,401);
      assert.match(denied.headers.get('WWW-Authenticate'),/^Basic realm="AbDbAdmin"/);
    }
    assert.equal((await fetch(base,{headers:{Authorization:auth(basic)}})).status,200);
    command('reset-basic');
    const replacement=gatewayPassword();
    assert.ok(replacement && replacement!==basic);
    assert.equal((await fetch(base,{headers:{Authorization:auth(basic)}})).status,401);
    assert.equal((await fetch(base,{headers:{Authorization:auth(replacement)}})).status,200);
    return;
  }
  assert.ok(!command('show-access').includes('Username: gateway'));
  async function request(path, method='GET', data, cookie='', code=200, csrf=true) {
    const response = await fetch(base+'/api/'+path,{
      method,
      headers:{
        Cookie:cookie, ...(csrf?{'X-AbDbAdmin':'1'}:{}),
        ...(data===undefined?{}:{'Content-Type':'application/json'}),
      },
      body:data===undefined?undefined:JSON.stringify(data),
    });
    const content = /^(text\/csv|application\/sql)/.test(response.headers.get('Content-Type')||'')
      ? await response.text() : await response.json();
    assert.equal(response.status,code,JSON.stringify(content));
    return {body:content,cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
  }
  const initial = (await readFile(join(directory,'initial-admin.txt'),'utf8')).trim();
  assert.match(initial,/^[\w-]{43}$/);
  assert.equal(await (await fetch(base+'/healthz')).text(),'ok');
  const localPage=await fetch(base);
  assert.equal(localPage.headers.get('WWW-Authenticate'),null);
  assert.match(await localPage.text(),/<html lang="en">/);
  const outsideHost = await new Promise((resolve,reject)=>{
    get(base,{headers:{Host:'remote.example'}},response=>{
      response.resume();
      resolve(response.statusCode);
    }).on('error',reject);
  });
  assert.equal(outsideHost,403);
  assert.equal((await fetch(base,{headers:{'X-Forwarded-For':'192.0.2.10'}})).status,403);
  assert.equal((await fetch(base+'/i18n.js')).status,200);
  const unauthenticated = language => fetch(base+'/api/session',{headers:{'Accept-Language':language}}).then(res=>res.json());
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
  const criteria={filters:[{column:'status',operator:'contains',value:'PA'}],sort:{column:'id',direction:'desc'}};
  const filtered=orders+'&filter='+encodeURIComponent(JSON.stringify(criteria));
  assert.deepEqual((await request(filtered,'GET',undefined,reader)).body.rows,[[101,1,'paid']]);
  const views=demo+'/views?schema=store&table=orders';
  await request(views,'POST',{name:'Paid orders',view:criteria},reader);
  const {body:stored}=await request(views,'GET',undefined,reader);
  assert.deepEqual(stored[0].view,criteria);
  assert.deepEqual((await request(views,'GET',undefined,admin)).body,[]);
  await request(views+'&id='+stored[0].id,'DELETE',undefined,admin);
  assert.equal((await request(views,'GET',undefined,reader)).body.length,1);
  await request(views+'&id='+stored[0].id,'DELETE',undefined,reader);
  assert.deepEqual((await request(views,'GET',undefined,reader)).body,[]);
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
      if (!pg) await db.query('DROP TABLE IF EXISTS clay_editor_test, clay_editor_test_renamed');
      await db.query('DROP TABLE IF EXISTS clay_child');
      await db.query('DROP TABLE IF EXISTS clay_parent');
      await db.query('CREATE TABLE clay_parent (id INT PRIMARY KEY, label VARCHAR(80) DEFAULT NULL)');
      await db.query('CREATE TABLE clay_child (id INT PRIMARY KEY, parent_id INT, FOREIGN KEY (parent_id) REFERENCES clay_parent(id))');
      await db.query("INSERT INTO clay_parent(id,label) VALUES (1,'original')");
    });
    await request('connection-test','POST',profile,reader,403);
    const diagnostic = await request('connection-test','POST',profile,admin);
    assert.ok(diagnostic.body.peer);
    const denied = await request('connection-test','POST',{...profile,password:'wrong-password'},admin,502);
    assert.match(denied.body.error,/password/i);
    assert.ok(!JSON.stringify(denied.body).includes('wrong-password'));
    if (!pg) assert.ok(denied.body.peer);
    const {body:{id}} = await request('connections','POST',profile,admin);
    const saved = await readFile(join(directory,'claydb.sqlite-wal'));
    assert.equal(saved.includes(profile.password),false);
    const conn = 'connections/'+id;
    if (pg) {
      await request(conn+'/structure-editor','GET',undefined,admin,403);
    } else {
      const objects=await request(conn+'/database-objects','GET',undefined,admin);
      assert.deepEqual(Object.keys(objects.body),['routines','triggers','events']);
      const csvRoute=conn+'/csv-import';
      const input={table:'clay_parent',csv:'id,label\r\n803,"Needle, with ""quotes"""\r\n'};
      await request(csvRoute,'POST',input,reader,404);
      const preview=await request(csvRoute,'POST',input,admin);
      assert.equal(preview.body.rows,1);
      assert.equal((await withDatabase(profile,db=>db.query('SELECT id FROM clay_parent WHERE id=803'))).rows.length,0);
      await request(csvRoute,'POST',{...input,csv:input.csv.replace('803','804'),confirmation:preview.body.confirmation},admin,409);
      await request(csvRoute,'POST',{...input,confirmation:preview.body.confirmation},admin);
      const results=await request(conn+'/database-search','POST',{text:'needle'},admin);
      assert.ok(results.body.results.some(result=>result.table==='clay_parent' && result.rows[0][0]==='Needle, with "quotes"'));
      await withDatabase(profile,db=>db.query('DELETE FROM clay_parent WHERE id=803'));
      const script=conn+'/sql-script';
      const probe='SELECT 13 AS first; SELECT 29 AS second';
      const {body:batchPreview}=await request(script,'POST',{sql:probe},admin);
      await request(script,'POST',{sql:probe+'; SELECT 3',confirmation:batchPreview.confirmation},admin,409);
      const {body:batch}=await request(script,'POST',{sql:probe,confirmation:batchPreview.confirmation},admin);
      assert.deepEqual(batch.sets.map(set=>String(set.rows[0][0])),["13","29"]);
      const roundtrip='clay_dump_test';
      await withDatabase(profile,async db=>{
        await db.query('DROP TABLE IF EXISTS clay_dump_test');
        await db.query('CREATE TABLE clay_dump_test (id INT PRIMARY KEY, label VARCHAR(80), payload VARBINARY(8))');
        await db.query('INSERT INTO clay_dump_test VALUES (1,?,?)',["quotes ' and line\nbreak",Buffer.from([0,1,255])]);
      });
      const {body:dump}=await request(conn+'/sql-export?table='+roundtrip,'GET',undefined,admin);
      assert.match(dump,/CREATE TABLE/);
      await withDatabase(profile,db=>db.query('DROP TABLE clay_dump_test'));
      const {body:restore}=await request(script,'POST',{sql:dump},admin);
      await request(script,'POST',{sql:dump,confirmation:restore.confirmation},admin);
      const readback=await withDatabase(profile,db=>db.query('SELECT * FROM clay_dump_test'));
      assert.deepEqual(readback.rows,[[1,"quotes ' and line\nbreak",Buffer.from([0,1,255])]]);
      const checked=await request(conn+'/maintenance','POST',{table:roundtrip,operation:'CHECK'},admin);
      assert.ok(checked.body.rows.length);
      await withDatabase(profile,db=>db.query('DROP TABLE clay_dump_test'));
      const editor=conn+'/structure-editor';
      const grant='users/'+readerId+'/permissions';
      await request(grant,'PUT',{connection:id,level:'sql'},admin);
      await request(editor,'GET',undefined,reader,403);
      await request(grant,'PUT',{connection:id,level:null},admin);
      const change=async input=>{
        const {body:preview}=await request(editor,'POST',{...input,preview:true},admin);
        assert.ok(preview.sql && preview.confirmation);
        await request(editor,'POST',{...input,confirmation:preview.confirmation},admin);
      };
      const table='clay_editor_test';
      await withDatabase(profile,db=>db.query('DROP TABLE IF EXISTS clay_editor_test'));
      const create={operation:'create-table',table,columns:[{name:'id',type:'INT',nullable:false,primary:true}]};
      await request(editor,'POST',create,admin,409);
      const {body:dryRun}=await request(editor,'POST',{...create,preview:true},admin);
      await request(editor+'?table='+table,'GET',undefined,admin,404);
      await request(editor,'POST',{...create,table:table+'_other',confirmation:dryRun.confirmation},admin,409);
      await change(create);
      await change({operation:'add-column',table,column:{name:'parent_id',type:'INT',nullable:true}});
      await change({operation:'add-index',table,name:'test_idx',keys:['parent_id']});
      await change({operation:'add-foreign-key',table,name:'test_fk',columnName:'parent_id',referencedTable:'clay_parent',referencedColumn:'id'});
      const {body:definition}=await request(editor+'?table='+table,'GET',undefined,admin);
      assert.ok(definition.columns.some(row=>row[0]==='parent_id'));
      assert.ok(definition.indexes.some(row=>row[0]==='test_idx'));
      assert.ok(definition.foreignKeys.some(row=>row[0]==='test_fk'));
      await change({operation:'drop-foreign-key',table,name:'test_fk'});
      await change({operation:'drop-index',table,name:'test_idx'});
      await change({operation:'rename-column',table,columnName:'parent_id',name:'related_id'});
      await change({operation:'drop-column',table,columnName:'related_id'});
      await change({operation:'rename-table',table,name:table+'_renamed'});
      await change({operation:'drop-table',table:table+'_renamed'});
    }
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
    const first=(await request(rows,'GET',undefined,reader)).body.snapshots[0];
    await request(rows,'POST',{action:'update',key:{id:1},values:{label:'=changed'},snapshot:first},reader);
    await request(rows,'POST',{action:'delete',key:{id:1},snapshot:first},reader,409);
    const filtered=rows+'&filter='+encodeURIComponent(JSON.stringify({filters:[{column:'label',operator:'contains',value:'changed'}],sort:{column:'id',direction:'desc'}}));
    assert.deepEqual((await request(filtered,'GET',undefined,reader)).body.rows,[[1,'=changed']]);
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
  for (const secret of ['secret-row-marker','secret-sql-marker',initial,'test-reader-pass']) {
    assert.equal(JSON.stringify(log).includes(secret),false);
  }
  const oldest=log.entries.at(-1).id;
  const older=(await request('audit?before='+oldest,'GET',undefined,admin)).body;
  assert.ok(older.entries.every(entry=>entry.id<oldest));
  await request('users/'+readerId,'DELETE',undefined,admin);
  await request('session','GET',undefined,reader,401);
  await request('logout','POST',undefined,admin);
  await request('session','GET',undefined,admin,401);
});
