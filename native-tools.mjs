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
