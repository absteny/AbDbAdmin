import { createHash, timingSafeEqual } from 'node:crypto';
import { tableViewSql } from './table-view.mjs';
const visible = "table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg_toast%' AND table_schema NOT LIKE 'pg_temp%'";
const scope = (pg, alias = '') => pg ? visible.replaceAll('table_schema', alias + 'table_schema') : alias + 'table_schema = DATABASE()';
const timeout = 10000;

export function identifier(pg, value) {
  const quote = pg ? '"' : '`';
  return quote + value.replaceAll(quote, quote + quote) + quote;
}

function sshError(code) {
  return Object.assign(new Error(code),{code});
}

export async function observeSshHostKey({host,port}) {
  const {default:{Client}}=await import('ssh2');
  const ssh=new Client();
  try {
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(sshError('SSH_TIMEOUT')),7500);
      const finish=(error,value)=>{
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      ssh.on('error',error=>finish(sshError(error.level==='client-timeout'?'SSH_TIMEOUT':'SSH_CONNECTION_FAILED')));
      ssh.once('close',()=>finish(sshError('SSH_CONNECTION_FAILED')));
      try {
        ssh.connect({host,port,username:'abdbadmin',readyTimeout:7000,hostVerifier:raw=>{
          const fingerprint='SHA256:'+createHash('sha256').update(raw).digest('base64').replace(/=$/,'');
          finish(null,fingerprint);
          return false;
        }});
      } catch {finish(sshError('SSH_CONNECTION_FAILED'));}
    });
  } finally {ssh.destroy();}
}

async function openSshChannel(profile) {
  const {default:{Client}}=await import('ssh2');
  const {host,port,user,privateKey,passphrase,fingerprint}=profile.ssh;
  const ssh=new Client();
  if (!fingerprint) throw sshError('SSH_HOST_KEY_UNCONFIGURED');
  const expected=Buffer.from(fingerprint.slice(7),'base64');
  let verified=false, failure;
  try {
    const channel=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(sshError('SSH_TIMEOUT')),10000);
      const settle=(error,stream)=>{
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(stream);
      };
      ssh.on('error',error=>settle(sshError(failure ??
        (error.level==='client-authentication'?'SSH_AUTH_FAILED':error.level==='client-timeout'?'SSH_TIMEOUT':'SSH_CONNECTION_FAILED'))));
      ssh.once('close',()=>settle(sshError(failure ?? 'SSH_CONNECTION_FAILED')));
      ssh.once('ready',()=>{
        ssh.forwardOut('127.0.0.1',0,profile.host,profile.port,(error,stream)=>{
          if (error) {settle(sshError('SSH_FORWARD_FAILED'));return;}
          stream.on('error',()=>{});
          settle(null,stream);
        });
      });
      try {
        ssh.connect({host,port,username:user,privateKey,passphrase:passphrase || undefined,readyTimeout:7000,hostVerifier:raw=>{
          const actual=createHash('sha256').update(raw).digest();
          verified=expected.length===actual.length && timingSafeEqual(expected,actual);
          if (!verified) failure='SSH_HOST_KEY_MISMATCH';
          return verified;
        }});
      } catch (error) {
        settle(sshError(/privateKey/i.test(error.message)?'SSH_KEY_INVALID':'SSH_CONNECTION_FAILED'));
      }
    });
    return {channel,ssh};
  } catch (error) {
    ssh.destroy();
    throw error;
  }
}

export async function withDatabase(profile, fn, {scripts=false}={}) {
  const pg = profile.engine === 'postgres';
  const address = {
    host: profile.host, port: profile.port, user: profile.user,
    password: profile.password, database: profile.database,
  };
  let client, tunnel;
  let Query;
  try {
    if (pg) {
      const { default: pgDriver } = await import('pg');
      const { Client, types } = pgDriver;
      Query = pgDriver.Query;
      client = new Client({
        ...address, connectionTimeoutMillis: 5000, statement_timeout: timeout,
        types: {getTypeParser: (oid, format) => [114,1082,1114,1184,3802].includes(oid) && format !== 'binary' ? value => value : types.getTypeParser(oid,format)},
        ssl: profile.tls ? { rejectUnauthorized: true, ca: profile.ca || undefined } : false,
      });
      client.on('error', () => {});
      await client.connect();
    } else {
      const { default: mysql } = await import('mysql2');
      if (profile.ssh) tunnel=await openSshChannel(profile);
      client = mysql.createConnection({
        ...address, ...(tunnel?{stream:tunnel.channel}:{}), connectTimeout: 5000, multipleStatements: scripts, rowsAsArray: true, flags: '-LOCAL_FILES',
        supportBigNumbers: true, bigNumberStrings: true, dateStrings: true,
        ssl: profile.tls ? { rejectUnauthorized: true, verifyIdentity: true, ca: profile.ca || undefined } : undefined,
      });
      client.on('error', () => {});
      await client.promise().connect();
    }
    return await fn({
      pg,
      async script(sql, sanitize) {
        return new Promise((resolve,reject)=>{
          const sets=[];
          const command=client.query({sql,timeout});
          const timer=setTimeout(()=>reject(Object.assign(new Error('Script timed out'),{code:'QUERY_TIMEOUT'})),timeout+2000);
          let truncated=false, bytes=0;
          function result(index) {
            if (index>=25) {truncated=true;return null;}
            return sets[index] ??= {columns:[],rows:[],affected:null,truncated:false};
          }
          // mysql2 Query omits the result index on field and OK packet events.
          let current=-1;
          const currentIndex=index=>Number.isInteger(index)?index:current;
          command.on('fields',fields=>{
            current++;
            if (!fields) return;
            const set=result(current);
            if (set) set.columns=fields.map(field=>field.name);
          });
          command.on('result',(row,index)=>{
            const set=result(currentIndex(index));
            if (!set) return;
            if (!Array.isArray(row)) set.affected=row.affectedRows ?? null;
            else if (set.rows.length<100 && bytes<=1048576) {
              const clean=sanitize(row);
              bytes+=Buffer.byteLength(JSON.stringify(clean));
              if (bytes<=1048576) set.rows.push(clean);
              else set.truncated=true;
            } else set.truncated=true;
          });
          command.once('error',error=>{clearTimeout(timer);reject(error);});
          command.once('end',()=>{clearTimeout(timer);resolve({sets:sets.filter(Boolean),truncated});});
        });
      },
      async transaction(callback) {
        const control = pg ? client : client.promise();
        await control.query('START TRANSACTION');
        try {
          const result = await callback();
          await control.query('COMMIT');
          return result;
        } catch (error) {
          try {await control.query('ROLLBACK');} catch {}
          throw error;
        }
      },
      async query(sql, values = [], cap = Infinity, maxBytes = Infinity) {
        return new Promise((resolve, reject) => {
          const rows = [];
          const timer = setTimeout(() => reject(Object.assign(new Error('Query timed out'),{code:'QUERY_TIMEOUT'})),timeout+2000);
          let columns = [];
          let affected = null;
          let bytes=0;
          const accept = row => {
            if (rows.length>=cap || bytes>maxBytes) return;
            if (maxBytes!==Infinity) bytes+=Buffer.byteLength(JSON.stringify(row));
            if (bytes>maxBytes) {
              fail(Object.assign(new Error('Export too large'),{code:'EXPORT_TOO_LARGE'}));
              return;
            }
            rows.push(row);
          };
          const fail = error => {clearTimeout(timer);reject(error);};
          const done = () => {clearTimeout(timer);resolve({columns,rows,affected});};
          try {
            if (pg) {
              const command = new Query({text:sql,values,rowMode:'array',queryMode:'extended'});
              command.on('row',accept);
              command.once('error',fail);
              command.once('end',result => {
                columns = result.fields.map(field=>field.name);
                affected = result.rowCount;
                done();
              });
              client.query(command);
            } else {
              const command = client.execute({sql,timeout},values);
              command.on('fields',(fields,index=0) => {
                if (fields && index===0) columns = fields.map(field=>field.name);
              });
              command.on('result',(row,index=0) => {
                if (index!==0) return;
                if (Array.isArray(row)) accept(row);
                else affected = row.affectedRows ?? null;
              });
              command.once('error',fail);
              command.once('end',done);
            }
          } catch (error) {fail(error);}
        });
      },
    });
  } finally {
    if (pg) await client?.end();
    else {
      client?.destroy();
      tunnel?.ssh.destroy();
    }
  }
}

export async function structure({query, pg}, {catalog=false}={}) {
  const {rows} = await query(
    `SELECT table_schema, table_name, table_type${catalog && !pg
      ? ', TABLE_ROWS, ENGINE, TABLE_COLLATION, COALESCE(DATA_LENGTH,0)+COALESCE(INDEX_LENGTH,0), DATA_FREE' : ''}
     FROM information_schema.tables WHERE ${scope(pg)}
     ORDER BY table_schema, table_name${catalog?'':' LIMIT 500'}`);
  return rows;
}

export async function columns({query, pg}, schema, table, details = false) {
  const marks = pg ? ['$1','$2'] : ['?','?'];
  const common = ['column_default','character_maximum_length','numeric_precision','numeric_scale','datetime_precision',
    'collation_name','character_set_name','generation_expression'];
  const properties = common.concat(pg ? ['udt_name','is_identity','identity_generation','is_generated']
    : ['column_type','column_key','extra','column_comment']);
  const metadata = details ? ', '+properties.map(name=>'c.'+name).join(', ') : '';
  const {rows} = await query(
    `SELECT c.column_name, c.data_type, c.is_nullable,
     EXISTS (SELECT 1 FROM information_schema.table_constraints t
       JOIN information_schema.key_column_usage k ON k.constraint_schema=t.constraint_schema
       AND k.constraint_name=t.constraint_name AND k.table_schema=t.table_schema AND k.table_name=t.table_name
       WHERE t.constraint_type='PRIMARY KEY' AND c.table_schema=t.table_schema
       AND c.table_name=t.table_name AND k.column_name=c.column_name)${metadata}
     FROM information_schema.columns c WHERE ${scope(pg, 'c.')}
       AND c.table_schema=${marks[0]} AND c.table_name=${marks[1]} ORDER BY c.ordinal_position`, [schema, table]);
  return details ? rows.map(row=>[...row.slice(0,4),Object.fromEntries(properties.map((name,index)=>[name,row[index+4]]))]) : rows;
}

export async function relations({query, pg}) {
  const sql = pg ? `SELECT DISTINCT child_ns.nspname, child.relname, parent_ns.nspname, parent.relname
    FROM pg_catalog.pg_constraint fk
    JOIN pg_catalog.pg_class child ON child.oid=fk.conrelid
    JOIN pg_catalog.pg_namespace child_ns ON child_ns.oid=child.relnamespace
    JOIN pg_catalog.pg_class parent ON parent.oid=fk.confrelid
    JOIN pg_catalog.pg_namespace parent_ns ON parent_ns.oid=parent.relnamespace
    WHERE fk.contype='f'
      AND pg_catalog.has_table_privilege(child.oid,'SELECT')
      AND pg_catalog.has_table_privilege(parent.oid,'SELECT')
    ORDER BY 1,2,3,4 LIMIT 2500`
    : `SELECT DISTINCT table_schema, table_name, referenced_table_schema, referenced_table_name
       FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND referenced_table_name IS NOT NULL LIMIT 2500`;
  return (await query(sql)).rows;
}

export async function tableData(db, schema, table, offset, limit, view = {filters:[]}, details = true) {
  const definition = await columns(db, schema, table, details);
  if (!definition.length) return null;
  const quote = value => identifier(db.pg, value);
  const args = [];
  const clause = tableViewSql(definition,view,db.pg?'postgres':'mysql',quote,value=>{
    args.push(value);
    return db.pg?'$'+args.length:'?';
  });
  if (clause===null) return {invalidView:true};
  return {
    ...await db.query(`SELECT * FROM ${quote(schema)}.${quote(table)}${clause} LIMIT ${limit} OFFSET ${offset}`,args),
    definition,
  };
}
