import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { get } from 'node:http';
import { connect } from 'node:net';
import ssh2 from 'ssh2';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withDatabase } from '../database.mjs';

for (const local of [false,true]) test(local ? 'Local access and audit' : 'Remote Basic Auth and rotation', {timeout:90000}, async t=>{
  const directory = await mkdtemp(join(tmpdir(),'claydb-test-'));
  const sshPort=Number(process.env.TEST_DB_PORT)+1000;
  const hostKey=local && ['mysql','mariadb'].includes(process.env.TEST_DB_ENGINE)?ssh2.utils.generateKeyPairSync('ed25519').private:null;
  const pins=hostKey?{['127.0.0.1:'+sshPort]:'SHA256:'+createHash('sha256')
    .update(ssh2.utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=$/,'')}:null;
  const server = spawn(process.execPath,['server.mjs'],{env:{...process.env,DATA_DIR:directory,PORT:'0',BIND_HOST:'127.0.0.1',COOKIE_SECURE:'0',ABDB_LOCAL_ONLY:local?'1':'0',ABDB_SSH_HOST_KEYS:JSON.stringify(pins ?? {})}});
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
  await request('demo','POST',undefined,admin,404);

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
    const {body:{id}} = await request('connections','POST',{...profile,production:false},admin);
    const saved = await readFile(join(directory,'claydb.sqlite-wal'));
    assert.equal(saved.includes(profile.password),false);
    const conn = 'connections/'+id;
    assert.equal((await request('connections','GET',undefined,admin)).body.find(item=>item.id===id).production,true);
    assert.equal((await request(conn+'/settings','GET',undefined,admin)).body.production,true);
    if (pg) {
      assert.ok((await request(conn+'/structure-editor','GET',undefined,admin)).body.columnTypes.includes('INTEGER'));
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
      if (process.env.TEST_ACCOUNT_ADMIN==='1') {
        const path=conn+'/database-accounts';
        const account={user:'clay_account_test',host:'127.0.0.1'};
        const secret="sample-'\\-password";
        const change=async input=>{
          const {body:preview}=await request(path,'POST',input,admin);
          assert.equal(JSON.stringify(preview).includes(secret),false);
          await request(path,'POST',{...input,confirmation:preview.confirmation},admin);
        };
        await withDatabase(profile,db=>db.script("DROP USER IF EXISTS 'clay_account_test'@'127.0.0.1'",row=>row));
        try {
          await request(path,'POST',{operation:'create',...account,password:secret,confirmation:'invalid'},admin,409);
          await change({operation:'create',...account,password:secret});
          await change({operation:'grant',...account,privileges:['SELECT']});
          const {body:accounts}=await request(path,'GET',undefined,admin);
          assert.ok(accounts.accounts.some(([user,host])=>user===account.user && host===account.host));
          assert.ok(accounts.grants.some(([name,privilege])=>name.includes(account.user) && privilege==='SELECT'));
          assert.deepEqual((await withDatabase({...profile,user:account.user,password:secret},db=>db.query('SELECT id FROM clay_parent WHERE id=1'))).rows,[[1]]);
          await change({operation:'password',...account,password:secret+'-changed'});
          const updated={...profile,user:account.user,password:secret+'-changed'};
          assert.deepEqual((await withDatabase(updated,db=>db.query('SELECT id FROM clay_parent WHERE id=1'))).rows,[[1]]);
          await change({operation:'revoke',...account,privileges:['SELECT']});
          await assert.rejects(withDatabase(updated,db=>db.query('SELECT id FROM clay_parent')));
          await change({operation:'drop',...account});
        } finally {
          await withDatabase(profile,db=>db.script("DROP USER IF EXISTS 'clay_account_test'@'127.0.0.1'",row=>row));
        }
      }
      const overview=await request(conn+'/server-status','GET',undefined,admin);
      assert.ok(overview.body.status.some(([name])=>name.toLowerCase()==='uptime'));
      const metrics=(await request(conn+'/server-status?metrics=1','GET',undefined,admin)).body;
      assert.deepEqual(Object.keys(metrics),['status','sessions','sessionsTruncated']);
      const running=withDatabase(profile,db=>db.query('SELECT SLEEP(2) AS active_session_check'));
      try {
        let live;
        for (let tries=0;tries<8 && !live;tries++) {
          const sample=(await request(conn+'/server-status?metrics=1','GET',undefined,admin)).body;
          live=sample.sessions.find(row=>row[7]?.includes('active_session_check'));
          if (!live) await new Promise(resolve=>setTimeout(resolve,50));
        }
        assert.ok(live,'Running query appears in process list');
        assert.equal(live[1],profile.user);
      } finally {await running;}
      const {Server,utils}=ssh2;
      const passphrase='test-passphrase';
      const keypair=utils.generateKeyPairSync('ed25519',{passphrase,cipher:'aes256-ctr'});
      const expected=utils.parseKey(keypair.public).getPublicSSH();
      const clients=new Set();
      let authAttempts=0;
      const startProxy=key=>new Server({hostKeys:[key]},client=>{
        clients.add(client);
        client.on('error',()=>{});
        client.on('close',()=>clients.delete(client));
        client.on('authentication',context=>{
          authAttempts++;
          if (context.username==='tunnel-test' && context.method==='publickey' && context.key.data.equals(expected) &&
              (!context.signature || utils.parseKey(keypair.public).verify(context.blob,context.signature,context.hashAlgo)===true)) {
            context.accept();
          } else context.reject(['publickey']);
        });
        client.on('tcpip',(accept,reject,info)=>{
          if (info.destIP!==profile.host || info.destPort!==profile.port) {reject();return;}
          const stream=connect(profile.port,profile.host);
          stream.once('error',()=>{stream.destroy();});
          const channel=accept();
          channel.once('error',()=>stream.destroy());
          channel.once('close',()=>stream.destroy());
          stream.once('close',()=>channel.destroy());
          channel.pipe(stream).pipe(channel);
        });
      });
      let proxy=startProxy(hostKey);
      proxy.listen(sshPort,'127.0.0.1');
      await once(proxy,'listening');
      try {
        const ssh={host:'127.0.0.1',port:proxy.address().port,user:'tunnel-test',privateKey:keypair.private,passphrase};
        const tunneled={...profile,name:'SSH test',ssh};
        const firstUse=startProxy(hostKey);
        firstUse.listen(0,'127.0.0.1');
        await once(firstUse,'listening');
        try {
          const newcomer={...tunneled,ssh:{...ssh,port:firstUse.address().port}};
          const before=authAttempts;
          const observed=(await request('connection-test','POST',newcomer,admin,409)).body;
          assert.equal(observed.code,'SSH_HOST_KEY_CONFIRMATION');
          assert.equal(observed.endpoint,ssh.host+':'+newcomer.ssh.port);
          assert.match(observed.trust.fingerprint,/^SHA256:[A-Za-z0-9+/]{43}$/);
          await request('connections','POST',{...newcomer,sshApproval:'forged'},admin,409);
          assert.equal(authAttempts,before);
          if (process.env.TEST_DB_NO_TLS==='1') {
            const tlsFailure=await request('connection-test','POST',{...newcomer,tls:true,sshApproval:observed.trust.approval},admin,502);
            assert.equal(tlsFailure.body.code,'HANDSHAKE_NO_SSL_SUPPORT');
            assert.equal(tlsFailure.body.canUseSshEncryption,true);
            const direct=await request('connection-test','POST',{...newcomer,ssh:null,tls:true},admin,502);
            assert.equal(direct.body.canUseSshEncryption,undefined);
          } else await request('connection-test','POST',{...newcomer,sshApproval:observed.trust.approval},admin);
          await request('connection-test','POST',newcomer,admin);
          const {tls,...loopbackProfile}=newcomer;
          const id=(await request('connections','POST',{...loopbackProfile,sshOnlyEncryption:true},admin)).body.id;
          const savedLoopback=(await request('connections/'+id+'/settings','GET',undefined,admin)).body;
          assert.equal(savedLoopback.tls,false);
          assert.equal(savedLoopback.sshOnlyEncryption,true);
          await request('connection-test','POST',{...loopbackProfile,host:'db.example.net',sshOnlyEncryption:true},admin,400);
          await request('connections/'+id+'/sql','POST',{sql:'SELECT 1'},admin);
          await request('connections/'+id,'DELETE',undefined,admin);
        } finally {
          for (const client of clients) client.end();
          await new Promise(resolve=>firstUse.close(resolve));
        }
        const invalid=await request('connection-test','POST',{...tunneled,ssh:{...ssh,passphrase:'wrong'}},admin,502);
        assert.match(invalid.body.error,/passphrase/i);
        if (process.env.TEST_PUTTYGEN==='1') {
          const source=join(directory,'ssh-fixture'), pass=join(directory,'ssh-fixture-pass'), ppk=join(directory,'ssh-fixture.ppk');
          await writeFile(source,keypair.private,{mode:0o600});
          await writeFile(pass,passphrase+'\n',{mode:0o600});
          execFileSync('puttygen',[source,'-O','private','-o',ppk,'--old-passphrase',pass,'--new-passphrase',pass,
            '--ppk-param','version=3'],{stdio:'pipe'});
          const privateKey=await readFile(ppk,'utf8');
          assert.match(privateKey,/^PuTTY-User-Key-File-3: ssh-ed25519/);
          const ppkProfile={...tunneled,ssh:{...ssh,privateKey}};
          await request('connection-test','POST',ppkProfile,admin);
          const wrong=await request('connection-test','POST',{...ppkProfile,ssh:{...ppkProfile.ssh,passphrase:'wrong'}},admin,502);
          assert.match(wrong.body.error,/passphrase/i);
          const noPass=await request('connection-test','POST',{...ppkProfile,ssh:{...ppkProfile.ssh,passphrase:''}},admin,502);
          assert.match(noPass.body.error,/encrypted/i);
          const empty=join(directory,'ssh-fixture-empty'), plain=join(directory,'ssh-fixture-plain.ppk');
          await writeFile(empty,'\n',{mode:0o600});
          execFileSync('puttygen',[source,'-O','private','-o',plain,'--old-passphrase',pass,'--new-passphrase',empty,
            '--ppk-param','version=3'],{stdio:'pipe'});
          await request('connection-test','POST',{...tunneled,ssh:{...ssh,privateKey:await readFile(plain,'utf8'),passphrase:''}},admin);
        }
        const publicOnly=await request('connection-test','POST',{...tunneled,ssh:{...ssh,privateKey:keypair.public}},admin,502);
        assert.match(publicOnly.body.error,/public ssh key/i);
        await request('connection-test','POST',tunneled,admin);
        const savedId=(await request('connections','POST',tunneled,admin)).body.id;
        const savedPath='connections/'+savedId;
        const settings=(await request(savedPath+'/settings','GET',undefined,admin)).body;
        assert.ok(!Object.hasOwn(settings.ssh,'fingerprint'));
        assert.equal(settings.ssh.hasKey,true);
        assert.equal(settings.ssh.hasPassphrase,true);
        assert.ok(!Object.hasOwn(settings.ssh,'privateKey'));
        assert.ok(!Object.hasOwn(settings.ssh,'passphrase'));
        const {tls,...withoutTls}=settings;
        assert.equal(tls,false);
        await request(savedPath+'/settings','PUT',withoutTls,admin);
        assert.equal((await request(savedPath+'/settings','GET',undefined,admin)).body.tls,false);
        const viaSsh=(await request(savedPath+'/sql','POST',{sql:'SELECT 314 AS answer'},admin)).body;
        assert.equal(Number(viaSsh.rows[0][0]),314);
        const wal=await readFile(join(directory,'claydb.sqlite-wal'));
        assert.ok(!wal.includes(passphrase));
        assert.ok(!wal.includes('BEGIN OPENSSH PRIVATE KEY'));
        // Reuse the same endpoint with a different SSH host key.
        for (const client of clients) client.end();
        await new Promise(resolve=>proxy.close(resolve));
        proxy=startProxy(utils.generateKeyPairSync('ed25519').private);
        proxy.listen(ssh.port,'127.0.0.1');
        await once(proxy,'listening');
        const changed=await request(savedPath+'/sql','POST',{sql:'SELECT 1'},admin,502);
        assert.match(changed.body.error,/host key/i);
        await request(savedPath,'DELETE',undefined,admin);
      } finally {
        for (const client of clients) client.end();
        await new Promise(resolve=>proxy.close(resolve));
      }
      assert.ok(overview.body.grants.length);
      const objectPath=conn+'/object-change';
      const event={kind:'EVENT',name:'clay_route_event'};
      const changeObject=async values=>{
        const {body:preview}=await request(objectPath,'POST',{...values,preview:true},admin);
        await request(objectPath,'POST',{...values,confirmation:preview.confirmation},admin);
      };
      await withDatabase(profile,db=>db.script('DROP EVENT IF EXISTS clay_route_event',row=>row));
      const createEvent={...event,operation:'create',amount:1,unit:'DAY',sql:'SELECT 1'};
      await request(objectPath,'POST',createEvent,admin,409);
      await changeObject(createEvent);
      const object=await request(conn+'/object-definition?kind=EVENT&name=clay_route_event','GET',undefined,admin);
      assert.match(object.body.sql,/CREATE.*EVENT/i);
      assert.match(object.body.sql,/DISABLE DO SELECT 1/i);
      await changeObject({...event,operation:'schedule',amount:2,unit:'HOUR'});
      await changeObject({...event,operation:'body',sql:'SELECT 2'});
      assert.match((await request(conn+'/object-definition?kind=EVENT&name=clay_route_event','GET',undefined,admin)).body.sql,/DO SELECT 2/i);
      await changeObject({...event,operation:'enable'});
      const events=(await request(conn+'/database-objects','GET',undefined,admin)).body.events;
      assert.equal(events.find(row=>row[0]===event.name)[1],'ENABLED');
      await changeObject({...event,operation:'disable'});
      await changeObject({...event,operation:'drop'});
      assert.ok(!(await request(conn+'/database-objects','GET',undefined,admin)).body.events.some(row=>row[0]===event.name));
      const script=conn+'/sql-script';
      const probe='SELECT 13 AS first; SELECT 29 AS second';
      const {body:batchPreview}=await request(script,'POST',{sql:probe},admin);
      await request(script,'POST',{sql:probe+'; SELECT 3',confirmation:batchPreview.confirmation},admin,409);
      const {body:batch}=await request(script,'POST',{sql:probe,confirmation:batchPreview.confirmation},admin);
      assert.deepEqual(batch.sets.map(set=>String(set.rows[0][0])),["13","29"]);
      assert.deepEqual(batch.sets.map(set=>set.columns[0]),["first","second"]);
      await withDatabase(profile,db=>db.query('INSERT INTO clay_child(id,parent_id) VALUES (2,1)'));
      const exported=await request(conn+'/database-export','GET',undefined,admin);
      assert.match(exported.body,/FOREIGN_KEY_CHECKS=0/);
      assert.match(exported.body,/CREATE TABLE `clay_child`/);
      assert.match(exported.body,/CREATE TABLE `clay_parent`/);
      assert.doesNotMatch(exported.body,/DROP TABLE/);
      await withDatabase(profile,async db=>{
        await db.query('DROP TABLE clay_child');
        await db.query('DROP TABLE clay_parent');
      });
      const previewDb=await request(script,'POST',{sql:exported.body},admin);
      await request(script,'POST',{sql:exported.body,confirmation:previewDb.body.confirmation},admin);
      await withDatabase(profile,async db=>{
        assert.deepEqual((await db.query('SELECT id,parent_id FROM clay_child')).rows,[[2,1]]);
        await assert.rejects(db.query('INSERT INTO clay_child(id,parent_id) VALUES (3,55)'));
        await db.query('DELETE FROM clay_child WHERE id=2');
      });
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
      await request(editor,'POST',{operation:'change-engine',table:'clay_parent',engine:'MyISAM',preview:true},admin,409);
      await change({operation:'add-column',table,column:{name:'editable',type:'INT',nullable:true}});
      await withDatabase(profile,db=>db.query('INSERT INTO clay_editor_test(id,editable) VALUES (1,42)'));
      const typeChange={operation:'modify-column',table,column:{name:'editable',type:'VARCHAR(64)',nullable:true}};
      await request(editor,'POST',typeChange,admin,409);
      await change(typeChange);
      const typed=await request(editor+'?table='+table,'GET',undefined,admin);
      assert.match(typed.body.columns.find(row=>row[0]==='editable')[1],/^varchar\(64\)$/i);
      assert.deepEqual((await withDatabase(profile,db=>db.query('SELECT editable FROM clay_editor_test'))).rows,[['42']]);
      await change({operation:'drop-foreign-key',table,name:'test_fk'});
      await change({operation:'drop-index',table,name:'test_idx'});
      await change({operation:'rename-column',table,columnName:'parent_id',name:'related_id'});
      await change({operation:'drop-column',table,columnName:'related_id'});
      await change({operation:'change-engine',table,engine:'MyISAM'});
      assert.equal((await request(editor+'?table='+table,'GET',undefined,admin)).body.engine,'MyISAM');
      await change({operation:'change-engine',table,engine:'InnoDB'});
      const empty={operation:'truncate-table',table};
      await request(editor,'POST',empty,admin,409);
      assert.equal((await withDatabase(profile,db=>db.query('SELECT id FROM clay_editor_test'))).rows.length,1);
      await change(empty);
      assert.deepEqual((await withDatabase(profile,db=>db.query('SELECT id FROM clay_editor_test'))).rows,[]);
      await change({operation:'rename-table',table,name:table+'_renamed'});
      await change({operation:'drop-table',table:table+'_renamed'});
    }
    if (pg) {
      const editor=conn+'/structure-editor';
      const selection={schema,table:'clay_parent'};
      const definition=(await request(editor+'?'+new URLSearchParams(selection),'GET',undefined,admin)).body;
      assert.ok(definition.columnChanges.find(([name])=>name==='label')[1]);
      const change=async input=>{
        const operation={...selection,...input};
        await request(editor,'POST',operation,admin,409);
        const {body:preview}=await request(editor,'POST',{...operation,preview:true},admin);
        assert.match(preview.sql,/^ALTER TABLE "public"."clay_parent"/);
        await request(editor,'POST',{...operation,confirmation:preview.confirmation},admin);
      };
      await change({operation:'rename-column',columnName:'label',name:'description'});
      await change({operation:'modify-column',column:{name:'description',type:'VARCHAR(128)',nullable:false}});
      const changed=(await request(editor+'?'+new URLSearchParams(selection),'GET',undefined,admin)).body;
      assert.deepEqual(changed.columns[1],['description','character varying','NO']);
      await change({operation:'modify-column',column:{name:'description',type:'VARCHAR(128)',nullable:true}});
      await change({operation:'rename-column',columnName:'description',name:'label'});
    }
    const editor=conn+'/structure-editor';
    const defaultInput={operation:'set-column-default',schema,table:'clay_parent',columnName:'label',
      defaultValue:"sample ' value \\ slash"};
    await request(editor,'POST',defaultInput,admin,409);
    const {body:defaultPreview}=await request(editor,'POST',{...defaultInput,preview:true},admin);
    await request(editor,'POST',{...defaultInput,confirmation:defaultPreview.confirmation},admin);
    await withDatabase(profile,async db=>{
      await db.query('INSERT INTO clay_parent(id) VALUES (92)');
      assert.deepEqual((await db.query('SELECT label FROM clay_parent WHERE id=92')).rows,[[defaultInput.defaultValue]]);
      await db.query('DELETE FROM clay_parent WHERE id=92');
    });
    const properties=pg
      ? {operation:'set-column-comment',schema,table:'clay_parent',columnName:'label',comment:"A 'quoted' comment"}
      : {operation:'modify-column',table:'clay_parent',column:{name:'label',type:'VARCHAR(128)',nullable:true,
          charset:'utf8mb4',collation:'utf8mb4_bin',comment:"A 'quoted' comment"}};
    const {body:propertiesPreview}=await request(editor,'POST',{...properties,preview:true},admin);
    await request(editor,'POST',{...properties,confirmation:propertiesPreview.confirmation},admin);
    const revised=(await request(editor+'?'+new URLSearchParams({schema,table:'clay_parent'}),'GET',undefined,admin)).body;
    assert.equal((revised.columnDetails ?? revised.columns)[1][pg?8:5],"A 'quoted' comment");
    if (!pg) assert.equal(revised.columns[1][7],'utf8mb4_bin');
    await withDatabase(profile,async db=>{
      await db.query('INSERT INTO clay_parent(id) VALUES (93)');
      assert.deepEqual((await db.query('SELECT label FROM clay_parent WHERE id=93')).rows,[[defaultInput.defaultValue]]);
      await db.query('DELETE FROM clay_parent WHERE id=93');
    });
    const resetDefault={...defaultInput,defaultValue:null};
    const {body:resetPreview}=await request(editor,'POST',{...resetDefault,preview:true},admin);
    await request(editor,'POST',{...resetDefault,confirmation:resetPreview.confirmation},admin);
    const userPermission = 'users/'+readerId+'/permissions';
    const rows = conn+'/rows?schema='+schema+'&table=clay_parent';
    const csv = conn+'/csv?schema='+schema+'&table=clay_parent';
    await request(conn+'/schema','GET',undefined,reader,404);
    await request(userPermission,'PUT',{connection:id,level:'view'},admin);
    const structure = (await request(conn+'/schema','GET',undefined,reader)).body;
    assert.ok(structure.tables.some(table=>table[1]==='clay_child'));
    assert.deepEqual(structure.relations.find(edge=>edge[1]==='clay_child'),[schema,'clay_child',schema,'clay_parent']);
    assert.deepEqual(Object.keys((await request(conn+'/schema?relations=0','GET',undefined,reader)).body),['tables']);
    assert.deepEqual((await request(conn+'/schema-relations','GET',undefined,reader)).body,structure.relations);
    const page = (await request(rows,'GET',undefined,reader)).body;
    assert.deepEqual(page.rows,[[1,'original']]);
    await withDatabase(profile,async db=>{
      for (let i=2;i<=61;i++) await db.query('INSERT INTO clay_parent(id,label) VALUES ('+i+",'page')");
    });
    const firstPage=(await request(rows,'GET',undefined,reader)).body;
    const secondPage=(await request(rows+'&offset=50','GET',undefined,reader)).body;
    assert.equal(firstPage.truncated,true);
    assert.equal(secondPage.truncated,false);
    assert.deepEqual([...firstPage.rows,...secondPage.rows].map(row=>row[0]),Array.from({length:61},(_,i)=>61-i));
    const ascending=rows+'&filter='+encodeURIComponent(JSON.stringify({filters:[],sort:{column:'id',direction:'asc'}}));
    assert.equal((await request(ascending,'GET',undefined,reader)).body.rows[0][0],1);
    await withDatabase(profile,db=>db.query('DELETE FROM clay_parent WHERE id>1'));
    assert.equal(Number(page.definition[0][4].numeric_precision),pg?32:10);
    assert.equal(Number(page.definition[1][4].character_maximum_length),128);
    const views=conn+'/views?schema='+schema+'&table=clay_parent';
    const criteria={filters:[{column:'label',operator:'contains',value:'ori'}],sort:{column:'id',direction:'desc'}};
    await request(views,'POST',{name:'Original rows',view:criteria},reader);
    const {body:stored}=await request(views,'GET',undefined,reader);
    assert.deepEqual(stored[0].view,criteria);
    assert.deepEqual((await request(views,'GET',undefined,admin)).body,[]);
    await request(views+'&id='+stored[0].id,'DELETE',undefined,admin);
    assert.equal((await request(views,'GET',undefined,reader)).body.length,1);
    await request(views+'&id='+stored[0].id,'DELETE',undefined,reader);
    assert.deepEqual((await request(views,'GET',undefined,reader)).body,[]);
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
    await request(rows,'POST',{action:'insert',values:{id:2,label:'two'}},reader);
    const batchPage=(await request(rows,'GET',undefined,reader)).body;
    const selected=batchPage.rows.map(([id],index)=>({key:{id},snapshot:batchPage.snapshots[index]}));
    await request(rows,'POST',{action:'update',rows:[selected[0],{...selected[1],snapshot:'0'.repeat(64)}],
      values:{label:'batch'}},reader,409);
    assert.deepEqual((await request(rows,'GET',undefined,reader)).body.rows,[[2,'two'],[1,'=changed']]);
    await request(rows,'POST',{action:'update',rows:selected,values:{label:'batch'}},reader);
    const updated=(await request(rows,'GET',undefined,reader)).body;
    assert.deepEqual(updated.rows,[[2,'batch'],[1,'batch']]);
    await request(rows,'POST',{action:'delete',rows:[{key:{id:2},snapshot:updated.snapshots[0]}]},reader);
    await request(conn+'/sql','POST',{sql:'SELECT 1'},reader,403);
    await request(userPermission,'PUT',{connection:id,level:'sql'},admin);
    assert.deepEqual((await request(conn+'/sql','POST',{sql:'SELECT id FROM clay_parent'},reader)).body.rows,[[1]]);
    await request(conn+'/sql','POST',{sql:'SELECT 1; SELECT 2'},reader,502);
    const duplicateTable='clay_duplicate_test';
    const duplicateRows=conn+'/rows?schema='+schema+'&table='+duplicateTable;
    await withDatabase(profile,async db=>{
      await db.query('DROP TABLE IF EXISTS '+duplicateTable);
      await db.query('CREATE TABLE '+duplicateTable+(pg?' (id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label VARCHAR(80))':
        ' (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(80)) ENGINE=InnoDB'));
      await db.query("INSERT INTO "+duplicateTable+" (label) VALUES ('copy me')");
    });
    const original=(await request(duplicateRows,'GET',undefined,reader)).body;
    await request(duplicateRows,'POST',{action:'copy',rows:[{key:{id:1},snapshot:original.snapshots[0]}]},reader);
    assert.deepEqual((await request(duplicateRows,'GET',undefined,reader)).body.rows,[[2,'copy me'],[1,'copy me']]);
    const combined={schema,table:duplicateTable,operation:pg?'edit-column':'modify-column',column:{
      name:'label',newName:'description',type:'VARCHAR(96)',nullable:true,defaultValue:'initial',comment:'Combined edit',
    }};
    const {body:combinedPreview}=await request(editor,'POST',{...combined,preview:true},admin);
    await request(editor,'POST',{...combined,confirmation:combinedPreview.confirmation},admin);
    await withDatabase(profile,async db=>{
      assert.deepEqual((await db.query('SELECT description FROM '+duplicateTable+' ORDER BY id')).rows,[['copy me'],['copy me']]);
    });
    const beforeUndo=(await request(duplicateRows,'GET',undefined,reader)).body;
    await request(duplicateRows,'POST',{action:'update',key:{id:1},values:{description:'updated'},
      snapshot:beforeUndo.snapshots[1]},reader);
    const history=(await request('audit','GET',undefined,admin)).body;
    const entry=history.entries.find(item=>item.action==='row.update' && item.actor==='reader');
    assert.equal(entry.undo_state,'ready');
    await request('audit/'+entry.id,'GET',undefined,reader,403);
    const detail=(await request('audit/'+entry.id,'GET',undefined,admin)).body;
    assert.match(detail.statements[0].sql,/^UPDATE /);
    assert.deepEqual(detail.rollback[0].parameters,['copy me',1]);
    await request('audit/'+entry.id+'/undo','POST',{confirmed:false},admin,409);
    await withDatabase(profile,db=>db.query("UPDATE "+duplicateTable+" SET description='newer' WHERE id=1"));
    await request('audit/'+entry.id+'/undo','POST',{confirmed:true},admin,409);
    await withDatabase(profile,db=>db.query("UPDATE "+duplicateTable+" SET description='updated' WHERE id=1"));
    await request('audit/'+entry.id+'/undo','POST',{confirmed:true},admin);
    await request('audit/'+entry.id+'/undo','POST',{confirmed:true},admin,409);
    assert.equal((await request('audit/'+entry.id,'GET',undefined,admin)).body.undoState,'done');
    assert.equal((await request(duplicateRows,'GET',undefined,reader)).body.rows[1][1],'copy me');
    await request(conn+'/sql','POST',{sql:'SELECT 31415'},reader);
    const sqlEvent=(await request('audit','GET',undefined,admin)).body.entries.find(item=>item.action==='sql.execute');
    const sqlDetail=(await request('audit/'+sqlEvent.id,'GET',undefined,admin)).body;
    assert.equal(sqlDetail.statements[0].sql,'SELECT 31415');
    assert.equal(sqlDetail.undoState,'unavailable');
    await withDatabase(profile,db=>db.query('DROP TABLE '+duplicateTable));
    await request(userPermission,'PUT',{connection:id,level:null},admin);
    await request(rows,'GET',undefined,reader,404);
    await request(conn,'DELETE',undefined,admin);
  });

  await request('password','POST',{current:initial,password:'replacement-password-123'},admin);
  await assert.rejects(readFile(join(directory,'initial-admin.txt')),{code:'ENOENT'});
  await request('login','POST',{name:'admin',password:initial},'',401);
  const {body:log} = await request('audit','GET',undefined,admin);
  if (log.next!==null) {
    const older=(await request('audit?before='+log.next,'GET',undefined,admin)).body;
    assert.ok(older.entries.length && older.entries.every(entry=>entry.id<log.next));
    log.entries.push(...older.entries);
  }
  assert.ok(log.entries.some(e=>e.action==='login' && e.status===401 && e.actor===null));
  if (process.env.TEST_DB_ENGINE) {
    assert.ok(log.entries.some(e=>e.action==='permission.change' && e.actor==='admin' && e.subject_id===readerId && e.status===200));
    assert.ok(log.entries.some(e=>e.action==='sql.execute' && e.status===403));
    assert.ok(log.entries.some(e=>e.action==='csv.export' && e.actor==='reader' && e.status===200));
    assert.ok(log.entries.some(e=>e.action==='row.write' && e.actor==='reader' && e.status===403));
  }
  for (const secret of [initial,'test-reader-pass']) {
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
