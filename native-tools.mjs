import { identifier, structure, columns } from './database.mjs';

export function parseCsv(source) {
  const text=source.replace(/^\uFEFF/,'');
  const rows=[];
  let row=[], value='', state='start';
  function cell() {row.push(value);value='';state='start';}
  function endRow() {
    cell();
    rows.push(row);
    if (rows.length>201) throw new RangeError('Too many rows');
    row=[];
  }
  for (let index=0;index<text.length;index++) {
    const ch=text[index];
    if (state==='quoted') {
      if (ch==='"' && text[index+1]==='"') {value+='"';index++;}
      else if (ch==='"') state='closed';
      else value+=ch;
    } else if (ch===',') cell();
    else if (ch==='\r' || ch==='\n') {
      if (ch==='\r' && text[index+1]==='\n') index++;
      endRow();
    } else if (ch==='"' && state==='start') state='quoted';
    else if (ch==='"' || state==='closed') throw new SyntaxError('Invalid CSV quoting');
    else {value+=ch;state='bare';}
  }
  if (state==='quoted') throw new SyntaxError('Unclosed CSV quote');
  if (row.length || state!=='start') endRow();
  if (rows.length<2 || rows[0].length>64 || rows.some(current=>current.length!==rows[0].length)) {
    throw new SyntaxError('Invalid CSV dimensions');
  }
  return rows;
}

export async function importCsv(db,database,table,header,rows,confirm) {
  const info=await db.query(
    'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND TABLE_TYPE=\'BASE TABLE\'',[database,table]);
  if (String(info.rows[0]?.[0]).toLowerCase()!=='innodb') return null;
  const fields=(await columns(db,database,table)).map(([name])=>name);
  if (new Set(header).size!==header.length || !header.every(name=>fields.includes(name))) return null;
  if (!confirm) return {rows:rows.length,columns:header};
  const quote=name=>identifier(false,name);
  const sql='INSERT INTO '+quote(database)+'.'+quote(table)+' ('+header.map(quote).join(', ')+
    ') VALUES '+rows.map(()=> '('+header.map(()=>'?').join(', ')+')').join(', ');
  return db.transaction(async()=>({rows:(await db.query(sql,rows.flat())).affected}));
}

export async function searchDatabase(db,text,offset) {
  const tables=(await structure(db)).filter(([, ,type])=>type==='BASE TABLE');
  const batch=tables.slice(offset,offset+5);
  const find='%'+text.replace(/[!%_]/g,symbol=>'!'+symbol)+'%';
  const quote=name=>identifier(false,name);
  const results=[];
  let skipped=0;
  for (const [schema,table] of batch) {
    const fields=await db.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND DATA_TYPE IN ('char','varchar','tinytext','text','mediumtext','longtext','enum','set') ORDER BY ORDINAL_POSITION LIMIT 30",[schema,table]);
    const names=fields.rows.map(([name])=>name);
    if (!names.length) {skipped++;continue;}
    const where=names.map(name=>"LOWER("+quote(name)+") LIKE LOWER(?) ESCAPE '!'").join(' OR ');
    const found=await db.query('SELECT '+names.map(name=>'LEFT('+quote(name)+', 250)').join(', ')+
      ' FROM '+quote(schema)+'.'+quote(table)+' WHERE '+where+' LIMIT 6',names.map(()=>find));
    if (found.rows.length) results.push({schema,table,columns:names,rows:found.rows.slice(0,5),more:found.rows.length>5});
  }
  return {results,skipped,next:offset+batch.length<tables.length?offset+batch.length:null};
}

export async function databaseObjects(db,database) {
  const routines=await db.query(
    'SELECT ROUTINE_NAME,ROUTINE_TYPE,SQL_DATA_ACCESS FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? ORDER BY ROUTINE_NAME LIMIT 200',[database]);
  const triggers=await db.query(
    'SELECT TRIGGER_NAME,EVENT_OBJECT_TABLE,ACTION_TIMING,EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY TRIGGER_NAME LIMIT 200',[database]);
  const events=await db.query(
    'SELECT EVENT_NAME,STATUS,EVENT_TYPE FROM information_schema.EVENTS WHERE EVENT_SCHEMA=? ORDER BY EVENT_NAME LIMIT 200',[database]);
  return {routines:routines.rows,triggers:triggers.rows,events:events.rows};
}

export async function exportTableSql(db,database,table) {
  const quote=name=>identifier(false,name);
  const info=await db.query(
    "SELECT COLUMN_NAME,DATA_TYPE,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION",[database,table]);
  const tables=await db.query(
    "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",[database,table]);
  if (tables.rows[0]?.[0]!=='BASE TABLE' || !info.rows.length) return {error:'table'};
  const included=info.rows.filter(([, ,extra])=>!/(?:VIRTUAL|STORED|PERSISTENT) GENERATED/i.test(extra));
  if (included.some(([,type])=>/^(?:geometry|point|linestring|polygon|multi(?:point|linestring|polygon)|geometrycollection|vector)$/.test(type))) {
    return {error:'type'};
  }
  const binary=type=>/^(?:bit|binary|varbinary|tinyblob|blob|mediumblob|longblob)$/.test(type);
  const ref=quote(database)+'.'+quote(table);
  const create=(await db.query('SHOW CREATE TABLE '+ref)).rows[0][1];
  const projections=included.map(([name,type])=>{
    const column=quote(name);
    const hex=binary(type)?'HEX(CAST('+column+' AS BINARY))':'HEX(CONVERT('+column+' USING utf8mb4))';
    return "CASE WHEN OCTET_LENGTH("+column+") > 131072 THEN '!oversize' ELSE "+hex+" END";
  });
  const order=(await columns(db,database,table)).filter(row=>row[3]).map(([name])=>quote(name));
  const data=await db.query('SELECT '+(projections.length?projections.join(', '):'1')+' FROM '+ref+
    (order.length?' ORDER BY '+order.join(', '):'')+' LIMIT 1001',[],1001,1048576);
  if (data.rows.length>1000) return {error:'size'};
  const statement='INSERT INTO '+quote(table)+' ('+included.map(([name])=>quote(name)).join(', ')+') VALUES (';
  let sql='-- AbDbAdmin table export; run in the intended database.\n'+create+';\n';
  for (const row of data.rows) {
    if (row.includes('!oversize')) return {error:'size'};
    const values=included.map(([,type],i)=>row[i]===null?'NULL':binary(type)
      ? "X'"+row[i]+"'"
      : "CONVERT(X'"+row[i]+"' USING utf8mb4)");
    sql+=statement+values.join(', ')+');\n';
    if (Buffer.byteLength(sql)>1048576) return {error:'size'};
  }
  return {sql,rows:data.rows.length};
}

export async function serverOverview(db) {
  const keep=row=>row.map(value=>value==null?null:String(value));
  const status=await db.query("SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Questions','Slow_queries','Bytes_received','Bytes_sent')");
  const variables=await db.query("SHOW GLOBAL VARIABLES WHERE Variable_name IN ('version','version_comment','max_connections','read_only','character_set_server','collation_server','event_scheduler')");
  const grants=await db.query('SHOW GRANTS FOR CURRENT_USER');
  return {status:status.rows.map(keep),variables:variables.rows.map(keep),grants:grants.rows.map(keep)};
}

export async function objectDefinition(db,database,kind,name) {
  const quote=value=>identifier(false,value);
  const ref=quote(database)+'.'+quote(name);
  const result=(await db.script('SHOW CREATE '+kind+' '+ref,row=>row)).sets[0];
  const column=result?.columns.findIndex(title=>/^(?:Create (?:Procedure|Function|Event)|SQL Original Statement)$/i.test(title));
  const sql=column>=0?result.rows[0]?.[column]:null;
  return typeof sql==='string'?sql:Buffer.isBuffer(sql)?sql.toString('utf8'):null;
}
