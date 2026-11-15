import { identifier } from './database.mjs';

export const columnTypes = [
  'BIGINT','INT','SMALLINT','TINYINT','DECIMAL(18,2)','DOUBLE',
  'VARCHAR(32)','VARCHAR(64)','VARCHAR(128)','VARCHAR(255)','VARCHAR(512)','TEXT','DATE','DATETIME','TIMESTAMP','JSON','BLOB',
];

export const mysqlTypeFamilies = [
  'TINYINT','SMALLINT','MEDIUMINT','INT','BIGINT','DECIMAL','FLOAT','DOUBLE',
  'CHAR','VARCHAR','BINARY','VARBINARY','BIT','TINYTEXT','TEXT','MEDIUMTEXT','LONGTEXT',
  'TINYBLOB','BLOB','MEDIUMBLOB','LONGBLOB','DATE','DATETIME','TIME','TIMESTAMP','YEAR','JSON','GEOMETRY',
];

function mysqlColumnType(value) {
  if (typeof value!=='string' || value.length>96) return null;
  const match=/^([A-Z]+)(?:\((\d{1,5})(?:,(\d{1,5}))?\))?( UNSIGNED)?( ZEROFILL)?$/i.exec(value.trim());
  if (!match) return null;
  const [,raw,size,scale,unsigned,zerofill]=match;
  const type=raw.toUpperCase();
  if (!mysqlTypeFamilies.includes(type)) return null;
  const numeric=['TINYINT','SMALLINT','MEDIUMINT','INT','BIGINT','DECIMAL','FLOAT','DOUBLE'].includes(type);
  if (!numeric && (unsigned || zerofill)) return null;
  const length=Number(size);
  const places=Number(scale);
  if (['VARCHAR','VARBINARY','CHAR','BINARY','BIT'].includes(type)) {
    const max=type==='BIT'?64:['CHAR','BINARY'].includes(type)?255:65535;
    if (!size || length<1 || length>max || scale) return null;
  } else if (type==='DECIMAL') {
    if (size && (length<1 || length>65 || scale && (places>30 || places>length))) return null;
  } else if (['DATETIME','TIME','TIMESTAMP'].includes(type)) {
    if (scale || size && length>6) return null;
  } else if (size && (!numeric || length<1 || length>255 || scale)) return null;
  return type+(size?'('+length+(scale?','+places:'')+')':'')+(unsigned?' UNSIGNED':'')+(zerofill?' ZEROFILL':'');
}

export const tableEngines=['InnoDB','MyISAM'];

function columnDefault(value,pg=false) {
  if (value===null) return 'DROP DEFAULT';
  if (typeof value!=='string' || value.length>1024 || value.includes('\0')) throw new TypeError('Invalid default');
  const escaped=(pg?value.replaceAll('\\','\\\\'):value).replaceAll("'","''");
  return 'SET DEFAULT '+(pg?'E':'')+"'"+escaped+"'";
}

export function schemaStatement(database,input,definition) {
  const valid = name=>typeof name==='string' && name.length>0 && name.length<=64 && !/[\u0000-\u001f\u007f]/.test(name) && !name.endsWith(' ');
  const quote = name=>{
    if (!valid(name)) throw new TypeError('Invalid identifier');
    return identifier(false,name);
  };
  const inputColumn=column=>{
    const type=mysqlColumnType(column?.type);
    if (!type || typeof column.nullable!=='boolean') throw new TypeError('Invalid column definition');
    return quote(column.name)+' '+type+(column.nullable?' NULL':' NOT NULL');
  };
  const schema=identifier(false,database);
  const table=schema+'.'+quote(input.table);
  const alter='ALTER TABLE '+table+' ';
  switch (input.operation) {
    case 'create-table': {
      if (!Array.isArray(input.columns) || !input.columns.length || input.columns.length>30) throw new TypeError('Invalid columns');
      const fields=input.columns.map(inputColumn);
      const primary=input.columns.filter(column=>column.primary);
      if (primary.length) fields.push('PRIMARY KEY ('+primary.map(column=>quote(column.name)).join(', ')+')');
      return 'CREATE TABLE '+table+' ('+fields.join(', ')+')';
    }
    case 'rename-table': return 'RENAME TABLE '+table+' TO '+schema+'.'+quote(input.name);
    case 'drop-table': return 'DROP TABLE '+table;
    case 'truncate-table': return 'TRUNCATE TABLE '+table;
    case 'add-column': return alter+'ADD COLUMN '+inputColumn(input.column);
    case 'modify-column': {
      inputColumn(input.column);
      const type=mysqlColumnType(input.column.type);
      const current=definition?.columnChanges.find(([name])=>name===input.column?.name);
      if (!current?.[1]) return null;
      const charset=/^(?:VAR)?CHAR\(|^(?:TINY|MEDIUM|LONG)?TEXT$/.test(type) && current[2] && current[3]
        ? ' CHARACTER SET '+current[2]+' COLLATE '+current[3] : '';
      if (current[5] && (input.column.nullable || !/^(?:TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT)\b/.test(type))) return null;
      const comment=definition.columns.find(([name])=>name===input.column.name)?.[5];
      if (current[4]!=null && !/^(?:TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT|DECIMAL|FLOAT|DOUBLE)\b/.test(type)) return null;
      return alter+'MODIFY COLUMN '+quote(input.column.name)+' '+type+charset+
        (input.column.nullable?' NULL':' NOT NULL')+(current[4]==null?'':' DEFAULT '+current[4])+
        (current[5]?' AUTO_INCREMENT':'')+(comment?' COMMENT '+columnDefault(comment).slice('SET DEFAULT '.length):'');
    }
    case 'change-engine':
      if (!tableEngines.includes(input.engine)) throw new TypeError('Invalid engine');
      if (!definition || (input.engine==='MyISAM' && definition.hasForeignKeys)) return null;
      return alter+'ENGINE='+input.engine;
    case 'set-column-default': return alter+'ALTER COLUMN '+quote(input.columnName)+' '+columnDefault(input.defaultValue);
    case 'rename-column': return alter+'RENAME COLUMN '+quote(input.columnName)+' TO '+quote(input.name);
    case 'drop-column': return alter+'DROP COLUMN '+quote(input.columnName);
    case 'add-index': {
      if (!Array.isArray(input.keys) || !input.keys.length || input.keys.length>16) throw new TypeError('Invalid index columns');
      return alter+'ADD '+(input.unique===true?'UNIQUE ':'')+'INDEX '+quote(input.name)+' ('+input.keys.map(quote).join(', ')+')';
    }
    case 'drop-index': return alter+'DROP INDEX '+quote(input.name);
    case 'add-foreign-key':
      return alter+'ADD CONSTRAINT '+quote(input.name)+' FOREIGN KEY ('+quote(input.columnName)+') REFERENCES '+
        schema+'.'+quote(input.referencedTable)+' ('+quote(input.referencedColumn)+')';
    case 'drop-foreign-key': return alter+'DROP FOREIGN KEY '+quote(input.name);
    default: throw new TypeError('Invalid operation');
  }
}

export async function tableDefinition(db,database,table) {
  const args=[database,table];
  const objects=await db.query(
    'SELECT TABLE_TYPE,ENGINE,TABLE_COLLATION,TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',args);
  if (objects.rows[0]?.[0]!=='BASE TABLE') return null;
  const columns=await db.query(
    'SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,COLUMN_COMMENT,CHARACTER_SET_NAME,COLLATION_NAME,COLUMN_KEY,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',args);
  const indexes=await db.query(
    'SELECT INDEX_NAME,COLUMN_NAME,NON_UNIQUE,INDEX_TYPE,SUB_PART,COLLATION FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',args);
  const foreignKeys=await db.query(
    `SELECT k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.UPDATE_RULE,r.DELETE_RULE
      FROM information_schema.KEY_COLUMN_USAGE k LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME
      WHERE k.TABLE_SCHEMA=? AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION`,args);
  const incoming=await db.query(
    'SELECT 1 FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME=? LIMIT 1',args);
  const simpleName=value=>value==null || /^[a-z0-9_]+$/i.test(value);
  const numeric=/^(?:TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT|DECIMAL|FLOAT|DOUBLE)\b/i;
  const columnChanges=columns.rows.map(([name,type,nullable,defaultValue,extra,comment,charset,collation,,generated])=>{
    const hasDefault=defaultValue!==null && !(nullable==='YES' && defaultValue==='NULL');
    const numericDefault=hasDefault && numeric.test(type) && /^-?\d+(?:\.\d+)?$/.test(defaultValue)?defaultValue:null;
    const auto=extra.toLowerCase()==='auto_increment';
    return [name,(!hasDefault || numericDefault!==null) && (!extra || auto) && !generated &&
      comment.length<=1024 && Boolean(mysqlColumnType(type)) && simpleName(charset) && simpleName(collation),
      charset,collation,numericDefault,auto];
  });
  return {engine:objects.rows[0][1],collation:objects.rows[0][2],comment:objects.rows[0][3],columns:columns.rows,columnChanges,
    hasForeignKeys:Boolean(foreignKeys.rows.length || incoming.rows.length),indexes:indexes.rows,foreignKeys:foreignKeys.rows};
}

export const postgresColumnTypes = [
  'BIGINT','INTEGER','SMALLINT','NUMERIC(18,2)','DOUBLE PRECISION','BOOLEAN',
  'VARCHAR(32)','VARCHAR(64)','VARCHAR(128)','VARCHAR(255)','VARCHAR(512)','TEXT',
  'DATE','TIMESTAMP','TIMESTAMPTZ','JSON','JSONB','BYTEA','UUID',
];

export async function postgresTableDefinition(db,schema,table) {
  const {rows}=await db.query(
    `SELECT c.column_name,c.data_type,c.is_nullable,c.is_identity,c.is_generated,c.column_default,c.collation_name,c.generation_expression,
       pg_catalog.format_type(a.atttypid,a.atttypmod),pg_catalog.col_description(a.attrelid,a.attnum),c.identity_generation
     FROM information_schema.columns c JOIN information_schema.tables t
       ON t.table_schema=c.table_schema AND t.table_name=c.table_name
     JOIN pg_catalog.pg_namespace n ON n.nspname=c.table_schema
     JOIN pg_catalog.pg_class r ON r.relnamespace=n.oid AND r.relname=c.table_name
     JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attname=c.column_name AND NOT a.attisdropped
     WHERE c.table_schema=$1 AND c.table_name=$2 AND t.table_type='BASE TABLE'
       AND c.table_schema NOT IN ('pg_catalog','information_schema')
       AND c.table_schema NOT LIKE 'pg_toast%' AND c.table_schema NOT LIKE 'pg_temp%'
     ORDER BY c.ordinal_position`,[schema,table]);
  if (!rows.length) return null;
  const indexes=(await db.query('SELECT indexname,indexdef FROM pg_catalog.pg_indexes WHERE schemaname=$1 AND tablename=$2 ORDER BY indexname',[schema,table])).rows;
  const constraints=(await db.query(`SELECT c.conname,c.contype,pg_catalog.pg_get_constraintdef(c.oid)
    FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class r ON r.oid=c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname=$1 AND r.relname=$2 ORDER BY c.conname`,[schema,table])).rows;
  return {columns:rows.map(row=>row.slice(0,3)),columnDetails:rows.map(([name,,nullable,identity,generated,defaultValue,collation,
    expression,type,comment,identityGeneration])=>[name,type,nullable,defaultValue,collation,identityGeneration ?? identity,generated,expression,comment]),
    indexes,constraints,columnChanges:rows.map(([name,,,identity,generated])=>[name,identity==='NO' && generated==='NEVER'])};
}

function postgresType(value) {
  if (postgresColumnTypes.includes(value)) return value;
  if (typeof value!=='string' || value.length>40) return null;
  const match=/^(VARCHAR|NUMERIC|TIMESTAMP|TIMESTAMPTZ)\((\d{1,5})(?:,(\d{1,4}))?\)$/.exec(value);
  if (!match) return null;
  const [,type,length,scale]=match;
  const precision=Number(length), places=Number(scale);
  if (type==='NUMERIC' ? precision<1 || precision>1000 || places>precision
    : scale || (type==='VARCHAR'?precision<1:precision>6)) return null;
  return value;
}

export function postgresColumnStatement(input,definition) {
  const quote=name=>{
    if (typeof name!=='string' || !name.length || Buffer.byteLength(name)>63 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new TypeError('Invalid identifier');
    }
    return identifier(true,name);
  };
  const table=quote(input.schema)+'.'+quote(input.table);
  const name=input.operation==='modify-column'?input.column?.name:input.columnName;
  const field=quote(name);
  const existing=definition?.columnChanges.find(([column])=>column===name);
  if (!existing) return null;
  if (input.operation==='set-column-default') return 'ALTER TABLE '+table+' ALTER COLUMN '+field+' '+columnDefault(input.defaultValue,true);
  if (input.operation==='rename-column') return 'ALTER TABLE '+table+' RENAME COLUMN '+field+' TO '+quote(input.name);
  if (input.operation!=='modify-column' || !postgresType(input.column.type) || typeof input.column.nullable!=='boolean') {
    throw new TypeError('Invalid column definition');
  }
  if (!existing[1]) return null;
  const nullable=input.column.nullable?'DROP NOT NULL':'SET NOT NULL';
  return 'ALTER TABLE '+table+' ALTER COLUMN '+field+' TYPE '+postgresType(input.column.type)+', ALTER COLUMN '+field+' '+nullable;
}
