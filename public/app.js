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
const labelKeys = {postgres:'PostgreSQL',mysql:'MySQL',mariadb:'MariaDB',view:'Просмотр',edit:'Редактирование строк',sql:'Доступ к SQL',admin:'Администратор'};
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
const requests=new Map();
const requestLoader=document.querySelector('#request-loader');
const requestLabel=document.querySelector('#request-loader-label');
let requestTimer;
function requestTitle(path,method) {
  const endpoint=path.split('?')[0].split('/').at(-1);
  if (endpoint==='session') return 'Проверяем сеанс…';
  if (endpoint==='login') return 'Входим в панель…';
  if (endpoint==='schema' || endpoint==='structure-editor' && method==='GET') return 'Загрузка структуры…';
  if (endpoint==='rows' && method==='GET') return 'Загружаем строки…';
  if (endpoint==='sql' || endpoint==='sql-script') return 'Обрабатываем SQL…';
  if (endpoint==='connection-test') return 'Проверяем подключение…';
  if (method!=='GET') return 'Выполняем запрос…';
  return 'Загрузка…';
}
function startRequest(path,method) {
  const ticket=Symbol();
  requests.set(ticket,requestTitle(path,method));
  const show=()=>{
    if (!requests.size) return;
    requestLabel.textContent=t([...requests.values()].at(-1));
    const wasHidden=requestLoader.hidden;
    requestLoader.hidden=false;
    if (wasHidden && typeof requestLoader.showPopover==='function') {
      requestLoader.setAttribute('popover','manual');
      requestLoader.showPopover();
    }
  };
  if (requestLoader.hidden) {
    if (!requestTimer) requestTimer=setTimeout(()=>{requestTimer=undefined;show();},140);
  } else show();
  return ()=>{
    requests.delete(ticket);
    if (!requests.size) {
      clearTimeout(requestTimer);
      requestTimer=undefined;
      if (requestLoader.hasAttribute('popover')) {
        requestLoader.hidePopover();
        requestLoader.removeAttribute('popover');
      }
      requestLoader.hidden=true;
    } else if (!requestLoader.hidden) show();
  };
}

async function api(path, method='GET', payload) {
  const finish=startRequest(path,method);
  try {
    const response = await fetch('/api/'+path,{
      method,
      headers:{'X-AbDbAdmin':'1','Accept-Language':language,...(payload === undefined ? {} : {'Content-Type':'application/json'})},
      body:payload === undefined ? undefined : JSON.stringify(payload),
    });
    const value = await response.json();
    if (!response.ok) {
      if (response.status === 401 && !['login','session'].includes(path)) {
        tableViews.clear();scriptDraft=null;
        state.user = null;
        if (dialog.open) dialog.close();
        login();
      }
      throw Object.assign(new Error(value.error || t('Ошибка запроса')),{peer:value.peer});
    }
    return value;
  } finally {finish();}
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
  writeRoute();
  render();
}

function form(children, text, callback, footer=[]) {
  const error = e('p',{class:'form-error',role:'alert'});
  return e('form',{class:'stack',onsubmit:async event=>{
    event.preventDefault();
    const target = event.currentTarget;
    const actions = target.querySelectorAll('[type=submit]');
    actions.forEach(action=>{action.disabled=true;});
    error.textContent = '';
    try {await callback(Object.fromEntries(new FormData(target)),target,event.submitter);}
    catch (reason) {error.textContent = reason.message;}
    finally {actions.forEach(action=>{action.disabled=false;});}
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
const utilityRoutes=new Set(['users','audit']);
const databaseRoutes=new Set(['structure','tables','graph','sql','database-search','sql-script','database-objects','schema-editor','server-status','database-accounts','database-backup']);
let pendingTable=null;
let pendingTableAction=null;
let stopRowLoading=()=>{};
let sidebarContext=null;
let scriptDraft=null;
let appliedHash=null;

function allowedView(view,connection) {
  if (utilityRoutes.has(view)) return Boolean(state.user.admin);
  if (!databaseRoutes.has(view) || !connection) return false;
  if (view==='sql') return ['admin','sql'].includes(connection.level);
  if (view==='database-search') return ['mysql','mariadb'].includes(connection.engine);
  if (['sql-script','database-objects','schema-editor','server-status','database-accounts','database-backup'].includes(view)) {
    return state.user.admin && ['mysql','mariadb'].includes(connection.engine);
  }
  return true;
}
function writeRoute(replace=false) {
  if (!state.user) return;
  const params=new URLSearchParams();
  if (state.connection) params.set('connection',String(state.connection.id));
  if (state.connection || utilityRoutes.has(state.view)) params.set('view',state.view);
  const table=pendingTable ?? state.table;
  if (state.connection && table && !utilityRoutes.has(state.view)) {
    params.set('schema',table[0]);
    params.set('table',table[1]);
    if (state.view==='tables' && state.offset) params.set('offset',String(state.offset));
  }
  const hash=params.size?'#'+params:'';
  if (location.hash!==hash) history[replace?'replaceState':'pushState'](null,'',location.pathname+location.search+hash);
  appliedHash=location.hash;
}
function restoreRoute() {
  if (!state.user) return;
  pendingTableAction=null;
  const params=new URLSearchParams(location.hash.slice(1));
  const connection=state.connections.find(item=>String(item.id)===params.get('connection')) ?? null;
  const requested=params.get('view');
  const view=allowedView(requested,connection)?requested:connection?'structure':'tables';
  const table=params.get('table'), schema=params.get('schema');
  pendingTable=connection && table && schema && !utilityRoutes.has(view)?[schema,table]:null;
  const offset=Number(params.get('offset') ?? 0);
  Object.assign(state,{connection,view,schema:null,tables:[],relations:[],table:null,
    offset:view==='tables' && pendingTable && Number.isInteger(offset) && offset>=0 && offset<=1000000 && offset%50===0?offset:0});
  writeRoute(true);
  render();
}
function onRouteChange() {
  if (state.user && location.hash!==appliedHash) {
    if (dialog.open) dialog.close();
    restoreRoute();
  }
}
window.addEventListener('popstate',onRouteChange);
window.addEventListener('hashchange',onRouteChange);

function login() {
  stopRowLoading();
  sidebarContext=null;
  renderId++;
  const content = form([
    label(t('Логин'),field('name','text','',{required:true,autocomplete:'username',autofocus:true})),
    label(t('Пароль'),field('password','password','',{required:true,autocomplete:'current-password'})),
  ],t('Войти'),async data=>{
    state.user = await api('login','POST',data);
    state.view = 'tables';
    state.connection = null;
    await refreshConnections();
    restoreRoute();
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
  pendingTableAction=null;
  state.connection = state.connections.find(item=>item.id===id);
  pendingTable=null;
  Object.assign(state,{view:'structure',schema:null,tables:[],relations:[],table:null,offset:0});
  writeRoute();
  render();
}
function setView(view) { state.view=view; writeRoute(); render(); }
function changePassword() {
  openDialog(t('Сменить пароль'),form([
    label(t('Текущий пароль'),field('current','password','',{required:true,autocomplete:'current-password'})),
    label(t('Новый пароль'),field('password','password','',{required:true,minlength:12,maxlength:256,autocomplete:'new-password'})),
  ],t('Сохранить'),async data=>{await api('password','POST',data);dialog.close();toast(t('Пароль обновлён'));}));
}
function render() {
  stopRowLoading();
  if (!state.user) return login();
  const stamp = ++renderId;
  const active = state.connection;
  const admin = state.user.admin;
  const pages={users:'Пользователи',audit:'Журнал действий'};
  const utility = Object.hasOwn(pages,state.view);
  const people = state.view === 'users';
  const mysqlWorkspace = active && ['mysql','mariadb'].includes(active.engine);
  const engine = active && t(labelKeys[active.engine] ?? active.engine);
  const content = div('stack');
  const workspace=Boolean(active && !utility);
  const tableSidebar=div('sidebar-tables');
  const schemaReady=workspace?loadWorkspaceSchema(active.id,stamp,tableSidebar):null;
  const browsedTable=state.view==='tables' && (pendingTable ?? state.table);
  const heading = div('hero',e('h1',{},browsedTable?t('Таблица')+' · '+browsedTable[1]:utility?t(pages[state.view]):active?.name || t('Подключения')),
    active && !utility ? e('p',{},(browsedTable?active.name+' / '+browsedTable[0]+' · ':'')+engine+' · '+t(labelKeys[active.level])+(active.production?' · PRODUCTION':'')) : null);
  app.replaceChildren(div(workspace?'shell schema-shell':'shell',div('sidebar',
    brand(),
    div('row spread',e('span',{class:'nav-heading'},t('Подключения')),admin?button('+',()=>editConnection(), 'primary',{'aria-label':t('Добавить подключение')}):null),
    div('nav connection-tree',state.connections.map(connection=>div('connection-branch',
      button(t(labelKeys[connection.engine] ?? connection.engine)+' · '+connection.name,
        click(()=>choose(connection.id)),null,{'aria-current':String(workspace && connection.id===active.id),
          ...(workspace && connection.id===active.id?{'aria-expanded':'true'}:{})}),
      workspace && connection.id===active.id?tableSidebar:null))),
    admin?div('nav',
      button(t('Пользователи и права'),()=>setView('users'),null,{'aria-current':String(people)}),
      button(t('Журнал действий'),()=>setView('audit'),null,{'aria-current':String(state.view==='audit')})):null,
    div('grow'),
    div('stack',languagePicker(),e('small',{},state.user.name),button(t('Сменить пароль'),changePassword),button(t('Выйти'),click(async()=>{
      await api('logout','POST');tableViews.clear();scriptDraft=null;state.user=null;login();
    }))),
  ),e('main',{class:active && !utility?'main stack database-workspace'+(state.view==='structure'?' structure-workspace':''):'main stack'},heading,
    active && !utility ? div('row tabs',
      ...[['structure',t('Структура')],['graph',t('3D-схема')],...(['admin','sql'].includes(active.level)?[['sql','SQL']]:[])]
        .map(([key,title])=>button(title,()=>setView(key),null,{'aria-current':String(state.view===key)})),
      mysqlWorkspace?button(t('Поиск по базе'),()=>setView('database-search'),null,{'aria-current':String(state.view==='database-search')}):null,
      admin && mysqlWorkspace?button(t('Выгрузка и восстановление'),()=>setView('database-backup'),null,{'aria-current':String(state.view==='database-backup')}):null,
      admin && mysqlWorkspace?button(t('SQL-скрипты'),()=>setView('sql-script'),null,{'aria-current':String(state.view==='sql-script')}):null,
      admin && mysqlWorkspace?button(t('Пользователи СУБД'),()=>setView('database-accounts'),null,{'aria-current':String(state.view==='database-accounts')}):null,
      admin && mysqlWorkspace?button(t('Состояние сервера'),()=>setView('server-status'),null,{'aria-current':String(state.view==='server-status')}):null,
      admin && mysqlWorkspace?button(t('Объекты БД'),()=>setView('database-objects'),null,{'aria-current':String(state.view==='database-objects')}):null,
      admin && mysqlWorkspace?button(t('Редактор структуры'),()=>setView('schema-editor'),null,{'aria-current':String(state.view==='schema-editor')}):null,
      admin?button(t('Настройки'),click(async()=>editConnection(await api(route('settings')),active.id))):null,
    ):null,content)));
  if (state.view==='audit') return auditView(content,stamp).catch(error=>showError(content,stamp,error));
  if (people) return users(content,stamp).catch(error=>showError(content,stamp,error));
  if (!active) {
    content.append(div('panel empty',e('h2',{},admin?t('Добавьте подключение'):t('Доступных подключений пока нет')),
      e('p',{},admin?t('Укажите сервер и учётную запись базы данных.'):t('Попросите администратора выдать доступ к нужной базе.')),
      admin?button(t('Добавить подключение'),()=>editConnection(),'primary'):null));
    return;
  }
  if (state.view === 'sql') return sqlView(content);
  if (state.view==='database-backup' && mysqlWorkspace && admin) return backupView(content);
  if (state.view==='sql-script' && mysqlWorkspace && admin) return scriptsView(content,stamp);
  if (state.view==='database-search' && mysqlWorkspace) return databaseSearchView(content,stamp);
  if (state.view==='database-accounts' && mysqlWorkspace && admin) return databaseAccountsView(content,stamp).catch(error=>showError(content,stamp,error));
  if (state.view==='server-status' && mysqlWorkspace && admin) return serverStatusView(content,stamp).catch(error=>showError(content,stamp,error));
  if (state.view==='database-objects' && mysqlWorkspace && admin) return databaseObjectsView(content,stamp).catch(error=>showError(content,stamp,error));
  if (state.view === 'schema-editor' && admin && mysqlWorkspace) return schemaReady.then(loaded=>{
    if (loaded && stamp===renderId) return schemaEditor(content,stamp);
  }).catch(error=>showError(content,stamp,error));
  loadTables(content,stamp,schemaReady).catch(error=>showError(content,stamp,error));
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
  const observed=e('strong',{},t('Пока неизвестен'));
  const status=e('small',{role:'status'});
  const network=div('network wide stack',
    e('strong',{},t('Ваш IP для доступа к БД')),
    div('row',e('span',{},t('Адрес по данным сервера БД')),observed),
    state.user.sourceIp ? div('row',e('span',{},t('Настроенный исходящий IP')),e('code',{},state.user.sourceIp)) : null,
    e('small',{},t('Нажмите «Проверить подключение». Если сервер не сообщил адрес, уточните его в журнале БД или у администратора сети.')),
    status,
  );
  const content = form(div('fields',
    network,
    label(t('Название'),field('name','text',config.name,{required:true,maxlength:255}),'wide'),
    label(t('СУБД'),engine),
    label(t('Порт'),port),
    e('label',{class:'check wide'},field('production','checkbox','1',{checked:config.production}),t('Рабочая база (production)'),e('small',{},t('Показывает предупреждение при работе с реальными данными. Права доступа задаются отдельно.'))),
    label(t('Хост'),field('host','text',config.host,{required:true,placeholder:'db.example.net'})),
    label(t('База данных'),field('database','text',config.database,{required:true})),
    label(t('Пользователь БД'),field('user','text',config.user,{required:true})),
    label(t('Пароль БД'),field('password','password','',{autocomplete:'new-password',placeholder:id?t('Сохранённый пароль'):''})),
    e('label',{class:'check wide'},field('tls','checkbox','1',{checked:config.tls ?? true}),t('TLS с проверкой сертификата')),
    label(config.customCa?t('Новый PEM-сертификат CA (текущий сохранён)'):t('PEM-сертификат CA (необязательно)'),e('textarea',{name:'ca'}),'wide'),
    config.customCa?e('label',{class:'check wide'},field('removeCa','checkbox','1'),t('Удалить сохранённый сертификат CA')):null,
    id?e('label',{class:'check wide'},field('resetPassword','checkbox','1'),t('Сохранить пустой пароль БД')):null,
  ),t('Проверить и сохранить'),async (data,_form,action)=>{
    status.textContent='';
    observed.textContent=t('Пока неизвестен');
    data.port=Number(data.port);
    data.tls=Boolean(data.tls);
    data.production=Boolean(data.production);
    if (id && !data.password && !data.resetPassword) delete data.password;
    if (id && !data.ca && !data.removeCa) delete data.ca;
    let next = id;
    try {
      if (action?.value==='test') {
        const result=await api('connection-test','POST',{...data,id});
        if (result.peer) observed.textContent=result.peer;
        status.textContent=t('Подключение работает. Настройки не сохранены.');
        return;
      }
      if (id) await api(`connections/${id}/settings`,'PUT',data);
      else next = (await api('connections','POST',data)).id;
    } catch (error) {
      if (error.peer) observed.textContent=error.peer;
      throw error;
    }
    dialog.close();
    await refreshConnections();
    await choose(next);
    toast(t('Подключение сохранено'));
  },[e('button',{type:'submit',value:'test'},t('Проверить подключение')),id?button(t('Удалить подключение'),()=>confirmAction(t('Удалить подключение?'),
    t('Профиль и выданные на него права будут удалены.'),async ()=>{
      await api('connections/'+id,'DELETE');
      await refreshConnections();
      render();
    }),'danger'):null]);
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
      const picker = select('level',[['',t('Нет доступа')],['view',t('Просмотр')],['edit',t('Редактирование строк')],['sql',t('Доступ к SQL')]],values.get(connection.id) || '');
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
  'row.update':'Изменение строки','row.delete':'Удаление строки','csv.export':'Экспорт CSV','demo.enable':'Подключение демо','schema.change':'Изменение структуры','csv.import':'Импорт CSV','sql.script':'Выполнение SQL-скрипта','sql.export':'Экспорт SQL','table.maintenance':'Обслуживание таблицы',
  'db-account.create':'Создание пользователя СУБД','db-account.password':'Смена пароля пользователя СУБД',
  'db-account.drop':'Удаление пользователя СУБД','db-account.grant':'Выдача прав СУБД','db-account.revoke':'Отзыв прав СУБД','database.export':'Выгрузка базы',
  'db-object.create':'Создание события','db-object.drop':'Удаление объекта',
  'db-object.enable':'Включение события','db-object.disable':'Выключение события','db-object.schedule':'Изменение расписания','db-object.body':'Изменение команды события',
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


function backupView(target) {
  const download=button(t('Скачать SQL'),click(async ()=>{
    download.disabled=true;
    try {
      const response=await fetch('/api/'+route('database-export'),{headers:{'Accept-Language':language}});
      if (!response.ok) throw new Error((await response.json()).error || t('Ошибка запроса'));
      const objectUrl=URL.createObjectURL(await response.blob());
      const link=e('a',{href:objectUrl,download:'abdbadmin-database.sql'});
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);
    } finally {download.disabled=false;}
  }),'primary');
  target.append(div('panel stack',
    e('h2',{},t('Выгрузка и восстановление')),
    e('p',{},t('SQL-файл содержит структуру и данные таблиц InnoDB. До 30 таблиц, 5 000 строк суммарно, 1 000 строк на таблицу и 1 МБ.')),
    e('p',{},t('Представления, процедуры, триггеры, события и пользователи не включаются. Не меняйте структуру во время выгрузки.')),
    div('row',download,button(t('Открыть SQL-скрипты'),()=>setView('sql-script'))),
    e('small',{},t('Для восстановления выберите подключение к пустой базе и загрузите файл во вкладке «SQL-скрипты».'))));
}

function scriptsView(target,stamp) {
  const path=route('sql-script');
  const connection=state.connection;
  const output=div('stack');
  const file=field('file','file',undefined,{accept:'.sql,text/plain,application/sql'});
  const input=e('textarea',{name:'sql',class:'code',spellcheck:'false'});
  if (scriptDraft?.id===connection.id) input.value=scriptDraft.sql;
  scriptDraft=null;
  const warning=t('Скрипт может выполниться частично. Ранее выполненные команды не откатываются автоматически.');
  target.append(div('panel stack',e('h2',{},t('SQL-скрипты')),e('p',{},warning),
    form([label(t('SQL-файл'),file),label(t('Текст SQL'),input)],t('Предпросмотр изменений'),async ({sql})=>{
      if (file.files.length) {
        if (sql.trim()) throw new Error(t('Выберите файл или введите SQL.'));
        if (file.files[0].size>1048576) throw new Error(t('Размер SQL-файла ограничен 1 МБ.'));
        sql=new TextDecoder('utf-8',{fatal:true}).decode(await file.files[0].arrayBuffer());
      }
      const preview=await api(path,'POST',{sql});
      if (stamp!==renderId) return;
      openDialog(t('Предпросмотр изменений'),form([
        e('strong',{},(connection.production?'PRODUCTION · ':'')+connection.name+' / '+preview.database),
        e('pre',{class:'schema-sql'},sql.slice(0,8192)),
        sql.length>8192?e('small',{},t('В предпросмотре показано начало скрипта.')):null,
        e('p',{},warning),
      ],t('Выполнить'),async ()=>{
        const payload=await api(path,'POST',{sql,confirmation:preview.confirmation});
        dialog.close();
        output.replaceChildren(...payload.sets.map((set,index)=>div('panel stack',
          e('h3',{},t('Результат')+' '+(index+1)),resultTable(set),
          set.truncated?e('small',{},t('Результат сокращён.')):null)),
          ...(payload.truncated?[e('p',{},t('Часть наборов результатов скрыта.'))]:[]));
      }));
    })),output);
}

function maintenanceDialog() {
  const table=state.table[1];
  const path=route('maintenance');
  const target=state.connection.name+' / '+state.table[0]+' / '+table;
  const commands=[['CHECK',t('Проверить')],['ANALYZE',t('Обновить статистику')],['OPTIMIZE',t('Оптимизировать')]];
  const result=div('stack');
  openDialog(t('Обслуживание таблицы'),form([
    e('strong',{},(state.connection.production?'PRODUCTION · ':'')+target),
    e('p',{},t('Обслуживание может занять время и заблокировать таблицу.')),
    label(t('Действие'),select('operation',commands,'CHECK')),result,
  ],t('Выполнить'),async ({operation})=>{
    const payload=await api(path,'POST',{table,operation});
    result.replaceChildren(resultTable(payload));
  }));
}

function databaseSearchView(target,stamp) {
  const path=route('database-search');
  const output=div('stack');
  async function search(text,offset) {
    const page=await api(path,'POST',{text,offset});
    if (stamp!==renderId) return;
    output.replaceChildren(...page.results.map(result=>div('panel stack',
      e('h3',{},result.schema+'.'+result.table),
      resultTable(result),
      result.more?e('small',{},t('Показаны первые пять совпадений.')):null)));
    if (!page.results.length) output.append(e('p',{},t('В этой группе таблиц совпадений нет.')));
    if (page.next!==null) output.append(button(t('Следующие таблицы'),click(()=>search(text,page.next))));
  }
  target.append(div('panel stack',e('h2',{},t('Поиск по базе')),
    e('p',{},t('Поиск текста по столбцам. Проверяет до пяти таблиц за один запрос.')),
    form(label(t('Текст поиска'),field('text','search','',{required:true,maxlength:200})),t('Найти'),
      async ({text})=>search(text,0))),output);
}

async function databaseAccountsView(target,stamp) {
  const path=route('database-accounts');
  const connection=state.connection;
  target.append(e('p',{},t('Загрузка…')));
  const data=await api(path);
  if (stamp!==renderId) return;
  const actions={create:'Создать пользователя СУБД',password:'Сменить пароль',drop:'Удалить пользователя СУБД',
    grant:'Выдать права',revoke:'Отозвать права'};

  function edit(operation,account=[]) {
    const [username='',host='']=account;
    const needsPassword=operation==='password' || operation==='create';
    const needsPrivileges=operation==='grant' || operation==='revoke';
    const checklist=div('fields');
    if (needsPrivileges) checklist.append(...data.privileges.map(value=>e('label',{class:'check'},
      field('privilege','checkbox',value),value)));
    const title=t(actions[operation]);
    const editor=form([
      div('fields',label(t('Пользователь БД'),field('user','text',username,{required:true,maxlength:32,readonly:!!username})),
        label(t('Хост'),field('host','text',host,{required:true,maxlength:253,readonly:!!host}))),
      needsPassword?label(t('Новый пароль'),field('password','password','',{required:true,minlength:12,maxlength:255,autocomplete:'new-password'})):null,
      checklist,
    ],t('Предпросмотр изменений'),async (values,element)=>{
      const input={operation,user:values.user,host:values.host};
      if (needsPassword) input.password=values.password;
      if (needsPrivileges) input.privileges=new FormData(element).getAll('privilege');
      const preview=await api(path,'POST',input);
      openDialog(t('Предпросмотр изменений'),form([
        e('strong',{},(connection.production?'PRODUCTION · ':'')+connection.name),
        e('p',{},title+' · '+input.user+'@'+input.host),
        needsPrivileges?e('p',{},preview.database+' · '+input.privileges.join(', ')):null,
        operation==='drop'?e('p',{},t('Удаление учётной записи влияет на весь сервер БД.')):null,
      ],t('Подтвердить'),async ()=>{
        await api(path,'POST',{...input,confirmation:preview.confirmation});
        dialog.close();
        render();
      },button(t('Назад'),()=>openDialog(title,editor))));
    });
    openDialog(title,editor);
  }

  target.replaceChildren(div('panel stack',
    div('row spread',e('h2',{},t('Пользователи СУБД')),button(t(actions.create),()=>edit('create'),'primary')),
    data.accounts.length?resultTable({columns:[t('Пользователь БД'),t('Хост')],rows:data.accounts},row=>{
      const own=row.join('@')===data.current;
      return div('row',
        button(t(actions.grant),()=>edit('grant',row)),
        button(t(actions.revoke),()=>edit('revoke',row)),
        own?null:button(t(actions.password),()=>edit('password',row)),
        own?null:button(t('Удалить'),()=>edit('drop',row),'danger'));
    }):e('p',{},t('Объекты не найдены.')),
    data.truncated?e('small',{},t('Результат сокращён.')):null),
    div('panel stack',e('h2',{},t('Права на базу')+' · '+data.database),
      data.grants.length?resultTable({columns:[t('Пользователь БД'),t('Право')],rows:data.grants}):e('p',{},t('Объекты не найдены.'))));
}
async function serverStatusView(target,stamp) {
  target.replaceChildren(e('p',{},t('Загрузка…')));
  const data=await api(route('server-status'));
  if (stamp!==renderId) return;
  target.replaceChildren(div('panel stack',
    div('row spread',e('h2',{},t('Состояние сервера')),button(t('Повторить'),render)),
    resultTable({columns:[t('Параметр'),t('Значение')],rows:data.status}),
    e('h3',{},t('Настройки сервера')),
    resultTable({columns:[t('Параметр'),t('Значение')],rows:data.variables}),
    e('h3',{},t('Права подключённой учётной записи')),
    resultTable({columns:['GRANT'],rows:data.grants}),
  ));
}
async function databaseObjectsView(target,stamp) {
  const path=route('object-definition');
  const changePath=route('object-change');
  const connection=state.connection;
  const data=await api(route('database-objects'));
  if (stamp!==renderId) return;
  const lists=[
    ['Процедуры и функции',['Имя','Тип','Доступ к данным'],data.routines,row=>row[1]],
    ['Триггеры',['Имя','Таблица','Момент','Действие'],data.triggers,()=>'TRIGGER'],
    ['События',['Имя','Статус','Тип'],data.events,()=>'EVENT'],
  ];

  function draft(sql) {
    scriptDraft={id:connection.id,sql};
    if (dialog.open) dialog.close();
    setView('sql-script');
  }

  function change(title,fields,makeInput) {
    const editor=form(fields,t('Предпросмотр изменений'),async values=>{
      const input=makeInput(values);
      const preview=await api(changePath,'POST',{...input,preview:true});
      if (stamp!==renderId) return;
      openDialog(t('Предпросмотр изменений'),form([
        e('strong',{},(connection.production?'PRODUCTION · ':'')+connection.name+' / '+preview.database),
        e('p',{},t('Вы точно хотите внести эти изменения?')),
        e('pre',{class:'schema-sql'},preview.sql),
      ],t('Подтвердить'),async ()=>{
        await api(changePath,'POST',{...input,confirmation:preview.confirmation});
        dialog.close();
        render();
      },button(t('Назад'),()=>openDialog(title,editor))));
    });
    openDialog(title,editor);
  }
  const schedule=()=>div('fields',
    label(t('Интервал'),field('amount','number','1',{min:1,max:100000,required:true})),
    label(t('Единица времени'),select('unit',['MINUTE','HOUR','DAY','WEEK','MONTH'].map(value=>[value,t(value)]),'HOUR')));
  function createEvent() {
    change(t('Создать событие'),[
      label(t('Название'),field('name','text','',{required:true,maxlength:64})),
      schedule(),
      label(t('Текст SQL'),e('textarea',{name:'sql',class:'code',required:true,maxlength:65000})),
      e('small',{},t('Новое событие создаётся выключенным.')),
    ],values=>({kind:'EVENT',operation:'create',...values,amount:Number(values.amount)}));
  }
  const templates={
    PROCEDURE:'CREATE PROCEDURE procedure_name()\nBEGIN\n  SELECT 1;\nEND',
    FUNCTION:'CREATE FUNCTION function_name() RETURNS INT DETERMINISTIC\nRETURN 1',
    TRIGGER:'CREATE TRIGGER trigger_name BEFORE INSERT ON table_name FOR EACH ROW\nSET NEW.column_name = NEW.column_name',
  };
  target.append(div('panel row',
    button(t('Создать событие'),createEvent,'primary'),
    ...[['PROCEDURE','Шаблон процедуры'],['FUNCTION','Шаблон функции'],['TRIGGER','Шаблон триггера']]
      .map(([key,title])=>button(t(title),()=>draft(templates[key])))));

  function controls(row,kind) {
    const name=row[0];
    const describe=button(t('Определение SQL'),click(async ()=>{
      const {sql}=await api(path+'?'+new URLSearchParams({kind,name}));
      if (stamp!==renderId) return;
      openDialog(t('Определение SQL'),div('stack',e('pre',{class:'schema-sql'},sql),
        button(t('Открыть в SQL-скриптах'),()=>draft(sql))));
    }));
    const switchEvent=()=>{
      const operation=row[1]==='ENABLED'?'disable':'enable';
      const title=t(operation==='enable'?'Включить событие':'Выключить событие');
      change(title,e('p',{},name),()=>({kind,name,operation}));
    };
    return div('row',describe,
      kind==='EVENT'?button(t(row[1]==='ENABLED'?'Выключить событие':'Включить событие'),switchEvent):null,
      kind==='EVENT'?button(t('Изменить интервал'),()=>change(t('Изменить интервал'),schedule(),
        values=>({kind,name,operation:'schedule',unit:values.unit,amount:Number(values.amount)}))):null,
      kind==='EVENT'?button(t('Изменить команду события'),()=>change(t('Изменить команду события'),[
        e('strong',{},name),
        label(t('Текст SQL'),e('textarea',{name:'sql',class:'code',required:true,maxlength:65000})),
      ],values=>({kind,name,operation:'body',sql:values.sql}))):null,
      button(t('Удалить'),()=>change(t('Удалить объект'),e('p',{},kind+' · '+name),()=>({kind,name,operation:'drop'})),'danger'));
  }
  for (const [title,headers,rows,kind] of lists) target.append(div('panel stack',
    e('h2',{},t(title)),rows.length?resultTable({columns:headers.map(header=>t(header)),rows},row=>controls(row,kind(row))):
      e('p',{},t('Объекты не найдены.'))));
}

function openCsvImport() {
  const table=state.table[1];
  const target=state.connection.name+' / '+state.table[0]+' / '+table;
  const path=route('csv-import');
  const file=field('file','file',undefined,{required:true,accept:'.csv,text/csv'});
  const editor=form([
    e('strong',{},(state.connection.production?'PRODUCTION · ':'')+target),
    e('p',{},t('CSV в UTF-8 с заголовками столбцов и разделителем-запятой. До 200 строк и 64 КБ.')),
    label(t('CSV-файл'),file),
  ],t('Предпросмотр изменений'),async ()=>{
    const selected=file.files[0];
    if (!selected || selected.size>65536) throw new Error(t('Выберите CSV-файл размером до 64 КБ.'));
    let csv;
    try { csv=new TextDecoder('utf-8',{fatal:true}).decode(await selected.arrayBuffer()); }
    catch {throw new Error(t('Файл должен быть в UTF-8.'));}
    const preview=await api(path,'POST',{table,csv});
    openDialog(t('Импорт CSV'),form([
      e('strong',{},target),
      e('p',{},t('Будет добавлено строк: {count}',{count:preview.rows})),
      e('p',{},preview.columns.join(', ')),
    ],t('Подтвердить'),async ()=>{
      const result=await api(path,'POST',{table,csv,confirmation:preview.confirmation});
      dialog.close();
      toast(t('Добавлено строк: {count}',{count:result.rows}));
      render();
    },button(t('Назад'),()=>openDialog(t('Импорт CSV'),editor))));
  });
  openDialog(t('Импорт CSV'),editor);
}

async function schemaEditor(target,stamp) {
  const path=route('structure-editor');
  const connection=state.connection;
  const [settings,schema]=await Promise.all([api(path),state.schema?Promise.resolve(state):api(route('schema'))]);
  if (stamp!==renderId) return;
  if (!state.schema) Object.assign(state,{schema:true,...schema});
  if (pendingTable) {
    state.table=state.tables.find(row=>row[0]===pendingTable[0] && row[1]===pendingTable[1]) ?? null;
    pendingTable=null;
    writeRoute(true);
  }
  const tables=state.tables.filter(([schema,,type])=>schema===settings.database && type==='BASE TABLE');
  const picker=select('table',tables.map(([,name])=>[name,name]),state.table?.[1] ?? tables[0]?.[1]);
  if (!picker.value && tables.length) picker.value=tables[0][1];
  const details=div('stack');
  const nameField=()=>label(t('Название'),field('name','text','',{required:true,maxlength:64}));
  const pickColumn=(name,columns,title=t('Столбец'))=>select(name,columns.map(column=>[column,column]),columns[0],{required:true,'aria-label':title});

  function operation(title,inputs,makeInput) {
    const editor=form(inputs,t('Предпросмотр изменений'),async values=>{
      const input=makeInput(values);
      const preview=await api(path,'POST',{...input,preview:true});
      openDialog(t('Предпросмотр изменений'),form([
        e('strong',{},(connection.production?'PRODUCTION · ':'')+connection.name+' / '+settings.database),
        e('p',{},t('Вы точно хотите внести эти изменения?')),
        e('pre',{class:'schema-sql'},preview.sql),
        input.engine==='MyISAM'?e('p',{},t('MyISAM не поддерживает транзакции и внешние ключи.')):null,
        e('p',{},t('Изменения структуры могут применяться без возможности отката.')),
      ],t('Подтвердить'),async ()=>{
        await api(path,'POST',{...input,confirmation:preview.confirmation});
        state.schema=null;state.table=null;state.offset=0;
        const nextTable=input.operation==='drop-table'?null:input.operation==='rename-table'?input.name:input.table;
        pendingTable=nextTable?[settings.database,nextTable]:null;
        writeRoute(true);
        dialog.close();
        render();
      },button(t('Назад'),()=>openDialog(title,editor))));
    });
    openDialog(title,editor);
  }

  function columnFields(index,primary=false) {
    return div('fields',label(t('Столбец'),field('column'+index,'text','',{required:true,maxlength:64})),
      label(t('Тип'),select('type'+index,settings.columnTypes.map(type=>[type,type]),'INT')),
      e('label',{class:'check'},field('null'+index,'checkbox','1'),t('Допускает NULL')),
      primary?e('label',{class:'check'},field('primary'+index,'checkbox','1'),t('Первичный ключ')):null);
  }
  const asColumn=(values,index)=>({name:values['column'+index],type:values['type'+index],
    nullable:Boolean(values['null'+index]),primary:Boolean(values['primary'+index])});

  function createTable() {
    const fields=div('stack',columnFields(0,true));
    const add=button(t('Добавить столбец'),()=>{
      fields.append(columnFields(fields.children.length,true));
      add.disabled=fields.children.length>=30;
    });
    operation(t('Создать таблицу'),[nameField(),fields,add],values=>({
      operation:'create-table',table:values.name,
      columns:Array.from(fields.children,(_,index)=>asColumn(values,index)),
    }));
  }

  async function loadDefinition() {
    const table=picker.value;
    if (!table) return;
    details.replaceChildren(e('p',{},t('Загрузка…')));
    const definition=await api(path+'?'+new URLSearchParams({table}));
    if (stamp!==renderId || table!==picker.value) return;
    const columns=definition.columns.map(row=>row[0]);
    const indexes=[...new Set(definition.indexes.map(row=>row[0]).filter(name=>name!=='PRIMARY'))];
    const foreignKeys=[...new Set(definition.foreignKeys.map(row=>row[0]))];
    const edit=(code,title,inputs,values)=>button(t(title),()=>operation(t(title),inputs(),input=>({operation:code,table,...values(input)})));
    function addForeignKey() {
      const ref=select('referencedTable',tables.map(([,name])=>[name,name]),table);
      const referenced=div('stack');
      async function refresh() {
        const target=ref.value;
        referenced.replaceChildren();
        const selected=await api(path+'?'+new URLSearchParams({table:target}));
        if (ref.value===target) referenced.replaceChildren(label(t('Целевой столбец'),pickColumn('referencedColumn',selected.columns.map(row=>row[0]))));
      }
      ref.addEventListener('change',click(refresh));
      operation(t('Добавить внешний ключ'),[nameField(),label(t('Столбец'),pickColumn('columnName',columns)),
        label(t('Целевая таблица'),ref),referenced],values=>({operation:'add-foreign-key',table,...values}));
      refresh().catch(report);
    }
    const columnList=()=>label(t('Столбец'),pickColumn('columnName',columns));
    const eligible=new Map(definition.columnChanges);
    const engineChoices=settings.tableEngines.filter(engine=>engine!==definition.engine && (engine!=='MyISAM' || !definition.hasForeignKeys));
    function modifyColumn(row) {
      const [name,type,nullable]=row;
      const types=settings.columnTypes.map(value=>[value,value]);
      const initial=types.find(([value])=>value.toLowerCase()===type.toLowerCase())?.[0] ?? '';
      operation(t('Изменить тип столбца'),[
        e('strong',{},name+' · '+type),
        label(t('Новый тип'),select('type',[['',t('Выберите тип')],...types],initial,{required:true})),
        e('label',{class:'check'},field('nullable','checkbox','1',{checked:nullable==='YES'}),t('Допускает NULL')),
        e('small',{},t('Смена типа преобразует существующие значения.')),
      ],v=>({operation:'modify-column',table,column:{name,type:v.type,nullable:Boolean(v.nullable)}}));
    }
    details.replaceChildren(
      div('row',
        e('strong',{},t('Движок таблицы')+' · '+definition.engine),
        engineChoices.length?edit('change-engine','Сменить движок',()=>label(t('Новый движок'),
          select('engine',engineChoices.map(engine=>[engine,engine]),engineChoices[0])),v=>v):null,
        edit('rename-table','Переименовать таблицу',()=>nameField(),v=>v),
        edit('drop-table','Удалить таблицу',()=>e('p',{},table),()=>({}))),
      e('h3',{},t('Столбцы')),
      resultTable({columns:[t('Имя'),t('Тип'),t('Допускает NULL'),t('По умолчанию'),t('Дополнительно')],rows:definition.columns},row=>eligible.get(row[0])
        ?button(t('Изменить тип'),()=>modifyColumn(row))
        :e('small',{},t('Особые свойства столбца'))),
      div('row',
        edit('add-column','Добавить столбец',()=>columnFields(0),v=>({column:asColumn(v,0)})),
        edit('rename-column','Переименовать столбец',()=>[columnList(),nameField()],v=>v),
        edit('drop-column','Удалить столбец',()=>columnList(),v=>v)),
      e('h3',{},t('Индексы')),
      resultTable({columns:[t('Имя'),t('Столбец'),t('Уникальный')],rows:definition.indexes.map(([name,column,nonUnique])=>[name,column,t(nonUnique?'Нет':'Да')])}),
      div('row',
        edit('add-index','Добавить индекс',()=>[nameField(),columnList(),e('label',{class:'check'},field('unique','checkbox','1'),t('Уникальный'))],
          v=>({name:v.name,keys:[v.columnName],unique:Boolean(v.unique)})),
        indexes.length?edit('drop-index','Удалить индекс',()=>label(t('Имя'),pickColumn('name',indexes)),v=>v):null),
      e('h3',{},t('Внешние ключи')),
      resultTable({columns:[t('Имя'),t('Столбец'),t('Схема'),t('Целевая таблица'),t('Целевой столбец')],rows:definition.foreignKeys}),
      div('row',button(t('Добавить внешний ключ'),addForeignKey),
        foreignKeys.length?edit('drop-foreign-key','Удалить внешний ключ',()=>label(t('Имя'),pickColumn('name',foreignKeys)),v=>v):null),
    );
  }

  picker.addEventListener('change',click(async ()=>{
    state.table=tables.find(row=>row[1]===picker.value) ?? null;writeRoute();await loadDefinition();
  }));
  target.replaceChildren(div('panel stack',
    div('row spread',e('h2',{},t('Редактор структуры')),button(t('Создать таблицу'),createTable,'primary')),
    tables.length?label(t('Таблица'),picker):e('p',{},t('Подходящих таблиц нет.')),details));
  if (pendingTableAction==='create-table') {
    pendingTableAction=null;
    createTable();
  }
  await loadDefinition();
}

function openWorkspaceTable(table,view='tables',action=null) {
  pendingTableAction=action;
  pendingTable=null;
  state.table=table;
  state.offset=0;
  setView(view);
}

async function loadWorkspaceSchema(id,stamp,sidebar) {
  if (sidebarContext?.id!==id) sidebarContext={id,needle:'',scroll:0};
  const context=sidebarContext;
  sidebar.append(e('small',{},t('Загрузка структуры…')));
  try {
    if (!state.schema) {
      const payload=await api('connections/'+id+'/schema');
      if (stamp!==renderId) return false;
      Object.assign(state,{schema:true,...payload});
    }
    if (stamp!==renderId) return false;
    const search=e('input',{type:'search',value:context.needle,placeholder:t('Поиск таблиц'),'aria-label':t('Фильтр таблиц слева')});
    const list=div('table-tree-list');
    list.addEventListener('scroll',()=>{if (list.isConnected) context.scroll=list.scrollTop;});
    const multipleSchemas=new Set(state.tables.map(row=>row[0])).size>1;
    const selected=pendingTable ?? state.table;
    function filter() {
      const needle=context.needle.trim().toLowerCase();
      const tables=state.tables.filter(([schema,name])=>(schema+'.'+name).toLowerCase().includes(needle));
      list.replaceChildren(...tables.map(table=>{
        const [schema,name]=table;
        const isCurrent=selected?.[0]===schema && selected?.[1]===name;
        return button((multipleSchemas?schema+'.':'')+name,()=>openWorkspaceTable(table),'tree-table',
          {title:schema+'.'+name,'aria-current':String(isCurrent)});
      }));
      if (!tables.length) list.append(e('small',{},t('Подходящих таблиц нет.')));
    }
    search.addEventListener('input',()=>{context.needle=search.value;context.scroll=0;filter();list.scrollTop=0;});
    const mysql=['mysql','mariadb'].includes(state.connection.engine);
    sidebar.replaceChildren(search,state.user.admin && mysql
      ?button(t('Новая таблица'),()=>{pendingTableAction='create-table';setView('schema-editor');},'tree-create'):document.createTextNode(''),list);
    filter();
    queueMicrotask(()=>{if (list.isConnected) list.scrollTop=context.scroll;});
    return true;
  } catch (error) {
    if (stamp===renderId) sidebar.replaceChildren(e('small',{role:'alert'},error.message),button(t('Повторить'),render));
    return false;
  }
}

function databaseStructure(target) {
  const search=e('input',{type:'search',placeholder:t('Имя таблицы или схемы')});
  const results=div('table-wrap catalog-grid');
  const connection=state.connection;
  const mysql=['mysql','mariadb'].includes(connection.engine);
  const canEdit=state.user.admin && mysql;
  const number=new Intl.NumberFormat(language);
  const checked=new Set();
  const onlySelected=field('onlySelected','checkbox','1');
  const selectionStatus=e('small',{role:'status'});
  const tableKey=([schema,name])=>JSON.stringify([schema,name]);
  const bytes=value=>{
    const n=Number(value);
    if (n>=1048576) return number.format(Math.round(n/104857.6)/10)+' MiB';
    if (n>=1024) return number.format(Math.round(n/102.4)/10)+' KiB';
    return number.format(n)+' B';
  };
  function action(title,icon,fn,style='') {
    return e('button',{type:'button',class:'catalog-action '+style,onclick:fn},
      e('span',{'aria-hidden':'true',class:'catalog-icon'},icon),t(title));
  }
  const bulkChoices=[
    ['CHECK',t('Проверить')],['ANALYZE',t('Обновить статистику')],['OPTIMIZE',t('Оптимизировать')],
    ['truncate-table',t('Очистить')],['drop-table',t('Удалить')],
  ];
  const bulkSelect=select('bulk',[['',t('С выбранными')],...bulkChoices],'');
  const bulkRun=button(t('Продолжить'),click(async ()=>{
    const operation=bulkSelect.value;
    const selected=state.tables.filter(table=>checked.has(tableKey(table)) && table[2]==='BASE TABLE');
    if (!operation || !selected.length) return;
    if (selected.length>20) throw new Error(t('Выберите не более 20 таблиц.'));
    const destructive=operation==='truncate-table' || operation==='drop-table';
    const path=route(destructive?'structure-editor':'maintenance');
    const title=bulkChoices.find(([key])=>key===operation)[1];
    const result=div('stack');
    const review=form([
      e('strong',{},(connection.production?'PRODUCTION · ':'')+connection.name+' · '+title),
      e('p',{},t('Вы точно хотите внести эти изменения?')),
      e('p',{},selected.map(table=>table[1]).join(', ')),
      destructive?e('p',{},t('Действия выполняются по очереди. При ошибке предыдущие изменения могут сохраниться.')):null,
      result,
    ],t('Подтвердить'),async (_values,element)=>{
      const reportRows=[];
      result.replaceChildren(e('p',{},t('Выполняем запрос…')));
      for (const [,table] of selected) {
        if (!element.isConnected || !dialog.open) return;
        try {
          if (destructive) {
            const input={table,operation};
            const preview=await api(path,'POST',{...input,preview:true});
            if (!element.isConnected || !dialog.open) return;
            await api(path,'POST',{...input,confirmation:preview.confirmation});
            reportRows.push([table,t('Готово')]);
          } else {
            const response=await api(path,'POST',{table,operation});
            for (const row of response.rows) reportRows.push([table,[row[2],row[3]].filter(Boolean).join(' · ')]);
          }
        } catch (error) {
          reportRows.push([table,error.message]);
          break;
        }
      }
      if (!element.isConnected || !dialog.open) return;
      result.replaceChildren(resultTable({columns:[t('Таблица'),t('Результат')],rows:reportRows}),
        button(t('Закрыть'),()=>{
          dialog.close();state.schema=null;render();
        }));
      // A completed batch is never resubmitted from this confirmation.
      element.querySelector('[type=submit]').remove();
    });
    openDialog(t('С выбранными'),review);
  }));
  bulkSelect.addEventListener('change',updateBulk);
  function updateBulk() {
    const selected=state.tables.some(table=>table[2]==='BASE TABLE' && checked.has(tableKey(table)));
    bulkSelect.disabled=!selected;
    bulkRun.disabled=!selected || !bulkSelect.value;
  }
  function update() {
    const needle=search.value.trim().toLowerCase();
    const visible=state.tables.filter(table=> {
      const [schema,name]=table;
      return (schema+'.'+name).toLowerCase().includes(needle) &&
        (!onlySelected.checked || checked.has(tableKey(table)));
    });
    const selectAll=field('selectAll','checkbox','1',{'aria-label':t('Выбрать видимые таблицы'),
      checked:visible.length>0 && visible.every(table=>checked.has(tableKey(table)))});
    selectAll.indeterminate=visible.some(table=>checked.has(tableKey(table)))&&!selectAll.checked;
    selectAll.addEventListener('change',()=>{
      for (const table of visible) {
        const key=tableKey(table);
        if (selectAll.checked) checked.add(key); else checked.delete(key);
      }
      update();
    });
    const headers=[t('Таблица'),t('Действия'),...(mysql?[t('Строки'),t('Тип'),t('Сравнение'),t('Размер'),t('Фрагментация')]:[t('Схема'),t('Тип')])];
    results.replaceChildren(e('table',{class:'structure-grid'},
      e('thead',{},e('tr',{},e('th',{scope:'col',class:'catalog-choice'},selectAll),
        headers.map(title=>e('th',{scope:'col'},title)))),
      e('tbody',{},visible.map(table=>{
        const [schema,name,type,rows,engine,collation,size,free]=table;
        const key=tableKey(table);
        const base=type==='BASE TABLE';
        const selected=field('tableSelected','checkbox','1',{'aria-label':name,checked:checked.has(key)});
        selected.addEventListener('change',()=>{if (selected.checked) checked.add(key);else checked.delete(key);update();});
        return e('tr',{},
          e('td',{class:'catalog-choice'},selected),
          e('td',{class:'catalog-name'},button(name,()=>openWorkspaceTable(table),'table-link',{title:schema+'.'+name})),
          e('td',{class:'catalog-action-cell'},div('row catalog-actions',
            canEdit && base?action('Структура','▤',()=>openWorkspaceTable(table,'schema-editor')):null)),
          ...(mysql?[rows==null?'—':number.format(Number(rows)),engine ?? t('Представление БД'),collation ?? '—',
            size==null?'—':bytes(size),Number(free)>0?bytes(free):'—']:[schema,type]).map(value=>e('td',{class:'catalog-meta'},value)));
      }))));
    selectionStatus.textContent=t('Выбрано таблиц: {count}',{count:checked.size});
    updateBulk();
    if (!visible.length) results.append(e('p',{},t('Подходящих таблиц нет.')));
  }
  search.addEventListener('input',update);
  onlySelected.addEventListener('change',update);
  target.append(div('catalog-panel',
    e('fieldset',{class:'catalog-filter'},e('legend',{},t('Фильтры')),
      div('row',label(t('Содержит слово'),search),
        e('label',{class:'check'},onlySelected,t('Только выбранные')))),
    results,div('row spread catalog-summary',selectionStatus,canEdit?div('row catalog-bulk',bulkSelect,bulkRun):null,
      button(t('Обновить структуру'),()=>{state.schema=null;render();}))));
  update();
  const footer=target.querySelector('.catalog-summary');
  if (typeof ResizeObserver==='function') {
    const workspace=target.closest('main');
    const resize=new ResizeObserver(()=>{
      workspace.style.setProperty('--catalog-footer-height',footer.offsetHeight+'px');
    });
    resize.observe(footer);
    stopRowLoading=()=>resize.disconnect();
  }
}

async function loadTables(target,stamp,schemaReady) {
  target.append(div('panel',t('Загрузка структуры…')));
  const loaded=await schemaReady;
  if (stamp!==renderId) return;
  target.replaceChildren();
  if (!loaded) {
    target.append(div('panel',button(t('Повторить'),render)));
    return;
  }
  if (!state.tables.length) {
    target.append(div('panel empty',e('h2',{},t('Таблиц пока нет')),e('p',{},t('Проверьте права пользователя БД и выбранную базу.')),
      button(t('Обновить структуру'),()=>{state.schema=null;render();})));
    return;
  }
  if (pendingTable) {
    state.table=state.tables.find(row=>row[0]===pendingTable[0] && row[1]===pendingTable[1]) ?? null;
    pendingTable=null;
    if (!state.table) state.offset=0;
  }
  if (state.view==='graph') {writeRoute(true);return graph(target);}
  if (state.view==='structure') {writeRoute(true);return databaseStructure(target);}
  if (!state.table) state.table=state.tables[0];
  target.closest('main').querySelector('h1').textContent=t('Таблица')+' · '+state.table[1];
  writeRoute(true);
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
  const editable = state.connection.level!=='view' && state.table[2]==='BASE TABLE';
  const rowActions=page=>editable && page.definition.some(field=>field[3]) && !page.unsafeKey
    ? row=>button(t('Изменить'),()=>rowDialog(page,path,row)) : null;
  const showActions=editable && data.definition.some(field=>field[3]);
  const actionCell=page=>showActions ? (rowActions(page) ?? (()=>'—')) : null;
  const nativeAdmin=state.user.admin && editable && ['mysql','mariadb'].includes(state.connection.engine);
  const columnMetadata=new Map(data.definition.map(column=>[column[0],column]));
  const gridOptions=page=>({
    rowEdit:rowActions(page)?row=>rowDialog(page,path,row):null,
    header:name=>columnHeader(name,columnMetadata.get(name),state.user.admin && editable),
    tableClass:'structure-grid row-data-grid',
  });
  const grid=resultTable(data,actionCell(data),gridOptions(data));
  grid.classList.add('browsing-grid');
  const count=e('small',{role:'status'});
  const loadButton=button(t('Загрузить ещё'),click(loadMore));
  const footer=div('row spread browse-end',count,loadButton);
  grid.append(footer);
  let offset=state.offset+data.rows.length, loading=false;
  let more=data.truncated && offset<=1000000;
  let observer;
  function updateStatus(message) {
    count.textContent=message ?? (offset>state.offset
      ? t('Строки {start}–{end}',{start:state.offset+1,end:offset}):t('Строк нет'));
    loadButton.hidden=!more;
  }
  async function loadMore() {
    if (stamp!==renderId || !more || loading) return;
    loading=true;
    loadButton.disabled=true;
    updateStatus(t('Загрузка…'));
    try {
      const url=new URLSearchParams(path.split('?')[1]);
      url.set('offset',String(offset));
      const page=await api(path.split('?')[0]+'?'+url);
      if (stamp!==renderId) return;
      if (JSON.stringify(page.columns)!==JSON.stringify(data.columns)) {
        more=false;
        updateStatus(t('Структура изменилась. Обновите таблицу.'));
        observer?.disconnect();
        return;
      }
      const tableBody=grid.querySelector('tbody');
      tableBody.append(...resultTable(page,actionCell(page),{rowEdit:gridOptions(page).rowEdit}).querySelector('tbody').children);
      offset+=page.rows.length;
      more=page.truncated && page.rows.length>0 && offset<=1000000;
      updateStatus();
      if (more) {
        observer?.unobserve(footer);
        observer?.observe(footer);
      } else observer?.disconnect();
    } catch (error) {
      if (stamp===renderId) {
        observer?.disconnect();
        updateStatus(error.message);
      }
    } finally {
      loading=false;
      loadButton.disabled=false;
    }
  }
  updateStatus();
  const csv = e('a',{href:'/api/'+route('csv')+'?'+rowParams()},t('CSV · до 500 строк'));
  const exportSql=nativeAdmin?e('a',{href:'/api/'+route('sql-export')+'?'+new URLSearchParams({table:state.table[1]})},t('Экспорт SQL')):null;
  target.append(div('catalog-panel browse-panel',
    div('row spread browse-toolbar',
      div('row row-transfer',csv,exportSql,nativeAdmin?button(t('Импорт CSV'),openCsvImport):null),
      div('row',nativeAdmin?button(t('Обслуживание таблицы'),maintenanceDialog):null,
        editable?button(t('Добавить строку'),()=>rowDialog(data,path),'primary'):null)),
    div('browse-filters',filterControls(data.columns)),
    grid));
  if (more && typeof IntersectionObserver==='function') {
    observer=new IntersectionObserver(entries=>{
      if (entries.some(entry=>entry.isIntersecting)) loadMore();
    },{root:grid,rootMargin:'0px 0px 160px 0px'});
    observer.observe(footer);
  }
  stopRowLoading=()=>{observer?.disconnect();};
}
function resultTable(data,actions,{header,rowEdit,tableClass}={}) {
  if (!data.columns.length) return e('p',{},data.affected==null?t('Запрос выполнен'):t('Затронуто строк: {count}',{count:data.affected}));
  return div('table-wrap',e('table',tableClass?{class:tableClass}:{},
    e('thead',{},e('tr',{},data.columns.map(name=>e('th',{scope:'col'},header?header(name):name)),actions?e('th',{scope:'col'},t('Действия')):null)),
    e('tbody',{},data.rows.map(row=>{
      const tr=e('tr',rowEdit?{class:'editable-row'}:{},
        row.map(value=>e('td',{},value==null?e('i',{},'NULL'):String(value))),
        actions?e('td',{class:'actions'},actions(row)):null);
      if (rowEdit) tr.addEventListener('dblclick',event=>{
        if (!event.target.closest('button,a,input,select,textarea')) rowEdit(row);
      });
      return tr;
    })),
  ));
}
function columnHeader(name,definition,editable) {
  if (!definition) return name;
  const [,type,nullable,key,metadata={}]=definition;
  const propertyLabels={
    column_default:'По умолчанию',character_maximum_length:'Длина',numeric_precision:'Точность',
    numeric_scale:'Масштаб',datetime_precision:'Точность времени',collation_name:'Сравнение',
    character_set_name:'Кодировка',generation_expression:'Выражение генерации',udt_name:'Тип СУБД',
    is_identity:'Столбец идентификатора',identity_generation:'Генерация идентификатора',
    is_generated:'Вычисляемый столбец',column_key:'Индекс',extra:'Дополнительно',column_comment:'Комментарий',
  };
  const properties=Object.entries(propertyLabels).flatMap(([property,label])=>{
    const value=metadata[property];
    return value==null || value===''?[]:[e('dt',{},t(label)),e('dd',{},String(value))];
  });
  return div('column-heading',
    div('row column-name',e('strong',{},name),editable?button('✎',click(()=>editBrowseColumn(name)),'column-pencil',
      {'aria-label':t('Изменить столбец')+' '+name,title:t('Изменить столбец')}):null),
    e('small',{},[metadata.column_type ?? type,nullable==='YES'?'NULL':'NOT NULL',key?'PK':null].filter(Boolean).join(' · ')),
    properties.length?e('details',{},e('summary',{},t('Свойства столбца')),e('dl',{},properties)):null);
}

async function editBrowseColumn(name) {
  const stamp=renderId;
  const [schema,table]=state.table;
  const path=route('structure-editor');
  const [settings,definition]=await Promise.all([api(path),api(path+'?'+new URLSearchParams({schema,table}))]);
  if (stamp!==renderId) return;
  const column=definition.columns.find(([current])=>current===name);
  if (!column) throw new Error(t('Столбец недоступен'));
  const [,type,nullable]=column;
  const canModify=new Map(definition.columnChanges).get(name);
  const title=t('Изменить столбец')+' · '+name;
  function operation(inputs,makeInput) {
    const editor=form(inputs,t('Предпросмотр изменений'),async values=>{
      const input={schema,table,...makeInput(values)};
      const preview=await api(path,'POST',{...input,preview:true});
      openDialog(t('Предпросмотр изменений'),form([
        e('strong',{},[state.connection.name,schema,table].join(' / ')),
        e('p',{},t('Вы точно хотите внести эти изменения?')),
        e('pre',{class:'schema-sql'},preview.sql),
        e('p',{},t('Изменения структуры могут применяться без возможности отката.')),
      ],t('Подтвердить'),async ()=>{
        await api(path,'POST',{...input,confirmation:preview.confirmation});
        if (input.operation==='rename-column') {
          const view=currentTableView();
          const rename=rule=>rule.column===name?{...rule,column:input.name}:rule;
          dialog.close();
          state.schema=null;
          applyTableView({filters:view.filters.map(rename),sort:view.sort?rename(view.sort):null});
          return;
        }
        dialog.close();
        state.schema=null;
        render();
      },button(t('Назад'),()=>openDialog(title,editor))));
    });
    openDialog(title,editor);
  }
  const typeOptions=settings.columnTypes.map(value=>[value,value]);
  const initial=typeOptions.find(([value])=>value.toLowerCase()===type.toLowerCase())?.[0] ?? '';
  openDialog(title,div('row',
    button(t('Переименовать столбец'),()=>operation(
      label(t('Название'),field('name','text',name,{required:true,maxlength:64})),
      values=>({operation:'rename-column',columnName:name,name:values.name}))),
    canModify?button(t('Изменить тип столбца'),()=>operation([
      label(t('Новый тип'),select('type',[['',t('Выберите тип')],...typeOptions],initial,{required:true})),
      e('label',{class:'check'},field('nullable','checkbox','1',{checked:nullable==='YES'}),t('Допускает NULL')),
      e('small',{},t('Смена типа преобразует существующие значения.')),
    ],values=>({operation:'modify-column',column:{name,type:values.type,nullable:Boolean(values.nullable)}}))):
      e('small',{},t('Особые свойства столбца'))));
}

function filterControls(columns) {
  const view=currentTableView();
  const items=div('stack');
  const choices=columns.map(name=>[name,name]);
  const sort=select('sort',[['',t('По умолчанию')],...choices],view.sort?.column ?? '');
  const direction=select('direction',[['asc',t('По возрастанию')],['desc',t('По убыванию')]],view.sort?.direction ?? 'desc');
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
    const item=div('filter-condition',
      label(t('Столбец'),column),label(t('Условие'),operator),
      label(t('Значение'),value),button(t('Удалить'),()=>{
        item.remove();add.disabled=false;
      }));
    items.append(item);
    add.disabled=items.children.length>=8;
  }
  view.filters.forEach(addFilter);
  direction.disabled=!sort.value;
  sort.addEventListener('change',()=>{direction.disabled=!sort.value;});
  return e('fieldset',{class:'catalog-filter'},e('legend',{},t('Фильтры и сортировка')),form([
    items,div('row filter-controls',label(t('Сортировка'),sort),label(t('Порядок'),direction),add),
  ],t('Применить'),async ()=>{
    const filters=Array.from(items.children,item=>Object.fromEntries(
      Array.from(item.querySelectorAll('input,select'),control=>[control.name,control.value])));
    applyTableView({filters,sort:sort.value?{column:sort.value,direction:direction.value}:null});
  },[
    button(t('Сохранённые представления'),click(savedViews)),
    view.filters.length || view.sort?button(t('Сбросить фильтры'),()=>applyTableView({filters:[],sort:null})):null,
  ]));
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
  const rowIndex=row?data.rows.indexOf(row):-1;
  const fields = data.definition.map(([name,type,nullable],index)=>{
    const mode = select('mode'+index,[['skip',row?t('Без изменений'):t('По умолчанию')],['value',t('Значение')],
      ...(nullable==='YES'?[['null','NULL']]:[])],'skip',{'aria-label':name});
    const columnIndex=data.columns.indexOf(name);
    const limited=Boolean(data.limitedCells?.[rowIndex]?.[columnIndex]);
    const original=limited?'':String(row?.[columnIndex] ?? '');
    const input=field('value'+index,'text',original,{'aria-label':name+' · '+type,disabled:limited});
    input.addEventListener('input',()=>{mode.value='value';});
    mode.addEventListener('change',()=>{
      input.disabled=mode.value==='null' || limited && mode.value==='skip';
      if (mode.value==='skip') input.value=original;
    });
    return div('table-picker',label(name+' · '+type,mode),div('stack',input,
      limited?e('small',{},t('Полное значение не загружено. Можно ввести новое значение.')):null));
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
      e('p',{},t('Вы точно хотите внести эти изменения?')),
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
  const connection=state.connection;
  const path=route('sql');
  target.append(div('panel stack',e('h2',{},t('SQL-консоль')),
    form(label(t('Одна SQL-команда'),e('textarea',{name:'sql',class:'code',placeholder:'SELECT …',
      spellcheck:'false',required:true,maxlength:65000})),
    t('Предпросмотр изменений'),async ({sql})=>{
      openDialog(t('Предпросмотр изменений'),form([
        e('strong',{},(connection.production?'PRODUCTION · ':'')+connection.name),
        e('p',{},t('Вы точно хотите выполнить эту SQL-команду?')),
        e('pre',{class:'schema-sql'},sql),
      ],t('Выполнить'),async ()=>{
        const result=await api(path,'POST',{sql});
        dialog.close();
        output.replaceChildren(resultTable(result));
        if (result.truncated) output.append(e('small',{},t('Показаны первые 200 строк.')));
      }));
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
    context.strokeStyle='#227c8eb8';
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
      context.fillStyle='#77aeb4';
      context.fill();
      const gradient=context.createLinearGradient(x-w/2,y-h/2,x+w/2,y+h/2);
      gradient.addColorStop(0,'#f3fffc');
      gradient.addColorStop(1,'#a0dfcf');
      context.fillStyle=gradient;
      context.beginPath();
      context.roundRect(x-w/2,y-h/2,w,h,10*scale);
      context.fill();
      context.strokeStyle='#fff9';
      context.lineWidth=1;
      context.stroke();
      context.fillStyle='#124354';
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
  restoreRoute();
}).catch(error=>{
  if (state.user) {
    login();
    report(error);
  }
});
