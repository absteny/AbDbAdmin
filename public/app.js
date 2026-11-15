const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const notice = document.querySelector('#notice');
const labels = {postgres:'PostgreSQL',mysql:'MySQL',mariadb:'MariaDB',view:'Просмотр',edit:'Редактирование строк',sql:'Доступ к SQL',admin:'Администратор'};
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
    headers:{'X-AbDbAdmin':'1',...(payload === undefined ? {} : {'Content-Type':'application/json'})},
    body:payload === undefined ? undefined : JSON.stringify(payload),
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !['login','session'].includes(path)) {
      state.user = null;
      if (dialog.open) dialog.close();
      login();
    }
    throw new Error(value.error || 'Ошибка запроса');
  }
  return value;
}
const route = tail=>`connections/${state.connection.id}/${tail}`;
const rowParams = ()=>new URLSearchParams({schema:state.table[0],table:state.table[1],offset:state.offset});

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
  dialog.replaceChildren(div('stack',div('row spread',e('h2',{},title),button('Закрыть',()=>dialog.close())),children));
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
    label('Логин',field('name','text','',{required:true,autocomplete:'username',autofocus:true})),
    label('Пароль',field('password','password','',{required:true,autocomplete:'current-password'})),
  ],'Войти',async data=>{
    state.user = await api('login','POST',data);
    state.view = 'tables';
    state.connection = null;
    await refreshConnections();
    render();
  });
  app.replaceChildren(div('login',div('panel login-card',
    div('login-main stack',brand(),e('h1',{},'Ваши базы данных'),e('p',{},'Войдите, чтобы открыть сохранённые подключения.'),content),
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
  openDialog('Сменить пароль',form([
    label('Текущий пароль',field('current','password','',{required:true,autocomplete:'current-password'})),
    label('Новый пароль',field('password','password','',{required:true,minlength:12,maxlength:256,autocomplete:'new-password'})),
  ],'Сохранить',async data=>{await api('password','POST',data);dialog.close();toast('Пароль обновлён');}));
}
function render() {
  if (!state.user) return login();
  const stamp = ++renderId;
  const active = state.connection;
  const admin = state.user.admin;
  const people = state.view === 'users';
  const engine = active && labels[active.engine];
  const content = div('stack');
  const heading = div('hero',e('h1',{},people?'Пользователи':active?.name || 'Подключения'),
    active && !people ? e('p',{},engine+' · '+labels[active.level]) : null);
  app.replaceChildren(div('shell',div('sidebar',
    brand(),
    div('row spread',e('span',{class:'nav-heading'},'Подключения'),admin?button('+',()=>editConnection(), 'primary',{'aria-label':'Добавить подключение'}):null),
    div('nav',state.connections.map(connection=>button(labels[connection.engine]+' · '+connection.name,
      click(()=>choose(connection.id)),null,{'aria-current':String(!people && connection.id===active?.id)}))),
    admin?div('nav',button('Пользователи и права',()=>setView('users'),null,{'aria-current':String(people)})):null,
    div('grow'),
    div('stack',e('small',{},state.user.name),button('Сменить пароль',changePassword),button('Выйти',click(async()=>{
      await api('logout','POST');state.user=null;login();
    }))),
  ),e('main',{class:'main stack'},heading,
    active && !people ? div('row tabs',
      ...[['tables','Таблицы'],['graph','3D-схема'],...(['admin','sql'].includes(active.level)?[['sql','SQL']]:[])]
        .map(([key,title])=>button(title,()=>setView(key),null,{'aria-current':String(state.view===key)})),
      admin?button('Настройки',click(async()=>editConnection(await api(route('settings')),active.id))):null,
    ):null,content)));
  if (people) return users(content,stamp).catch(error=>showError(content,stamp,error));
  if (!active) {
    content.append(div('panel empty',e('h2',{},admin?'Добавьте подключение':'Доступных подключений пока нет'),
      e('p',{},admin?'Укажите сервер и учётную запись базы данных.':'Попросите администратора выдать доступ к нужной базе.'),
      admin?button('Добавить подключение',()=>editConnection(),'primary'):null));
    return;
  }
  if (state.view === 'sql') return sqlView(content);
  loadTables(content,stamp).catch(error=>showError(content,stamp,error));
}
function showError(target, stamp, error) {
  if (stamp===renderId) target.replaceChildren(div('panel stack',e('p',{role:'alert'},error.message),button('Повторить',render)));
}
function confirmAction(title,text,callback) {
  openDialog(title,form(e('p',{},text),'Подтвердить',async ()=>{
    await callback();
    dialog.close();
  }));
}
function editConnection(config={}, id=null) {
  const engine = select('engine',[['postgres','PostgreSQL'],['mysql','MySQL'],['mariadb','MariaDB']],config.engine || 'postgres');
  const port = field('port','number',config.port || 5432,{min:1,max:65535,required:true});
  engine.addEventListener('change',()=>{port.value=engine.value==='postgres'?5432:3306;});
  const content = form(div('fields',
    label('Название',field('name','text',config.name,{required:true,maxlength:255}),'wide'),
    label('СУБД',engine),
    label('Порт',port),
    label('Хост',field('host','text',config.host,{required:true,placeholder:'db.example.net'})),
    label('База данных',field('database','text',config.database,{required:true})),
    label('Пользователь БД',field('user','text',config.user,{required:true})),
    label('Пароль БД',field('password','password','',{autocomplete:'new-password',placeholder:id?'Сохранённый пароль':''})),
    e('label',{class:'check wide'},field('tls','checkbox','1',{checked:config.tls ?? true}),'TLS с проверкой сертификата'),
    label(config.customCa?'Новый PEM-сертификат CA (текущий сохранён)':'PEM-сертификат CA (необязательно)',e('textarea',{name:'ca'}),'wide'),
    config.customCa?e('label',{class:'check wide'},field('removeCa','checkbox','1'),'Удалить сохранённый сертификат CA'):null,
    id?e('label',{class:'check wide'},field('resetPassword','checkbox','1'),'Сохранить пустой пароль БД'):null,
  ),'Проверить и сохранить',async data=>{
    data.port=Number(data.port);
    data.tls=Boolean(data.tls);
    if (id && !data.password && !data.resetPassword) delete data.password;
    if (id && !data.ca && !data.removeCa) delete data.ca;
    let next = id;
    if (id) await api(`connections/${id}/settings`,'PUT',data);
    else next = (await api('connections','POST',data)).id;
    dialog.close();
    await refreshConnections();
    await choose(next);
    toast('Подключение сохранено');
  },id?button('Удалить подключение',()=>confirmAction('Удалить подключение?',
    'Профиль и выданные на него права будут удалены.',async ()=>{
      await api('connections/'+id,'DELETE');
      await refreshConnections();
      render();
    }),'danger'):[]);
  openDialog(id?'Настройки подключения':'Новое подключение',content);
}
async function users(target,stamp) {
  target.append(div('panel','Загрузка…'));
  const list = await api('users');
  if (stamp !== renderId) return;
  target.replaceChildren(div('panel stack',div('row spread',e('h2',{},'Учётные записи'),
    button('Добавить пользователя',()=>openDialog('Новый пользователь',form([
      label('Логин',field('name','text','',{required:true,minlength:3,maxlength:48,autocomplete:'off'})),
      label('Пароль',field('password','password','',{required:true,minlength:12,maxlength:256,autocomplete:'new-password'})),
    ],'Создать',async data=>{await api('users','POST',data);dialog.close();render();})), 'primary')),
  list.map(user=>div('row spread user-line',e('strong',{},user.name),
    user.admin?e('span',{class:'tag'},'Администратор'):div('row',
      button('Доступ',click(()=>permissions(user))),
      button('Удалить',()=>confirmAction('Удалить пользователя?',user.name+' потеряет доступ к панели.',async ()=>{
        await api('users/'+user.id,'DELETE');render();
      }),'danger'),
    )))));
}
async function permissions(user) {
  const url = 'users/'+user.id+'/permissions';
  const list = await api(url);
  const values = new Map(list.map(item=>[item.connection_id,item.level]));
  openDialog('Доступ · '+user.name,div('stack',
    e('p',{},'SQL разрешает любые запросы в рамках прав учётной записи сохранённого подключения.'),
    state.connections.length ? state.connections.map(connection=>{
      const picker = select('level',[['','Нет доступа'],['view','Просмотр'],['edit','Редактирование строк'],['sql','Доступ к SQL']],values.get(connection.id) || '');
      const save = button('Сохранить',click(async ()=>{
        await api(url,'PUT',{connection:connection.id,level:picker.value || null});
        toast('Доступ обновлён');
      }));
      return div('row',div('grow',label(connection.name,picker)),save);
    }):e('p',{},'Сначала добавьте подключение.'),
  ));
}
async function loadTables(target,stamp) {
  target.append(div('panel','Загрузка структуры…'));
  if (!state.schema) {
    const payload = await api(route('schema'));
    if (stamp!==renderId) return;
    Object.assign(state,{schema:true,...payload});
  }
  target.replaceChildren();
  if (!state.tables.length) {
    target.append(div('panel empty',e('h2',{},'Таблиц пока нет'),e('p',{},'Проверьте права пользователя БД и выбранную базу.'),
      button('Обновить структуру',()=>{state.schema=null;render();})));
    return;
  }
  if (state.view==='graph') return graph(target);
  if (!state.table) state.table=state.tables[0];
  const selection = select('table',state.tables.map((entry,index)=>[String(index),entry[0]+'.'+entry[1]]),String(state.tables.indexOf(state.table)),{
    onchange:event=>{state.table=state.tables[Number(event.target.value)];state.offset=0;render();},
  });
  const search = e('input',{type:'search',placeholder:'Имя таблицы или схемы'});
  search.addEventListener('input',()=>{
    const needle = search.value.trim().toLowerCase();
    for (const option of selection.options) {
      option.hidden = !option.selected && !option.textContent.toLowerCase().includes(needle);
      option.disabled = option.hidden;
    }
  });
  target.append(div('panel row spread',div('grow',label('Поиск таблиц',search)),div('grow',label('Таблица или представление',selection)),
    button('Обновить структуру',()=>{state.schema=null;state.table=null;state.offset=0;render();})));
  const path = route('rows')+'?'+rowParams();
  const data = await api(path);
  if (stamp!==renderId) return;
  const editable = state.connection.level!=='view' && state.table[2]==='BASE TABLE';
  const hasKeys = data.definition.some(field=>field[3]) && !data.unsafeKey;
  const actions = editable && hasKeys;
  const csv = e('a',{href:'/api/'+route('csv')+'?'+rowParams()},'CSV · до 500 строк');
  target.append(div('panel stack',
    div('row spread',e('h2',{},state.table[1]),div('row',csv,editable?button('Добавить строку',()=>rowDialog(data,path),'primary'):null)),
    resultTable(data,actions?row=>button('Изменить',()=>rowDialog(data,path,row)):null),
    div('row spread',e('small',{},data.rows.length?`Строки ${state.offset+1}–${state.offset+data.rows.length}`:'Строк нет'),
      div('row',button('Назад',()=>{state.offset-=50;render();},null,{disabled:!state.offset}),
        button('Далее',()=>{state.offset+=50;render();},null,{disabled:!data.truncated || state.offset>=1000000}))),
  ));
  target.append(div('panel stack',e('h2',{},'Столбцы'),resultTable({
    columns:['Имя','Тип','Допускает NULL','Первичный ключ'],
    rows:data.definition.map(([name,type,nullable,key])=>[name,type,nullable==='YES'?'Да':'Нет',key?'Да':'']),
  })));
}
function resultTable(data,actions) {
  if (!data.columns.length) return e('p',{},data.affected==null?'Запрос выполнен':`Затронуто строк: ${data.affected}`);
  return div('table-wrap',e('table',{},
    e('thead',{},e('tr',{},data.columns.map(name=>e('th',{scope:'col'},name)),actions?e('th',{scope:'col'},'Действия'):null)),
    e('tbody',{},data.rows.map(row=>e('tr',{},row.map(value=>e('td',{},value==null?e('i',{},'NULL'):String(value))),actions?e('td',{class:'actions'},actions(row)):null))),
  ));
}
function rowDialog(data,path,row) {
  const key = Object.fromEntries(data.definition.filter(field=>field[3]).map(([name])=>[name,row?.[data.columns.indexOf(name)]]));
  const fields = data.definition.map(([name,type],index)=>{
    const mode = select('mode'+index,[['skip',row?'Без изменений':'По умолчанию'],['value','Значение'],['null','NULL']],'skip');
    const input = field('value'+index,'text',row?.[data.columns.indexOf(name)] ?? '',{hidden:true});
    mode.addEventListener('change',()=>{input.hidden=mode.value!=='value';});
    return div('table-picker',label(name+' · '+type,mode),input);
  });
  openDialog(row?'Изменить строку':'Добавить строку',form(fields,'Сохранить',async dataInput=>{
    const values = Object.fromEntries(data.definition.flatMap(([name],index)=>{
      const mode = dataInput['mode'+index];
      if (mode==='skip') return [];
      return [[name,mode==='null'?null:dataInput['value'+index]]];
    }));
    await api(path,'POST',{action:row?'update':'insert',values,key});
    dialog.close();
    render();
  },row?button('Удалить строку',()=>confirmAction('Удалить строку?','Строка будет удалена из базы данных.',async ()=>{
    await api(path,'POST',{action:'delete',key});render();
  }),'danger'):[]));
}
function sqlView(target) {
  const output = div('panel stack');
  target.append(div('panel stack',e('h2',{},'SQL-консоль'),
    form([
      label('Одна SQL-команда',e('textarea',{name:'sql',class:'code',placeholder:'SELECT …',spellcheck:'false',required:true,maxlength:65000})),
      label('Подтверждаю выполнение команды в выбранной базе',field('confirm','checkbox','1',{required:true}),'check'),
    ],'Выполнить',async (data,formNode)=>{
      const result = await api(route('sql'),'POST',{sql:data.sql});
      formNode.elements.confirm.checked=false;
      output.replaceChildren(resultTable(result));
      if (result.truncated) output.append(e('small',{},'Показаны первые 200 строк.'));
    })),output);
}
function graph(target) {
  const canvas = e('canvas',{tabindex:0,'aria-label':'Трёхмерная схема. Стрелки вращают, плюс и минус меняют масштаб.'});
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
    div('row spread',e('h2',{},'Связи таблиц'),div('row',
      button('−',()=>move(0,0,1/1.2),null,{'aria-label':'Уменьшить масштаб'}),
      button('+',()=>move(0,0,1.2),null,{'aria-label':'Увеличить масштаб'}),
      button('Сбросить вид',()=>{yaw=-.2;pitch=.8;zoom=1;draw();}))),
    canvas,
    e('small',{},`Объекты — ${graphTables.length} · Связи — ${edges.length}. Перетащите схему, чтобы повернуть, или нажмите на таблицу, чтобы открыть её.`),
    state.tables.length>120?e('small',{},'На схеме показаны первые 120 объектов.'):null,
    div('row',div('grow',label('Таблица',picker)),button('Открыть',()=>viewTable(Number(picker.value)))),
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
