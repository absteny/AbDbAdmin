import { translate } from './i18n.js';
let language = localStorage.getItem('abdb-language') === 'ru' ? 'ru' : 'en';
const t = (message, variables) => translate(language,message,variables);
function applyLanguage() {
  document.documentElement.lang=language;
  document.title=language==='ru' ? 'AbDbAdmin — панель баз данных' : 'AbDbAdmin — Database administration';
}
function languagePicker() {
  return label(language==='ru'?'Язык':'Language',select('language',[['en','English'],['ru','Русский']],language,{
    onchange:event=>{
      language=event.target.value;
      localStorage.setItem('abdb-language',language);
      applyLanguage();
      render();
      app.querySelector('[name=language]')?.focus();
    },
  }));
}
applyLanguage();

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const notice = document.querySelector('#notice');
const labelKeys = {postgres:'PostgreSQL',mysql:'MySQL',mariadb:'MariaDB',demo:'Учебная база',view:'Просмотр',edit:'Редактирование строк',sql:'Доступ к SQL',admin:'Администратор'};
const state = {user:null,connections:[],connection:null,view:'tables',schema:null,tables:[],relations:[],table:null,offset:0};
let renderId = 0;
let noticeTimer;

function element(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key,value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2),value);
    else if (key === 'value') node.value = value;
    else node.setAttribute(key,value === true ? '' : value);
  }
  node.append(...children.flat(Infinity).filter(child=>child != null));
  return node;
}
const e = element;
const div = (style,...children)=>e('div',{class:style},children);
const button = (text,fn,style,attrs={})=>e('button',{type:'button',class:style,onclick:fn,...attrs},text);
const brand = ()=>div('brand',e('span',{class:'mark','aria-hidden':true},'◈'),'AbDbAdmin');
const field = (name,type='text',value='',attrs={})=>e('input',{name,type,value,...attrs});
const label = (title,input,style)=>e('label',{class:style},title,input);
const submit = title=>e('button',{class:'primary',type:'submit'},title);
const report = error=>toast(error.message || String(error));
const click = fn=>()=>Promise.resolve().then(fn).catch(report);

function toast(message) {
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(()=>{notice.hidden=true;},4500);
}
async function api(path, method='GET', payload) {
  const response = await fetch('/api/'+path,{
    method,
    headers:{'X-AbDbAdmin':'1','Accept-Language':language,...(payload === undefined ? {} : {'Content-Type':'application/json'})},
    body:payload === undefined ? undefined : JSON.stringify(payload),
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !['login','session'].includes(path)) {
      tableViews.clear();
      state.user = null;
      if (dialog.open) dialog.close();
      login();
    }
    throw new Error(value.error || t('Ошибка запроса'));
  }
  return value;
}
const route = tail=>`connections/${state.connection.id}/${tail}`;
const tableViews = new Map();
const tableScope = ()=>JSON.stringify([state.connection.id,...state.table.slice(0,2)]);
const currentTableView = ()=>tableViews.get(tableScope()) ?? {filters:[],sort:null};
const rowParams = (filtered=true)=>{
  const params=new URLSearchParams({schema:state.table[0],table:state.table[1],offset:state.offset});
  const view=currentTableView();
  if (filtered && (view.filters.length || view.sort)) params.set('filter',JSON.stringify(view));
  return params;
};
function applyTableView(view) {
  tableViews.set(tableScope(),view);
  state.offset=0;
  render();
}

function form(children, text, callback, footer=[]) {
  const error = e('p',{class:'form-error',role:'alert'});
  return e('form',{class:'stack',onsubmit:async event=>{
    event.preventDefault();
    const target = event.currentTarget;
    const action = target.querySelector('[type=submit]');
    action.disabled = true;
    error.textContent = '';
    try {await callback(Object.fromEntries(new FormData(target)),target);}
    catch (reason) {error.textContent = reason.message;}
    finally {action.disabled = false;}
  }},children,error,div('row',submit(text),footer));
}
function openDialog(title,children) {
  if (dialog.open) dialog.close();
  dialog.replaceChildren(div('stack',div('row spread',e('h2',{},title),button(t('Закрыть'),()=>dialog.close())),children));
  dialog.showModal();
}
function select(name, entries, value, attrs={}) {
  const result = e('select',{name,...attrs},entries.map(([key,text])=>e('option',{value:key},text)));
  result.value = value;
  return result;
}
function login() {
  renderId++;
  const content = form([
    label(t('Логин'),field('name','text','',{required:true,autocomplete:'username',autofocus:true})),
    label(t('Пароль'),field('password','password','',{required:true,autocomplete:'current-password'})),
  ],t('Войти'),async data=>{
    state.user = await api('login','POST',data);
    state.view = 'tables';
    state.connection = null;
    await refreshConnections();
    render();
  });
  app.replaceChildren(div('login',div('panel login-card',
    div('login-main stack',div('row spread',brand(),languagePicker()),e('h1',{},t('Ваши базы данных')),e('p',{},t('Войдите, чтобы открыть сохранённые подключения.')),content),
    div('login-art',div('clay-stack',e('span'),e('span'),e('span'))),
  )));
}
async function refreshConnections() {
  state.connections = await api('connections');
  if (state.connection) state.connection = state.connections.find(item=>item.id===state.connection.id) || null;
}
async function choose(id) {
  state.connection = state.connections.find(item=>item.id===id);
  Object.assign(state,{view:'tables',schema:null,tables:[],relations:[],table:null,offset:0});
  render();
}
function setView(view) { state.view=view; render(); }
function changePassword() {
  openDialog(t('Сменить пароль'),form([
    label(t('Текущий пароль'),field('current','password','',{required:true,autocomplete:'current-password'})),
    label(t('Новый пароль'),field('password','password','',{required:true,minlength:12,maxlength:256,autocomplete:'new-password'})),
  ],t('Сохранить'),async data=>{await api('password','POST',data);dialog.close();toast(t('Пароль обновлён'));}));
}
function render() {
  if (!state.user) return login();
  const stamp = ++renderId;
  const active = state.connection;
  const admin = state.user.admin;
  const pages={users:'Пользователи',audit:'Журнал действий',demo:'Демо'};
  const utility = Object.hasOwn(pages,state.view);
  const people = state.view === 'users';
  const demo = active?.engine === 'demo';
  const engine = active && t(labelKeys[active.engine] ?? active.engine);
  const content = div('stack');
  const heading = div('hero',e('h1',{},utility?t(pages[state.view]):active?.name || t('Подключения')),
    active && !utility ? e('p',{},engine+' · '+t(labelKeys[active.level])+(active.production?' · PRODUCTION':'')) : null);
  app.replaceChildren(div('shell',div('sidebar',
    brand(),
    div('row spread',e('span',{class:'nav-heading'},t('Подключения')),admin?button('+',()=>editConnection(), 'primary',{'aria-label':t('Добавить подключение')}):null),
    div('nav',state.connections.map(connection=>button(t(labelKeys[connection.engine] ?? connection.engine)+' · '+connection.name,
      click(()=>choose(connection.id)),null,{'aria-current':String(!utility && connection.id===active?.id)}))),
    admin?div('nav',
      button(t('Пользователи и права'),()=>setView('users'),null,{'aria-current':String(people)}),
      button(t('Журнал действий'),()=>setView('audit'),null,{'aria-current':String(state.view==='audit')}),
      button(t('Демо'),()=>setView('demo'),null,{'aria-current':String(state.view==='demo')})):null,
    state.user.advancedUrl?e('a',{href:state.user.advancedUrl,target:'_blank',rel:'noopener noreferrer'},t('Расширенное управление MySQL и MariaDB')):null,
    div('grow'),
    div('stack',languagePicker(),e('small',{},state.user.name),button(t('Сменить пароль'),changePassword),button(t('Выйти'),click(async()=>{
      await api('logout','POST');tableViews.clear();state.user=null;login();
    }))),
  ),e('main',{class:'main stack'},heading,
    active && !utility ? div('row tabs',
      ...[['tables',t('Таблицы')],['graph',t('3D-схема')],...(!demo && ['admin','sql'].includes(active.level)?[['sql','SQL']]:[])]
        .map(([key,title])=>button(title,()=>setView(key),null,{'aria-current':String(state.view===key)})),
      admin && !demo?button(t('Настройки'),click(async()=>editConnection(await api(route('settings')),active.id))):null,
    ):null,content)));
  if (state.view==='demo') return demoView(content);
  if (state.view==='audit') return auditView(content,stamp).catch(error=>showError(content,stamp,error));
  if (people) return users(content,stamp).catch(error=>showError(content,stamp,error));
  if (!active) {
    content.append(div('panel empty',e('h2',{},admin?t('Добавьте подключение'):t('Доступных подключений пока нет')),
      e('p',{},admin?t('Укажите сервер и учётную запись базы данных.'):t('Попросите администратора выдать доступ к нужной базе.')),
      admin?button(t('Добавить подключение'),()=>editConnection(),'primary'):null));
    return;
  }
  if (state.view === 'sql') return sqlView(content);
  loadTables(content,stamp).catch(error=>showError(content,stamp,error));
}
function showError(target, stamp, error) {
  if (stamp===renderId) target.replaceChildren(div('panel stack',e('p',{role:'alert'},error.message),button(t('Повторить'),render)));
}
function confirmAction(title,text,callback) {
  openDialog(title,form(e('p',{},text),t('Подтвердить'),async ()=>{
    await callback();
    dialog.close();
  }));
}
function editConnection(config={}, id=null) {
  const engine = select('engine',[['postgres','PostgreSQL'],['mysql','MySQL'],['mariadb','MariaDB']],config.engine || 'postgres');
  const port = field('port','number',config.port || 5432,{min:1,max:65535,required:true});
  engine.addEventListener('change',()=>{port.value=engine.value==='postgres'?5432:3306;});
  const content = form(div('fields',
    label(t('Название'),field('name','text',config.name,{required:true,maxlength:255}),'wide'),
    label(t('СУБД'),engine),
    label(t('Порт'),port),
    e('label',{class:'check wide'},field('production','checkbox','1',{checked:config.production}),t('Рабочая база (production)')),
    label(t('Хост'),field('host','text',config.host,{required:true,placeholder:'db.example.net'})),
    label(t('База данных'),field('database','text',config.database,{required:true})),
    label(t('Пользователь БД'),field('user','text',config.user,{required:true})),
    label(t('Пароль БД'),field('password','password','',{autocomplete:'new-password',placeholder:id?t('Сохранённый пароль'):''})),
    e('label',{class:'check wide'},field('tls','checkbox','1',{checked:config.tls ?? true}),t('TLS с проверкой сертификата')),
    label(config.customCa?t('Новый PEM-сертификат CA (текущий сохранён)'):t('PEM-сертификат CA (необязательно)'),e('textarea',{name:'ca'}),'wide'),
    config.customCa?e('label',{class:'check wide'},field('removeCa','checkbox','1'),t('Удалить сохранённый сертификат CA')):null,
    id?e('label',{class:'check wide'},field('resetPassword','checkbox','1'),t('Сохранить пустой пароль БД')):null,
  ),t('Проверить и сохранить'),async data=>{
    data.port=Number(data.port);
    data.tls=Boolean(data.tls);
    data.production=Boolean(data.production);
    if (id && !data.password && !data.resetPassword) delete data.password;
    if (id && !data.ca && !data.removeCa) delete data.ca;
    let next = id;
    if (id) await api(`connections/${id}/settings`,'PUT',data);
    else next = (await api('connections','POST',data)).id;
    dialog.close();
    await refreshConnections();
    await choose(next);
    toast(t('Подключение сохранено'));
  },id?button(t('Удалить подключение'),()=>confirmAction(t('Удалить подключение?'),
    t('Профиль и выданные на него права будут удалены.'),async ()=>{
      await api('connections/'+id,'DELETE');
      await refreshConnections();
      render();
    }),'danger'):[]);
  openDialog(id?t('Настройки подключения'):t('Новое подключение'),content);
}
async function users(target,stamp) {
  target.append(div('panel',t('Загрузка…')));
  const list = await api('users');
  if (stamp !== renderId) return;
  target.replaceChildren(div('panel stack',div('row spread',e('h2',{},t('Учётные записи')),
    button(t('Добавить пользователя'),()=>openDialog(t('Новый пользователь'),form([
      label(t('Логин'),field('name','text','',{required:true,minlength:3,maxlength:48,autocomplete:'off'})),
      label(t('Пароль'),field('password','password','',{required:true,minlength:12,maxlength:256,autocomplete:'new-password'})),
    ],t('Создать'),async data=>{await api('users','POST',data);dialog.close();render();})), 'primary')),
  list.map(user=>div('row spread user-line',e('strong',{},user.name),
    user.admin?e('span',{class:'tag'},t('Администратор')):div('row',
      button(t('Доступ'),click(()=>permissions(user))),
      button(t('Удалить'),()=>confirmAction(t('Удалить пользователя?'),user.name+t(' потеряет доступ к панели.'),async ()=>{
        await api('users/'+user.id,'DELETE');render();
      }),'danger'),
    )))));
}
async function permissions(user) {
  const url = 'users/'+user.id+'/permissions';
  const list = await api(url);
  const values = new Map(list.map(item=>[item.connection_id,item.level]));
  openDialog(t('Доступ · ')+user.name,div('stack',
    e('p',{},t('SQL разрешает любые запросы в рамках прав учётной записи сохранённого подключения.')),
    state.connections.length ? state.connections.map(connection=>{
      const picker = select('level',[['',t('Нет доступа')],['view',t('Просмотр')],...(connection.engine==='demo'?[]:[['edit',t('Редактирование строк')],['sql',t('Доступ к SQL')]])],values.get(connection.id) || '');
      const save = button(t('Сохранить'),click(async ()=>{
        await api(url,'PUT',{connection:connection.id,level:picker.value || null});
        toast(t('Доступ обновлён'));
      }));
      return div('row',div('grow',label(connection.name,picker)),save);
    }):e('p',{},t('Сначала добавьте подключение.')),
  ));
}

const auditActions = {
  login:'Вход',logout:'Выход','password.change':'Смена пароля',
  'admin.reset':'Сброс пароля администратора','gateway.reset':'Сброс пароля Basic Auth',
  'user.create':'Создание пользователя','user.delete':'Удаление пользователя','permission.change':'Изменение прав',
  'connection.create':'Создание подключения','connection.update':'Изменение подключения','connection.delete':'Удаление подключения',
  'sql.execute':'Выполнение SQL','row.write':'Операция со строкой','row.insert':'Добавление строки',
  'row.update':'Изменение строки','row.delete':'Удаление строки','csv.export':'Экспорт CSV','demo.enable':'Подключение демо',
};

async function auditView(target,stamp,before=null) {
  target.replaceChildren(div('panel',t('Загрузка…')));
  const page=await api('audit'+(before===null?'':'?before='+before));
  if (stamp!==renderId) return;
  const names=new Map(state.connections.map(item=>[item.id,item.name]));
  const date=new Intl.DateTimeFormat(language,{dateStyle:'short',timeStyle:'medium'});
  const rows=page.entries.map(item=>[
    date.format(new Date(item.created_at)),item.actor ?? '—',t(auditActions[item.action] ?? item.action),
    item.connection_id==null?'—':names.get(item.connection_id) ?? '#'+item.connection_id,
    item.subject_id==null?'—':'#'+item.subject_id,
    t(item.status<400?'Успешно':'Ошибка')+' ('+item.status+')',
  ]);
  const load=cursor=>auditView(target,stamp,cursor).catch(error=>showError(target,stamp,error));
  target.replaceChildren(div('panel stack',
    div('row spread',e('h2',{},t('Журнал действий')),button(t('Обновить'),()=>load(null))),
    rows.length?resultTable({columns:['Время','Пользователь','Действие','Подключение','Кого изменили','Результат'].map(key=>t(key)),rows}):e('p',{},t('Записей пока нет')),
    page.next==null?null:div('row',button(t('Более ранние записи'),()=>load(page.next))),
  ));
}

function demoView(target) {
  const demo=state.connections.find(item=>item.engine==='demo');
  target.append(div('panel stack',
    e('h2',{},'Sample Store'),
    e('p',{},t('Тестовые клиенты, заказы и товары. Данные доступны только для чтения.')),
    demo?button(t('Удалить демо'),()=>confirmAction(t('Удалить демо'),t('Удалить демо-подключение и относящиеся к нему права?'),async ()=>{
      await api('connections/'+demo.id,'DELETE');
      await refreshConnections();
      render();
    }),'danger'):button(t('Запустить демо'),click(async ()=>{
      await api('demo','POST');
      await refreshConnections();
      render();
    }),'primary'),
  ));
  target.append(div('panel stack',
    e('h2',{},t('1. Дать коллеге доступ на просмотр')),
    e('p',{},t('Откройте пользователей, создайте учебный аккаунт или выберите существующий. Для подключения Sample Store установите «Просмотр» и сохраните. Войдите под этим аккаунтом и проверьте доступ к таблицам.')),
    button(t('Открыть пользователей'),()=>setView('users'),null,{disabled:!demo}),
  ),div('panel stack',
    e('h2',{},t('2. Найти связанные таблицы')),
    e('p',{},t('Откройте 3D-схему, найдите связь orders → customers и откройте orders. Сравните customer_id в заказах с id в customers.')),
    button(t('Открыть 3D-схему'),click(async ()=>{await choose(demo.id);setView('graph');}),null,{disabled:!demo}),
  ));
}

async function loadTables(target,stamp) {
  target.append(div('panel',t('Загрузка структуры…')));
  if (!state.schema) {
    const payload = await api(route('schema'));
    if (stamp!==renderId) return;
    Object.assign(state,{schema:true,...payload});
  }
  target.replaceChildren();
  if (!state.tables.length) {
    target.append(div('panel empty',e('h2',{},t('Таблиц пока нет')),e('p',{},t('Проверьте права пользователя БД и выбранную базу.')),
      button(t('Обновить структуру'),()=>{state.schema=null;render();})));
    return;
  }
  if (state.view==='graph') return graph(target);
  if (!state.table) state.table=state.tables[0];
  const selection = select('table',state.tables.map((entry,index)=>[String(index),entry[0]+'.'+entry[1]]),String(state.tables.indexOf(state.table)),{
    onchange:event=>{state.table=state.tables[Number(event.target.value)];state.offset=0;render();},
  });
  const search = e('input',{type:'search',placeholder:t('Имя таблицы или схемы')});
  search.addEventListener('input',()=>{
    const needle = search.value.trim().toLowerCase();
    for (const option of selection.options) {
      option.hidden = !option.selected && !option.textContent.toLowerCase().includes(needle);
      option.disabled = option.hidden;
    }
  });
  target.append(div('panel row spread',div('grow',label(t('Поиск таблиц'),search)),div('grow',label(t('Таблица или представление'),selection)),
    button(t('Обновить структуру'),()=>{state.schema=null;state.table=null;state.offset=0;render();})));
  const path = route('rows')+'?'+rowParams();
  let data;
  try { data = await api(path); }
  catch (error) {
    if (stamp!==renderId) return;
    const view=currentTableView();
    if (!view.filters.length && !view.sort) throw error;
    if (stamp===renderId) target.append(div('panel stack',e('p',{role:'alert'},error.message),
      button(t('Сбросить фильтры'),()=>applyTableView({filters:[],sort:null}))));
    return;
  }
  if (stamp!==renderId) return;
  const editable = state.connection.engine!=='demo' && state.connection.level!=='view' && state.table[2]==='BASE TABLE';
  const hasKeys = data.definition.some(field=>field[3]) && !data.unsafeKey;
  const actions = editable && hasKeys;
  const csv = e('a',{href:'/api/'+route('csv')+'?'+rowParams()},t('CSV · до 500 строк'));
  target.append(div('panel stack',
    div('row spread',e('h2',{},state.table[1]),div('row',csv,editable?button(t('Добавить строку'),()=>rowDialog(data,path),'primary'):null)),
    div('row',
      button(t('Фильтры и сортировка'),()=>filterDialog(data.columns)),
      button(t('Сохранённые представления'),click(savedViews)),
      currentTableView().filters.length || currentTableView().sort
        ? button(t('Сбросить фильтры'),()=>applyTableView({filters:[],sort:null})) : null),
    resultTable(data,actions?row=>button(t('Изменить'),()=>rowDialog(data,path,row)):null),
    div('row spread',e('small',{},data.rows.length?t('Строки {start}–{end}',{start:state.offset+1,end:state.offset+data.rows.length}):t('Строк нет')),
      div('row',button(t('Назад'),()=>{state.offset-=50;render();},null,{disabled:!state.offset}),
        button(t('Далее'),()=>{state.offset+=50;render();},null,{disabled:!data.truncated || state.offset>=1000000}))),
  ));
  target.append(div('panel stack',e('h2',{},t('Столбцы')),resultTable({
    columns:[t('Имя'),t('Тип'),t('Допускает NULL'),t('Первичный ключ')],
    rows:data.definition.map(([name,type,nullable,key])=>[name,type,nullable==='YES'?t('Да'):t('Нет'),key?t('Да'):'']),
  })));
}
function resultTable(data,actions) {
  if (!data.columns.length) return e('p',{},data.affected==null?t('Запрос выполнен'):t('Затронуто строк: {count}',{count:data.affected}));
  return div('table-wrap',e('table',{},
    e('thead',{},e('tr',{},data.columns.map(name=>e('th',{scope:'col'},name)),actions?e('th',{scope:'col'},t('Действия')):null)),
    e('tbody',{},data.rows.map(row=>e('tr',{},row.map(value=>e('td',{},value==null?e('i',{},'NULL'):String(value))),actions?e('td',{class:'actions'},actions(row)):null))),
  ));
}
function filterDialog(columns) {
  const view=currentTableView();
  const items=div('stack');
  const choices=columns.map(name=>[name,name]);
  const sort=select('sort',[['',t('По умолчанию')],...choices],view.sort?.column ?? '');
  const direction=select('direction',[['asc',t('По возрастанию')],['desc',t('По убыванию')]],view.sort?.direction ?? 'asc');
  const add=button(t('Добавить условие'),()=>addFilter({column:columns[0],operator:'contains',value:''}));
  function addFilter(filter) {
    const column=select('column',choices,filter.column);
    const operator=select('operator',[
      ['contains',t('Содержит')],['eq',t('Равно')],['null','IS NULL'],['not-null','IS NOT NULL'],
    ],filter.operator);
    const value=field('value','text',filter.value,{maxlength:512});
    const toggle=()=>{value.disabled=['null','not-null'].includes(operator.value);};
    operator.addEventListener('change',toggle);
    toggle();
    const item=div('fields',
      label(t('Столбец'),column),label(t('Условие'),operator),
      label(t('Значение'),value),button(t('Удалить'),()=>{
        item.remove();add.disabled=false;
      }));
    items.append(item);
    add.disabled=items.children.length>=8;
  }
  view.filters.forEach(addFilter);
  openDialog(t('Фильтры и сортировка'),form([
    items,add,div('fields',label(t('Сортировка'),sort),label(t('Порядок'),direction)),
  ],t('Применить'),async ()=>{
    const filters=Array.from(items.children,item=>Object.fromEntries(
      Array.from(item.querySelectorAll('input,select'),control=>[control.name,control.value])));
    dialog.close();
    applyTableView({filters,sort:sort.value?{column:sort.value,direction:direction.value}:null});
  }));
}

async function savedViews() {
  const path=route('views')+'?'+rowParams(false);
  const scope=tableScope();
  const list=await api(path);
  if (!state.connection || !state.table || scope!==tableScope()) return;
  openDialog(t('Сохранённые представления'),div('stack',
    list.length ? list.map(item=>div('row spread',e('strong',{},item.name),div('row',
      button(t('Применить'),()=>{dialog.close();applyTableView(item.view);}),
      button(t('Удалить'),()=>confirmAction(t('Удалить представление?'),item.name,async ()=>{
        await api(path+'&id='+item.id,'DELETE');
        render();
      }),'danger')))) : e('p',{},t('Представлений пока нет')),
    form([e('p',{},t('Сохранение с тем же именем заменит существующее представление.')),
      label(t('Название'),field('name','text','',{required:true,maxlength:80}))],
      t('Сохранить текущий вид'),async data=>{
        await api(path,'POST',{name:data.name,view:currentTableView()});
        dialog.close();
      })));
}

function rowDialog(data,path,row) {
  const key = Object.fromEntries(data.definition.filter(field=>field[3]).map(([name])=>[name,row?.[data.columns.indexOf(name)]]));
  const fields = data.definition.map(([name,type],index)=>{
    const mode = select('mode'+index,[['skip',row?t('Без изменений'):t('По умолчанию')],['value',t('Значение')],['null','NULL']],'skip');
    const input = field('value'+index,'text',row?.[data.columns.indexOf(name)] ?? '',{hidden:true});
    mode.addEventListener('change',()=>{input.hidden=mode.value!=='value';});
    return div('table-picker',label(name+' · '+type,mode),input);
  });
  const title=row?t('Изменить строку'):t('Добавить строку');
  const editor=form(fields,t('Предпросмотр изменений'),async dataInput=>{
    const values = Object.fromEntries(data.definition.flatMap(([name],index)=>{
      const mode = dataInput['mode'+index];
      if (mode==='skip') return [];
      return [[name,mode==='null'?null:dataInput['value'+index]]];
    }));
    if (row && !Object.keys(values).length) throw new Error(t('Выберите хотя бы один столбец для изменения.'));
    preview(row?'update':'insert',values);
  },row?button(t('Удалить строку'),()=>preview('delete',{}),'danger'):[]);
  function preview(action,values) {
    const names=action==='update'?Object.keys(values):data.columns;
    const before=data.columns.map((name,index)=>[name,row?.[index]]);
    const original=new Map(before);
    const target=[state.connection.name,state.table[0],state.table[1]].join(' / ');
    const changes=names.map(name=>[
      name,row ? original.get(name) : '—',
      action==='delete' ? '—' : Object.hasOwn(values,name) ? values[name] : t('По умолчанию'),
    ]);
    const production=state.connection.production;
    openDialog(t('Предпросмотр изменений'),form([
      e('strong',{},(production?'PRODUCTION · ':'')+target),
      e('p',{},t(action==='delete'?'Удалить строку':action==='insert'?'Добавить строку':'Изменить строку')+' · 1'),
      row?e('small',{},t('Первичный ключ')+' · '+JSON.stringify(key)):null,
      resultTable({columns:[t('Столбец'),t('Было'),t('Станет')],rows:changes}),
      e('small',{},t('Показаны данные, загруженные в таблицу. База может изменить итоговые значения.')),
    ],t('Подтвердить'),async ()=>{
      const result=await api(path,'POST',{action,values,key,snapshot:row?data.snapshots?.[data.rows.indexOf(row)]:undefined});
      dialog.close();
      if (Number.isInteger(result.affected)) toast(t('Затронуто строк: {count}',{count:result.affected}));
      render();
    },button(t('Назад'),()=>openDialog(title,editor))));
  }
  openDialog(title,editor);
}

function sqlView(target) {
  const output = div('panel stack');
  target.append(div('panel stack',e('h2',{},t('SQL-консоль')),
    form([
      label(t('Одна SQL-команда'),e('textarea',{name:'sql',class:'code',placeholder:'SELECT …',spellcheck:'false',required:true,maxlength:65000})),
      label(t('Подтверждаю выполнение команды в выбранной базе'),field('confirm','checkbox','1',{required:true}),'check'),
    ],t('Выполнить'),async (data,formNode)=>{
      const result = await api(route('sql'),'POST',{sql:data.sql});
      formNode.elements.confirm.checked=false;
      output.replaceChildren(resultTable(result));
      if (result.truncated) output.append(e('small',{},t('Показаны первые 200 строк.')));
    })),output);
}
function graph(target) {
  const canvas = e('canvas',{tabindex:0,'aria-label':t('Трёхмерная схема. Стрелки вращают, плюс и минус меняют масштаб.')});
  const context = canvas.getContext('2d');
  const graphTables = state.tables.slice(0,120);
  const names = new Map(graphTables.map((row,index)=>[JSON.stringify(row.slice(0,2)),index]));
  const edges = state.relations.flatMap(row=>{
    const start = names.get(JSON.stringify(row.slice(0,2)));
    const end = names.get(JSON.stringify(row.slice(2,4)));
    return start == null || end == null ? [] : [[start,end]];
  });
  const size = Math.ceil(Math.sqrt(graphTables.length));
  const positions = graphTables.map(([schema,table],index)=>({
    schema,table,index,x:(index%size-(size-1)/2)*167,
    z:(Math.floor(index/size)-(Math.ceil(graphTables.length/size)-1)/2)*112,
  }));
  let yaw = -.2, pitch = .8, zoom = 1;
  let hits = [];
  function draw() {
    const {width,height} = canvas.getBoundingClientRect();
    if (!width || !height) return;
    const density = window.devicePixelRatio || 1;
    canvas.width = Math.round(width*density);
    canvas.height = Math.round(height*density);
    context.scale(density,density);
    const fit = Math.min(1.15,(width-35)/(size*173),(height-35)/(size*96)) * zoom;
    function project(node) {
      const x = node.x*Math.cos(yaw) - node.z*Math.sin(yaw);
      const z = node.x*Math.sin(yaw) + node.z*Math.cos(yaw);
      const depth = z*Math.cos(pitch);
      const scale = 1200/(1200+depth*fit);
      return { ...node, x:width/2+x*fit*scale, y:height/2+z*Math.sin(pitch)*fit*scale, depth, scale:Math.max(.28,fit*scale) };
    }
    const points = positions.map(project);
    context.strokeStyle='#7966b8a8';
    context.lineWidth=1.8;
    for (const [start,end] of edges) {
      const a=points[start], b=points[end];
      context.beginPath();
      if (start===end) context.arc(a.x+40*a.scale,a.y-17*a.scale,23*a.scale,0,Math.PI*2);
      else {
        context.moveTo(a.x,a.y);
        context.bezierCurveTo(a.x,(a.y+b.y)/2,b.x,(a.y+b.y)/2,b.x,b.y);
      }
      context.stroke();
    }
    hits = points.sort((a,b)=>b.depth-a.depth).map(point=>{
      const {x,y,scale}=point;
      const w=145*scale, h=43*scale;
      context.beginPath();
      context.roundRect(x-w/2,y-h/2+7*scale,w,h,10*scale);
      context.fillStyle='#aa99da';
      context.fill();
      const gradient=context.createLinearGradient(x-w/2,y-h/2,x+w/2,y+h/2);
      gradient.addColorStop(0,'#fcf7ff');
      gradient.addColorStop(1,'#c9baf1');
      context.fillStyle=gradient;
      context.beginPath();
      context.roundRect(x-w/2,y-h/2,w,h,10*scale);
      context.fill();
      context.strokeStyle='#fff9';
      context.lineWidth=1;
      context.stroke();
      context.fillStyle='#352b54';
      context.textAlign='center';
      context.textBaseline='middle';
      context.font=`600 ${Math.max(8,14*scale)}px system-ui`;
      const name=point.table.length>21?point.table.slice(0,20)+'…':point.table;
      context.fillText(name,x,y,w-8);
      return {point,left:x-w/2,right:x+w/2,top:y-h/2,bottom:y+h/2+7*scale};
    });
  }
  function viewTable(index) {
    state.table=graphTables[index];
    state.offset=0;
    setView('tables');
  }
  function move(x,y,scale=1) {
    yaw+=x;
    pitch=Math.max(.32,Math.min(1.5,pitch+y));
    zoom=Math.max(.45,Math.min(2.5,zoom*scale));
    draw();
  }
  canvas.addEventListener('keydown',event=>{
    const key = {ArrowLeft:[-.16,0],ArrowRight:[.16,0],ArrowUp:[0,.12],ArrowDown:[0,-.12],'+':[0,0,1.2],'-':[0,0,1/1.2]}[event.key];
    if (!key) return;
    event.preventDefault();
    move(...key);
  });
  let drag;
  canvas.addEventListener('pointerdown',event=>{
    if (!event.isPrimary) return;
    canvas.setPointerCapture(event.pointerId);
    drag={x:event.clientX,y:event.clientY,moved:false};
  });
  canvas.addEventListener('pointermove',event=>{
    if (!drag || !event.isPrimary) return;
    const dx=event.clientX-drag.x, dy=event.clientY-drag.y;
    if (!drag.moved && Math.hypot(dx,dy)<4) return;
    drag={x:event.clientX,y:event.clientY,moved:true};
    move(dx/180,dy/220);
  });
  canvas.addEventListener('pointerup',event=>{
    if (!event.isPrimary) return;
    if (drag && !drag.moved) {
      const rect=canvas.getBoundingClientRect();
      const x=event.clientX-rect.left,y=event.clientY-rect.top;
      const hit=hits.findLast(rect=>x>=rect.left && x<=rect.right && y>=rect.top && y<=rect.bottom);
      if (hit) viewTable(hit.point.index);
    }
    drag=null;
  });
  canvas.addEventListener('pointercancel',()=>{drag=null;});
  const picker=select('node',graphTables.map(([schema,table],index)=>[String(index),schema+'.'+table]),'0');
  target.append(div('panel graph stack',
    div('row spread',e('h2',{},t('Связи таблиц')),div('row',
      button('−',()=>move(0,0,1/1.2),null,{'aria-label':t('Уменьшить масштаб')}),
      button('+',()=>move(0,0,1.2),null,{'aria-label':t('Увеличить масштаб')}),
      button(t('Сбросить вид'),()=>{yaw=-.2;pitch=.8;zoom=1;draw();}))),
    canvas,
    e('small',{},t('Объекты — {objects} · Связи — {edges}. Перетащите схему, чтобы повернуть, или нажмите на таблицу, чтобы открыть её.',{objects:graphTables.length,edges:edges.length})),
    state.tables.length>120?e('small',{},t('На схеме показаны первые 120 объектов.')):null,
    div('row',div('grow',label(t('Таблица'),picker)),button(t('Открыть'),()=>viewTable(Number(picker.value)))),
  ));
  const observer = new ResizeObserver(()=>{
    if (!canvas.isConnected) {observer.disconnect();return;}
    draw();
  });
  observer.observe(canvas);
  draw();
}

login();
api('session').then(async user=>{
  state.user=user;
  await refreshConnections();
  render();
}).catch(error=>{
  if (state.user) {
    login();
    report(error);
  }
});
