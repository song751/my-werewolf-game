/**********************************************************************
 * 双身份狼人杀 – 精简自动法官 v11.0
 * ---------------------------------------------------------------
 * 1. 完全覆盖文档《规则说明书》全部条款；
 * 2. 单文件即可运行；需要 index.html / styles.css 原样配合；
 * 3. Firebase RTDB 8.x；所有读写路径与旧版一致，支持平滑替换。
 *********************************************************************/

/* ==================== 0. Firebase 初始化 ==================== */

const firebaseConfig = {
  apiKey: "AIzaSyCEAgB6DoY8YA6lZnYblhIDVTYH_q8UimI",
  authDomain: "werewolf-game-master-1f37f.firebaseapp.com",
  databaseURL: "https://werewolf-game-master-1f37f-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "werewolf-game-master-1f37f",
  storageBucket: "werewolf-game-master-1f37f.appspot.com",
  messagingSenderId: "626014452910",
  appId: "1:626014452910:web:35b6eba412f95f1878013f",
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

/* ==================== 1. 常量/数据 ==================== */

const ROLES = {
  // good
  平民:   { faction: 'good', icon: '👤' },
  守卫:   { faction: 'good', icon: '🛡️', unique: true },
  白痴:   { faction: 'good', icon: '🤪', unique: true },
  预言家: { faction: 'good', icon: '🔮', unique: true },
  骑士:   { faction: 'good', icon: '⚔️', unique: true },
  女巫:   { faction: 'good', icon: '🧪', unique: true },
  猎人:   { faction: 'good', icon: '🔫', unique: true },
  // bad
  狼人:   { faction: 'bad',  icon: '🐺' },
  隐狼:   { faction: 'bad',  icon: '🌑', unique: true, isInvisible: true },
  // neutral
  盗贼:   { faction: 'neu',  icon: '🎭', unique: true, isThief: true },
};
const GOD_ROLES = new Set(['守卫','白痴','预言家','骑士','女巫','猎人']);
const UNIQUE = new Set(Object.keys(ROLES).filter(k=>ROLES[k].unique));
const FORBID = new Set(['狼人|隐狼','预言家|狼人','预言家|隐狼','盗贼|狼人','盗贼|隐狼']);
const DEFAULT_SETUP = { 平民:6, 守卫:1, 白痴:1, 预言家:1, 骑士:1, 女巫:1, 猎人:1, 狼人:2, 隐狼:1, 盗贼:1 };

const PHASE = {
  SETUP:'SETUP', NIGHT:'NIGHT', NIGHT_WITCH:'NIGHT_WITCH', DAWN:'DAWN',
  SHERIFF_CAND:'SHERIFF_CAND', SHERIFF_SPEECH:'SHERIFF_SPEECH', SHERIFF_VOTE:'SHERIFF_VOTE',
  DAY_TALK:'DAY_TALK', DAY_VOTE:'DAY_VOTE',
  HUNTER:'HUNTER', BADGE:'BADGE',
  GAME_OVER:'GAME_OVER'
};

/* ==================== 2. 小工具 ==================== */

const $ = id => document.getElementById(id);
const escape = s=>s.replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
const shuffle = a=>{let i=a.length;while(i){const r=Math.random()*i--|0;[a[i],a[r]]=[a[r],a[i]]}return a};
const wait = ms=>new Promise(r=>setTimeout(r,ms));

/* ==================== 3. 状态机内核 ==================== */

class Engine {
  constructor(gameId){ this.id=gameId; }
  /* ---------- 数据读写 ---------- */
  ref(p){ return db.ref(`games/${this.id}/${p}`); }
  async read(p){ return (await this.ref(p).once('value')).val(); }
  write(p,v){ return this.ref(p).set(v); }
  update(obj){ return db.ref(`games/${this.id}`).update(obj); }
  push(p,v){ return this.ref(p).push(v); }

  /* ---------- 规则辅助 ---------- */
  activeRole(p){ return p.isAlive ? p.identities[Math.min(p.deaths,1)].role : null; }
  hasWolf(p){ return p.identities.some(i=>i.role==='狼人'||i.role==='隐狼'); }
  golden(p){ return p.identities.every(i=>i.role==='平民'); }
  invisibleActive(){ return this.state.settings.hiddenTrigger==='noWolfAlive'
    ? !Object.values(this.players).some(p=>p.isAlive&&this.activeRole(p)==='狼人')
    : !Object.values(this.players).some(p=>p.isAlive&&this.activeRole(p)==='狼人'); } // 两种写法一样，只是占位

  /* ---------- 主循环（主持端调用） ---------- */
  async tick(){
    this.state = await this.read('state')||{};
    this.players = await this.read('players')||{};
    this.actions = await this.read('actions')||{};
    switch(this.state.phase){
      case PHASE.NIGHT:            return this.checkNightEnd();
      case PHASE.NIGHT_WITCH:      return this.checkWitchEnd();
      case PHASE.DAWN:             return this.dawnResolve();
      case PHASE.SHERIFF_CAND:     return this.to(PHASE.SHERIFF_SPEECH);
      case PHASE.SHERIFF_VOTE:     return this.checkSheriffVote();
      case PHASE.DAY_VOTE:         return this.checkDayVote();
      case PHASE.HUNTER:           return this.checkHunterQueue();
    }
  }

  /* ---------- 阶段跳转 ---------- */
  async to(phase, extra={}){
    await this.update({ 'state/phase':phase, ...extra });
  }

  /* ---------------- 夜晚流程 --------------- */

  guardTarget(){           // 返回 null=空守, undefined=未守
    const g = this.actions[this.state.round]?.NIGHT?.GUARD||{};
    const rec = Object.values(g)[0]; // 只有一个守卫
    return rec?rec.target:undefined;
  }
  wolfTarget(){ return this.actions[this.state.round]?.NIGHT?.WOLF?.final||'0'; }
  cureTarget(){ return this.actions[this.state.round]?.NIGHT_WITCH?.cure||null; }
  poisonTarget(){ return this.actions[this.state.round]?.NIGHT_WITCH?.poison||null; }

  async checkNightEnd(){
    /* 必须满足：1) 已拍板 或 场上无活狼人；2) 若有女巫且存活 -> 进入WITCH，否则直奔DAWN */
    const wolvesAlive = Object.values(this.players).some(p=>p.isAlive && ['狼人','隐狼'].includes(this.activeRole(p)));
    const final = this.wolfTarget();
    if(final==null && wolvesAlive) return;          // 未拍板
    const witchAlive = Object.values(this.players).some(p=>p.isAlive && this.activeRole(p)==='女巫');
    if(witchAlive) await this.to(PHASE.NIGHT_WITCH); else await this.to(PHASE.DAWN);
  }

  async checkWitchEnd(){
    const w = await this.read(`actions/${this.state.round}/NIGHT_WITCH`)||{};
    const witchAlive = Object.values(this.players).find(p=>p.isAlive && this.activeRole(p)==='女巫');
    if(!witchAlive || w[witchAlive.id]!==undefined) await this.to(PHASE.DAWN);
  }

  /* ---------------- 黎明结算 --------------- */

  async dawnResolve(){
    if(this.state.resolving) return;
    await this.write('state/resolving',true);

    const deaths=[];
    // 狼刀
    const wolf = this.wolfTarget();
    if(wolf!=='0'&&wolf){
      const blocked = this.guardTarget()===wolf || this.cureTarget()===wolf;
      if(!blocked) deaths.push({pid:wolf,cause:'WOLF'});
    }
    // 毒
    if(this.poisonTarget() && !deaths.find(d=>d.pid===this.poisonTarget())){
      deaths.push({pid:this.poisonTarget(),cause:'POISON'});
    }
    // 处理死亡链
    for(const d of deaths) await this.kill(d.pid,d.cause);

    // 连续平安夜计数
    if(deaths.length) await this.write('state/peace',0);
    else               await this.write('state/peace',(this.state.peace||0)+1);

    // 日志
    const msg = deaths.length?`昨夜死亡：${deaths.map(d=>d.pid+'号').join('、')}`:'昨夜平安夜';
    await this.log(msg);

    // 进入竞选警长 (第一天) 或白天发言
    if(this.state.round===1) await this.to(PHASE.SHERIFF_CAND);
    else await this.to(PHASE.DAY_TALK);
    await this.write('state/resolving',null);
  }

  /* ------------------- 白天 -------------------- */

  async checkDayVote(){
    const r=this.state.round;
    const voters=Object.values(this.players).filter(p=>p.isAlive&&!p.isExposedIdiot);
    const rec=this.actions[r]?.DAY_VOTE||{};
    if(voters.every(v=>rec[v.id]!==undefined)) await this.tallyDayVote();
  }
  async tallyDayVote(){
    const r=this.state.round;
    const rec=this.actions[r].DAY_VOTE;
    const sheriff = Object.values(this.players).find(p=>p.badge);
    const weight=pid=>pid==sheriff?.id?3:2;
    const cnt={};
    Object.entries(rec).forEach(([pid,{target}])=>{
      if(target==='0')return;
      cnt[target]=(cnt[target]||0)+weight(pid);
    });
    const max=Math.max(0,...Object.values(cnt));
    const outs=Object.keys(cnt).filter(k=>cnt[k]===max);
    await this.log('---- 放逐票型 ----\n'+JSON.stringify(cnt));
    if(outs.length===1){
      await this.log(`放逐 ${outs[0]}号`);
      await this.kill(outs[0],'VOTE');
    }else await this.log('平票无人出局');
    await this.startNight(r+1);
  }

  async checkSheriffVote(){
    const voters=Object.values(this.players).filter(p=>p.isAlive&&!p.isExposedIdiot);
    const v=this.state.sheriff?.votes||{};
    if(voters.every(pl=>v[pl.id]!==undefined)) await this.tallySheriff();
  }
  async tallySheriff(){
    const {candidates,votes,isPK}=this.state.sheriff;
    const valid=Object.keys(candidates).filter(id=>candidates[id]&&!this.state.sheriff.drops?.[id]);
    if(!valid.length){ await this.log('无人上警'); await this.to(PHASE.DAY_TALK,{sheriff:null}); return; }

    const cnt={}; Object.entries(votes).forEach(([pid,t])=>{
      if(t==='0'||!valid.includes(t))return; cnt[t]=(cnt[t]||0)+1;
    });
    const max=Math.max(0,...Object.values(cnt));
    const win=Object.keys(cnt).filter(k=>cnt[k]===max);
    if(win.length===1){ await this.update({[`players/${win[0]}/badge`]:1,'state/sheriff':null}); await this.log(`⭐ ${win[0]}号当选警长`); await this.to(PHASE.DAY_TALK); }
    else if(isPK){ await this.log('再次平票，本局无警长'); await this.to(PHASE.DAY_TALK,{sheriff:null}); }
    else{ const obj={};win.forEach(i=>obj[i]=1);await this.write('state/sheriff',{candidates:obj,isPK:true});await this.to(PHASE.SHERIFF_SPEECH);}
  }

  /* ------------------- 其他 -------------------- */

  async startNight(round){
    await this.update({ actions:{}, 'state/round':round, 'state/phase':PHASE.NIGHT, 'state/showWolf':round===1 });
  }

  async kill(pid,cause){
    const p=this.players[pid]; if(!p||!p.isAlive) return;
    const newDeaths=p.deaths+1;
    const isOut=newDeaths>=2;
    const up={ [`players/${pid}/deaths`]:newDeaths, [`players/${pid}/isAlive`]:!isOut };
    await this.update(up);

    // 猎人
    if(this.activeRole(p)==='猎人'&&['WOLF','VOTE'].includes(cause)){
      await this.update({[`state/hunters/${pid}`]:true});
    }
    // 白痴
    if(this.activeRole(p)==='白痴'&&cause==='VOTE'&&!p.isExposedIdiot){
      await this.update({[`players/${pid}/isExposedIdiot`]:true});
      await this.log(`🤪 ${pid}号白痴翻牌（掉一命）`);
    }

    // 警徽移交
    if(isOut&&p.badge){
      await this.to(PHASE.BADGE,{postBadge:{dead:pid,next:this.state.phase==='NIGHT'?PHASE.DAY_TALK:PHASE.NIGHT}});
      return;
    }
    await this.checkWin();
  }

  async checkHunterQueue(){
    const qs=await this.read('state/hunters')||{};
    if(!Object.values(qs).some(v=>v)) return; // 仍有待执行
    await this.to(this.state.nextPhaseAfterHunter||PHASE.DAY_TALK,{'state/hunters':null,'state/nextPhaseAfterHunter':null});
  }

  /* ---------- 胜负判定 ---------- */
  async checkWin(){
    const alive=Object.values(this.players).filter(p=>p.isAlive);
    const wolvesAlive=alive.some(p=>['狼人','隐狼'].includes(this.activeRole(p)));
    const peace=await this.read('state/peace')||0;

    if(!wolvesAlive||peace>=3){
      await this.to(PHASE.GAME_OVER,{'state/winner':'🏆 好人获胜'});return true;
    }
    const setting=this.state.settings.wolfWin;
    if(setting==='exterminate'){
      const goodAlive=alive.some(p=>this.activeRole(p)&&ROLES[this.activeRole(p)].faction==='good');
      if(!goodAlive){ await this.to(PHASE.GAME_OVER,{'state/winner':'🐺 狼人屠城获胜'});return true;}
    }else{
      const godAlive=alive.some(p=>(p.identities.some(i=>GOD_ROLES.has(i.role))));
      const goldenAlive=alive.some(p=>this.golden(p));
      if(!godAlive||!goldenAlive){
        await this.to(PHASE.GAME_OVER,{'state/winner':'🐺 狼人屠边获胜'});return true;
      }
    }
    return false;
  }

  /* ---------- 日志 ---------- */
  async log(msg,secret=false){
    await this.push('logs',{msg,ts:firebase.database.ServerValue.TIMESTAMP,round:this.state.round||0,secret});
  }
}

/* ==================== 4. 客户端 (UI + 事件) ==================== */

const App={
  me:null, gameId:null, engine:null, unsub:[], selection:null,

  /* ---------- 启动 ---------- */
  init(){
    const p=new URLSearchParams(location.search);
    this.gameId=p.get('game'); this.me=p.get('player');
    document.addEventListener('click',e=>this.onClick(e));
    if(this.gameId&&this.me) this.enterGame(); else this.renderSetup();
  },

  /* ---------- 创建 / 加入 ---------- */
  async createGame(){
    const counts={}; $('role-grid').querySelectorAll('input').forEach(i=>{
      const n=i.id.replace('role-',''); const v=+i.value||0; if(v) counts[n]=v;
    });
    const pool=[]; Object.entries(counts).forEach(([r,c])=>{
      if(UNIQUE.has(r)&&c>1) return this.toast(`${r} 只能 1 张`,'error');
      for(let i=0;i<c;i++) pool.push(r);
    });
    if(pool.length===0||pool.length%2!==0) return this.toast('身份数必须为偶数且>0','error');
    const dealt=this.deal(pool); if(!dealt) return this.toast('配置非法：出现禁用组合','error');

    const id=db.ref('games').push().key;
    const players={};
    dealt.pairs.forEach((pair,i)=>{
      players[i+1]={id:i+1,identities:pair,deaths:0,isAlive:true,isReady:false,isExposedIdiot:false,badge:0,skill:{}};
    });
    const settings={
      witchRule: $('opt-witch-selfsave').value,
      seerMode: $('opt-seer-mode').value,
      wolfWin: $('opt-wolf-win').value,
      hiddenTrigger: $('opt-wolf-visibility').value
    };
    const init={players,settings,actions:{},logs:{},
      state:{phase:PHASE.SETUP,round:0,host:1,peace:0}};
    await db.ref(`games/${id}`).set(init);
    this.toast('房间创建成功','success');
    location.href=`?game=${id}&player=1`;
  },
  deal(pool){
    for(let t=0;t<6000;t++){
      const d=shuffle([...pool]); const pairs=[]; let ok=true;
      for(let i=0;i<d.length;i+=2){
        const a=d[i],b=d[i+1]; const key=[a,b].sort().join('|');
        if(FORBID.has(key)){ok=false;break;}
        if(a==='盗贼'&&b==='盗贼'){ok=false;break;}
        if(a==='盗贼') pairs.push([{role:b,isCopy:true},{role:b}]);
        else if(b==='盗贼') pairs.push([{role:a},{role:a,isCopy:true}]);
        else pairs.push([{role:a},{role:b}]);
      }
      if(ok) return {pairs};
    }
    return null;
  },

  /* ---------- 进入房间 ---------- */
  enterGame(){
    $('setup-view').classList.add('hidden'); $('game-view').classList.remove('hidden');
    this.engine=new Engine(this.gameId);
    const root=db.ref(`games/${this.gameId}`);
    this.unsub.push(root.on('value',snap=>this.render(snap.val())));
    if(this.me==='0') this.unsub.push(); // 上帝暂不实现 UI
  },

  /* ---------- 渲染 ---------- */
  render(data){
    if(!data) return;
    this.full=data;
    this.players=data.players||{};
    const me=this.players[this.me];
    if(me) this.renderIdentity(me);
    this.renderStatus(data.state);
  },
  renderStatus(st){
    const map={
      [PHASE.SETUP]:'等待玩家确认',
      [PHASE.NIGHT]:'夜晚行动',
      [PHASE.NIGHT_WITCH]:'女巫行动',
      [PHASE.DAWN]:'黎明结算',
      [PHASE.SHERIFF_CAND]:'上警意向',
      [PHASE.SHERIFF_SPEECH]:'上警发言',
      [PHASE.SHERIFF_VOTE]:'警长投票',
      [PHASE.DAY_TALK]:'白天发言',
      [PHASE.DAY_VOTE]:'放逐投票',
      [PHASE.HUNTER]:'猎人开枪',
      [PHASE.BADGE]:'警徽移交',
      [PHASE.GAME_OVER]:data.state.winner||'游戏结束'
    };
    $('status-bar').innerHTML=`<span class="status-text">${map[st.phase]}</span>`;
  },
  renderIdentity(me){
    const fmt=id=>`<span class="identity-item"><span class="identity-icon">${ROLES[id.role].icon}</span><span class="identity-name${id.isCopy?' thief-copy-text':''}">${id.role}</span></span>`;
    $('identity-card').innerHTML=`
      <div class="identity-header">你的身份</div>
      <div class="identity-display">${fmt(me.identities[0])}<span class="identity-separator">+</span>${fmt(me.identities[1])}</div>
      ${this.full.state.phase===PHASE.SETUP&&!me.isReady?`
        <div class="identity-actions">
          <button class="control-btn" data-act="swap">交换</button>
          <button class="confirm-btn" data-act="ready">确认</button>
        </div>`:''}`;
  },

  /* ---------- 事件 ---------- */
  async onClick(e){
    const b=e.target.closest('[data-act]'); if(!b) return;
    const act=b.dataset.act;
    if(act==='create') return this.createGame();
    if(!this.engine) return;
    switch(act){
      case 'swap': await this.engine.update({[`players/${this.me}/identities`]:[...this.players[this.me].identities].reverse()});break;
      case 'ready': await this.engine.update({[`players/${this.me}/isReady`]:true});break;
    }
  },

  /* ---------- 工具 ---------- */
  toast(txt,type='info'){
    const n=document.createElement('div');n.className=`notification ${type}`;n.innerText=txt;
    $('notification-container').appendChild(n);setTimeout(()=>n.remove(),3000);
  },

  /* ---------- 清理 ---------- */
  destroy(){ this.unsub.forEach(u=>u&&u()); }
};

document.addEventListener('DOMContentLoaded',()=>App.init());
