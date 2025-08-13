/* ========================================
   双身份狼人杀 - 精简版 App (FSM 重构)
   说明：
   - 采用单一状态机（phase）驱动流程，所有行动统一写入 actions 节点
   - 简化逻辑，确保规则与日志符合你的最新要求
   - 保持现有 index.html 和 styles.css 的结构不变（移动端三列布局不变）
   - 关键规则：
     * 守卫不可连续两晚守同一人；若上一晚空守（null），则下一晚可守任何人
     * 盗贼/白痴/猎人/女巫/预言家/守卫/骑士 各最多 1
     * 金宝宝（平民+平民 或 平民+盗贼）至少 1 对
     * 日间放逐投票：警长=1.5票，其他=1票（实现用 3/2 权重），日志显示票型
     * 普通狼人可见队友与投票/狼聊；隐狼不可见，不参与狼聊；当仅剩隐狼时由隐狼拍板
     * 玩家日志公开信息仅包含：夜晚死亡/平安夜、上警名单/退水、警长投票票型、放逐票型、白痴翻牌、猎人开枪、骑士决斗
       上帝视角可见全部秘密日志：狼刀/守卫/女巫/预言家等
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

/* 角色定义与默认配置 */
const ROLES = {
  '平民': { faction: 'good', isGod: false, icon: '👤' },
  '守卫': { faction: 'good', isGod: true, icon: '🛡️' },
  '白痴': { faction: 'good', isGod: true, icon: '🤪' },
  '预言家': { faction: 'good', isGod: true, icon: '🔮' },
  '骑士': { faction: 'good', isGod: true, icon: '⚔️' },
  '女巫': { faction: 'good', isGod: true, icon: '🧪' },
  '猎人': { faction: 'good', isGod: true, icon: '🔫' },
  '狼人': { faction: 'bad',  isGod: false, icon: '🐺' },
  '隐狼': { faction: 'bad',  isGod: false, icon: '🌑', isInvisible: true },
  '盗贼': { faction: 'neutral', isGod: false, isThief: true, icon: '🎭' },
};
const DEFAULT_SETUP = { '平民': 6, '守卫': 1, '白痴': 1, '预言家': 1, '骑士': 1, '女巫': 1, '猎人': 1, '狼人': 2, '隐狼': 1, '盗贼': 1 };

/* 有且仅有 1 的角色集合 */
const UNIQUE_ROLES = new Set(['盗贼','白痴','猎人','女巫','预言家','守卫','骑士']);

/* 状态机阶段 */
const PHASE = {
  SETUP: 'SETUP',
  NIGHT_GUARD: 'NIGHT_GUARD',
  NIGHT_SEER: 'NIGHT_SEER',
  NIGHT_WOLVES: 'NIGHT_WOLVES',
  NIGHT_WITCH: 'NIGHT_WITCH',
  DAWN_RESOLVE: 'DAWN_RESOLVE',
  DAY_TALK: 'DAY_TALK',
  DAY_VOTE: 'DAY_VOTE',
  HUNTER_ACTION: 'HUNTER_ACTION',
  SHERIFF_CAND: 'SHERIFF_CAND',
  SHERIFF_SPEECH: 'SHERIFF_SPEECH',
  SHERIFF_VOTE: 'SHERIFF_VOTE',
  SHERIFF_TRANSFER: 'SHERIFF_TRANSFER',
  GAME_OVER: 'GAME_OVER',
};

/* App 主对象 */
const App = {
  gameId: null,
  playerId: null,        // '0' 为上帝视角
  isHost: false,
  state: null,           // games/<gid>/state
  settings: null,        // games/<gid>/settings
  players: {},           // games/<gid>/players
  actions: {},           // games/<gid>/actions
  sheriff: null,         // games/<gid>/sheriff
  full: null,            // 完整游戏树快照

  selection: null,       // 本地选择（不落库）
  wolfVotesOff: null,    // 狼投票监听 off
  wolfChatOff: null,     // 狼聊监听 off

  /* ----------------- 工具 ----------------- */
  $(id){ return document.getElementById(id) },
  escapeHTML(s){ return typeof s==='string' ? s.replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])) : '' },
  notify(msg,type='info',ms=3000){
    const c=this.$('notification-container'); if(!c) return;
    const n=document.createElement('div');
    n.className=`notification ${type}`;
    n.innerHTML=`<div class="notification-content">${this.escapeHTML(msg)}</div>`;
    c.appendChild(n);
    setTimeout(()=>n.classList.add('show'),10);
    setTimeout(()=>{ n.classList.add('fade-out'); setTimeout(()=>n.remove(),300) },ms);
  },
  async log(message,isSecret=false){
    const entry={ message, round:this.state?.round||0, timestamp:firebase.database.ServerValue.TIMESTAMP, isSecret };
    await db.ref(`games/${this.gameId}/logs`).push(entry);
  },
  shuffle(a){ let i=a.length,r; while(i){ r=Math.floor(Math.random()*i--); [a[i],a[r]]=[a[r],a[i]] } return a; },

  /* ----------------- 初始化 ----------------- */
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
    const tgt=this.$(`${name}-view`);
    if(tgt){ tgt.classList.remove('hidden'); setTimeout(()=>tgt.classList.add('view-active'),10); }
  },

  /* ----------------- 事件 ----------------- */
  async onClick(e){
    const btn=e.target.closest('button[data-action]'); if(!btn) return;
    const act=btn.dataset.action;

    // 通用操作
    if(act==='open-logs'){ this.openModal('logs-modal'); return; }
    if(act==='close-modal'){ this.closeModal(btn.dataset.target); return; }
    if(act==='copy-link'){ const el=this.$(btn.dataset.inputid); if(el){ try{ await navigator.clipboard.writeText(el.value); this.notify('链接已复制','success'); }catch{ el.select(); document.execCommand('copy'); this.notify('链接已复制','success'); } } return; }

    // 需要游戏上下文
    switch(act){
      /* 创建与进入 */
      case 'create-game': await this.createGame(); return;
      case 'join-as-creator': {
        const gid = btn.dataset.gameid || btn.getAttribute('value');
        if(!gid){ this.notify('未获取到游戏ID','error'); return; }
        this.gameId=gid; this.playerId='1';
        history.pushState(null,'',`?game=${this.gameId}&player=${this.playerId}`);
        this.startApp(); return;
      }

      /* 主持操作（仅主持人） */
      case 'host-start': if(!this.isHost) return this.notify('仅主持可操作','error'); await this.startNight(1); return;
      case 'host-next':  if(!this.isHost) return this.notify('仅主持可操作','error'); await this.advance(false); return;
      case 'host-open-day-vote': if(!this.isHost) return this.notify('仅主持可操作','error'); await this.setPhase(PHASE.DAY_VOTE); return;
      case 'host-tally-day': if(!this.isHost) return this.notify('仅主持可操作','error'); await this.tallyDayVotes(); return;
      case 'host-tally-sheriff': if(!this.isHost) return this.notify('仅主持可操作','error'); await this.tallySheriffVotes(); return;
      case 'host-force-start': if(!this.isHost) return this.notify('仅主持可操作','error'); await this.hostForceStartGame(); return;
      case 'host-force-end-night': if(!this.isHost) return this.notify('仅主持可操作','error'); await this.hostForceEndNight(); return;
      case 'host-force-end-cand': if(!this.isHost) return this.notify('仅主持可操作','error'); await this.hostForceEndSheriffCand(); return;
      case 'host-force-end-dayvote': if(!this.isHost) return this.notify('仅主持可操作','error'); await this.hostForceEndDayVote(); return;
      case 'host-force-end-sheriffvote': if(!this.isHost) return this.notify('仅主持可操作','error'); await this.hostForceEndSheriffVote(); return;

      /* 身份确认 */
      case 'swap-identities': await this.swapIdentities(); return;
      case 'confirm-identities': await this.setPlayerReady(true); return;

      /* 夜间技能与投票/白天行动 */
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

  /* ----------------- 模态框 ----------------- */
  openModal(id){ const m=this.$(id); if(!m) return; m.classList.add('open'); m.querySelector('.modal-overlay')?.addEventListener('click',()=>this.closeModal(id),{once:true}); },
  closeModal(id){ const m=this.$(id); if(!m) return; m.classList.remove('open'); },

  /* ----------------- 监听 ----------------- */
  async startApp(){
    const s=await db.ref(`games/${this.gameId}`).once('value');
    if(!s.exists()){
      document.body.innerHTML = `<div class="error-container" style="text-align:center; margin-top: 100px;">
        <div style="font-size:48px;">😵</div><h2>游戏不存在</h2>
        <p>房间已关闭或链接无效</p>
        <button onclick="location.href='?'" class="btn-primary" style="margin-top:20px;">返回首页</button></div>`;
      return;
    }
    if(this.playerId==='0'){
      // 上帝视角
      this.showView('god');
    }else{
      this.showView('game');
    }

    db.ref(`games/${this.gameId}`).on('value', snap=>{
      if(!snap.exists()) return;
      this.full = snap.val();
      this.state = this.full.state || {};
      this.players = this.full.players || {};
      this.actions = this.full.actions || {};
      this.sheriff = this.full.sheriff || null;
      this.settings = this.full.settings || { witchSelfSaveRule:'noFirstNightSelfSave', seerMode:'faction', wolfWin:'edge' };
      if(this.playerId!=='0'){
        const me=this.players[this.playerId];
        if(!me){
          document.body.innerHTML = `<div class="error-container" style="text-align:center; margin-top: 100px;">
            <div style="font-size:48px;">❌</div><h2>无法加入游戏</h2>
            <p>你不是该房间的玩家或已被移除</p>
            <button onclick="location.href='?'" class="btn-primary" style="margin-top:20px;">返回首页</button></div>`;
          return;
        }
        this.isHost = Number(this.playerId) === Number(this.state.hostId);
        this.renderAll();
        // 夜晚狼人监听
        this.refreshWolfListeners();
      }else{
        this.renderGod();
      }
      // 玩家日志监听（公开日志）
      this.renderLogsLive();
    });
  },

  /* ----------------- 视图渲染 ----------------- */
  renderAll(){
    const me=this.players[this.playerId];
    this.$('host-badge')?.classList.toggle('hidden', !this.isHost);
    this.$('sheriff-badge-top')?.classList.toggle('hidden', !(me && me.badge));

    this.renderStatus();
    this.renderIdentityCard();
    this.renderPersistentInfo();
    this.renderActionPanel();
    this.renderPlayerGrid();
    this.renderHostPanel();
  },
  renderStatus(){
    const map = {
      [PHASE.SETUP]: '⏳ 等待所有玩家确认身份',
      [PHASE.NIGHT_GUARD]: `🌙 第 ${this.state.round} 夜 · 守卫行动`,
      [PHASE.NIGHT_SEER]:  `🌙 第 ${this.state.round} 夜 · 预言家行动`,
      [PHASE.NIGHT_WOLVES]:`🌙 第 ${this.state.round} 夜 · 狼人商议`,
      [PHASE.NIGHT_WITCH]: `🌙 第 ${this.state.round} 夜 · 女巫行动`,
      [PHASE.DAWN_RESOLVE]:'🌤️ 天亮结算中',
      [PHASE.DAY_TALK]:    `☀️ 第 ${this.state.round} 天 · 发言`,
      [PHASE.DAY_VOTE]:    `☀️ 第 ${this.state.round} 天 · 放逐投票`,
      [PHASE.SHERIFF_CAND]:'👑 上警意向',
      [PHASE.SHERIFF_SPEECH]:'👑 上警发言/退水',
      [PHASE.SHERIFF_VOTE]:'👑 警长投票',
      [PHASE.HUNTER_ACTION]:'🔫 猎人开枪',
      [PHASE.SHERIFF_TRANSFER]:'💔 警长阵亡 · 移交或撕毁',
      [PHASE.GAME_OVER]: this.state.winner || '🏁 游戏结束'
    };
    const el=this.$('status-bar'); if(el) el.innerHTML = `<span class="status-text">${map[this.state.phase]||'游戏进行中'}</span>`;
  },
  renderIdentityCard(){
    if(this.playerId==='0') return;
    const p=this.players[this.playerId]; if(!p) return;
    const fmt = (id)=> id.isThiefCopy
      ? `<span class="identity-item"><span class="identity-icon thief-icon">🎭</span><span class="identity-name thief-copy-text">${id.role}</span></span>`
      : `<span class="identity-item"><span class="identity-icon">${ROLES[id.role].icon}</span><span class="identity-name">${id.role}</span></span>`;
    const h1 = p.deaths>=1 ? '<span class="identity-dead">' : '';
    const h2 = p.deaths>=2 ? '<span class="identity-dead">' : '';
    let html = `
      <div class="identity-header">你的身份</div>
      <div class="identity-display">
        ${h1}${fmt(p.identities[0])}${p.deaths>=1?'</span>':''}
        <span class="identity-separator">+</span>
        ${h2}${fmt(p.identities[1])}${p.deaths>=2?'</span>':''}
      </div>`;
    if(this.state.phase===PHASE.SETUP && !p.isReady){
      html += `<div class="identity-actions">
        <button class="control-btn" data-action="swap-identities"><span>🔄 交换身份</span></button>
        <button class="confirm-btn" data-action="confirm-identities"><span>✓ 确认身份</span></button>
      </div>`;
    }
    const el=this.$('identity-card'); if(el) el.innerHTML=html;
  },
  renderPersistentInfo(){
    let html='';
    if(this.playerId!=='0' && this.getActiveRole(this.players[this.playerId])==='预言家'){
      const rec=(this.players[this.playerId].skillStates||{})['global_seerResults']||{};
      const mode=this.settings.seerMode||'faction';
      const keys=Object.keys(rec);
      if(keys.length){
        html+=`<div class="seer-results">
          <div class="seer-title">🔮 查验记录 (${mode==='faction'?'阵营':'身份'})</div>
          <div class="seer-list">${keys.map(k=>`<span class="seer-item">${k}号: <strong>${this.escapeHTML(rec[k])}</strong></span>`).join(' ')}</div>
        </div>`;
      }
    }
    const el=this.$('persist'); if(el){ el.innerHTML=html; el.classList.toggle('hidden', !html); }
  },
  renderPlayerGrid(){
    const L=this.$('player-grid-left'), R=this.$('player-grid-right'); if(!L||!R) return;
    L.innerHTML=''; R.innerHTML='';
    const arr = Object.values(this.players).sort((a,b)=>a.id-b.id);
    const half = Math.ceil(arr.length/2);

    const viewerType = this.getViewerWolfType();
    const round = this.state.round||0;
    const wolfPhaseActions = (this.actions[round]||{})[PHASE.NIGHT_WOLVES]||{};
    const alphaTarget = wolfPhaseActions.alphaTarget || null;
    const votes = wolfPhaseActions.votes || {};

    const canSeeTeam = (p)=>{
      if(viewerType!=='regular') return false;
      return p.isAlive && this.getActiveRole(p)==='狼人';
    };

    const selectable = (p)=>{
      if(!this.selection) return false;
      if(!p.isAlive) return false;
      const me=this.players[this.playerId];
      switch(this.selection.type){
        case 'guard': {
          // 不可连续守同人；若上次空守（null），则不限
          const last = this.getSkillState('lastGuardTarget', me);
          return p.id!==me.id && (last==null || Number(last)!==Number(p.id));
        }
        case 'seer': return p.id!==me.id;
        case 'wolf-vote': return true;
        case 'witch-poison': return !p.isExposedIdiot && p.id!==me.id;
        case 'day-vote': return !p.isExposedIdiot;
        case 'knight': return !p.isExposedIdiot && p.id!==me.id;
        case 'hunter': return true;
        case 'sheriff-vote': {
          const cand = (this.sheriff?.candidates)||{};
          const drops = (this.sheriff?.drops)||{};
          return !!cand[p.id] && !drops[p.id];
        }
        case 'badge-pass': return p.id!==me.id && p.isAlive;
      }
      return false;
    };

    const isSelected = (p)=> this.selection && Number(this.selection.targetId)===Number(p.id);

    const make = (p)=>{
      const lives=2-p.deaths;
      const card=document.createElement('div');
      card.className='player-card';
      if(this.playerId && Number(this.playerId)===Number(p.id)) card.classList.add('me');
      if(!p.isAlive) card.classList.add('disabled');
      if(this.selection && !selectable(p)) card.classList.add('disabled');
      if(isSelected(p)) card.classList.add('selected');
      if(alphaTarget && Number(alphaTarget)===Number(p.id) && viewerType==='regular' && this.state.phase===PHASE.NIGHT_WOLVES){
        card.classList.add('wolf-final-target');
      }

      let wolfBadges='';
      if(viewerType==='regular' && this.state.phase===PHASE.NIGHT_WOLVES){
        const voterIds=Object.entries(votes).filter(([,t])=>Number(t)===Number(p.id)).map(([vid])=>Number(vid)).sort((a,b)=>a-b);
        wolfBadges=voterIds.map((vid,idx)=>`<span class="wolf-corner" style="top:${4+idx*16}px">${vid}</span>`).join('');
      }

      const tags=[];
      if(canSeeTeam(p)) tags.push('<span class="tag tag-team">队友</span>');
      if(p.isExposedIdiot) tags.push('<span class="tag tag-idiot">白痴</span>');

      card.innerHTML=`
        <div class="player-number">${p.id}${p.badge?'<span class="sheriff-icon">👑</span>':''}</div>
        <div class="tagline">${tags.join('')}</div>
        <div class="hearts"><span class="heart ${lives<1?'off':''}">❤</span><span class="heart ${lives<2?'off':''}">❤</span></div>
        ${wolfBadges}
      `;
      if(this.selection && selectable(p)){
        card.style.cursor='pointer';
        card.addEventListener('click',()=>{
          this.selection.targetId = p.id.toString();
          this.renderActionPanel();
          this.renderPlayerGrid();
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

    const phase=this.state.phase;
    const ps=Object.values(this.players).sort((a,b)=>a.id-b.id);
    const round=this.state.round||0;

    const tag = (p, done)=> `<span class="player-tag ${done?'done':'pending'}">${p.id}号</span>`;
    const section = (title, doneList, pendingList)=> `
      <div class="host-status">
        <div class="host-status-title">${title}</div>
        <div class="status-category">
          <div class="category-title">已完成:</div>
          <div class="player-tags">${doneList.length?doneList.join(''):'<span style="color:var(--text-tertiary);">无</span>'}</div>
        </div>
        <div class="status-category">
          <div class="category-title">未完成:</div>
          <div class="player-tags">${pendingList.length?pendingList.join(''):'<span style="color:var(--text-tertiary);">无</span>'}</div>
        </div>
      </div>`;

    let html = `<div class="host-panel">`;

    // SETUP：显示准备情况；增加“强制开始”
    if(phase===PHASE.SETUP){
      const ready=ps.filter(p=>p.isReady), pend=ps.filter(p=>!p.isReady);
      html += section(`玩家准备 (${ready.length}/${ps.length})`,
        ready.map(p=>tag(p,true)), pend.map(p=>tag(p,false)));
      html += `<div class="host-actions" style="display:flex;gap:8px;">
        <button class="confirm-btn" data-action="host-start" ${pend.length>0?'disabled':''}>🚀 开始游戏</button>
        <button class="action-btn" data-action="host-force-start">⚡ 强制开始</button>
      </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    // 夜间阶段：不显示进度，避免暴露信息；提供“强制结束夜晚”
    if([PHASE.NIGHT_GUARD,PHASE.NIGHT_SEER,PHASE.NIGHT_WOLVES,PHASE.NIGHT_WITCH,PHASE.DAWN_RESOLVE].includes(phase)){
      html += `<div class="host-status">
        <div class="host-status-title">夜间行动中（出于保密，夜间不显示操作进度）</div>
      </div>
      <div class="host-actions" style="display:flex;gap:8px;">
        <button class="action-btn" data-action="host-force-end-night">🌅 强制结束夜晚</button>
      </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    // 上警意向：显示谁已决定/未决定；提供“强制结束上警”
    if(phase===PHASE.SHERIFF_CAND){
      const cand=this.sheriff?.candidates||{};
      const decided=ps.filter(p=>p.isAlive && cand[p.id]!==undefined);
      const pending=ps.filter(p=>p.isAlive && cand[p.id]===undefined);
      html += section(`上警意向 (${decided.length}/${ps.filter(p=>p.isAlive).length})`,
        decided.map(p=>tag(p,true)), pending.map(p=>tag(p,false)));
      html += `<div class="host-actions" style="display:flex;gap:8px;">
        <button class="action-btn" data-action="host-force-end-cand">⏭️ 强制结束上警</button>
        <button class="confirm-btn" data-action="host-next">➡️ 推进</button>
      </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    // 上警发言：仅提供推进
    if(phase===PHASE.SHERIFF_SPEECH){
      html += `<div class="host-actions" style="display:flex;gap:8px;">
        <button class="confirm-btn" data-action="host-next">➡️ 进入警长投票</button>
      </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    // 警长投票：显示已投/未投；提供“强制结束投票”
    if(phase===PHASE.SHERIFF_VOTE){
      const votes=this.sheriff?.votes||{};
      const voters=ps.filter(p=>p.isAlive && !p.isExposedIdiot);
      const done=voters.filter(p=>votes[p.id]!==undefined);
      const pend=voters.filter(p=>votes[p.id]===undefined);
      html += section(`警长投票 (${done.length}/${voters.length})`,
        done.map(p=>tag(p,true)), pend.map(p=>tag(p,false)));
      html += `<div class="host-actions" style="display:flex;gap:8px;">
        <button class="action-btn" data-action="host-force-end-sheriffvote">🗳️ 强制结束投票</button>
        <button class="confirm-btn" data-action="host-tally-sheriff" ${pend.length>0?'disabled':''}>📊 统计</button>
      </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    // 白天发言：提供开启投票/推进
    if(phase===PHASE.DAY_TALK){
      html += `<div class="host-actions" style="display:flex;gap:8px;">
        <button class="confirm-btn" data-action="host-open-day-vote">🗳️ 开启放逐投票</button>
        <button class="control-btn" data-action="host-next">➡️ 推进</button>
      </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    // 白天投票：显示已投/未投；提供“强制结束投票”
    if(phase===PHASE.DAY_VOTE){
      const votes=(this.actions[round]||{})[PHASE.DAY_VOTE]||{};
      const voters=ps.filter(p=>p.isAlive && !p.isExposedIdiot);
      const done=voters.filter(p=>votes[p.id]!==undefined);
      const pend=voters.filter(p=>votes[p.id]===undefined);
      html += section(`放逐投票 (${done.length}/${voters.length})`,
        done.map(p=>tag(p,true)), pend.map(p=>tag(p,false)));
      html += `<div class="host-actions" style="display:flex;gap:8px;">
        <button class="action-btn" data-action="host-force-end-dayvote">🗳️ 强制结束投票</button>
        <button class="confirm-btn" data-action="host-tally-day" ${pend.length>0?'disabled':''}>📊 统计</button>
      </div>`;
      el.innerHTML=html+`</div>`; return;
    }

    // 猎人/警徽移交/结束
    if(phase===PHASE.HUNTER_ACTION){
      html += `<div class="host-status"><div class="host-status-title">猎人行动阶段</div></div>`;
      el.innerHTML=html+`</div>`; return;
    }
    if(phase===PHASE.SHERIFF_TRANSFER){
      html += `<div class="host-status"><div class="host-status-title">警徽移交阶段</div></div>`;
      el.innerHTML=html+`</div>`; return;
    }
    if(phase===PHASE.GAME_OVER){
      html += `<div class="host-status"><div class="host-status-title">🎮 游戏已结束</div></div>`;
      el.innerHTML=html+`</div>`; return;
    }

    // 兜底
    html += `<div class="host-actions"><button class="control-btn" data-action="host-next">➡️ 推进</button></div>`;
    el.innerHTML=html+`</div>`;
  },

  renderActionPanel(){
    const panel=this.$('action-panel'); if(!panel || this.playerId==='0'){ if(panel) panel.innerHTML=''; return; }
    const me=this.players[this.playerId]; if(!me){ panel.innerHTML=''; return; }
    const phase=this.state.phase; const round=this.state.round||0;
    const selTxt = (t)=> `<div class="action-target">当前目标：<strong>${t?`${t}号`:'未选择'}</strong></div>`;

    // 便捷：设置选择类型
    const ensureSel=(type)=>{ if(!this.selection || this.selection.type!==type){ this.selection={ type, targetId:null }; } };

    // SETUP
    if(phase===PHASE.SETUP){
      const hasThiefCopy = me.identities.some(id=>id.isThiefCopy);
      panel.innerHTML = `<div class="action-feedback">${hasThiefCopy?'你拥有盗贼复制身份，可调整顺序后确认。':'请确认身份，等待主持人开始游戏。'}</div>`;
      return;
    }

    // 夜间阶段
    if(phase===PHASE.NIGHT_GUARD && this.getActiveRole(me)==='守卫'){
      ensureSel('guard');
      const last=this.getSkillState('lastGuardTarget',me); // null 表示空守，允许任意
      panel.innerHTML = `
        <div class="action-prompt">请选择今晚要守护的玩家（不可连续守同一人）</div>
        ${selTxt(this.selection.targetId)}
        <div class="action-buttons">
          <button class="control-btn" data-action="skip-selection">🛡️ 空守</button>
          <button class="confirm-btn" data-action="confirm-selection" ${!this.selection.targetId?'disabled':''}>✅ 确认守护</button>
        </div>
        <div class="action-feedback">上次守护：${last===undefined?'无（未行动）':(last===null?'空守':`${last}号`)}</div>`;
      return;
    }
    if(phase===PHASE.NIGHT_SEER && this.getActiveRole(me)==='预言家'){
      ensureSel('seer');
      panel.innerHTML = `
        <div class="action-prompt">请选择今晚要查验的玩家：</div>
        ${selTxt(this.selection.targetId)}
        <div class="action-buttons">
          <button class="control-btn" data-action="skip-selection">🤔 跳过</button>
          <button class="confirm-btn" data-action="confirm-selection" ${!this.selection.targetId?'disabled':''}>✅ 确认查验</button>
        </div>`;
      return;
    }
    if(phase===PHASE.NIGHT_WOLVES && this.canWolfAct(me)){
      ensureSel('wolf-vote');
      const viewerType=this.getViewerWolfType();
      panel.innerHTML = `
        <div class="action-prompt">请选择今晚要袭击的玩家（拍板狼确认）：</div>
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
        </div>`:''}`;
      return;
    }
    if(phase===PHASE.NIGHT_WITCH && this.getActiveRole(me)==='女巫'){
      ensureSel('witch-poison');
      const wolfAct = ((this.actions[round]||{})[PHASE.NIGHT_WOLVES])||{};
      const target = wolfAct.alphaTarget || null;
      const isFirstNight = round===1;
      const lifeIdx = me.deaths;
      const usedCure = !!this.getSkillState('hasUsedCure', me, lifeIdx);
      const usedPoison = !!this.getSkillState('hasUsedPoison', me, lifeIdx);
      const canCure = !usedCure && target && target!=='0';
      const canPoison = !usedPoison;
      // 自救规则
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
            <button class="action-btn" data-action="confirm-selection" ${!canPoison || !this.selection.targetId?'disabled':''}>☠️ 使用毒药</button>
          </div>
          ${!canCure && !canPoison ? '<div class="action-feedback">本条命的药水已用尽</div>':''}
        </div>`;
      return;
    }

    // 白天
    if(phase===PHASE.DAY_TALK && this.getActiveRole(me)==='骑士' && !this.getSkillState('hasUsedDuel',me)){
      ensureSel('knight');
      panel.innerHTML = `
        <div class="action-prompt">骑士可以选择一名玩家发起决斗：</div>
        ${selTxt(this.selection.targetId)}
        <div class="action-buttons">
          <button class="confirm-btn" data-action="confirm-selection" ${!this.selection.targetId?'disabled':''}>⚔️ 决斗</button>
        </div>`;
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

    // 上警流程
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
            <button class="confirm-btn" data-action="badge-pass" ${!this.selection.targetId?'disabled':''} data-to="${this.selection.targetId||''}">👑 移交</button>
          </div>`;
      }else{
        panel.innerHTML = `<div class="action-feedback">等待警长移交警徽...</div>`;
      }
      return;
    }

    if(phase===PHASE.DAWN_RESOLVE){
      panel.innerHTML = `<div class="action-feedback">结算中，请等待主持人推进...</div>`;
      return;
    }

    if(phase===PHASE.GAME_OVER){
      panel.innerHTML = `<div class="action-feedback">${this.state.winner||'游戏结束'}</div>`;
      return;
    }

    panel.innerHTML = `<div class="action-feedback">请等待...</div>`;
  },

  renderGod(){
    // 玩家列表
    const list=this.$('god-player-list'); if(list){
      list.innerHTML='';
      const fmt=(id)=> `<span class="${id.isThiefCopy?'thief-copy':''}">${ROLES[id.role].icon} ${id.role}</span>`;
      Object.values(this.players).sort((a,b)=>a.id-b.id).forEach(p=>{
        const lives=2-p.deaths;
        const row=document.createElement('div');
        row.className=`god-row ${!p.isAlive?'dead-all':''}`;
        row.innerHTML=`
          <div class="god-player-number"><span class="player-id">${p.id}号</span>${p.badge?'<span class="sheriff-icon">👑</span>':''}</div>
          <div class="god-identities">
            <span class="${p.deaths>=1?'dead-identity':''}">${fmt(p.identities[0])}</span>
            <span class="identity-plus">+</span>
            <span class="${p.deaths>=2?'dead-identity':''}">${fmt(p.identities[1])}</span>
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
    // 玩家端仅公开日志
    if(this.playerId==='0') return;
    const cont=this.$('game-log-content'); if(!cont) return;
    cont.innerHTML='';
    const ref=db.ref(`games/${this.gameId}/logs`).limitToLast(300);
    ref.off(); // 重绑
    ref.on('child_added', s=>{
      const v=s.val(); if(!v || v.isSecret) return;
      const d=document.createElement('div');
      d.className='log-item';
      const prefix=v.round>0?`<span class="log-round">[第${v.round}轮]</span> `:'';
      d.innerHTML = prefix + this.escapeHTML(v.message);
      cont.appendChild(d); cont.scrollTop=cont.scrollHeight;
    });
  },

  /* ----------------- 角色与权限 ----------------- */
  getActiveRole(p){
    if(!p || !p.isAlive) return null;
    if(p.deaths>=p.identities.length) return null;
    return p.identities[p.deaths]?.role || null;
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
      const hasAliveWolf = Object.values(this.players).some(pp=>pp.isAlive && this.getActiveRole(pp)==='狼人');
      return !hasAliveWolf; // 仅剩隐狼时可行动
    }
    return false;
  },
  getAlphaWolfId(){
    const alive = Object.values(this.players).filter(p=>p.isAlive);
    const regs = alive.filter(p=>this.getActiveRole(p)==='狼人').map(p=>p.id);
    if(regs.length) return Math.min(...regs).toString();
    const hides = alive.filter(p=>this.getActiveRole(p)==='隐狼').map(p=>p.id);
    if(hides.length) return Math.min(...hides).toString();
    return null;
  },

  /* ----------------- 行动：本地选择 ----------------- */
  async confirmSelection(){
    const sel=this.selection; if(!sel) return;
    const me=this.players[this.playerId];
    const round=this.state.round;

    const writeAction = async (phase, payload)=> {
      await db.ref(`games/${this.gameId}/actions/${round}/${phase}/${this.playerId}`).set({ ...payload, ts: firebase.database.ServerValue.TIMESTAMP });
    };

    switch(sel.type){
      case 'guard': {
        // 记录守护目标，并存 lastGuardTarget
        await writeAction(PHASE.NIGHT_GUARD, { target: sel.targetId });
        await this.setSkillState('lastGuardTarget', Number(sel.targetId), me);
        this.notify(`你守护了 ${sel.targetId}号`,'success');
        break;
      }
      case 'seer': {
        // 查验结果写入自己的 skillStates(global)
        const res = this.seerResult(Number(sel.targetId));
        await writeAction(PHASE.NIGHT_SEER, { target: sel.targetId, result: res });
        const rec=(this.getGlobalSkillState('seerResults')||{}); rec[sel.targetId]=res;
        await this.setGlobalSkillState('seerResults', rec);
        await this.log(`🔮 预言家(${this.playerId}号)查验 ${sel.targetId}号，结果为 ${res}`, true);
        this.notify(`查验结果：${sel.targetId}号 → ${res}`, 'success');
        break;
      }
      case 'wolf-vote': {
        // 狼人仅记录投票；拍板另有 wolf-confirm
        await db.ref(`games/${this.gameId}/actions/${round}/${PHASE.NIGHT_WOLVES}/votes/${this.playerId}`).set(sel.targetId);
        this.notify(`已投票：${sel.targetId==='0'?'空刀':sel.targetId+'号'}`,'success');
        break;
      }
      case 'witch-poison': {
        // 只写 poison，解药通过 witchCure
        await writeAction(PHASE.NIGHT_WITCH, { poison: sel.targetId });
        await this.setSkillState('hasUsedPoison', true, me);
        await this.log(`🧪 女巫(${this.playerId}号)毒杀了 ${sel.targetId}号`, true);
        this.notify(`你毒杀了 ${sel.targetId}号`, 'error');
        break;
      }
      case 'day-vote': {
        await db.ref(`games/${this.gameId}/actions/${round}/${PHASE.DAY_VOTE}/${this.playerId}`).set({ target: sel.targetId, ts: firebase.database.ServerValue.TIMESTAMP });
        this.notify(`已投票：${sel.targetId}号`,'success');
        break;
      }
      case 'knight': {
        await this.setSkillState('hasUsedDuel', true, me);
        await this.log(`⚔️ 骑士 ${this.playerId}号 对 ${sel.targetId}号 发动决斗！`, false);
        const targetRole=this.getActiveRole(this.players[sel.targetId]);
        const evil = targetRole==='狼人' || targetRole==='隐狼';
        const loser = evil ? sel.targetId : this.playerId;
        const loserRole = evil ? targetRole : this.getActiveRole(me);
        const r=await this.kill(loser,'DUEL');
        if(evil){
          await this.log(`决斗成功！${loser}号(${loserRole}) 阵亡。`, false);
          await this.handlePostDeath(r, 'NIGHT_GUARD'); // 直接进入夜晚
        }else{
          await this.log(`决斗失败！骑士 ${loser}号 阵亡。`, false);
          await this.handlePostDeath(r, 'DAY_TALK');
        }
        break;
      }
      case 'hunter': {
        await this.log(`🔫 猎人 ${this.playerId}号 开枪带走了 ${sel.targetId}号！`, false);
        await db.ref(`games/${this.gameId}/state/hunterQueue/${this.playerId}`).set(null);
        const r=await this.kill(sel.targetId,'HUNTER');
        if(r.sheriffDied) return; // 等待移交
        await this.resolveAfterHunters();
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
      case 'guard':
        await db.ref(`games/${this.gameId}/actions/${round}/${PHASE.NIGHT_GUARD}/${this.playerId}`).set({ target: null, ts: firebase.database.ServerValue.TIMESTAMP });
        await this.setSkillState('lastGuardTarget', null, me);
        this.notify('你选择了空守','info');
        break;
      case 'seer':
        await db.ref(`games/${this.gameId}/actions/${round}/${PHASE.NIGHT_SEER}/${this.playerId}`).set({ target: null, ts: firebase.database.ServerValue.TIMESTAMP });
        this.notify('你跳过了查验','info');
        break;
      case 'wolf-vote':
        await db.ref(`games/${this.gameId}/actions/${round}/${PHASE.NIGHT_WOLVES}/votes/${this.playerId}`).set('0');
        this.notify('已选择空刀','info');
        break;
      case 'witch-poison':
        await db.ref(`games/${this.gameId}/actions/${round}/${PHASE.NIGHT_WITCH}/${this.playerId}`).set({ skipped: true, ts: firebase.database.ServerValue.TIMESTAMP });
        this.notify('女巫未使用毒药','info');
        break;
      case 'day-vote':
        await db.ref(`games/${this.gameId}/actions/${round}/${PHASE.DAY_VOTE}/${this.playerId}`).set({ target:'0', ts: firebase.database.ServerValue.TIMESTAMP });
        this.notify('已投弃票','info');
        break;
      case 'sheriff-vote':
        await db.ref(`games/${this.gameId}/sheriff/votes/${this.playerId}`).set('0');
        this.notify('已为警长投弃票','info');
        break;
      case 'badge-pass':
        await this.badgeDestroy();
        break;
    }
    this.selection=null; this.renderActionPanel(); this.renderPlayerGrid();
  },

  /* ----------------- 夜间：女巫与狼人特有 ----------------- */
  async witchCure(targetId){
    if(!targetId) return;
    const me=this.players[this.playerId];
    const round=this.state.round;
    const rule=this.settings.witchSelfSaveRule||'noFirstNightSelfSave';
    const isFirstNight = round===1;
    if(Number(targetId)===Number(this.playerId)){
      if((rule==='noFirstNightSelfSave' && isFirstNight) || (rule==='onlyFirstNightSelfSave' && !isFirstNight)){
        return this.notify('本轮不可自救','error');
      }
    }
    const used = !!this.getSkillState('hasUsedCure', me, me.deaths);
    if(used) return this.notify('解药已用过','error');
    await db.ref(`games/${this.gameId}/actions/${round}/${PHASE.NIGHT_WITCH}/${this.playerId}`).update({ cure: targetId, ts: firebase.database.ServerValue.TIMESTAMP });
    await this.setSkillState('hasUsedCure', true, me);
    await this.log(`🧪 女巫(${this.playerId}号)使用解药救了 ${targetId}号`, true);
    this.notify(`你救了 ${targetId}号`,'success');
  },

  async wolfConfirm(value){
    const myId=this.playerId;
    const alpha=this.getAlphaWolfId();
    if(myId!==alpha) return this.notify('你不是拍板狼','error');
    const me=this.players[myId]; if(!this.canWolfAct(me)) return this.notify('当前不可确认','error');
    const round=this.state.round;
    const ref=db.ref(`games/${this.gameId}/actions/${round}/${PHASE.NIGHT_WOLVES}`);
    await ref.transaction(cur=>{
      if(cur && cur.alphaTarget!=null) return; // 已有拍板
      return { ...(cur||{}), alphaTarget: value||'0', alphaActor: myId, ts: firebase.database.ServerValue.TIMESTAMP };
    });
    await this.log(`🐺 狼队决定袭击 ${value==='0'?'空刀':value+'号'} (由${myId}号确认)`, true);
    this.notify(`已确认袭击 ${value==='0'?'空刀':value+'号'}`,'success');
    this.selection=null; this.renderActionPanel(); this.renderPlayerGrid();
  },

  refreshWolfListeners(){
    // 清理
    if(this.wolfVotesOff){ this.wolfVotesOff(); this.wolfVotesOff=null; }
    if(this.wolfChatOff){ this.wolfChatOff(); this.wolfChatOff=null; }

    if(this.playerId==='0') return;
    const me=this.players[this.playerId]; if(!me) return;
    const type=this.getViewerWolfType();
    if(this.state.phase!==PHASE.NIGHT_WOLVES || !type) return;

    const round=this.state.round;
    // 投票显示
    const disp = this.$('wolf-votes-display');
    const votesRef = db.ref(`games/${this.gameId}/actions/${round}/${PHASE.NIGHT_WOLVES}`);
    const handler = (snap)=>{
      const v=snap.val()||{};
      const votes=v.votes||{};
      const alphaId=this.getAlphaWolfId();
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
      const chatRef=db.ref(`games/${this.gameId}/wolfChat`).limitToLast(80);
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
    if(msg.length>120) return this.notify('消息过长','error');
    db.ref(`games/${this.gameId}/wolfChat`).push({ pid:this.playerId, msg, ts: firebase.database.ServerValue.TIMESTAMP });
    el.value='';
  },

  /* ----------------- 上警流程 ----------------- */
  async sheriffCand(v){
    const alive=this.players[this.playerId]?.isAlive;
    if(!alive) return;
    await db.ref(`games/${this.gameId}/sheriff/candidates/${this.playerId}`).set(v?1:0);
    if(v) this.notify('你选择了上警','success'); else this.notify('你选择了不上警','info');
  },
  async sheriffDrop(){
    await db.ref(`games/${this.gameId}/sheriff/drops/${this.playerId}`).set(1);
    this.notify('你已退水','info');
  },
  async tallySheriffVotes(){
    const cand=this.sheriff?.candidates||{}, drops=this.sheriff?.drops||{}, votes=this.sheriff?.votes||{};
    const valid = Object.keys(cand).filter(id=>cand[id] && !drops[id]);
    if(valid.length===0){
      await this.log('👑 本轮无候选人，跳过选举', false);
      await db.ref(`games/${this.gameId}/sheriff`).set(null);
      await this.setPhase(PHASE.DAY_TALK);
      return;
    }
    // 统计
    const counts={}; const voters=Object.values(this.players).filter(p=>p.isAlive && !p.isExposedIdiot);
    voters.forEach(v=>{
      const t=votes[v.id]; if(!t || t==='0') return;
      if(!valid.includes(t)) return;
      counts[t]=(counts[t]||0)+1;
    });
    // 日志票型（警长投票一人一票）
    const pattern=this.buildVotePatternForSheriff(voters, votes);
    if(pattern) await this.log(`警长投票票型：\n${pattern}`, false);

    const max = Object.keys(counts).length?Math.max(...Object.values(counts)):0;
    const winners = Object.keys(counts).filter(id=>counts[id]===max);
    const isPK = !!this.sheriff?.isPK;
    if(winners.length===1){
      const sid=winners[0];
      await db.ref(`games/${this.gameId}/players/${sid}/badge`).set(1);
      await this.log(`👑 ${sid}号当选警长！`, false);
      await db.ref(`games/${this.gameId}/sheriff`).set(null);
      await this.setPhase(PHASE.DAY_TALK);
    }else if(valid.length===1){
      // 独警
      const sid=valid[0];
      await db.ref(`games/${this.gameId}/players/${sid}/badge`).set(1);
      await this.log(`👑 ${sid}号独警，直接当选！`, false);
      await db.ref(`games/${this.gameId}/sheriff`).set(null);
      await this.setPhase(PHASE.DAY_TALK);
    }else{
      if(isPK){
        await this.log('⚖️ PK后再次平票，本轮无警长。', false);
        await db.ref(`games/${this.gameId}/sheriff`).set(null);
        await this.setPhase(PHASE.DAY_TALK);
      }else{
        // 进入 PK：仅平票者为候选人
        const nextCand={}; winners.forEach(id=>nextCand[id]=1);
        await db.ref(`games/${this.gameId}/sheriff`).set({ candidates: nextCand, drops:{}, votes:{}, isPK:true });
        await this.setPhase(PHASE.SHERIFF_SPEECH);
      }
    }
  },

  /* ----------------- 日间投票统计 ----------------- */
  async tallyDayVotes(){
    const round=this.state.round;
    const votes = (this.actions[round]||{})[PHASE.DAY_VOTE]||{};
    const voters = Object.values(this.players).filter(p=>p.isAlive && !p.isExposedIdiot);
    const sheriffId = Object.keys(this.players).find(id=>this.players[id].badge);

    const counts={};
    voters.forEach(v=>{
      const rec=votes[v.id]; const t=rec?.target;
      if(!t || t==='0') return;
      const w = (v.id.toString()===sheriffId)?3:2; // 3/2 权重
      counts[t]=(counts[t]||0)+w;
    });

    // 票型日志（显示 1.5/1 形式）
    const pattern=this.buildVotePatternForDay(voters, votes, sheriffId);
    if(pattern) await this.log(`放逐投票票型：\n${pattern}`, false);

    const max=Object.keys(counts).length?Math.max(...Object.values(counts)):0;
    const outs=Object.keys(counts).filter(id=>counts[id]===max);
    if(outs.length===1){
      const id=outs[0];
      await this.log(`⚖️ ${id}号以 ${(counts[id]/2).toFixed(1)} 票被放逐。`, false);
      const r=await this.kill(id,'VOTE');
      await this.handlePostDeath(r, PHASE.NIGHT_GUARD, true); // 夜晚开始新一轮
    }else{
      await this.log(outs.length>1?`⚖️ 平票：${outs.join('、')}号。无人出局。`:'⚖️ 无人出局。', false);
      await this.setPhase(PHASE.NIGHT_GUARD, this.state.round+1);
    }
  },

  buildVotePatternForDay(voters, votes, sheriffId){
    // 形如：
    // 2号 1号 3号(警长) 4号 ----- 3.5票
    // 4号 2号 5号 7号 ----- 3票
    // 弃票 6号 8号
    const groups={}; const abstain=[];
    voters.forEach(v=>{
      const t=votes[v.id]?.target;
      if(!t || t==='0'){ abstain.push(v.id); return; }
      if(!groups[t]) groups[t]=[];
      groups[t].push(v.id);
    });
    const lines=[];
    Object.keys(groups).sort((a,b)=>Number(a)-Number(b)).forEach(t=>{
      const vs=groups[t].sort((a,b)=>a-b);
      const weight = vs.reduce((sum,vid)=> sum + (vid.toString()===sheriffId?1.5:1), 0);
      const names = vs.map(vid=> vid.toString()===sheriffId ? `${vid}号(警长)` : `${vid}号`).join(' ');
      lines.push(`${t}号 ${names} ----- ${weight.toFixed(1)}票`);
    });
    if(abstain.length){
      lines.push(`弃票 ${abstain.sort((a,b)=>a-b).map(x=>`${x}号`).join(' ')}`);
    }
    return lines.join('\n');
  },
  buildVotePatternForSheriff(voters, votes){
    const groups={}; const abstain=[];
    voters.forEach(v=>{
      const t=votes[v.id];
      if(!t || t==='0'){ abstain.push(v.id); return; }
      if(!groups[t]) groups[t]=[];
      groups[t].push(v.id);
    });
    const lines=[];
    Object.keys(groups).sort((a,b)=>Number(a)-Number(b)).forEach(t=>{
      const vs=groups[t].sort((a,b)=>a-b).map(x=>`${x}号`).join(' ');
      lines.push(`${t}号 ${vs} ----- ${groups[t].length}票`);
    });
    if(abstain.length) lines.push(`弃票 ${abstain.sort((a,b)=>a-b).map(x=>`${x}号`).join(' ')}`);
    return lines.join('\n');
  },

  /* ----------------- 阶段推进（主持） ----------------- */
  async startNight(round){
    await db.ref(`games/${this.gameId}/actions/${round}`).set(null);
    await this.setPhase(PHASE.NIGHT_GUARD, round);
  },
  async advance(force=false){
    const phase=this.state.phase, round=this.state.round;
    const alive = Object.values(this.players).filter(p=>p.isAlive);
    const roleExists = (r)=> alive.some(p=>this.getActiveRole(p)===r);

    if(phase===PHASE.NIGHT_GUARD){
      if(!roleExists('守卫') || force || await this.phaseHasAction(PHASE.NIGHT_GUARD)) return this.setPhase(PHASE.NIGHT_SEER);
      return this.notify('等待守卫行动','info');
    }
    if(phase===PHASE.NIGHT_SEER){
      if(!roleExists('预言家') || force || await this.phaseHasAction(PHASE.NIGHT_SEER)) return this.setPhase(PHASE.NIGHT_WOLVES);
      return this.notify('等待预言家行动','info');
    }
    if(phase===PHASE.NIGHT_WOLVES){
      const wolvesAlive = alive.some(p=>['狼人','隐狼'].includes(this.getActiveRole(p)));
      if(!wolvesAlive || force || await this.wolvesConfirmed()) return this.setPhase(PHASE.NIGHT_WITCH);
      return this.notify('等待狼人拍板','info');
    }
    if(phase===PHASE.NIGHT_WITCH){
      if(!roleExists('女巫') || force || await this.phaseHasAction(PHASE.NIGHT_WITCH)) return this.resolveNight();
      return this.notify('等待女巫行动','info');
    }
    if(phase===PHASE.DAWN_RESOLVE){
      return; // 由 resolveNight 内推进
    }
    if(phase===PHASE.DAY_TALK){
      // 首日可进入上警（若未产生警长）
      const hasSheriff = Object.values(this.players).some(p=>p.badge);
      if(round===1 && !hasSheriff) return this.setPhase(PHASE.SHERIFF_CAND);
      return this.setPhase(PHASE.DAY_VOTE);
    }
    if(phase===PHASE.DAY_VOTE){
      return this.tallyDayVotes();
    }
    if(phase===PHASE.SHERIFF_CAND){
      return this.setPhase(PHASE.SHERIFF_SPEECH);
    }
    if(phase===PHASE.SHERIFF_SPEECH){
      return this.setPhase(PHASE.SHERIFF_VOTE);
    }
    if(phase===PHASE.SHERIFF_VOTE){
      return this.tallySheriffVotes();
    }
    if(phase===PHASE.HUNTER_ACTION){
      return this.resolveAfterHunters();
    }
    if(phase===PHASE.SHERIFF_TRANSFER){
      // 等待阵亡警长操作；主持推进为无操作则默认撕毁
      const ds=this.state.postDeath?.deadSheriffId;
      if(ds){
        await this.badgeDestroy(true);
      }
      return;
    }
  },
  async setPhase(phase, round=null){
    const up={ 'state/phase': phase };
    if(round!=null) up['state/round']=round;
    await db.ref(`games/${this.gameId}`).update(up);
  },
  async phaseHasAction(phase){
    const r=this.state.round;
    const snap=await db.ref(`games/${this.gameId}/actions/${r}/${phase}`).once('value');
    return snap.exists();
  },
  async wolvesConfirmed(){
    const r=this.state.round;
    const v=(await db.ref(`games/${this.gameId}/actions/${r}/${PHASE.NIGHT_WOLVES}`).once('value')).val()||{};
    return v.alphaTarget!=null;
  },
   async hostForceStartGame(){
    if(this.state.phase!==PHASE.SETUP) return this.notify('当前不是准备阶段','error');
    const updates={};
    Object.values(this.players).forEach(p=>{
      updates[`players/${p.id}/isReady`] = true;
      // 身份顺序按当前展示锁定，无需额外写入
    });
    await db.ref(`games/${this.gameId}`).update(updates);
    await this.startNight(1);
  },
   async hostForceEndNight(){
    const r=this.state.round;
    // 守卫：无行动则空守 + 记录 lastGuardTarget=null
    const guardP = Object.values(this.players).find(p=>p.isAlive && this.getActiveRole(p)==='守卫');
    if(guardP){
      const gAct = (this.actions[r]||{})[PHASE.NIGHT_GUARD]?.[guardP.id];
      if(!gAct){
        await db.ref(`games/${this.gameId}/actions/${r}/${PHASE.NIGHT_GUARD}/${guardP.id}`)
          .set({ target:null, ts:firebase.database.ServerValue.TIMESTAMP });
        const lifeIdx=guardP.deaths;
        await db.ref(`games/${this.gameId}/players/${guardP.id}/skillStates/${lifeIdx}_lastGuardTarget`).set(null);
      }
    }
    // 预言家：无行动则 target:null
    const seerP = Object.values(this.players).find(p=>p.isAlive && this.getActiveRole(p)==='预言家');
    if(seerP){
      const sAct = (this.actions[r]||{})[PHASE.NIGHT_SEER]?.[seerP.id];
      if(!sAct){
        await db.ref(`games/${this.gameId}/actions/${r}/${PHASE.NIGHT_SEER}/${seerP.id}`)
          .set({ target:null, ts:firebase.database.ServerValue.TIMESTAMP });
      }
    }
    // 狼人：若未拍板则空刀
    const wRef = db.ref(`games/${this.gameId}/actions/${r}/${PHASE.NIGHT_WOLVES}`);
    const wolfAct = (await wRef.once('value')).val()||{};
    if(wolfAct.alphaTarget==null){
      const alpha=this.getAlphaWolfId();
      await wRef.update({ alphaTarget:'0', alphaActor: alpha||'0', ts: firebase.database.ServerValue.TIMESTAMP });
    }
    // 女巫：若存在但未行动则视为 skipped
    const witchP = Object.values(this.players).find(p=>p.isAlive && this.getActiveRole(p)==='女巫');
    if(witchP){
      const wAct = (this.actions[r]||{})[PHASE.NIGHT_WITCH]?.[witchP.id];
      if(!wAct){
        await db.ref(`games/${this.gameId}/actions/${r}/${PHASE.NIGHT_WITCH}/${witchP.id}`)
          .set({ skipped:true, ts:firebase.database.ServerValue.TIMESTAMP });
      }
    }

    // 结算夜晚；首夜 -> 上警；后续 -> 白天
    const hasSheriff = Object.values(this.players).some(p=>p.badge);
    const next = (this.state.round===1 && !hasSheriff) ? PHASE.SHERIFF_CAND : PHASE.DAY_TALK;
    await this.resolveNight(next);
  },
   async hostForceEndSheriffCand(){
    if(this.state.phase!==PHASE.SHERIFF_CAND) return this.notify('当前不是上警阶段','error');
    const cand=this.sheriff?.candidates||{};
    const updates={};
    Object.values(this.players).forEach(p=>{
      if(p.isAlive && cand[p.id]===undefined){
        updates[`sheriff/candidates/${p.id}`]=0;
      }
    });
    if(Object.keys(updates).length){
      await db.ref(`games/${this.gameId}`).update(updates);
    }
    await this.setPhase(PHASE.SHERIFF_SPEECH);
  },
   async hostForceEndDayVote(){
    if(this.state.phase!==PHASE.DAY_VOTE) return this.notify('当前不是放逐投票阶段','error');
    const r=this.state.round;
    const votes=(this.actions[r]||{})[PHASE.DAY_VOTE]||{};
    const voters=Object.values(this.players).filter(p=>p.isAlive && !p.isExposedIdiot);
    const updates={};
    voters.forEach(v=>{
      if(votes[v.id]===undefined){
        updates[`actions/${r}/${PHASE.DAY_VOTE}/${v.id}`]={ target:'0', ts:firebase.database.ServerValue.TIMESTAMP };
      }
    });
    if(Object.keys(updates).length){
      await db.ref(`games/${this.gameId}`).update(updates);
    }
    await this.tallyDayVotes();
  },
   async hostForceEndSheriffVote(){
    if(this.state.phase!==PHASE.SHERIFF_VOTE) return this.notify('当前不是警长投票阶段','error');
    const votes=this.sheriff?.votes||{};
    const voters=Object.values(this.players).filter(p=>p.isAlive && !p.isExposedIdiot);
    const updates={};
    voters.forEach(v=>{
      if(votes[v.id]===undefined){
        updates[`sheriff/votes/${v.id}`]='0';
      }
    });
    if(Object.keys(updates).length){
      await db.ref(`games/${this.gameId}`).update(updates);
    }
    await this.tallySheriffVotes();
  },
   

  /* ----------------- 夜晚结算 ----------------- */
async resolveNight(nextIfNoAction = PHASE.DAY_TALK){
    await this.setPhase(PHASE.DAWN_RESOLVE);
    const r=this.state.round;
    const guard = (this.actions[r]||{})[PHASE.NIGHT_GUARD]||{};
    const wolf  = (this.actions[r]||{})[PHASE.NIGHT_WOLVES]||{};
    const witch = (this.actions[r]||{})[PHASE.NIGHT_WITCH]||{};

    const wolfTarget = wolf.alphaTarget||null;
    const guardTarget = Object.values(guard)[0]?.target ?? undefined; // 守卫唯一
    const cureTarget = Object.values(witch)[0]?.cure ?? null;
    const poisonTarget = Object.values(witch)[0]?.poison ?? null;

    await this.log(`[结算] 狼刀:${wolfTarget||'无'}, 守:${guardTarget===undefined?'无':(guardTarget===null?'空守':guardTarget)}, 解:${cureTarget||'无'}, 毒:${poisonTarget||'无'}`, true);

    const deaths=[];
    if(wolfTarget && wolfTarget!=='0'){
      const saved = (guardTarget!==undefined && guardTarget!==null && Number(guardTarget)===Number(wolfTarget)) || (cureTarget && Number(cureTarget)===Number(wolfTarget));
      if(!saved) deaths.push({ pid:wolfTarget, cause:'NIGHT' });
    }
    if(poisonTarget){
      if(!deaths.some(d=>Number(d.pid)===Number(poisonTarget))){
        deaths.push({ pid:poisonTarget, cause:'POISON' });
      }
      await this.log(`🧪 女巫使用毒药杀害了 ${poisonTarget}号`, false);
    }

    if(deaths.length){
      const deadList=[...new Set(deaths.map(d=>Number(d.pid)))].sort((a,b)=>a-b);
      await this.log(`昨夜死亡的玩家是：${deadList.join('号、')}号`, false);
    }else{
      await this.log('昨夜是平安夜。', false);
    }

    let anyHunter=false, anySheriff=false;
    for(const d of deaths){
      const r2=await this.kill(d.pid, d.cause);
      anyHunter = anyHunter || r2.hunterTriggered;
      if(r2.sheriffDied){ anySheriff=true; break; }
    }
    await this.handlePostDeath({ hunterTriggered:anyHunter, sheriffDied:anySheriff }, nextIfNoAction);
  },

  /* ----------------- 击杀与后续 ----------------- */
  async kill(pid, cause){
    await this.log(`[系统] 处理 ${pid}号 死亡，原因: ${cause}`, true);
    let result={ hunterTriggered:false, sheriffDied:false };
    const ref=db.ref(`games/${this.gameId}/players/${pid}`);
    const before=(await ref.once('value')).val();
    if(!before || !before.isAlive) return result;
    const activeRole = this.getActiveRole(before);

    // 白痴投票免死翻牌
    if(cause==='VOTE' && activeRole==='白痴' && !before.isExposedIdiot){
      await ref.update({ isExposedIdiot:true });
      await this.log(`🤪 ${pid}号被投票出局，翻开白痴身份，本轮免于死亡！`, false);
      return result;
    }

    const after = await ref.transaction(p=>{
      if(!p || !p.isAlive) return p;
      p.deaths = Math.min((p.deaths||0)+1, 2);
      if(p.deaths>=2) p.isAlive=false;
      return p;
    }).then(t=>t.snapshot.val());

    // 猎人
    if(activeRole==='猎人' && ['NIGHT','VOTE','POISON','DUEL'].includes(cause)){
      await db.ref(`games/${this.gameId}/state/hunterQueue/${pid}`).set(true);
      result.hunterTriggered=true;
      await this.log(`[系统] ${pid}号是猎人，加入开枪队列。`, true);
    }
    // 警长
    if(!after.isAlive && before.badge){
      const nextPhase = (cause==='NIGHT' || cause==='POISON') ? PHASE.DAY_TALK : PHASE.NIGHT_GUARD;
      await db.ref(`games/${this.gameId}/state`).update({ phase: PHASE.SHERIFF_TRANSFER, postDeath: { deadSheriffId: pid, nextPhase, hunterTriggered: result.hunterTriggered } });
      result.sheriffDied=true;
      await this.log(`[系统] ${pid}号是警长且已死亡，进入警徽移交阶段。`, true);
    }

    // 胜负判定
    await this.checkWin();
    return result;
  },
  async handlePostDeath(resultOrObj, nextIfNoAction, isEndOfDay=false){
    const r = Array.isArray(resultOrObj)? {} : resultOrObj;
    if(r.sheriffDied) return; // 等待移交
    if(await this.checkWin()) return;

    const queue=(await db.ref(`games/${this.gameId}/state/hunterQueue`).once('value')).val()||{};
    if(Object.values(queue).some(v=>v===true)){
      // 需要进入猎人行动
      await db.ref(`games/${this.gameId}/state/postDeath`).update({ nextPhase: isEndOfDay?PHASE.NIGHT_GUARD:nextIfNoAction });
      await this.setPhase(PHASE.HUNTER_ACTION);
    }else{
      // 没有猎人，进入下一阶段
      if(isEndOfDay){
        await this.setPhase(PHASE.NIGHT_GUARD, this.state.round+1);
      }else{
        await this.setPhase(nextIfNoAction);
      }
    }
  },

  async badgePass(toId){
    const pd=this.state.postDeath||{};
    if(this.playerId!==pd.deadSheriffId) return this.notify('你无权操作警徽','error');
    const updates={};
    updates[`players/${pd.deadSheriffId}/badge`]=0;
    updates[`players/${toId}/badge`]=1;
    updates['state/postDeath']=null;
    await db.ref(`games/${this.gameId}`).update(updates);
    await this.log(`👑 警徽已由 ${pd.deadSheriffId}号 移交给 ${toId}号。`, false);
    await this.setPhase(pd.nextPhase || PHASE.DAY_TALK);
  },
  async badgeDestroy(force=false){
    const pd=this.state.postDeath||{};
    if(!force && this.playerId!==pd.deadSheriffId) return this.notify('你无权操作警徽','error');
    const updates={};
    updates[`players/${pd.deadSheriffId}/badge`]=0;
    updates['state/postDeath']=null;
    await db.ref(`games/${this.gameId}`).update(updates);
    await this.log(`💔 警徽已被 ${pd.deadSheriffId}号 撕毁。`, false);
    await this.setPhase(pd.nextPhase || PHASE.DAY_TALK);
  },

  /* ----------------- 胜负判定 ----------------- */
  async checkWin(){
    // 以“当前场上生效身份阵营”判定
    const all=Object.values(this.players);
    const wolvesAlive = all.some(p=>p.isAlive && ['狼人','隐狼'].includes(this.getActiveRole(p)));
    const goodsAlive = all.some(p=>p.isAlive && !['狼人','隐狼'].includes(this.getActiveRole(p)));
    if(!wolvesAlive){
      await db.ref(`games/${this.gameId}/state`).update({ phase:PHASE.GAME_OVER, winner:'游戏结束 - 好人阵营胜利！(狼人已全部出局)' });
      await this.log('🏆 游戏结束 - 好人阵营胜利！(狼人已全部出局)', false);
      return true;
    }
    // 连续平安夜胜利（可根据需要添加计数；此精简版不计）
    return false;
  },

  /* ----------------- 工具：身份/技能状态 ----------------- */
  getSkillState(key, p=null, lifeIdx=-1){
    const pl=p||this.players[this.playerId]; if(!pl) return undefined;
    const i=lifeIdx!==-1?lifeIdx:pl.deaths;
    return (pl.skillStates||{})[`${i}_${key}`];
  },
  async setSkillState(key, val, p=null){
    const pl=p||this.players[this.playerId]; if(!pl) return;
    const i=pl.deaths;
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
      return hasRegularWolf?'狼人':'好人'; // 隐狼视为好人
    }else{
      return this.getActiveRole(p)||'未知';
    }
  },

  /* ----------------- 身份确认与准备 ----------------- */
  async swapIdentities(){
    const me=this.players[this.playerId]; if(!me || this.state.phase!==PHASE.SETUP) return;
    const ids=[me.identities[1], me.identities[0]];
    await db.ref(`games/${this.gameId}/players/${this.playerId}/identities`).set(ids);
    this.notify('身份已交换','success');
  },
  async setPlayerReady(v){
    await db.ref(`games/${this.gameId}/players/${this.playerId}/isReady`).set(!!v);
    this.notify('身份已确认','success');
  },

  /* ----------------- 创建游戏/发牌 ----------------- */
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
      if(b.classList.contains('plus')) val=Math.min(10, val+1);
      else val=Math.max(0, val-1);
      input.value=val;
      this.updateRoleStats();
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

    const roleSetup={};
    this.$('role-grid').querySelectorAll('input').forEach(i=>{
      const name=i.id.replace('role-',''); const c=+i.value;
      if(c>0) roleSetup[name]=c;
    });

    // 校验：唯一角色最多 1
    for(const r of UNIQUE_ROLES){
      if((roleSetup[r]||0)>1){
        return this.createFail(`【${r}】最多 1 张`);
      }
    }

    const pool=[];
    Object.entries(roleSetup).forEach(([role,count])=>{ for(let i=0;i<count;i++) pool.push(role); });
    if(pool.length===0 || pool.length%2!==0) return this.createFail('身份总数需为偶数且大于0');

    const dealt = this.deal(pool);
    if(!dealt) return this.createFail('无法生成符合规则的牌组，请调整配置。');

    const gameId = db.ref('games').push().key;
    const playerCount = dealt.finalPairs.length;
    const players={};
    for(let i=1;i<=playerCount;i++){
      players[i]={ id:i, identities: dealt.finalPairs[i-1], deaths:0, isAlive:true, isReady:false, isExposedIdiot:false, skillStates:{}, badge:0 };
    }
    const settings={
      witchSelfSaveRule: this.$('opt-witch-selfsave').value,
      seerMode: this.$('opt-seer-mode').value,
      wolfWin: this.$('opt-wolf-win').value,
      playerCount
    };
    const init={
      state:{ phase:PHASE.SETUP, round:0, hostId:1, winner:null, hunterQueue:{}, postDeath:null },
      players,
      settings,
      actions:{},
      sheriff:null,
      logs:{},
      rawDeck: dealt.rawDeck
    };
    await db.ref(`games/${gameId}`).set(init);

    // UI 展示
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
    // 返回 { finalPairs: [[{role,isThiefCopy},{role,isThiefCopy}],...], rawDeck: [...] }
    for(let t=0;t<5000;t++){
      const deck=this.shuffle([...pool]);
      const rawPairs=[]; const finalPairs=[];
      let ok=true; let golden=0;

      for(let i=0;i<deck.length;i+=2){
        const a=deck[i], b=deck[i+1];
        if(a==='盗贼' && b==='盗贼'){ ok=false; break; }
        rawPairs.push([a,b]);

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

  /* ----------------- 其它 ----------------- */
  async setPhaseAndRound(phase, round){ await db.ref(`games/${this.gameId}/state`).update({ phase, round }); }
};

/* 全局暴露 */
window.App = App;
document.addEventListener('DOMContentLoaded', ()=>App.init());
