/**********************************************************************
 * 双身份狼人杀 - 电子法官 (FSM 精简版，纯前端/RTDB，无防作弊)
 * 说明：
 * - 仅用于朋友间娱乐，无任何安全/反作弊保障；
 * - 规则判定在“主持端（1号玩家）”本地完成并写库；
 * - 其他客户端只负责提交各自操作（写入 actions/*），与渲染状态；
 * - 数据结构与 index.html / styles.css 适配；无需服务器或云函数；
 * - Firebase SDK 使用 8.x（index.html 已引入）。
 *********************************************************************/

/* ==================== 0. 常量 & 数据 ==================== */

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

/* ==================== 1. 小工具 ==================== */

const $ = id => document.getElementById(id);
const el = (html)=>{ const d=document.createElement('div'); d.innerHTML=html.trim(); return d.firstElementChild; };
const escapeHtml = s=>String(s).replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
const shuffle = a=>{let i=a.length;while(i){const r=Math.random()*i--|0;[a[i],a[r]]=[a[r],a[i]]}return a};
const wait = ms=>new Promise(r=>setTimeout(r,ms));
const now = ()=>Date.now();

/* ==================== 2. Firebase 句柄 ==================== */

const firebaseConfig = {
  apiKey: "AIzaSyCEAgB6DoY8YA6lZnYblhIDVTYH_q8UimI",
  authDomain: "werewolf-game-master-1f37f.firebaseapp.com",
  databaseURL: "https://werewolf-game-master-1f37f-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "werewolf-game-master-1f37f",
  storageBucket: "werewolf-game-master-1f37f.appspot.com",
  messagingSenderId: "626014452910",
  appId: "1:626014452910:web:35b6eba412f95f1878013f",
};
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();

/* ==================== 3. 引擎（主持端本地规则判定） ==================== */

class Engine {
  constructor(gameId) { this.id=gameId; }
  ref(p){ return db.ref(`games/${this.id}/${p}`); }
  async read(p){ return (await this.ref(p).once('value')).val(); }
  write(p,v){ return this.ref(p).set(v); }
  update(obj){ return db.ref(`games/${this.id}`).update(obj); }
  push(p,v){ return this.ref(p).push(v); }

  /* —— 帮助 —— */
  activeIdx(p){ return Math.min(p.deaths||0,1); }
  activeRole(p){ return p.isAlive ? p.identities[this.activeIdx(p)].role : null; }
  playerAliveWolves(players,state){
    const activated = this.hiddenActivated(players,state);
    return Object.values(players).filter(p=>{
      if(!p.isAlive) return false;
      const ar = this.activeRole(p);
      if (ar==='狼人') return true;
      if (ar==='隐狼') return activated;
      return false;
    });
  }
  // 隐狼激活：settings.hiddenTrigger
  hiddenActivated(players,state){
    const trig = state?.settings?.hiddenTrigger || 'activeOnly';
    if (trig==='activeOnly'){
      // 无活跃狼人（活着且活跃身份为“狼人”的为0）则激活
      const anyActiveWolf = Object.values(players).some(p=>p.isAlive && this.activeRole(p)==='狼人');
      return !anyActiveWolf;
    } else {
      // 不存在狼人（全场两张牌都没“狼人”）
      const anyCardWolf = Object.values(players).some(p=>p.identities.some(i=>i.role==='狼人'));
      return !anyCardWolf;
    }
  }
  golden(p){ return p.identities.every(i=>i.role==='平民'); }
  hasWolfCard(p){ return p.identities.some(i=>i.role==='狼人'||i.role==='隐狼'); }
  isGod(p){ return p.identities.some(i=>GOD_ROLES.has(i.role)); }

  /* —— 宿主循环 —— */
  async tick(){
    const state = await this.read('state')||{};
    const players = await this.read('players')||{};
    const actions = await this.read('actions')||{};
    this.state=state; this.players=players; this.actions=actions;
    switch(state.phase){
      case PHASE.NIGHT:        return this.checkNightEnd();
      case PHASE.NIGHT_WITCH:  return this.checkWitchEnd();
      case PHASE.DAWN:         return this.dawnResolve();
      case PHASE.SHERIFF_VOTE: return this.checkSheriffVote();
      case PHASE.DAY_VOTE:     return this.checkDayVote();
      case PHASE.HUNTER:       return this.checkHunterQueue();
      case PHASE.BADGE:        return; // 等待移交
    }
  }

  async to(phase, extra={}){ await this.update({ 'state/phase':phase, ...extra }); }

  /* ========== 夜晚 ========== */

  guardChoice(){
    const g = this.actions[this.state.round]?.NIGHT?.GUARD||{};
    const rec = Object.values(g)[0]; // 只有一个守卫
    if (!rec) return undefined; // 未出手
    return rec.target===undefined ? undefined : rec.target; // null=空守
  }
  seerChoice(){
    const s = this.actions[this.state.round]?.NIGHT?.SEER||{};
    const rec = Object.values(s)[0];
    return rec?.target || null;
  }
  wolfVotes(){ return this.actions[this.state.round]?.NIGHT?.WOLF || {}; }
  wolfFinal(){ return this.actions[this.state.round]?.NIGHT?.WOLF?.final ?? undefined; } // '0'=空刀, undefined=未拍板
  cureTarget(){ return this.actions[this.state.round]?.NIGHT_WITCH?.cure ?? null; }
  poisonTarget(){ return this.actions[this.state.round]?.NIGHT_WITCH?.poison ?? null; }
  witchDoneFlag(){
    const data = this.actions[this.state.round]?.NIGHT_WITCH||{};
    return data?.done === true;
  }

  async checkNightEnd(){
    const wolvesAlive = this.playerAliveWolves(this.players,this.state).length>0;
    const final = this.wolfFinal();
    if (wolvesAlive && final===undefined) return; // 等拍板
    // 狼人已空刀或拍板，或无活狼 → 进入女巫或直接黎明
    const witchAlive = Object.values(this.players).some(p=>p.isAlive && this.activeRole(p)==='女巫');
    if (witchAlive) await this.to(PHASE.NIGHT_WITCH);
    else await this.to(PHASE.DAWN);
  }

  async checkWitchEnd(){
    const witchAlive = Object.values(this.players).some(p=>p.isAlive && this.activeRole(p)==='女巫');
    if(!witchAlive || this.witchDoneFlag()) await this.to(PHASE.DAWN);
  }

  /* ========== 黎明结算 ========== */

  async dawnResolve(){
    if(this.state.resolving) return;
    await this.write('state/resolving', true);

    const r=this.state.round;
    const deaths=[];
    // 狼刀
    const wolf = this.wolfFinal(); // '0' | pid | null | undefined
    if (wolf && wolf!=='0'){
      const blocked = (this.guardChoice()===wolf) || (this.cureTarget()===wolf);
      if(!blocked) deaths.push({pid:wolf,cause:'WOLF'});
    }
    // 毒
    const poison = this.poisonTarget();
    if(poison && !deaths.find(d=>d.pid===poison)) deaths.push({pid:poison, cause:'POISON'});

    // 处理死亡链（单次）
    for(const d of deaths){ await this.kill(d.pid, d.cause); }

    // 平安夜计数 & 日志
    if(deaths.length) await this.write('state/peace',0);
    else await this.write('state/peace',(this.state.peace||0)+1);

    await this.log(deaths.length?`昨夜死亡：${deaths.map(d=>d.pid+'号').join('、')}`:'昨夜平安夜');

    // 白天：第一天进入警长竞选，否则白天发言
    if(this.state.round===1){
      await this.update({'state/sheriff':{candidates:{},isPK:false}});
      await this.to(PHASE.SHERIFF_CAND);
    } else {
      await this.to(PHASE.DAY_TALK);
    }

    // 清理夜晚一次性记录
    await this.update({[`actions/${r}/NIGHT`]:null, [`actions/${r}/NIGHT_WITCH`]:null});
    await this.write('state/resolving', null);
  }

  /* ========== 白天 ========== */

  // 放逐投票
  async checkDayVote(){
    const r=this.state.round;
    const voters=Object.values(this.players).filter(p=>p.isAlive && !p.isExposedIdiot);
    const rec=this.actions[r]?.DAY_VOTE||{};
    if (voters.length===0) return;
    if(voters.every(v=>rec[v.id]!==undefined)){
      await this.tallyDayVote();
    }
  }
  async tallyDayVote(){
    const r=this.state.round;
    const rec=this.actions[r]?.DAY_VOTE||{};
    const sheriff = Object.values(this.players).find(p=>p.badge);
    const weight=pid=>pid==sheriff?.id?3:2; // 1.5 票用整数避免浮点
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
    }else{
      await this.log('平票无人出局');
    }
    await this.startNight(r+1);
  }

  // 警长投票
  async checkSheriffVote(){
    const voters=Object.values(this.players).filter(p=>p.isAlive && !p.isExposedIdiot);
    const v=this.state.sheriff?.votes||{};
    if(voters.every(pl=>v[pl.id]!==undefined)){
      await this.tallySheriff();
    }
  }
  async tallySheriff(){
    const {candidates,votes,isPK}=this.state.sheriff||{candidates:{},votes:{},isPK:false};
    const valid=Object.keys(candidates||{}).filter(id=>candidates[id] && !(this.state.sheriff?.drops||{})[id]);
    if(!valid.length){ await this.log('无人上警'); await this.to(PHASE.DAY_TALK,{sheriff:null}); return; }
    const cnt={};
    Object.entries(votes||{}).forEach(([pid,t])=>{
      if(t==='0'||!valid.includes(t))return; cnt[t]=(cnt[t]||0)+1;
    });
    const max=Math.max(0,...Object.values(cnt));
    const win=Object.keys(cnt).filter(k=>cnt[k]===max);
    if(win.length===1){
      await this.update({ [`players/${win[0]}/badge`]:1, 'state/sheriff':null });
      await this.log(`⭐ ${win[0]}号当选警长`);
      await this.to(PHASE.DAY_TALK);
    } else if(isPK){
      await this.log('再次平票，本局无警长');
      await this.to(PHASE.DAY_TALK,{sheriff:null});
    } else {
      const obj={}; win.forEach(i=>obj[i]=1);
      await this.update({ 'state/sheriff':{ candidates:obj, isPK:true } });
      await this.to(PHASE.SHERIFF_SPEECH);
    }
  }

  /* ========== 立即进入夜晚 ========== */
  async startNight(round){
    await this.update({
      actions:{},
      'state/round':round,
      'state/phase':PHASE.NIGHT,
      'state/showWolf': round===1 ? true : false
    });
  }

  /* ========== 杀人/死亡链 ========== */
  async kill(pid,cause){
    const p=this.players[pid]; if(!p||!p.isAlive) return;
    const wasSheriff = !!p.badge;
    const newDeaths=(p.deaths||0)+1;
    const isOut = newDeaths>=2;
    const up={
      [`players/${pid}/deaths`]:newDeaths,
      [`players/${pid}/isAlive`]:!isOut
    };

    // 白痴翻牌：仅“被票”且活跃身份为白痴
    if(this.activeRole(p)==='白痴' && cause==='VOTE' && !p.isExposedIdiot){
      up[`players/${pid}/isExposedIdiot`] = true;
      await this.log(`🤪 ${pid}号白痴翻牌（掉一命）`);
    }

    // 猎人链：活跃身份为猎人且被刀/被票
    if(this.activeRole(p)==='猎人' && (cause==='WOLF'||cause==='VOTE')){
      const q = await this.read('state/hunters')||{};
      q[pid]=true;
      await this.write('state/hunters', q);
    }

    await this.update(up);

    // 警徽移交
    if(isOut && wasSheriff){
      // 进入徽章移交相位，等待被淘汰警长处理
      await this.update({
        'state/phase': PHASE.BADGE,
        'state/postBadge': { dead: pid, next: (this.state.phase===PHASE.NIGHT||this.state.phase===PHASE.NIGHT_WITCH||this.state.phase===PHASE.DAWN) ? PHASE.DAY_TALK : PHASE.NIGHT }
      });
      return;
    }

    await this.checkWin();
  }

  /* ========== 猎人队列处理 ========== */
  async checkHunterQueue(){
    const q = await this.read('state/hunters')||{};
    const list = Object.keys(q).filter(k=>q[k]);
    if(list.length===0){
      const np = await this.read('state/nextPhaseAfterHunter') || PHASE.DAY_TALK;
      await this.update({ 'state/hunters':null, 'state/nextPhaseAfterHunter':null, 'state/phase':np });
      return;
    }
    // 等待 HUNTER_SHOOT（前端直接调用 kill）
    return;
  }

  /* ========== 决斗 ========== */
  async duel(fromPid, targetPid){
    const from=this.players[fromPid], tar=this.players[targetPid];
    if(!from?.isAlive || !tar?.isAlive) return;
    // 标记骑士已用
    await this.update({ [`players/${fromPid}/skill/knightUsed`]: true });

    // 判断目标是否狼人阵营：活跃“狼人”或已激活“隐狼”
    const activated = this.hiddenActivated(this.players, this.state);
    const tarActive = this.activeRole(tar);
    const isWolfFaction = (tarActive==='狼人') || (tarActive==='隐狼' && activated);

    if(isWolfFaction){
      await this.log(`⚔️ ${fromPid}号骑士对 ${targetPid}号 发动决斗（命中狼人阵营）`);
      await this.kill(targetPid,'DUEL');
      // 若导致警徽移交，移交完毕再入夜；否则立即入夜
      await this.update({ 'state/nextPhaseAfterHunter': PHASE.NIGHT });
      // 若还在白天相位，直接切夜
      if (this.state.phase===PHASE.DAY_TALK || this.state.phase===PHASE.DAY_VOTE){
        await this.startNight(this.state.round+1);
      }
    } else {
      await this.log(`⚔️ ${fromPid}号骑士对 ${targetPid}号 决斗失败（目标非狼人阵营）`);
      await this.kill(fromPid,'DUEL');
      // 白天继续
    }
  }

  /* ========== 胜负判定 ========== */
  async checkWin(){
    const alive=Object.values(this.players).filter(p=>p.isAlive);
    const activated = this.hiddenActivated(this.players, this.state);
    const wolvesAlive = alive.some(p=>{
      const ar=this.activeRole(p);
      return ar==='狼人' || (ar==='隐狼' && activated);
    });
    const peace=await this.read('state/peace')||0;

    if(!wolvesAlive || peace>=3){
      await this.to(PHASE.GAME_OVER, {'state/winner':'🏆 好人获胜'});
      await this.log('🏁 结算：好人获胜（无狼或连续3晚平安夜）');
      return true;
    }
    const setting=this.state.settings?.wolfWin || 'edge';
    if(setting==='exterminate'){
      const goodAlive=alive.some(p=>{
        const ar=this.activeRole(p);
        return ar && ROLES[ar]?.faction==='good';
      });
      if(!goodAlive){
        await this.to(PHASE.GAME_OVER, {'state/winner':'🐺 狼人屠城获胜'});
        await this.log('🏁 结算：狼人屠城');
        return true;
      }
    } else {
      const godAlive=alive.some(p=>p.identities.some(i=>GOD_ROLES.has(i.role)));
      const goldenAlive=alive.some(p=>this.golden(p));
      if(!godAlive || !goldenAlive){
        await this.to(PHASE.GAME_OVER, {'state/winner':'🐺 狼人屠边获胜'});
        await this.log('🏁 结算：狼人屠边');
        return true;
      }
    }
    return false;
  }

  /* ========== 日志 ========== */
  async log(msg,secret=false){
    await this.push('logs',{msg,ts:firebase.database.ServerValue.TIMESTAMP,round:this.state.round||0,secret});
  }
}

/* ==================== 4. 前端应用 ==================== */

const App={
  me:null, gameId:null, engine:null, unsub:[], full:null, selection:null, autorun:null,

  /* ---------- 启动 ---------- */
  init(){
    // 事件委托
    document.addEventListener('click', (e)=>this.onClick(e));

    const p=new URLSearchParams(location.search);
    this.gameId=p.get('game')||'';
    this.me = p.get('player')||'';

    if (!this.gameId || !this.me){
      // 渲染设置页
      this.renderSetup();
      return;
    }
    this.enterGame();
  },

  /* ---------- 设置页渲染 ---------- */
  renderSetup(){
    $('setup-view').classList.remove('hidden');
    $('game-view').classList.add('hidden');
    $('god-view').classList.add('hidden');

    // 角色网格
    const grid = $('role-grid');
    grid.innerHTML='';
    Object.keys(ROLES).forEach(role=>{
      const def = DEFAULT_SETUP[role] || 0;
      const item = el(`
        <div class="role-setup-item">
          <span class="role-name">${ROLES[role].icon} ${role}${ROLES[role].unique? '（唯一）':''}</span>
          <input id="role-${role}" type="number" min="0" step="1" value="${def}" style="width:80px" />
        </div>
      `);
      item.querySelector('input').addEventListener('input', ()=>this.updateSetupStats());
      grid.appendChild(item);
    });

    // 规则默认
    $('opt-witch-selfsave').value = 'noFirstNightSelfSave';
    $('opt-seer-mode').value = 'faction'; // 默认查阵营更稳
    $('opt-wolf-win').value = 'edge';
    $('opt-wolf-visibility').value = 'activeOnly';

    // 创建按钮绑定
    $('btn-create').setAttribute('data-action','create-game');

    // 初始统计
    this.updateSetupStats();
  },

  updateSetupStats(){
    const inputs = $('role-grid').querySelectorAll('input[type="number"]');
    let total=0;
    const conf={};
    inputs.forEach(i=>{
      const r=i.id.replace('role-','');
      let v = parseInt(i.value||'0',10); if (isNaN(v)||v<0) v=0;
      conf[r]=v; total += v;
    });
    const players = Math.floor(total/2);
    $('total-roles').textContent = String(total);
    $('player-cnt').textContent = String(players);
    const warn = $('player-count-warning');
    if (total===0 || total%2!==0) warn.textContent = '身份总数必须为偶数且大于 0';
    else warn.textContent = '';
  },

  /* ---------- 创建游戏 ---------- */
  async createGame(){
    const counts={};
    $('role-grid').querySelectorAll('input').forEach(i=>{
      const r=i.id.replace('role-',''); const v=+i.value||0; if(v) counts[r]=v;
    });
    const pool=[];
    for(const [r,c] of Object.entries(counts)){
      if(UNIQUE.has(r) && c>1){ this.toast(`${r} 只能 1 张`,'error'); return; }
      for(let i=0;i<c;i++) pool.push(r);
    }
    if(pool.length===0 || pool.length%2!==0){ this.toast('身份数必须为偶数且>0','error'); return; }

    // 发牌（尝试满足禁配 + 至少一名金宝宝）
    const dealt = this.dealWithGolden(pool);
    if(!dealt){ this.toast('配置非法：出现禁用组合或无法构造','error'); return; }

    const id = db.ref('games').push().key;
    const players={};
    dealt.pairs.forEach((pair,i)=>{
      players[i+1]={
        id:i+1,
        name:`玩家${i+1}`,
        identities:pair,
        deaths:0, isAlive:true, isReady:false,
        isExposedIdiot:false, badge:0, skill:{} // skill: { lastGuard, cureUsed, poisonUsed, knightUsed }
      };
    });

    const settings={
      witchRule: $('opt-witch-selfsave').value,
      seerMode: $('opt-seer-mode').value,
      wolfWin: $('opt-wolf-win').value,
      hiddenTrigger: $('opt-wolf-visibility').value
    };

    const init={
      meta:{ createdAt: now() },
      players, settings, actions:{}, logs:{},
      state:{ phase:PHASE.SETUP, round:0, host:1, peace:0, winner:null, sheriff:null }
    };
    await db.ref(`games/${id}`).set(init);
    this.toast('房间创建成功','success');
    // 跳转为 1 号主持
    location.href = `${location.pathname}?game=${id}&player=1`;
  },

  dealWithGolden(pool){
    // 基于 deal()，若无金宝宝，尝试微调
    for(let t=0;t<8000;t++){
      const d=shuffle([...pool]);
      let ok=true;
      const pairs=[];
      for(let i=0;i<d.length;i+=2){
        const a=d[i], b=d[i+1];
        const key=[a,b].sort().join('|');
        if(FORBID.has(key)){ ok=false; break; }
        if(a==='盗贼' && b==='盗贼'){ ok=false; break; }
        if(a==='盗贼') pairs.push([{role:b,isCopy:true},{role:b}]);
        else if(b==='盗贼') pairs.push([{role:a},{role:a,isCopy:true}]);
        else pairs.push([{role:a},{role:b}]);
      }
      if(!ok) continue;

      // 检查是否存在金宝宝（双平民，含盗贼复制为平民也算）
      const hasGolden = pairs.some(pr=>pr[0].role==='平民' && pr[1].role==='平民');
      if (hasGolden) return { pairs };

      // 若没有金宝宝，尝试从所有牌中找两个平民并塞给第一位（不破坏唯一约束）
      const flat = pairs.flat().map((id,i)=>({idx:i, role:id.role, isCopy: !!id.isCopy}));
      const civIdx = flat.filter(x=>x.role==='平民').map(x=>x.idx);
      if(civIdx.length>=2){
        // 把第0位玩家的两张改为平民（注意：不改变牌张总数，只是交换）
        const p0a = pairs[0][0], p0b = pairs[0][1];
        // 找到两个平民所在的 pair 与位置
        const aIdx=civIdx[0], bIdx=civIdx[1];
        const aiPair = Math.floor(aIdx/2), aiPos = aIdx%2;
        const biPair = Math.floor(bIdx/2), biPos = bIdx%2;
        // 交换到第0对
        const tmpA = pairs[aiPair][aiPos], tmpB = pairs[biPair][biPos];
        pairs[aiPair][aiPos] = p0a; pairs[biPair][biPos] = p0b;
        pairs[0][0] = {role:'平民'}; pairs[0][1] = {role:'平民'};
        return { pairs };
      }
      // 否则继续尝试下一次随机
    }
    return null;
  },

  /* ---------- 进入房间 ---------- */
  enterGame(){
    $('setup-view').classList.add('hidden');
    $('game-view').classList.remove('hidden');

    this.engine = new Engine(this.gameId);

    // 订阅渲染
    const root = db.ref(`games/${this.gameId}`);
    this.unsub.push(root.on('value', snap=>{
      const data = snap.val();
      if(!data) return;
      this.full = data;
      this.renderAll(data);
    }));

    // 主持端（1号）自动判定循环
    if (this.me === '1'){
      this.autorun && clearInterval(this.autorun);
      this.autorun = setInterval(()=>this.engine.tick().catch(()=>{}), 400);
    }
  },

  /* ---------- 渲染全局 ---------- */
  renderAll(data){
    // 状态条
    this.renderStatus(data.state);

    // 身份卡
    const me = data.players?.[this.me];
    if (me) this.renderIdentity(me, data);

    // 玩家左右列
    this.renderPlayers(data);

    // 操作面板
    this.renderActions(data);

    // 主持人控件
    this.renderHost(data);

    // 公共日志（按钮弹窗打开时再渲染）
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
      [PHASE.GAME_OVER]: this.full?.state?.winner || '游戏结束'
    };
    $('status-bar').innerHTML=`<span class="status-text">${map[st.phase]||''}</span>`;
  },

  renderIdentity(me, data){
    const fmt=id=>`<span class="identity-item"><span class="identity-icon">${ROLES[id.role].icon}</span><span class="identity-name${id.isCopy?' thief-copy-text':''}">${id.role}</span></span>`;
    const canSwap = data.state.phase===PHASE.SETUP && !me.isReady;
    $('identity-card').innerHTML=`
      <div class="identity-header">你的身份</div>
      <div class="identity-display">
        ${fmt(me.identities[0])}<span class="identity-separator">+</span>${fmt(me.identities[1])}
      </div>
      ${canSwap?`
        <div class="identity-actions">
          <button class="control-btn" data-action="swap">交换</button>
          <button class="confirm-btn" data-action="ready">确认</button>
        </div>`:''}
    `;

    // 持久信息（例如预言家查验结果、女巫药瓶状态）
    const persist = [];
    const ar = this.activeRole(me);
    if (ar==='女巫'){
      const usedCure = !!me.skill?.cureUsed;
      const usedPoison = !!me.skill?.poisonUsed;
      persist.push(`女巫药瓶：解药${usedCure?'已用完':'可用'}，毒药${usedPoison?'已用完':'可用'}`);
    }
    if (ar==='骑士'){
      persist.push(`骑士技能：${me.skill?.knightUsed ? '已使用' : '可使用'}`);
    }
    if (ar==='守卫'){
      if (me.skill?.lastGuard) persist.push(`上次守护：${me.skill.lastGuard}号`);
    }
    $('persist').classList.toggle('hidden', persist.length===0);
    $('persist').innerHTML = persist.map(s=>`<div>• ${escapeHtml(s)}</div>`).join('');
  },

  /* ---------- 玩家列表 ---------- */
  renderPlayers(data){
    const left=$('player-grid-left'), right=$('player-grid-right');
    left.innerHTML=''; right.innerHTML='';
    const players = Object.values(data.players||{}).sort((a,b)=>a.id-b.id);
    const mid = Math.ceil(players.length/2);
    const activatedHidden = this.engine?.hiddenActivated ? this.engine.hiddenActivated(data.players, data.state) : false;
    const my = data.players?.[this.me];

    // 狼可见策略
    const wolfVis = data.settings?.hiddenTrigger==='allWolves' ? 'allWolves' : 'activeOnly';
    const meIsWolf = my ? this.isWolfVisible(my, data, activatedHidden, wolfVis) : false;

    players.forEach(p=>{
      const card = this.renderPlayerCard(p, data, { meIsWolf, activatedHidden, wolfVis });
      (p.id<=mid ? left : right).appendChild(card);
    });
  },

  renderPlayerCard(p, data, ctx){
    const meId = Number(this.me);
    const isMe = p.id===meId;
    const hearts = (2-(p.deaths||0));
    const sheriff = p.badge? '⭐' : '';
    const hostMark = (data.state.host===p.id)?'👑':'';
    const numberHtml = `<span class="player-number">${p.id}${sheriff?` <span class="sheriff-icon">${sheriff}</span>`:''}${hostMark?` <span class="host-mark">${hostMark}</span>`:''}</span>`;

    // tag：狼队标（仅狼互见，策略控制）
    let tags=[];
    const showWolf = this.showWolfTag(p, data, ctx);
    if (showWolf) tags.push('<span class="tag tag-team">狼阵营</span>');
    if (p.isExposedIdiot) tags.push('<span class="tag tag-idiot">白痴翻牌</span>');

    const card = el(`
      <div class="player-card ${isMe?'me':''} ${!p.isAlive?'disabled':''}" data-pid="${p.id}">
        ${numberHtml}
        <div class="tagline">${tags.join('')}</div>
        <div class="hearts">
          <span class="heart ${hearts>=1?'':'off'}">❤</span>
          <span class="heart ${hearts>=2?'':'off'}">❤</span>
        </div>
      </div>
    `);

    // 目标选中效果
    if (this.selection && this.selection.pid===String(p.id)){
      card.classList.add('selected');
    }

    // 可点选目标
    card.addEventListener('click', ()=>{
      this.selection = { pid:String(p.id) };
      this.renderActions(this.full);
      this.renderPlayers(this.full);
    });

    return card;
  },

  isWolfVisible(player, data, activatedHidden, wolfVis){
    const ar = this.activeRole(player);
    if (wolfVis==='allWolves'){
      // 任何携带狼身份互见（隐狼是否激活不影响“能否互见”）
      return player.identities.some(i=>i.role==='狼人'||i.role==='隐狼');
    } else {
      // 仅可行动狼人互见（活跃=狼人；或活跃=隐狼且已激活）
      return ar==='狼人' || (ar==='隐狼' && activatedHidden);
    }
  },
  showWolfTag(p, data, ctx){
    const { meIsWolf, activatedHidden, wolfVis } = ctx;
    if (!meIsWolf) return false;
    return this.isWolfVisible(p, data, activatedHidden, wolfVis);
  },

  /* ---------- 操作面板 ---------- */
  renderActions(data){
    const panel = $('action-panel');
    panel.innerHTML='';
    const st = data.state;
    const me = data.players?.[this.me];
    if (!me) return;

    const phase = st.phase;

    // SETUP
    if (phase===PHASE.SETUP){
      const allReady = Object.values(data.players||{}).every(p=>p.isReady);
      panel.innerHTML = `<div class="action-feedback">${allReady?'全员已确认，等待主持开始游戏':'请确认你的身份并点击“确认”'}</div>`;
      return;
    }

    if (!me.isAlive && phase!==PHASE.BADGE) {
      panel.innerHTML = `<div class="action-feedback">你已出局，无法行动</div>`;
      return;
    }

    const ar = this.activeRole(me);

    // 夜晚
    if (phase===PHASE.NIGHT){
      const box = [];
      // 守卫
      if (ar==='守卫'){
        const last = me.skill?.lastGuard || null;
        box.push(`<div class="action-prompt">选择一名玩家进行守护（可空守；不可连续守同一人）</div>`);
        box.push(`<div class="action-buttons">
          <button class="control-btn" data-action="guard-null">空守</button>
          <button class="confirm-btn" data-action="guard-confirm">确认守护${this.selection?`：${this.selection.pid}号`:''}</button>
        </div>`);
        if (last) box.push(`<div class="action-target">上次守护：${last}号（本夜不可守）</div>`);
      }
      // 预言家
      if (ar==='预言家'){
        box.push(`<div class="action-prompt">选择一名玩家进行查验</div>`);
        box.push(`<div class="action-buttons">
          <button class="confirm-btn" data-action="seer-confirm">查验${this.selection?`：${this.selection.pid}号`:''}</button>
        </div>`);
        const res = this.getSeerResultForMe(data);
        if (res) box.push(`<div class="action-feedback">查验结果：${escapeHtml(res)}</div>`);
      }
      // 狼人/隐狼（按可见策略/激活）
      const activatedHidden = this.engine.hiddenActivated(data.players, data.state);
      const canWolfAct = (ar==='狼人') || (ar==='隐狼' && activatedHidden);
      if (canWolfAct){
        const wolf = data.actions?.[st.round]?.NIGHT?.WOLF || {};
        const myVote = wolf[this.me]?.target || '未投';
        const final = wolf?.final ?? undefined;
        const alphaId = this.getAlphaWolfId(data, activatedHidden);
        const isAlpha = String(alphaId)===String(this.me);
        box.push(`<div class="action-prompt">狼人阵营：投票并由拍板狼（最小号）确认目标</div>`);
        box.push(`<div class="action-target">我的投票：${myVote==='0'?'空刀':myVote}</div>`);
        box.push(`<div class="action-buttons">
          <button class="control-btn" data-action="wolf-vote">投票${this.selection?`：${this.selection.pid}号`:''}</button>
          <button class="control-btn" data-action="wolf-empty">投空刀</button>
          ${isAlpha?`<button class="confirm-btn" data-action="wolf-final">拍板${this.selection?`：${this.selection.pid}号`:''}</button>
          <button class="action-btn" data-action="wolf-final-empty">拍板空刀</button>`:''}
        </div>`);
        box.push(`<div class="action-feedback">当前拍板：${final===undefined?'未拍板':(final==='0'?'空刀':final+'号')}</div>`);
      }
      panel.innerHTML = box.join('');
      return;
    }

    // 女巫
    if (phase===PHASE.NIGHT_WITCH){
      if (ar!=='女巫'){
        panel.innerHTML = `<div class="action-feedback">等待女巫行动...</div>`;
        return;
      }
      const r=st.round;
      const a = data.actions?.[r]?.NIGHT_WITCH || {};
      const wolfFinal = data.actions?.[r]?.NIGHT?.WOLF?.final ?? undefined;
      const canSeeKnife = !me.skill?.cureUsed; // 失去解药后不能看刀口
      const knifeText = (wolfFinal && wolfFinal!=='0')? `${wolfFinal}号` : '空刀/未定';
      const usedCure = !!me.skill?.cureUsed;
      const usedPoison = !!me.skill?.poisonUsed;

      const firstNight = st.round===1;
      const rule = data.settings?.witchRule || 'noFirstNightSelfSave';
      let selfSaveAllowed = true;
      if (rule==='noFirstNightSelfSave' && firstNight) selfSaveAllowed=false;
      if (rule==='onlyFirstNightSelfSave' && !firstNight) selfSaveAllowed=false;

      const cureTgt = a.cure || null;
      const poisonTgt = a.poison || null;

      panel.innerHTML = `
        <div class="action-prompt">女巫行动</div>
        <div class="action-target">${canSeeKnife?`今晚刀口：${knifeText}`:`（解药已用，无法查看刀口）`}</div>
        <div class="witch-actions-container">
          <button class="control-btn" data-action="witch-cure" ${usedCure?'disabled':''}>${usedCure?'解药已用':'使用解药'}${this.selection?`：${this.selection.pid}号`:''}</button>
          <button class="action-btn" data-action="witch-poison" ${usedPoison?'disabled':''}>${usedPoison?'毒药已用':'使用毒药'}${this.selection?`：${this.selection.pid}号`:''}</button>
          <button class="confirm-btn" data-action="witch-done">结束夜药</button>
        </div>
        <div class="action-feedback">
          已选择：${cureTgt?`解药→${cureTgt}号`:'解药未用'}；${poisonTgt?`毒药→${poisonTgt}号`:'毒药未用'}
          ${selfSaveAllowed? '':'（当前规则：本夜不可自救）'}
        </div>
      `;
      return;
    }

    // 警长竞选
    if (phase===PHASE.SHERIFF_CAND){
      const up = data.state?.sheriff?.candidates?.[this.me] ? true : false;
      panel.innerHTML = `
        <div class="action-prompt">是否上警？</div>
        <div class="action-buttons">
          <button class="confirm-btn" data-action="sheriff-up">${up?'已上警':'上警'}</button>
          <button class="control-btn" data-action="sheriff-down">不上警</button>
        </div>
      `;
      return;
    }
    if (phase===PHASE.SHERIFF_SPEECH){
      const isCand = !!data.state?.sheriff?.candidates?.[this.me];
      if (isCand){
        panel.innerHTML = `
          <div class="action-prompt">上警发言中（你可以退水）</div>
          <div class="action-buttons">
            <button class="action-btn" data-action="sheriff-drop">退水</button>
          </div>
        `;
      } else {
        panel.innerHTML = `<div class="action-feedback">候选人发言中...</div>`;
      }
      return;
    }
    if (phase===PHASE.SHERIFF_VOTE){
      const candidates = data.state?.sheriff?.candidates||{};
      const drops = data.state?.sheriff?.drops||{};
      const valid = Object.keys(candidates).filter(id=>candidates[id] && !drops[id]);
      const listText = valid.length? valid.join('、') : '无';
      panel.innerHTML = `
        <div class="action-prompt">警长投票</div>
        <div class="action-target">候选人：${listText}</div>
        <div class="action-buttons">
          <button class="control-btn" data-action="sheriff-vote">投票${this.selection?`：${this.selection.pid}号`:''}</button>
          <button class="action-btn" data-action="sheriff-vote-abstain">弃票</button>
        </div>
      `;
      return;
    }

    // 白天发言 + 骑士
    if (phase===PHASE.DAY_TALK){
      const knightReady = (ar==='骑士') && !me.skill?.knightUsed;
      panel.innerHTML = `
        <div class="action-feedback">白天发言进行中${knightReady?'，你可以发动“决斗”':''}</div>
        ${knightReady?`
          <div class="action-buttons">
            <button class="action-btn" data-action="knight-duel">决斗${this.selection?`：${this.selection.pid}号`:''}</button>
          </div>`:''}
      `;
      return;
    }

    // 放逐投票
    if (phase===PHASE.DAY_VOTE){
      if (me.isExposedIdiot){
        panel.innerHTML = `<div class="action-feedback">你是已翻牌白痴，已失去投票权</div>`;
        return;
      }
      panel.innerHTML = `
        <div class="action-prompt">放逐投票</div>
        <div class="action-buttons">
          <button class="confirm-btn" data-action="day-vote">投票${this.selection?`：${this.selection.pid}号`:''}</button>
          <button class="control-btn" data-action="day-vote-abstain">弃票</button>
        </div>
      `;
      return;
    }

    // 猎人开枪
    if (phase===PHASE.HUNTER){
      const q = data.state?.hunters||{};
      const list = Object.keys(q).filter(k=>q[k]);
      const myTurn = list[0]===String(this.me);
      panel.innerHTML = `
        <div class="action-prompt">猎人开枪${myTurn?'（轮到你）':''}</div>
        ${myTurn?`
        <div class="action-buttons">
          <button class="action-btn" data-action="hunter-shoot">开枪${this.selection?`：${this.selection.pid}号`:''}</button>
        </div>`:'<div class="action-feedback">等待猎人行动...</div>'}
      `;
      return;
    }

    // 警徽移交
    if (phase===PHASE.BADGE){
      const post = data.state?.postBadge||{};
      const isDeadSheriff = String(post?.dead)===String(this.me);
      panel.innerHTML = `
        <div class="action-prompt">警徽移交</div>
        ${isDeadSheriff?`
          <div class="action-buttons">
            <button class="confirm-btn" data-action="badge-pass">移交${this.selection?`：${this.selection.pid}号`:''}</button>
            <button class="action-btn" data-action="badge-destroy">撕毁</button>
          </div>
        `:'<div class="action-feedback">等待警长移交警徽...</div>'}
      `;
      return;
    }

    // 结束
    if (phase===PHASE.GAME_OVER){
      panel.innerHTML = `<div class="action-feedback">${data.state.winner||'游戏结束'}</div>`;
      return;
    }
  },

  /* ---------- 主持控件 ---------- */
  renderHost(data){
    const host = $('host-controls');
    const isHost = String(data.state?.host||'1')===String(this.me);
    host.classList.toggle('hidden', !isHost);
    if (!isHost){ host.innerHTML=''; return; }

    const st = data.state;
    let html = `<div class="host-panel">`;

    if (st.phase===PHASE.SETUP){
      const allReady = Object.values(data.players||{}).every(p=>p.isReady);
      html+=`<div class="host-status-title">主持控制</div>
      <div class="host-actions">
        <button class="btn-primary" data-action="host-start" ${allReady?'':'disabled'}>开始游戏（N1）</button>
      </div>`;
    }

    if (st.phase===PHASE.SHERIFF_CAND){
      html+=`<div class="host-status-title">警长竞选</div>
      <div class="host-actions">
        <button class="btn-primary" data-action="host-speech">进入上警发言</button>
        <button class="btn-primary" data-action="host-sheriff-vote">进入警长投票</button>
        <button class="control-btn" data-action="host-skip-sheriff">跳过竞选</button>
      </div>`;
    }
    if (st.phase===PHASE.SHERIFF_SPEECH){
      html+=`<div class="host-status-title">警长发言</div>
      <div class="host-actions">
        <button class="btn-primary" data-action="host-sheriff-vote">进入警长投票</button>
      </div>`;
    }
    if (st.phase===PHASE.DAY_TALK){
      html+=`<div class="host-status-title">白天</div>
      <div class="host-actions">
        <button class="btn-primary" data-action="host-day-vote">开启放逐投票</button>
        <button class="control-btn" data-action="host-skip-day">直接入夜</button>
      </div>`;
    }

    html+=`</div>`;
    host.innerHTML = html;
  },

  /* ---------- 点击事件 ---------- */
  async onClick(e){
    const a = e.target.closest('[data-action]');
    if (!a) return;
    const act = a.dataset.action;

    // SETUP
    if (act==='create-game') return this.createGame();
    if (!this.full){ return; }

    // 顶部按钮
    if (act==='open-logs'){ return this.openLogs(); }
    if (act==='close-modal'){ return this.closeModal(a.dataset.target); }

    // 身份按钮
    if (act==='swap'){
      const me = this.full.players?.[this.me];
      if (!me || me.isReady || this.full.state.phase!==PHASE.SETUP) return;
      const ids=[...me.identities].reverse();
      await db.ref(`games/${this.gameId}/players/${this.me}/identities`).set(ids);
      return;
    }
    if (act==='ready'){
      await db.ref(`games/${this.gameId}/players/${this.me}/isReady`).set(true);
      return;
    }

    // 主持控制
    if (act==='host-start'){
      // 进入 N1
      await db.ref(`games/${this.gameId}/state`).update({ phase:PHASE.NIGHT, round:1, peace:0, showWolf:true });
      await db.ref(`games/${this.gameId}/actions`).set({});
      await this.engine.log('游戏开始，进入第一夜');
      return;
    }
    if (act==='host-speech'){
      await db.ref(`games/${this.gameId}/state/phase`).set(PHASE.SHERIFF_SPEECH);
      return;
    }
    if (act==='host-sheriff-vote'){
      await db.ref(`games/${this.gameId}/state/phase`).set(PHASE.SHERIFF_VOTE);
      return;
    }
    if (act==='host-skip-sheriff'){
      await db.ref(`games/${this.gameId}/state`).update({ sheriff:null, phase:PHASE.DAY_TALK });
      await this.engine.log('本局无警长');
      return;
    }
    if (act==='host-day-vote'){
      await db.ref(`games/${this.gameId}/state/phase`).set(PHASE.DAY_VOTE);
      return;
    }
    if (act==='host-skip-day'){
      await this.engine.startNight((this.full.state?.round||0)+1);
      return;
    }

    // 目标选择相关（通过点卡片已经赋值 this.selection）

    // 夜晚：守卫
    if (act==='guard-null'){
      const r=this.full.state.round;
      // 空守：target=null
      await db.ref(`games/${this.gameId}/actions/${r}/NIGHT/GUARD/${this.me}`).set({ target:null, ts:now() });
      await this.toast('守卫：空守已提交','info');
      return;
    }
    if (act==='guard-confirm'){
      if (!this.selection){ this.toast('请选择要守护的目标','error'); return; }
      const r=this.full.state.round;
      const me = this.full.players?.[this.me];
      if(me?.skill?.lastGuard && String(me.skill.lastGuard)===this.selection.pid){
        this.toast('不能连续两晚守同一人','error'); return;
      }
      await db.ref(`games/${this.gameId}/actions/${r}/NIGHT/GUARD/${this.me}`).set({ target:this.selection.pid, ts:now() });
      await db.ref(`games/${this.gameId}/players/${this.me}/skill/lastGuard`).set(this.selection.pid);
      this.toast(`守卫：守护${this.selection.pid}号已提交`,'success');
      return;
    }

    // 夜晚：预言家
    if (act==='seer-confirm'){
      if (!this.selection){ this.toast('请选择查验目标','error'); return; }
      const r=this.full.state.round;
      // 写入 SEER 记录（包含结果，供自己查看；无安全考虑）
      const res = this.computeSeerResult(this.full, this.selection.pid);
      await db.ref(`games/${this.gameId}/actions/${r}/NIGHT/SEER/${this.me}`).set({ target:this.selection.pid, result: res, ts:now() });
      this.toast(`预言家：已查验 ${this.selection.pid}号`,'success');
      return;
    }

    // 夜晚：狼人
    if (act==='wolf-vote'){
      if (!this.selection){ this.toast('请选择刀口','error'); return; }
      const r=this.full.state.round;
      await db.ref(`games/${this.gameId}/actions/${r}/NIGHT/WOLF/${this.me}`).set({ target:this.selection.pid, ts:now() });
      this.toast(`狼人投票：${this.selection.pid}号`,'success');
      return;
    }
    if (act==='wolf-empty'){
      const r=this.full.state.round;
      await db.ref(`games/${this.gameId}/actions/${r}/NIGHT/WOLF/${this.me}`).set({ target:'0', ts:now() });
      this.toast('狼人投票：空刀','info');
      return;
    }
    if (act==='wolf-final'){
      if (!this.selection){ this.toast('请先选择拍板目标','error'); return; }
      const r=this.full.state.round;
      await db.ref(`games/${this.gameId}/actions/${r}/NIGHT/WOLF/final`).set(this.selection.pid);
      await this.engine.log(`🐺 拍板：${this.selection.pid}号`);
      return;
    }
    if (act==='wolf-final-empty'){
      const r=this.full.state.round;
      await db.ref(`games/${this.gameId}/actions/${r}/NIGHT/WOLF/final`).set('0');
      await this.engine.log(`🐺 拍板：空刀`);
      return;
    }

    // 女巫
    if (act==='witch-cure'){
      if (!this.selection){ this.toast('请选择要救的人','error'); return; }
      const me = this.full.players?.[this.me];
      if (me?.skill?.cureUsed){ this.toast('解药已用完','error'); return; }
      const firstNight = this.full.state.round===1;
      const rule = this.full.settings?.witchRule || 'noFirstNightSelfSave';
      const selfSaveAllowed = (rule==='onlyFirstNightSelfSave') ? firstNight : (rule!=='noFirstNightSelfSave' || !firstNight);
      if (!selfSaveAllowed && String(this.selection.pid)===String(this.me)){
        this.toast('当前规则：首夜不可自救','error'); return;
      }
      const r=this.full.state.round;
      await db.ref(`games/${this.gameId}/actions/${r}/NIGHT_WITCH/cure`).set(this.selection.pid);
      await db.ref(`games/${this.gameId}/players/${this.me}/skill/cureUsed`).set(true);
      this.toast(`女巫解药：救 ${this.selection.pid}号`,'success');
      return;
    }
    if (act==='witch-poison'){
      if (!this.selection){ this.toast('请选择要毒的人','error'); return; }
      const me = this.full.players?.[this.me];
      if (me?.skill?.poisonUsed){ this.toast('毒药已用完','error'); return; }
      const r=this.full.state.round;
      await db.ref(`games/${this.gameId}/actions/${r}/NIGHT_WITCH/poison`).set(this.selection.pid);
      await db.ref(`games/${this.gameId}/players/${this.me}/skill/poisonUsed`).set(true);
      this.toast(`女巫毒药：毒 ${this.selection.pid}号`,'success');
      return;
    }
    if (act==='witch-done'){
      const r=this.full.state.round;
      await db.ref(`games/${this.gameId}/actions/${r}/NIGHT_WITCH/done`).set(true);
      this.toast('女巫操作结束','info');
      return;
    }

    // 警长
    if (act==='sheriff-up'){
      const obj = this.full.state?.sheriff?.candidates||{};
      obj[this.me]=1;
      await db.ref(`games/${this.gameId}/state/sheriff/candidates`).set(obj);
      return;
    }
    if (act==='sheriff-down'){
      const obj = this.full.state?.sheriff?.candidates||{};
      delete obj[this.me];
      await db.ref(`games/${this.gameId}/state/sheriff/candidates`).set(obj);
      return;
    }
    if (act==='sheriff-drop'){
      const drops=this.full.state?.sheriff?.drops||{};
      drops[this.me]=1;
      await db.ref(`games/${this.gameId}/state/sheriff/drops`).set(drops);
      return;
    }
    if (act==='sheriff-vote'){
      if (!this.selection){ this.toast('请选择候选人','error'); return; }
      const r=this.full.state.round;
      await db.ref(`games/${this.gameId}/state/sheriff/votes/${this.me}`).set(this.selection.pid);
      this.toast('已提交警长投票','success');
      return;
    }
    if (act==='sheriff-vote-abstain'){
      const r=this.full.state.round;
      await db.ref(`games/${this.gameId}/state/sheriff/votes/${this.me}`).set('0');
      this.toast('已弃票','info');
      return;
    }

    // 骑士
    if (act==='knight-duel'){
      if (!this.selection){ this.toast('请选择决斗目标','error'); return; }
      await this.engine.duel(this.me, this.selection.pid);
      return;
    }

    // 放逐投票
    if (act==='day-vote'){
      if (!this.selection){ this.toast('请选择要投的玩家','error'); return; }
      const r=this.full.state.round;
      await db.ref(`games/${this.gameId}/actions/${r}/DAY_VOTE/${this.me}`).set({ target:this.selection.pid, ts:now() });
      this.toast('投票已提交','success');
      return;
    }
    if (act==='day-vote-abstain'){
      const r=this.full.state.round;
      await db.ref(`games/${this.gameId}/actions/${r}/DAY_VOTE/${this.me}`).set({ target:'0', ts:now() });
      this.toast('已弃票','info');
      return;
    }

    // 猎人
    if (act==='hunter-shoot'){
      if (!this.selection){ this.toast('请选择开枪目标','error'); return; }
      const q = this.full.state?.hunters||{};
      const list = Object.keys(q).filter(k=>q[k]);
      if (list[0]!==String(this.me)){ this.toast('尚未轮到你开枪','error'); return; }
      // 执行击杀并出队
      await this.engine.kill(this.selection.pid, 'DUEL'); // 猎人开枪的 cause 不影响后续；此处不再派生
      const nq = {...q}; delete nq[list[0]];
      await db.ref(`games/${this.gameId}/state/hunters`).set(Object.keys(nq).length?nq:null);
      // 若队列为空，回归 nextPhaseAfterHunter 或 DAY_TALK
      if (!Object.keys(nq).length){
        const np = this.full.state?.nextPhaseAfterHunter || PHASE.DAY_TALK;
        await db.ref(`games/${this.gameId}/state`).update({ phase: np, nextPhaseAfterHunter: null });
      }
      return;
    }

    // 警徽移交
    if (act==='badge-pass'){
      if (!this.selection){ this.toast('请选择移交对象','error'); return; }
      const post = this.full.state?.postBadge||{};
      // 移交
      const up={};
      // 移除死者的徽章
      up[`players/${post.dead}/badge`] = 0;
      // 赋予新目标徽章
      up[`players/${this.selection.pid}/badge`] = 1;
      // 清理并回到下一相
      await db.ref(`games/${this.gameId}`).update(up);
      await db.ref(`games/${this.gameId}/state`).update({ phase: post.next||PHASE.DAY_TALK, postBadge:null });
      await this.engine.log(`⭐ 警徽移交给 ${this.selection.pid}号`);
      return;
    }
    if (act==='badge-destroy'){
      const post = this.full.state?.postBadge||{};
      const up={};
      up[`players/${post.dead}/badge`] = 0;
      await db.ref(`games/${this.gameId}`).update(up);
      await db.ref(`games/${this.gameId}/state`).update({ phase: post.next||PHASE.DAY_TALK, postBadge:null });
      await this.engine.log(`🗑️ 警徽被撕毁`);
      return;
    }
  },

  /* ---------- 辅助：预言家查验 ---------- */
  computeSeerResult(data, targetPid){
    const settings = data.settings||{};
    const mode = settings.seerMode || 'faction'; // faction | identity
    const target = data.players?.[targetPid];
    if (!target) return '';
    const activatedHidden = this.engine.hiddenActivated(data.players, data.state);
    if (mode==='identity'){
      // 返回当前活跃身份（隐狼未激活时 -> 其好人身份）
      const role = this.activeRole(target);
      if (role==='隐狼' && !activatedHidden){
        // 未激活时看作其当前好人身份 —— 这里“活跃身份”就是隐狼（好人?），规则：若隐狼未激活，查“身份模式”返回好人身份
        // 实现：若隐狼未激活，则返回“平民阵营中伪装的身份名”，为简化：显示“好人身份”
        // 但更严谨：隐狼牌本身就是“隐狼”（但规则要求未激活时显示其当前好人身份）
        // 由于我们没有记录“隐狼的另一张好人身份”在前/后，这里采用：若活跃为隐狼且未激活 → 返回“平民（潜伏）”
        return '平民（潜伏）';
      }
      return role;
    } else {
      // 阵营：任一身份为“狼人” → 狼人阵营；隐狼未激活 → 好人阵营；激活后 → 狼人阵营
      const hasWolfCard = target.identities.some(i=>i.role==='狼人');
      const hasInvisible = target.identities.some(i=>i.role==='隐狼');
      const wolfFaction = hasWolfCard || (hasInvisible && activatedHidden);
      return wolfFaction ? '狼人阵营' : '好人阵营';
    }
  },
  getSeerResultForMe(data){
    const r=data.state.round;
    const rec=data.actions?.[r]?.NIGHT?.SEER?.[this.me];
    return rec?.result || '';
    },
  getAlphaWolfId(data, activatedHidden){
    const alive = Object.values(data.players||{}).filter(p=>p.isAlive);
    const wolves = alive.filter(p=>{
      const ar = this.activeRole(p);
      return ar==='狼人' || (ar==='隐狼' && activatedHidden);
    }).map(p=>p.id);
    if (wolves.length===0) return null;
    return Math.min(...wolves);
  },

  /* ---------- 顶部：日志 ---------- */
  openLogs(){
    const logs = Object.values(this.full.logs||{}).sort((a,b)=>a.ts-b.ts);
    const box = $('game-log-content');
    box.innerHTML = logs.map(l=>`<div class="log-item"><span class="log-round">[${l.round??0}]</span> ${escapeHtml(l.msg)}</div>`).join('') || '<div class="log-item">暂无日志</div>';
    const modal=$('logs-modal'); modal.classList.add('open');
  },
  closeModal(id){
    const m = id ? document.getElementById(id) : document.querySelector('.modal.open');
    if (m) m.classList.remove('open');
  },

  /* ---------- 工具 ---------- */
  toast(txt,type='info'){
    const n=document.createElement('div');n.className=`notification ${type}`;n.innerText=txt;
    $('notification-container').appendChild(n);setTimeout(()=>n.remove(),2500);
  },
  activeRole(p){
    const idx = Math.min(p.deaths||0,1);
    return p.identities[idx]?.role || null;
  },

  /* ---------- 清理 ---------- */
  destroy(){
    this.unsub.forEach(u=>u&&u.off&&u.off());
    if (this.autorun) clearInterval(this.autorun);
  }
};

/* ==================== 5. 绑定 ==================== */

document.addEventListener('DOMContentLoaded', ()=>App.init());
