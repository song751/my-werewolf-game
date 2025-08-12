/* ========================================
   双身份狼人杀 - V10.3 (综合优化版)
   - 作者: AI Assistant
   - 更新日志:
   - #1  修复女巫技能逻辑，确保每晚一药，严格执行自救规则
   - #2  修复隐狼可以看到狼队友的Bug
   - #3  优化盗贼身份UI显示，使用特殊图标和颜色
   - #4  修复退水后仍可上警的问题
   - #5  调整投票权重为警长3票，普通2票
   - #6  实现选择状态持久化，防止操作中断
   - #8  强化猎人/警长死亡并发处理逻辑
   - #9  增加监听器卸载机制，修复潜在内存泄漏
   - #10 增加客户端操作锁定，防止重复提交
   - #11 增加骑士决斗结果的公开日志
   - #12 确认并巩固了双命女巫的独立药剂逻辑
   - #13 全面审查并确认了日志系统的公私分离
   - #14 CSS与动画效果增强 (见styles.css)
======================================== */

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

const ROLES = {
  '平民': { faction: 'good', isGod: false, icon: '👤' },
  '守卫': { faction: 'good', isGod: true, icon: '🛡️' },
  '白痴': { faction: 'good', isGod: true, icon: '🤪' },
  '预言家': { faction: 'good', isGod: true, icon: '🔮' },
  '骑士': { faction: 'good', isGod: true, icon: '⚔️' },
  '隐狼': { faction: 'bad', isGod: false, isInvisible: true, icon: '🌑' },
  '女巫': { faction: 'good', isGod: true, icon: '🧪' },
  '猎人': { faction: 'good', isGod: true, icon: '🔫' },
  '狼人': { faction: 'bad', isGod: false, icon: '🐺' },
  '盗贼': { faction: 'neutral', isGod: false, isThief: true, icon: '🎭' }
};
const DEFAULT_SETUP = { '平民': 6, '守卫': 1, '白痴': 1, '预言家': 1, '骑士': 1, '女巫': 1, '猎人': 1, '狼人': 2, '隐狼': 1, '盗贼': 1 };
const FORBIDDEN_RAW = [['预言家', '狼人'], ['预言家', '隐狼'], ['盗贼', '隐狼'], ['隐狼', '狼人'], ['隐狼', '隐狼']];

const App = {
  gameId: null, playerId: null, isHost: false,
  allPlayers: {}, playerData: null, fullGameData: null, gameState: null,
  gameListener: null, logListener: null, logQueryRef: null, seenLogKeys: new Set(),
  wolfChatListener: null, wolfVotesListener: null, wolfVotesCallbackRef: null,
  playerSelectionListener: null, // MODIFICATION #6: Listener for selection state
  selection: null, // This will now be kept in sync with Firebase

  $(id) { return document.getElementById(id) },
  escapeHTML(s) { return typeof s === 'string' ? s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])) : '' },
  _shuffle(a) { let i = a.length, r; while (i) { r = Math.floor(Math.random() * i--);[a[i], a[r]] = [a[r], a[i]] } return a; },

  showNotification(msg, type = 'info', duration = 5000) {
    const c = this.$('notification-container');
    const d = document.createElement('div');
    d.className = `notification ${type}`;
    d.innerHTML = `<div class="notification-content">${this.escapeHTML(msg)}</div>`;
    c.appendChild(d);
    setTimeout(() => d.classList.add('show'), 10);
    setTimeout(() => {
      d.classList.add('fade-out');
      setTimeout(() => d.remove(), 300);
    }, duration);
  },

  async addGameLog(message, isSecret = false) {
    // MODIFICATION #13: Centralized logging ensures correct visibility
    const entry = { message, round: this.gameState?.round || 0, timestamp: firebase.database.ServerValue.TIMESTAMP, isSecret };
    await db.ref(`games/${this.gameId}/logs`).push(entry);
  },

  async init() {
    const q = new URLSearchParams(location.search);
    this.gameId = q.get('game');
    this.playerId = q.get('player');

    document.body.classList.add('loading');
    setTimeout(() => document.body.classList.remove('loading'), 400);

    if (this.gameId && this.playerId === 'PLAYER_ID') {
      return this.renderJoinPage();
    }

    document.body.addEventListener('click', this.handleGlobalClick.bind(this));
    // MODIFICATION #9: Add listener to clean up on page exit
    window.addEventListener('beforeunload', () => this.detachAllListeners());

    if (!this.gameId) {
      this.showView('setup');
      this.renderRoleSetup();
    } else {
      await this.startApp();
    }
  },

  // MODIFICATION #9: New function to detach all Firebase listeners
  detachAllListeners() {
    if (this.gameListener) db.ref(`games/${this.gameId}`).off('value', this.gameListener);
    if (this.logQueryRef && this.logListener) this.logQueryRef.off('child_added', this.logListener);
    if (this.playerSelectionListener) db.ref(`games/${this.gameId}/playerSelections/${this.playerId}`).off('value', this.playerSelectionListener);
    this.stopWolfListeners();
    this.gameListener = null;
    this.logListener = null;
    this.playerSelectionListener = null;
    console.log('All Firebase listeners detached.');
  },

  renderJoinPage() {
    const app = document.querySelector('.app');
    app.innerHTML = `
      <div class="setup-container" style="max-width:400px;margin:100px auto;">
        <div class="setup-header">
          <h2>加入游戏</h2>
          <p class="setup-subtitle">输入法官分配的座位号</p>
        </div>
        <div style="margin:24px 0;">
          <input id="player-id-input" type="number" class="fancy-input" placeholder="请输入座位号" min="1" max="20">
        </div>
        <button id="join-game-btn" class="btn-primary btn-large">
          <span>进入游戏</span>
        </button>
      </div>`;

    const input = this.$('player-id-input');
    const btn = this.$('join-game-btn');
    input.addEventListener('keypress', (e) => e.key === 'Enter' && btn.click());
    btn.addEventListener('click', () => {
      const id = input.value;
      if (id && +id > 0) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';
        const u = new URL(location.href);
        u.searchParams.set('player', id);
        location.href = u.toString();
      } else {
        this.showNotification('请输入有效的座位号（1-20）', 'error');
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 500);
      }
    });
  },

  showView(name) {
    ['setup', 'game', 'god'].forEach((v) => {
      const el = this.$(`${v}-view`);
      if (el) {
        el.classList.add('hidden');
        el.classList.remove('view-active');
      }
    });
    const target = this.$(`${name}-view`);
    if (target) {
      target.classList.remove('hidden');
      setTimeout(() => target.classList.add('view-active'), 10);
    }
  },

  async startApp() {
    const snap = await db.ref(`games/${this.gameId}`).once('value');
    if (!snap.exists()) {
      this.detachAllListeners();
      document.body.innerHTML = `<div class="error-container" style="text-align:center; margin-top: 100px;"><div style="font-size:48px;">😵</div><h2>游戏不存在</h2><p>游戏房间已关闭或链接无效</p><button onclick="location.href='?'" class="btn-primary" style="margin-top:20px;">返回首页</button></div>`;
      return;
    }
    if (this.playerId === '0') {
      this.showView('god');
      this.listenToGameChanges(this.renderGodView.bind(this));
    } else {
      this.showView('game');
      this.listenToGameChanges(this.renderAll.bind(this));
      this.listenToLogs();
      this.listenToPlayerSelection(); // MODIFICATION #6
    }
  },

  handleGlobalClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;

    btn.classList.add('clicked');
    setTimeout(() => btn.classList.remove('clicked'), 280);

    if (action === 'open-logs') { this.openModal('logs-modal'); return; }
    if (action === 'close-modal') { this.closeModal(btn.dataset.target); return; }
    if (action === 'copy-link') {
      const el = this.$(btn.dataset.inputid);
      if (el) {
        navigator.clipboard.writeText(el.value).then(() => {
          this.showNotification('链接已复制到剪贴板', 'success');
          const btnSpan = btn.querySelector('span');
          if(btnSpan) btnSpan.textContent = '✓ 已复制';
          setTimeout(() => { if(btnSpan) btnSpan.textContent = '复制'; }, 2000);
        });
      }
      return;
    }

    if (action.startsWith('host-') && !this.isHost) { this.showNotification('只有主持人才能执行此操作', 'error'); return; }
    
    switch (action) {
      case 'create-game': this.createGame(); return;
      case 'host-start': this.updatePhase('NIGHT', 1); return;
      case 'host-day': this.processNight(); return;
      case 'confirm-selection': this.confirmSelection(); return;
      case 'skip-selection': this.skipSelection(); return;
      case 'cancel-selection': this.clearSelection(); return;
      case 'wolf-confirm': this.wolfConfirmKill(btn); return; // MODIFICATION #10: Pass button element
      case 'witch-cure': this.witchTryCure(btn.dataset.target); return; // MODIFICATION #1
      case 'witch-poison-start': this.setSelection({ type: 'witch-poison' }); return; // MODIFICATION #1
      default: {
        this.handleSimpleAction(action, btn);
      }
    }
  },

  handleSimpleAction(action, btn) {
    // This function handles less complex actions to keep the main switch clean.
    switch(action) {
        case 'join-as-creator': {
            const gid = btn.dataset.gameid || btn.getAttribute('value');
            if (!gid) { this.showNotification('未获取到游戏ID，请刷新后重试', 'error'); return; }
            this.gameId = gid;
            this.playerId = '1';
            history.pushState(null, '', `?game=${this.gameId}&player=${this.playerId}`);
            this.startApp();
            return;
        }
        case 'host-force-start': if (confirm('确定要强制开始游戏吗？')) { const up = {}; Object.values(this.allPlayers).forEach(p => { if (!p.isReady) up[`players/${p.id}/isReady`] = true }); db.ref(`games/${this.gameId}`).update(up).then(() => this.updatePhase('NIGHT', 1)); } return;
        case 'host-sheriff-cand-init': this.updatePhase('SHERIFF_CAND'); return;
        case 'host-sheriff-speech': this.updatePhase('SHERIFF_SPEECH'); return;
        case 'host-sheriff-vote': this.hostEnterSheriffVote(); return;
        case 'host-sheriff-elect-single': this.hostSheriffElectSingle(); return;
        case 'host-tally-sheriff': this.tallySheriffVotes(); return;
        case 'host-force-tally-sheriff': this.tallySheriffVotes(); return;
        case 'host-force-end-cand': this.updatePhase('SHERIFF_SPEECH'); return;
        case 'host-force-day': if (confirm('确定要强制进入白天吗？')) this.processNight(); return;
        case 'host-open-day-vote': db.ref(`games/${this.gameId}/state/dayVotingOpen`).set(true); this.showNotification('已开启白天投票', 'success'); return;
        case 'host-close-day-vote': db.ref(`games/${this.gameId}/state/dayVotingOpen`).set(false); this.showNotification('已关闭白天投票', 'info'); return;
        case 'host-tally-day': this.tallyDayVotes(); return;
        case 'host-force-tally-day': this.tallyDayVotes(); return;
        case 'host-force-badge-destroy': if (confirm('确定要强制撕毁警徽吗？')) this.playerDestroyBadge(true); return;
        case 'swap-identities': db.ref(`games/${this.gameId}/players/${this.playerId}/identities`).transaction(ids => ids ? [ids[1], ids[0]] : null); this.showNotification('身份已交换', 'success'); return;
        case 'confirm-identities': db.ref(`games/${this.gameId}/players/${this.playerId}/isReady`).set(true); this.showNotification('身份已确认，等待其他玩家...', 'success'); return;
        case 'sheriff-cand': const value = Number(btn.dataset.value); db.ref(`games/${this.gameId}/sheriff/candidates/${this.playerId}`).set(value); this.showNotification(value ? '你选择了上警' : '你选择了不上警', 'info'); return;
        case 'sheriff-drop': db.ref(`games/${this.gameId}/sheriff/drops/${this.playerId}`).set(true); this.showNotification('你已退水', 'info'); return;
        case 'wolf-send': this.sendWolfMessage(); return;
    }
  },

  openModal(id) {
    const m = this.$(id);
    if (!m) return;
    m.classList.add('open');
    const overlay = m.querySelector('.modal-overlay');
    if (overlay) {
      overlay.addEventListener('click', () => this.closeModal(id), { once: true });
    }
  },

  closeModal(id) {
    const m = this.$(id);
    if (!m) return;
    m.classList.remove('open');
  },

  listenToLogs() {
    if (this.logQueryRef && this.logListener) this.logQueryRef.off('child_added', this.logListener);
    this.seenLogKeys.clear();
    this.logQueryRef = db.ref(`games/${this.gameId}/logs`).limitToLast(200);
    this.logListener = this.logQueryRef.on('child_added', snap => {
      if (!snap.exists() || this.seenLogKeys.has(snap.key)) return;
      this.seenLogKeys.add(snap.key);
      const log = snap.val();
      // MODIFICATION #13: Player log only shows public messages
      if (log && !log.isSecret) {
        const cont = this.$('game-log-content');
        if(!cont) return;
        const p = document.createElement('div');
        p.className = 'log-item fade-in';
        const prefix = log.round > 0 ? `<span class="log-round">[第${log.round}轮]</span> ` : '';
        p.innerHTML = prefix + this.escapeHTML(log.message);
        cont.appendChild(p);
        cont.scrollTop = cont.scrollHeight;
      }
    });
  },

  listenToGameChanges(render) {
    if (this.gameListener) db.ref(`games/${this.gameId}`).off('value', this.gameListener);
    this.gameListener = db.ref(`games/${this.gameId}`).on('value', s => {
      if (!s.exists()) {
        this.detachAllListeners();
        document.body.innerHTML = `<div class="error-container" style="text-align:center; margin-top: 100px;"><div style="font-size:48px;">🎮</div><h2>游戏已结束</h2><p>感谢参与本局游戏</p><button onclick="location.href='?'" class="btn-primary" style="margin-top:20px;">开始新游戏</button></div>`;
        return;
      }
      const g = s.val();
      this.fullGameData = g;
      this.gameState = g.state;
      this.allPlayers = g.players;
      if (this.playerId !== '0') {
        if (!g.players || !g.players[this.playerId]) {
          this.detachAllListeners();
          document.body.innerHTML = `<div class="error-container" style="text-align:center; margin-top: 100px;"><div style="font-size:48px;">❌</div><h2>无法加入游戏</h2><p>你不是该游戏的玩家</p><button onclick="location.href='?'" class="btn-primary" style="margin-top:20px;">返回首页</button></div>`;
          return;
        }
        this.playerData = g.players[this.playerId];
        this.isHost = this.playerData.id == this.gameState.creatorId;
      }
      if (this.gameState.phase !== 'NIGHT') this.stopWolfListeners();
      
      render();
    });
  },
  
  // MODIFICATION #6: New listener for persistent selection
  listenToPlayerSelection() {
      if (this.playerSelectionListener) db.ref(`games/${this.gameId}/playerSelections/${this.playerId}`).off('value', this.playerSelectionListener);
      
      this.playerSelectionListener = db.ref(`games/${this.gameId}/playerSelections/${this.playerId}`).on('value', snap => {
          this.selection = snap.val();
          if (this.$('game-view').classList.contains('view-active')) {
              this.renderActionPanel();
              this.renderPlayerGrid();
          }
      });
  },

  renderRoleSetup() {
    const c = this.$('role-setup');
    c.innerHTML = '';
    Object.keys(DEFAULT_SETUP).forEach(name => {
      const role = ROLES[name];
      const icon = role.icon;
      const v = DEFAULT_SETUP[name];
      const div = document.createElement('div');
      div.className = 'role-setup-item';
      div.innerHTML = `
        <span class="role-name"><span class="role-icon">${icon}</span><span>${name}</span></span>
        <div class="role-counter">
          <button class="counter-btn minus" data-role="${name}">−</button>
          <input type="number" id="role-${name}" min="0" value="${v}" readonly>
          <button class="counter-btn plus" data-role="${name}">+</button>
        </div>`;
      c.appendChild(div);
    });

    c.addEventListener('click', (e) => {
      const btn = e.target.closest('.counter-btn');
      if (btn) {
        const role = btn.dataset.role;
        const input = this.$(`role-${role}`);
        let value = parseInt(input.value) || 0;
        if (btn.classList.contains('plus') && value < 10) value++;
        else if (btn.classList.contains('minus') && value > 0) value--;
        input.value = value;
        this.updateRoleStats();
      }
    });
    this.updateRoleStats();
  },
  
  updateRoleStats() {
    const c = this.$('role-setup');
    let t = 0;
    c.querySelectorAll('input').forEach(i => t += +i.value || 0);
    this.$('total-roles').textContent = t;
    const pc = t > 0 && t % 2 === 0 ? t / 2 : '?';
    this.$('player-cnt').textContent = pc;
    this.$('player-count-warning').textContent =
      typeof pc === 'number' && pc > 12 ? '⚠️ 建议玩家数不超过12人' :
        (t % 2 !== 0 ? '⚠️ 身份总数必须为偶数' : '');
  },

  async createGame() {
    const btn = this.$('btn-create');
    btn.disabled = true;
    this.$('create-text').classList.add('hidden');
    this.$('create-spinner').classList.remove('hidden');
    const errorEl = this.$('setup-error');
    errorEl.classList.add('hidden');
    errorEl.textContent = '';

    const pool = [];
    let cfg = '当前配置：';
    this.$('role-setup').querySelectorAll('input').forEach(i => {
      const r = i.id.replace('role-', ''), n = +i.value;
      if (n > 0) cfg += `${r}×${n} `;
      for (let k = 0; k < n; k++) pool.push(r);
    });
    if (pool.length === 0 || pool.length % 2 !== 0) {
      return this.setupFail('身份总数需为偶数且大于0');
    }
    if (pool.length / 2 > 12) {
      if (!confirm('玩家数量超过12人，可能影响游戏体验，确定要创建吗？')) {
        return this.setupFail('操作已取消。');
      }
    }

    const pairs = this.deal(pool);
    if (!pairs) {
      return this.setupFail(`无法生成符合规则的牌组，请调整身份配置后重试。<br><small>${cfg}</small>`);
    }

    const gId = db.ref('games').push().key, pc = pool.length / 2, players = {};
    for (let i = 1; i <= pc; i++) {
      players[i] = { id: i, identities: pairs[i - 1], originalIdentities: JSON.parse(JSON.stringify(pairs[i - 1])), deaths: 0, isAlive: true, isReady: false, isExposedIdiot: false, skillStates: {}, badge: 0 };
    }
    const config = { pc, witchSelfSaveRule: this.$('opt-witch-selfsave').value, seerMode: this.$('opt-seer-mode').value, wolfWin: this.$('opt-wolf-win').value };
    await db.ref(`games/${gId}`).set({ state: { phase: 'SETUP', round: 0, peaceNightStreak: 0, winner: null, creatorId: 1, nightStatus: {}, hunterQueue: {}, postDeathState: null, dayVotingOpen: false }, players, config, playerSelections: {}, wolfChat: {}, wolfVotes: {}, nightActions: {}, sheriff: {}, dayVotes: {}, logs: {} });

    this.showNotification('游戏创建成功！', 'success');
    this.$('role-setup').classList.add('hidden');
    btn.classList.add('hidden');
    const info = this.$('game-creation-info');
    info.classList.remove('hidden');
    const base = `${location.origin}${location.pathname}`, url = `${base}?game=${gId}&player=PLAYER_ID`;
    info.innerHTML = `
      <div class="success-message" style="text-align:center; margin-bottom:16px;">
        <div style="font-size:32px; margin-bottom:8px;">✅</div>
        <h3>游戏房间已创建</h3>
        <p style="color:var(--text-secondary); font-size:14px;">将以下链接分享给玩家，记得替换 PLAYER_ID 为对应座位号</p>
      </div>
      <div class="link-container" style="display:flex; gap:8px;">
        <input id="player-link-template" class="fancy-input" value="${url}" readonly style="text-align:left;">
        <button data-action="copy-link" data-inputid="player-link-template" class="control-btn" style="flex-shrink:0;"><span>复制</span></button>
      </div>
      <button data-action="join-as-creator" data-gameid="${gId}" class="btn-primary btn-large"><span>以1号玩家(主持人)身份进入</span></button>`;
  },

  setupFail(msg) {
    const e = this.$('setup-error');
    e.innerHTML = msg;
    e.classList.remove('hidden');
    const btn = this.$('btn-create');
    btn.disabled = false;
    this.$('create-text').classList.remove('hidden');
    this.$('create-spinner').classList.add('hidden');
  },

  deal(pool) {
    for (let t = 0; t < 5000; t++) {
      const s = this._shuffle([...pool]);
      let ok = true;
      const raw = [];
      for (let i = 0; i < s.length; i += 2) {
        raw.push([s[i], s[i + 1]].sort());
      }
      for (const p of raw) {
        if (FORBIDDEN_RAW.some(([a, b]) => (a === p[0] && b === p[1]) || (a === p[1] && b === p[0]))) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const finalPairs = [], cnt = {};
      for (const p of raw) {
        let a, b;
        if (p[0] === '盗贼') {
          a = { r: p[1], t: true };
          b = { r: p[1], t: true }; // Both are copies
        } else {
          a = { r: p[0], t: false };
          b = { r: p[1], t: false };
        }
        finalPairs.push([
          { role: a.r, isThiefCopy: a.t },
          { role: b.r, isThiefCopy: b.t }
        ]);
        cnt[a.r] = (cnt[a.r] || 0) + 1;
        cnt[b.r] = (cnt[b.r] || 0) + 1;
      }
      const golden = finalPairs.filter(p => p[0].role === '平民' && p[1].role === '平民').length;
      if (golden < 1 || golden > 2) continue;
      
      const wolves = (cnt['狼人'] || 0) + (cnt['隐狼'] || 0);
      if (wolves === 0) continue;
      const gods = Object.keys(cnt).reduce((s, r) => s + (ROLES[r].isGod ? cnt[r] : 0), 0);
      if (gods === 0) continue;
      return finalPairs;
    }
    return null;
  },

  renderIdentityCard() {
    const pd = this.playerData;
    if (!pd) return;
    const i = pd.identities, d = pd.deaths;
    
    // MODIFICATION #3: New formatter for Thief UI
    const fmt = (id) => {
      const isThief = id.isThiefCopy;
      const icon = isThief ? '🎭' : ROLES[id.role].icon;
      const textClass = isThief ? 'thief-copy-text' : '';
      const iconClass = isThief ? 'thief-icon' : '';
      return `<span class="identity-item">
                <span class="identity-icon ${iconClass}">${icon}</span>
                <span class="identity-name ${textClass}">${id.role}</span>
              </span>`;
    };
    
    let cardContent = `<div class="identity-header">你的身份</div><div class="identity-display">${d >= 1 ? '<span class="identity-dead">' : ''}${fmt(i[0])}${d >= 1 ? '</span>' : ''}<span class="identity-separator">+</span>${d >= 2 ? '<span class="identity-dead">' : ''}${fmt(i[1])}${d >= 2 ? '</span>' : ''}</div>`;
    
    if (this.gameState.phase === 'SETUP' && !pd.isReady) {
      cardContent += `
        <div class="identity-actions">
          <button class="control-btn" data-action="swap-identities"><span>🔄 交换身份</span></button>
          <button class="confirm-btn" data-action="confirm-identities"><span>✓ 确认身份</span></button>
        </div>`;
    }
    this.$('identity-card').innerHTML = cardContent;
  },
  
  renderHostControls() {
    const el = this.$('host-controls');
    el.classList.remove('hidden');
    const ph = this.gameState.phase;
    let h = `<div class="host-panel">`;
    const allPlayers = Object.values(this.allPlayers);
    const generatePlayerTags = (playerList, className = '') => {
        if (!playerList || playerList.length === 0) return '<span style="color:var(--text-tertiary);">无</span>';
        return playerList.map(p => `<span class="player-tag ${className}">${p.id}号</span>`).join('');
    };
    if (ph === 'SETUP') {
        const readyPlayers = allPlayers.filter(p => p.isReady);
        const pendingPlayers = allPlayers.filter(p => !p.isReady);
        h += `<div class="host-status"><div class="host-status-title">玩家准备 (${readyPlayers.length}/${allPlayers.length})</div><div class="status-category"><div class="category-title">已准备:</div><div class="player-tags">${generatePlayerTags(readyPlayers, 'done')}</div></div><div class="status-category"><div class="category-title">未准备:</div><div class="player-tags">${generatePlayerTags(pendingPlayers, 'pending')}</div></div></div>`;
        h += `<div class="host-actions" style="display:flex; gap:8px;">`;
        if (pendingPlayers.length > 0) h += `<button class="action-btn" data-action="host-force-start" style="flex:1;">强制开始</button>`;
        h += `<button class="confirm-btn" data-action="host-start" ${pendingPlayers.length > 0 ? 'disabled' : ''} style="flex:1;">🚀 开始游戏</button>`;
        h += `</div>`;
    }
    if (ph === 'NIGHT') {
        const ns = this.gameState.nightStatus || {};
        const allDone = Object.values(ns).every(s => s === 'complete');
        const hasSheriff = allPlayers.some(p => p.badge);
        const isFirstNight = this.gameState.round === 1;
        h += `<div class="host-status"><div class="host-status-title">夜晚行动中...</div><p style="font-size:13px; color:var(--text-tertiary); margin-top: 4px;">为保证公平，上帝视角不显示具体角色进度。</p></div>`;
        h += `<div class="host-actions" style="display:flex; gap:8px;">`;
        if (isFirstNight && !hasSheriff) {
            if (!allDone) h += `<button class="action-btn" data-action="host-force-day" style="flex:1;">强制上警</button>`;
            h += `<button class="confirm-btn" data-action="host-sheriff-cand-init" ${!allDone ? 'disabled' : ''} style="flex:1;">👑 开始上警</button>`;
        } else {
            if (!allDone) h += `<button class="action-btn" data-action="host-force-day" style="flex:1;">强制天亮</button>`;
            h += `<button class="confirm-btn" data-action="host-day" ${!allDone ? 'disabled' : ''} style="flex:1;">☀️ 天亮了</button>`;
        }
        h += `</div>`;
    }
    if (ph === 'SHERIFF_CAND') {
        const alivePlayers = allPlayers.filter(p => p.isAlive);
        const decisions = this.fullGameData.sheriff?.candidates || {};
        const decidedPlayers = alivePlayers.filter(p => decisions[p.id] !== undefined);
        const pendingPlayers = alivePlayers.filter(p => decisions[p.id] === undefined);
        h += `<div class="host-status"><div class="host-status-title">上警意向 (${decidedPlayers.length}/${alivePlayers.length})</div><div class="status-category"><div class="category-title">已决定:</div><div class="player-tags">${generatePlayerTags(decidedPlayers, 'done')}</div></div><div class="status-category"><div class="category-title">等待中:</div><div class="player-tags">${generatePlayerTags(pendingPlayers, 'pending')}</div></div></div>`;
        h += `<div class="host-actions" style="display:flex; gap:8px;"><button class="action-btn" data-action="host-force-end-cand" style="flex:1;">强制结束</button><button class="confirm-btn" data-action="host-sheriff-speech" ${pendingPlayers.length > 0 ? 'disabled' : ''} style="flex:1;">进入发言</button></div>`;
    }
    if (ph === 'SHERIFF_SPEECH') {
        const cand = this.fullGameData.sheriff?.candidates || {};
        const drops = this.fullGameData.sheriff?.drops || {};
        const valid = Object.keys(cand).filter(id => cand[id] && !drops[id]);
        if (valid.length === 1) h += `<div class="single-sheriff" style="text-align:center; margin-bottom:8px;">独警：${valid[0]}号 <button class="confirm-btn" data-action="host-sheriff-elect-single" style="margin-left:8px;">直接当选</button></div>`;
        h += `<div class="host-actions"><button class="control-btn" data-action="host-sheriff-vote" style="width:100%;">进入投票</button></div>`;
    }
    if (ph === 'SHERIFF_VOTE') {
        const voters = allPlayers.filter(p => p.isAlive && !p.isExposedIdiot);
        const votedIds = Object.keys(this.fullGameData.sheriff?.votes || {});
        const votedPlayers = voters.filter(p => votedIds.includes(p.id.toString()));
        const pendingPlayers = voters.filter(p => !votedIds.includes(p.id.toString()));
        h += `<div class="host-status"><div class="host-status-title">警长投票 (${votedPlayers.length}/${voters.length})</div><div class="status-category"><div class="category-title">已投票:</div><div class="player-tags">${generatePlayerTags(votedPlayers, 'done')}</div></div><div class="status-category"><div class="category-title">未投票:</div><div class="player-tags">${generatePlayerTags(pendingPlayers, 'pending')}</div></div></div>`;
        h += `<div class="host-actions" style="display:flex; gap:8px;"><button class="action-btn" data-action="host-force-tally-sheriff" style="flex:1;">强制计票</button><button class="confirm-btn" data-action="host-tally-sheriff" ${pendingPlayers.length > 0 ? 'disabled' : ''} style="flex:1;">📊 统计</button></div>`;
    }
    if (ph === 'DAY') {
        const open = !!this.fullGameData.state.dayVotingOpen;
        if (open) {
            const voters = allPlayers.filter(p => p.isAlive && !p.isExposedIdiot);
            const votedIds = Object.keys(this.fullGameData.dayVotes?.[this.gameState.round] || {});
            const votedPlayers = voters.filter(p => votedIds.includes(p.id.toString()));
            const pendingPlayers = voters.filter(p => !votedIds.includes(p.id.toString()));
            h += `<div class="host-status"><div class="host-status-title">放逐投票 (${votedPlayers.length}/${voters.length})</div><div class="status-category"><div class="category-title">已投票:</div><div class="player-tags">${generatePlayerTags(votedPlayers, 'done')}</div></div><div class="status-category"><div class="category-title">未投票:</div><div class="player-tags">${generatePlayerTags(pendingPlayers, 'pending')}</div></div></div>`;
            h += `<div class="host-actions" style="display:flex; gap:8px;"><button class="action-btn" data-action="host-force-tally-day" style="flex:1;">强制计票</button><button class="confirm-btn" data-action="host-tally-day" ${pendingPlayers.length > 0 ? 'disabled' : ''} style="flex:1;">📊 统计</button></div>`;
        } else {
            h += `<div class="host-actions"><button class="confirm-btn" data-action="host-open-day-vote" style="width:100%;">开启投票</button></div>`;
        }
    }
    if (ph === 'SHERIFF_TRANSFER') { h += `<div class="transfer-status" style="text-align:center; margin-bottom:8px;">⚰️ 警长已阵亡，等待移交或撕毁</div><button class="action-btn" data-action="host-force-badge-destroy" style="width:100%;">强制撕毁</button>`; }
    if (ph === 'GAME_OVER') { h += `<div class="game-over-host" style="text-align:center; color:var(--text-secondary);">🎮 游戏已结束</div>`; }
    h += `</div>`;
    el.innerHTML = h;
  },

  renderAll() {
    this.$('host-badge').classList.toggle('hidden', !this.isHost);
    this.$('sheriff-badge-top').classList.toggle('hidden', !this.playerData?.badge);
    this.renderStatus();
    this.renderIdentityCard();
    this.renderPersistentInfo();
    this.renderActionPanel();
    this.renderPlayerGrid();
    if (this.isHost) this.renderHostControls();
  },

  renderStatus() {
    const m = {
      SETUP: '⏳ 等待所有玩家准备',
      NIGHT: `🌙 第 ${this.gameState.round} 夜`,
      SHERIFF_CAND: '👑 上警意向征集',
      SHERIFF_SPEECH: '👑 上警发言/退水',
      SHERIFF_VOTE: '👑 警长投票',
      DAY: `☀️ 第 ${this.gameState.round} 天`,
      GAME_OVER: `🏆 ${this.gameState.winner}`,
      HUNTER_ACTION: '🔫 猎人正在开枪',
      SHERIFF_TRANSFER: '💔 警长阵亡，等待移交'
    };
    const status = this.$('status-bar');
    const text = m[this.gameState.phase] || '游戏进行中';
    status.innerHTML = `<span class="status-text">${text}</span>`;
  },

  renderPersistentInfo() {
    let h = '';
    if (this.getActiveRole(this.playerData) === '预言家') {
      const mode = this.fullGameData.config?.seerMode || 'faction';
      const r = this.getGlobalSkillState('seerResults') || {};
      const entries = Object.entries(r);
      if (entries.length) {
        h += `<div class="seer-results"><div class="seer-title">🔮 查验记录 (${mode === 'faction' ? '阵营' : '身份'})</div><div class="seer-list">`;
        entries.forEach(([id, res]) => { h += `<span class="seer-item">${id}号: <strong>${this.escapeHTML(res)}</strong></span>`; });
        h += `</div></div>`;
      }
    }
    const el = this.$('persist');
    el.innerHTML = h;
    el.classList.toggle('hidden', !h);
  },

  renderPlayerGrid() {
    const L = this.$('player-grid-left'), R = this.$('player-grid-right');
    L.innerHTML = ''; R.innerHTML = '';

    const list = Object.values(this.allPlayers).sort((a, b) => a.id - b.id);
    const half = Math.ceil(list.length / 2);

    const viewerType = this.getViewerWolfType();
    const isNight = this.gameState.phase === 'NIGHT';

    // MODIFICATION #2: Fix logic for hidden wolf
    const canSeeTeammate = (p) => {
      if (viewerType !== 'regular') return false; // Hidden wolves see no one
      const has = (pp, role) => (pp.originalIdentities || pp.identities).some(x => x.role === role);
      return has(p, '狼人');
    };

    const votesMap = this.fullGameData?.wolfVotes || {};
    const finalTarget = this.fullGameData?.nightActions?.[this.gameState.round]?.wolf?.target || null;

    const selectable = (p) => {
      if (!this.selection) return false;
      const me = this.playerData;
      switch (this.selection.type) {
        case 'seer': return p.isAlive && p.id != me.id;
        case 'guard': return p.isAlive && this.getSkillState('lastGuardTarget') != p.id;
        case 'witch-poison': return p.isAlive && !p.isExposedIdiot && p.id != me.id;
        case 'wolf-vote': return p.isAlive && this.canWolfAct(me);
        case 'day-vote': return p.isAlive && !p.isExposedIdiot;
        case 'knight': return p.isAlive && !p.isExposedIdiot && p.id != me.id;
        case 'hunter': return p.isAlive;
        case 'sheriff-vote': const c = this.fullGameData.sheriff?.candidates || {}, d = this.fullGameData.sheriff?.drops || {}; return p.isAlive && c[p.id] && !d[p.id];
        case 'sheriff-pass': return p.isAlive && p.id != me.id;
      }
      return false;
    };

    const isSelected = (p) => this.selection?.targetId && +this.selection.targetId === +p.id;

    const makeCard = (p) => {
      const live = 2 - p.deaths;
      const card = document.createElement('div');
      card.className = 'player-card';
      if (+this.playerId === +p.id) card.classList.add('me');
      if (!p.isAlive) card.classList.add('disabled');
      if (this.selection && !selectable(p)) card.classList.add('disabled');
      if (isSelected(p)) card.classList.add('selected');

      let wolfBadges = '';
      if (viewerType && isNight) {
          const voterIds = Object.entries(votesMap).filter(([, t]) => +t === +p.id).map(([wid]) => wid).sort((a, b) => a - b);
          wolfBadges = voterIds.map((wid, idx) => `<span class="wolf-corner" style="top:${idx * 16 + 4}px">${wid}</span>`).join('');
          if (finalTarget && +finalTarget === +p.id) card.classList.add('wolf-final-target');
      }

      const tags = [];
      if (canSeeTeammate(p)) tags.push('<span class="tag tag-team">队友</span>');
      if (p.isExposedIdiot) tags.push('<span class="tag tag-idiot">白痴</span>');

      card.innerHTML = `<div class="player-number">${p.id}${p.badge ? `<span class="sheriff-icon">👑</span>` : ''}</div><div class="tagline">${tags.join('')}</div><div class="hearts"><span class="heart ${live < 1 ? 'off' : ''}">❤</span><span class="heart ${live < 2 ? 'off' : ''}">❤</span></div>${wolfBadges}`;

      if (this.selection && selectable(p)) {
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
          const targetId = p.id.toString();
          if (this.selection.type === 'wolf-vote') {
            if (!this.canWolfAct(this.playerData) || this.gameState?.nightStatus?.wolf !== 'pending') { this.showNotification('当前不可投票', 'error'); return; }
            db.ref(`games/${this.gameId}/wolfVotes/${this.playerId}`).set(targetId);
            this.showNotification(`已投票：${targetId}号`, 'success');
          } else {
            // MODIFICATION #6: Update selection in DB
            this.setSelection({ ...this.selection, targetId });
          }
        });
      }
      return card;
    };

    list.slice(0, half).forEach(p => L.appendChild(makeCard(p)));
    list.slice(half).forEach(p => R.appendChild(makeCard(p)));
  },

  // MODIFICATION #6: Rewrote selection functions to use Firebase
  async setSelection(selectionData) {
    await db.ref(`games/${this.gameId}/playerSelections/${this.playerId}`).set(selectionData);
  },
  async clearSelection() {
    await db.ref(`games/${this.gameId}/playerSelections/${this.playerId}`).remove();
  },

  renderActionPanel() {
    const panel = this.$('action-panel');
    panel.innerHTML = '';

    if (this.gameState.phase === 'GAME_OVER') {
        panel.innerHTML = `<div class="game-over-panel"><div class="game-over-icon">🏆</div><div class="game-over-text">游戏结束</div></div>`;
        return;
    }

    const isDead = !this.playerData.isAlive;
    const ns = this.gameState.nightStatus || {};
    const role = this.getActiveRole(this.playerData);
    const dayOpen = !!this.fullGameData?.state?.dayVotingOpen;
    const actionInProgress = !!this.fullGameData.nightActions?.[this.gameState.round]?.[this.playerId]?.inProgress;

    const info = (msg) => `<div class="action-feedback">${this.escapeHTML(msg)}</div>`;
    const bar = (title, { confirmText = '确认', skipText = '跳过', allowSkip = true, allowCancel = true } = {}) => {
        const tgt = this.selection?.targetId ? `${this.selection.targetId}号` : '未选择';
        return `<div class="action-bar"><div class="action-title">${this.escapeHTML(title)}</div><div class="action-target">当前目标：<strong>${tgt}</strong></div><div class="action-buttons"><button class="confirm-btn" data-action="confirm-selection" ${!this.selection?.targetId ? 'disabled' : ''}>${confirmText}</button>${allowSkip ? `<button class="control-btn" data-action="skip-selection">${skipText}</button>` : ''}${allowCancel ? `<button class="action-btn" data-action="cancel-selection">取消</button>` : ''}</div></div>`;
    };

    if (this.gameState.phase === 'SHERIFF_TRANSFER') {
        const t = this.gameState.postDeathState;
        if (t && this.playerId == t.deadSheriffId) {
            this.setSelection({type: 'sheriff-pass'});
            panel.innerHTML = bar('你已阵亡，请选择警徽移交对象', { allowSkip: true, skipText: '撕毁警徽' });
        } else panel.innerHTML = info('等待警长移交警徽...');
        return;
    }

    if (isDead) {
        if (this.gameState.phase === 'HUNTER_ACTION' && this.gameState.hunterQueue && this.gameState.hunterQueue[this.playerId]) {
            this.setSelection({type: 'hunter'});
            panel.innerHTML = bar('你是猎人，请选择带走目标', { allowSkip: false });
        } else panel.innerHTML = `<div class="dead-panel"><div class="dead-icon">💀</div><div class="dead-text">你已出局</div></div>`;
        return;
    }

    // MODIFICATION #4: Handle sheriff drop state
    if (this.gameState.phase === 'SHERIFF_CAND') {
        const myCand = this.fullGameData.sheriff?.candidates?.[this.playerId];
        const hasDropped = this.fullGameData.sheriff?.drops?.[this.playerId];
        if (hasDropped) { panel.innerHTML = info('你已退水，无法操作'); }
        else if (myCand !== undefined) { panel.innerHTML = info(`你已选择 ${myCand ? '上警' : '不上警'}`); }
        else { panel.innerHTML = `<div class="sheriff-choice"><div class="choice-title">是否参与警长竞选？</div><div class="choice-buttons"><button class="btn-primary" data-action="sheriff-cand" data-value="1">我要上警</button><button class="control-btn" data-action="sheriff-cand" data-value="0">不上警</button></div></div>`; }
        return;
    }

    if (this.gameState.phase === 'SHERIFF_SPEECH') {
        const cand = this.fullGameData.sheriff?.candidates || {};
        const drops = this.fullGameData.sheriff?.drops || {};
        const runningCandidates = Object.keys(cand).filter(id => cand[id] && !drops[id]);

        let html = `<div class="candidate-info-box"><div class="candidate-info-title">👑 上警玩家</div><div class="candidate-list">${runningCandidates.length > 0 ? runningCandidates.map(id => `<span class="player-tag">${id}号</span>`).join('') : '<span style="color:var(--text-tertiary);">无</span>'}</div></div>`;

        const isCandidate = cand[this.playerId] && !drops[this.playerId];
        if (isCandidate) {
            html += `<div class="drop-water" style="margin-top:16px;"><button class="action-btn" data-action="sheriff-drop">💧 退水</button></div>`;
        } else {
            html += info('等待主持人推进流程...');
        }
        panel.innerHTML = html;
        return;
    }

    if (this.gameState.phase === 'SHERIFF_VOTE') {
        if (this.playerData.isExposedIdiot) { panel.innerHTML = info('你无法投票'); return; }
        const v = this.fullGameData.sheriff?.votes?.[this.playerId];
        if (v != null) { panel.innerHTML = info(`你已投票给 ${v === '0' ? '弃票' : v + '号'}`); }
        else { this.setSelection({type: 'sheriff-vote'}); panel.innerHTML = bar('为警长投票', { allowSkip: true, skipText: '弃票' }); }
        return;
    }

    if (this.gameState.phase === 'DAY') {
        if (!dayOpen) {
            if (role === '骑士' && !this.getSkillState('hasUsedDuel')) {
                this.setSelection({type: 'knight'});
                panel.innerHTML = bar('你是骑士，可在投票前发动决斗', { allowSkip: false, confirmText: '决斗', allowCancel: true });
            } else panel.innerHTML = info('等待主持人开启投票…');
        } else {
            if (this.playerData.isExposedIdiot) { panel.innerHTML = info('你无法投票'); }
            else {
                const v = this.fullGameData.dayVotes?.[this.gameState.round]?.[this.playerId];
                if (v != null) { panel.innerHTML = info(`你已投票给 ${v === '0' ? '弃票' : v + '号'}`); }
                else { this.setSelection({type: 'day-vote'}); panel.innerHTML = bar('放逐投票', { allowSkip: true, skipText: '弃票' }); }
            }
        }
        return;
    }

    if (this.gameState.phase === 'NIGHT') {
        if (actionInProgress) { panel.innerHTML = info('操作已确认，等待天亮...'); return; }

        if (role === '女巫' && ns.witch === 'pending') {
            // MODIFICATION #1: Complete Witch Logic Overhaul
            const idx = this.playerData.deaths;
            const hasCure = !this.getSkillState('hasUsedCure', this.playerData, idx);
            const hasPoison = !this.getSkillState('hasUsedPoison', this.playerData, idx);
            const wolfTarget = this.fullGameData.nightActions?.[this.gameState.round]?.wolf?.target;

            let html = `<div class="witch-panel"><div class="witch-status"><div class="potion-status"><span class="potion ${hasCure ? 'available' : 'used'}">💊 解药</span><span class="potion ${hasPoison ? 'available' : 'used'}">☠️ 毒药</span></div></div>`;

            if (this.selection?.type === 'witch-poison') {
                html += bar('毒药：请选择目标', { allowSkip: true, skipText: '不使用毒药', allowCancel: true });
            } else {
                html += '<div class="witch-actions-container">';
                if (hasCure && wolfTarget && wolfTarget !== '0') {
                    const selfRule = this.fullGameData.config?.witchSelfSaveRule || 'noFirstNightSelfSave';
                    const isSelf = +wolfTarget === +this.playerId;
                    const isFirstNight = this.gameState.round === 1;
                    let canSave = true;
                    if (isSelf && ((selfRule === 'noFirstNightSelfSave' && isFirstNight) || (selfRule === 'onlyFirstNightSelfSave' && !isFirstNight))) {
                        canSave = false;
                    }
                    html += `<button class="confirm-btn" data-action="witch-cure" data-target="${wolfTarget}" ${!canSave ? 'disabled' : ''}>💊 救 ${wolfTarget}号</button>`;
                }
                if (hasPoison) {
                    html += `<button class="action-btn" data-action="witch-poison-start">☠️ 用毒药</button>`;
                }
                html += '</div>';
                if (!hasCure && !hasPoison) { html += info('本条命药水已用尽'); }
                else if ((!wolfTarget || wolfTarget === '0') && !hasPoison) { html += info('今晚无人被刀，且无毒药可用'); }
                else if ((!wolfTarget || wolfTarget === '0') && hasPoison) { html += info('今晚无人被刀'); }
            }
            html += `</div>`;
            panel.innerHTML = html;
            return;
        }

        if (['狼人', '隐狼'].includes(role)) {
            if (ns.wolf === 'pending') {
                const can = this.canWolfAct(this.playerData);
                this.setSelection({type: 'wolf-vote'});
                let wolfPanelHtml = `<div class="wolf-inline-panel"><div class="wolf-hint">${can ? '🎯 点击上方玩家卡片投票，或选择空刀' : '⏳ 等待同伴行动'}</div><div id="wolf-votes-display" class="wolf-votes-section"></div>`;
                if(can){
                    wolfPanelHtml += `<div class="wolf-actions" style="margin-top:8px;"><button class="control-btn" data-action="skip-selection">🔪 空刀</button></div>`;
                }
                if (role === '狼人') {
                    wolfPanelHtml += `<div id="wolf-chat-area" class="wolf-chat-section"><div id="wolf-chat-messages" class="chat-messages"></div><div class="chat-input-wrapper"><input id="wolf-chat-input" class="chat-input" placeholder="输入消息..." maxlength="120" /><button data-action="wolf-send" class="btn-send"><span>发送</span></button></div></div>`;
                }
                wolfPanelHtml += `</div>`;
                panel.innerHTML = wolfPanelHtml;
                this.initWolfListeners();
                return;
            } else {
                panel.innerHTML = info('狼队已确定刀口，等待其他角色行动…');
                return;
            }
        }
        if (role === '守卫' && ns.guard === 'pending') { this.setSelection({ type: 'guard' }); panel.innerHTML = bar('守卫：请选择守护对象', { allowSkip: true, skipText: '空守' }); return; }
        if (role === '预言家' && ns.seer === 'pending') { this.setSelection({ type: 'seer' }); panel.innerHTML = bar(`预言家：请选择查验目标`, { allowSkip: true, skipText: '跳过' }); return; }
        
        panel.innerHTML = info('等待其他角色行动...');
        return;
    }

    panel.innerHTML = info('进行中…');
  },

  async confirmSelection() {
    if (!this.selection || !this.selection.targetId) return;
    const t = this.selection.targetId;
    switch (this.selection.type) {
      case 'seer': await this.seerCheck(t); break;
      case 'guard': await this.guardProtect(t); break;
      case 'witch-poison': await this.witchUsePoison(t); break;
      case 'day-vote': await db.ref(`games/${this.gameId}/dayVotes/${this.gameState.round}/${this.playerId}`).set(t); this.showNotification(`已投票：${t}号`, 'success'); break;
      case 'knight': await this.knight(t); break;
      case 'hunter': await this.hunter(t); break;
      case 'sheriff-vote': await db.ref(`games/${this.gameId}/sheriff/votes/${this.playerId}`).set(t); this.showNotification(`已投警长：${t}号`, 'success'); break;
      case 'sheriff-pass': await this.playerPassBadge(t); break;
    }
    await this.clearSelection();
  },

  async skipSelection() {
    if (!this.selection) return;
    switch (this.selection.type) {
        case 'seer': await this.seerSkip(); break;
        case 'guard': await this.guardSkip(); break;
        case 'witch-poison': await this.witchSkip(); break;
        case 'wolf-vote':
            if (!this.canWolfAct(this.playerData) || this.gameState?.nightStatus?.wolf !== 'pending') { this.showNotification('当前不可投票', 'error'); break; }
            await db.ref(`games/${this.gameId}/wolfVotes/${this.playerId}`).set('0');
            this.showNotification('已选择空刀', 'success');
            break;
        case 'day-vote': await db.ref(`games/${this.gameId}/dayVotes/${this.gameState.round}/${this.playerId}`).set('0'); this.showNotification('已投弃票', 'info'); break;
        case 'sheriff-vote': await db.ref(`games/${this.gameId}/sheriff/votes/${this.playerId}`).set('0'); this.showNotification('已为警长投弃票', 'info'); break;
        case 'sheriff-pass': await this.playerDestroyBadge(); break;
    }
    await this.clearSelection();
  },

  renderGodView() {
    const list = this.$('god-player-list');
    list.innerHTML = '';
    const fmt = (id) => `<span class="${id.isThiefCopy ? 'thief-copy' : ''}">${ROLES[id.role].icon} ${id.role}</span>`;

    Object.values(this.fullGameData.players || {}).sort((a, b) => a.id - b.id).forEach(p => {
      const live = 2 - p.deaths, ids = p.identities, d = p.deaths;
      const row = document.createElement('div');
      row.className = `god-row ${!p.isAlive ? 'dead-all' : ''}`;
      row.innerHTML = `<div class="god-player-number"><span class="player-id">${p.id}号</span>${p.badge ? '<span class="sheriff-icon">👑</span>' : ''}</div><div class="god-identities"><span class="${d >= 1 ? 'dead-identity' : ''}">${fmt(ids[0])}</span><span class="identity-plus">+</span><span class="${d >= 2 ? 'dead-identity' : ''}">${fmt(ids[1])}</span></div><div class="god-hearts"><span class="life-heart ${live < 1 ? 'lost' : ''}">❤</span><span class="life-heart ${live < 2 ? 'lost' : ''}">❤</span></div>`;
      list.appendChild(row);
    });

    const godLog = this.$('god-log-content');
    godLog.innerHTML = '';
    const logs = Object.values(this.fullGameData.logs || {}).sort((a, b) => a.timestamp - b.timestamp);
    if (logs.length === 0) {
      godLog.innerHTML = '<div class="log-empty">暂无日志</div>';
    }
    logs.forEach(log => {
      const div = document.createElement('div');
      div.className = 'log-item';
      if (log.isSecret) div.classList.add('log-secret');
      const prefix = log.round > 0 ? `<span class="log-round">[第${log.round}轮]</span> ` : '';
      div.innerHTML = prefix + this.escapeHTML(log.message);
      godLog.appendChild(div);
    });
    godLog.scrollTop = godLog.scrollHeight;
  },

  async updatePhase(phase, round = null) {
      const up = { 'state/phase': phase };
      if (round !== null) up['state/round'] = round;
      else if (phase === 'NIGHT') up['state/round'] = this.gameState.round + 1;

      if (phase === 'NIGHT') {
          // MODIFICATION #1 & #6: Reset night states and selections
          up['nightActions'] = {}; up['wolfVotes'] = {}; up['wolfChat'] = {}; up['playerSelections'] = {};
          const alive = Object.values(this.allPlayers).filter(p => p.isAlive);
          const exists = (role) => alive.some(p => this.getActiveRole(p) === role);
          const witch = alive.find(p => this.getActiveRole(p) === '女巫');
          // MODIFICATION #12: Correctly check witch state for the current life
          const wIdx = witch ? witch.deaths : -1;
          const canWitch = witch && (!this.getSkillState('hasUsedCure', witch, wIdx) || !this.getSkillState('hasUsedPoison', witch, wIdx));
          const status = { guard: exists('守卫') ? 'pending' : 'complete', seer: exists('预言家') ? 'pending' : 'complete', wolf: this.isAnyWolfInGame() ? 'pending' : 'complete', witch: canWitch ? 'locked' : 'complete' };
          if (status.wolf === 'complete' && status.witch === 'locked') status.witch = 'pending';
          up['state/nightStatus'] = status;
      }
      if (phase === 'DAY') { up['state/dayVotingOpen'] = false; up['playerSelections'] = {}; }
      if (phase === 'SHERIFF_CAND') { up['sheriff'] = { candidates: {}, drops: {}, votes: {} }; }
      await db.ref(`games/${this.gameId}`).update(up);
  },

  async guardProtect(id) { await this.setNightAction({ target: id }); await this.addGameLog(`🛡️ 守卫(${this.playerId}号)守护了 ${id}号`, true); await db.ref(`games/${this.gameId}/state/nightStatus/guard`).set('complete'); await this.setSkillState('lastGuardTarget', id); this.showNotification(`你守护了 ${id}号`, 'success'); },
  async guardSkip() { await this.setNightAction({ target: null, skipped: true }); await this.addGameLog(`🛡️ 守卫(${this.playerId}号)空守`, true); await db.ref(`games/${this.gameId}/state/nightStatus/guard`).set('complete'); await this.setSkillState('lastGuardTarget', null); },

  async seerCheck(id) {
    const mode = this.fullGameData.config?.seerMode || 'faction';
    let result = '';
    if (mode === 'faction') {
      const target = this.allPlayers[id];
      const hasRegularWolf = (target.identities || []).some(x => x.role === '狼人');
      result = hasRegularWolf ? '狼人' : '好人';
    } else {
      result = this.getActiveRole(this.allPlayers[id]) || '未知';
    }
    await this.setNightAction({ target: id, result });
    await db.ref(`games/${this.gameId}/state/nightStatus/seer`).set('complete');
    await this.addGameLog(`🔮 预言家(${this.playerId}号)查验 ${id}号，结果为 ${result}`, true);
    const rec = this.getGlobalSkillState('seerResults') || {}; rec[id] = result; await this.setGlobalSkillState('seerResults', rec);
    this.showNotification(`查验结果：${id}号 → ${result}`, 'success');
  },
  async seerSkip() { await this.setNightAction({ target: null, skipped: true }); await db.ref(`games/${this.gameId}/state/nightStatus/seer`).set('complete'); await this.addGameLog(`🔮 预言家(${this.playerId}号)跳过查验`, true); },

  async witchTryCure(targetId) {
    // MODIFICATION #1: Witch logic now uses the inProgress flag and is atomic
    const round = this.gameState.round;
    const actionRef = db.ref(`games/${this.gameId}/nightActions/${round}/${this.playerId}`);
    
    const trx = await actionRef.transaction(currentData => {
        if (currentData && currentData.inProgress) return; // Abort if action already taken
        return { inProgress: true, cure: targetId };
    });

    if (trx.committed) {
        await this.setSkillState('hasUsedCure', true);
        await db.ref(`games/${this.gameId}/state/nightStatus/witch`).set('complete');
        await this.addGameLog(`🧪 女巫(${this.playerId}号)使用解药救了 ${targetId}号`, true);
        this.showNotification(`你救了 ${targetId}号`, 'success');
    } else {
        this.showNotification('操作失败，本晚已使用过药瓶', 'error');
    }
  },

  async witchUsePoison(id) {
    const round = this.gameState.round;
    const actionRef = db.ref(`games/${this.gameId}/nightActions/${round}/${this.playerId}`);

    const trx = await actionRef.transaction(currentData => {
        if (currentData && currentData.inProgress) return;
        return { inProgress: true, poison: id };
    });

    if (trx.committed) {
        await this.setSkillState('hasUsedPoison', true);
        await db.ref(`games/${this.gameId}/state/nightStatus/witch`).set('complete');
        await this.addGameLog(`🧪 女巫(${this.playerId}号)毒杀了 ${id}号`, true);
        this.showNotification(`你毒杀了 ${id}号`, 'error');
    } else {
        this.showNotification('操作失败，本晚已使用过药瓶', 'error');
    }
  },
  async witchSkip() { await this.setNightAction({ skipped: true }); await db.ref(`games/${this.gameId}/state/nightStatus/witch`).set('complete'); await this.addGameLog(`🧪 女巫(${this.playerId}号)未使用药水`, true); },

  async knight(id) {
    await this.setSkillState('hasUsedDuel', true);
    const role = this.getActiveRole(this.allPlayers[id]);
    const isEvil = ['狼人', '隐狼'].includes(role);
    const loser = isEvil ? id : this.playerId;
    const loserRole = isEvil ? role : this.getActiveRole(this.playerData);
    await this.addGameLog(`⚔️ 骑士 ${this.playerId}号 对 ${id}号 发动决斗！`, false);
    const res = await this.kill(loser, 'DUEL');
    // MODIFICATION #11: Clear public logs
    if (isEvil) {
        await this.addGameLog(`决斗成功！${loser}号(${loserRole}) 阵亡。游戏直接进入夜晚。`, false);
        await this.handlePostDeath({ ...res, nextPhaseIfNoAction: 'NIGHT' });
    } else {
        await this.addGameLog(`决斗失败！骑士 ${loser}号 阵亡。发言继续。`, false);
        await this.handlePostDeath({ ...res, nextPhaseIfNoAction: 'DAY' });
    }
  },

  async hunter(id) {
    await this.addGameLog(`🔫 猎人 ${this.playerId}号 开枪带走了 ${id}号！`, false);
    await db.ref(`games/${this.gameId}/state/hunterQueue/${this.playerId}`).set(null);
    const res = await this.kill(id, 'HUNTER');
    if (res.sheriffDied) return;
    const remain = (await db.ref(`games/${this.gameId}/state/hunterQueue`).once('value')).val() || {};
    if (Object.values(remain).some(v => v === true)) {
        await this.updatePhase('HUNTER_ACTION');
    } else {
        const next = this.gameState.postDeathState?.nextPhase || (this.gameState.phase === 'DAY' ? 'NIGHT' : 'DAY');
        if (!this.gameState.postDeathState || !this.gameState.postDeathState.deadSheriffId) {
            await db.ref(`games/${this.gameId}/state/postDeathState`).set(null);
        }
        await this.updatePhase(next);
    }
  },

  getViewerWolfType() {
    if (!this.playerData) return null;
    const has = (role) => (this.playerData.originalIdentities || this.playerData.identities).some(x => x.role === role);
    if (has('狼人')) return 'regular';
    if (has('隐狼')) return 'hidden';
    return null;
  },
  canWolfAct(p) {
    const role = this.getActiveRole(p);
    if (role === '狼人') return true;
    if (role === '隐狼') {
      const livingRegular = Object.values(this.allPlayers).filter(pp => pp.isAlive && this.getActiveRole(pp) === '狼人');
      return livingRegular.length === 0;
    }
    return false;
  },
  getAlphaWolfId() {
    const livingRegular = Object.values(this.allPlayers).filter(p => p.isAlive && this.getActiveRole(p) === '狼人');
    if (livingRegular.length > 0) return Math.min(...livingRegular.map(p => p.id)).toString();
    const livingInvisible = Object.values(this.allPlayers).filter(p => p.isAlive && this.getActiveRole(p) === '隐狼');
    if (livingInvisible.length > 0) return Math.min(...livingInvisible.map(p => p.id)).toString();
    return null;
  },
  initWolfListeners() {
    this.stopWolfListeners(false);
    const myType = this.getViewerWolfType(); if (!myType) return;

    this.wolfVotesCallbackRef = (snap) => {
      const votes = snap.val() || {};
      const alpha = this.getAlphaWolfId();
      const display = this.$('wolf-votes-display'); if (!display) return;

      let voters = Object.values(this.allPlayers).filter(p => p.isAlive && this.getActiveRole(p) === '狼人');
      if (voters.length === 0) { voters = Object.values(this.allPlayers).filter(p => p.isAlive && this.getActiveRole(p) === '隐狼'); }

      let html = '<div class="wolf-vote-title">🗳️ 投票情况</div><div class="wolf-vote-list">';
      voters.sort((a, b) => a.id - b.id).forEach(w => {
        const v = votes[w.id]; const vt = v != null ? (v === '0' ? '空刀' : `${v}号`) : '未投票';
        const isAlpha = (alpha && w.id.toString() === alpha);
        html += `<div class="wolf-vote-item"><span class="voter">${w.id}号 ${isAlpha ? '<span class="alpha-badge">拍板</span>' : ''}</span><span class="vote-arrow">→</span><span class="vote-target ${v != null ? 'voted' : ''}">${vt}</span></div>`;
      });
      html += '</div>';
      if (this.playerId === alpha && votes[alpha] != null && this.gameState?.nightStatus?.wolf === 'pending') {
        const tgt = votes[alpha];
        html += `<div class="wolf-confirm-section"><button class="confirm-btn wolf-confirm-btn" data-action="wolf-confirm" data-value="${tgt}">🎯 确认袭击 ${tgt === '0' ? '空刀' : tgt + '号'}</button></div>`;
      }
      display.innerHTML = html;
    };
    this.wolfVotesListener = db.ref(`games/${this.gameId}/wolfVotes`);
    this.wolfVotesListener.on('value', this.wolfVotesCallbackRef);

    if (myType === 'regular') {
      const chatRef = db.ref(`games/${this.gameId}/wolfChat`);
      const box = this.$('wolf-chat-messages'); if (box) box.innerHTML = '';
      this.wolfChatListener = chatRef.limitToLast(80).on('child_added', s => {
        const v = s.val(); if (!v) return;
        const p = document.createElement('div');
        p.className = 'chat-message';
        p.innerHTML = `<span class="chat-sender">${v.pid}号:</span> <span class="chat-text">${this.escapeHTML(v.msg)}</span>`;
        if (box) { box.appendChild(p); box.scrollTop = box.scrollHeight; }
      });
    }
  },
  stopWolfListeners(hide = true) {
    if (this.wolfVotesListener && this.wolfVotesCallbackRef) { db.ref(`games/${this.gameId}/wolfVotes`).off('value', this.wolfVotesCallbackRef); this.wolfVotesListener = null; this.wolfVotesCallbackRef = null; }
    if (this.wolfChatListener) { db.ref(`games/${this.gameId}/wolfChat`).off('child_added', this.wolfChatListener); this.wolfChatListener = null; }
  },
  async wolfConfirmKill(btn) {
    // MODIFICATION #10: Add client-side lock
    btn.disabled = true;
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';
    const targetId = btn.dataset.value;

    const alpha = this.getAlphaWolfId();
    if (this.playerId !== alpha || !this.canWolfAct(this.playerData) || this.gameState?.nightStatus?.wolf !== 'pending') {
        this.showNotification('你无权确认或当前不可确认', 'error');
        btn.disabled = false;
        btn.innerHTML = originalText;
        return;
    }
    
    const ref = db.ref(`games/${this.gameId}/nightActions/${this.gameState.round}/wolf`);
    const trx = await ref.transaction(cur => {
        if (cur) return; // Abort if already set
        return { target: targetId, actorId: this.playerId };
    });

    if (trx.committed) {
        await this.addGameLog(`🐺 狼队决定袭击 ${targetId === '0' ? '空刀' : targetId + '号'} (由${this.playerId}号确认)`, true);
        await db.ref(`games/${this.gameId}/state/nightStatus`).transaction(st => { if (!st) return st; st.wolf = 'complete'; if (st.witch === 'locked') st.witch = 'pending'; return st; });
        this.showNotification(`已确认袭击 ${targetId === '0' ? '空刀' : targetId + '号'}`, 'success');
        await this.clearSelection();
    } else {
        this.showNotification('确认失败：已有其他狼人确认刀口', 'error');
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
  },
  sendWolfMessage() {
    const type = this.getViewerWolfType(); if (type !== 'regular') { this.showNotification('你无法在狼窝发言', 'error'); return; }
    const inp = this.$('wolf-chat-input'); const msg = (inp.value || '').trim(); if (!msg) return; if (msg.length > 120) { this.showNotification('消息过长', 'error'); return; }
    db.ref(`games/${this.gameId}/wolfChat`).push({ pid: this.playerId, msg, ts: firebase.database.ServerValue.TIMESTAMP }); inp.value = '';
  },

  async hostEnterSheriffVote() {
    const cand = this.fullGameData.sheriff?.candidates || {}, drops = this.fullGameData.sheriff?.drops || {};
    const valid = Object.keys(cand).filter(id => cand[id] && !drops[id]);
    if (valid.length === 1) {
      const sid = valid[0]; await db.ref(`games/${this.gameId}/players/${sid}/badge`).set(1);
      await this.addGameLog(`👑 ${sid}号独警，直接当选警长！`, false);
      if (this.gameState.round === 1) await this.processNight(); else await this.updatePhase('DAY');
    } else {
      await this.updatePhase('SHERIFF_VOTE');
    }
  },
  async hostSheriffElectSingle() {
    const cand = this.fullGameData.sheriff?.candidates || {}, drops = this.fullGameData.sheriff?.drops || {};
    const valid = Object.keys(cand).filter(id => cand[id] && !drops[id]);
    if (valid.length === 1) {
      const sid = valid[0]; await db.ref(`games/${this.gameId}/players/${sid}/badge`).set(1);
      await this.addGameLog(`👑 ${sid}号独警，直接当选警长！`, false);
      if (this.gameState.round === 1) await this.processNight(); else await this.updatePhase('DAY');
    } else this.showNotification('当前非独警，无法直接当选', 'error');
  },

  async tallySheriffVotes() {
    const votes = this.fullGameData.sheriff?.votes || {}; const counts = {};
    Object.values(votes).forEach(t => { if (t !== '0') counts[t] = (counts[t] || 0) + 1; });
    const voters = Object.values(this.allPlayers).filter(p => p.isAlive && !p.isExposedIdiot);
    let details = '警长投票详情：' + voters.map(v => {
      const t = votes[v.id]; if (t === undefined) return `${v.id}号(未投)`; if (t === '0') return `${v.id}号(弃票)`; return `${v.id}号→${t}号`;
    }).join('，');
    await this.addGameLog(details, false);
    const max = Object.keys(counts).length ? Math.max(...Object.values(counts)) : 0;
    const winners = Object.keys(counts).filter(id => counts[id] === max);
    if (winners.length === 1) {
      const sid = winners[0]; await db.ref(`games/${this.gameId}/players/${sid}/badge`).set(1);
      await this.addGameLog(`👑 ${sid}号当选警长！`, false);
      if (this.gameState.round === 1) await this.processNight(); else await this.updatePhase('DAY');
    } else {
      const isPK = this.fullGameData.sheriff?.isPKRound;
      if (isPK) {
          await this.addGameLog('⚖️ PK后再次平票，本轮无警长。', false);
          await db.ref(`games/${this.gameId}/sheriff`).set(null);
          if (this.gameState.round === 1) await this.processNight(); else await this.updatePhase('DAY');
          return;
      }
      await this.addGameLog(winners.length > 1 ? `⚖️ 平票：${winners.join('、')}号，进入PK环节。` : '⚖️ 无人当选警长。', false);
      const newC = {}; if (winners.length > 1) winners.forEach(id => newC[id] = 1);
      await db.ref(`games/${this.gameId}/sheriff`).set({ candidates: newC, drops: {}, votes: {}, isPKRound: true });
      if (winners.length > 1) await this.updatePhase('SHERIFF_SPEECH');
      else if (this.gameState.round === 1) await this.processNight(); else await this.updatePhase('DAY');
    }
  },

  async tallyDayVotes() {
      const votes = this.fullGameData.dayVotes?.[this.gameState.round] || {}; const counts = {};
      const sheriffId = Object.keys(this.allPlayers).find(id => this.allPlayers[id].badge);
      const voters = Object.values(this.allPlayers).filter(p => p.isAlive && !p.isExposedIdiot);
      let details = '放逐投票详情：' + voters.map(v => {
          const t = votes[v.id]; if (t === undefined) return `${v.id}号(未投)`; if (t === '0') return `${v.id}号(弃票)`; return `${v.id}号${v.id == sheriffId ? '(警长)' : ''}→${t}号`;
      }).join('，');
      await this.addGameLog(details, false);
      Object.entries(votes).forEach(([voter, target]) => {
          if (target !== '0') {
              // MODIFICATION #5: Update vote weights
              const w = (voter == sheriffId) ? 3 : 2;
              counts[target] = (counts[target] || 0) + w;
          }
      });
      const max = Object.keys(counts).length ? Math.max(...Object.values(counts)) : 0;
      const outs = Object.keys(counts).filter(id => counts[id] === max);
      if (outs.length === 1) {
          const id = outs[0];
          await this.addGameLog(`⚖️ ${id}号以 ${counts[id]} 票被放逐。`, false);
          const r = await this.kill(id, 'VOTE'); await this.handlePostDeath({ ...r, nextPhaseIfNoAction: 'NIGHT' });
      } else {
          await this.addGameLog(outs.length > 1 ? `⚖️ 平票：${outs.join('、')}号。无人出局。` : '⚖️ 无人出局。', false);
          await this.updatePhase('NIGHT');
      }
  },

  async playerPassBadge(to) {
    const st = this.gameState.postDeathState || {};
    if (this.playerId != st.deadSheriffId) { this.showNotification('你无权操作警徽', 'error'); return; }
    const up = { [`players/${st.deadSheriffId}/badge`]: 0, [`players/${to}/badge`]: 1, 'state/postDeathState': null };
    await db.ref(`games/${this.gameId}`).update(up);
    await this.addGameLog(`👑 警徽已由 ${st.deadSheriffId}号 移交给 ${to}号。`, false);
    await this.handlePostDeath({ hunterTriggered: st.hunterTriggered, sheriffDied: false, nextPhaseIfNoAction: st.nextPhase });
  },
  async playerDestroyBadge(isForced = false) {
    const st = this.gameState.postDeathState || {};
    if (!isForced && this.playerId != st.deadSheriffId) { this.showNotification('你无权操作警徽', 'error'); return; }
    const up = { [`players/${st.deadSheriffId}/badge`]: 0, 'state/postDeathState': null };
    await db.ref(`games/${this.gameId}`).update(up);
    await this.addGameLog(`💔 警徽已被 ${st.deadSheriffId}号 撕毁。`, false);
    await this.handlePostDeath({ hunterTriggered: st.hunterTriggered, sheriffDied: false, nextPhaseIfNoAction: st.nextPhase });
  },

  async handlePostDeath({ hunterTriggered, sheriffDied, nextPhaseIfNoAction = 'DAY' }) {
    // MODIFICATION #8: Enhanced logging
    await this.addGameLog(`[系统] Post-death check: hunterTriggered=${hunterTriggered}, sheriffDied=${sheriffDied}`, true);
    if (sheriffDied) return;
    const over = await this.checkWin(); if (over) return;
    const q = (await db.ref(`games/${this.gameId}/state/hunterQueue`).once('value')).val() || {};
    if (Object.values(q).some(v => v === true)) {
      await this.addGameLog(`[系统] 检测到猎人队列，进入开枪阶段`, true);
      await db.ref(`games/${this.gameId}/state/postDeathState`).transaction(v => { v = v || {}; v.nextPhase = nextPhaseIfNoAction; return v; });
      await this.updatePhase('HUNTER_ACTION');
    } else if (nextPhaseIfNoAction) {
      await this.addGameLog(`[系统] 无特殊死亡事件，进入下一阶段: ${nextPhaseIfNoAction}`, true);
      await this.updatePhase(nextPhaseIfNoAction);
    }
  },
  async kill(pid, cause) {
      // MODIFICATION #8: Enhanced logging
      await this.addGameLog(`[系统] 正在处理 ${pid}号 的死亡事件，原因: ${cause}`, true);
      let result = { hunterTriggered: false, sheriffDied: false };
      const pBefore = this.allPlayers[pid]; if (!pBefore || !pBefore.isAlive) return result;
      const roleBefore = this.getActiveRole(pBefore);
      let idiotFlipped = false;
      
      const trx = await db.ref(`games/${this.gameId}/players/${pid}`).transaction(p => {
          if (!p || !p.isAlive) return p;
          const idx = p.deaths;
          if (cause === 'VOTE' && p.identities[idx]?.role === '白痴' && !p.isExposedIdiot) {
              p.isExposedIdiot = true;
              idiotFlipped = true;
          }
          p.deaths = Math.min(p.deaths + 1, 2);
          if (p.deaths >= 2) p.isAlive = false;
          return p;
      });

      if (!trx.committed) return result;
      if (idiotFlipped) await this.addGameLog(`🤪 ${pid}号被投票出局，翻开白痴身份！`, false);
      
      const p = trx.snapshot.val();
      const wasSheriff = pBefore.badge, nowDead = !p.isAlive;
      const willHunter = roleBefore === '猎人' && (['NIGHT', 'VOTE', 'POISON', 'DUEL'].includes(cause));

      if (willHunter) {
          await db.ref(`games/${this.gameId}/state/hunterQueue/${pid}`).set(true);
          result.hunterTriggered = true;
          await this.addGameLog(`[系统] ${pid}号是猎人，已加入开枪队列`, true);
      }
      if (nowDead && wasSheriff) {
          const next = (cause === 'DAY' || cause === 'VOTE' || cause === 'DUEL') ? 'NIGHT' : 'DAY';
          await db.ref(`games/${this.gameId}/state`).update({ phase: 'SHERIFF_TRANSFER', postDeathState: { deadSheriffId: pid, hunterTriggered: result.hunterTriggered, nextPhase: next } });
          result.sheriffDied = true;
          await this.addGameLog(`[系统] ${pid}号是警长且已死亡，进入警徽移交阶段`, true);
      }
      await this.checkWin();
      return result;
  },
  async processNight() {
    await this.addGameLog('🌙 天亮了。', false);
    const nightActions = this.fullGameData.nightActions?.[this.gameState.round] || {};
    const deaths = [];

    // Consolidate actions
    const wolf = nightActions.wolf;
    const guard = Object.values(nightActions).find(a => a.target !== undefined && a.actorId && this.getActiveRole(this.allPlayers[a.actorId]) === '守卫');
    const witch = Object.values(nightActions).find(a => (a.cure || a.poison) && a.actorId && this.getActiveRole(this.allPlayers[a.actorId]) === '女巫');
    
    const wolfTarget = wolf?.target;
    const guardTarget = guard?.target;
    const cureTarget = witch?.cure;
    const poisonTarget = witch?.poison;

    if (wolfTarget && wolfTarget !== '0') {
      const guarded = guardTarget === wolfTarget;
      const cured = cureTarget === wolfTarget;
      if (guarded) await this.addGameLog(`🛡️ 守卫成功守护了 ${wolfTarget}号`, true);
      if (cured) await this.addGameLog(`🧪 女巫使用解药救活了 ${wolfTarget}号`, true);
      if (!guarded && !cured) deaths.push({ pid: wolfTarget, cause: 'NIGHT' });
    }
    if (poisonTarget && !deaths.some(d => d.pid === poisonTarget)) {
      deaths.push({ pid: poisonTarget, cause: 'POISON' });
      await this.addGameLog(`🧪 女巫使用毒药杀害了 ${poisonTarget}号`, true);
    }

    let anyH = false, anyS = false;
    if (deaths.length) {
      const ids = [...new Set(deaths.map(d => d.pid))].sort((a, b) => a - b).join('号、');
      await this.addGameLog(`死亡的玩家是：${ids}号`, false);
      await db.ref(`games/${this.gameId}/state/peaceNightStreak`).set(0);
      for (const d of deaths) {
        const r = await this.kill(d.pid, d.cause);
        if (r.hunterTriggered) anyH = true;
        if (r.sheriffDied) { anyS = true; break; }
      }
    } else {
      await this.addGameLog('昨夜平安夜。', false);
      const streak = (this.gameState.peaceNightStreak || 0) + 1;
      await db.ref(`games/${this.gameId}/state/peaceNightStreak`).set(streak);
    }
    await this.handlePostDeath({ hunterTriggered: anyH, sheriffDied: anyS, nextPhaseIfNoAction: 'DAY' });
  },

  async checkWin() {
    await new Promise(r => setTimeout(r, 100));
    const s = await db.ref(`games/${this.gameId}`).once('value'); if (!s.exists()) return false;
    const g = s.val(); if (g.state.phase === 'GAME_OVER') return true;
    let winner = null;
    const all = Object.values(g.players);
    const wolfPlayers = all.filter(p => p.originalIdentities.some(id => ROLES[id.role].faction === 'bad'));
    const goodPlayers = all.filter(p => !p.originalIdentities.some(id => ROLES[id.role].faction === 'bad'));
    const godPlayers = all.filter(p => p.originalIdentities.some(id => ROLES[id.role].isGod));
    const civilianPlayers = all.filter(p => p.originalIdentities.every(id => !ROLES[id.role].isGod && ROLES[id.role].faction === 'good'));

    const allWolvesDead = wolfPlayers.every(p => !p.isAlive);
    if (allWolvesDead) winner = '游戏结束 - 好人阵营胜利！(狼人已全部出局)';
    if (g.state.peaceNightStreak >= 3) winner = '游戏结束 - 好人阵营胜利！(连续三晚平安夜)';

    if (!winner) {
      const mode = g.config?.wolfWin || 'edge';
      if (mode === 'exterminate') {
        const allGoodsDead = goodPlayers.length > 0 && goodPlayers.every(p => !p.isAlive);
        if (allGoodsDead) winner = '游戏结束 - 狼人阵营胜利！(屠城：好人全灭)';
      } else {
        const allGodsDead = godPlayers.length > 0 && godPlayers.every(p => !p.isAlive);
        const allCiviliansDead = civilianPlayers.length > 0 && civilianPlayers.every(p => !p.isAlive);
        if (allGodsDead) winner = '游戏结束 - 狼人阵营胜利！(屠边达成：神职全灭)';
        if (allCiviliansDead) winner = '游戏结束 - 狼人阵营胜利！(屠边达成：民牌全灭)';
      }
    }
    if (winner) {
      await db.ref(`games/${this.gameId}/state`).update({ phase: 'GAME_OVER', winner });
      await this.addGameLog(`🏆 ${winner}`, false);
      return true;
    }
    return false;
  },

  getActiveRole(p) { if (!p || !p.isAlive) return null; if (p.deaths >= p.identities.length) return null; const cur = p.identities[p.deaths]; return cur ? cur.role : null; },
  isAnyWolfInGame() { return Object.values(this.allPlayers).some(p => p.isAlive && ['狼人', '隐狼'].includes(this.getActiveRole(p))); },
  getSkillState(key, player = null, idx = -1) { const p = player || this.playerData; if (!p) return undefined; const i = idx !== -1 ? idx : p.deaths; return (p.skillStates || {})[`${i}_${key}`]; },
  async setSkillState(key, value) { const i = this.playerData.deaths; await db.ref(`games/${this.gameId}/players/${this.playerId}/skillStates/${i}_${key}`).set(value); },
  getGlobalSkillState(key) { return (this.playerData?.skillStates || {})[`global_${key}`]; },
  async setGlobalSkillState(key, val) { await db.ref(`games/${this.gameId}/players/${this.playerId}/skillStates/global_${key}`).set(val); },
  async setNightAction(data) {
    // Helper to set atomic night actions for simple roles
    const round = this.gameState.round;
    const actionRef = db.ref(`games/${this.gameId}/nightActions/${round}/${this.playerId}`);
    await actionRef.set({ ...data, actorId: this.playerId, inProgress: true });
  }
};

window.App = App;
document.addEventListener('DOMContentLoaded', () => App.init());
