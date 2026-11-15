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
  if (endpoint==='undo') return 'Отменяем изменение…';
  if (path.split('/')[0].split('?')[0]==='audit') return 'Загружаем журнал…';
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

async function api(path, method='GET', payload, {quiet=false,signal}={}) {
  const finish=quiet?()=>{}:startRequest(path,method);
  try {
    const response = await fetch('/api/'+path,{
      method,signal,
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
const databaseRoutes=new Set(['structure','tables','graph','sql','database-search','sql-script','database-objects','schema-editor','server-status','database-backup']);
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
  if (view==='schema-editor') return state.user.admin;
  if (view==='database-search') return ['mysql','mariadb'].includes(connection.engine);
  if (['sql-script','database-objects','server-status','database-backup'].includes(view)) {
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
    active && !utility ? e('p',{},(browsedTable?active.name+' / '+browsedTable[0]+' · ':'')+engine+' · '+t(labelKeys[active.level])+' · PRODUCTION') : null);
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
      ...[['structure',t('Структура')],['graph',t('3D-схема')],...(['admin','sql'].includes(active.level)?[['sql',t('SQL-консоль')]]:[])]
        .map(([key,title])=>button(title,()=>setView(key),null,{'aria-current':String(state.view===key)})),
      mysqlWorkspace?button(t('Поиск по базе'),()=>setView('database-search'),null,{'aria-current':String(state.view==='database-search')}):null,
      admin && mysqlWorkspace?button(t('Выгрузка и восстановление'),()=>setView('database-backup'),null,{'aria-current':String(state.view==='database-backup')}):null,
      admin && mysqlWorkspace?button(t('Состояние сервера'),()=>setView('server-status'),null,{'aria-current':String(state.view==='server-status')}):null,
      admin && mysqlWorkspace?button(t('Объекты БД'),()=>setView('database-objects'),null,{'aria-current':String(state.view==='database-objects')}):null,
      admin?button(t('Редактор структуры'),()=>setView('schema-editor'),null,{'aria-current':String(state.view==='schema-editor')}):null,
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
  if (state.view==='server-status' && mysqlWorkspace && admin) return serverStatusView(content,stamp).catch(error=>showError(content,stamp,error));
  if (state.view==='database-objects' && mysqlWorkspace && admin) return databaseObjectsView(content,stamp).catch(error=>showError(content,stamp,error));
  if (state.view === 'schema-editor' && admin) return schemaReady.then(loaded=>{
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
  const targetHost=field('host','text',config.host,{required:true,placeholder:'db.example.net'});
  const savedSsh=config.ssh;
  let useSsh=Boolean(savedSsh);
  const modeButton=(title,description,ssh)=>e('button',{type:'button',class:'connection-mode',
    'aria-pressed':String(useSsh===ssh),onclick:()=>{
      useSsh=ssh;
      if (ssh && engine.value==='postgres') {
        engine.value='mysql';
        port.value=3306;
      }
      syncSsh();
    }},e('strong',{},t(title)),e('small',{},t(description)));
  const directMode=modeButton('Прямое подключение','Подключение к адресу базы данных',false);
  const sshMode=modeButton('Через SSH','Подключение к MySQL или MariaDB через SSH-сервер',true);
  const modes=e('div',{class:'connection-modes wide',role:'group','aria-label':t('Способ подключения')},directMode,sshMode);
  const sshHost=field(undefined,'text',savedSsh?.host ?? '',{required:true,maxlength:255,placeholder:'ssh.example.net'});
  const sshPort=field(undefined,'number',savedSsh?.port ?? 22,{required:true,min:1,max:65535});
  const sshUser=field(undefined,'text',savedSsh?.user ?? '',{required:true,maxlength:128});
  const keyFile=field(undefined,'file');
  const keyText=e('textarea',{maxlength:32768,autocomplete:'off',spellcheck:'false',
    placeholder:savedSsh?.hasKey?t('Сохранённый SSH-ключ'):null});
  const passphrase=field(undefined,'password','',{maxlength:4096,autocomplete:'new-password',
    placeholder:savedSsh?.hasPassphrase?t('Сохранённая парольная фраза'):null});
  const clearPassphrase=field(undefined,'checkbox','1');
  const keyStatus=e('small',{role:'status'});
  let keyLoad=Promise.resolve();
  let fileReadId=0;
  keyFile.addEventListener('change',()=>{
    const file=keyFile.files[0], readId=++fileReadId;
    if (!file) return;
    keyStatus.textContent='';
    keyFile.setCustomValidity('');
    keyLoad=(async()=>{
      try {
        if (file.size>32768) throw new Error(t('Размер SSH-ключа не должен превышать 32 КБ.'));
        const text=await file.text();
        if (readId!==fileReadId) return;
        keyText.value=text.trim();
        keyStatus.textContent=t('Файл ключа прочитан');
      } catch (error) {
        if (readId!==fileReadId) return;
        keyStatus.textContent=error.message;
        keyFile.setCustomValidity(error.message);
      }
    })();
  });
  keyText.addEventListener('input',()=>{
    fileReadId++;
    keyFile.value='';
    keyFile.setCustomValidity('');
    keyStatus.textContent='';
  });
  const sshFields=e('fieldset',{class:'wide catalog-filter ssh-fields'},
    e('legend',{},'SSH'),
    div('fields',label(t('Хост SSH'),sshHost),label(t('Порт SSH'),sshPort),label(t('Пользователь SSH'),sshUser),
      label(t('Загрузить файл приватного ключа'),keyFile,'wide'),keyStatus,
      label(t('Или вставить приватный SSH-ключ'),keyText,'wide'),
      label(t('Парольная фраза SSH-ключа'),passphrase,'wide'),
      savedSsh?.hasPassphrase?e('label',{class:'check wide'},clearPassphrase,t('Удалить сохранённую парольную фразу')):null,
      e('small',{class:'wide'},t('Хост и порт базы указываются так, как их видит SSH-сервер. Если MySQL работает на нём, обычно это 127.0.0.1:3306.'))));
  function syncSsh() {
    directMode.setAttribute('aria-pressed',String(!useSsh));
    sshMode.setAttribute('aria-pressed',String(useSsh));
    const postgres=engine.querySelector('[value=postgres]');
    postgres.hidden=postgres.disabled=useSsh;
    sshFields.disabled=sshFields.hidden=!useSsh;
    targetHost.placeholder=useSsh?'127.0.0.1':'db.example.net';
  }
  engine.addEventListener('change',syncSsh);
  syncSsh();
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
    modes,
    label(t('Название'),field('name','text',config.name,{required:true,maxlength:255}),'wide'),
    label(t('СУБД'),engine),sshFields,
    e('strong',{class:'wide'},t('Настройки базы данных')),
    label(t('Порт'),port),
    label(t('Хост'),targetHost),
    label(t('База данных'),field('database','text',config.database,{required:true})),
    label(t('Пользователь БД'),field('user','text',config.user,{required:true})),
    label(t('Пароль БД'),field('password','password','',{autocomplete:'new-password',placeholder:id?t('Сохранённый пароль'):''})),
    network,
    e('label',{class:'check wide'},field('tls','checkbox','1',{checked:config.tls ?? true}),t('TLS с проверкой сертификата')),
    label(config.customCa?t('Новый PEM-сертификат CA (текущий сохранён)'):t('PEM-сертификат CA (необязательно)'),e('textarea',{name:'ca'}),'wide'),
    config.customCa?e('label',{class:'check wide'},field('removeCa','checkbox','1'),t('Удалить сохранённый сертификат CA')):null,
    id?e('label',{class:'check wide'},field('resetPassword','checkbox','1'),t('Сохранить пустой пароль БД')):null,
  ),t('Проверить и сохранить'),async (data,_form,action)=>{
    status.textContent='';
    observed.textContent=t('Пока неизвестен');
    data.port=Number(data.port);
    data.tls=Boolean(data.tls);
    data.ssh=null;
    if (!sshFields.disabled) {
      await keyLoad;
      if (!keyFile.validity.valid) throw new Error(keyFile.validationMessage);
      const privateKey=keyText.value.trim();
      if (!privateKey && !savedSsh?.hasKey) throw new Error(t('Выберите файл или вставьте приватный SSH-ключ.'));
      data.ssh={host:sshHost.value.trim(),port:Number(sshPort.value),user:sshUser.value.trim(),
        ...(privateKey?{privateKey}:{}),
        ...(passphrase.value || clearPassphrase.checked?{passphrase:clearPassphrase.checked?'':passphrase.value}:{})};
    }
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
  'row.undo':'Откат изменения строк','row.copy':'Дублирование строк','row.update':'Изменение строки','row.delete':'Удаление строки','csv.export':'Экспорт CSV','demo.enable':'Подключение демо','schema.change':'Изменение структуры','csv.import':'Импорт CSV','sql.script':'Выполнение SQL-скрипта','sql.export':'Экспорт SQL','table.maintenance':'Обслуживание таблицы',
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
  function statements(list) {
    return list.map(({sql,parameters})=>div('stack audit-statement',e('pre',{class:'schema-sql'},sql),
      parameters?.length?e('pre',{class:'audit-parameters'},t('Параметры по порядку')+'\n'+JSON.stringify(parameters,null,2)):null));
  }
  async function details(id) {
    const info=await api('audit/'+id);
    if (stamp!==renderId) return;
    const ready=info.undoState==='ready';
    const status={done:'Изменение уже отменено',pending:'Результат отката нужно проверить в базе',
      unavailable:'Для этого запроса автоматический откат недоступен'}[info.undoState];
    const title=t('Запрос журнала')+' #'+id;
    const rollback=div('stack',e('h3',{},t('SQL отката')),statements(info.rollback));
    const apply=button(t('Откатить'),()=>{
      openDialog(t('Подтвердить откат'),form([
        e('p',{},t('Вы точно хотите внести эти изменения?')),
        div('stack',statements(info.rollback)),
      ],t('Подтвердить'),async()=>{
        await api('audit/'+id+'/undo','POST',{confirmed:true});
        dialog.close();
        toast(t('Изменение отменено'));
        await load(null);
      },button(t('Назад'),click(()=>details(id)))));
    },'danger',{disabled:!ready});
    openDialog(title,div('stack audit-detail',
      e('h3',{},t('SQL запроса')),statements(info.statements),
      info.truncated?e('small',{},t('В журнале сохранена часть запроса')):null,
      div('row',apply),status?e('small',{},t(status)):null,
      info.rollback.length?rollback:null));
  }
  const load=cursor=>auditView(target,stamp,cursor).catch(error=>showError(target,stamp,error));
  target.replaceChildren(div('panel stack',
    div('row spread',e('h2',{},t('Журнал действий')),button(t('Обновить'),()=>load(null))),
    rows.length?resultTable({columns:['Время','Пользователь','Действие','Подключение','Кого изменили','Результат'].map(key=>t(key)),rows},
      row=>{
        const item=page.entries[rows.indexOf(row)];
        return item.undo_state?button(t('Просмотр SQL'),click(()=>details(item.id))):'—';
      }):e('p',{},t('Записей пока нет')),
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
        e('strong',{},'PRODUCTION · '+connection.name+' / '+preview.database),
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
    e('strong',{},'PRODUCTION · '+target),
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

async function serverStatusView(target,stamp) {
  const path=route('server-status');
  const key='abdb-metrics:'+state.user.name+':'+state.connection.id;
  const horizon=10*60*1000;
  const parse=rows=>Object.fromEntries(rows.map(([name,value])=>[name.toLowerCase(),value]));
  let history=[];
  try {
    const stored=JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(stored)) history=stored.slice(-200).filter(entry=>Number.isFinite(entry?.at) && entry.at>Date.now()-horizon);
  } catch {}
  const status=e('small',{role:'status'},t('Загрузка…'));
  const charts=div('metrics-grid');
  const sessions=div('stack');
  const activeOnly=field(undefined,'checkbox','1');
  const sessionOutput=div('stack');
  let latestSessions=[];
  let sessionsTruncated=false;
  function showSessions() {
    const visible=latestSessions.filter(row=>!activeOnly.checked || row[4]!=='Sleep');
    sessionOutput.replaceChildren(
      visible.length?div('table-wrap',e('table',{class:'structure-grid process-grid'},
        e('thead',{},e('tr',{},['ID',t('Пользователь БД'),t('Хост'),t('База данных'),t('Команда'),t('Секунды'),t('Состояние'),t('Текущий SQL')]
          .map(name=>e('th',{scope:'col'},name)))),
        e('tbody',{},visible.map(row=>e('tr',{},row.slice(0,7).map(value=>e('td',{},value??'—')),
          e('td',{},row[7]?e('code',{},row[7]+(Number(row[8])?'…':'')):'—')))))):e('p',{},t('Нет видимых соединений')),
      sessionsTruncated?e('small',{},t('Показаны первые 100 соединений')):null);
  }
  activeOnly.addEventListener('change',showSessions);
  sessions.append(div('row spread',e('h3',{},t('Соединения и запросы')),
    e('label',{class:'check'},activeOnly,t('Только активные'))),
    e('small',{},t('Видимость соединений зависит от прав учётной записи MySQL.')),
    sessionOutput);
  const settings=div('stack');
  target.replaceChildren(div('catalog-panel',
    div('row spread',e('h2',{},t('Состояние сервера')),status),
    e('p',{},t('Обновление каждые 3 секунды · история за 10 минут в этом браузере')),
    charts,sessions,settings));
  const controller=new AbortController();
  let timer;
  let details=null;
  stopRowLoading=()=>{clearTimeout(timer);controller.abort();};
  const number=new Intl.NumberFormat(language,{maximumFractionDigits:1});
  const clock=new Intl.DateTimeFormat(language,{timeStyle:'medium'});
  function chart(title,metric,{unit='',cap=null,dialMax=cap}={}) {
    const value=history.at(-1)?.[metric];
    const points=history.filter(entry=>Number.isFinite(entry[metric]));
    const from=Date.now()-horizon;
    const top=cap ?? Math.max(1,...points.map(entry=>entry[metric]));
    const plot=e('canvas',{width:480,height:100,'aria-hidden':'true'});
    const context=plot.getContext('2d');
    if (context) {
      context.strokeStyle='#b6d9d6';
      for (const y of [16,52,89]) {
        context.beginPath();context.moveTo(0,y);context.lineTo(480,y);context.stroke();
      }
      context.strokeStyle='#087e83';context.lineWidth=3;
      let started=false;
      context.beginPath();
      for (const entry of history) {
        if (!Number.isFinite(entry[metric])) {started=false;continue;}
        const x=Math.max(0,Math.min(480,(entry.at-from)*480/horizon));
        const y=89-73*Math.max(0,Math.min(1,entry[metric]/top));
        if (started) context.lineTo(x,y); else context.moveTo(x,y);
        started=true;
      }
      context.stroke();
    }
    const text=Number.isFinite(value)?number.format(value)+(unit?' '+unit:''):'—';
    const gauge=dialMax && Number.isFinite(value)?e('canvas',{width:240,height:125,class:'metric-dial',role:'meter',
      'aria-label':title,'aria-valuemin':0,'aria-valuemax':dialMax,'aria-valuenow':Math.min(value,dialMax)}):null;
    const dial=gauge?.getContext('2d');
    if (dial) {
      const angle=Math.PI*(1+Math.min(1,value/dialMax));
      dial.lineWidth=14;dial.lineCap='round';
      dial.strokeStyle='#c1ddd9';dial.beginPath();dial.arc(120,109,85,Math.PI,2*Math.PI);dial.stroke();
      dial.strokeStyle='#087e83';dial.beginPath();dial.arc(120,109,85,Math.PI,angle);dial.stroke();
      dial.lineWidth=4;dial.strokeStyle='#164651';dial.beginPath();dial.moveTo(120,109);
      dial.lineTo(120+72*Math.cos(angle),109+72*Math.sin(angle));dial.stroke();
    }
    return div('metric-card stack',e('h3',{},title),
      e('strong',{},text,cap?' / '+number.format(cap):null),gauge,plot,
      div('row spread',e('small',{},clock.format(from)),e('small',{},clock.format(Date.now()))));
  }
  function draw() {
    const max=Number(details?.variables.max_connections);
    const connected=history.at(-1)?.connected;
    charts.replaceChildren(
      chart(t('Открытые подключения'),'connected',{cap:max>0?max:null}),
      chart(t('Активные потоки'),'running',{dialMax:connected>0?connected:null}),
      chart(t('Запросы в секунду'),'queries'),
      chart(t('Медленные запросы в секунду'),'slow'),
      chart(t('Получено в секунду'),'received',{unit:'KiB/s'}),
      chart(t('Отправлено в секунду'),'sent',{unit:'KiB/s'}));
  }
  async function sample() {
    if (stamp!==renderId) return;
    const started=performance.now();
    try {
      const data=await api(path+(details?'?metrics=1':''),'GET',undefined,{quiet:true,signal:controller.signal});
      if (stamp!==renderId) return;
      if (!details) {
        details={variables:parse(data.variables)};
        settings.replaceChildren(e('details',{},e('summary',{},t('Настройки сервера')),
          resultTable({columns:[t('Параметр'),t('Значение')],rows:data.variables})),
          e('details',{},e('summary',{},t('Права подключённой учётной записи')),
          resultTable({columns:['GRANT'],rows:data.grants})));
      }
      latestSessions=data.sessions ?? [];
      sessionsTruncated=data.sessionsTruncated;
      showSessions();
      const at=Date.now(), m=parse(data.status);
      const counters=['questions','slow_queries','bytes_received','bytes_sent'].map(name=>Number(m[name]));
      const uptime=Number(m.uptime);
      const previous=history.at(-1);
      const seconds=(at-previous?.at)/1000;
      const rate=(i,scale=1)=>seconds>0 && seconds<15 && uptime>=previous?.uptime && counters[i]>=previous?.counters?.[i]
        ?(counters[i]-previous.counters[i])/seconds/scale:null;
      history=[...history.filter(entry=>entry.at>at-horizon),{at,uptime,counters,
        connected:Number(m.threads_connected),running:Number(m.threads_running),
        queries:rate(0),slow:rate(1),received:rate(2,1024),sent:rate(3,1024)}].slice(-200);
      try {localStorage.setItem(key,JSON.stringify(history));} catch {}
      status.textContent=t('Последний замер: {time}',{time:clock.format(at)});
      draw();
    } catch (error) {
      if (stamp===renderId && !controller.signal.aborted) status.textContent=error.message;
    } finally {
      if (stamp===renderId && !controller.signal.aborted) timer=setTimeout(sample,Math.max(0,3000-(performance.now()-started)));
    }
  }
  if (history.length) draw();
  await sample();
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
        e('strong',{},'PRODUCTION · '+connection.name+' / '+preview.database),
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
    e('strong',{},'PRODUCTION · '+target),
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

function schemaTypeField(settings,actual='') {
  const mysql=Boolean(settings.mysqlTypeFamilies);
  const families=settings.mysqlTypeFamilies ?? [...new Set(settings.columnTypes.map(value=>value.split('(')[0]))];
  const normalized=actual.toUpperCase().replace('CHARACTER VARYING','VARCHAR')
    .replace(/TIMESTAMP(\(\d+\))? WITH TIME ZONE/,(_,precision)=>'TIMESTAMPTZ'+(precision ?? ''))
    .replace(/TIMESTAMP(\(\d+\))? WITHOUT TIME ZONE/,(_,precision)=>'TIMESTAMP'+(precision ?? ''));
  const parts=/^([A-Z ]+?)(?:\((\d+)(?:,(\d+))?\))?( UNSIGNED)?( ZEROFILL)?$/.exec(normalized);
  const initial=families.includes(parts?.[1])?parts[1]:actual?'':mysql?'INT':'INTEGER';
  const family=select('family',[['',t('Выберите тип')],...families.map(value=>[value,value])],initial,{required:true});
  const size=field('size','number',parts?.[2] ?? '',{min:0,max:65535});
  const scale=field('scale','number',parts?.[3] ?? '',{min:0,max:mysql?30:1000});
  const unsigned=field('unsigned','checkbox','1',{checked:Boolean(parts?.[4])});
  const zerofill=field('zerofill','checkbox','1',{checked:Boolean(parts?.[5])});
  const sizeLabel=label(t('Длина или точность'),size);
  const scaleLabel=label(t('Масштаб'),scale);
  const unsignedLabel=e('label',{class:'check'},unsigned,'UNSIGNED');
  const zerofillLabel=e('label',{class:'check'},zerofill,'ZEROFILL');
  function update() {
    const type=family.value;
    const fixed=['CHAR','BINARY','VARBINARY','BIT'].includes(type) || mysql && type==='VARCHAR';
    const decimal=['DECIMAL','NUMERIC'].includes(type);
    const temporal=['DATETIME','TIME','TIMESTAMP','TIMESTAMPTZ'].includes(type);
    const numeric=mysql && ['TINYINT','SMALLINT','MEDIUMINT','INT','BIGINT','FLOAT','DOUBLE','DECIMAL'].includes(type);
    sizeLabel.hidden=!(fixed || decimal || temporal || type==='VARCHAR' || numeric && /^\w+INT$|^INT$/.test(type));
    size.disabled=sizeLabel.hidden;
    size.required=fixed;
    size.min=temporal?0:1;
    size.max=temporal?6:decimal?(mysql?65:1000):type==='BIT'?64:['CHAR','BINARY'].includes(type)?255:65535;
    scaleLabel.hidden=!decimal;
    scale.disabled=scaleLabel.hidden;
    unsignedLabel.hidden=zerofillLabel.hidden=!numeric;
    unsigned.disabled=zerofill.disabled=!numeric;
  }
  family.addEventListener('change',()=>{
    size.value=['VARCHAR','VARBINARY'].includes(family.value)?'255':['CHAR','BINARY','BIT'].includes(family.value)?'1':'';
    scale.value='';unsigned.checked=zerofill.checked=false;
    update();
  });
  update();
  return {control:div('fields',label(t('Тип'),family),sizeLabel,scaleLabel,unsignedLabel,zerofillLabel),
    value:()=>family.value+(!size.disabled && size.value?'('+size.value+(!scale.disabled && scale.value?','+scale.value:'')+')':'')+
      (!unsigned.disabled && unsigned.checked?' UNSIGNED':'')+(!zerofill.disabled && zerofill.checked?' ZEROFILL':'')};
}

async function postgresSchemaEditor(target,stamp,settings) {
  const tables=state.tables.filter(row=>row[2]==='BASE TABLE');
  const current=tables.includes(state.table)?state.table:tables[0];
  const picker=select('table',tables.map(([schema,table],i)=>[String(i),schema+'.'+table]),String(tables.indexOf(current)));
  picker.addEventListener('change',()=>openWorkspaceTable(tables[Number(picker.value)],'schema-editor'));
  const details=div('stack');
  target.replaceChildren(div('catalog-panel',e('h2',{},t('Редактор структуры')),
    tables.length?label(t('Таблица'),picker):e('p',{},t('Подходящих таблиц нет.')),details));
  if (!current) return;
  state.table=current;
  writeRoute(true);
  const [schema,table]=current;
  const definition=await api(route('structure-editor')+'?'+new URLSearchParams({schema,table}));
  if (stamp!==renderId) return;
  details.replaceChildren(e('h3',{},t('Столбцы')),
    resultTable({columns:['Имя','Тип','Допускает NULL','По умолчанию','Сравнение','Столбец идентификатора',
      'Вычисляемый столбец','Выражение генерации','Комментарий'].map(key=>t(key)),rows:definition.columnDetails},
    row=>button(t('Изменить столбец'),click(()=>editBrowseColumn(row[0],{settings,definition})))),
    e('h3',{},t('Индексы')),resultTable({columns:[t('Имя'),t('Определение')],rows:definition.indexes}),
    e('h3',{},t('Ограничения')),resultTable({columns:[t('Имя'),t('Тип'),t('Определение')],rows:definition.constraints}));
}

async function schemaEditor(target,stamp) {
  const path=route('structure-editor');
  const connection=state.connection;
  const settings=await api(path);
  if (stamp!==renderId) return;
  if (pendingTable) {
    state.table=state.tables.find(row=>row[0]===pendingTable[0] && row[1]===pendingTable[1]) ?? null;
    pendingTable=null;
    writeRoute(true);
  }
  if (state.connection.engine==='postgres') return postgresSchemaEditor(target,stamp,settings);
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
        e('strong',{},'PRODUCTION · '+connection.name+' / '+settings.database),
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
    const type=schemaTypeField(settings);
    return {control:div('stack',
      label(t('Столбец'),field('column'+index,'text','',{required:true,maxlength:64})),
      type.control,
      e('label',{class:'check'},field('null'+index,'checkbox','1'),t('Допускает NULL')),
      primary?e('label',{class:'check'},field('primary'+index,'checkbox','1'),t('Первичный ключ')):null),
    read:values=>({name:values['column'+index],type:type.value(),nullable:Boolean(values['null'+index]),primary:Boolean(values['primary'+index])})};
  }

  function createTable() {
    const first=columnFields(0,true);
    const columns=[first];
    const fields=div('stack',first.control);
    const add=button(t('Добавить столбец'),()=>{
      const column=columnFields(columns.length,true);
      columns.push(column);fields.append(column.control);
      add.disabled=columns.length>=30;
    });
    operation(t('Создать таблицу'),[nameField(),fields,add],values=>({
      operation:'create-table',table:values.name,columns:columns.map(column=>column.read(values)),
    }));
  }

  async function loadDefinition() {
    const table=picker.value;
    if (!table) return;
    details.replaceChildren(e('p',{},t('Загрузка…')));
    const definition=await api(path+'?'+new URLSearchParams({table}));
    if (stamp!==renderId || table!==picker.value) return;
    state.table=tables.find(row=>row[1]===table);
    writeRoute(true);
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
    const engineChoices=settings.tableEngines.filter(engine=>engine!==definition.engine && (engine!=='MyISAM' || !definition.hasForeignKeys));
    function addColumn() {
      const column=columnFields(0);
      operation(t('Добавить столбец'),column.control,values=>({operation:'add-column',table,column:column.read(values)}));
    }
    details.replaceChildren(
      div('row',
        e('strong',{},t('Движок таблицы')+' · '+definition.engine),
        e('small',{},definition.collation,definition.comment?' · '+definition.comment:null),
        engineChoices.length?edit('change-engine','Сменить движок',()=>label(t('Новый движок'),
          select('engine',engineChoices.map(engine=>[engine,engine]),engineChoices[0])),v=>v):null,
        edit('rename-table','Переименовать таблицу',()=>nameField(),v=>v),
        edit('drop-table','Удалить таблицу',()=>e('p',{},table),()=>({}))),
      e('h3',{},t('Столбцы')),
      resultTable({columns:['Имя','Тип','Допускает NULL','По умолчанию','Дополнительно','Комментарий','Кодировка','Сравнение','Индекс',
        'Выражение генерации'].map(key=>t(key)),rows:definition.columns},
        row=>button(t('Изменить столбец'),click(()=>editBrowseColumn(row[0],{settings,definition})))),
      div('row',
        button(t('Добавить столбец'),addColumn),
        edit('rename-column','Переименовать столбец',()=>[columnList(),nameField()],v=>v),
        edit('drop-column','Удалить столбец',()=>columnList(),v=>v)),
      e('h3',{},t('Индексы')),
      resultTable({columns:[t('Имя'),t('Столбец'),t('Уникальный'),t('Тип'),t('Длина'),t('Порядок')],rows:definition.indexes.map(([name,column,nonUnique,...rest])=>[name,column,t(Number(nonUnique)?'Нет':'Да'),...rest])}),
      div('row',
        edit('add-index','Добавить индекс',()=>[nameField(),columnList(),e('label',{class:'check'},field('unique','checkbox','1'),t('Уникальный'))],
          v=>({name:v.name,keys:[v.columnName],unique:Boolean(v.unique)})),
        indexes.length?edit('drop-index','Удалить индекс',()=>label(t('Имя'),pickColumn('name',indexes)),v=>v):null),
      e('h3',{},t('Внешние ключи')),
      resultTable({columns:[t('Имя'),t('Столбец'),t('Схема'),t('Целевая таблица'),t('Целевой столбец'),'ON UPDATE','ON DELETE'],rows:definition.foreignKeys}),
      div('row',button(t('Добавить внешний ключ'),addForeignKey),
        foreignKeys.length?edit('drop-foreign-key','Удалить внешний ключ',()=>label(t('Имя'),pickColumn('name',foreignKeys)),v=>v):null),
    );
  }

  picker.addEventListener('change',click(async ()=>{
    state.table=tables.find(row=>row[1]===picker.value) ?? null;writeRoute();await loadDefinition();
  }));
  target.replaceChildren(div('catalog-panel',
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
      const payload=await api('connections/'+id+'/schema?relations=0');
      if (stamp!==renderId) return false;
      Object.assign(state,{schema:true,relations:null,...payload});
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
      e('strong',{},'PRODUCTION · '+connection.name+' · '+title),
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
    const headers=[t('Таблица'),...(mysql?[t('Строки'),t('Тип'),t('Сравнение'),t('Размер'),t('Фрагментация')]:[t('Схема'),t('Тип')])];
    results.replaceChildren(e('table',{class:'structure-grid'},
      e('thead',{},e('tr',{},e('th',{scope:'col',class:'catalog-choice'},selectAll),
        headers.map(title=>e('th',{scope:'col'},title)))),
      e('tbody',{},visible.map(table=>{
        const [schema,name,type,rows,engine,collation,size,free]=table;
        const key=tableKey(table);
        const selected=field('tableSelected','checkbox','1',{'aria-label':name,checked:checked.has(key)});
        selected.addEventListener('change',()=>{if (selected.checked) checked.add(key);else checked.delete(key);update();});
        return e('tr',{},
          e('td',{class:'catalog-choice'},selected),
          e('td',{class:'catalog-name'},button(name,()=>openWorkspaceTable(table),'table-link',{title:schema+'.'+name})),
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
  if (state.view==='graph') {
    const relations=state.relations ?? await api(route('schema-relations'));
    if (stamp!==renderId) return;
    state.relations=relations;
    writeRoute(true);
    return graph(target);
  }
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
  const picks=new Map();
  const selectAll=field('selectRows','checkbox','1',{'aria-label':t('Выбрать загруженные строки')});
  const selectionCount=e('small',{role:'status'});
  const textCell=value=>value==null?'':String(value);
  function batchText(csv) {
    const rows=[data.columns,...selectedRows().map(item=>item.row)];
    return rows.map(row=>row.map(value=>{
      let text=textCell(value);
      if (/^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(text)) text="'"+text;
      return csv?'"'+text.replaceAll('"','""')+'"':text.replace(/[\t\r\n]/g,' ');
    }).join(csv?',':'\t')).join('\r\n');
  }
  const copy=button(t('В буфер'),click(async()=>{await navigator.clipboard.writeText(batchText(false));toast(t('Скопировано'));}));
  const exportRows=button(t('Экспорт CSV'),()=>{
    const url=URL.createObjectURL(new Blob(['\uFEFF',batchText(true)],{type:'text/csv;charset=utf-8'}));
    const link=e('a',{href:url,download:'abdbadmin-selected.csv'});
    link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  const duplicate=button(t('Дублировать'),()=>batchEditor('copy'));
  const editSelected=button(t('Изменить'),()=>batchEditor('update'));
  const deleteSelected=button(t('Удалить'),()=>batchEditor('delete'),'danger');
  const batchBar=div('row selection-bar',selectionCount,copy,exportRows,editSelected,duplicate,deleteSelected,
    button(t('Снять выбор'),()=>{for(const item of picks.values()) item.checkbox.checked=false;selectionChanged();}));
  function selectedRows() {return [...picks.values()].filter(item=>item.checkbox.checked);}
  function selectionChanged() {
    const rows=selectedRows();
    selectAll.checked=picks.size>0 && rows.length===picks.size;
    selectAll.indeterminate=rows.length>0 && !selectAll.checked;
    selectAll.disabled=!picks.size;
    batchBar.hidden=!rows.length;
    selectionCount.textContent=t('Выбрано строк: {count}',{count:rows.length});
    selectionCount.title=rows.length>50?t('Групповые изменения: до 50 строк'):'';
    const batchWritable=state.connection.engine==='postgres' || /^innodb$/i.test(state.table[4] ?? '');
    deleteSelected.disabled=!batchWritable || rows.length>50 || !rows.every(item=>item.snapshot && item.key);
    editSelected.disabled=deleteSelected.disabled || !data.definition.some(column=>!column[3]);
    duplicate.disabled=deleteSelected.disabled || !data.definition.some(([, , , primary, meta])=>primary && meta &&
      (meta.is_identity==='YES' || /^nextval\(/.test(meta.column_default ?? '') || /\bauto_increment\b/i.test(meta.extra ?? '')));
    duplicate.title=duplicate.disabled?t('Для дублирования нужен автоматически создаваемый первичный ключ'):'';
  }
  selectAll.addEventListener('change',()=>{
    for(const item of picks.values()) item.checkbox.checked=selectAll.checked;
    selectionChanged();
  });
  function pickRow(page,row,index) {
    const checkbox=field('pickRow','checkbox','1',{'aria-label':t('Выбрать строку')});
    checkbox.addEventListener('change',selectionChanged);
    const key=editable && !page.unsafeKey && page.definition.some(column=>column[3])?
      Object.fromEntries(page.definition.filter(column=>column[3]).map(([name])=>[name,row[page.columns.indexOf(name)]])):null;
    picks.set(checkbox,{checkbox,row,key,snapshot:page.snapshots?.[index]});
    return checkbox;
  }
  function batchEditor(action) {
    const rows=selectedRows();
    const title=t({delete:'Удалить выбранные строки',update:'Изменить выбранные строки',copy:'Дублировать выбранные строки'}[action]);
    const targets=rows.map(({key,snapshot})=>({key,snapshot}));
    function review(values) {
      openDialog(title,form([
        e('p',{},t('Вы точно хотите внести эти изменения?')),
        e('strong',{},state.table.join(' / ')+' · '+t('Выбрано строк: {count}',{count:rows.length})),
        values?e('p',{},Object.entries(values).map(([name,value])=>name+' = '+(value ?? 'NULL')).join(', ')):null,
        e('pre',{class:'schema-sql'},targets.map(({key})=>JSON.stringify(key)).join('\n')),
      ],t('Подтвердить'),async()=>{
        const result=await api(path,'POST',{action,rows:targets,values});
        dialog.close();
        toast(t('Затронуто строк: {count}',{count:result.affected}));
        render();
      }));
    }
    if (action!=='update') return review();
    const columns=data.definition.filter(column=>!column[3]);
    if (!columns.length) return;
    const picker=select('column',columns.map(([name])=>[name,name]),columns[0][0]);
    const input=field('value','text');
    const useNull=field('null','checkbox','1');
    function refresh() {
      useNull.disabled=columns.find(([name])=>name===picker.value)[2]!=='YES';
      if(useNull.disabled) useNull.checked=false;
      input.disabled=useNull.checked;
    }
    picker.addEventListener('change',refresh);
    useNull.addEventListener('change',refresh);
    refresh();
    openDialog(title,form([label(t('Столбец'),picker),label(t('Значение'),input),e('label',{class:'check'},useNull,'NULL')],
      t('Предпросмотр изменений'),async values=>review({[values.column]:values.null?null:values.value})));
  }
  const gridOptions=page=>({
    rowEdit:rowActions(page)?row=>rowDialog(page,path,row):null,
    header:name=>columnHeader(name,columnMetadata.get(name),state.user.admin && editable),
    tableClass:'structure-grid row-data-grid',selectAll,pick:(row,index)=>pickRow(page,row,index),
  });
  const grid=resultTable(data,actionCell(data),gridOptions(data));
  grid.classList.add('browsing-grid');
  const count=e('small',{role:'status'});
  const loadButton=button(t('Загрузить ещё'),click(loadMore));
  const footer=div('row spread browse-end',count,loadButton);
  grid.append(footer);
  selectionChanged();
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
      url.set('metadata','0');
      const page=await api(path.split('?')[0]+'?'+url,'GET',undefined,{quiet:true});
      if (stamp!==renderId) return;
      if (JSON.stringify(page.columns)!==JSON.stringify(data.columns)) {
        more=false;
        updateStatus(t('Структура изменилась. Обновите таблицу.'));
        observer?.disconnect();
        return;
      }
      const tableBody=grid.querySelector('tbody');
      tableBody.append(...resultTable(page,actionCell(page),{rowEdit:gridOptions(page).rowEdit,pick:gridOptions(page).pick}).querySelector('tbody').children);
      selectionChanged();
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
    div('row browse-tools',
      e('details',{class:'browse-transfer'},e('summary',{},t('Импорт и экспорт')),
        div('row row-transfer',csv,exportSql,nativeAdmin?button(t('Импорт CSV'),openCsvImport):null)),
      e('details',{class:'browse-filters'},e('summary',{},t('Фильтры и сортировка')+
        (currentTableView().filters.length?' · '+currentTableView().filters.length:'')),filterControls(data.columns)),
      nativeAdmin?button(t('Обслуживание таблицы'),maintenanceDialog):null,
      editable?button(t('Добавить строку'),()=>rowDialog(data,path),'primary'):null),
    batchBar,grid));
  if (more && typeof IntersectionObserver==='function') {
    observer=new IntersectionObserver(entries=>{
      if (entries.some(entry=>entry.isIntersecting)) loadMore();
    },{root:grid,rootMargin:'0px 0px 160px 0px'});
    observer.observe(footer);
  }
  stopRowLoading=()=>{observer?.disconnect();};
}
function resultTable(data,actions,{header,rowEdit,tableClass,selectAll,pick}={}) {
  if (!data.columns.length) return e('p',{},data.affected==null?t('Запрос выполнен'):t('Затронуто строк: {count}',{count:data.affected}));
  return div('table-wrap',e('table',tableClass?{class:tableClass}:{},
    e('thead',{},e('tr',{},selectAll?e('th',{scope:'col',class:'row-choice'},selectAll):null,data.columns.map(name=>e('th',{scope:'col'},header?header(name):name)),actions?e('th',{scope:'col'},t('Действия')):null)),
    e('tbody',{},data.rows.map((row,index)=>{
      const tr=e('tr',rowEdit?{class:'editable-row'}:{},
        pick?e('td',{class:'row-choice'},pick(row,index)):null,
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

async function editBrowseColumn(name,loaded) {
  const stamp=renderId;
  const [schema,table]=state.table;
  const path=route('structure-editor');
  const [settings,definition]=loaded?[loaded.settings,loaded.definition]:
    await Promise.all([api(path),api(path+'?'+new URLSearchParams({schema,table}))]);
  if (stamp!==renderId) return;
  const column=(definition.columnDetails ?? definition.columns).find(([current])=>current===name);
  if (!column) throw new Error(t('Столбец недоступен'));
  const [,type,nullable]=column;
  const postgres=state.connection.engine==='postgres';
  const canModify=new Map(definition.columnChanges).get(name);
  const title=t('Изменить столбец')+' · '+name;
  const typeField=schemaTypeField(settings,type);
  typeField.control.classList.add('column-form-fields');
  const family=typeField.control.querySelector('[name=family]');
  const supported=Boolean(canModify && family.value);
  const originalType=typeField.value();
  const newName=field('newName','text',name,{required:true,maxlength:postgres?63:64});
  const allowNull=field('nullable','checkbox','1',{checked:nullable==='YES'});
  const charset=field('charset','text',postgres?'':column[6] ?? '',{maxlength:64});
  const collation=field('collation','text',(postgres?column[4]:column[7]) ?? '',{maxlength:128});
  const comment=field('comment','text',(postgres?column[8]:column[5]) ?? '',{maxlength:1024});
  const auto=field('autoIncrement','checkbox','1',{checked:!postgres && /\bauto_increment\b/i.test(column[4] ?? '')});
  const original={charset:charset.value,collation:collation.value,comment:comment.value,auto:auto.checked};
  const defaultMode=select('defaultMode',[['keep',t('Без изменений')],['value',t('Задать значение')],['remove',t('Удалить значение по умолчанию')]],'keep');
  const defaultValue=field('defaultValue','text','');
  const defaultLabel=label(t('Значение'),defaultValue);
  const booleanDefault=select('booleanDefault',[['true','TRUE'],['false','FALSE']],'true');
  const booleanLabel=label(t('Значение'),booleanDefault);
  const after=select('position',[['keep',t('Без изменений')],['first',t('В начало')],
    ...definition.columns.filter(([other])=>other!==name).map(([other],idx)=>['after'+idx,t('После')+' '+other])],'keep');
  const charsetLabel=label(t('Кодировка'),charset), collationLabel=label(t('Сравнение'),collation);
  const autoLabel=e('label',{class:'check'},auto,'AUTO_INCREMENT');
  function update() {
    const selected=family.value;
    const character=/CHAR|TEXT/.test(selected);
    charsetLabel.hidden=!character || postgres || !supported;
    collationLabel.hidden=!character || !supported;
    autoLabel.hidden=postgres || !supported || !/^(TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT)$/.test(selected);
    booleanLabel.hidden=defaultMode.value!=='value' || selected!=='BOOLEAN';
    booleanDefault.disabled=booleanLabel.hidden;
    defaultLabel.hidden=defaultMode.value!=='value' || !booleanLabel.hidden;
    defaultValue.disabled=defaultLabel.hidden;
    defaultValue.type=/^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|DOUBLE PRECISION|YEAR|BIT)$/.test(selected)
      ?'number':selected==='DATE'?'date':selected==='TIME'?'time':/^(DATETIME|TIMESTAMP)$/.test(selected)?'datetime-local':'text';
    defaultValue.step=defaultValue.type==='number'?'any':defaultValue.type==='time' || defaultValue.type==='datetime-local'?'1':'';
    defaultValue.required=!defaultLabel.hidden && defaultValue.type!=='text';
  }
  family.addEventListener('change',update);
  defaultMode.addEventListener('change',update);
  update();
  async function review(sql,apply,renames=false) {
    openDialog(t('Предпросмотр изменений'),form([
      e('strong',{},[state.connection.name,schema,table,name].join(' / ')),
      e('p',{},t('Вы точно хотите внести эти изменения?')),
      e('pre',{class:'schema-sql'},sql),
    ],t('Подтвердить'),async()=>{
      await apply();
      dialog.close();
      state.schema=null;
      if (renames) {
        const old=currentTableView();
        const rename=rule=>rule.column===name?{...rule,column:newName.value}:rule;
        applyTableView({filters:old.filters.map(rename),sort:old.sort?rename(old.sort):null});
      } else render();
    },button(t('Назад'),()=>openDialog(title,editor))));
  }
  const editor=form([
    div('column-form-fields',
      label(t('Название'),newName),
      supported?typeField.control:e('p',{},t('Тип')+' · '+type),
      label(t('По умолчанию')+' · '+(column[3] ?? '—'),defaultMode),defaultLabel,booleanLabel,
      charsetLabel,collationLabel,
      postgres || supported?e('label',{class:'check'},allowNull,t('Допускает NULL')):null,
      autoLabel,
      postgres || supported?label(t('Комментарий'),comment):null,
      !postgres && supported?label(t('Переместить поле'),after):null),
    e('details',{class:'column-native'},e('summary',{},t('Расширенное редактирование SQL')),
      button(t('Открыть SQL'),()=>{
        const quote=value=>{const mark=postgres?'"':'`';return mark+value.replaceAll(mark,mark+mark)+mark;};
        const prefix='ALTER TABLE '+quote(schema)+'.'+quote(table)+(postgres?' ALTER COLUMN ':' MODIFY COLUMN ')+quote(name)+' ';
        const native=form(label(t('Одна SQL-команда'),e('textarea',{name:'sql',class:'sql-console-input',required:true,maxlength:65000,value:prefix})),
          t('Предпросмотр изменений'),async ({sql})=>{
            if(sql.trim()===prefix.trim()) throw new Error(t('Введите SQL-запрос'));
            await review(sql,()=>api(route('sql'),'POST',{sql}));
          },button(t('Назад'),()=>openDialog(title,editor)));
        openDialog(t('Расширенное редактирование SQL'),native);
      })),
  ],t('Предпросмотр изменений'),async values=>{
    const rename=values.newName!==name;
    const nullChanged=allowNull.checked!==(nullable==='YES');
    const typeChanged=supported && (typeField.value()!==originalType || !collationLabel.hidden && collation.value!==original.collation ||
      !charsetLabel.hidden && charset.value!==original.charset);
    const commentChanged=comment.value!==original.comment;
    const defaultChanged=defaultMode.value!=='keep';
    const settingsChanged=typeChanged || nullChanged || commentChanged || auto.checked!==original.auto || after.value!=='keep';
    if (!rename && !defaultChanged && !settingsChanged) throw new Error(t('Нет изменений'));
    const changes={name,...(rename?{newName:values.newName}:{}),
      ...(defaultChanged?{defaultValue:values.defaultMode==='remove'?null:(values.booleanDefault ?? (defaultValue.type==='datetime-local'?values.defaultValue.replace('T',' '):values.defaultValue))}:{}),
    };
    let input;
    if (postgres) {
      if (nullChanged || typeChanged) changes.nullable=allowNull.checked;
      if (typeChanged) Object.assign(changes,{type:typeField.value(),collation:collationLabel.hidden?'':collation.value});
      if (commentChanged) changes.comment=comment.value || null;
      input={operation:'edit-column',column:changes};
    } else if (supported && (settingsChanged || rename && defaultChanged)) {
      Object.assign(changes,{type:typeField.value(),nullable:allowNull.checked,comment:comment.value,autoIncrement:!autoLabel.hidden && auto.checked});
      if (!charsetLabel.hidden) Object.assign(changes,{charset:charset.value,collation:collation.value});
      if (after.value==='first') changes.after=null;
      else if(after.value!=='keep') changes.after=definition.columns.filter(([other])=>other!==name)[Number(after.value.slice(5))][0];
      input={operation:'modify-column',column:changes};
    } else if (rename && defaultChanged) {
      throw new Error(t('Примените переименование и значение по умолчанию по отдельности для этого типа.'));
    } else if (rename) input={operation:'rename-column',columnName:name,name:values.newName};
    else input={operation:'set-column-default',columnName:name,defaultValue:changes.defaultValue};
    input={...input,schema,table};
    const preview=await api(path,'POST',{...input,preview:true});
    await review(preview.sql,()=>api(path,'POST',{...input,confirmation:preview.confirmation}),rename);
  });
  openDialog(title,editor);
}

function filterControls(columns) {
  const view=currentTableView();
  const items=div('filter-items');
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
  const error=e('p',{class:'form-error',role:'alert'});
  return e('form',{class:'catalog-filter compact-filters','aria-label':t('Фильтры и сортировка'),onsubmit:event=>{
    event.preventDefault();
    try {
      const filters=Array.from(items.children,item=>Object.fromEntries(
        Array.from(item.querySelectorAll('input,select'),control=>[control.name,control.value])));
      applyTableView({filters,sort:sort.value?{column:sort.value,direction:direction.value}:null});
    } catch (reason) {error.textContent=reason.message;}
  }},
  div('row filter-controls',e('strong',{},t('Фильтры')),label(t('Сортировка'),sort),label(t('Порядок'),direction),
    add,submit(t('Применить')),
    view.filters.length || view.sort?button(t('Сбросить фильтры'),()=>applyTableView({filters:[],sort:null})):null),
  items,error);
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
    openDialog(t('Предпросмотр изменений'),form([
      e('strong',{},'PRODUCTION · '+target),
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
    form(label(t('Одна SQL-команда'),e('textarea',{name:'sql',class:'code sql-console-input',placeholder:'SELECT …',
      spellcheck:'false',required:true,maxlength:65000})),
    t('Предпросмотр изменений'),async ({sql})=>{
      openDialog(t('Предпросмотр изменений'),form([
        e('strong',{},'PRODUCTION · '+connection.name),
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
  const key=([schema,table])=>JSON.stringify([schema,table]);
  const tables=new Map(state.tables.map(table=>[key(table),table]));
  const connected=new Map();
  for (const relation of state.relations) {
    const source=key(relation.slice(0,2)),destination=key(relation.slice(2));
    if (!tables.has(source) || !tables.has(destination)) continue;
    if (!connected.has(source)) connected.set(source,{in:new Set(),out:new Set()});
    if (!connected.has(destination)) connected.set(destination,{in:new Set(),out:new Set()});
    connected.get(source).out.add(destination);
    connected.get(destination).in.add(source);
  }
  const search=field('graphSearch','search','',{placeholder:t('Поиск таблиц'),'aria-label':t('Поиск таблиц')});
  const picker=select('graphTable',[],undefined,{'aria-label':t('Таблица')});
  const scene=div('relationship-stage');
  const depth=field('graphDepth','checkbox','1');
  depth.addEventListener('change',()=>scene.classList.toggle('has-depth',depth.checked));
  let selected=state.table && tables.has(key(state.table))?key(state.table):connected.keys().next().value ?? tables.keys().next().value;
  function card(id,center=false) {
    const table=tables.get(id);
    return div(center?'relationship-card current':'relationship-card',
      e('small',{},table[0]),
      center?e('strong',{},table[1]):button(table[1],()=>{selected=id;search.value='';refreshPicker();focus();},'relationship-name'),
      button(t('Открыть данные'),()=>openWorkspaceTable(table),'relationship-open'));
  }
  function lane(title,ids,end) {
    const nodes=[...ids].sort((a,b)=>tables.get(a)[1].localeCompare(tables.get(b)[1]));
    return div('relationship-lane stack',e('h3',{},t(title)+' · '+nodes.length),
      nodes.length?div('relationship-nodes',nodes.map(id=>div('relationship-edge '+end,card(id),
        e('span',{'aria-hidden':'true'},'→')))):e('small',{},t('Связей нет')));
  }
  function draw() {
    if (!tables.has(selected)) {scene.replaceChildren(e('p',{},t('Подходящих таблиц нет.')));return;}
    const links=connected.get(selected);
    const incoming=new Set(links?.in),outgoing=new Set(links?.out);
    const self=incoming.delete(selected);
    outgoing.delete(selected);
    scene.replaceChildren(lane('На неё ссылаются',incoming,'incoming'),
      div('relationship-focus stack',e('h3',{},t('Выбранная таблица')),card(selected,true),
        self?e('small',{},t('Ссылается на себя')):null),
      lane('Она ссылается на',outgoing,'outgoing'));
  }
  function refreshPicker() {
    const needle=search.value.trim().toLowerCase();
    const choices=[...tables].filter(([,table])=>table.slice(0,2).join('.').toLowerCase().includes(needle));
    picker.replaceChildren(...choices.map(([id,[schema,table]])=>e('option',{value:id},schema+'.'+table)));
    if (!choices.some(([id])=>id===selected)) selected=choices[0]?.[0];
    picker.value=selected ?? '';
    picker.disabled=!choices.length;
  }
  search.addEventListener('input',()=>{refreshPicker();draw();});
  function focus() {
    state.table=tables.get(selected);
    writeRoute(true);
    draw();
  }
  picker.addEventListener('change',()=>{selected=picker.value;focus();});
  target.append(div('catalog-panel relationship-panel',
    div('row spread',e('h2',{},t('Связи таблиц')),
      div('row',search,picker,e('label',{class:'check'},depth,t('Наклон 3D')))),
    e('small',{},t('Стрелка идёт от внешнего ключа к таблице, на которую он ссылается. Нажмите на имя, чтобы открыть её связи.')),
    scene));
  refreshPicker();draw();
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
