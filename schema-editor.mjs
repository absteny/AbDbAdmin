import { identifier } from './database.mjs';

export const columnTypes = [
  'BIGINT','INT','SMALLINT','TINYINT','DECIMAL(18,2)','DOUBLE',
  'VARCHAR(255)','TEXT','DATE','DATETIME','TIMESTAMP','JSON','BLOB',
];

export function schemaStatement(database,input) {
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
    case 'add-column': return alter+'ADD COLUMN '+inputColumn(input.column);
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
    'SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',args);
  if (objects.rows[0]?.[0]!=='BASE TABLE') return null;
  const columns=await db.query(
    'SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',args);
  const indexes=await db.query(
    'SELECT INDEX_NAME,COLUMN_NAME,NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX',args);
  const foreignKeys=await db.query(
    'SELECT CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME,ORDINAL_POSITION',args);
  return {columns:columns.rows,indexes:indexes.rows,foreignKeys:foreignKeys.rows};
}
