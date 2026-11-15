import { identifier } from './database.mjs';

export const columnTypes = [
  'BIGINT','INT','SMALLINT','TINYINT','DECIMAL(18,2)','DOUBLE',
  'VARCHAR(32)','VARCHAR(64)','VARCHAR(128)','VARCHAR(255)','VARCHAR(512)','TEXT','DATE','DATETIME','TIMESTAMP','JSON','BLOB',
];

export const tableEngines=['InnoDB','MyISAM'];

export function schemaStatement(database,input,definition) {
  const valid = name=>typeof name==='string' && name.length>0 && name.length<=64 && !/[\u0000-\u001f\u007f]/.test(name) && !name.endsWith(' ');
  const quote = name=>{
    if (!valid(name)) throw new TypeError('Invalid identifier');
    return identifier(false,name);
  };
  const inputColumn=column=>{
    if (!columnTypes.includes(column?.type) || typeof column.nullable!=='boolean') throw new TypeError('Invalid column definition');
    return quote(column.name)+' '+column.type+(column.nullable?' NULL':' NOT NULL');
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
      const current=definition?.columnChanges.find(([name])=>name===input.column?.name);
      if (!current?.[1]) return null;
      const charset=/^(?:VARCHAR\(\d+\)|TEXT)$/.test(input.column.type) && current[2] && current[3]
        ? ' CHARACTER SET '+current[2]+' COLLATE '+current[3] : '';
      return alter+'MODIFY COLUMN '+quote(input.column.name)+' '+input.column.type+charset+
        (input.column.nullable?' NULL':' NOT NULL');
    }
    case 'change-engine':
      if (!tableEngines.includes(input.engine)) throw new TypeError('Invalid engine');
      if (!definition || (input.engine==='MyISAM' && definition.hasForeignKeys)) return null;
      return alter+'ENGINE='+input.engine;
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
    'SELECT TABLE_TYPE,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',args);
  if (objects.rows[0]?.[0]!=='BASE TABLE') return null;
  const columns=await db.query(
    'SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,COLUMN_COMMENT,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',args);
  const indexes=await db.query(
    'SELECT INDEX_NAME,COLUMN_NAME,NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',args);
  const foreignKeys=await db.query(
    'SELECT CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME,ORDINAL_POSITION',args);
  const incoming=await db.query(
    'SELECT 1 FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME=? LIMIT 1',args);
  const simpleName=value=>value==null || /^[a-z0-9_]+$/i.test(value);
  const columnChanges=columns.rows.map(([name,type,nullable,defaultValue,extra,comment,charset,collation])=>[
    name,(defaultValue===null || nullable==='YES' && defaultValue==='NULL') && !extra && !comment &&
      !/\b(?:unsigned|zerofill)\b/i.test(type) && simpleName(charset) && simpleName(collation),
    charset,collation,
  ]);
  return {engine:objects.rows[0][1],columns:columns.rows.map(row=>row.slice(0,5)),columnChanges,
    hasForeignKeys:Boolean(foreignKeys.rows.length || incoming.rows.length),indexes:indexes.rows,foreignKeys:foreignKeys.rows};
}

export const postgresColumnTypes = [
  'BIGINT','INTEGER','SMALLINT','NUMERIC(18,2)','DOUBLE PRECISION','BOOLEAN',
  'VARCHAR(32)','VARCHAR(64)','VARCHAR(128)','VARCHAR(255)','VARCHAR(512)','TEXT',
  'DATE','TIMESTAMP','TIMESTAMPTZ','JSON','JSONB','BYTEA','UUID',
];

export async function postgresTableDefinition(db,schema,table) {
  const {rows}=await db.query(
    `SELECT c.column_name,c.data_type,c.is_nullable,c.is_identity,c.is_generated
     FROM information_schema.columns c JOIN information_schema.tables t
       ON t.table_schema=c.table_schema AND t.table_name=c.table_name
     WHERE c.table_schema=$1 AND c.table_name=$2 AND t.table_type='BASE TABLE'
       AND c.table_schema NOT IN ('pg_catalog','information_schema')
       AND c.table_schema NOT LIKE 'pg_toast%' AND c.table_schema NOT LIKE 'pg_temp%'
     ORDER BY c.ordinal_position`,[schema,table]);
  if (!rows.length) return null;
  return {columns:rows.map(row=>row.slice(0,3)),columnChanges:rows.map(([name,,,identity,generated])=>
    [name,identity==='NO' && generated==='NEVER'])};
}

export function postgresColumnStatement(input,definition) {
  const quote=name=>{
    if (typeof name!=='string' || !name.length || Buffer.byteLength(name)>63 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new TypeError('Invalid identifier');
    }
    return identifier(true,name);
  };
  const table=quote(input.schema)+'.'+quote(input.table);
  const name=input.operation==='rename-column'?input.columnName:input.column?.name;
  const field=quote(name);
  const existing=definition?.columnChanges.find(([column])=>column===name);
  if (!existing) return null;
  if (input.operation==='rename-column') return 'ALTER TABLE '+table+' RENAME COLUMN '+field+' TO '+quote(input.name);
  if (input.operation!=='modify-column' || !postgresColumnTypes.includes(input.column.type) || typeof input.column.nullable!=='boolean') {
    throw new TypeError('Invalid column definition');
  }
  if (!existing[1]) return null;
  const nullable=input.column.nullable?'DROP NOT NULL':'SET NOT NULL';
  return 'ALTER TABLE '+table+' ALTER COLUMN '+field+' TYPE '+input.column.type+', ALTER COLUMN '+field+' '+nullable;
}
