import { tableViewSql } from './table-view.mjs';
import { DatabaseSync } from 'node:sqlite';

const fixture = new DatabaseSync(':memory:');
fixture.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE customers (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL);
  CREATE TABLE products (id INTEGER PRIMARY KEY, title TEXT NOT NULL, price_cents INTEGER NOT NULL);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), status TEXT NOT NULL);
  CREATE TABLE order_items (
    order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL, PRIMARY KEY (order_id,product_id)
  );
  INSERT INTO customers VALUES (1,'Northwind Workshop'),(2,'Juniper Studio'),(3,'Cedar Lab');
  INSERT INTO products VALUES (10,'Sample notebook',900),(20,'Sample mug',1500),(30,'Sample tote',2200);
  INSERT INTO orders VALUES (101,1,'paid'),(102,2,'pending'),(103,1,'shipped');
  INSERT INTO order_items VALUES (101,10,2),(101,20,1),(102,30,1),(103,20,3);
  PRAGMA query_only=ON;
`);

const tables = fixture.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row=>row.name);
const foreignKeys = fixture.prepare('SELECT "table" FROM pragma_foreign_key_list(?)');
const fields = fixture.prepare('SELECT name,type,"notnull",pk FROM pragma_table_info(?) ORDER BY cid');

export function demoStructure() {
  return {
    tables:tables.map(name=>['store',name,'BASE TABLE']),
    relations:tables.flatMap(name=>foreignKeys.all(name).map(key=>['store',name,'store',key.table])),
  };
}

export function demoRows(schema, table, offset, limit, view = {filters:[]}) {
  if (schema!=='store' || !tables.includes(table)) return null;
  const definition = fields.all(table).map(field=>[field.name,field.type,field.notnull || field.pk ? 'NO' : 'YES',Boolean(field.pk)]);
  const args = [];
  const clause = tableViewSql(definition,view,'sqlite',value=>'"'+value.replaceAll('"','""')+'"',value=>{
    args.push(value);
    return '?';
  });
  if (clause===null) return {invalidView:true};
  const query = fixture.prepare('SELECT * FROM "'+table+'"'+clause+' LIMIT ? OFFSET ?');
  query.setReturnArrays(true);
  return {columns:definition.map(field=>field[0]),definition,rows:query.all(...args,limit,offset),affected:null};
}
