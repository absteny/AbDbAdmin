// Filter values are always bound parameters. Column names come from table metadata.
export function tableViewSql(definition, view, dialect, quote, bind) {
  const names = new Set(definition.map(([name]) => name));
  const textType = dialect === 'mysql' ? 'CHAR' : 'TEXT';
  const filters = view.filters.map(({column,operator,value}) => {
    if (!names.has(column)) return null;
    const field = quote(column);
    if (operator === 'null') return field + ' IS NULL';
    if (operator === 'not-null') return field + ' IS NOT NULL';
    const text = 'CAST(' + field + ' AS ' + textType + ')';
    if (operator === 'eq') return text + ' = ' + bind(value);
    const escaped = value.replace(/[!%_]/g, symbol => '!' + symbol);
    return "LOWER(" + text + ") LIKE LOWER(" + bind('%' + escaped + '%') + ") ESCAPE '!'";
  });
  if (filters.includes(null) || (view.sort && !names.has(view.sort.column))) return null;
  const primary = definition.filter(([name,,,key]) => key && name !== view.sort?.column).map(([name]) => quote(name)+' DESC');
  if (!view.sort && !primary.length) {
    const fallback=definition.find(([,type])=>/^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|timestamp|datetime|date|time|uuid|varchar|char|character|text)(?:$|\s)/i.test(type));
    if (fallback) primary.push(quote(fallback[0])+' DESC');
  }
  if (view.sort) primary.unshift(quote(view.sort.column) + (view.sort.direction === 'desc' ? ' DESC' : ' ASC'));
  if (!primary.length && dialect === 'sqlite') primary.push('rowid DESC');
  return (filters.length ? ' WHERE ' + filters.join(' AND ') : '') +
    (primary.length ? ' ORDER BY ' + primary.join(', ') : '');
}
