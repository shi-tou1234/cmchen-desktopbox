'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const files = require('../src/main/basketfiles');
const organize = require('../src/main/organize');
const store = require('../src/main/store');
const baskets = require('../src/main/baskets');
const mouse = require('../src/main/mouseState');
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
function source(name) {
 const start = main.indexOf('function '+name+'('); assert.ok(start>=0,name);
 let n=0; for(let i=main.indexOf('{',start);i<main.length;i++) { if(main[i]==='{')n++; if(main[i]==='}'&&--n===0)return main.slice(start,i+1); }
 throw Error(name);
}
async function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(),'deskbasket-reliable-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const a=path.join(root,'source'),b=path.join(root,'dest');fs.mkdirSync(a);fs.mkdirSync(b);return {root,a,b}; }
test('枚举或属性读取失败一律报错，不能将不可读目录当成空目录',()=>{
 const dir={isDirectory:()=>true};
 assert.throws(()=>files.snapshotTree('X:',{statSync:()=>dir,readdirSync:()=>{throw Error('EACCES');}}),/EACCES/);
 assert.throws(()=>files.snapshotTree('X:',{statSync:()=>dir,readdirSync:()=>['child'],lstatSync:()=>{throw Error('EPERM');}}),/EPERM/);
});
test('重名移动返回实际目标，按原名称撤销且不覆盖占位文件',async t=>{
 const {a,b}=await fixture(t);const src=path.join(a,'样例.txt');fs.writeFileSync(src,'my original');fs.writeFileSync(path.join(b,'样例.txt'),'existing');
 const result=await files.placeInto(b,src);assert.equal(result.action,'move');assert.equal(path.basename(result.dest),'样例 (2).txt');assert.equal(fs.existsSync(src),false);
 fs.writeFileSync(src,'new occupant');const refused=await files.placeInto(a,result.dest,{exactName:'样例.txt'});assert.equal(refused.ok,false);assert.equal(fs.readFileSync(src,'utf8'),'new occupant');
 fs.unlinkSync(src);const back=await files.placeInto(a,result.dest,{exactName:'样例.txt'});assert.equal(back.action,'move');assert.equal(back.dest,src);assert.equal(fs.readFileSync(src,'utf8'),'my original');assert.equal(fs.readFileSync(path.join(b,'样例.txt'),'utf8'),'existing');
});
test('并发同名移动串行选位，两个源文件都保留正确内容',async t=>{
 const {a,b,root}=await fixture(t);const c=path.join(root,'other');fs.mkdirSync(c);for(const [dir,text]of [[a,'one'],[c,'two']])fs.writeFileSync(path.join(dir,'same.txt'),text);
 const out=await Promise.all([files.placeInto(b,path.join(a,'same.txt')),files.placeInto(b,path.join(c,'same.txt'))]);assert.ok(out.every(r=>r.action==='move'));assert.notEqual(out[0].dest,out[1].dest);assert.deepEqual(out.map(r=>fs.readFileSync(r.dest,'utf8')).sort(),['one','two']);
});
test('目录复制校验含内容而非只有文件大小；拒绝移入自己的子目录',async t=>{
 const {a,b}=await fixture(t);fs.writeFileSync(path.join(a,'a.txt'),'1234');fs.mkdirSync(path.join(a,'sub'));fs.writeFileSync(path.join(a,'sub','x'),'中文');
 const result=await files.placeInto(b,a,{mode:'copy'});assert.equal(result.ok,true);const before=files.snapshotTree(a);assert.equal(await files.verifyCopy(a,result.dest,before),'');
 fs.writeFileSync(path.join(result.dest,'a.txt'),'5678');assert.match(await files.verifyCopy(a,result.dest,before),/内容/);
 assert.equal((await files.placeInto(path.join(a,'sub'),a)).ok,false);
});
test('扫描符号链接时失败关闭，不跟随链接删除外部内容',()=>{
 assert.throws(()=>files.snapshotTree('root',{lstatSync:()=>({isSymbolicLink:()=>true})}),/符号链接/);
});
test('目标目录不可读时失败而不是猜测空位',async t=>{
 const {a,b}=await fixture(t);const src=path.join(a,'a');fs.writeFileSync(src,'a');const out=await files.placeInto(path.join(b,'missing'),src);assert.equal(out.ok,false);assert.equal(fs.existsSync(src),true);
});
test('扩展名与关键词合取，第一条规则优先；排除项不移动',()=>{
 const rules=[{extensions:'PDF',keyword:'课程',target:'课程资料'},{extensions:'pdf',target:'所有PDF'}];
 const entries=['课程一.PDF','普通.pdf','临时.tmp','a.txt'].map(name=>({name,path:name}));
 const out=organize.planOrganization(entries,[],{rules,exclude:['*.tmp']});
 assert.equal(out.groups[0].name,'课程资料');assert.equal(out.groups[0].count,1);assert.equal(out.groups[1].name,'所有PDF');assert.equal(out.skipped[0].reason,'excluded');
});
test('关键词规则、关闭规则和同目标合并；已有筐复用',()=>{
 const rules=[{keyword:'禁止',target:'禁用',enabled:false},{keyword:'报告',target:'工作'},{extensions:'png',target:'工作'}];
 const out=organize.planOrganization([{name:'报告.docx'},{name:'图.png'}],[{id:'b',name:'工作'}],{rules});
 assert.equal(out.groups.length,1);assert.equal(out.groups[0].basketId,'b');assert.equal(out.groups[0].count,2);
});
test('通配排除按文件名匹配，正则字符视为字面量',()=>{
 assert.equal(organize.excludedName('abc.tmp',['*.tmp']),true);assert.equal(organize.excludedName('a[1].txt',['a[1].txt']),true);assert.equal(organize.excludedName('a1.txt',['a[1].txt']),false);assert.equal(organize.excludedName('x.tmp',['?.tmp']),true);
});
test('新设置规范化、规则与固定路径跨配置保存保留',()=>{
 const value=store.mergedSettings({low_memory:false,focus_manual:true,focus_fullscreen:false,organize_rules:[{extensions:'*.PDF,docx',target:'学习'}],baskets:[{id:'b',items:['C:\\a.txt'],pinned:['C:\\a.txt']}]});
 assert.equal(value.low_memory,false);assert.equal(value.focus_manual,true);assert.equal(value.focus_fullscreen,false);assert.equal(value.organize_rules[0].extensions,'pdf,docx');assert.equal(value.baskets[0].pinned.length,1);
 const again=store.mergedSettings(JSON.parse(JSON.stringify(value)));assert.deepEqual(again.organize_rules,value.organize_rules);assert.deepEqual(again.baskets[0].pinned,value.baskets[0].pinned);
});
test('固定优先且不改底层顺序，取消固定恢复原顺序',()=>{
 const c=vm.createContext({basketfiles:files});vm.runInContext(source('pinnedEntries'),c);const entries=['a','b','c'].map(path=>({path}));const basket={pinned:['c']};assert.deepEqual(Array.from(c.pinnedEntries(basket,entries),e=>e.path),['c','a','b']);assert.deepEqual(entries.map(e=>e.path),['a','b','c']);assert.deepEqual(Array.from(c.pinnedEntries({pinned:[]},entries),e=>e.path),['a','b','c']);
});
test('从筐移除后清掉固定标记',()=>{const b=baskets.normalizeBasket({items:['C:\\a.txt'],pinned:['C:\\a.txt']});assert.equal(baskets.removeItem(b,'C:\\a.txt').pinned.length,0);});
test('新旧鼠标协议兼容，完整全屏状态解析',()=>{
 assert.equal(mouse.parseReport('0:1:0:-1920:20:123:1').fullscreen,true);assert.equal(mouse.parseReport('0:1:0:20:20:123:0').fullscreen,false);assert.equal(mouse.parseReport('0:1:0:20:20:123:2'),null);assert.equal(mouse.parseReport('0:1').overDesktop,true);
});
test('常驻 F9 可隐藏与恢复，专注期间不唤出',()=>{
 let hidden=0,shown=0;const c=vm.createContext({settings:{dock_enabled:true,dock_auto_hide:false},focusActive:false,dockManuallyHidden:false,dockWindow:{isDestroyed:()=>false,hide:()=>hidden++,showInactive:()=>shown++},closeFolderPopup(){},hideWeatherCard(){},setDockTopmost(){}});vm.runInContext(source('toggleDockByHotkey'),c);c.toggleDockByHotkey();assert.equal(hidden,1);c.toggleDockByHotkey();assert.equal(shown,1);c.focusActive=true;c.toggleDockByHotkey();assert.equal(hidden,1);
});
test('专注/手动隐藏阻止 Dock 命中，遮挡回归仍有独立测试',()=>{
 const c=vm.createContext({focusActive:true,dockManuallyHidden:false});vm.runInContext(source('dockCanInteract'),c);assert.equal(c.dockCanInteract(),false);c.focusActive=false;c.dockManuallyHidden=true;assert.equal(c.dockCanInteract(),false);
});
test('主进程图标缓存按条数与字节数封顶，大图不会无限占用',()=>{
 const c=vm.createContext({settings:{low_memory:true},CACHE_MAX:1024});vm.runInContext(source('cacheSet'),c);const map=new Map();for(let i=0;i<300;i++)c.cacheSet(map,i,'tiny');assert.equal(map.size,128);c.cacheSet(map,'huge','x'.repeat(5*1024*1024));assert.equal(map.size,0);
});


test('恢复日志在源名称删除前保存，保存失败时保留原件',async t=>{
 const {a,b}=await fixture(t);const src=path.join(a,'journal.txt');fs.writeFileSync(src,'safety');let called=false;
 const result=await files.placeInto(b,src,{onPrepared:({from,to})=>{called=true;assert.equal(fs.existsSync(from),true);assert.equal(fs.readFileSync(to,'utf8'),'safety');throw Error('disk full');}});
 assert.equal(called,true);assert.equal(result.action,'copy');assert.equal(fs.existsSync(src),true);assert.equal(fs.readFileSync(result.dest,'utf8'),'safety');assert.match(result.note,/恢复记录保存失败/);
});
test('目录移动也在删除源目录前完成恢复记录',async t=>{
 const {a,b}=await fixture(t);fs.writeFileSync(path.join(a,'x'),'data');let called=false;
 const result=await files.placeInto(b,a,{onPrepared:({from,to})=>{called=true;assert.equal(fs.existsSync(from),true);assert.equal(fs.readFileSync(path.join(to,'x'),'utf8'),'data');}});
 assert.equal(called,true);assert.equal(result.action,'move');assert.equal(fs.existsSync(a),false);
});
const popupSource=fs.readFileSync(path.join(__dirname,'../src/renderer/popup.js'),'utf8');
function popupFunction(name){const begin=popupSource.indexOf('function '+name+'(');assert.ok(begin>=0,name);const start=popupSource.lastIndexOf('async ',begin)===begin-6?begin-6:begin;let count=0;for(let i=popupSource.indexOf('{',begin);i<popupSource.length;i++){if(popupSource[i]==='{')count++;if(popupSource[i]==='}'&&--count===0)return popupSource.slice(start,i+1);}throw Error(name);}
test('Shift 连选存储纯路径，固定标记不污染选区',()=>{
 const c=vm.createContext({currentEntries:()=>[{path:'a'},{path:'b',pinned:true},{path:'c'}],applySelection(){},selection:null});vm.runInContext(popupFunction('selectRange'),c);c.selectRange(0,1);assert.deepEqual(Array.from(c.selection),['a','b']);
});
test('删除、移出与剪贴板传输保持字符串路径协议',async()=>{
 for(const [fn,key,response]of [['trashSelection','trashItems',{failed:[]}],['moveOutSelection','moveOutItems',{results:[{ok:true}],total:0}],['copySelection','copyToClipboard',{ok:true}]]){
  let received;const c=vm.createContext({opTargets:()=>[{path:'a',name:'a',pinned:true}],api:{[key]:(...args)=>{received=args;return response;}},view:{basketId:'b'},reloadHome:async()=>{},setStatus(){}});vm.runInContext(popupFunction(fn),c);await c[fn]();assert.deepEqual(Array.from(received.at(-1)),['a'],fn);
 }
});
test('自动专注遵循已知全屏报告，未知状态不错误唤出',()=>{
 let report={known:true,fullscreen:true},hides=0,shows=0;const c=vm.createContext({settings:{focus_manual:false,focus_fullscreen:true},mouseState:{ensureRunning(){},poll:()=>report},dockWindow:{isDestroyed:()=>false,hide:()=>hides++,showInactive:()=>shows++},windowLayer:{handleOf:()=>1},focusActive:false,dockManuallyHidden:false,dockSlideTimer:null,dockLayerRevision:0,popupExternalDrag:false,organizeBusy:false,closeMenuIfOpen(){},hideWeatherCard(){},closeFolderPopup(){},syncDock(){},applyDockLayerMode(){},viz:{applySetting(){}},broadcastState(){}});
 vm.runInContext(source('updateFocusMode'),c);c.updateFocusMode();assert.equal(c.focusActive,true);assert.equal(hides,1);report={known:false};c.updateFocusMode();assert.equal(c.focusActive,true);report={known:true,fullscreen:false};c.updateFocusMode();assert.equal(c.focusActive,false);assert.equal(shows,1);
});

test('异步旧筐快照不能复活已移走的条目',()=>{
 const old={id:'b',items:['C:/gone.txt']},current={id:'b',items:[],dir:''};const c=vm.createContext({findBasket:()=>current,basketScanCache:new Map(),basketfiles:files,fs,path,sameItemList:()=>true});vm.runInContext(source('basketView'),c);assert.equal(c.basketView(old).entries.length,0);assert.equal(c.basketView(old).items.length,0);
});
test('读取拒绝访问不会自动清除文件登记',()=>{
 const b={id:'b',dir:'root',items:['root/locked.txt']};const c=vm.createContext({findBasket:()=>b,basketScanCache:new Map(),basketfiles:files,basketModel:baskets,path,fs:{readdirSync:()=>['locked.txt'],statSync:p=>{if(p==='root')return {mtimeMs:1};const e=Error('denied');e.code='EACCES';throw e;}},sameItemList:()=>false});vm.runInContext(source('basketView'),c);assert.equal(c.basketView(b).items.length,1);assert.equal(c.basketView(b).entries[0].exists,false);
});
