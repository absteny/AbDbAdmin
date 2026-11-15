const visible = "table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg_toast%' AND table_schema NOT LIKE 'pg_temp%'";
const scope = (pg, alias = '') => pg ? visible.replaceAll('table_schema', alias + 'table_schema') : alias + 'table_schema = DATABASE()';
const timeout = 10000;

export function identifier(pg, value) {
  const quote = pg ? '"' : '`';
  return quote + value.replaceAll(quote, quote + quote) + quote;
}

export async function withDatabase(profile, fn) {
  const pg = profile.engine === 'postgres';
  const address = {
    host: profile.host, port: profile.port, user: profile.user,
    password: profile.password, database: profile.database,
  };
  let client;
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
      client = mysql.createConnection({
        ...address, connectTimeout: 5000, multipleStatements: false, rowsAsArray: true, flags: '-LOCAL_FILES',
        supportBigNumbers: true, bigNumberStrings: true, dateStrings: true,
        ssl: profile.tls ? { rejectUnauthorized: true, verifyIdentity: true, ca: profile.ca || undefined } : undefined,
      });
      client.on('error', () => {});
      await client.promise().connect();
    }
    return await fn({
      pg,
      async query(sql, values = [], cap = Infinity) {
        return new Promise((resolve, reject) => {
          const rows = [];
          const timer = setTimeout(() => reject(Object.assign(new Error('Query timed out'),{code:'QUERY_TIMEOUT'})),timeout+2000);
          let columns = [];
          let affected = null;
          const accept = row => {
            if (rows.length < cap) rows.push(row);
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
    else client?.destroy();
  }
}

export async function structure({query, pg}) {
  const {rows} = await query(
    `SELECT table_schema, table_name, table_type FROM information_schema.tables
     WHERE ${scope(pg)} ORDER BY table_schema, table_name LIMIT 500`);
  return rows;
}

export async function columns({query, pg}, schema, table) {
  const marks = pg ? ['$1','$2'] : ['?','?'];
  const {rows} = await query(
    `SELECT c.column_name, c.data_type, c.is_nullable,
     EXISTS (SELECT 1 FROM information_schema.table_constraints t
       JOIN information_schema.key_column_usage k ON k.constraint_schema=t.constraint_schema
       AND k.constraint_name=t.constraint_name AND k.table_schema=t.table_schema AND k.table_name=t.table_name
       WHERE t.constraint_type='PRIMARY KEY' AND c.table_schema=t.table_schema
       AND c.table_name=t.table_name AND k.column_name=c.column_name)
     FROM information_schema.columns c WHERE ${scope(pg, 'c.')}
       AND c.table_schema=${marks[0]} AND c.table_name=${marks[1]} ORDER BY c.ordinal_position`, [schema, table]);
  return rows;
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

export async function tableData(db, schema, table, offset, limit) {
  const definition = await columns(db, schema, table);
  if (!definition.length) return null;
  const quote = value => identifier(db.pg, value);
  const primary = definition.filter(column => column[3]).map(column => quote(column[0]));
  const order = primary.length ? ' ORDER BY ' + primary.join(', ') : '';
  return {
    ...await db.query(`SELECT * FROM ${quote(schema)}.${quote(table)}${order} LIMIT ${limit} OFFSET ${offset}`),
    definition,
  };
}
