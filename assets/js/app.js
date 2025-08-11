/* =========================================
   双身份狼人杀 - V9.5
   - 优化UI：增强选中玩家卡片的视觉效果。
   - 修复狼人刀人逻辑：普通狼人点击即投票，无需确认；仅拍板狼在狼窝确认最终目标。
   - 优化主持人上警视图：清晰展示上警、不上警和等待中的玩家列表。
========================================= */

const firebaseConfig={apiKey:"AIzaSyCEAgB6DoY8YA6lZnYblhIDVTYH_q8UimI",authDomain:"werewolf-game-master-1f37f.firebaseapp.com",databaseURL:"https://werewolf-game-master-1f37f-default-rtdb.asia-southeast1.firebasedatabase.app",projectId:"werewolf-game-master-1f37f",storageBucket:"werewolf-game-master-1f37f.appspot.com",messagingSenderId:"626014452910",appId:"1:626014452910:web:35b6eba412f95f1878013f"};
firebase.initializeApp(firebaseConfig);
const db=firebase.database();

const ROLES={'平民':{faction:'good',isGod:false,icon:'👤'},'守卫':{faction:'good',isGod:true,icon:'🛡️'},'白痴':{faction:'good',isGod:true,icon:'🤪'},'预言家':{faction:'good',isGod:true,icon:'🔮'},'骑士':{faction:'good',isGod:true,icon:'⚔️'},'隐狼':{faction:'bad',isGod:false,isInvisible:true,icon:'🌑'},'女巫':{faction:'good',isGod:true,icon:'🧪'},'猎人':{faction:'good',isGod:true,icon:'🔫'},'狼人':{faction:'bad',isGod:false,icon:'🐺'},'盗贼':{faction:'neutral',isGod:false,isThief:true,icon:'🎭'}};
const DEFAULT_SETUP={'平民':6,'守卫':1,'白痴':1,'预言家':1,'骑士':1,'女巫':1,'猎人':1,'狼人':2,'隐狼':1,'盗贼':1};
const FORBIDDEN_RAW=[['预言家','狼人'],['预言家','隐狼'],['盗贼','隐狼'],['隐狼','狼人'],['隐狼','隐狼']];

const App={
  gameId:null, playerId:null, isHost:false,
  allPlayers:{}, playerData:null, fullGameData:null, gameState:null,
  gameListener:null, logListener:null, logQueryRef:null, seenLogKeys:new Set(),
  wolfChatListener:null, wolfVotesListener:null, wolfVotesCallbackRef:null,
  selection:null,

  $(id){return document.getElementById(id)},
  escapeHTML(s){return typeof s==='string'?s.replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])):''},
  showNotification(msg,type='info',duration=5000){const c=this.$('notification-container');const d=document.createElement('div');d.className=`notification ${type}`;d.textContent=this.escapeHTML(msg);c.appendChild(d);setTimeout(()=>d.remove(),duration);},
  async addGameLog(message,isSecret=false){const entry={message,round:this.gameState?.round||0,timestamp:firebase.database.ServerValue.TIMESTAMP,isSecret}; await db.ref(`games/${this.gameId}/logs`).push(entry);},
  _shuffle(a){let i=a.length,r;while(i){r=Math.floor(Math.random()*i--);[a[i],a[r]]=[a[r],a[i]]}return a;},

  async init(){
    const q=new URLSearchParams(location.search);
    this.gameId=q.get('game'); this.playerId=q.get('player');

    if(this.gameId && this.playerId==='PLAYER_ID'){
      const app=document.querySelector('.app');
      app.innerHTML=`<div style="background:var(--panel);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);padding:14px;animation:fade-up .3s;">
        <h3 style="margin:0 0 8px;text-align:center">输入你的座位号</h3>
        <div class="info-box">请输入法官分配给你的座位号（数字），然后点击加入游戏。</div>
        <div class="inline" style="justify-content:center"><input type="number" id="player-id-input" placeholder="座位号" style="width:140px"><button class="confirm-btn" id="join-game-btn">加入游戏</button></div>
      </div>`;
      document.getElementById('join-game-btn').addEventListener('click',()=>{
        const id=document.getElementById('player-id-input').value;
        if(id && !isNaN(id) && id>0){ const u=new URL(location.href); u.searchParams.set('player',id); location.href=u.toString(); }
        else this.showNotification('请输入有效座位号','error');
      });
      return;
    }

    document.body.addEventListener('click',this.handleGlobalClick.bind(this));

    if(!this.gameId){ this.showView('setup'); this.renderRoleSetup(); }
    else { await this.startApp(); }
  },

  showView(v){ ['setup-view','game-view','god-view'].forEach(id=>{const el=this.$(id); if(el) el.classList.add('hidden');}); const t=this.$(v+'-view'); if(t) t.classList.remove('hidden'); },

  async startApp(){
    const snap=await db.ref(`games/${this.gameId}`).once('value');
    if(!snap.exists()){ document.body.innerHTML='<h2 style="padding:16px;">游戏不存在或已损坏</h2>'; return; }
    if(this.playerId==='0'){ this.showView('god'); this.listenToGameChanges(this.renderGodView.bind(this)); }
    else { this.showView('game'); this.listenToGameChanges(this.renderAll.bind(this)); this.listenToLogs(); }
  },

  handleGlobalClick(e){
    const btn=e.target.closest('button[data-action]'); if(!btn) return;
    const action=btn.dataset.action;

    if(action==='open-logs'){ this.openModal('logs-modal'); return; }
    if(action==='open-wolf'){ this.openWolfModal(); return; }
    if(action==='close-modal'){ this.closeModal(btn.dataset.target); return; }
    if(action==='copy-link'){ const el=this.$(btn.dataset.inputid); if(el){ el.select(); el.setSelectionRange(0,99999); navigator.clipboard.writeText(el.value).then(()=>this.showNotification('链接已复制','success')); } return; }

    if(action.startsWith('host-') && !this.isHost) return;

    switch(action){
      case 'join-as-creator': {
        const gid = btn.dataset.gameid || btn.getAttribute('value');
        if(!gid){ this.showNotification('未获取到游戏ID，请刷新后重试','error'); return; }
        this.gameId = gid; this.playerId='1';
        history.pushState(null,'',`?game=${this.gameId}&player=${this.playerId}`);
        this.startApp(); return;
      }
      case 'create-game': this.createGame(); return;

      // 主持人流转
      case 'host-start': this.updatePhase('NIGHT',1); return;
      case 'host-force-start': {
        if(confirm('强制开始? 未准备玩家保持当前顺序')){
          const up={}; Object.values(this.allPlayers).forEach(p=>{if(!p.isReady) up[`players/${p.id}/isReady`]=true});
          db.ref(`games/${this.gameId}`).update(up).then(()=>this.updatePhase('NIGHT',1));
        } return;
      }
      case 'host-sheriff-cand-init': this.updatePhase('SHERIFF_CAND'); return;
      case 'host-sheriff-speech': this.updatePhase('SHERIFF_SPEECH'); return;
      case 'host-sheriff-vote': this.hostEnterSheriffVote(); return;
      case 'host-sheriff-elect-single': this.hostSheriffElectSingle(); return;
      case 'host-tally-sheriff': this.tallySheriffVotes(); return;
      case 'host-force-tally-sheriff': this.tallySheriffVotes(); return;
      case 'host-force-end-cand': this.updatePhase('SHERIFF_SPEECH'); return; /* 新增：强制结束上警意向 */
      case 'host-day': this.processNight(); return;
      case 'host-force-day': {
        const round=this.gameState.round||1;
        const hasSheriff=Object.values(this.allPlayers).some(p=>p.badge);
        if(round===1 && !hasSheriff){ this.updatePhase('SHERIFF_CAND'); }
        else{ if(confirm('强制进入白天？未行动视为无操作')) this.processNight(); }
        return;
      }
      case 'host-open-day-vote': db.ref(`games/${this.gameId}/state/dayVotingOpen`).set(true); return;
      case 'host-close-day-vote': db.ref(`games/${this.gameId}/state/dayVotingOpen`).set(false); return;
      case 'host-tally-day': this.tallyDayVotes(); return;
      case 'host-force-tally-day': this.tallyDayVotes(); return;
      case 'host-force-badge-destroy': if(confirm('强制撕毁警徽?')) this.playerDestroyBadge(true); return;

      // 玩家常规
      case 'swap-identities': db.ref(`games/${this.gameId}/players/${this.playerId}/identities`).transaction(ids=>ids?[ids[1],ids[0]]:null); return;
      case 'confirm-identities': db.ref(`games/${this.gameId}/players/${this.playerId}/isReady`).transaction(v=>v||true); return;

      // 上警
      case 'sheriff-cand': db.ref(`games/${this.gameId}/sheriff/candidates/${this.playerId}`).set(Number(btn.dataset.value)); return;
      case 'sheriff-drop': db.ref(`games/${this.gameId}/sheriff/drops/${this.playerId}`).set(true); return;

      // 统一确认
      case 'confirm-selection': this.confirmSelection(); return;
      case 'skip-selection': this.skipSelection(); return;
      case 'cancel-selection': this.clearSelection(); this.renderActionPanel(); this.renderPlayerGrid(); return;

      // 狼窝
      case 'wolf-confirm': this.wolfConfirmKill(btn.dataset.value); return;
      case 'wolf-send': this.sendWolfMessage(); return;
    }
  },

  openModal(id){ const m=this.$(id); if(!m) return; m.classList.add('open'); const onClick=(e)=>{ if(e.target===m){ this.closeModal(id); } }; m._outsideHandler=onClick; m.addEventListener('click',onClick); },
  closeModal(id){ const m=this.$(id); if(!m) return; m.classList.remove('open'); if(m._outsideHandler){ m.removeEventListener('click',m._outsideHandler); m._outsideHandler=null; }},

  openWolfModal(){
    const type=this.getViewerWolfType();
    const chat=this.$('wolf-chat-area');
    const tips=this.$('wolf-modal-tips');
    if(type==='regular'){ chat.classList.remove('hidden'); tips.textContent='提示：普通狼人可投票，拍板狼负责确认刀口。'; }
    else if(type==='hidden'){ chat.classList.add('hidden'); tips.textContent='隐狼：可查看普通狼投票，但不能私聊与投票（无普通狼时由隐狼执行）。'; }
    else { chat.classList.add('hidden'); tips.textContent='你不是狼人。'; }
    this.openModal('wolf-modal');
    this.initWolfListeners();
  },

  listenToLogs(){
    if(this.logQueryRef && this.logListener) this.logQueryRef.off('child_added',this.logListener);
    this.seenLogKeys.clear();
    this.logQueryRef=db.ref(`games/${this.gameId}/logs`).limitToLast(200);
    this.logListener=this.logQueryRef.on('child_added',snap=>{
      if(!snap.exists()) return;
      const key=snap.key; if(this.seenLogKeys.has(key)) return; this.seenLogKeys.add(key);
      const log=snap.val(); if(log && !log.isSecret){
        const cont=this.$('game-log-content');
        const p=document.createElement('div'); p.className='log-item';
        const prefix=log.round>0?`[第 ${log.round} 轮] `:'';
        p.textContent=prefix+log.message;
        cont.appendChild(p); cont.scrollTop=cont.scrollHeight;
        if(!this.isHost) this.showNotification(log.message,'info');
      }
    });
  },

  listenToGameChanges(render){
    if(this.gameListener) db.ref(`games/${this.gameId}`).off('value',this.gameListener);
    this.gameListener=db.ref(`games/${this.gameId}`).on('value',s=>{
      if(!s.exists()){ document.body.innerHTML='<h2 style="padding:16px;">游戏已结束或不存在</h2>'; return; }
      const g=s.val();
      this.fullGameData=g; this.gameState=g.state; this.allPlayers=g.players;
      if(this.playerId!=='0'){
        if(!g.players || !g.players[this.playerId]){ document.body.innerHTML='<h2 style="padding:16px;">错误：你不是该游戏的玩家</h2>'; return; }
        this.playerData=g.players[this.playerId];
        this.isHost=this.playerData.id==this.gameState.creatorId;
      }
      if(this.gameState.phase!=='NIGHT'){ this.stopWolfListeners(); this.closeModal('wolf-modal'); }
      // 阶段变化时清空选择
      this.selection=null;
      render();
    });
  },

  /* 创建/设置 */
  renderRoleSetup(){
    const c=this.$('role-setup'); c.innerHTML='';
    Object.keys(DEFAULT_SETUP).forEach(name=>{
      const icon={'平民':'👤','守卫':'🛡️','白痴':'🤪','预言家':'🔮','骑士':'⚔️','女巫':'🧪','猎人':'🔫','狼人':'🐺','隐狼':'🌑','盗贼':'🎭'}[name]||'';
      const v=DEFAULT_SETUP[name];
      const div=document.createElement('div'); div.className='role-setup-item';
      div.innerHTML=`<span><span style="margin-right:6px;font-size:16px">${icon}</span>${name}</span><input type="number" id="role-${name}" min="0" value="${v}">`;
      c.appendChild(div);
    });
    const u=()=>{ let t=0; c.querySelectorAll('input').forEach(i=>t+=+i.value||0); this.$('total-roles').textContent=t; const pc=t>0 && t%2===0? t/2 : '身份总数必须为偶数'; this.$('player-cnt').textContent=pc; this.$('player-count-warning').textContent= typeof pc==='number' && pc>9 ? '(推荐≤9人)' : ''; };
    c.oninput=u; u();
  },

  async createGame(){
    const btn=this.$('btn-create'); btn.disabled=true; this.$('create-text').classList.add('hidden'); this.$('create-spinner').classList.remove('hidden');
    const errorEl=this.$('setup-error'); errorEl.classList.add('hidden'); errorEl.textContent='';

    const pool=[]; let cfg='当前配置：';
    this.$('role-setup').querySelectorAll('input').forEach(i=>{const r=i.id.replace('role-',''), n=+i.value; if(n>0) cfg+=`${r}x${n} `; for(let k=0;k<n;k++) pool.push(r);});
    if(pool.length===0 || pool.length%2!==0){ return this.setupFail('身份总数需为偶数且大于0'); }
    if(pool.length/2>12){ return this.setupFail('玩家过多，建议不超过12人。'); }

    const pairs=this.deal(pool);
    if(!pairs){ return this.setupFail(`无法生成符合规则的牌组，请调整身份配置后重试。<br><small>${cfg}</small>`); }

    const gId=db.ref('games').push().key, pc=pool.length/2, players={};
    for(let i=1;i<=pc;i++){
      players[i]={id:i,identities:pairs[i-1],originalIdentities:JSON.parse(JSON.stringify(pairs[i-1])),deaths:0,isAlive:true,isReady:false,isExposedIdiot:false,skillStates:{},badge:0};
    }
    const config={
      pc,
      witchSelfSaveRule: this.$('opt-witch-selfsave').value,
      seerMode: this.$('opt-seer-mode').value,
      wolfWin: this.$('opt-wolf-win').value
    };
    await db.ref(`games/${gId}`).set({
      state:{phase:'SETUP',round:0,peaceNightStreak:0,winner:null,creatorId:1,nightStatus:{},hunterQueue:{},postDeathState:null,dayVotingOpen:false},
      players, config, wolfChat:{}, wolfVotes:{}, nightActions:{}, sheriff:{}, dayVotes:{}, logs:{}
    });

    this.showNotification('游戏创建成功！','success');
    this.$('role-setup').classList.add('hidden'); btn.classList.add('hidden');
    const info=this.$('game-creation-info'); info.classList.remove('hidden');
    const base=`${location.origin}${location.pathname}`, url=`${base}?game=${gId}&player=PLAYER_ID`;
    info.innerHTML=`<div class="info-box" style="margin-top:0">将以下链接模板分发给玩家，将 PLAYER_ID 替换为座位号。</div>
      <div class="inline" style="justify-content:center"><input id="player-link-template" style="flex:1" value="${url}" readonly><button data-action="copy-link" data-inputid="player-link-template" class="control-btn">复制</button></div>
      <div style="margin-top:8px;text-align:center;"><button data-action="join-as-creator" data-gameid="${gId}" class="confirm-btn">以1号玩家(主持人)进入</button></div>`;
  },
  setupFail(msg){ const e=this.$('setup-error'); e.innerHTML=msg; e.classList.remove('hidden'); const btn=this.$('btn-create'); btn.disabled=false; this.$('create-text').classList.remove('hidden'); this.$('create-spinner').classList.add('hidden'); },

  deal(pool){
    for(let t=0;t<5000;t++){
      const s=this._shuffle([...pool]); let ok=true;
      const raw=[]; for(let i=0;i<s.length;i+=2){raw.push([s[i],s[i+1]].sort());}
      for(const p of raw){ if(FORBIDDEN_RAW.some(([a,b])=>(a===p[0]&&b===p[1])||(a===p[1]&&b===p[0]))){ok=false;break;} }
      if(!ok) continue;
      const finalPairs=[], cnt={};
      for(const p of raw){
        let a,b;
        if(p[0]==='盗贼'){ a={r:p[1],t:true}; b={r:p[1],t:false}; }
        else { a={r:p[0],t:false}; b={r:p[1],t:false}; }
        finalPairs.push([{role:a.r,isThiefCopy:a.t},{role:b.r,isThiefCopy:b.t}]);
        cnt[a.r]=(cnt[a.r]||0)+1; cnt[b.r]=(cnt[b.r]||0)+1;
      }
      const golden=finalPairs.filter(p=>p[0].role==='平民'&&p[1].role==='平民').length;
      if(golden<1||golden>2) continue;
      for(const p of finalPairs){ const roles=[p[0].role,p[1].role].sort(); if(FORBIDDEN_RAW.some(([a,b])=>(a===roles[0]&&b===roles[1])||(a===roles[1]&&b===roles[0]))){ok=false;break;} }
      if(!ok) continue;
      const wolves=(cnt['狼人']||0)+(cnt['隐狼']||0); if(wolves===0) continue;
      const gods=Object.keys(cnt).reduce((s,r)=>s+(ROLES[r].isGod?cnt[r]:0),0); if(gods===0) continue;
      return finalPairs;
    }
    return null;
  },

  /* 渲染 */
  renderAll(){
    this.$('host-badge').classList.toggle('hidden', !this.isHost);
    this.$('sheriff-badge-top').classList.toggle('hidden', !this.playerData?.badge);

    this.renderStatus();
    this.renderIdentityCard();
    this.renderPersistentInfo();
    this.renderActionPanel(); // 设选择模式
    this.renderPlayerGrid();  // 启用点击
    if(this.isHost) this.renderHostControls();

    const myType=this.getViewerWolfType();
    this.$('btn-wolf').classList.toggle('hidden', !myType || this.gameState.phase!=='NIGHT');
  },

  renderStatus(){
    const m={SETUP:'⏳ 等待所有玩家准备',NIGHT:`🌙 第 ${this.gameState.round} 夜`,SHERIFF_CAND:'👑 上警：是否上警',SHERIFF_SPEECH:'👑 上警：发言/退水',SHERIFF_VOTE:'👑 上警：投票',DAY:`☀️ 第 ${this.gameState.round} 天`,GAME_OVER:`🏆 ${this.gameState.winner}`,HUNTER_ACTION:'🔫 猎人正在开枪',SHERIFF_TRANSFER:'💔 警长阵亡，等待移交'};
    this.$('status-bar').textContent=m[this.gameState.phase]||'进行中';
  },

  renderIdentityCard(){
    const pd=this.playerData; if(!pd) return;
    const i=pd.identities, d=pd.deaths;
    const fmt=(id)=>`${ROLES[id.role].icon} ${id.isThiefCopy?`<span style="opacity:.8">${id.role}</span>`:id.role}`;
    this.$('identity-card').innerHTML=`
      <div><strong style="font-size:15px;">你的身份</strong></div>
      <div style="margin-top:6px;font-size:15px;">
        ${d>=1?'<span style="opacity:.5;text-decoration:line-through">':''}${fmt(i[0])}${d>=1?'</span>':''}
        <span style="margin:0 8px;">+</span>
        ${d>=2?'<span style="opacity:.5;text-decoration:line-through">':''}${fmt(i[1])}${d>=2?'</span>':''}
      </div>
      ${this.gameState.phase==='SETUP'&&!pd.isReady?'<div class="inline" style="justify-content:center;margin-top:6px;"><button class="action-btn" data-action="swap-identities">交换</button><button class="confirm-btn" data-action="confirm-identities">确定</button></div>':''}
    `;
  },

  renderPersistentInfo(){
    let h='';
    if(this.getActiveRole(this.playerData)==='预言家'){
      const mode=this.fullGameData.config?.seerMode||'faction';
      const r=this.getGlobalSkillState('seerResults')||{};
      const l=Object.entries(r).map(([id,res])=>`${id}号(${this.escapeHTML(res)})`).join('、 ');
      if(l) h+=`<div style="padding:8px;background:var(--panel-light);border-radius:12px;border:1px solid var(--border);text-align:center"><strong>🔮 查验历史(${mode==='faction'?'阵营':'身份'}):</strong> ${l}</div>`;
    }
    const el=this.$('persist'); el.innerHTML=h; el.classList.toggle('hidden', !h);
  },

  renderPlayerGrid(){
    const L=this.$('player-grid-left'), R=this.$('player-grid-right');
    L.innerHTML=''; R.innerHTML='';
    const list=Object.values(this.allPlayers).sort((a,b)=>a.id-b.id);
    const half=Math.ceil(list.length/2);
    const leftList=list.slice(0,half), rightList=list.slice(half);

    const viewerType=this.getViewerWolfType();
    const canSeeTeammate=(p)=>{
      if(!viewerType) return false;
      const has=(pp,role)=> (pp.originalIdentities||pp.identities).some(x=>x.role===role);
      if(viewerType==='regular') return has(p,'狼人');
      return has(p,'狼人');
    };

    const selectable=(p)=>{
      if(!this.selection) return false;
      const me=this.playerData;
      switch(this.selection.type){
        case 'seer': return p.isAlive && p.id!=me.id;
        case 'guard': { const last=this.getSkillState('lastGuardTarget'); if(last && +last===+p.id) return false; return p.isAlive; }
        case 'witch-poison': return p.isAlive && !p.isExposedIdiot && p.id!=me.id;
        case 'wolf-vote': return p.isAlive && this.canWolfAct(me);
        case 'day-vote': return p.isAlive && !p.isExposedIdiot;
        case 'knight': return p.isAlive && !p.isExposedIdiot && p.id!=me.id;
        case 'hunter': return p.isAlive;
        case 'sheriff-vote': { const cand=this.fullGameData.sheriff?.candidates||{}, drops=this.fullGameData.sheriff?.drops||{}; return p.isAlive && cand[p.id]!=null && cand[p.id]!==0 && !drops[p.id]; }
        case 'sheriff-pass': return p.isAlive && p.id!=me.id;
      }
      return false;
    };

    const isSelected=(p)=>{
      if (!this.selection) return false;
      if (this.selection.type === 'wolf-vote') {
          const myVote = this.fullGameData.wolfVotes?.[this.playerId];
          return myVote && +myVote === +p.id;
      }
      return this.selection.targetId && +this.selection.targetId === +p.id;
    };

    const makeCard=(p)=>{
      const live=2-p.deaths;
      const card=document.createElement('div');
      card.className='player-card';
      if(+this.playerId===+p.id) card.classList.add('me');
      if(!p.isAlive) card.classList.add('disabled');
      if(this.selection && !selectable(p)) card.classList.add('disabled');
      if(isSelected(p)) card.classList.add('selected');
      card.dataset.pid=p.id;

      const tags=[];
      if(+this.playerId===+p.id) tags.push('<span class="tag tag-you">你</span>');
      if(p.isExposedIdiot) tags.push('<span class="tag tag-idiot">白痴</span>');
      if(canSeeTeammate(p)) tags.push('<span class="tag tag-wolf">队友</span>');

      card.innerHTML=`
        <div class="player-number">${p.id}</div>
        <div class="tagline">
          ${p.badge?'<span class="sheriff-icon">👑</span>':''}
          ${tags.join('')}
        </div>
        <div class="hearts">
          <span class="heart ${live<1?'off':''}">❤</span>
          <span class="heart ${live<2?'off':''}">❤</span>
        </div>
        <span class="kill-dot"></span>
      `;

      if(this.selection && selectable(p)){
        card.style.cursor='pointer';
        card.addEventListener('click',()=>{
          const type = this.selection.type;
          const targetId = p.id.toString();

          if (type === 'wolf-vote') {
              if (!this.canWolfAct(this.playerData) || this.gameState?.nightStatus?.wolf !== 'pending') {
                  this.showNotification('当前不可投票', 'error');
                  return;
              }
              db.ref(`games/${this.gameId}/wolfVotes/${this.playerId}`).set(targetId);
              this.showNotification(`已投票：${targetId}号`, 'success');
          } else {
              this.selection.targetId = targetId;
              this.renderPlayerGrid();
              this.renderActionPanel();
          }
        });
      }
      return card;
    };

    leftList.forEach(p=>L.appendChild(makeCard(p)));
    rightList.forEach(p=>R.appendChild(makeCard(p)));
  },

  setSelection(type){ if(!this.selection || this.selection.type!==type){ this.selection={type, targetId:null}; } },
  clearSelection(){ this.selection=null; },

  renderActionPanel(){
    const panel=this.$('action-panel'); panel.innerHTML='';
    if(this.gameState.phase==='GAME_OVER'){ panel.innerHTML='<div class="action-feedback">游戏结束</div>'; return; }

    const isDead=!this.playerData.isAlive;
    const ns=this.gameState.nightStatus||{};
    const role=this.getActiveRole(this.playerData);
    const dayOpen=!!this.fullGameData?.state?.dayVotingOpen;

    const info=(msg)=>`<div class="action-feedback">${this.escapeHTML(msg)}</div>`;
    const bar=(title,{confirmText='确认',skipText='跳过',allowSkip=true,allowCancel=true}={})=>{
      const tgt=this.selection?.targetId? `${this.selection.targetId}号` : '未选择';
      return `<div class="info-box"><strong>${this.escapeHTML(title)}</strong><div style="margin-top:6px;">当前目标：<b>${tgt}</b></div></div>
        <div class="inline" style="margin-top:8px;justify-content:center;">
          <button class="confirm-btn" data-action="confirm-selection" ${!this.selection?.targetId?'disabled':''}>${confirmText}</button>
          ${allowSkip?`<button class="control-btn" data-action="skip-selection">${skipText}</button>`:''}
          ${allowCancel?`<button class="action-btn" data-action="cancel-selection">取消</button>`:''}
        </div>`;
    };

    if(this.gameState.phase==='SHERIFF_TRANSFER'){
      const t=this.gameState.postDeathState;
      if(t && this.playerId===t.deadSheriffId){ this.setSelection('sheriff-pass'); panel.innerHTML=bar('你已阵亡，请选择警徽移交对象',{allowSkip:true,skipText:'撕毁警徽'}); }
      else panel.innerHTML=info('等待警长移交警徽...');
      return;
    }

    if(isDead){
      if(this.gameState.phase==='HUNTER_ACTION' && this.gameState.hunterQueue && this.gameState.hunterQueue[this.playerId]){ this.setSelection('hunter'); panel.innerHTML=bar('你是猎人，请选择带走目标',{allowSkip:false}); }
      else panel.innerHTML=info('你已出局');
      return;
    }

    // 上警
    if(this.gameState.phase==='SHERIFF_CAND'){
      const my=candVal(this.fullGameData,this.playerId);
      if(my!=null){ panel.innerHTML=info(`你已选择 ${my?'上警':'不上警'}`); }
      else panel.innerHTML=`<div class="inline" style="justify-content:center;"><button class="action-btn" data-action="sheriff-cand" data-value="1">我要上警</button><button class="control-btn" data-action="sheriff-cand" data-value="0">不上警</button></div>`;
      return;
    }
    if(this.gameState.phase==='SHERIFF_SPEECH'){
      const isC=this.fullGameData.sheriff?.candidates?.[this.playerId]; const drop=this.fullGameData.sheriff?.drops?.[this.playerId];
      if(isC && !drop){ panel.innerHTML=`<div style="text-align:center;"><button class="action-btn" data-action="sheriff-drop">💧 退水</button></div>`; }
      else panel.innerHTML=info('等待主持人推进流程...');
      return;
    }
    if(this.gameState.phase==='SHERIFF_VOTE'){
      if(this.playerData.isExposedIdiot){ panel.innerHTML=info('你无法投票'); return; }
      const v=this.fullGameData.sheriff?.votes?.[this.playerId];
      if(v!=null){ panel.innerHTML=info(`你已投票给 ${v==='0'?'弃票':v+'号'}`); }
      else{ this.setSelection('sheriff-vote'); panel.innerHTML=bar('为警长投票',{allowSkip:true,skipText:'弃票'}); }
      return;
    }

    // 白天
    if(this.gameState.phase==='DAY'){
      if(!dayOpen){
        if(role==='骑士' && !this.getSkillState('hasUsedDuel')){ this.setSelection('knight'); panel.innerHTML=bar('你是骑士，可在投票前发动决斗',{allowSkip:false}); }
        else panel.innerHTML=info('等待主持人开启投票…');
      }else{
        if(this.playerData.isExposedIdiot){ panel.innerHTML=info('你无法投票'); }
        else{
          const v=this.fullGameData.dayVotes?.[this.gameState.round]?.[this.playerId];
          if(v!=null){ panel.innerHTML=info(`你已投票给 ${v==='0'?'弃票':v+'号'}`); }
          else{ this.setSelection('day-vote'); panel.innerHTML=bar('放逐投票',{allowSkip:true,skipText:'弃票'}); }
        }
      }
      return;
    }

    // 夜晚
    if(this.gameState.phase==='NIGHT'){
      if(role==='守卫' && ns.guard==='pending'){ this.setSelection('guard'); panel.innerHTML=bar('守卫：请选择守护对象（不可连守）',{allowSkip:true,skipText:'空守'}); return; }
      if(role==='预言家' && ns.seer==='pending'){ this.setSelection('seer'); panel.innerHTML=bar(`预言家：请选择查验目标（模式：${this.fullGameData.config?.seerMode==='identity'?'身份':'阵营'}）`,{allowSkip:true,skipText:'跳过'}); return; }
      if(role==='女巫' && ns.witch==='pending'){
        const idx=this.playerData.deaths;
        const hasCure=!this.getSkillState('hasUsedCure',this.playerData,idx);
        const hasPoison=!this.getSkillState('hasUsedPoison',this.playerData,idx);
        const nightTarget=this.fullGameData.nightActions?.[this.gameState.round]?.wolf?.target;
        let html=`<div class="info-box">解药:${hasCure?'✅':'❌'} | 毒药:${hasPoison?'✅':'❌'}`;
        const selfRule=this.fullGameData.config?.witchSelfSaveRule||'noFirstNightSelfSave';
        html+=`<div style="margin-top:6px;color:${selfRule==='noFirstNightSelfSave'?'#f59e0b':'#3b82f6'};font-size:13px;">规则：${selfRule==='noFirstNightSelfSave'?'首夜不能自救':'仅首夜可以自救'}</div></div>`;
        if(hasCure && nightTarget && nightTarget!=='0') html+=`<div class="inline" style="margin:6px 0;justify-content:center;"><button class="action-btn" onclick="App.witchTryCure('${nightTarget}')">💊 救 ${nightTarget}号</button></div>`;
        if(hasPoison){ this.setSelection('witch-poison'); html+=bar('毒药：请选择目标',{allowSkip:true,skipText:'不使用毒药'}); }
        else html+=`<div class="action-feedback">本条命毒药已用尽</div>`;
        panel.innerHTML=html; return;
      }
      if(['狼人','隐狼'].includes(role)){
        if(ns.wolf==='pending'){
          const can=this.canWolfAct(this.playerData);
          this.setSelection('wolf-vote');
          let html = `<div class="info-box">狼队行动：${can ? '请从上方列表选择袭击目标' : '等待普通狼人行动'}</div>`;
          html += `<div class="inline" style="margin-top:8px;justify-content:center;">`;
          if (can) {
              html += `<button class="control-btn" data-action="skip-selection">🔪 空刀</button>`;
          }
          html += `<button class="control-btn" data-action="open-wolf">🐺 打开狼窝</button>`;
          html += `</div>`;
          
          const alphaId = this.getAlphaWolfId();
          if (alphaId) {
              if (this.playerId === alphaId) {
                  html += `<div class="action-feedback" style="margin-top:8px; border-color: var(--warning);">你是拍板狼，请在狼窝中确认最终目标。</div>`;
              } else if (can) {
                  html += `<div class="action-feedback" style="margin-top:8px;">你的投票将同步至狼窝，由拍板狼（${alphaId}号）确认。</div>`;
              }
          }
          panel.innerHTML = html;
          return;
        }else{
          panel.innerHTML=info('狼队已确定刀口，等待其他角色行动…'); return;
        }
      }
      panel.innerHTML=info('等待其他角色行动...'); return;
    }

    panel.innerHTML=info('进行中…');
  },

  async confirmSelection(){
    if(!this.selection || !this.selection.targetId) return;
    const t=this.selection.targetId;
    switch(this.selection.type){
      case 'seer': await this.seerCheck(t); break;
      case 'guard': await this.guardProtect(t); break;
      case 'witch-poison': await this.witchUsePoison(t); break;
      // 狼人投票被单独处理，不再通过此函数
      case 'day-vote': await db.ref(`games/${this.gameId}/dayVotes/${this.gameState.round}/${this.playerId}`).set(t); break;
      case 'knight': await this.knight(t); break;
      case 'hunter': await this.hunter(t); break;
      case 'sheriff-vote':
        await db.ref(`games/${this.gameId}/sheriff/votes/${this.playerId}`).set(t);
        await db.ref(`games/${this.gameId}/sheriff/_lastUpdate`).set(firebase.database.ServerValue.TIMESTAMP);
        this.showNotification(`已投警长：${t==='0'?'弃票':t+'号'}`,'success'); break;
      case 'sheriff-pass': await this.playerPassBadge(t); break;
    }
    this.clearSelection(); this.renderActionPanel(); this.renderPlayerGrid();
  },
  async skipSelection(){
    if(!this.selection) return;
    switch(this.selection.type){
      case 'seer': await this.seerSkip(); break;
      case 'guard': await this.guardSkip(); break;
      case 'witch-poison': await this.witchSkip(); break;
      case 'wolf-vote':
        if(!this.canWolfAct(this.playerData) || this.gameState?.nightStatus?.wolf!=='pending'){ this.showNotification('当前不可投票','error'); break; }
        await db.ref(`games/${this.gameId}/wolfVotes/${this.playerId}`).set('0'); this.showNotification('已选择空刀','success'); break;
      case 'day-vote': await db.ref(`games/${this.gameId}/dayVotes/${this.gameState.round}/${this.playerId}`).set('0'); break;
      case 'sheriff-vote':
        await db.ref(`games/${this.gameId}/sheriff/votes/${this.playerId}`).set('0');
        await db.ref(`games/${this.gameId}/sheriff/_lastUpdate`).set(firebase.database.ServerValue.TIMESTAMP);
        this.showNotification('已为警长投弃票','success'); break;
      case 'sheriff-pass': await this.playerDestroyBadge(); break;
    }
    this.clearSelection(); this.renderActionPanel(); this.renderPlayerGrid();
  },

  /* 主持人面板 */
  renderHostControls(){
    const el=this.$('host-controls'); el.classList.remove('hidden');
    const ph=this.gameState.phase;
    let h=``;
    const renderStatus=(title,total,done)=>{ const p=total.filter(x=>done.includes(x.id)); const pending=total.filter(x=>!done.includes(x.id)); let s=`<div class="info-box">${title}：${p.length}/${total.length}</div>`; if(pending.length){ s+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:6px;margin-top:6px;">'; pending.forEach(pp=>s+=`<div style="background:var(--panel-light);border:1px solid var(--border);border-radius:10px;padding:6px;font-size:12px;text-align:center;">${pp.id}号 待完成</div>`); s+='</div>'; } return s; };

    if(ph==='SETUP'){
      const tot=Object.values(this.allPlayers); const rdy=tot.filter(p=>p.isReady);
      h+=renderStatus('玩家准备',tot,rdy);
      if(rdy.length<tot.length) h+=`<button class="action-btn" data-action="host-force-start">强制开始</button>`;
      h+=`<button class="control-btn" data-action="host-start" ${rdy.length<tot.length?'disabled':''}>🚀 开始游戏</button>`;
    }
    if(ph==='NIGHT'){
      const ns=this.gameState.nightStatus||{}, done=Object.values(ns).every(s=>s==='complete');
      const hasSheriff=Object.values(this.allPlayers).some(p=>p.badge);
      h+=`<div class="info-box">夜晚进度：${Object.values(ns).filter(s=>s==='complete').length} / ${Object.values(ns).length}</div>`;
      if(this.gameState.round===1 && !hasSheriff){
        h+=`<button class="control-btn" data-action="host-sheriff-cand-init" ${!done?'disabled':''}>👑 开始上警</button>`;
        h+=`<button class="action-btn" data-action="host-force-day">强制上警</button>`;
      }else{
        if(!done) h+=`<button class="action-btn" data-action="host-force-day">强制天亮</button>`;
        h+=`<button class="control-btn" data-action="host-day" ${!done?'disabled':''}>☀️ 天亮了(结算夜晚)</button>`;
      }
    }
    if(ph==='SHERIFF_CAND'){
      const alive=Object.values(this.allPlayers).filter(p=>p.isAlive);
      const candidates = [], notRunning = [], pending = [];
      alive.forEach(p => {
          const decision = candVal(this.fullGameData, p.id);
          if (decision === 1) {
              candidates.push(p.id);
          } else if (decision === 0) {
              notRunning.push(p.id);
          } else {
              pending.push(p.id);
          }
      });

      h += `<div class="info-box" style="text-align:left; padding: 10px 14px;">
              <strong style="display:block; text-align:center; margin-bottom:8px;">上警意向 (${alive.length - pending.length}/${alive.length})</strong>
              <div><span style="font-size:1.1em">✅</span> <b>上警:</b> ${candidates.length > 0 ? candidates.map(id=>id+'号').join(', ') : '无'}</div>
              <div style="margin-top:4px;"><span style="font-size:1.1em">❌</span> <b>不上警:</b> ${notRunning.length > 0 ? notRunning.map(id=>id+'号').join(', ') : '无'}</div>
              <div style="margin-top:4px;"><span style="font-size:1.1em">⏳</span> <b>等待中:</b> ${pending.length > 0 ? pending.map(id=>id+'号').join(', ') : '无'}</div>
            </div>`;

      h+=`<div class="inline" style="justify-content:center;margin-top:6px;">
            <button class="control-btn" data-action="host-sheriff-speech" ${pending.length > 0 ? 'disabled':''}>进入发言/退水</button>
            <button class="action-btn" data-action="host-force-end-cand">强制结束上警</button>
          </div>`;
    }
    if(ph==='SHERIFF_SPEECH'){
      const cand=this.fullGameData.sheriff?.candidates||{}; const drops=this.fullGameData.sheriff?.drops||{};
      const valid=Object.keys(cand).filter(id=>cand[id] && !drops[id]);
      if(valid.length===1) h+=`<div class="info-box">独警：${valid[0]}号</div><button class="confirm-btn" data-action="host-sheriff-elect-single">直接当选</button>`;
      h+=`<button class="control-btn" data-action="host-sheriff-vote">进入投票</button>`;
    }
    if(ph==='SHERIFF_VOTE'){
      const voters=Object.values(this.allPlayers).filter(p=>p.isAlive && !p.isExposedIdiot);
      const votedKeys=Object.keys(this.fullGameData.sheriff?.votes||{});
      const voted=votedKeys.map(id=>this.allPlayers[id]).filter(Boolean);
      h+=`<div class="info-box">投票进度：${voted.length}/${voters.length}</div>`;
      h+=`<div class="inline" style="justify-content:center;margin-top:6px;">
            <button class="control-btn" data-action="host-tally-sheriff" ${voted.length<voters.length?'disabled':''}>📊 统计</button>
            <button class="action-btn" data-action="host-force-tally-sheriff">强制计票</button>
          </div>`;
    }
    if(ph==='DAY'){
      const open=!!this.fullGameData.state.dayVotingOpen;
      h+=`<div class="info-box">投票开关：${open?'已开启 ✅':'未开启 ⏳'}</div>`;
      h+= open ? `<button class="action-btn" data-action="host-close-day-vote">关闭投票</button>` : `<button class="control-btn" data-action="host-open-day-vote">开启投票</button>`;
      if(open){
        const voters=Object.values(this.allPlayers).filter(p=>p.isAlive && !p.isExposedIdiot);
        const voted=Object.keys(this.fullGameData.dayVotes?.[this.gameState.round]||{}).map(id=>this.allPlayers[id]).filter(Boolean);
        h+=`<div class="info-box" style="margin-top:6px;">投票进度：${voted.length}/${voters.length}</div>`;
        h+=`<div class="inline" style="justify-content:center"><button class="control-btn" data-action="host-tally-day" ${voted.length<voters.length?'disabled':''}>📊 统计放逐票</button><button class="action-btn" data-action="host-force-tally-day">强制计票</button></div>`;
      }
    }
    if(ph==='SHERIFF_TRANSFER'){
      h+=`<div class="info-box">警长已阵亡，等待移交或撕毁</div><button class="action-btn" data-action="host-force-badge-destroy">强制撕毁</button>`;
    }
    if(ph==='GAME_OVER'){ h+=`<div class="info-box">游戏结束</div>`; }
    el.innerHTML=h;
  },

  /* 上帝视角 */
  renderGodView(){
    const list=this.$('god-player-list'); list.innerHTML='';
    const f=(id)=>`${ROLES[id.role].icon} ${id.isThiefCopy?`<span class="thief-copy">${id.role}</span>`:id.role}`;
    Object.values(this.fullGameData.players||{}).sort((a,b)=>a.id-b.id).forEach(p=>{
      const live=2-p.deaths, ids=p.identities, d=p.deaths;
      const row=document.createElement('div');
      row.className=`god-row ${!p.isAlive?'dead-all':''}`;
      row.innerHTML=`
        <div style="min-width:54px;font-weight:700;font-size:14px;">${p.id}号 ${p.badge?'👑':''}</div>
        <div style="flex:1;display:flex;gap:6px;align-items:center;">
          <span class="${d>=1?'dead-identity':''}">${f(ids[0])}</span><span>+</span>
          <span class="${d>=2?'dead-identity':''}">${f(ids[1])}</span>
        </div>
        <div><span class="life-heart ${live<1?'lost':''}">❤</span><span class="life-heart ${live<2?'lost':''}">❤</span></div>
      `;
      list.appendChild(row);
    });

    const godLog=this.$('god-log-content'); godLog.innerHTML='';
    const logs=Object.values(this.fullGameData.logs||{}).sort((a,b)=>a.timestamp-b.timestamp);
    if(logs.length===0){ godLog.innerHTML='<div class="log-item">暂无日志</div>'; }
    logs.forEach(log=>{
      const div=document.createElement('div'); div.className='log-item';
      if(log.isSecret) div.classList.add('log-secret');
      const prefix=log.round>0?`[第 ${log.round} 轮] `:'';
      div.textContent=prefix+log.message;
      godLog.appendChild(div);
    });
    godLog.scrollTop=godLog.scrollHeight;
  },

  /* 规则与技能 */
  async updatePhase(phase,round=null){
    const up={'state/phase':phase};
    if(round!==null) up['state/round']=round;
    else if(phase==='NIGHT') up['state/round']=this.gameState.round+1;

    if(phase==='NIGHT'){
      up['nightActions']={}; up['wolfVotes']={}; up['wolfChat']={};
      const alive=Object.values(this.allPlayers).filter(p=>p.isAlive);
      const exists=(role)=>alive.some(p=>this.getActiveRole(p)===role);
      const witch=alive.find(p=>this.getActiveRole(p)==='女巫');
      const wIdx=witch?witch.deaths:-1;
      const canWitch=witch && (!this.getSkillState('hasUsedCure',witch,wIdx) || !this.getSkillState('hasUsedPoison',witch,wIdx));
      const status={ guard:exists('守卫')?'pending':'complete', seer:exists('预言家')?'pending':'complete', wolf:this.isAnyWolfInGame()?'pending':'complete', witch:canWitch?'locked':'complete' };
      if(status.wolf==='complete' && status.witch==='locked') status.witch='pending';
      up['state/nightStatus']=status;
    }
    if(phase==='DAY'){ up['state/dayVotingOpen']=false; }
    if(phase==='SHERIFF_CAND'){ up['sheriff']={candidates:{},drops:{},votes:{}}; }
    await db.ref(`games/${this.gameId}`).update(up);
  },

  async guardProtect(id){ await db.ref(`games/${this.gameId}/nightActions/${this.gameState.round}/guard`).set({target:id,actorId:this.playerId}); await this.addGameLog(`🛡️ 守卫(${this.playerId}号)守护了 ${id}号`,true); await db.ref(`games/${this.gameId}/state/nightStatus/guard`).set('complete'); await this.setSkillState('lastGuardTarget',id); this.showNotification(`你守护了 ${id}号`,'success'); },
  async guardSkip(){ await db.ref(`games/${this.gameId}/nightActions/${this.gameState.round}/guard`).set({target:null,actorId:this.playerId}); await this.addGameLog(`🛡️ 守卫(${this.playerId}号)空守`,true); await db.ref(`games/${this.gameId}/state/nightStatus/guard`).set('complete'); await this.setSkillState('lastGuardTarget',null); },

  async seerCheck(id){
    const mode=this.fullGameData.config?.seerMode||'faction';
    let result='';
    if(mode==='faction'){
      const target=this.allPlayers[id];
      const hasRegularWolf=(target.identities||[]).some(x=>x.role==='狼人');
      result = hasRegularWolf ? '狼人' : '好人';
    }else{
      const role=this.getActiveRole(this.allPlayers[id])||'未知';
      result=role;
    }
    await db.ref(`games/${this.gameId}/nightActions/${this.gameState.round}/seer`).set({target:id,result,actorId:this.playerId});
    await db.ref(`games/${this.gameId}/state/nightStatus/seer`).set('complete');
    await this.addGameLog(`🔮 预言家(${this.playerId}号)查验 ${id}号，结果为 ${result}`,true);
    const rec=this.getGlobalSkillState('seerResults')||{}; rec[id]=result; await this.setGlobalSkillState('seerResults',rec);
    this.showNotification(`查验结果：${id}号 -> ${result}`,'success');
  },
  async seerSkip(){ await db.ref(`games/${this.gameId}/nightActions/${this.gameState.round}/seer`).set({target:null,actorId:this.playerId,skipped:true}); await db.ref(`games/${this.gameId}/state/nightStatus/seer`).set('complete'); await this.addGameLog(`🔮 预言家(${this.playerId}号)跳过查验`,true); },

  async witchTryCure(targetId){
    const rule=this.fullGameData.config?.witchSelfSaveRule||'noFirstNightSelfSave';
    const isSelf = +targetId===+this.playerId;
    const isFirstNight = this.gameState.round===1;
    if(rule==='noFirstNightSelfSave' && isSelf && isFirstNight){ this.showNotification('规则：首夜不能自救','error'); return; }
    if(rule==='onlyFirstNightSelfSave' && isSelf && !isFirstNight){ this.showNotification('规则：仅首夜可以自救','error'); return; }
    const idx=this.playerData.deaths;
    const ref=db.ref(`games/${this.gameId}/players/${this.playerId}/skillStates`);
    ref.transaction(st=>{st=st||{};const k=`${idx}_hasUsedCure`; if(st[k]) return; st[k]=true; return st;})
      .then(async res=>{
        if(res.committed){
          await db.ref(`games/${this.gameId}/nightActions/${this.gameState.round}/witch`).update({cure:targetId});
          await db.ref(`games/${this.gameId}/state/nightStatus/witch`).set('complete');
          await this.addGameLog(`🧪 女巫(${this.playerId}号)使用解药救了 ${targetId}号`,true);
          this.showNotification(`你救了 ${targetId}号`,'success');
        }
      });
  },
  async witchUsePoison(id){
    const idx=this.playerData.deaths;
    const ref=db.ref(`games/${this.gameId}/players/${this.playerId}/skillStates`);
    ref.transaction(st=>{st=st||{};const k=`${idx}_hasUsedPoison`; if(st[k]) return; st[k]=true; return st;})
      .then(async res=>{
        if(res.committed){
          await db.ref(`games/${this.gameId}/nightActions/${this.gameState.round}/witch`).update({poison:id});
          await db.ref(`games/${this.gameId}/state/nightStatus/witch`).set('complete');
          await this.addGameLog(`🧪 女巫(${this.playerId}号)毒杀了 ${id}号`,true);
          this.showNotification(`你毒杀了 ${id}号`,'error');
        }
      });
  },
  async witchSkip(){ await db.ref(`games/${this.gameId}/nightActions/${this.gameState.round}/witch`).update({actorId:this.playerId,skipped:true}); await db.ref(`games/${this.gameId}/state/nightStatus/witch`).set('complete'); await this.addGameLog(`🧪 女巫(${this.playerId}号)未使用药水`,true); },

  async knight(id){
    await this.setSkillState('hasUsedDuel',true);
    const role=this.getActiveRole(this.allPlayers[id]); const isEvil=['狼人','隐狼'].includes(role);
    const loser=isEvil? id : this.playerId; const loserRole=isEvil? role : this.getActiveRole(this.playerData);
    await this.addGameLog(`⚔️ 骑士 ${this.playerId}号 对 ${id}号 发动决斗！`);
    const res=await this.kill(loser,'DUEL');
    if(isEvil){ await this.addGameLog(`决斗成功！${loser}号(${loserRole}) 阵亡，进入夜晚。`); await this.handlePostDeath({...res,nextPhaseIfNoAction:'NIGHT'}); }
    else{ await this.addGameLog(`决斗失败！骑士 ${loser}号 阵亡。`); await this.handlePostDeath({...res,nextPhaseIfNoAction:'DAY'}); }
  },

  async hunter(id){
    await this.addGameLog(`🔫 猎人 ${this.playerId}号 开枪带走了 ${id}号！`);
    await db.ref(`games/${this.gameId}/state/hunterQueue/${this.playerId}`).set(null);
    const res=await this.kill(id,'HUNTER');
    if(res.sheriffDied) return;
    const remain=(await db.ref(`games/${this.gameId}/state/hunterQueue`).once('value')).val()||{};
    if(Object.keys(remain).length>0){ await this.updatePhase('HUNTER_ACTION'); }
    else{
      const next=this.gameState.postDeathState?.nextPhase || (this.gameState.phase==='DAY'?'NIGHT':'DAY');
      if(!this.gameState.postDeathState || !this.gameState.postDeathState.deadSheriffId){ await db.ref(`games/${this.gameId}/state/postDeathState`).set(null); }
      await this.updatePhase(next);
    }
  },

  /* 狼队 */
  getViewerWolfType(){
    if(!this.playerData) return null;
    const has=(role)=> (this.playerData.originalIdentities||this.playerData.identities).some(x=>x.role===role);
    if(has('狼人')) return 'regular';
    if(has('隐狼')) return 'hidden';
    return null;
  },
  canWolfAct(p){
    const role=this.getActiveRole(p);
    if(role==='狼人') return true;
    if(role==='隐狼'){
      const livingRegular=Object.values(this.allPlayers).filter(pp=>pp.isAlive && this.getActiveRole(pp)==='狼人');
      return livingRegular.length===0;
    }
    return false;
  },
  getAlphaWolfId(){
    const livingRegular=Object.values(this.allPlayers).filter(p=>p.isAlive && this.getActiveRole(p)==='狼人');
    if(livingRegular.length>0) return Math.min(...livingRegular.map(p=>p.id)).toString();
    const livingInvisible=Object.values(this.allPlayers).filter(p=>p.isAlive && this.getActiveRole(p)==='隐狼');
    if(livingInvisible.length>0) return Math.min(...livingInvisible.map(p=>p.id)).toString();
    return null;
  },
  initWolfListeners(){
    this.stopWolfListeners(false);
    const myType=this.getViewerWolfType(); if(!myType) return;

    this.wolfVotesCallbackRef=(snap)=>{
      const votes=snap.val()||{};
      const alpha=this.getAlphaWolfId();
      const display=this.$('wolf-votes-display'); if(!display) return;

      let voters=Object.values(this.allPlayers).filter(p=>p.isAlive && this.getActiveRole(p)==='狼人');
      if(voters.length===0){ voters=Object.values(this.allPlayers).filter(p=>p.isAlive && this.getActiveRole(p)==='隐狼'); }

      let html='<div><strong>投票情况</strong></div>';
      voters.sort((a,b)=>a.id-b.id).forEach(w=>{
        const v=votes[w.id]; const vt=v!=null?(v==='0'?'空刀':`${v}号`):'未投票';
        const isAlpha=(alpha && w.id.toString()===alpha);
        html+=`<div class="log-item">${w.id}号 ${isAlpha?'(拍板狼)':''} → ${vt}</div>`;
      });
      if(this.playerId===alpha && votes[alpha]!=null && this.gameState?.nightStatus?.wolf==='pending'){
        const tgt=votes[alpha]; html+=`<div class="inline" style="margin-top:6px;justify-content:center;"><button class="confirm-btn" data-action="wolf-confirm" data-value="${tgt}">确认袭击 ${tgt==='0'?'空刀':tgt+'号'}</button></div>`;
      }
      display.innerHTML=html;
    };
    this.wolfVotesListener=db.ref(`games/${this.gameId}/wolfVotes`);
    this.wolfVotesListener.on('value',this.wolfVotesCallbackRef);
    this.wolfVotesListener.once('value').then(this.wolfVotesCallbackRef);

    if(myType==='regular'){
      const chatRef=db.ref(`games/${this.gameId}/wolfChat`);
      const box=this.$('wolf-chat-messages'); if(box) box.innerHTML='';
      this.wolfChatListener=chatRef.limitToLast(80).on('child_added',s=>{
        const v=s.val(); if(!v) return;
        const p=document.createElement('div'); p.textContent=`${v.pid}号：${v.msg}`;
        this.$('wolf-chat-messages').appendChild(p);
        this.$('wolf-chat-messages').scrollTop=this.$('wolf-chat-messages').scrollHeight;
      });
    }
  },
  stopWolfListeners(hide=true){
    if(this.wolfVotesListener){ db.ref(`games/${this.gameId}/wolfVotes`).off('value',this.wolfVotesCallbackRef); this.wolfVotesListener=null; this.wolfVotesCallbackRef=null; }
    if(this.wolfChatListener){ db.ref(`games/${this.gameId}/wolfChat`).off('child_added',this.wolfChatListener); this.wolfChatListener=null; }
    if(hide) this.closeModal('wolf-modal');
  },
  async wolfConfirmKill(targetId){
    const alpha=this.getAlphaWolfId();
    if(this.playerId!==alpha || !this.canWolfAct(this.playerData) || this.gameState?.nightStatus?.wolf!=='pending'){
      this.showNotification('你无权确认或当前不可确认','error'); return;
    }
    const ref=db.ref(`games/${this.gameId}/nightActions/${this.gameState.round}/wolf`);
    ref.transaction(cur=>{ if(cur) return; return {target:targetId,actorId:this.playerId}; })
      .then(async res=>{
        if(res.committed){
          await this.addGameLog(`🐺 狼队决定袭击 ${targetId==='0'?'空刀':targetId+'号'} (由${this.playerId}号确认)`,true);
          await db.ref(`games/${this.gameId}/state/nightStatus`).transaction(st=>{ if(!st) return st; st.wolf='complete'; if(st.witch==='locked') st.witch='pending'; return st; });
          this.showNotification(`已确认袭击 ${targetId==='0'?'空刀':targetId+'号'}`,'success');
          // 清理本地选择状态，刷新面板（防止仍显示“选择刀口”）
          this.clearSelection(); this.renderActionPanel(); this.renderPlayerGrid();
        }else{
          this.showNotification('确认失败：已存在刀口或网络问题','error');
        }
      });
  },
  sendWolfMessage(){
    const type=this.getViewerWolfType(); if(type!=='regular'){ this.showNotification('你无法在狼窝发言','error'); return; }
    const inp=this.$('wolf-chat-input'); const msg=(inp.value||'').trim(); if(!msg) return; if(msg.length>120){ this.showNotification('消息过长','error'); return; }
    db.ref(`games/${this.gameId}/wolfChat`).push({pid:this.playerId,msg,ts:firebase.database.ServerValue.TIMESTAMP}); inp.value='';
  },

  /* 上警 */
  async hostEnterSheriffVote(){
    const cand=this.fullGameData.sheriff?.candidates||{}, drops=this.fullGameData.sheriff?.drops||{};
    const valid=Object.keys(cand).filter(id=>cand[id] && !drops[id]);
    if(valid.length===1){
      const sid=valid[0]; await db.ref(`games/${this.gameId}/players/${sid}/badge`).set(1);
      await this.addGameLog(`👑 ${sid}号独警，直接当选警长！`);
      if(this.gameState.round===1) await this.processNight(); else await this.updatePhase('DAY');
    }else{
      await this.updatePhase('SHERIFF_VOTE');
    }
  },
  async hostSheriffElectSingle(){
    const cand=this.fullGameData.sheriff?.candidates||{}, drops=this.fullGameData.sheriff?.drops||{};
    const valid=Object.keys(cand).filter(id=>cand[id] && !drops[id]);
    if(valid.length===1){
      const sid=valid[0]; await db.ref(`games/${this.gameId}/players/${sid}/badge`).set(1);
      await this.addGameLog(`👑 ${sid}号独警，直接当选警长！`);
      if(this.gameState.round===1) await this.processNight(); else await this.updatePhase('DAY');
    }else this.showNotification('当前非独警，无法直接当选','error');
  },

  async tallySheriffVotes(){
    const votes=this.fullGameData.sheriff?.votes||{}; const counts={};
    Object.values(votes).forEach(t=>{ if(t!=='0') counts[t]=(counts[t]||0)+1; });
    const voters=Object.values(this.allPlayers).filter(p=>p.isAlive && !p.isExposedIdiot);
    let details='警长投票详情：'+voters.map(v=>{
      const t=votes[v.id]; if(t===undefined) return `${v.id}号(未投)`; if(t==='0') return `${v.id}号(弃票)`; return `${v.id}号→${t}号`;
    }).join('，');
    await this.addGameLog(details);
    const max=Object.keys(counts).length?Math.max(...Object.values(counts)):0;
    const winners=Object.keys(counts).filter(id=>counts[id]===max);
    if(winners.length===1){
      const sid=winners[0]; await db.ref(`games/${this.gameId}/players/${sid}/badge`).set(1);
      await this.addGameLog(`👑 ${sid}号当选警长！`);
      if(this.gameState.round===1) await this.processNight(); else await this.updatePhase('DAY');
    }else{
      await this.addGameLog(winners.length>1?`⚖️ 平票：${winners.join('、')}号，重新发言并投票。`:'⚖️ 无人当选警长。');
      const newC={}; if(winners.length>1) winners.forEach(id=>newC[id]=1);
      await db.ref(`games/${this.gameId}/sheriff`).set({candidates:newC,drops:{},votes:{},_lastUpdate:firebase.database.ServerValue.TIMESTAMP});
      if(winners.length>1) await this.updatePhase('SHERIFF_SPEECH');
      else if(this.gameState.round===1) await this.processNight(); else await this.updatePhase('DAY');
    }
  },

  async tallyDayVotes(){
    const votes=this.fullGameData.dayVotes?.[this.gameState.round]||{}; const counts={};
    const sheriffId=Object.keys(this.allPlayers).find(id=>this.allPlayers[id].badge);
    const voters=Object.values(this.allPlayers).filter(p=>p.isAlive && !p.isExposedIdiot);
    let details='放逐投票详情：'+voters.map(v=>{
      const t=votes[v.id]; if(t===undefined) return `${v.id}号(未投)`; if(t==='0') return `${v.id}号(弃票)`; return `${v.id}号${sheriffId==v.id?'(警长)':''}→${t}号`;
    }).join('，');
    await this.addGameLog(details);
    Object.entries(votes).forEach(([voter,target])=>{ if(target!=='0'){ const w=(voter==sheriffId)?1.5:1; counts[target]=(counts[target]||0)+w; } });
    const max=Object.keys(counts).length?Math.max(...Object.values(counts)):0;
    const outs=Object.keys(counts).filter(id=>counts[id]===max);
    if(outs.length===1){
      const id=outs[0];
      await this.addGameLog(`⚖️ ${id}号以 ${counts[id]} 票被放逐。`);
      const r=await this.kill(id,'VOTE'); await this.handlePostDeath({...r,nextPhaseIfNoAction:'NIGHT'});
    }else{
      await this.addGameLog(outs.length>1?`⚖️ 平票：${outs.join('、')}号。无人出局。`:'⚖️ 无人出局。');
      await this.updatePhase('NIGHT');
    }
  },

  async playerPassBadge(to){
    const st=this.gameState.postDeathState||{};
    if(this.playerId!==st.deadSheriffId){ this.showNotification('你无权操作警徽','error'); return; }
    const up={[`players/${st.deadSheriffId}/badge`]:0,[`players/${to}/badge`]:1,'state/postDeathState':null};
    await db.ref(`games/${this.gameId}`).update(up);
    await this.addGameLog(`👑 警徽已由 ${st.deadSheriffId}号 移交给 ${to}号。`);
    await this.handlePostDeath({hunterTriggered:st.hunterTriggered,sheriffDied:false,nextPhaseIfNoAction:st.nextPhase});
  },
  async playerDestroyBadge(isForced=false){
    const st=this.gameState.postDeathState||{};
    if(!isForced && this.playerId!==st.deadSheriffId){ this.showNotification('你无权操作警徽','error'); return; }
    const up={[`players/${st.deadSheriffId}/badge`]:0,'state/postDeathState':null};
    await db.ref(`games/${this.gameId}`).update(up);
    await this.addGameLog(`💔 警徽已被 ${st.deadSheriffId}号 撕毁。`);
    await this.handlePostDeath({hunterTriggered:st.hunterTriggered,sheriffDied:false,nextPhaseIfNoAction:st.nextPhase});
  },

  async handlePostDeath({hunterTriggered,sheriffDied,nextPhaseIfNoAction='DAY'}){
    if(sheriffDied) return;
    const over=await this.checkWin(); if(over) return;
    const q=(await db.ref(`games/${this.gameId}/state/hunterQueue`).once('value')).val()||{};
    if(Object.keys(q).length>0){
      await db.ref(`games/${this.gameId}/state/postDeathState`).transaction(v=>{v=v||{};v.nextPhase=nextPhaseIfNoAction;return v;});
      await this.updatePhase('HUNTER_ACTION');
    }else if(nextPhaseIfNoAction){
      await this.updatePhase(nextPhaseIfNoAction);
    }
  },
  async kill(pid,cause){
    let result={hunterTriggered:false,sheriffDied:false};
    const pBefore=this.allPlayers[pid]; if(!pBefore || !pBefore.isAlive) return result;
    const roleBefore=this.getActiveRole(pBefore);
    let idiotFlipped=false;
    const trx=await db.ref(`games/${this.gameId}/players/${pid}`).transaction(p=>{
      if(!p || !p.isAlive) return p;
      const idx=p.deaths, iden=p.identities[idx];
      if(cause==='VOTE' && iden && iden.role==='白痴' && !p.isExposedIdiot){ p.isExposedIdiot=true; idiotFlipped=true; }
      p.deaths=Math.min(p.deaths+1,2); if(p.deaths>=2) p.isAlive=false; return p;
    });
    if(!trx.committed) return result;
    if(idiotFlipped) await this.addGameLog(`🤪 ${pid}号被投票出局，翻开白痴身份！`);
    const p=trx.snapshot.val();
    const wasSheriff=pBefore.badge, nowDead=!p.isAlive;
    const willHunter = roleBefore==='猎人' && (['NIGHT','VOTE','POISON','DUEL'].includes(cause));
    if(willHunter){ await db.ref(`games/${this.gameId}/state/hunterQueue/${pid}`).set(true); result.hunterTriggered=true; }
    if(nowDead && wasSheriff){
      const next=(cause==='DAY'||cause==='VOTE'||cause==='DUEL')?'NIGHT':'DAY';
      await db.ref(`games/${this.gameId}/state`).update({phase:'SHERIFF_TRANSFER',postDeathState:{deadSheriffId:pid,hunterTriggered:result.hunterTriggered,nextPhase:next}});
      result.sheriffDied=true;
    }
    await this.checkWin();
    return result;
  },
  async processNight(){
    await this.addGameLog('🌙 天亮了。');
    const actions=this.fullGameData.nightActions?.[this.gameState.round]||{};
    const deaths=[];
    const wolf=actions.wolf?.target, guard=actions.guard?.target, cure=actions.witch?.cure, poison=actions.witch?.poison;

    if(wolf && wolf!=='0'){
      const guarded=guard===wolf, cured=cure===wolf;
      if(!guarded && !cured) deaths.push({pid:wolf,cause:'NIGHT'});
    }
    if(poison && !deaths.some(d=>d.pid===poison)) deaths.push({pid:poison,cause:'POISON'});

    let anyH=false, anyS=false;
    if(deaths.length){
      const ids=[...new Set(deaths.map(d=>d.pid))].sort((a,b)=>a-b).join('号、');
      await this.addGameLog(`死亡的玩家是：${ids}号`);
      await db.ref(`games/${this.gameId}/state/peaceNightStreak`).set(0);
      for(const d of deaths){
        const r=await this.kill(d.pid,d.cause);
        if(r.hunterTriggered) anyH=true;
        if(r.sheriffDied){ anyS=true; break; }
      }
    }else{
      await this.addGameLog('昨夜平安夜。');
      const streak=(this.gameState.peaceNightStreak||0)+1;
      await db.ref(`games/${this.gameId}/state/peaceNightStreak`).set(streak);
    }
    await this.handlePostDeath({hunterTriggered:anyH,sheriffDied:anyS,nextPhaseIfNoAction:'DAY'});
  },

  async checkWin(){
    await new Promise(r=>setTimeout(r,100));
    const s=await db.ref(`games/${this.gameId}`).once('value'); if(!s.exists()) return false;
    const g=s.val(); if(g.state.phase==='GAME_OVER') return true;
    let winner=null;
    const all=Object.values(g.players);
    const wolfPlayers=all.filter(p=>p.originalIdentities.some(id=>ROLES[id.role].faction==='bad'));
    const goodPlayers=all.filter(p=>!p.originalIdentities.some(id=>ROLES[id.role].faction==='bad'));
    const godPlayers=all.filter(p=>p.originalIdentities.some(id=>ROLES[id.role].isGod));
    const goldenPlayers=all.filter(p=>p.originalIdentities.every(id=>id.role==='平民'));

    const allWolvesDead=wolfPlayers.every(p=>!p.isAlive);
    if(allWolvesDead) winner='游戏结束 - 好人阵营胜利！(狼人已全部出局)';
    if(g.state.peaceNightStreak>=3) winner='游戏结束 - 好人阵营胜利！(连续三晚平安夜)';

    if(!winner){
      const mode=g.config?.wolfWin || 'edge';
      if(mode==='exterminate'){
        const allGoodsDead=goodPlayers.length>0 && goodPlayers.every(p=>!p.isAlive);
        if(allGoodsDead) winner='游戏结束 - 狼人阵营胜利！(屠城：好人全灭)';
      }else{
        const allGodsDead=godPlayers.length>0 && godPlayers.every(p=>!p.isAlive);
        const allGoldenDead=goldenPlayers.length>0 && goldenPlayers.every(p=>!p.isAlive);
        if(allGodsDead || allGoldenDead) winner='游戏结束 - 狼人阵营胜利！(屠边达成)';
      }
    }
    if(winner){
      await db.ref(`games/${this.gameId}/state`).update({phase:'GAME_OVER',winner});
      await this.addGameLog(`🏆 ${winner}`);
      return true;
    }
    return false;
  },

  /* 工具 */
  getActiveRole(p){ if(!p || !p.isAlive) return null; if(p.deaths>=p.identities.length) return null; const cur=p.identities[p.deaths]; return cur?cur.role:null; },
  isAnyWolfInGame(){ return Object.values(this.allPlayers).some(p=>p.isAlive && ['狼人','隐狼'].includes(this.getActiveRole(p))); },
  getSkillState(key,player=null,idx=-1){ const p=player||this.playerData; if(!p) return undefined; const i=idx!==-1?idx:p.deaths; return (p.skillStates||{})[`${i}_${key}`]; },
  async setSkillState(key,value){ const i=this.playerData.deaths; await db.ref(`games/${this.gameId}/players/${this.playerId}/skillStates/${i}_${key}`).set(value); },
  getGlobalSkillState(key,player=null){ const p=player||this.playerData; if(!p) return undefined; return (p.skillStates||{})[`global_${key}`]; },
  async setGlobalSkillState(key,val){ await db.ref(`games/${this.gameId}/players/${this.playerId}/skillStates/global_${key}`).set(val); },
};
function candVal(g, pid){ return g.sheriff?.candidates?.[pid]; }
window.App=App;
document.addEventListener('DOMContentLoaded',()=>App.init());
