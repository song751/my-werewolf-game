/* ========================================
   双身份狼人杀 - App (FSM 精简版 · 自动化修正版)
   作者注记：
   - 夜晚并行动：守卫/预言家/狼人 同在 PHASE.NIGHT 行动，仅女巫在 PHASE.NIGHT_WITCH。
   - 流程尽量自动：除发言阶段需主持开启投票外，其余能自动推进的都自动推进；同时保留主持人的强制操作。
   - 警长移交：仅当玩家“真正出局”（两条命都没了，isAlive=false）时触发移交，不因白痴翻牌触发。
   - 队友可见：settings.wolfVisibility = 'activeOnly' | 'allWolves'，并且仅当 state.showWolfTags=true（首夜开始时）才显示队友角标。
   - 胜负判定：三连平安夜或狼人阵营全灭→好人胜；狼人胜按设置：
       * 屠边：神职全死 或 金宝宝全死
       * 屠城：所有好人全死
   - 重开：沿用 setupCounts 与 settings 重新发牌，回到 SETUP（允许玩家再调换身份顺序），不直接进入第一夜。
   - UI 徽标：玩家卡显示 👑(主持) 与 ⭐(警长) 角标；标题旁不再依赖这些徽标（HTML/CSS 后续提供）。
   ======================================== */

/* Firebase 配置 */
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

/* 角色与配置 */
const ROLES = {
  '平民':   { faction: 'good', isGod: false, icon: '👤' },
  '守卫':   { faction: 'good', isGod: true,  icon: '🛡️' },
  '白痴':   { faction: 'good', isGod: true,  icon: '🤪' },
  '预言家': { faction: 'good', isGod: true,  icon: '🔮' },
  '骑士':   { faction: 'good', isGod: true,  icon: '⚔️' },
  '女巫':   { faction: 'good', isGod: true,  icon: '🧪' },
  '猎人':   { faction: 'good', isGod: true,  icon: '🔫' },
  '狼人':   { faction: 'bad',  isGod: false, icon: '🐺' },
  '隐狼':   { faction: 'bad',  isGod: false, icon: '🌑', isInvisible: true },
  '盗贼':   { faction: 'neutral', isGod: false, isThief: true, icon: '🎭' },
};
const GOD_ROLES = new Set(['守卫','白痴','预言家','骑士','女巫','猎人']);
const DEFAULT_SETUP = { '平民': 6, '守卫': 1, '白痴': 1, '预言家': 1, '骑士': 1, '女巫': 1, '猎人': 1, '狼人': 2, '隐狼': 1, '盗贼': 1 };
const UNIQUE_ROLES = new Set(['盗贼','白痴','猎人','女巫','预言家','守卫','骑士']);
const FORBIDDEN_PAIR = new Set([
  '狼人|隐狼', '预言家|狼人', '预言家|隐狼',
  '盗贼|狼人', '盗贼|隐狼'
]);

/* 状态机阶段（并行动：NIGHT -> NIGHT_WITCH -> DAWN_RESOLVE） */
const PHASE = {
  SETUP: 'SETUP',
  NIGHT: 'NIGHT',
  NIGHT_WITCH: 'NIGHT_WITCH',
  DAWN_RESOLVE: 'DAWN_RESOLVE',
  DAY_TALK: 'DAY_TALK',
  DAY_VOTE: 'DAY_VOTE',
  SHERIFF_CAND: 'SHERIFF_CAND',
  SHERIFF_SPEECH: 'SHERIFF_SPEECH',
  SHERIFF_VOTE: 'SHERIFF_VOTE',
  HUNTER_ACTION: 'HUNTER_ACTION',
  SHERIFF_TRANSFER: 'SHERIFF_TRANSFER',
  GAME_OVER: 'GAME_OVER',
};

const App = {
  gameId: null,
  playerId: null,   // '0' = 上帝视角
  isHost: false,

  state: null,
  settings: null,
  setupCounts: null,  // 保存创建时的身份配置，供重开使用
  players: {},
  actions: {},
  sheriff: null,
  full: null,

  selection: null,
  wolfVotesOff: null,
  wolfChatOff: null,

  /* ---------- 通用工具 ---------- */
  $(id){ return document.getElementById(id) },
  escapeHTML(s){ return typeof s==='string' ? s.replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])) : '' },
  notify(msg,type='info',ms=3200){
    const c=this.$('notification-container'); if(!c) return;
    const n=document.createElement('div'); n.className=`notification ${type}`;
    n.innerHTML=`<div class="notification-content">${this.escapeHTML(msg)}</div>`;
    c.appendChild(n); setTimeout(()=>n.classList.add('show'),10);
    setTimeout(()=>{ n.classList.add('fade-out'); setTimeout(()=>n.remove(),260) },ms);
  },
  async log(message,isSecret=false){
    const entry={ message, round:this.state?.round||0, timestamp:firebase.database.ServerValue.TIMESTAMP, isSecret };
    await db.ref(`games/${this.gameId}/logs`).push(entry);
  },
  shuffle(a){ let i=a.length, r; while(i){ r=Math.floor(Math.random()*i--); [a[i],a[r]]=[a[r],a[i]] } return a; },

  /* ---------- 初始化与路由 ---------- */
  init(){
    const p=new URLSearchParams(location.search);
    this.gameId=p.get('game'); this.playerId=p.get('player');
    document.addEventListener('click', this.onClick.bind(this));

    if(this.gameId && this.playerId){
      this.startApp();
    }else{
      this.showView('setup');
      this.renderRoleSetup();
    }
  },
  showView(name){
    ['setup','game','god'].forEach(v=>{
      const el=this.$(`${v}-view`); if(!el) return;
      el.classList.add('hidden'); el.classList.remove('view-active');
    });
    const tgt=this.$(`${name}-view`); if(tgt){ tgt.classList.remove('hidden'); setTimeout(()=>tgt.classList.add('view-active'),10); }
  },

  /* ---------- 事件分发 ---------- */
  async onClick(e){
    const btn=e.target.closest('button[data-action]'); if(!btn) return;
    const act=btn.dataset.action;

    // 公共
    if(act==='open-logs'){ this.openModal('logs-modal'); return; }
    if(act==='close-modal'){ this.closeModal(btn.dataset.target); return; }
    if(act==='copy-link'){ const el=this.$(btn.dataset.inputid); if(!el) return;
      try{ await navigator.clipboard.writeText(el.value); }catch{ el.select(); document.execCommand('copy'); }
      this.notify('链接已复制','success'); return; }

    switch(act){
      /* 创建/进入 */
      case 'create-game': await this.createGame(); return;
      case 'join-as-creator': {
        const gid=btn.dataset.gameid||btn.getAttribute('value'); if(!gid) return this.notify('未获取到游戏ID','error');
        this.gameId=gid; this.playerId='1'; history.pushState(null,'',`?game=${gid}&player=1`); this.startApp(); return;
      }

      /* 主持人操作（尽量自动，但保留强制项） */
      case 'host-start': if(!this.isHost) return; await this.hostStart(); return;             // 正常开始（从 SETUP -> NIGHT，round=1）
      case 'host-force-start': if(!this.isHost) return; await this.hostForceStartGame(); return; // 强制开始（未确认者按当前顺序）
      case 'host-force-sunrise': if(!this.isHost) return; await this.hostForceSunrise(); return; // 强制天亮（夜晚->结算）
      case 'host-open-sheriff-vote': if(!this.isHost) return; await this.setPhase(PHASE.SHERIFF_VOTE); return;
      case 'host-open-day-vote': if(!this.isHost) return; await this.setPhase(PHASE.DAY_VOTE); return;
      case 'host-force-end-dayvote': if(!this.isHost) return; await this.hostForceEndDayVote(); return;
      case 'host-force-end-sheriffvote': if(!this.isHost) return; await this.hostForceEndSheriffVote(); return;
      case 'host-force-start-sheriff': if(!this.isHost) return; await this.setPhase(PHASE.SHERIFF_CAND); return;
      case 'host-restart': if(!this.isHost) return; await this.hostRestart(); return;

      /* 身份确认 */
      case 'swap-identities': await this.swapIdentities(); return;
      case 'confirm-identities': await this.setPlayerReady(true); return;

      /* 行动类（夜/日） */
      case 'confirm-selection': await this.confirmSelection(); return;
      case 'skip-selection': await this.skipSelection(); return;
      case 'wolf-send': this.sendWolfMessage(); return;
      case 'wolf-confirm': await this.wolfConfirm(btn.dataset.value); return;
      case 'witch-cure': await this.witchCure(btn.dataset.target); return;

      /* 上警流程 */
      case 'sheriff-cand': await this.sheriffCand(+btn.dataset.value); return;
      case 'sheriff-drop': await this.sheriffDrop(); return;

      /* 警徽移交 */
      case 'badge-pass': await this.badgePass(btn.dataset.to); return;
      case 'badge-destroy': await this.badgeDestroy(); return;
    }
  },

  /* ---------- 模态框 ---------- */
  openModal(id){ const m=this.$(id); if(!m) return; m.classList.add('open'); m.querySelector('.modal-overlay')?.addEventListener('click',()=>this.closeModal(id),{once:true}); },
  closeModal(id){ const m=this.$(id); if(!m) return; m.classList.remove('open'); },

  /* ---------- 主订阅 ---------- */
  async startApp(){
    const s=await db.ref(`games/${this.gameId}`).once('value');
    if(!s.exists()){
      document.body.innerHTML = `<div style="text-align:center; margin-top: 100px;">
        <div style="font-size:48px;">😵</div><h2>游戏不存在</h2>
        <p>房间已关闭或链接无效</p>
        <button onclick="location.href='?'" class="btn-primary" style="margin-top:20px;">返回首页</button></div>`;
      return;
    }
    if(this.playerId==='0') this.showView('god'); else this.showView('game');

    db.ref(`games/${this.gameId}`).on('value', snap=>{
      if(!snap.exists()) return;
      this.full = snap.val();
      this.state = this.full.state || {};
      this.players = this.full.players || {};
      this.actions = this.full.actions || {};
      this.sheriff = this.full.sheriff || null;
      this.settings = this.full.settings || { witchSelfSaveRule:'noFirstNightSelfSave', seerMode:'faction', wolfWin:'edge', wolfVisibility:'activeOnly' };
      this.setupCounts = this.full.setupCounts || null;

      if(this.playerId!=='0'){
        const me=this.players[this.playerId];
        if(!me){
          document.body.innerHTML = `<div style="text-align:center; margin-top: 100px;">
            <div style="font-size:48px;">❌</div><h2>无法加入游戏</h2>
            <p>你不是该房间的玩家或已被移除</p>
            <button onclick="location.href='?'" class="btn-primary" style="margin-top:20px;">返回首页</button></div>`;
          return;
        }
        this.isHost = Number(this.playerId) === Number(this.state.hostId);
        this.renderAll();
        this.refreshWolfListeners();
      }else{
        this.renderGod();
      }
      // 玩家侧公开日志
      this.renderLogsLive();

      // 自动推进（仅主持端执行，避免多端同时推进）
      if(this.isHost) this.autoAdvance();
    });
  },

  /* ---------- 渲染 ---------- */
  renderAll(){
    // 顶部徽章改为不依赖（HTML 后续清理），此处不再切换
    this.renderStatus();
    this.renderIdentityCard();
    this.renderPersistentInfo();
    this.renderActionPanel();
    this.renderPlayerGrid();
    this.renderHostPanel();
  },
  renderStatus(){
    const r=this.state.round||0;
    const map={
      [PHASE.SETUP]: '⏳ 等待所有玩家确认身份',
      [PHASE.NIGHT]: `🌙 第 ${r} 夜 · 夜间行动`,
      [PHASE.NIGHT_WITCH]: `🌙 第 ${r} 夜 · 女巫行动`,
      [PHASE.DAWN_RESOLVE]:'🌤️ 天亮结算中',
      [PHASE.DAY_TALK]:    `☀️ 第 ${r} 天 · 发言中`,
      [PHASE.DAY_VOTE]:    `☀️ 第 ${r} 天 · 放逐投票`,
      [PHASE.SHERIFF_CAND]:'👮 上警意向',
      [PHASE.SHERIFF_SPEECH]:'👮 上警发言/退水',
      [PHASE.SHERIFF_VOTE]:'👮 警长投票',
      [PHASE.HUNTER_ACTION]:'🔫 猎人行动',
      [PHASE.SHERIFF_TRANSFER]:'⭐ 警徽移交',
      [PHASE.GAME_OVER]: this.state.winner || '🏁 游戏结束'
    };
    const el=this.$('status-bar'); if(el) el.innerHTML = `<span class="status-text">${map[this.state.phase]||'进行中'}</span>`;
  },
  renderIdentityCard(){
    if(this.playerId==='0') return;
    const p=this.players[this.playerId]; if(!p) return;
    const fmt=(id)=> id.isThiefCopy
      ? `<span class="identity-item"><span class="identity-icon">🎭</span><span class="identity-name thief-copy-text">${id.role}</span></span>`
      : `<span class="identity-item"><span class="identity-icon">${ROLES[id.role].icon}</span><span class="identity-name">${id.role}</span></span>`;
    const wrapDead = (idx)=> p.deaths>idx ? 'identity-dead' : '';
    let html = `
      <div class="identity-header">你的身份</div>
      <div class="identity-display">
        <span class="${wrapDead(0)}">${fmt(p.identities[0])}</span>
        <span class="identity-separator">+</span>
        <span class="${wrapDead(1)}">${fmt(p.identities[1])}</span>
      </div>`;
    if(this.state.phase===PHASE.SETUP && !p.isReady){
      html += `<div class="identity-actions">
        <button class="control-btn" data-action="swap-identities">🔄 交换身份</button>
        <button class="confirm-btn" data-action="confirm-identities">✓ 确认身份</button>
      </div>`;
    }else if(this.state.phase===PHASE.SETUP && p.isReady){
      html += `<div class="action-feedback">已确认，请等待主持人开始</div>`;
    }
    const el=this.$('identity-card'); if(el) el.innerHTML=html;
  },
  renderPersistentInfo(){
    // 仅示例：预言家历史
    if(this.playerId==='0'){ const el=this.$('persist'); if(el) el.classList.add('hidden'); return; }
    const me=this.players[this.playerId]; const el=this.$('persist'); if(!el) return;
    let html='';
    if(this.getActiveRole(me)==='预言家'){
      const rec=(me.skillStates||{})['global_seerResults']||{};
      const mode=this.settings.seerMode||'faction';
      const keys=Object.keys(rec);
      if(keys.length){
        html+=`<div class="seer-results">
          <div class="seer-title">🔮 查验记录 (${mode==='faction'?'阵营':'身份'})</div>
          <div class="seer-list">${keys.map(k=>`<span class="seer-item">${k}号: <strong>${this.escapeHTML(rec[k])}</strong></span>`).join(' ')}</div>
        </div>`;
      }
    }
    el.innerHTML=html; el.classList.toggle('hidden', !html);
  },
  renderPlayerGrid(){
    const L=this.$('player-grid-left'), R=this.$('player-grid-right'); if(!L||!R) return;
    L.innerHTML=''; R.innerHTML='';
    const arr=Object.values(this.players).sort((a,b)=>a.id-b.id);
    const half=Math.ceil(arr.length/2);

    // 狼阶段信息（仅普通狼可见投票角标）
    const viewerWolfType=this.getViewerWolfType();
    const round=this.state.round||0;
    const wolfNode=((this.actions[round]||{}).NIGHT||{}).WOLVES||{};
    const alphaTarget=wolfNode.alphaTarget||null;
    const votes=wolfNode.votes||{};
    const showWolfBadges = viewerWolfType==='regular' && this.state.phase===PHASE.NIGHT;

    const canSeeTeammate = (p)=>{
      if(!this.state.showWolfTags) return false;
      const vis=this.settings.wolfVisibility||'activeOnly';
      const viewer=this.players[this.playerId]; if(!viewer) return false;
      const viewerActive=this.getActiveRole(viewer);
      const targetActive=this.getActiveRole(p);
      const hasWolf=(pl)=> (pl.identities||[]).some(x=>x.role==='狼人'||x.role==='隐狼');
      if(vis==='activeOnly'){
        return viewerActive==='狼人' && targetActive==='狼人';
      }else{
        return hasWolf(viewer) && hasWolf(p);
      }
    };

    const alreadyActedGuard=(pid)=>{
      const g=((this.actions[round]||{}).NIGHT||{}).GUARD||{};
      return g[pid]!==undefined;
    };
    const alreadyActedSeer=(pid)=>{
      const s=((this.actions[round]||{}).NIGHT||{}).SEER||{};
      return s[pid]!==undefined;
    };

    const selectable=(p)=>{
      if(!this.selection) return false;
      if(!p.isAlive) return false;
      const me=this.players[this.playerId];
      switch(this.selection.type){
        case 'guard': {
          // 已提交则不可再选
          if(alreadyActedGuard(me.id)) return false;
          const last=this.getSkillState('lastGuardTarget', me);
          return p.id!==me.id && (last==null || Number(last)!==Number(p.id));
        }
        case 'seer': {
          if(alreadyActedSeer(me.id)) return false;
          return p.id!==me.id;
        }
        case 'wolf-vote': return true; // 允许多次改票，直到拍板
        case 'witch-poison': return !p.isExposedIdiot && p.id!==me.id;
        case 'day-vote': return !p.isExposedIdiot;
        case 'knight': return !p.isExposedIdiot && p.id!==me.id;
        case 'hunter': return true;
        case 'sheriff-vote': {
          const cand=(this.sheriff?.candidates)||{}; const drops=(this.sheriff?.drops)||{};
          return !!cand[p.id] && !drops[p.id];
        }
        case 'badge-pass': return p.id!==me.id && p.isAlive;
      }
      return false;
    };

    const isSelected=(p)=> this.selection && Number(this.selection.targetId)===Number(p.id);

    const make=(p)=>{
      const card=document.createElement('div');
      const lives=Math.max(0, 2 - (p.deaths||0));
      card.className='player-card';
      if(Number(this.playerId)===Number(p.id)) card.classList.add('me');
      if(!p.isAlive) card.classList.add('disabled');
      if(this.selection && !selectable(p)) card.classList.add('disabled');
      if(isSelected(p)) card.classList.add('selected');
      if(showWolfBadges && alphaTarget && Number(alphaTarget)===Number(p.id)) card.classList.add('wolf-final-target');

      // 狼投票角标
      let wolfBadges='';
      if(showWolfBadges){
        const voterIds=Object.entries(votes).filter(([,t])=>Number(t)===Number(p.id)).map(([vid])=>Number(vid)).sort((a,b)=>a-b);
        wolfBadges=voterIds.map((vid,idx)=>`<span class="wolf-corner" style="top:${4+idx*16}px">${vid}</span>`).join('');
      }

      const tags=[];
      if(canSeeTeammate(p)) tags.push('<span class="tag tag-team">队友</span>');
      if(p.isExposedIdiot) tags.push('<span class="tag tag-idiot">白痴</span>');

      const isHostMark = this.isHost && Number(p.id)===Number(this.state.hostId);
      const isSheriff = !!p.badge;

      card.innerHTML = `
        <div class="player-number">
          ${p.id}
          ${isHostMark?`<span title="主持" class="host-mark" style="margin-left:2px;">👑</span>`:''}
          ${isSheriff?`<span title="警长" class="sheriff-icon" style="margin-left:2px; color:#a78bfa; -webkit-text-fill-color:initial;">⭐</span>`:''}
        </div>
        <div class="tagline">${tags.join('')}</div>
        <div class="hearts"><span class="heart ${lives<1?'off':''}">❤</span><span class="heart ${lives<2?'off':''}">❤</span></div>
        ${wolfBadges}
      `;

      if(this.selection && selectable(p)){
        card.style.cursor='pointer';
        card.addEventListener('click', ()=>{
          this.selection.targetId = p.id.toString();
          this.renderActionPanel(); this.renderPlayerGrid();
        });
      }
      return card;
    };

    arr.slice(0,half).forEach(p=>L.appendChild(make(p)));
    arr.slice(half).forEach(p=>R.appendChild(make(p)));
  },
  renderHostPanel(){
    const el=this.$('host-controls'); if(!el) return;
    if(!this.isHost){ el.classList.add('hidden'); el.innerHTML=''; return; }
    el.classList.remove('hidden');

    const phase=this.state.phase, r=this.state.round||0, ps=Object.values(this.players).sort((a,b)=>a.id-b.id);
    const tag = (p, ok)=> `<span class="player-tag ${ok?'done':'pending'}">${p.id}号</span>`;
    const section = (title, done, pend)=> `
      <div class="host-status">
        <div class="host-status-title">${title}</div>
        <div class="status-category"><div class="category-title">已完成:</div><div class="player-tags">${done.length?done.join(''):'<span style="color:var(--text-tertiary);">无</span>'}</div></div>
        <div class="status-category"><div class="category-title">未完成:</div><div class="player-tags">${pend.length?pend.join(''):'<span style="color:var(--text-tertiary);">无</span>'}</div></div>
      </div>`;

    let html = `<div class="host-panel">`;

    if(phase===PHASE.SETUP){
      const ready=ps.filter(p=>p.isReady), pend=ps.filter(p=>!p.isReady);
      html += section(`玩家准备 (${ready.length}/${ps.length})`, ready.map(p=>tag(p,true)), pend.map(p=>tag(p,false)));
      html += `<div class="host-actions" style="display:flex;gap:8px;">
        <button class="confirm-btn" data-action="host-start" ${pend.length>0?'disabled':''}>🚀 开始游戏</button>
        <button class="action-btn" data-action="host-force-start">⚡ 强制开始</button>
      </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    if(phase===PHASE.NIGHT || phase===PHASE.NIGHT_WITCH || phase===PHASE.DAWN_RESOLVE){
      html += `<div class="host-status"><div class="host-status-title">夜间进行中（为保密不显示进度）</div></div>
      <div class="host-actions" style="display:flex;gap:8px;">
        <button class="action-btn" data-action="host-force-sunrise">🌅 强制天亮</button>
      </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    if(phase===PHASE.SHERIFF_CAND){
      const cand=this.sheriff?.candidates||{};
      const decided=ps.filter(p=>p.isAlive && cand[p.id]!==undefined);
      const pending=ps.filter(p=>p.isAlive && cand[p.id]===undefined);
      html += section(`上警意向 (${decided.length}/${ps.filter(p=>p.isAlive).length})`,
        decided.map(p=>tag(p,true)), pending.map(p=>tag(p,false)));
      html += `<div class="host-actions" style="display:flex;gap:8px;">
        <button class="confirm-btn" data-action="host-open-sheriff-vote">🗳️ 开启警长投票</button>
      </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    if(phase===PHASE.SHERIFF_VOTE){
      const votes=this.sheriff?.votes||{};
      const voters=ps.filter(p=>p.isAlive && !p.isExposedIdiot);
      const done=voters.filter(p=>votes[p.id]!==undefined);
      const pend=voters.filter(p=>votes[p.id]===undefined);
      html += section(`警长投票 (${done.length}/${voters.length})`,
        done.map(p=>tag(p,true)), pend.map(p=>tag(p,false)));
      html += `<div class="host-actions" style="display:flex;gap:8px;">
        <button class="action-btn" data-action="host-force-end-sheriffvote">⏭️ 强制结束投票</button>
      </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    if(phase===PHASE.DAY_TALK){
      html += `<div class="host-actions" style="display:flex;gap:8px;">
        <button class="confirm-btn" data-action="host-open-day-vote">🗳️ 开启放逐投票</button>
        <button class="control-btn" data-action="host-force-start-sheriff">👮 强制开始上警</button>
      </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    if(phase===PHASE.DAY_VOTE){
      const votes=(this.actions[r]||{}).DAY_VOTE||{};
      const voters=ps.filter(p=>p.isAlive && !p.isExposedIdiot);
      const done=voters.filter(p=>votes[p.id]!==undefined);
      const pend=voters.filter(p=>votes[p.id]===undefined);
      html += section(`放逐投票 (${done.length}/${voters.length})`,
        done.map(p=>tag(p,true)), pend.map(p=>tag(p,false)));
      html += `<div class="host-actions" style="display:flex;gap:8px;">
        <button class="action-btn" data-action="host-force-end-dayvote">⏭️ 强制结束投票</button>
      </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    if(phase===PHASE.HUNTER_ACTION){
      html += `<div class="host-status"><div class="host-status-title">猎人行动中</div></div>`;
      html += `<div class="host-actions" style="display:flex;gap:8px;">
        <button class="control-btn" data-action="host-force-sunrise">🌅 强制天亮</button>
      </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    if(phase===PHASE.SHERIFF_TRANSFER){
      html += `<div class="host-status"><div class="host-status-title">警徽移交阶段</div></div>`;
      el.innerHTML=html+`</div>`; return;
    }

    if(phase===PHASE.GAME_OVER){
      html += `<div class="host-status"><div class="host-status-title">🏁 ${this.state.winner||'游戏结束'}</div></div>
               <div class="host-actions" style="display:flex;gap:8px;">
                 <button class="action-btn" data-action="host-restart">🔄 重开一局</button>
               </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    // 兜底
    html += `<div class="host-actions" style="display:flex;gap:8px;">
      <button class="action-btn" data-action="host-force-sunrise">🌅 强制天亮</button>
      <button class="action-btn" data-action="host-restart">🔄 重开一局</button>
    </div>`;
    el.innerHTML=html+`</div>`;
  },
  renderActionPanel(){
    const panel=this.$('action-panel'); if(!panel || this.playerId==='0'){ if(panel) panel.innerHTML=''; return; }
    const me=this.players[this.playerId]; if(!me){ panel.innerHTML=''; return; }
    const phase=this.state.phase; const round=this.state.round||0;
    const selTxt=(t)=> `<div class="action-target">当前目标：<strong>${t?`${t}号`:'未选择'}</strong></div>`;
    const ensureSel=(type)=>{ if(!this.selection || this.selection.type!==type){ this.selection={ type, targetId:null }; } };

    const nightNode = ((this.actions[round]||{}).NIGHT)||{};
    const gNode = nightNode.GUARD||{};
    const sNode = nightNode.SEER||{};
    const wNode = nightNode.WOLVES||{};

    // SETUP
    if(phase===PHASE.SETUP){
      panel.innerHTML = `<div class="action-feedback">请确认身份并等待主持人开始游戏。</div>`;
      return;
    }

    // NIGHT：守卫/预言家/狼人并行
    if(phase===PHASE.NIGHT){
      // 守卫
      if(this.getActiveRole(me)==='守卫'){
        ensureSel('guard');
        const hasActed = gNode[this.playerId]!==undefined;
        const last=this.getSkillState('lastGuardTarget', me);
        panel.innerHTML = `
          <div class="action-prompt">请选择今晚要守护的玩家（不可连续守同一人）</div>
          ${selTxt(this.selection.targetId)}
          <div class="action-buttons">
            <button class="control-btn" data-action="skip-selection" ${hasActed?'disabled':''}>🛡️ 空守</button>
            <button class="confirm-btn" data-action="confirm-selection" ${(!this.selection.targetId||hasActed)?'disabled':''}>✅ 确认守护</button>
          </div>
          <div class="action-feedback">上次守护：${last===undefined?'无':(last===null?'空守':`${last}号`)}${hasActed?' · 本夜已提交':''}</div>`;
        return;
      }
      // 预言家
      if(this.getActiveRole(me)==='预言家'){
        ensureSel('seer');
        const hasActed = sNode[this.playerId]!==undefined;
        panel.innerHTML = `
          <div class="action-prompt">请选择今晚要查验的玩家</div>
          ${selTxt(this.selection.targetId)}
          <div class="action-buttons">
            <button class="control-btn" data-action="skip-selection" ${hasActed?'disabled':''}>⏭️ 跳过</button>
            <button class="confirm-btn" data-action="confirm-selection" ${(!this.selection.targetId||hasActed)?'disabled':''}>✅ 确认查验</button>
          </div>
          ${hasActed?'<div class="action-feedback">本夜已提交</div>':''}`;
        return;
      }
      // 狼人/隐狼
      if(this.canWolfAct(me)){
        ensureSel('wolf-vote');
        const viewerType=this.getViewerWolfType();
        const alphaTarget = wNode.alphaTarget||null;
        panel.innerHTML = `
          <div class="action-prompt">请选择今晚要袭击的玩家（由拍板狼确认）</div>
          ${selTxt(this.selection.targetId)}
          <div class="action-buttons">
            <button class="control-btn" data-action="skip-selection">🔪 空刀</button>
            <button class="confirm-btn" data-action="confirm-selection" ${!this.selection.targetId?'disabled':''}>✅ 投票</button>
          </div>
          <div id="wolf-votes-display" class="wolf-votes-display"></div>
          ${viewerType==='regular'?`
          <div class="wolf-chat-section">
            <div id="wolf-chat-messages" class="chat-messages"></div>
            <div class="chat-input-wrapper">
              <input type="text" id="wolf-chat-input" class="chat-input" placeholder="狼人悄悄话...">
              <button class="btn-send" data-action="wolf-send">发送</button>
            </div>
          </div>`:''}
          ${alphaTarget?'<div class="action-feedback">已确认袭击：'+(alphaTarget==='0'?'空刀':alphaTarget+'号')+'</div>':''}
        `;
        return;
      }

      panel.innerHTML = `<div class="action-feedback">夜间进行中，请等待...</div>`;
      return;
    }

    // 女巫阶段
    if(phase===PHASE.NIGHT_WITCH && this.getActiveRole(me)==='女巫'){
      ensureSel('witch-poison');
      const wolfAct = (((this.actions[round]||{}).NIGHT||{}).WOLVES)||{};
      const target = wolfAct.alphaTarget || null;
      const isFirstNight = round===1;
      const lifeIdx = me.deaths;
      const usedCure = !!this.getSkillState('hasUsedCure', me, lifeIdx);
      const usedPoison = !!this.getSkillState('hasUsedPoison', me, lifeIdx);
      const canCure = !usedCure && target && target!=='0';
      let cureDisabled=false;
      if(canCure && Number(target)===Number(this.playerId)){
        const rule=this.settings.witchSelfSaveRule||'noFirstNightSelfSave';
        if((rule==='noFirstNightSelfSave' && isFirstNight) || (rule==='onlyFirstNightSelfSave' && !isFirstNight)) cureDisabled=true;
      }
      panel.innerHTML = `
        <div class="witch-panel">
          <div class="witch-status">
            <div class="potion-status">
              <span class="potion ${!usedCure?'available':''}">💊 解药</span>
              <span class="potion ${!usedPoison?'available':''}">☠️ 毒药</span>
            </div>
          </div>
          <div class="action-target">当前毒药目标：<strong>${this.selection.targetId?this.selection.targetId+'号':'未选择'}</strong></div>
          <div class="witch-actions-container">
            <button class="confirm-btn" data-action="witch-cure" data-target="${target||''}" ${(!canCure || cureDisabled)?'disabled':''}>💊 ${target?`救 ${target}号`:'无人可救'}</button>
            <button class="action-btn" data-action="confirm-selection" ${(!this.selection.targetId || usedPoison)?'disabled':''}>☠️ 使用毒药</button>
            <button class="control-btn" data-action="skip-selection">⏭️ 本轮不使用</button>
          </div>
        </div>`;
      return;
    }

    if(phase===PHASE.DAY_TALK){
      // 骑士在白天可决斗（一次性）
      if(this.getActiveRole(me)==='骑士' && !this.getSkillState('hasUsedDuel',me)){
        ensureSel('knight');
        panel.innerHTML = `
          <div class="action-prompt">骑士可以选择一名玩家发起决斗：</div>
          ${selTxt(this.selection.targetId)}
          <div class="action-buttons">
            <button class="confirm-btn" data-action="confirm-selection" ${!this.selection.targetId?'disabled':''}>⚔️ 决斗</button>
          </div>`;
        return;
      }
      panel.innerHTML = `<div class="action-feedback">发言阶段，请等待主持人开启投票。</div>`;
      return;
    }

    if(phase===PHASE.DAY_VOTE){
      ensureSel('day-vote');
      panel.innerHTML = `
        <div class="action-prompt">放逐投票已开启：</div>
        ${selTxt(this.selection.targetId)}
        <div class="action-buttons">
          <button class="control-btn" data-action="skip-selection">🗳️ 弃票</button>
          <button class="confirm-btn" data-action="confirm-selection" ${!this.selection.targetId?'disabled':''}>✅ 投票</button>
        </div>`;
      return;
    }

    if(phase===PHASE.SHERIFF_CAND){
      panel.innerHTML = `
        <div class="action-prompt">请选择是否上警：</div>
        <div class="action-buttons">
          <button class="control-btn" data-action="sheriff-cand" data-value="0">不上警</button>
          <button class="confirm-btn" data-action="sheriff-cand" data-value="1">我要上警</button>
        </div>`;
      return;
    }

    if(phase===PHASE.SHERIFF_SPEECH){
      const cand=this.sheriff?.candidates||{};
      const drops=this.sheriff?.drops||{};
      if(cand[this.playerId] && !drops?.[this.playerId]){
        panel.innerHTML = `<div class="action-buttons"><button class="action-btn" data-action="sheriff-drop">💧 退水</button></div>`;
      }else{
        panel.innerHTML = `<div class="action-feedback">候选人发言中...</div>`;
      }
      return;
    }

    if(phase===PHASE.SHERIFF_VOTE){
      ensureSel('sheriff-vote');
      panel.innerHTML = `
        <div class="action-prompt">请选择你支持的警长候选人：</div>
        ${selTxt(this.selection.targetId)}
        <div class="action-buttons">
          <button class="control-btn" data-action="skip-selection">🗳️ 弃票</button>
          <button class="confirm-btn" data-action="confirm-selection" ${!this.selection.targetId?'disabled':''}>✅ 投票</button>
        </div>`;
      return;
    }

    if(phase===PHASE.HUNTER_ACTION){
      const queue=this.state.hunterQueue||{};
      if(queue[this.playerId]){
        ensureSel('hunter');
        panel.innerHTML = `
          <div class="action-prompt">你是猎人，请选择一名玩家带走：</div>
          ${selTxt(this.selection.targetId)}
          <div class="action-buttons">
            <button class="confirm-btn" data-action="confirm-selection" ${!this.selection.targetId?'disabled':''}>🔫 开枪</button>
          </div>`;
      }else{
        panel.innerHTML = `<div class="action-feedback">猎人正在行动，请稍候...</div>`;
      }
      return;
    }

    if(phase===PHASE.SHERIFF_TRANSFER){
      const pds=this.state.postDeath||{};
      if(pds.deadSheriffId==this.playerId){
        ensureSel('badge-pass');
        panel.innerHTML = `
          <div class="action-prompt">你是阵亡警长，请选择移交对象或撕毁警徽：</div>
          ${selTxt(this.selection.targetId)}
          <div class="action-buttons">
            <button class="action-btn" data-action="badge-destroy">💔 撕毁</button>
            <button class="confirm-btn" data-action="badge-pass" ${!this.selection.targetId?'disabled':''} data-to="${this.selection.targetId||''}">⭐ 移交</button>
          </div>`;
      }else{
        panel.innerHTML = `<div class="action-feedback">等待警长移交警徽...</div>`;
      }
      return;
    }

    if(phase===PHASE.DAWN_RESOLVE){
      panel.innerHTML = `<div class="action-feedback">结算中，请稍候...</div>`;
      return;
    }

    if(phase===PHASE.GAME_OVER){
      panel.innerHTML = `<div class="action-feedback">${this.state.winner||'游戏结束'}</div>`;
      return;
    }

    panel.innerHTML = `<div class="action-feedback">请等待...</div>`;
  },

  renderGod(){
    // 玩家状态
    const list=this.$('god-player-list'); if(list){
      list.innerHTML='';
      const fmt=(id)=> `<span class="${id.isThiefCopy?'thief-copy':''}">${ROLES[id.role].icon} ${id.role}</span>`;
      Object.values(this.players).sort((a,b)=>a.id-b.id).forEach(p=>{
        const lives=Math.max(0, 2-(p.deaths||0));
        const row=document.createElement('div');
        row.className=`god-row ${!p.isAlive?'dead-all':''}`;
        row.innerHTML=`
          <div class="god-player-number"><span class="player-id">${p.id}号</span>${p.badge?'<span class="sheriff-icon" style="color:#a78bfa">⭐</span>':''}${Number(p.id)===Number(this.state.hostId)?'<span class="host-mark">👑</span>':''}</div>
          <div class="god-identities">
            <span class="${p.deaths>0?'dead-identity':''}">${fmt(p.identities[0])}</span>
            <span class="identity-plus">+</span>
            <span class="${p.deaths>1?'dead-identity':''}">${fmt(p.identities[1])}</span>
          </div>
          <div class="god-hearts"><span class="life-heart ${lives<1?'lost':''}">❤</span><span class="life-heart ${lives<2?'lost':''}">❤</span></div>`;
        list.appendChild(row);
      });
    }
    // 日志（含秘密）
    const godLog=this.$('god-log-content'); if(godLog){
      godLog.innerHTML='';
      const logs=Object.values(this.full.logs||{}).sort((a,b)=>a.timestamp-b.timestamp);
      if(!logs.length){ godLog.innerHTML='<div class="log-empty">暂无日志</div>'; return; }
      logs.forEach(l=>{
        const div=document.createElement('div');
        div.className='log-item'; if(l.isSecret) div.classList.add('log-secret');
        const prefix=l.round>0?`<span class="log-round">[第${l.round}轮]</span> `:'';
        div.innerHTML = prefix + this.escapeHTML(l.message);
        godLog.appendChild(div);
      });
      godLog.scrollTop=godLog.scrollHeight;
    }
  },
  renderLogsLive(){
    if(this.playerId==='0') return;
    const cont=this.$('game-log-content'); if(!cont) return;
    cont.innerHTML='';
    const ref=db.ref(`games/${this.gameId}/logs`).limitToLast(300);
    ref.off();
    ref.on('child_added', s=>{
      const v=s.val(); if(!v || v.isSecret) return;
      const d=document.createElement('div');
      d.className='log-item';
      const prefix=v.round>0?`<span class="log-round">[第${v.round}轮]</span> `:'';
      d.innerHTML = prefix + this.escapeHTML(v.message);
      cont.appendChild(d); cont.scrollTop=cont.scrollHeight;
    });
  },

  /* ---------- 角色与权限/可见 ---------- */
  getActiveRole(p){
    if(!p || !p.isAlive) return null;
    const idx = Math.min(p.deaths||0, 1);
    return p.identities?.[idx]?.role || null;
  },
  hasAnyWolfIdentity(p){
    return (p.identities||[]).some(id=>id.role==='狼人'||id.role==='隐狼');
  },
  getViewerWolfType(){
    if(this.playerId==='0') return null;
    const me=this.players[this.playerId]; if(!me) return null;
    const has=(r)=> (me.identities||[]).some(x=>x.role===r);
    if(has('狼人')) return 'regular';
    if(has('隐狼')) return 'hidden';
    return null;
  },
  canWolfAct(p){
    const r=this.getActiveRole(p);
    if(r==='狼人') return true;
    if(r==='隐狼'){
      // 仅当场上无“活跃的普通狼人”时，隐狼可作为拍板狼/行动
      const hasActiveRegular = Object.values(this.players).some(pp=>pp.isAlive && this.getActiveRole(pp)==='狼人');
      return !hasActiveRegular;
    }
    return false;
  },
  getAlphaWolfId(){
    // 生效的拍板者：优先最低号活跃普通狼人，否则最低号活跃隐狼
    const alive = Object.values(this.players).filter(p=>p.isAlive);
    const regs = alive.filter(p=>this.getActiveRole(p)==='狼人').map(p=>p.id);
    if(regs.length) return Math.min(...regs).toString();
    const hides = alive.filter(p=>this.getActiveRole(p)==='隐狼').map(p=>p.id);
    if(hides.length) return Math.min(...hides).toString();
    return null;
  },

  /* ---------- 行动提交（本地 -> actions） ---------- */
  async confirmSelection(){
    const sel=this.selection; if(!sel) return;
    const me=this.players[this.playerId]; if(!me) return;
    const round=this.state.round;

    const write = async (path, payload)=> db.ref(`games/${this.gameId}/${path}`).set({ ...payload, ts: firebase.database.ServerValue.TIMESTAMP });

    switch(sel.type){
      case 'guard': {
        // 不允许重复提交
        const existed = ((this.actions[round]||{}).NIGHT||{}).GUARD?.[this.playerId];
        if(existed!==undefined) return this.notify('本夜已提交','info');
        await write(`actions/${round}/NIGHT/GUARD/${this.playerId}`, { target: sel.targetId });
        await this.setSkillState('lastGuardTarget', Number(sel.targetId), me);
        this.notify(`你守护了 ${sel.targetId}号`,'success');
        break;
      }
      case 'seer': {
        const existed = ((this.actions[round]||{}).NIGHT||{}).SEER?.[this.playerId];
        if(existed!==undefined) return this.notify('本夜已提交','info');
        const res = this.seerResult(Number(sel.targetId));
        await write(`actions/${round}/NIGHT/SEER/${this.playerId}`, { target: sel.targetId, result: res });
        const rec=(this.getGlobalSkillState('seerResults')||{}); rec[sel.targetId]=res;
        await this.setGlobalSkillState('seerResults', rec);
        await this.log(`🔮 预言家(${this.playerId}号)查验 ${sel.targetId}号，结果为 ${res}`, true);
        this.notify(`查验结果：${sel.targetId}号 → ${res}`,'success');
        break;
      }
      case 'wolf-vote': {
        await db.ref(`games/${this.gameId}/actions/${round}/NIGHT/WOLVES/votes/${this.playerId}`).set(sel.targetId);
        this.notify(`已投票：${sel.targetId==='0'?'空刀':sel.targetId+'号'}`,'success');
        break;
      }
      case 'witch-poison': {
        await write(`actions/${round}/NIGHT_WITCH/${this.playerId}`, { poison: sel.targetId });
        await this.setSkillState('hasUsedPoison', true, me);
        await this.log(`🧪 女巫(${this.playerId}号)毒杀了 ${sel.targetId}号`, true);
        this.notify(`你毒杀了 ${sel.targetId}号`,'error');
        break;
      }
      case 'day-vote': {
        await write(`actions/${round}/DAY_VOTE/${this.playerId}`, { target: sel.targetId });
        this.notify(`已投票：${sel.targetId}号`,'success');
        break;
      }
      case 'knight': {
        await this.setSkillState('hasUsedDuel', true, me);
        await this.log(`⚔️ 骑士 ${this.playerId}号 对 ${sel.targetId}号 发动决斗！`, false);
        await this.knightResolve(sel.targetId);
        break;
      }
      case 'hunter': {
        await this.log(`🔫 猎人 ${this.playerId}号 开枪带走了 ${sel.targetId}号！`, false);
        await db.ref(`games/${this.gameId}/state/hunterQueue/${this.playerId}`).set(null);
        await this.killAndChain(sel.targetId,'HUNTER');
        break;
      }
      case 'sheriff-vote': {
        await db.ref(`games/${this.gameId}/sheriff/votes/${this.playerId}`).set(sel.targetId);
        this.notify(`已投警长票：${sel.targetId==='0'?'弃票':sel.targetId+'号'}`,'success');
        break;
      }
      case 'badge-pass': {
        await this.badgePass(sel.targetId);
        break;
      }
    }
    this.selection=null;
    this.renderActionPanel(); this.renderPlayerGrid();
  },
  async skipSelection(){
    if(!this.selection) return;
    const me=this.players[this.playerId];
    const round=this.state.round;
    switch(this.selection.type){
      case 'guard': {
        const existed = ((this.actions[round]||{}).NIGHT||{}).GUARD?.[this.playerId];
        if(existed!==undefined) return this.notify('本夜已提交','info');
        await db.ref(`games/${this.gameId}/actions/${round}/NIGHT/GUARD/${this.playerId}`).set({ target:null, ts: firebase.database.ServerValue.TIMESTAMP });
        await this.setSkillState('lastGuardTarget', null, me);
        this.notify('你选择了空守','info');
        break;
      }
      case 'seer': {
        const existed = ((this.actions[round]||{}).NIGHT||{}).SEER?.[this.playerId];
        if(existed!==undefined) return this.notify('本夜已提交','info');
        await db.ref(`games/${this.gameId}/actions/${round}/NIGHT/SEER/${this.playerId}`).set({ target:null, ts: firebase.database.ServerValue.TIMESTAMP });
        this.notify('你跳过了查验','info');
        break;
      }
      case 'wolf-vote': {
        await db.ref(`games/${this.gameId}/actions/${round}/NIGHT/WOLVES/votes/${this.playerId}`).set('0');
        this.notify('已选择空刀','info');
        break;
      }
      case 'witch-poison': {
        await db.ref(`games/${this.gameId}/actions/${round}/NIGHT_WITCH/${this.playerId}`).set({ skipped:true, ts: firebase.database.ServerValue.TIMESTAMP });
        this.notify('女巫未使用毒药','info');
        break;
      }
      case 'day-vote': {
        await db.ref(`games/${this.gameId}/actions/${round}/DAY_VOTE/${this.playerId}`).set({ target:'0', ts: firebase.database.ServerValue.TIMESTAMP });
        this.notify('已投弃票','info');
        break;
      }
      case 'sheriff-vote': {
        await db.ref(`games/${this.gameId}/sheriff/votes/${this.playerId}`).set('0');
        this.notify('已为警长投弃票','info');
        break;
      }
      case 'badge-pass': {
        await this.badgeDestroy();
        break;
      }
    }
    this.selection=null; this.renderActionPanel(); this.renderPlayerGrid();
  },

  /* ---------- 夜间：女巫/狼人特有 ---------- */
  async witchCure(targetId){
    if(!targetId) return;
    const me=this.players[this.playerId]; const round=this.state.round;
    const rule=this.settings.witchSelfSaveRule||'noFirstNightSelfSave';
    const isFirstNight = round===1;
    if(Number(targetId)===Number(this.playerId)){
      if((rule==='noFirstNightSelfSave' && isFirstNight) || (rule==='onlyFirstNightSelfSave' && !isFirstNight)){
        return this.notify('本轮不可自救','error');
      }
    }
    const used = !!this.getSkillState('hasUsedCure', me, me.deaths);
    if(used) return this.notify('解药已用过','error');
    await db.ref(`games/${this.gameId}/actions/${round}/NIGHT_WITCH/${this.playerId}`).update({ cure: targetId, ts: firebase.database.ServerValue.TIMESTAMP });
    await this.setSkillState('hasUsedCure', true, me);
    await this.log(`🧪 女巫(${this.playerId}号)使用解药救了 ${targetId}号`, true);
    this.notify(`你救了 ${targetId}号`,'success');
  },
  async wolfConfirm(value){
    const myId=this.playerId;
    const alpha=this.getAlphaWolfId();
    const me=this.players[myId];
    if(myId!==alpha) return this.notify('你不是拍板狼','error');
    if(!this.canWolfAct(me)) return this.notify('当前不可确认','error');
    const round=this.state.round;
    const ref=db.ref(`games/${this.gameId}/actions/${round}/NIGHT/WOLVES`);
    await ref.transaction(cur=>{
      if(cur && cur.alphaTarget!=null) return cur; // 已拍板
      return { ...(cur||{}), alphaTarget: value||'0', alphaActor: myId, ts: firebase.database.ServerValue.TIMESTAMP };
    });
    await this.log(`🐺 狼队决定袭击 ${value==='0'?'空刀':value+'号'} (由${myId}号确认)`, true);
    this.notify(`已确认袭击 ${value==='0'?'空刀':value+'号'}`,'success');
    this.selection=null; this.renderActionPanel(); this.renderPlayerGrid();
  },
  refreshWolfListeners(){
    if(this.wolfVotesOff){ this.wolfVotesOff(); this.wolfVotesOff=null; }
    if(this.wolfChatOff){ this.wolfChatOff(); this.wolfChatOff=null; }

    if(this.playerId==='0') return;
    const me=this.players[this.playerId]; if(!me) return;
    const type=this.getViewerWolfType();
    if(this.state.phase!==PHASE.NIGHT || !type) return;

    const round=this.state.round;
    // 投票显示
    const disp=this.$('wolf-votes-display');
    const votesRef=db.ref(`games/${this.gameId}/actions/${round}/NIGHT/WOLVES`);
    const handler=(snap)=>{
      const v=snap.val()||{}; const votes=v.votes||{}; const alphaId=this.getAlphaWolfId();
      if(!disp) return;
      const voters = Object.values(this.players).filter(p=>p.isAlive && (this.getActiveRole(p)==='狼人' || (!Object.values(this.players).some(pp=>pp.isAlive && this.getActiveRole(pp)==='狼人') && this.getActiveRole(p)==='隐狼')));
      let html=`<div class="wolf-vote-title">🗳️ 投票情况</div><div class="wolf-vote-list">`;
      voters.sort((a,b)=>a.id-b.id).forEach(w=>{
        const vt=votes[w.id]; const text = vt==null?'未投票':(vt==='0'?'空刀':`${vt}号`);
        const isAlpha = (alphaId && w.id.toString()===alphaId);
        html += `<div class="wolf-vote-item"><span class="voter">${w.id}号 ${isAlpha?'<span class="alpha-badge">拍板</span>':''}</span><span class="vote-arrow">→</span><span class="vote-target ${vt!=null?'voted':''}">${text}</span></div>`;
      });
      html+=`</div>`;
      if(alphaId===this.playerId && v.alphaTarget!=null){
        const t=v.alphaTarget;
        html += `<div class="wolf-confirm-section"><button class="confirm-btn" data-action="wolf-confirm" data-value="${t}">🎯 确认袭击 ${t==='0'?'空刀':t+'号'}</button></div>`;
      }
      disp.innerHTML=html;
    };
    votesRef.on('value', handler);
    this.wolfVotesOff = ()=> votesRef.off('value', handler);

    // 狼聊（仅普通狼人可见）
    if(type==='regular'){
      const chatBox=this.$('wolf-chat-messages'); if(chatBox) chatBox.innerHTML='';
      const chatRef=db.ref(`games/${this.gameId}/wolfChat`).limitToLast(120);
      const chatHandler=(s)=>{
        const v=s.val(); if(!v) return;
        const p=document.createElement('div'); p.className='chat-message';
        p.innerHTML = `<span class="chat-sender">${v.pid}号:</span> <span class="chat-text">${this.escapeHTML(v.msg)}</span>`;
        chatBox && (chatBox.appendChild(p), chatBox.scrollTop=chatBox.scrollHeight);
      };
      chatRef.on('child_added', chatHandler);
      this.wolfChatOff = ()=> chatRef.off('child_added', chatHandler);

      const input=this.$('wolf-chat-input');
      if(input){
        const clone=input.cloneNode(true);
        input.parentNode.replaceChild(clone,input);
        clone.addEventListener('keypress',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); this.sendWolfMessage(); }});
      }
    }
  },
  sendWolfMessage(){
    if(this.getViewerWolfType()!=='regular') return this.notify('你无法在狼窝发言','error');
    const el=this.$('wolf-chat-input'); if(!el) return;
    const msg=(el.value||'').trim(); if(!msg) return;
    if(msg.length>160) return this.notify('消息过长','error');
    db.ref(`games/${this.gameId}/wolfChat`).push({ pid:this.playerId, msg, ts: firebase.database.ServerValue.TIMESTAMP });
    el.value='';
  },

  /* ---------- 上警流程 ---------- */
  async sheriffCand(v){
    if(!this.players[this.playerId]?.isAlive) return;
    await db.ref(`games/${this.gameId}/sheriff/candidates/${this.playerId}`).set(v?1:0);
    this.notify(v?'你选择了上警':'你选择了不上警', v?'success':'info');
  },
  async sheriffDrop(){
    await db.ref(`games/${this.gameId}/sheriff/drops/${this.playerId}`).set(1);
    this.notify('你已退水','info');
  },

  /* ---------- 技能/状态工具 ---------- */
  getSkillState(key, p=null, lifeIdx=-1){
    const pl=p||this.players[this.playerId]; if(!pl) return undefined;
    const i=lifeIdx!==-1?lifeIdx:(pl.deaths||0);
    return (pl.skillStates||{})[`${i}_${key}`];
  },
  async setSkillState(key, val, p=null){
    const pl=p||this.players[this.playerId]; if(!pl) return;
    const i=(pl.deaths||0);
    await db.ref(`games/${this.gameId}/players/${pl.id}/skillStates/${i}_${key}`).set(val);
  },
  getGlobalSkillState(key){
    const pl=this.players[this.playerId]; return (pl?.skillStates||{})[`global_${key}`];
  },
  async setGlobalSkillState(key,val){
    await db.ref(`games/${this.gameId}/players/${this.playerId}/skillStates/global_${key}`).set(val);
  },
  seerResult(targetId){
    const mode=this.settings.seerMode||'faction';
    const p=this.players[targetId]; if(!p) return '未知';
    if(mode==='faction'){
      const hasRegularWolf = (p.identities||[]).some(id=>id.role==='狼人');
      return hasRegularWolf?'狼人':'好人'; // 隐狼不显狼
    }else{
      return this.getActiveRole(p)||'未知';
    }
  },

  /* ---------- 创建游戏/发牌/重开 ---------- */
  renderRoleSetup(){
    const box=this.$('role-grid'); if(!box) return;
    box.innerHTML='';
    Object.keys(DEFAULT_SETUP).forEach(name=>{
      const role=ROLES[name];
      const defaultValue=DEFAULT_SETUP[name];
      const div=document.createElement('div'); div.className='role-setup-item';
      div.innerHTML=`
        <span class="role-name"><span class="role-icon">${role.icon}</span><span>${name}</span></span>
        <div class="role-counter">
          <button class="counter-btn minus" data-role="${name}">−</button>
          <input type="number" id="role-${name}" min="0" value="${defaultValue}" readonly>
          <button class="counter-btn plus" data-role="${name}">+</button>
        </div>`;
      box.appendChild(div);
    });
    box.addEventListener('click',(e)=>{
      const b=e.target.closest('.counter-btn'); if(!b) return;
      const role=b.dataset.role; const input=this.$(`role-${role}`); let val=+input.value||0;
      if(b.classList.contains('plus')) val=Math.min(10, val+1); else val=Math.max(0, val-1);
      input.value=val; this.updateRoleStats();
    });
    this.updateRoleStats();
  },
  updateRoleStats(){
    const box=this.$('role-grid'); if(!box) return;
    let total=0; box.querySelectorAll('input').forEach(i=>total+=+i.value||0);
    this.$('total-roles').textContent=total;
    const players = total%2===0? total/2 : '?';
    this.$('player-cnt').textContent=players;
    this.$('player-count-warning').textContent = total%2!==0 ? '⚠️ 身份总数必须为偶数' : '';
  },
  async createGame(){
    const btn=this.$('btn-create'); const err=this.$('setup-error');
    btn.disabled=true; this.$('create-text').classList.add('hidden'); this.$('create-spinner').classList.remove('hidden'); err.classList.add('hidden'); err.textContent='';

    const counts={};
    this.$('role-grid').querySelectorAll('input').forEach(i=>{ const name=i.id.replace('role-',''); const c=+i.value; if(c>0) counts[name]=c; });

    // 校验唯一角色最多 1
    for(const r of UNIQUE_ROLES){ if((counts[r]||0)>1) return this.createFail(`【${r}】最多 1 张`); }

    const pool=[]; Object.entries(counts).forEach(([role,c])=>{ for(let i=0;i<c;i++) pool.push(role); });
    if(pool.length===0 || pool.length%2!==0) return this.createFail('身份总数需为偶数且大于0');

    const dealt=this.deal(pool); if(!dealt) return this.createFail('无法生成符合规则的牌组，请调整配置。');

    const gameId = db.ref('games').push().key;
    const playerCount = dealt.finalPairs.length;
    const players={};
    for(let i=1;i<=playerCount;i++){
      players[i]={ id:i, identities: dealt.finalPairs[i-1], deaths:0, isAlive:true, isReady:false, isExposedIdiot:false, skillStates:{}, badge:0 };
    }
    const settings={
      witchSelfSaveRule: this.$('opt-witch-selfsave')?.value || 'noFirstNightSelfSave',
      seerMode: this.$('opt-seer-mode')?.value || 'faction',
      wolfWin: this.$('opt-wolf-win')?.value || 'edge',
      wolfVisibility: this.$('opt-wolf-visibility')?.value || 'activeOnly',
      playerCount
    };
    const init={
      state:{ phase:PHASE.SETUP, round:0, hostId:1, winner:null, hunterQueue:{}, postDeath:null, showWolfTags:false, peaceInRow:0 },
      players, settings,
      actions:{}, sheriff:null, logs:{},
      rawDeck: dealt.rawDeck, setupCounts: counts
    };
    await db.ref(`games/${gameId}`).set(init);

    // 创建完成提示与链接
    this.notify('游戏创建成功','success');
    this.$('role-setup-section').classList.add('hidden');
    btn.classList.add('hidden');
    const info=this.$('game-creation-info'); info.classList.remove('hidden');
    const base = `${location.origin}${location.pathname}`;
    const url = `${base}?game=${gameId}&player=PLAYER_ID`;
    let options=''; for(let i=2;i<=playerCount;i++) options+=`<option value="${i}">${i}号玩家</option>`;
    info.innerHTML=`
      <div class="success-message" style="text-align:center; margin-bottom:16px;">
        <div style="font-size:32px; margin-bottom:8px;">✅</div>
        <h3>游戏房间已创建</h3>
        <p style="color:var(--text-secondary); font-size:14px;">分享下面链接给玩家，替换 PLAYER_ID 为座位号</p>
      </div>
      <div class="link-container" style="display:flex; gap:8px; margin-bottom:16px;">
        <input id="player-link-template" class="fancy-input" value="${url}" readonly style="text-align:left;">
        <button data-action="copy-link" data-inputid="player-link-template" class="control-btn" style="flex-shrink:0;"><span>复制</span></button>
      </div>
      <div class="host-transfer-section" style="border-top:1px solid var(--border-primary); padding-top:16px; margin-top:16px;">
        <h4 style="text-align:center; font-weight:600; margin-bottom:8px;">房主操作</h4>
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:16px;">
          <select id="host-transfer-select" class="rule-select" style="flex-grow:1;">
            <option value="">将房主移交给...</option>${options}
          </select>
          <button class="control-btn" onclick="firebase.database().ref('games/${gameId}/state/hostId').set(Number(document.getElementById('host-transfer-select').value)||1)">确认移交</button>
        </div>
        <button data-action="join-as-creator" data-gameid="${gameId}" class="btn-primary btn-large"><span>以房主身份进入</span></button>
      </div>`;
  },
  createFail(msg){
    const err=this.$('setup-error'); err.textContent=msg; err.classList.remove('hidden');
    this.$('create-text').classList.remove('hidden'); this.$('create-spinner').classList.add('hidden'); this.$('btn-create').disabled=false;
  },
  deal(pool){
    const isBan=(a,b)=> FORBIDDEN_PAIR.has([a,b].sort().join('|'));
    for(let t=0;t<6000;t++){
      const deck=this.shuffle([...pool]);
      const finalPairs=[]; let ok=true, golden=0;
      for(let i=0;i<deck.length;i+=2){
        const a=deck[i], b=deck[i+1];
        if(a==='盗贼' && b==='盗贼'){ ok=false; break; }
        if(isBan(a,b)){ ok=false; break; }

        if(a==='盗贼'){
          finalPairs.push([{role:b,isThiefCopy:true},{role:b,isThiefCopy:false}]);
        }else if(b==='盗贼'){
          finalPairs.push([{role:a,isThiefCopy:false},{role:a,isThiefCopy:true}]);
        }else{
          finalPairs.push([{role:a,isThiefCopy:false},{role:b,isThiefCopy:false}]);
        }
        const fp=finalPairs[finalPairs.length-1];
        if(fp[0].role==='平民' && fp[1].role==='平民') golden++;
      }
      if(!ok) continue;
      if(golden<1) continue; // 至少 1 对金宝宝
      return { finalPairs, rawDeck: deck };
    }
    return null;
  },

  /* ---------- 主持动作（开始/强制/重开） ---------- */
  async hostStart(){
    if(this.state.phase!==PHASE.SETUP) return;
    // 必须全部 isReady
    const allReady = Object.values(this.players).every(p=>p.isReady);
    if(!allReady) return this.notify('仍有玩家未确认身份','error');
    await this.startNight(1);
  },
  async hostForceStartGame(){
    if(this.state.phase!==PHASE.SETUP) return;
    const updates={};
    Object.values(this.players).forEach(p=>{ updates[`players/${p.id}/isReady`]=true; });
    await db.ref(`games/${this.gameId}`).update(updates);
    await this.startNight(1);
  },
  async startNight(round){
    // 清空该轮 actions，进入 NIGHT；首夜打开队友标
    await db.ref(`games/${this.gameId}/actions/${round}`).set(null);
    await db.ref(`games/${this.gameId}/state`).update({ phase:PHASE.NIGHT, round, showWolfTags: round===1, postDeath:null });
  },
  async hostForceSunrise(){
    const r=this.state.round||1;
    // 若仍在 NIGHT：补齐狼拍板为空刀；女巫阶段若未到则直接进入结算（视为女巫未使用）
    if(this.state.phase===PHASE.NIGHT){
      const wRef = db.ref(`games/${this.gameId}/actions/${r}/NIGHT/WOLVES`);
      const cur=(await wRef.once('value')).val()||{};
      if(cur.alphaTarget==null){
        const alpha=this.getAlphaWolfId();
        await wRef.update({ alphaTarget:'0', alphaActor: alpha||'0', ts: firebase.database.ServerValue.TIMESTAMP });
      }
      // 直接进入结算
      await this.setPhase(PHASE.DAWN_RESOLVE);
      return;
    }
    if(this.state.phase===PHASE.NIGHT_WITCH){
      await this.setPhase(PHASE.DAWN_RESOLVE);
      return;
    }
    // 其它阶段按当前流程无效
    this.notify('当前不可强制天亮','error');
  },
  async hostForceEndDayVote(){
    if(this.state.phase!==PHASE.DAY_VOTE) return;
    const r=this.state.round;
    const votes=(this.actions[r]||{}).DAY_VOTE||{};
    const voters=Object.values(this.players).filter(p=>p.isAlive && !p.isExposedIdiot);
    const updates={};
    voters.forEach(v=>{ if(votes[v.id]===undefined) updates[`actions/${r}/DAY_VOTE/${v.id}`]={ target:'0', ts:firebase.database.ServerValue.TIMESTAMP };});
    if(Object.keys(updates).length) await db.ref(`games/${this.gameId}`).update(updates);
    // 统计在自动推进里处理（或在后半部 tallyDayVotes 直接调用）
  },
  async hostForceEndSheriffVote(){
    if(this.state.phase!==PHASE.SHERIFF_VOTE) return;
    const votes=this.sheriff?.votes||{};
    const voters=Object.values(this.players).filter(p=>p.isAlive && !p.isExposedIdiot);
    const updates={};
    voters.forEach(v=>{ if(votes[v.id]===undefined) updates[`sheriff/votes/${v.id}`]='0'; });
    if(Object.keys(updates).length) await db.ref(`games/${this.gameId}`).update(updates);
  },
  async hostRestart(){
    // 使用 setupCounts + settings 重新发牌，回到 SETUP
    const counts = this.setupCounts;
    const settings = this.settings;
    if(!counts || !settings) return this.notify('缺少配置，无法重开','error');

    // 发新牌
    const pool=[]; Object.entries(counts).forEach(([role,c])=>{ for(let i=0;i<c;i++) pool.push(role); });
    const dealt=this.deal(pool); if(!dealt) return this.notify('重开失败：无法生成牌组','error');

    const playerIds=Object.keys(this.players).map(x=>+x).sort((a,b)=>a-b);
    if(playerIds.length!==dealt.finalPairs.length) return this.notify('重开失败：玩家数与牌组不匹配','error');

    const updates={
      'actions': null,
      'logs': null,
      'sheriff': null,
      'rawDeck': dealt.rawDeck,
      'state/phase': PHASE.SETUP,
      'state/round': 0,
      'state/winner': null,
      'state/hunterQueue': null,
      'state/postDeath': null,
      'state/showWolfTags': false,
      'state/peaceInRow': 0,
      'wolfChat': null
    };
    playerIds.forEach((id,i)=>{
      updates[`players/${id}/identities`] = dealt.finalPairs[i];
      updates[`players/${id}/deaths`] = 0;
      updates[`players/${id}/isAlive`] = true;
      updates[`players/${id}/isReady`] = false;
      updates[`players/${id}/isExposedIdiot`] = false;
      updates[`players/${id}/skillStates`] = {};
      updates[`players/${id}/badge`] = 0;
    });
    await db.ref(`games/${this.gameId}`).update(updates);
    await this.log('🔄 主持人重开了游戏（沿用原配置与规则）', false);
    this.notify('已重开，玩家可重新调整身份顺序','success');
  },

  /* ---------- 自动推进（仅主持端触发）/ 胜负与结算 等函数见后半部分 ---------- */
};
window.App = App;
document.addEventListener('DOMContentLoaded', ()=>App.init());
/* ======== 后半部分：自动推进 / 结算 / 投票统计 / 胜负判定 等 ======== */
Object.assign(App, {
  /* ---------- 自动推进（仅主持端触发） ---------- */
  async autoAdvance(){
    if(!this.isHost) return;
    const phase=this.state.phase, r=this.state.round||0;

    if(phase===PHASE.NIGHT){
      // 狼人拍板后，自动进入女巫；若无狼存活，也直接进入女巫
      const wolvesAlive = Object.values(this.players).some(p=>p.isAlive && ['狼人','隐狼'].includes(this.getActiveRole(p)));
      const wolfNode=(((this.actions[r]||{}).NIGHT||{}).WOLVES)||{};
      const confirmed = wolfNode.alphaTarget!=null || !wolvesAlive;
      if(confirmed){
        await this.setPhase(PHASE.NIGHT_WITCH);
      }
      return;
    }

    if(phase===PHASE.NIGHT_WITCH){
      // 女巫存在且未行动 -> 等待；否则进入结算
      const aliveWitch = Object.values(this.players).find(p=>p.isAlive && this.getActiveRole(p)==='女巫');
      const witchActs = (this.actions[r]||{}).NIGHT_WITCH || {};
      if(!aliveWitch || witchActs[aliveWitch.id]!==undefined){
        await this.setPhase(PHASE.DAWN_RESOLVE);
      }
      return;
    }

    if(phase===PHASE.DAWN_RESOLVE){
      // 避免重复结算
      if(this.state.resolvingNight) return;
      await this.resolveNight();
      return;
    }

    if(phase===PHASE.SHERIFF_CAND){
      // 自动进入发言（仅“开始投票”需主持手动）
      await this.setPhase(PHASE.SHERIFF_SPEECH);
      return;
    }

    if(phase===PHASE.SHERIFF_VOTE){
      const votes=this.sheriff?.votes||{};
      const voters=Object.values(this.players).filter(p=>p.isAlive && !p.isExposedIdiot);
      const allVoted = voters.every(v=>votes[v.id]!==undefined);
      if(allVoted) await this.tallySheriffVotes();
      return;
    }

    if(phase===PHASE.DAY_VOTE){
      const votes=(this.actions[r]||{}).DAY_VOTE||{};
      const voters=Object.values(this.players).filter(p=>p.isAlive && !p.isExposedIdiot);
      const allVoted = voters.every(v=>votes[v.id]!==undefined);
      if(allVoted) await this.tallyDayVotes();
      return;
    }

    if(phase===PHASE.HUNTER_ACTION){
      await this.resolveAfterHunters();
      return;
    }

    // 其它阶段不自动
  },

  /* ---------- 阶段切换 ---------- */
  async setPhase(phase, round=null){
    const up={ 'state/phase': phase };
    if(round!=null) up['state/round']=round;
    if(phase===PHASE.NIGHT){
      const r = round!=null ? round : (this.state.round||0);
      up['state/showWolfTags'] = (r===1);
    }
    await db.ref(`games/${this.gameId}`).update(up);
  },

  /* ---------- 夜晚结算 ---------- */
  async resolveNight(){
    // 上锁，避免多主持/多端同时结算
    await db.ref(`games/${this.gameId}/state/resolvingNight`).transaction(v=> v ? v : true);
    if((await db.ref(`games/${this.gameId}/state/resolvingNight`).once('value')).val()!==true) return;

    const r=this.state.round;
    const night = (this.actions[r]||{}).NIGHT || {};
    const gNode = night.GUARD || {};
    const wNode = night.WOLVES || {};
    const witch = (this.actions[r]||{}).NIGHT_WITCH || {};

    // 守护目标（唯一守卫）
    const guardTarget = Object.values(gNode)[0]?.target ?? undefined; // undefined=无守卫或未出，null=空守
    // 狼刀
    const wolfTarget = wNode.alphaTarget || '0';
    // 女巫
    const cureTarget = Object.values(witch)[0]?.cure ?? null;
    const poisonTarget = Object.values(witch)[0]?.poison ?? null;

    await this.log(`[结算] 狼刀:${wolfTarget==='0'?'无':wolfTarget}, 守:${guardTarget===undefined?'无':(guardTarget===null?'空守':guardTarget)}, 解:${cureTarget||'无'}, 毒:${poisonTarget||'无'}`, true);

    // 生成死亡列表
    const deaths=[];
    if(wolfTarget && wolfTarget!=='0'){
      const savedByGuard = (guardTarget!==undefined && guardTarget!==null && Number(guardTarget)===Number(wolfTarget));
      const savedByCure  = (cureTarget && Number(cureTarget)===Number(wolfTarget));
      if(!(savedByGuard || savedByCure)) deaths.push({ pid:wolfTarget, cause:'NIGHT' });
    }
    if(poisonTarget && !deaths.some(d=>Number(d.pid)===Number(poisonTarget))){
      deaths.push({ pid:poisonTarget, cause:'POISON' });
    }

    if(deaths.length){
      const deadList=[...new Set(deaths.map(d=>Number(d.pid)))].sort((a,b)=>a-b);
      await this.log(`昨夜死亡的玩家是：${deadList.join('号、')}号`, false);
      await db.ref(`games/${this.gameId}/state/peaceInRow`).set(0);
    }else{
      await this.log('昨夜是平安夜。', false);
      const curPeace=this.state.peaceInRow||0;
      await db.ref(`games/${this.gameId}/state/peaceInRow`).set(curPeace+1);
    }

    // 执行死亡链
    let anySheriff=false;
    for(const d of deaths){
      const r2=await this.kill(d.pid, d.cause);
      if(r2.sheriffDied){ anySheriff=true; break; }
    }

    // 天亮后流程（默认进入 DAY_TALK）
    await this.handlePostDeath({ hunterTriggered:false, sheriffDied:anySheriff }, PHASE.DAY_TALK);

    // 解锁
    await db.ref(`games/${this.gameId}/state/resolvingNight`).set(null);
  },

  /* ---------- 决斗 ---------- */
  async knightResolve(targetId){
    const me=this.players[this.playerId];
    const target=this.players[targetId];
    if(!me || !target) return;

    const tRole=this.getActiveRole(target);
    const evil = tRole==='狼人' || tRole==='隐狼';
    const loser = evil ? targetId : this.playerId;

    if(evil){
      await this.log(`决斗成功！${targetId}号(${tRole}) 阵亡。`, false);
      await this.killAndChain(loser,'DUEL');
    }else{
      await this.log(`决斗失败！骑士 ${this.playerId}号 阵亡。`, false);
      await this.killAndChain(loser,'DUEL');
    }
  },

  /* ---------- 击杀与链式处理 ---------- */
  async killAndChain(pid, cause){
    const r=await this.kill(pid, cause);
    if(r.sheriffDied) return; // 等移交
    await this.resolveAfterHunters();
  },

  async kill(pid, cause){
    await this.log(`[系统] 处理 ${pid}号 死亡/出局 检查，原因: ${cause}`, true);
    let result={ hunterTriggered:false, sheriffDied:false };
    const ref=db.ref(`games/${this.gameId}/players/${pid}`);
    const before=(await ref.once('value')).val();
    if(!before || !before.isAlive) return result;

    const activeRole = this.getActiveRole(before);

    // 白痴首次被投票：翻牌免死，但掉一命；若因此出局（两条命都没了），按正常死亡处理
    if(cause==='VOTE' && activeRole==='白痴' && !before.isExposedIdiot){
      const after = await ref.transaction(p=>{
        if(!p || !p.isAlive) return p;
        p.isExposedIdiot = true;
        p.deaths = Math.min((p.deaths||0)+1, 2);
        if(p.deaths>=2) p.isAlive=false;
        return p;
      }).then(t=>t.snapshot.val());

      await this.log(`🤪 ${pid}号被投票，翻开白痴身份，免出局（掉一命，剩余心：${Math.max(0,2 - (after.deaths||0))}）`, false);
      // 只有真正出局（isAlive=false）才触发警徽移交
      if(!after.isAlive && before.badge){
        const nextPhase = PHASE.NIGHT; // 白天投票后进入夜晚
        await db.ref(`games/${this.gameId}/state`).update({
          phase: PHASE.SHERIFF_TRANSFER,
          postDeath: { deadSheriffId: pid, nextPhase, hunterTriggered: false }
        });
        result.sheriffDied=true;
        await this.log(`[系统] ${pid}号为警长且已出局，进入警徽移交阶段。`, true);
      }
      await this.checkWin();
      return result;
    }

    // 常规死亡 + 猎人触发
    const after = await ref.transaction(p=>{
      if(!p || !p.isAlive) return p;
      p.deaths = Math.min((p.deaths||0)+1, 2);
      if(p.deaths>=2) p.isAlive=false;
      return p;
    }).then(t=>t.snapshot.val());

    if(activeRole==='猎人' && ['NIGHT','VOTE','POISON','DUEL','HUNTER'].includes(cause)){
      await db.ref(`games/${this.gameId}/state/hunterQueue/${pid}`).set(true);
      result.hunterTriggered=true;
      await this.log(`[系统] ${pid}号是猎人，加入开枪队列。`, true);
    }

    // 出局的警长才移交
    if(!after.isAlive && before.badge){
      const nextPhase = (['NIGHT','POISON'].includes(cause)) ? PHASE.DAY_TALK : PHASE.NIGHT;
      await db.ref(`games/${this.gameId}/state`).update({
        phase: PHASE.SHERIFF_TRANSFER,
        postDeath: { deadSheriffId: pid, nextPhase, hunterTriggered: result.hunterTriggered }
      });
      result.sheriffDied=true;
      await this.log(`[系统] ${pid}号是警长且已出局，进入警徽移交阶段。`, true);
    }

    await this.checkWin();
    return result;
  },

  async resolveAfterHunters(){
    const queue=(await db.ref(`games/${this.gameId}/state/hunterQueue`).once('value')).val()||{};
    if(Object.values(queue).some(v=>v===true)){
      await this.setPhase(PHASE.HUNTER_ACTION);
      return;
    }
    // 没有待行动猎人，继续 postDeath.nextPhase 或默认 DAY_TALK
    const post=this.state.postDeath||{};
    const next = post.nextPhase || PHASE.DAY_TALK;
    await db.ref(`games/${this.gameId}/state/postDeath`).set(null);
    if(next===PHASE.NIGHT){
      await this.startNight((this.state.round||0)+1);
    }else{
      await this.setPhase(next);
    }
  },

  async handlePostDeath(resultOrObj, nextIfNoAction){
    // sheriff 移交优先
    const post=this.state.postDeath||{};
    if(post?.deadSheriffId) return;

    // 猎人行为
    const queue=(await db.ref(`games/${this.gameId}/state/hunterQueue`).once('value')).val()||{};
    if(Object.values(queue).some(v=>v===true)){
      await db.ref(`games/${this.gameId}/state/postDeath`).update({ nextPhase: nextIfNoAction });
      await this.setPhase(PHASE.HUNTER_ACTION);
      return;
    }

    // 正常进入下一阶段（夜晚结束 -> DAY_TALK）
    await this.setPhase(nextIfNoAction);
  },

  /* ---------- 警徽移交 ---------- */
  async badgePass(toId){
    const pd=this.state.postDeath||{};
    if(this.playerId!==pd.deadSheriffId) return this.notify('你无权操作警徽','error');
    const updates={};
    updates[`players/${pd.deadSheriffId}/badge`]=0;
    updates[`players/${toId}/badge`]=1;
    updates['state/postDeath']=null;
    await db.ref(`games/${this.gameId}`).update(updates);
    await this.log(`⭐ 警徽已由 ${pd.deadSheriffId}号 移交给 ${toId}号。`, false);
    if(pd.nextPhase===PHASE.NIGHT){
      await this.startNight((this.state.round||0)+1);
    }else{
      await this.setPhase(pd.nextPhase || PHASE.DAY_TALK);
    }
  },
  async badgeDestroy(){
    const pd=this.state.postDeath||{};
    if(this.playerId!==pd.deadSheriffId) return this.notify('你无权操作警徽','error');
    const updates={};
    updates[`players/${pd.deadSheriffId}/badge`]=0;
    updates['state/postDeath']=null;
    await db.ref(`games/${this.gameId}`).update(updates);
    await this.log(`💔 警徽已被 ${pd.deadSheriffId}号 撕毁。`, false);
    if(pd.nextPhase===PHASE.NIGHT){
      await this.startNight((this.state.round||0)+1);
    }else{
      await this.setPhase(pd.nextPhase || PHASE.DAY_TALK);
    }
  },

  /* ---------- 投票统计与票型美化 ---------- */
  buildVotePatternForDay(voters, votes, sheriffId){
    const groups={}; const abstain=[];
    voters.forEach(v=>{
      const t=votes[v.id]?.target;
      if(!t || t==='0'){ abstain.push(v.id); return; }
      (groups[t] ||= []).push(v.id);
    });
    const fmtWeight=(w)=> Number.isInteger(w)? `${w}票` : `${w.toFixed(1)}票`;
    const entries = Object.keys(groups).map(t=>{
      const arr = groups[t].sort((a,b)=>a-b);
      const weight = arr.reduce((s,vid)=> s + (vid.toString()===sheriffId?1.5:1), 0);
      const names = arr.map(vid=> vid.toString()===sheriffId? `${vid}号(警长)` : `${vid}号`).join(' ');
      return { t:Number(t), names, weight };
    }).sort((a,b)=> b.weight - a.weight || a.t - b.t);

    const lines=['—— 放逐投票票型 ——'];
    entries.forEach((e,i)=> lines.push(`${i+1}. ${e.t}号  ${e.names}  ----- ${fmtWeight(e.weight)}`));
    if(abstain.length) lines.push(`弃票  ${abstain.sort((a,b)=>a-b).map(x=>`${x}号`).join(' ')}`);
    return lines.join('\n');
  },
  buildVotePatternForSheriff(voters, votes){
    const groups={}; const abstain=[];
    voters.forEach(v=>{
      const t=votes[v.id];
      if(!t || t==='0'){ abstain.push(v.id); return; }
      (groups[t] ||= []).push(v.id);
    });
    const entries=Object.keys(groups).map(t=>{
      const arr=groups[t].sort((a,b)=>a-b);
      return { t:Number(t), names: arr.map(x=>`${x}号`).join(' '), cnt: arr.length };
    }).sort((a,b)=> b.cnt - a.cnt || a.t - b.t);
    const lines=['—— 警长投票票型 ——'];
    entries.forEach((e,i)=> lines.push(`${i+1}. ${e.t}号  ${e.names}  ----- ${e.cnt}票`));
    if(abstain.length) lines.push(`弃票  ${abstain.sort((a,b)=>a-b).map(x=>`${x}号`).join(' ')}`);
    return lines.join('\n');
  },

  async tallyDayVotes(){
    const r=this.state.round;
    const votes = (this.actions[r]||{}).DAY_VOTE||{};
    const voters = Object.values(this.players).filter(p=>p.isAlive && !p.isExposedIdiot);
    const sheriffId = Object.keys(this.players).find(id=>this.players[id].badge);

    const counts={};
    voters.forEach(v=>{
      const rec=votes[v.id]; const t=rec?.target;
      if(!t || t==='0') return;
      const w = (v.id.toString()===sheriffId)?3:2; // 3/2 权重
      counts[t]=(counts[t]||0)+w;
    });

    // 票型日志
    const pattern=this.buildVotePatternForDay(voters, votes, sheriffId);
    if(pattern) await this.log(pattern, false);

    const max=Object.keys(counts).length?Math.max(...Object.values(counts)):0;
    const outs=Object.keys(counts).filter(id=>counts[id]===max);
    if(outs.length===1){
      const id=outs[0];
      await this.log(`⚖️ ${id}号以 ${(counts[id]/2).toFixed(1)} 票被放逐。`, false);
      await this.killAndChain(id,'VOTE'); // 链式继续（猎人/警徽）
      // 若未进入猎人/警徽，正常进入下一夜
      const post=this.state.postDeath||{};
      const hasQueue = Object.values(this.state.hunterQueue||{}).some(v=>v===true);
      if(!post?.deadSheriffId && !hasQueue){
        await this.startNight(r+1);
      }
    }else{
      await this.log(outs.length>1?`⚖️ 平票：${outs.join('、')}号。无人出局。`:'⚖️ 无人出局。', false);
      await this.startNight(r+1);
    }
  },

  async tallySheriffVotes(){
    const cand=this.sheriff?.candidates||{}, drops=this.sheriff?.drops||{}, votes=this.sheriff?.votes||{};
    const valid = Object.keys(cand).filter(id=>cand[id] && !drops[id]);
    if(valid.length===0){
      await this.log('👮 本轮无候选人，取消选举', false);
      await db.ref(`games/${this.gameId}/sheriff`).set(null);
      await this.setPhase(PHASE.DAY_TALK);
      return;
    }
    const counts={}; const voters=Object.values(this.players).filter(p=>p.isAlive && !p.isExposedIdiot);
    voters.forEach(v=>{
      const t=votes[v.id]; if(!t || t==='0') return;
      if(!valid.includes(t)) return;
      counts[t]=(counts[t]||0)+1;
    });

    // 票型
    const pattern=this.buildVotePatternForSheriff(voters, votes);
    if(pattern) await this.log(pattern, false);

    const max=Object.keys(counts).length?Math.max(...Object.values(counts)):0;
    const winners=Object.keys(counts).filter(id=>counts[id]===max);
    const isPK=!!this.sheriff?.isPK;

    if(winners.length===1){
      const sid=winners[0];
      await db.ref(`games/${this.gameId}/players/${sid}/badge`).set(1);
      await this.log(`⭐ ${sid}号当选警长！`, false);
      await db.ref(`games/${this.gameId}/sheriff`).set(null);
      await this.setPhase(PHASE.DAY_TALK);
    }else if(valid.length===1){
      const sid=valid[0];
      await db.ref(`games/${this.gameId}/players/${sid}/badge`).set(1);
      await this.log(`⭐ ${sid}号独警，直接当选！`, false);
      await db.ref(`games/${this.gameId}/sheriff`).set(null);
      await this.setPhase(PHASE.DAY_TALK);
    }else{
      if(isPK){
        await this.log('⚖️ PK后再次平票，本轮无警长。', false);
        await db.ref(`games/${this.gameId}/sheriff`).set(null);
        await this.setPhase(PHASE.DAY_TALK);
      }else{
        const nextCand={}; winners.forEach(id=>nextCand[id]=1);
        await db.ref(`games/${this.gameId}/sheriff`).set({ candidates: nextCand, drops:{}, votes:{}, isPK:true });
        await this.setPhase(PHASE.SHERIFF_SPEECH);
      }
    }
  },

  /* ---------- 胜负判定 ---------- */
  isGoldenBaby(p){
    const [a,b]=p.identities||[];
    if(!a||!b) return false;
    const ar=a.role, br=b.role;
    const set = new Set([ar, br]);
    // 平民+平民 或 平民+盗贼（盗贼复制平民时发牌阶段已折算，但这里按原定义）
    return (set.has('平民') && (set.has('平民') || set.has('盗贼'))) && set.size<=2;
  },
  async checkWin(){
    // 好人胜：三连平安夜 或 狼人全部出局（无活跃狼身份）
    const wolvesAlive = Object.values(this.players).some(p=>p.isAlive && ['狼人','隐狼'].includes(this.getActiveRole(p)));
    const peaceInRow = this.state.peaceInRow||0;
    if(!wolvesAlive || peaceInRow>=3){
      await db.ref(`games/${this.gameId}/state`).update({ phase:PHASE.GAME_OVER, winner:`🏆 游戏结束 - 好人阵营胜利！(${!wolvesAlive?'狼人已全部出局':'连续三晚平安夜'})` });
      await this.log(`🏆 游戏结束 - 好人阵营胜利！(${!wolvesAlive?'狼人已全部出局':'连续三晚平安夜'})`, false);
      return true;
    }

    // 狼人胜：按设置
    const mode=this.settings.wolfWin||'edge';
    const alivePlayers = Object.values(this.players).filter(p=>p.isAlive);
    const goodAlive = alivePlayers.some(p=> !['狼人','隐狼'].includes(this.getActiveRole(p)) ); // 所有非狼均死 -> 屠城
    if(mode==='exterminate'){
      if(!goodAlive){
        await db.ref(`games/${this.gameId}/state`).update({ phase:PHASE.GAME_OVER, winner:'🐺 游戏结束 - 狼人阵营胜利！（屠城）' });
        await this.log('🐺 游戏结束 - 狼人阵营胜利！（屠城）', false);
        return true;
      }
    }else{
      // 屠边：神职全死 或 金宝宝全死
      const godAlive = alivePlayers.some(p=> (p.identities||[]).some(id=>GOD_ROLES.has(id.role)) );
      const goldenAlive = alivePlayers.some(p=> this.isGoldenBaby(p) );
      if(!godAlive || !goldenAlive){
        await db.ref(`games/${this.gameId}/state`).update({ phase:PHASE.GAME_OVER, winner:`🐺 游戏结束 - 狼人阵营胜利！（屠边：${!godAlive?'神职全灭':'金宝宝全灭'}）` });
        await this.log(`🐺 游戏结束 - 狼人阵营胜利！（屠边：${!godAlive?'神职全灭':'金宝宝全灭'}）`, false);
        return true;
      }
    }
    return false;
  },
});
