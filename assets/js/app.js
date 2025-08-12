/* ========================================
   双身份狼人杀 - V10.3 (综合优化修复版)
   - 作者: AI Assistant
   - 更新日志 (V10.3):
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
   - #15 [本此修复] 修复了身份配置界面无法渲染的BUG
   - #16 [本此修复] 增加了大量注释并优化了代码结构
======================================== */

// --- Firebase 配置 ---
// 用于连接到 Firebase Realtime Database，实现游戏数据的实时同步。
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


// --- 游戏核心常量 ---

// 定义所有角色及其属性
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

// 默认的游戏身份配置
const DEFAULT_SETUP = { '平民': 6, '守卫': 1, '白痴': 1, '预言家': 1, '骑士': 1, '女巫': 1, '猎人': 1, '狼人': 2, '隐狼': 1, '盗贼': 1 };

// 禁止出现在同一玩家身份牌中的组合
const FORBIDDEN_RAW = [['预言家', '狼人'], ['预言家', '隐狼'], ['盗贼', '隐狼'], ['隐狼', '狼人'], ['隐狼', '隐狼']];


// --- 主应用对象 ---
// 封装了整个应用的状和方法
const App = {
  // --- 核心状态属性 ---
  gameId: null,             // 当前游戏ID
  playerId: null,           // 当前玩家ID
  isHost: false,            // 当前玩家是否为主持人
  allPlayers: {},           // 缓存的所有玩家数据
  playerData: null,         // 当前玩家的详细数据
  fullGameData: null,       // 完整的游戏数据快照
  gameState: null,          // 游戏的核心状态 (阶段, 回合等)
  selection: null,          // 当前玩家的选择状态 (如目标)，实时同步
  
  // --- 监听器管理 ---
  gameListener: null,       // 游戏主数据监听器
  logListener: null,        // 游戏日志监听器
  logQueryRef: null,        // 日志查询引用
  seenLogKeys: new Set(),   // 用于防止日志重复渲染
  wolfChatListener: null,   // 狼人聊天监听器
  wolfVotesListener: null,  // 狼人投票监听器
  wolfVotesCallbackRef: null, // 狼人投票回调函数引用
  playerSelectionListener: null, // 玩家选择状态监听器

  // --- 工具方法 ---

  /**
   * DOM元素选择器
   * @param {string} id - 元素的ID
   * @returns {HTMLElement} 对应的DOM元素
   */
  $(id) { return document.getElementById(id) },

  /**
   * HTML特殊字符转义，防止XSS攻击
   * @param {string} s - 需要转义的字符串
   * @returns {string} 转义后的安全字符串
   */
  escapeHTML(s) { 
    return typeof s === 'string' 
      ? s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])) 
      : '';
  },

  /**
   * Fisher-Yates (aka Knuth) 洗牌算法
   * @param {Array} a - 需要被打乱的数组
   * @returns {Array} 打乱后的数组
   */
  _shuffle(a) { 
    let i = a.length, r; 
    while (i) { 
      r = Math.floor(Math.random() * i--);
      [a[i], a[r]] = [a[r], a[i]];
    } 
    return a; 
  },

  /**
   * 显示一个浮动通知
   * @param {string} msg - 通知内容
   * @param {string} type - 通知类型 ('info', 'success', 'error')
   * @param {number} duration - 显示时长 (毫秒)
   */
  showNotification(msg, type = 'info', duration = 5000) {
    const container = this.$('notification-container');
    const notificationDiv = document.createElement('div');
    notificationDiv.className = `notification ${type}`;
    notificationDiv.innerHTML = `<div class="notification-content">${this.escapeHTML(msg)}</div>`;
    container.appendChild(notificationDiv);
    
    // 动画效果
    setTimeout(() => notificationDiv.classList.add('show'), 10);
    setTimeout(() => {
      notificationDiv.classList.add('fade-out');
      setTimeout(() => notificationDiv.remove(), 300);
    }, duration);
  },

  /**
   * 向数据库添加一条游戏日志
   * @param {string} message - 日志内容
   * @param {boolean} isSecret - 是否为秘密日志 (仅上帝视角可见)
   */
  async addGameLog(message, isSecret = false) {
    const entry = { 
      message, 
      round: this.gameState?.round || 0, 
      timestamp: firebase.database.ServerValue.TIMESTAMP, 
      isSecret 
    };
    await db.ref(`games/${this.gameId}/logs`).push(entry);
  },

  // --- 应用初始化与视图管理 ---

  /**
   * 应用入口函数
   * - 解析URL参数
   * - 决定显示设置界面还是游戏界面
   */
  init() {
    const urlParams = new URLSearchParams(window.location.search);
    this.gameId = urlParams.get('game');
    this.playerId = urlParams.get('player');

    // 全局事件监听器，处理按钮点击等
    document.body.addEventListener('click', (e) => this.handleGlobalClick(e));

    if (this.gameId && this.playerId) {
      // 如果URL中包含游戏和玩家ID，则直接进入游戏
      this.showView('game');
      this.startApp();
    } else if (this.gameId && !this.playerId) {
      // 如果只有游戏ID，则显示加入页面
      this.renderJoinPage();
    } else {
      // 否则，显示游戏创建/设置页面
      this.showView('setup');
      this.initializeSetupScreen();
    }
  },

  /**
   * 初始化游戏设置界面
   */
  initializeSetupScreen() {
    this.$('role-setup-section').classList.remove('hidden');
    this.$('btn-create').classList.remove('hidden');
    this.$('btn-create').disabled = false;
    this.$('create-text').classList.remove('hidden');
    this.$('create-spinner').classList.add('hidden');
    this.$('game-creation-info').classList.add('hidden');
    this.$('setup-error').classList.add('hidden');
    this.$('setup-error').textContent = '';
    
    // 渲染身份配置选项
    this.renderRoleSetup();
  },

  /**
   * 切换显示的主要视图 (setup, game, god)
   * @param {string} viewName - 'setup', 'game', 或 'god'
   */
  showView(viewName) {
    ['setup', 'game', 'god'].forEach((v) => {
      const el = this.$(`${v}-view`);
      if (el) {
        el.classList.add('hidden');
        el.classList.remove('view-active');
      }
    });
    const targetView = this.$(`${viewName}-view`);
    if (targetView) {
      targetView.classList.remove('hidden');
      setTimeout(() => targetView.classList.add('view-active'), 10);
    }
  },

  /**
   * 开始应用的核心逻辑，在获取到 gameId 和 playerId 后调用
   * - 验证游戏是否存在
   * - 根据玩家ID（0为上帝）设置不同的监听器
   */
  async startApp() {
    const snap = await db.ref(`games/${this.gameId}`).once('value');
    if (!snap.exists()) {
      this.detachAllListeners();
      document.body.innerHTML = `<div class="error-container" style="text-align:center; margin-top: 100px;"><div style="font-size:48px;">😵</div><h2>游戏不存在</h2><p>游戏房间已关闭或链接无效</p><button onclick="location.href='?'" class="btn-primary" style="margin-top:20px;">返回首页</button></div>`;
      return;
    }

    if (this.playerId === '0') {
      // 上帝视角
      this.isHost = true; // 上帝视角默认拥有部分主持权限
      this.showView('god');
      this.listenToGameChanges(this.renderGodView.bind(this));
    } else {
      // 玩家视角
      this.showView('game');
      this.listenToGameChanges(this.renderAll.bind(this));
      this.listenToLogs();
      this.listenToPlayerSelection();
    }
  },

  /**
   * 渲染加入游戏页面 (当URL中只有gameId时)
   */
  renderJoinPage() {
    this.showView('setup'); // Hide other views
    const setupContainer = this.$('setup-container');
    setupContainer.innerHTML = `
      <div class="setup-header">
        <h2>加入游戏</h2>
        <p class="setup-subtitle">输入法官分配给你的座位号</p>
      </div>
      <div style="margin:24px 0;">
        <input id="player-id-input" type="number" class="fancy-input" placeholder="请输入座位号" min="1" max="20">
      </div>
      <button id="join-game-btn" class="btn-primary btn-large">
        <span>进入游戏</span>
      </button>`;

    const input = this.$('player-id-input');
    const btn = this.$('join-game-btn');
    
    const joinAction = () => {
      const id = input.value;
      if (id && +id > 0) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';
        const url = new URL(location.href);
        url.searchParams.set('player', id);
        location.href = url.toString();
      } else {
        this.showNotification('请输入有效的座位号（例如：1, 2, 3...）', 'error');
        input.classList.add('shake');
        setTimeout(() => input.classList.remove('shake'), 500);
      }
    };

    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') joinAction();
    });
    btn.addEventListener('click', joinAction);
  },

  // --- 事件处理 ---

  /**
   * 全局点击事件委托处理器
   * @param {Event} e - 点击事件对象
   */
  handleGlobalClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;

    // 添加点击动画
    btn.classList.add('clicked');
    setTimeout(() => btn.classList.remove('clicked'), 280);

    const action = btn.dataset.action;

    // 无需权限验证的通用操作
    if (action === 'open-logs') { this.openModal('logs-modal'); return; }
    if (action === 'close-modal') { this.closeModal(btn.dataset.target); return; }
    if (action === 'copy-link') { this.copyLink(btn); return; }

    // 主持人权限验证
    if (action.startsWith('host-') && !this.isHost) {
      this.showNotification('只有主持人才能执行此操作', 'error');
      return;
    }
    
    // 根据 action 执行对应函数
    switch (action) {
      case 'create-game': this.createGame(); break;
      case 'host-start': this.updatePhase('NIGHT', 1); break;
      case 'host-day': this.processNight(); break;
      case 'confirm-selection': this.confirmSelection(); break;
      case 'skip-selection': this.skipSelection(); break;
      case 'cancel-selection': this.clearSelection(); break;
      case 'wolf-confirm': this.wolfConfirmKill(btn); break;
      case 'witch-cure': this.witchTryCure(btn.dataset.target); break;
      case 'witch-poison-start': this.setSelection({ type: 'witch-poison' }); break;
      default:
        // 处理其他较为简单的操作
        this.handleSimpleAction(action, btn);
    }
  },

  /**
   * 处理不那么复杂的点击操作，保持主switch-case清晰
   */
  handleSimpleAction(action, btn) {
    switch(action) {
        case 'join-as-creator':
            const gameId = btn.dataset.gameid;
            if (!gameId) { this.showNotification('未获取到游戏ID，请刷新后重试', 'error'); return; }
            history.pushState(null, '', `?game=${gameId}&player=1`);
            location.reload(); // Reload to re-initialize with new params
            return;
        
        case 'transfer-host-pregame':
            const newHostId = this.$('host-transfer-select').value;
            if (newHostId && btn.dataset.gameid) {
                db.ref(`games/${btn.dataset.gameid}/state/creatorId`).set(Number(newHostId)).then(() => {
                    this.showNotification(`房主已成功移交给 ${newHostId} 号玩家！`, 'success');
                });
            }
            return;

        case 'host-restart-game':
            if (confirm('确定要为所有玩家开启新的一局游戏吗？这会重置所有身份和状态。')) {
                btn.disabled = true;
                btn.innerHTML = '<span class="spinner"></span> 正在重置...';
                this.restartGame();
            }
            return;
        
        // 其他主持人强制操作
        case 'host-force-start': if (confirm('有玩家未准备，确定要强制开始游戏吗？')) { const up = {}; Object.values(this.allPlayers).forEach(p => { if (!p.isReady) up[`players/${p.id}/isReady`] = true }); db.ref(`games/${this.gameId}`).update(up).then(() => this.updatePhase('NIGHT', 1)); } return;
        case 'host-sheriff-cand-init': this.updatePhase('SHERIFF_CAND'); return;
        case 'host-sheriff-speech': this.updatePhase('SHERIFF_SPEECH'); return;
        case 'host-sheriff-vote': this.hostEnterSheriffVote(); return;
        case 'host-sheriff-elect-single': this.hostSheriffElectSingle(); return;
        case 'host-tally-sheriff': this.tallySheriffVotes(); return;
        case 'host-force-end-cand': this.updatePhase('SHERIFF_SPEECH'); return;
        case 'host-force-day': if (confirm('确定要强制进入白天吗？')) this.processNight(); return;
        case 'host-tally-day': this.tallyDayVotes(); return;
        case 'host-force-badge-destroy': if (confirm('确定要强制撕毁警徽吗？')) this.playerDestroyBadge(true); return;
        
        // 玩家个人操作
        case 'swap-identities': db.ref(`games/${this.gameId}/players/${this.playerId}/identities`).transaction(ids => ids ? [ids[1], ids[0]] : null); this.showNotification('身份已交换', 'success'); return;
        case 'confirm-identities': db.ref(`games/${this.gameId}/players/${this.playerId}/isReady`).set(true); this.showNotification('身份已确认，等待其他玩家...', 'success'); return;
        case 'sheriff-cand': const value = Number(btn.dataset.value); db.ref(`games/${this.gameId}/sheriff/candidates/${this.playerId}`).set(value); this.showNotification(value ? '你选择了上警' : '你选择了不上警', 'info'); return;
        case 'sheriff-drop': db.ref(`games/${this.gameId}/sheriff/drops/${this.playerId}`).set(true); this.showNotification('你已退水', 'info'); return;
        case 'wolf-send': this.sendWolfMessage(); return;
    }
  },

  /**
   * 复制链接到剪贴板
   * @param {HTMLElement} btn - 被点击的按钮
   */
  copyLink(btn) {
    const inputElement = this.$(btn.dataset.inputid);
    if (inputElement) {
      navigator.clipboard.writeText(inputElement.value).then(() => {
        this.showNotification('链接已复制到剪贴板', 'success');
        const btnSpan = btn.querySelector('span');
        if (btnSpan) {
          const originalText = btnSpan.textContent;
          btnSpan.textContent = '✓ 已复制';
          setTimeout(() => { if (btnSpan) btnSpan.textContent = originalText; }, 2000);
        }
      });
    }
  },

  // --- 模态框与监听器 ---

  /**
   * 打开模态框
   * @param {string} id - 模态框的ID
   */
  openModal(id) {
    const modal = this.$(id);
    if (!modal) return;
    modal.classList.add('open');
    const overlay = modal.querySelector('.modal-overlay');
    if (overlay) {
      overlay.addEventListener('click', () => this.closeModal(id), { once: true });
    }
  },

  /**
   * 关闭模态框
   * @param {string} id - 模态框的ID
   */
  closeModal(id) {
    const modal = this.$(id);
    if (modal) {
      modal.classList.remove('open');
    }
  },

  /**
   * 卸载所有Firebase监听器，防止内存泄漏
   */
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

  /**
   * 监听游戏日志变化并渲染
   */
  listenToLogs() {
    // 清理旧监听器
    if (this.logQueryRef && this.logListener) {
      this.logQueryRef.off('child_added', this.logListener);
    }
    this.seenLogKeys.clear();
    
    this.logQueryRef = db.ref(`games/${this.gameId}/logs`).limitToLast(200);
    this.logListener = this.logQueryRef.on('child_added', snap => {
      if (!snap.exists() || this.seenLogKeys.has(snap.key)) return;
      this.seenLogKeys.add(snap.key);
      
      const log = snap.val();
      // 玩家只应看到公开日志
      if (log && !log.isSecret) {
        const container = this.$('game-log-content');
        if (!container) return;
        const p = document.createElement('div');
        p.className = 'log-item fade-in';
        const prefix = log.round > 0 ? `<span class="log-round">[第${log.round}轮]</span> ` : '';
        p.innerHTML = prefix + this.escapeHTML(log.message);
        container.appendChild(p);
        container.scrollTop = container.scrollHeight;
      }
    });
  },

  /**
   * 监听整个游戏对象的变化
   * @param {Function} renderCallback - 数据变化后要执行的渲染函数
   */
  listenToGameChanges(renderCallback) {
    if (this.gameListener) db.ref(`games/${this.gameId}`).off('value', this.gameListener);
    
    this.gameListener = db.ref(`games/${this.gameId}`).on('value', snapshot => {
      if (!snapshot.exists()) {
        this.detachAllListeners();
        document.body.innerHTML = `<div class="error-container" style="text-align:center; margin-top: 100px;"><div style="font-size:48px;">🎮</div><h2>游戏已结束</h2><p>感谢参与本局游戏</p><button onclick="location.href='?'" class="btn-primary" style="margin-top:20px;">开始新游戏</button></div>`;
        return;
      }

      const gameData = snapshot.val();
      this.fullGameData = gameData;
      this.gameState = gameData.state;
      this.allPlayers = gameData.players;

      if (this.playerId !== '0') {
        // 如果是玩家，检查玩家数据是否存在
        if (!gameData.players || !gameData.players[this.playerId]) {
          this.detachAllListeners();
          document.body.innerHTML = `<div class="error-container" style="text-align:center; margin-top: 100px;"><div style="font-size:48px;">❌</div><h2>无法加入游戏</h2><p>你不是该游戏的玩家，请检查座位号是否正确。</p><button onclick="location.href='?'" class="btn-primary" style="margin-top:20px;">返回首页</button></div>`;
          return;
        }
        this.playerData = gameData.players[this.playerId];
        this.isHost = this.playerData.id == this.gameState.creatorId;
      }
      
      // 如果不是夜晚，停止狼人相关的监听器
      if (this.gameState.phase !== 'NIGHT') {
        this.stopWolfListeners();
      }
      
      // 执行传入的渲染回调
      renderCallback();
    });
  },
  
  /**
   * 监听当前玩家的选择状态变化 (用于持久化选择)
   */
  listenToPlayerSelection() {
      if (this.playerSelectionListener) {
        db.ref(`games/${this.gameId}/playerSelections/${this.playerId}`).off('value', this.playerSelectionListener);
      }
      
      this.playerSelectionListener = db.ref(`games/${this.gameId}/playerSelections/${this.playerId}`).on('value', snap => {
          this.selection = snap.val();
          // 只有在游戏视图激活时才重新渲染，避免不必要的操作
          if (!this.$('game-view').classList.contains('hidden')) {
              this.renderActionPanel();
              this.renderPlayerGrid();
          }
      });
  },

  // --- 游戏设置与创建 ---

  /**
   * 渲染身份配置界面
   */
  renderRoleSetup() {
    // [关键修复] 选择正确的容器，而不是覆盖整个 #role-setup section
    const container = this.$('role-grid');
    container.innerHTML = ''; // 清空旧内容

    Object.keys(DEFAULT_SETUP).forEach(name => {
      const role = ROLES[name];
      const defaultValue = DEFAULT_SETUP[name];
      const div = document.createElement('div');
      div.className = 'role-setup-item';
      div.innerHTML = `
        <span class="role-name">
          <span class="role-icon">${role.icon}</span>
          <span>${name}</span>
        </span>
        <div class="role-counter">
          <button class="counter-btn minus" data-role="${name}">−</button>
          <input type="number" id="role-${name}" min="0" value="${defaultValue}" readonly>
          <button class="counter-btn plus" data-role="${name}">+</button>
        </div>`;
      container.appendChild(div);
    });

    // 为加减按钮添加事件监听
    container.addEventListener('click', (e) => {
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

    // 初始化统计数据
    this.updateRoleStats();
  },
  
  /**
   * 更新设置界面中的总身份数和玩家数统计
   */
  updateRoleStats() {
    const roleInputs = this.$('role-grid').querySelectorAll('input');
    let totalRoles = 0;
    roleInputs.forEach(input => totalRoles += +input.value || 0);
    
    this.$('total-roles').textContent = totalRoles;
    
    const playerCount = totalRoles > 0 && totalRoles % 2 === 0 ? totalRoles / 2 : '?';
    this.$('player-cnt').textContent = playerCount;
    
    // 显示警告信息
    const warningEl = this.$('player-count-warning');
    if (totalRoles % 2 !== 0) {
      warningEl.textContent = '⚠️ 身份总数必须为偶数';
    } else if (typeof playerCount === 'number' && playerCount > 12) {
      warningEl.textContent = '⚠️ 建议玩家数不超过12人';
    } else {
      warningEl.textContent = '';
    }
  },

  /**
   * 创建游戏的核心逻辑
   */
  async createGame() {
    const btn = this.$('btn-create');
    btn.disabled = true;
    this.$('create-text').classList.add('hidden');
    this.$('create-spinner').classList.remove('hidden');
    const errorEl = this.$('setup-error');
    errorEl.classList.add('hidden');
    errorEl.textContent = '';

    // 1. 收集身份配置
    const roleSetup = {};
    this.$('role-grid').querySelectorAll('input').forEach(i => {
      const roleName = i.id.replace('role-', '');
      const count = +i.value;
      if (count > 0) roleSetup[roleName] = count;
    });

    // 2. 收集规则配置
    const rules = {
      witchSelfSaveRule: this.$('opt-witch-selfsave').value,
      seerMode: this.$('opt-seer-mode').value,
      wolfWin: this.$('opt-wolf-win').value
    };

    // 3. 验证配置
    const totalRoles = Object.values(roleSetup).reduce((sum, count) => sum + count, 0);
    if (totalRoles === 0 || totalRoles % 2 !== 0) {
      return this.setupFail('创建失败：身份总数必须为大于0的偶数。');
    }
    if (totalRoles / 2 > 12) {
      if (!confirm('玩家数量超过12人，可能影响游戏体验，确定要创建吗？')) {
        return this.setupFail('操作已取消。');
      }
    }

    // 4. 发牌并创建游戏数据
    const gameDataResult = await this._prepareGameData(roleSetup, rules);
    if (gameDataResult.error) {
      return this.setupFail(gameDataResult.error);
    }

    // 5. 将游戏数据写入数据库
    const newGameId = db.ref('games').push().key;
    await db.ref(`games/${newGameId}`).set(gameDataResult.data);
    
    // 6. 更新UI，显示成功信息和链接
    this.showNotification('游戏创建成功！', 'success');
    this.$('role-setup-section').classList.add('hidden');
    btn.classList.add('hidden');
    this.renderCreationSuccess(newGameId, gameDataResult.playerCount);
  },

  /**
   * 准备游戏数据，包括发牌
   * @param {object} roleSetup - 角色和数量的配置
   * @param {object} rules - 游戏规则配置
   * @returns {object} 包含游戏数据或错误信息的对象
   */
  async _prepareGameData(roleSetup, rules) {
    const rolePool = [];
    Object.entries(roleSetup).forEach(([role, count]) => {
      for (let i = 0; i < count; i++) rolePool.push(role);
    });

    const pairs = this.deal(rolePool);
    if (!pairs) {
      return { error: '无法生成符合规则的牌组，请尝试调整身份配置（例如，增加平民或狼人数量）。' };
    }

    const playerCount = rolePool.length / 2;
    const players = {};
    for (let i = 1; i <= playerCount; i++) {
      players[i] = { 
        id: i, 
        identities: pairs[i - 1], 
        originalIdentities: JSON.parse(JSON.stringify(pairs[i - 1])), 
        deaths: 0, 
        isAlive: true, 
        isReady: false, 
        isExposedIdiot: false, 
        skillStates: {}, 
        badge: 0 
      };
    }
    
    const gameData = {
      state: { 
        phase: 'SETUP', 
        round: 0, 
        peaceNightStreak: 0, 
        winner: null, 
        creatorId: 1, // 默认1号为房主
        nightStatus: {}, 
        hunterQueue: {}, 
        postDeathState: null, 
        dayVotingOpen: false 
      },
      players,
      config: { ...rules, playerCount },
      // 初始化游戏过程中的数据结构
      playerSelections: {}, 
      wolfChat: {}, 
      wolfVotes: {}, 
      nightActions: {}, 
      sheriff: {}, 
      dayVotes: {}, 
      logs: {}
    };

    return { data: gameData, playerCount };
  },

  /**
   * 创建失败时的UI处理
   * @param {string} msg - 显示的错误信息
   */
  setupFail(msg) {
    const errorEl = this.$('setup-error');
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
    
    // 重置创建按钮状态
    this.$('create-text').classList.remove('hidden');
    this.$('create-spinner').classList.add('hidden');
    this.$('btn-create').disabled = false;
  },

  /**
   * 游戏创建成功后，渲染分享链接和操作按钮
   * @param {string} gameId - 新创建的游戏ID
   * @param {number} playerCount - 玩家总数
   */
  renderCreationSuccess(gameId, playerCount) {
    const infoContainer = this.$('game-creation-info');
    infoContainer.classList.remove('hidden');
    const baseUrl = `${location.origin}${location.pathname}`;
    const urlTemplate = `${baseUrl}?game=${gameId}&player=PLAYER_ID`;
    
    let playerOptions = '';
    for (let i = 2; i <= playerCount; i++) {
        playerOptions += `<option value="${i}">${i}号玩家</option>`;
    }

    infoContainer.innerHTML = `
      <div class="success-message" style="text-align:center; margin-bottom:16px;">
        <div style="font-size:32px; margin-bottom:8px;">✅</div>
        <h3>游戏房间已创建</h3>
        <p style="color:var(--text-secondary); font-size:14px;">将链接分享给玩家，让他们替换末尾的 PLAYER_ID</p>
      </div>
      <div style="display:flex; gap:8px; margin-bottom: 16px;">
        <input id="player-link-template" class="fancy-input" value="${urlTemplate}" readonly style="text-align:left;">
        <button data-action="copy-link" data-inputid="player-link-template" class="control-btn" style="flex-shrink:0;"><span>复制</span></button>
      </div>
      <div style="border-top: 1px solid var(--border-primary); padding-top: 16px; margin-top: 16px;">
        <h4 style="text-align:center; font-weight:600; margin-bottom:8px;">房主操作</h4>
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:16px;">
          <select id="host-transfer-select" class="rule-select" style="flex-grow:1;">
            <option value="">将房主移交给...</option>
            ${playerOptions}
          </select>
          <button data-action="transfer-host-pregame" data-gameid="${gameId}" class="control-btn">确认移交</button>
        </div>
        <button data-action="join-as-creator" data-gameid="${gameId}" class="btn-primary btn-large"><span>以1号房主身份进入</span></button>
      </div>`;
  },
  
  /**
   * 发牌算法
   * @param {Array<string>} pool - 包含所有待分配身份的数组
   * @returns {Array|null} 成功则返回配对好的身份数组，失败则返回null
   */
  deal(pool) {
    // 尝试5000次以找到有效组合
    for (let t = 0; t < 5000; t++) {
      const shuffledPool = this._shuffle([...pool]);
      let isValid = true;
      const rawPairs = [];
      
      // 1. 创建原始身份对
      for (let i = 0; i < shuffledPool.length; i += 2) {
        rawPairs.push([shuffledPool[i], shuffledPool[i + 1]].sort());
      }
      
      // 2. 检查是否有被禁止的组合
      for (const pair of rawPairs) {
        if (FORBIDDEN_RAW.some(([a, b]) => (a === pair[0] && b === pair[1]) || (a === pair[1] && b === pair[0]))) {
          isValid = false;
          break;
        }
      }
      if (!isValid) continue;

      // 3. 格式化身份对 (处理盗贼逻辑)
      const finalPairs = [];
      const roleCounts = {};
      for (const pair of rawPairs) {
        let id1, id2;
        if (pair[0] === '盗贼') {
          // 如果有盗贼，两个身份都变成被盗身份的复制品
          id1 = { role: pair[1], isThiefCopy: true };
          id2 = { role: pair[1], isThiefCopy: true };
        } else {
          id1 = { role: pair[0], isThiefCopy: false };
          id2 = { role: pair[1], isThiefCopy: false };
        }
        finalPairs.push([id1, id2]);
        // 统计最终身份数量
        roleCounts[id1.role] = (roleCounts[id1.role] || 0) + 1;
        roleCounts[id2.role] = (roleCounts[id2.role] || 0) + 1;
      }

      // 4. 附加规则检查 (例如，金水数量、阵营平衡等)
      const goldenPairs = finalPairs.filter(p => p[0].role === '平民' && p[1].role === '平民').length;
      if (goldenPairs < 1 || goldenPairs > 2) continue; // 限制金水数量
      
      const wolfCount = (roleCounts['狼人'] || 0) + (roleCounts['隐狼'] || 0);
      if (wolfCount === 0) continue; // 必须有狼人
      
      const godCount = Object.keys(roleCounts).reduce((sum, role) => sum + (ROLES[role].isGod ? roleCounts[role] : 0), 0);
      if (godCount === 0) continue; // 必须有神职
      
      // 如果所有检查都通过，返回最终的身份对
      return finalPairs;
    }
    
    // 如果尝试多次后仍然失败，返回null
    return null;
  },

  // --- 游戏界面渲染 ---

  /**
   * 渲染所有游戏界面组件的总入口
   */
  renderAll() {
    this.$('host-badge').classList.toggle('hidden', !this.isHost);
    this.$('sheriff-badge-top').classList.toggle('hidden', !this.playerData?.badge);
    
    this.renderStatus();
    this.renderIdentityCard();
    this.renderPersistentInfo();
    this.renderActionPanel();
    this.renderPlayerGrid();
    
    if (this.isHost) {
      this.renderHostControls();
    } else {
      this.$('host-controls').classList.add('hidden');
    }
  },

  /**
   * 渲染顶部状态栏
   */
  renderStatus() {
    const phaseMap = {
      SETUP: '⏳ 等待所有玩家准备',
      NIGHT: `🌙 第 ${this.gameState.round} 夜`,
      SHERIFF_CAND: '👑 上警意向征集',
      SHERIFF_SPEECH: '👑 上警发言/退水',
      SHERIFF_VOTE: '👑 警长投票',
      DAY: `☀️ 第 ${this.gameState.round} 天`,
      GAME_OVER: `🏆 ${this.gameState.winner}`,
      HUNTER_ACTION: '🔫 猎人正在开枪...',
      SHERIFF_TRANSFER: '💔 警长阵亡，等待移交警徽'
    };
    const statusText = phaseMap[this.gameState.phase] || '游戏进行中';
    this.$('status-bar').innerHTML = `<span class="status-text">${statusText}</span>`;
  },

  /**
   * 渲染玩家的身份卡片
   */
  renderIdentityCard() {
    const pd = this.playerData;
    if (!pd) return;

    const identities = pd.identities;
    const originalIdentities = pd.originalIdentities;
    const deaths = pd.deaths;
    
    // 格式化单个身份的显示
    const formatIdentity = (identity, originalIdentity) => {
      // 如果原始身份是盗贼，则显示为盗贼复制的身份，但样式特殊
      if (originalIdentity.role === '盗贼') {
        return `<span class="identity-item">
                  <span class="identity-icon thief-icon">🎭</span>
                  <span class="identity-name thief-copy-text">${identity.role}</span>
                </span>`;
      }
      // 正常显示身份
      const roleInfo = ROLES[identity.role];
      return `<span class="identity-item">
                <span class="identity-icon">${roleInfo.icon}</span>
                <span class="identity-name">${identity.role}</span>
              </span>`;
    };
    
    // 组合身份卡片内容
    let cardContent = `<div class="identity-header">你的身份</div>
                       <div class="identity-display">
                         <span class="${deaths >= 1 ? 'dead-identity' : ''}">${formatIdentity(identities[0], originalIdentities[0])}</span>
                         <span class="identity-separator">+</span>
                         <span class="${deaths >= 2 ? 'dead-identity' : ''}">${formatIdentity(identities[1], originalIdentities[1])}</span>
                       </div>`;
    
    // 如果在设置阶段且玩家未准备好，显示操作按钮
    if (this.gameState.phase === 'SETUP' && !pd.isReady) {
      cardContent += `
        <div class="identity-actions">
          <button class="control-btn" data-action="swap-identities"><span>🔄 交换身份</span></button>
          <button class="confirm-btn" data-action="confirm-identities"><span>✓ 确认身份</span></button>
        </div>`;
    }
    this.$('identity-card').innerHTML = cardContent;
  },

  /**
   * 渲染持久化信息（如预言家查验记录）
   */
  renderPersistentInfo() {
    let html = '';
    // 预言家查验记录
    if (this.getActiveRole(this.playerData) === '预言家') {
      const seerMode = this.fullGameData.config?.seerMode || 'faction';
      const results = this.getGlobalSkillState('seerResults') || {};
      const entries = Object.entries(results);
      if (entries.length > 0) {
        html += `<div class="seer-results">
                   <div class="seer-title">🔮 查验记录 (${seerMode === 'faction' ? '阵营' : '身份'})</div>
                   <div class="seer-list">
                     ${entries.map(([id, res]) => `<span class="seer-item">${id}号: <strong>${this.escapeHTML(res)}</strong></span>`).join('')}
                   </div>
                 </div>`;
      }
    }
    
    const persistEl = this.$('persist');
    persistEl.innerHTML = html;
    persistEl.classList.toggle('hidden', !html);
  },

  /**
   * 渲染左右两侧的玩家网格
   */
  renderPlayerGrid() {
    const leftGrid = this.$('player-grid-left');
    const rightGrid = this.$('player-grid-right');
    leftGrid.innerHTML = '';
    rightGrid.innerHTML = '';

    const sortedPlayers = Object.values(this.allPlayers).sort((a, b) => a.id - b.id);
    const half = Math.ceil(sortedPlayers.length / 2);

    const viewerWolfType = this.getViewerWolfType();
    const isNight = this.gameState.phase === 'NIGHT';
    const wolfVotes = this.fullGameData?.wolfVotes || {};
    const wolfFinalTarget = this.fullGameData?.nightActions?.[this.gameState.round]?.wolf?.target || null;

    // 判断一个玩家卡片是否可选
    const isSelectable = (p) => {
      if (!this.selection) return false;
      const me = this.playerData;
      if (!p.isAlive || p.id == me.id) {
          // 守卫和女巫可以对自己操作（在特定规则下）
          if (this.selection.type !== 'guard' && this.selection.type !== 'witch-poison') return false;
      }

      switch (this.selection.type) {
        case 'seer': return p.id != me.id;
        case 'guard': return this.getSkillState('lastGuardTarget') != p.id;
        case 'witch-poison': return !p.isExposedIdiot;
        case 'wolf-vote': return this.canWolfAct(me);
        case 'day-vote': return !p.isExposedIdiot;
        case 'knight': return p.id != me.id && !p.isExposedIdiot;
        case 'hunter': return true;
        case 'sheriff-vote': 
          const c = this.fullGameData.sheriff?.candidates || {};
          const d = this.fullGameData.sheriff?.drops || {};
          return c[p.id] && !d[p.id];
        case 'sheriff-pass': return p.id != me.id;
        default: return false;
      }
    };

    // 创建单个玩家卡片的HTML
    const createPlayerCard = (p) => {
      const card = document.createElement('div');
      card.className = 'player-card';
      
      // 添加各种状态类
      if (+this.playerId === +p.id) card.classList.add('me');
      if (!p.isAlive) card.classList.add('disabled');
      if (this.selection && !isSelectable(p)) card.classList.add('disabled');
      if (this.selection?.targetId && +this.selection.targetId === +p.id) card.classList.add('selected');
      if (wolfFinalTarget && +wolfFinalTarget === +p.id) card.classList.add('wolf-final-target');

      // 狼人投票角标
      let wolfVoteBadges = '';
      if (viewerWolfType && isNight) {
          const voterIds = Object.keys(wolfVotes).filter(voterId => +wolfVotes[voterId] === +p.id).sort((a,b) => a-b);
          wolfVoteBadges = voterIds.map((voterId, index) => `<span class="wolf-corner" style="top:${index * 16 + 4}px">${voterId}</span>`).join('');
      }

      // 身份标签 (狼队友, 白痴等)
      const tags = [];
      if (viewerWolfType === 'regular' && (p.originalIdentities || p.identities).some(id => id.role === '狼人')) {
        tags.push('<span class="tag tag-team">队友</span>');
      }
      if (p.isExposedIdiot) tags.push('<span class="tag tag-idiot">白痴</span>');

      // 组合HTML
      const lives = 2 - p.deaths;
      card.innerHTML = `
        <div class="player-number">${p.id}${p.badge ? '<span class="sheriff-icon">👑</span>' : ''}</div>
        <div class="tagline">${tags.join('')}</div>
        <div class="hearts">
          <span class="heart ${lives < 1 ? 'off' : ''}">❤</span>
          <span class="heart ${lives < 2 ? 'off' : ''}">❤</span>
        </div>
        ${wolfVoteBadges}`;

      // 添加点击事件
      if (this.selection && isSelectable(p)) {
        card.addEventListener('click', () => {
          const targetId = p.id.toString();
          if (this.selection.type === 'wolf-vote') {
            // 狼人投票是特殊处理，直接写入数据库
            if (!this.canWolfAct(this.playerData) || this.gameState?.nightStatus?.wolf !== 'pending') {
              this.showNotification('当前不可投票', 'error');
              return;
            }
            db.ref(`games/${this.gameId}/wolfVotes/${this.playerId}`).set(targetId);
            this.setSelection({ ...this.selection, targetId }); // 同时更新本地状态以获得即时反馈
            this.showNotification(`已投票给 ${targetId}号`, 'info');
          } else {
            // 其他技能只更新本地选择状态，等待确认
            this.setSelection({ ...this.selection, targetId });
          }
        });
      }
      return card;
    };

    // 分配玩家到左右两列
    sortedPlayers.slice(0, half).forEach(p => leftGrid.appendChild(createPlayerCard(p)));
    sortedPlayers.slice(half).forEach(p => rightGrid.appendChild(createPlayerCard(p)));
  },

  /**
   * 渲染中央操作面板
   */
  renderActionPanel() {
    const panel = this.$('action-panel');
    panel.innerHTML = '';

    // 游戏结束
    if (this.gameState.phase === 'GAME_OVER') {
        panel.innerHTML = `<div class="action-feedback">🏆 游戏结束 - ${this.gameState.winner}</div>`;
        return;
    }

    const me = this.playerData;
    const role = this.getActiveRole(me);
    const nightStatus = this.gameState.nightStatus || {};
    const actionTaken = this.fullGameData.nightActions?.[this.gameState.round]?.[this.playerId]?.inProgress;

    // 通用UI组件
    const info = (msg) => `<div class="action-feedback">${this.escapeHTML(msg)}</div>`;
    const actionBar = (title, opts = {}) => {
        const { confirmText = '确认', skipText = '跳过', allowSkip = true, allowCancel = true } = opts;
        const targetText = this.selection?.targetId ? `${this.selection.targetId}号` : '未选择';
        return `<div class="action-bar">
                    <div class="action-title">${this.escapeHTML(title)}</div>
                    <div class="action-target">当前目标：<strong>${targetText}</strong></div>
                    <div class="action-buttons">
                        <button class="confirm-btn" data-action="confirm-selection" ${!this.selection?.targetId ? 'disabled' : ''}>${confirmText}</button>
                        ${allowSkip ? `<button class="control-btn" data-action="skip-selection">${skipText}</button>` : ''}
                        ${allowCancel ? `<button class="action-btn" data-action="cancel-selection">取消</button>` : ''}
                    </div>
                </div>`;
    };

    // --- 分阶段渲染 ---

    // 死亡状态
    if (!me.isAlive) {
        if (this.gameState.phase === 'HUNTER_ACTION' && this.gameState.hunterQueue?.[this.playerId]) {
            if (!this.selection || this.selection.type !== 'hunter') this.setSelection({type: 'hunter'});
            panel.innerHTML = actionBar('你是猎人，请选择带走一名玩家', { allowSkip: false, allowCancel: false });
        } else {
            panel.innerHTML = info('💀 你已出局，请安静观战');
        }
        return;
    }

    // 警长移交
    if (this.gameState.phase === 'SHERIFF_TRANSFER') {
        const postDeathState = this.gameState.postDeathState;
        if (postDeathState && this.playerId == postDeathState.deadSheriffId) {
            if (!this.selection || this.selection.type !== 'sheriff-pass') this.setSelection({type: 'sheriff-pass'});
            panel.innerHTML = actionBar('你已阵亡，请选择移交警徽的对象', { skipText: '撕毁警徽' });
        } else {
            panel.innerHTML = info('等待警长移交警徽...');
        }
        return;
    }

    // 上警阶段
    if (this.gameState.phase === 'SHERIFF_CAND') {
        const myDecision = this.fullGameData.sheriff?.candidates?.[this.playerId];
        if (myDecision !== undefined) {
            panel.innerHTML = info(`你已选择 ${myDecision ? '上警' : '不上警'}`);
        } else {
            panel.innerHTML = `<div class="sheriff-choice">
                                 <div class="choice-title">是否参与警长竞选？</div>
                                 <div class="choice-buttons">
                                   <button class="confirm-btn" data-action="sheriff-cand" data-value="1">我要上警</button>
                                   <button class="control-btn" data-action="sheriff-cand" data-value="0">不上警</button>
                                 </div>
                               </div>`;
        }
        return;
    }
    
    // 警长发言/退水阶段
    if (this.gameState.phase === 'SHERIFF_SPEECH') {
        const candidates = this.fullGameData.sheriff?.candidates || {};
        const drops = this.fullGameData.sheriff?.drops || {};
        const runningCandidates = Object.keys(candidates).filter(id => candidates[id] && !drops[id]);

        let html = `<div class="candidate-info-box">
                      <div class="candidate-info-title">👑 竞选玩家</div>
                      <div class="candidate-list">${runningCandidates.length > 0 ? runningCandidates.map(id => `<span class="player-tag">${id}号</span>`).join('') : info('无')}</div>
                    </div>`;
        
        if (candidates[this.playerId] && !drops[this.playerId]) {
            html += `<div style="margin-top:16px;"><button class="action-btn" data-action="sheriff-drop" style="width:100%;">💧 我要退水</button></div>`;
        } else if (drops[this.playerId]) {
            html = info('你已退水');
        } else {
            html += info('等待主持人推进流程...');
        }
        panel.innerHTML = html;
        return;
    }

    // 警长投票
    if (this.gameState.phase === 'SHERIFF_VOTE') {
        if (me.isExposedIdiot) { panel.innerHTML = info('白痴已翻牌，无法投票'); return; }
        const myVote = this.fullGameData.sheriff?.votes?.[this.playerId];
        if (myVote != null) {
            panel.innerHTML = info(`你已投票给 ${myVote === '0' ? '弃票' : myVote + '号'}`);
        } else {
            if (!this.selection || this.selection.type !== 'sheriff-vote') this.setSelection({type: 'sheriff-vote'});
            panel.innerHTML = actionBar('为警长投票', { skipText: '弃票' });
        }
        return;
    }

    // 白天阶段
    if (this.gameState.phase === 'DAY') {
        if (!this.gameState.dayVotingOpen) {
            // 投票前：骑士可发动技能
            if (role === '骑士' && !this.getSkillState('hasUsedDuel')) {
                if (!this.selection || this.selection.type !== 'knight') this.setSelection({type: 'knight'});
                panel.innerHTML = actionBar('你是骑士，可在投票前发动决斗', { confirmText: '决斗', allowSkip: false });
            } else {
                panel.innerHTML = info('发言阶段，等待主持人开启投票...');
            }
        } else {
            // 投票中
            if (me.isExposedIdiot) { panel.innerHTML = info('白痴已翻牌，无法投票'); return; }
            const myVote = this.fullGameData.dayVotes?.[this.gameState.round]?.[this.playerId];
            if (myVote != null) {
                panel.innerHTML = info(`你已投票给 ${myVote === '0' ? '弃票' : myVote + '号'}`);
            } else {
                if (!this.selection || this.selection.type !== 'day-vote') this.setSelection({type: 'day-vote'});
                panel.innerHTML = actionBar('放逐投票', { skipText: '弃票' });
            }
        }
        return;
    }

    // 夜晚阶段
    if (this.gameState.phase === 'NIGHT') {
        if (actionTaken) { panel.innerHTML = info('操作已确认，等待天亮...'); return; }

        switch(role) {
            case '女巫':
                if (nightStatus.witch === 'pending') {
                    const lifeIndex = me.deaths;
                    const hasCure = !this.getSkillState('hasUsedCure', me, lifeIndex);
                    const hasPoison = !this.getSkillState('hasUsedPoison', me, lifeIndex);
                    const wolfTarget = this.fullGameData.nightActions?.[this.gameState.round]?.wolf?.target;

                    let html = `<div class="witch-panel">
                                  <div class="witch-status">
                                    <div class="potion-status">
                                      <span class="potion ${hasCure ? 'available' : ''}">💊 解药</span>
                                      <span class="potion ${hasPoison ? 'available' : ''}">☠️ 毒药</span>
                                    </div>
                                  </div>
                                  <div class="witch-actions-container">`;
                    
                    if (hasCure && wolfTarget && wolfTarget !== '0') {
                        const rule = this.fullGameData.config?.witchSelfSaveRule;
                        const isSelf = +wolfTarget === +this.playerId;
                        const isFirstNight = this.gameState.round === 1;
                        let canSave = !isSelf || (rule === 'onlyFirstNightSelfSave' && isFirstNight) || (rule !== 'noFirstNightSelfSave' && rule !== 'onlyFirstNightSelfSave');
                        html += `<button class="confirm-btn" data-action="witch-cure" data-target="${wolfTarget}" ${!canSave ? 'disabled' : ''}>救 ${wolfTarget}号</button>`;
                    }
                    if (hasPoison) {
                        if (!this.selection || this.selection.type !== 'witch-poison') this.setSelection({type: 'witch-poison'});
                        html += `<button class="action-btn" data-action="confirm-selection" ${!this.selection?.targetId ? 'disabled' : ''}>毒杀 ${this.selection?.targetId || ''}号</button>`;
                    }
                    html += `</div>`;
                    if (!hasCure && !hasPoison) { html += info('本条命药水已用尽'); }
                    html += `<button class="control-btn" data-action="skip-selection" style="margin-top:8px;">跳过</button></div>`;
                    panel.innerHTML = html;
                } else {
                    panel.innerHTML = info('等待狼人行动...');
                }
                break;
            
            case '狼人':
            case '隐狼':
                if (nightStatus.wolf === 'pending') {
                    if (!this.selection || this.selection.type !== 'wolf-vote') this.setSelection({type: 'wolf-vote'});
                    let wolfPanelHtml = `<div class="wolf-inline-panel">
                                           <div class="wolf-hint">${this.canWolfAct(me) ? '🎯 点击上方玩家卡片投票，或选择空刀' : '⏳ 等待同伴行动'}</div>
                                           <div id="wolf-votes-display" class="wolf-votes-section"></div>`;
                    if(this.canWolfAct(me)){
                        wolfPanelHtml += `<div class="wolf-actions" style="margin-top:8px;"><button class="control-btn" data-action="skip-selection">🔪 空刀</button></div>`;
                    }
                    if (role === '狼人') {
                        wolfPanelHtml += `<div id="wolf-chat-area" class="wolf-chat-section">
                                            <div id="wolf-chat-messages" class="chat-messages"></div>
                                            <div class="chat-input-wrapper">
                                              <input id="wolf-chat-input" class="chat-input" placeholder="输入消息..." maxlength="120" />
                                              <button data-action="wolf-send" class="btn-send"><span>发送</span></button>
                                            </div>
                                          </div>`;
                    }
                    panel.innerHTML = wolfPanelHtml + `</div>`;
                    this.initWolfListeners();
                } else {
                    panel.innerHTML = info('狼队已确定目标，等待其他角色行动...');
                }
                break;
            
            case '守卫':
                if (nightStatus.guard === 'pending') {
                    if (!this.selection || this.selection.type !== 'guard') this.setSelection({ type: 'guard' });
                    panel.innerHTML = actionBar('守卫：请选择守护对象', { skipText: '空守' });
                } else {
                    panel.innerHTML = info('等待其他角色行动...');
                }
                break;
            
            case '预言家':
                if (nightStatus.seer === 'pending') {
                    if (!this.selection || this.selection.type !== 'seer') this.setSelection({ type: 'seer' });
                    panel.innerHTML = actionBar('预言家：请选择查验目标');
                } else {
                    panel.innerHTML = info('等待其他角色行动...');
                }
                break;

            default:
                panel.innerHTML = info('夜晚行动中，请耐心等待...');
                break;
        }
        return;
    }

    // 默认状态
    panel.innerHTML = info('等待游戏进入下一阶段...');
  },

  /**
   * 渲染主持人控制面板
   */
  renderHostControls() {
    const el = this.$('host-controls');
    el.classList.remove('hidden');
    const phase = this.gameState.phase;
    let html = `<div class="host-panel">`;

    const generatePlayerTags = (playerList, className = '') => {
        if (!playerList || playerList.length === 0) return '<span style="color:var(--text-tertiary);">无</span>';
        return playerList.map(p => `<span class="player-tag ${className}">${p.id}号</span>`).join('');
    };

    switch (phase) {
        case 'SETUP':
            const all = Object.values(this.allPlayers);
            const ready = all.filter(p => p.isReady);
            const pending = all.filter(p => !p.isReady);
            html += `<div class="host-status">
                       <div class="host-status-title">玩家准备 (${ready.length}/${all.length})</div>
                       <div class="status-category"><div class="category-title">已准备:</div><div class="player-tags">${generatePlayerTags(ready, 'done')}</div></div>
                       <div class="status-category"><div class="category-title">未准备:</div><div class="player-tags">${generatePlayerTags(pending, 'pending')}</div></div>
                     </div>
                     <div class="host-actions" style="display:flex; gap:8px;">
                       ${pending.length > 0 ? `<button class="action-btn" data-action="host-force-start" style="flex:1;">强制开始</button>` : ''}
                       <button class="confirm-btn" data-action="host-start" ${pending.length > 0 ? 'disabled' : ''} style="flex:1;">🚀 开始游戏</button>
                     </div>`;
            break;
        
        case 'NIGHT':
            const allDone = Object.values(this.gameState.nightStatus || {}).every(s => s === 'complete');
            const hasSheriff = Object.values(this.allPlayers).some(p => p.badge);
            const isFirstNight = this.gameState.round === 1;
            html += `<div class="host-status"><div class="host-status-title">夜晚行动中...</div></div>
                     <div class="host-actions" style="display:flex; gap:8px;">`;
            if (isFirstNight && !hasSheriff) {
                html += `${!allDone ? `<button class="action-btn" data-action="host-force-day" style="flex:1;">强制上警</button>` : ''}
                         <button class="confirm-btn" data-action="host-sheriff-cand-init" ${!allDone ? 'disabled' : ''} style="flex:1;">👑 开始上警</button>`;
            } else {
                html += `${!allDone ? `<button class="action-btn" data-action="host-force-day" style="flex:1;">强制天亮</button>` : ''}
                         <button class="confirm-btn" data-action="host-day" ${!allDone ? 'disabled' : ''} style="flex:1;">☀️ 天亮了</button>`;
            }
            html += `</div>`;
            break;

        case 'SHERIFF_VOTE':
        case 'DAY':
            const isDayVote = phase === 'DAY';
            const votingOpen = isDayVote ? this.gameState.dayVotingOpen : true;
            if (votingOpen) {
                const voters = Object.values(this.allPlayers).filter(p => p.isAlive && !p.isExposedIdiot);
                const votes = isDayVote ? (this.fullGameData.dayVotes?.[this.gameState.round] || {}) : (this.fullGameData.sheriff?.votes || {});
                const voted = voters.filter(p => Object.keys(votes).includes(p.id.toString()));
                const notVoted = voters.filter(p => !Object.keys(votes).includes(p.id.toString()));
                html += `<div class="host-status">
                           <div class="host-status-title">${isDayVote ? '放逐投票' : '警长投票'} (${voted.length}/${voters.length})</div>
                           <div class="status-category"><div class="category-title">已投票:</div><div class="player-tags">${generatePlayerTags(voted, 'done')}</div></div>
                           <div class="status-category"><div class="category-title">未投票:</div><div class="player-tags">${generatePlayerTags(notVoted, 'pending')}</div></div>
                         </div>
                         <div class="host-actions" style="display:flex; gap:8px;">
                           <button class="confirm-btn" data-action="${isDayVote ? 'host-tally-day' : 'host-tally-sheriff'}" ${notVoted.length > 0 ? 'disabled' : ''} style="flex:1;">📊 统计</button>
                         </div>`;
            } else {
                html += `<div class="host-actions"><button class="confirm-btn" data-action="host-open-day-vote" style="width:100%;">开启投票</button></div>`;
            }
            break;

        case 'GAME_OVER':
            html += `<div style="text-align:center; margin-bottom: 16px;">🎮 游戏已结束</div>
                     <button class="btn-primary btn-large" data-action="host-restart-game"><span>🔁 重新开始一局</span></button>`;
            break;
        
        default:
            html += `<div class="host-status"><div class="host-status-title">流程进行中...</div></div>`;
            break;
    }
    html += `</div>`;
    el.innerHTML = html;
  },
  
  /**
   * 渲染上帝（后台）视角界面
   */
  renderGodView() {
    const playerList = this.$('god-player-list');
    playerList.innerHTML = '';
    const formatIdentity = (id) => `<span class="${id.isThiefCopy ? 'thief-copy' : ''}">${ROLES[id.role].icon} ${id.role}</span>`;

    Object.values(this.fullGameData.players || {}).sort((a, b) => a.id - b.id).forEach(p => {
      const lives = 2 - p.deaths;
      const row = document.createElement('div');
      row.className = `god-row ${!p.isAlive ? 'dead-all' : ''}`;
      row.innerHTML = `<div class="god-player-number"><span class="player-id">${p.id}号</span>${p.badge ? '<span class="sheriff-icon">👑</span>' : ''}</div>
                       <div class="god-identities">
                         <span class="${p.deaths >= 1 ? 'dead-identity' : ''}">${formatIdentity(p.identities[0])}</span>
                         <span class="identity-plus">+</span>
                         <span class="${p.deaths >= 2 ? 'dead-identity' : ''}">${formatIdentity(p.identities[1])}</span>
                       </div>
                       <div class="god-hearts">
                         <span class="life-heart ${lives < 1 ? 'lost' : ''}">❤</span>
                         <span class="life-heart ${lives < 2 ? 'lost' : ''}">❤</span>
                       </div>`;
      playerList.appendChild(row);
    });

    const logContainer = this.$('god-log-content');
    logContainer.innerHTML = '';
    const logs = Object.values(this.fullGameData.logs || {}).sort((a, b) => a.timestamp - b.timestamp);
    if (logs.length === 0) {
      logContainer.innerHTML = '<div class="log-item">暂无日志</div>';
    } else {
        logs.forEach(log => {
          const div = document.createElement('div');
          div.className = 'log-item';
          if (log.isSecret) div.classList.add('log-secret');
          const prefix = log.round > 0 ? `<span class="log-round">[第${log.round}轮]</span> ` : '';
          div.innerHTML = prefix + this.escapeHTML(log.message);
          logContainer.appendChild(div);
        });
    }
    logContainer.scrollTop = logContainer.scrollHeight;
  },

  // --- 核心游戏逻辑 ---

  /**
   * 确认玩家的选择 (核心行动函数)
   */
  async confirmSelection() {
    if (!this.selection || !this.selection.targetId) return;
    const targetId = this.selection.targetId;
    
    // 根据选择类型执行不同技能
    switch (this.selection.type) {
      case 'seer': await this.seerCheck(targetId); break;
      case 'guard': await this.guardProtect(targetId); break;
      case 'witch-poison': await this.witchUsePoison(targetId); break;
      case 'knight': await this.knightDuel(targetId); break;
      case 'hunter': await this.hunterShoot(targetId); break;
      case 'day-vote': 
        await db.ref(`games/${this.gameId}/dayVotes/${this.gameState.round}/${this.playerId}`).set(targetId);
        this.showNotification(`已投票给 ${targetId}号`, 'success');
        break;
      case 'sheriff-vote': 
        await db.ref(`games/${this.gameId}/sheriff/votes/${this.playerId}`).set(targetId);
        this.showNotification(`已为警长投票给 ${targetId}号`, 'success');
        break;
      case 'sheriff-pass': await this.playerPassBadge(targetId); break;
    }
    // 行动后清除选择状态
    await this.clearSelection();
  },

  /**
   * 玩家选择跳过/弃票
   */
  async skipSelection() {
    if (!this.selection) return;
    switch (this.selection.type) {
        case 'seer': await this.seerSkip(); break;
        case 'guard': await this.guardSkip(); break;
        case 'witch-poison': await this.witchSkip(); break;
        case 'wolf-vote':
            if (!this.canWolfAct(this.playerData) || this.gameState?.nightStatus?.wolf !== 'pending') {
              this.showNotification('当前不可投票', 'error');
              break;
            }
            await db.ref(`games/${this.gameId}/wolfVotes/${this.playerId}`).set('0');
            this.showNotification('已选择空刀', 'success');
            break;
        case 'day-vote': 
            await db.ref(`games/${this.gameId}/dayVotes/${this.gameState.round}/${this.playerId}`).set('0');
            this.showNotification('已投弃票', 'info');
            break;
        case 'sheriff-vote': 
            await db.ref(`games/${this.gameId}/sheriff/votes/${this.playerId}`).set('0');
            this.showNotification('已为警长投弃票', 'info');
            break;
        case 'sheriff-pass': await this.playerDestroyBadge(); break;
    }
    await this.clearSelection();
  },

  /**
   * 清除玩家的选择状态 (从数据库中移除)
   */
  async clearSelection() {
    await db.ref(`games/${this.gameId}/playerSelections/${this.playerId}`).remove();
  },
  
  /**
   * 更新游戏阶段
   * @param {string} phase - 新的游戏阶段
   * @param {number|null} round - (可选) 新的回合数
   */
  async updatePhase(phase, round = null) {
      const updates = { 'state/phase': phase };
      if (round !== null) {
          updates['state/round'] = round;
      } else if (phase === 'NIGHT') {
          updates['state/round'] = this.gameState.round + 1;
      }

      // 进入夜晚时的重置操作
      if (phase === 'NIGHT') {
          updates['nightActions'] = {};
          updates['wolfVotes'] = {};
          updates['playerSelections'] = {};
          
          const alivePlayers = Object.values(this.allPlayers).filter(p => p.isAlive);
          const roleExists = (role) => alivePlayers.some(p => this.getActiveRole(p) === role);
          const witch = alivePlayers.find(p => this.getActiveRole(p) === '女巫');
          const witchLifeIndex = witch ? witch.deaths : -1;
          const canWitchAct = witch && (!this.getSkillState('hasUsedCure', witch, witchLifeIndex) || !this.getSkillState('hasUsedPoison', witch, witchLifeIndex));
          
          const nightStatus = {
              guard: roleExists('守卫') ? 'pending' : 'complete',
              seer: roleExists('预言家') ? 'pending' : 'complete',
              wolf: this.isAnyWolfInGame() ? 'pending' : 'complete',
              witch: canWitchAct ? 'locked' : 'complete' // 女巫默认锁定，等狼人行动后解锁
          };
          // 如果没狼人，女巫直接解锁
          if (nightStatus.wolf === 'complete' && nightStatus.witch === 'locked') {
              nightStatus.witch = 'pending';
          }
          updates['state/nightStatus'] = nightStatus;
      }
      
      // 进入白天或警长竞选时的重置
      if (phase === 'DAY') {
          updates['state/dayVotingOpen'] = false;
          updates['playerSelections'] = {};
      }
      if (phase === 'SHERIFF_CAND') {
          updates['sheriff'] = { candidates: {}, drops: {}, votes: {} };
      }

      await db.ref(`games/${this.gameId}`).update(updates);
  },

  /**
   * 夜晚结算
   */
  async processNight() {
    await this.addGameLog('🌙 天亮了。', false);
    const nightActions = this.fullGameData.nightActions?.[this.gameState.round] || {};
    const deaths = [];

    const wolfAction = nightActions.wolf;
    const guardAction = Object.values(nightActions).find(a => a.actorId && this.getActiveRole(this.allPlayers[a.actorId]) === '守卫');
    const witchAction = Object.values(nightActions).find(a => a.actorId && this.getActiveRole(this.allPlayers[a.actorId]) === '女巫');
    
    const wolfTarget = wolfAction?.target;
    const guardTarget = guardAction?.target;
    const cureTarget = witchAction?.cure;
    const poisonTarget = witchAction?.poison;

    // 1. 处理狼人击杀
    if (wolfTarget && wolfTarget !== '0') {
      const isGuarded = guardTarget === wolfTarget;
      const isCured = cureTarget === wolfTarget;
      if (isGuarded) await this.addGameLog(`🛡️ 守卫成功守护了 ${wolfTarget}号`, true);
      if (isCured) await this.addGameLog(`🧪 女巫使用解药救活了 ${wolfTarget}号`, true);
      if (!isGuarded && !isCured) {
        deaths.push({ id: wolfTarget, cause: 'NIGHT' });
      }
    }
    
    // 2. 处理女巫毒杀
    if (poisonTarget && !deaths.some(d => d.id === poisonTarget)) {
      deaths.push({ id: poisonTarget, cause: 'POISON' });
      await this.addGameLog(`🧪 女巫使用毒药杀害了 ${poisonTarget}号`, true);
    }

    // 3. 执行死亡结算
    let anyHunterTriggered = false, anySheriffDied = false;
    if (deaths.length > 0) {
      const deadPlayerIds = [...new Set(deaths.map(d => d.id))].sort((a, b) => a - b).join('号、');
      await this.addGameLog(`昨夜死亡的玩家是：${deadPlayerIds}号`, false);
      await db.ref(`games/${this.gameId}/state/peaceNightStreak`).set(0);
      
      for (const death of deaths) {
        const killResult = await this.kill(death.id, death.cause);
        if (killResult.hunterTriggered) anyHunterTriggered = true;
        if (killResult.sheriffDied) {
          anySheriffDied = true;
          break; // 警长死亡会暂停后续流程
        }
      }
    } else {
      await this.addGameLog('昨夜是平安夜。', false);
      const newStreak = (this.gameState.peaceNightStreak || 0) + 1;
      await db.ref(`games/${this.gameId}/state/peaceNightStreak`).set(newStreak);
    }
    
    // 4. 处理死亡后遗留事件
    await this.handlePostDeath({ 
      hunterTriggered: anyHunterTriggered, 
      sheriffDied: anySheriffDied, 
      nextPhaseIfNoAction: 'DAY' 
    });
  },

  /**
   * 处理玩家死亡事件
   * @param {string} playerId - 被杀玩家ID
   * @param {string} cause -死亡原因 (e.g., 'NIGHT', 'VOTE', 'POISON')
   * @returns {object} 返回死亡事件的结果，如是否触发猎人、警长死亡
   */
  async kill(playerId, cause) {
      let result = { hunterTriggered: false, sheriffDied: false };
      const playerBefore = this.allPlayers[playerId];
      if (!playerBefore || !playerBefore.isAlive) return result;

      const roleBeforeDeath = this.getActiveRole(playerBefore);
      let idiotFlipped = false;
      
      // 使用事务来安全地更新玩家状态
      const transaction = await db.ref(`games/${this.gameId}/players/${playerId}`).transaction(p => {
          if (!p || !p.isAlive) return p;
          
          // 白痴翻牌逻辑
          if (cause === 'VOTE' && p.identities[p.deaths]?.role === '白痴' && !p.isExposedIdiot) {
              p.isExposedIdiot = true;
              idiotFlipped = true;
              // 白痴免于死亡，不增加deaths
          } else {
              p.deaths = Math.min(p.deaths + 1, 2);
              if (p.deaths >= 2) {
                  p.isAlive = false;
              }
          }
          return p;
      });

      if (!transaction.committed) return result;
      if (idiotFlipped) {
          await this.addGameLog(`🤪 ${playerId}号被投票出局，翻开白痴身份，免于死亡！`, false);
          // 白痴翻牌后，游戏继续，不需要后续死亡处理
          return result;
      }
      
      const playerAfter = transaction.snapshot.val();
      const wasSheriff = playerBefore.badge;
      const isNowDead = !playerAfter.isAlive;
      const canTriggerHunter = roleBeforeDeath === '猎人' && ['NIGHT', 'VOTE', 'POISON', 'DUEL'].includes(cause);

      // 猎人开枪逻辑
      if (isNowDead && canTriggerHunter) {
          await db.ref(`games/${this.gameId}/state/hunterQueue/${playerId}`).set(true);
          result.hunterTriggered = true;
      }
      
      // 警长死亡逻辑
      if (isNowDead && wasSheriff) {
          const nextPhase = (cause === 'VOTE' || cause === 'DUEL') ? 'NIGHT' : 'DAY';
          await db.ref(`games/${this.gameId}/state`).update({ 
              phase: 'SHERIFF_TRANSFER', 
              postDeathState: { 
                  deadSheriffId: playerId, 
                  hunterTriggered: result.hunterTriggered, 
                  nextPhase: nextPhase 
              } 
          });
          result.sheriffDied = true;
      }
      
      await this.checkWin();
      return result;
  },

  /**
   * 检查并处理死亡后的连锁事件（猎人、警长）
   */
  async handlePostDeath({ hunterTriggered, sheriffDied, nextPhaseIfNoAction }) {
    if (sheriffDied) return; // 警长死亡会进入移交阶段，暂停游戏流程
    
    const isGameOver = await this.checkWin();
    if (isGameOver) return;

    const hunterQueue = (await db.ref(`games/${this.gameId}/state/hunterQueue`).once('value')).val() || {};
    if (Object.values(hunterQueue).some(v => v === true)) {
      // 如果有猎人待开枪
      await db.ref(`games/${this.gameId}/state/postDeathState`).transaction(v => {
          v = v || {};
          v.nextPhase = nextPhaseIfNoAction;
          return v;
      });
      await this.updatePhase('HUNTER_ACTION');
    } else if (nextPhaseIfNoAction) {
      // 如果没有连锁事件，进入下一阶段
      await this.updatePhase(nextPhaseIfNoAction);
    }
  },

  /**
   * 检查游戏是否满足胜利条件
   * @returns {boolean} 如果游戏结束则返回 true
   */
  async checkWin() {
    // 延迟一小段时间，确保数据库状态已更新
    await new Promise(r => setTimeout(r, 150));
    
    const snapshot = await db.ref(`games/${this.gameId}`).once('value');
    if (!snapshot.exists()) return false;
    
    const game = snapshot.val();
    if (game.state.phase === 'GAME_OVER') return true;

    let winnerMessage = null;
    const all = Object.values(game.players);
    const wolfFaction = all.filter(p => p.originalIdentities.some(id => ROLES[id.role].faction === 'bad'));
    const goodFaction = all.filter(p => !p.originalIdentities.some(id => ROLES[id.role].faction === 'bad'));
    
    const livingWolves = wolfFaction.filter(p => p.isAlive).length;
    const livingGoods = goodFaction.filter(p => p.isAlive).length;

    // 好人胜利条件
    if (livingWolves === 0) {
      winnerMessage = '好人阵营胜利！(狼人已全部出局)';
    } else if (game.state.peaceNightStreak >= 3) {
      winnerMessage = '好人阵营胜利！(连续三晚平安夜)';
    }

    // 狼人胜利条件
    if (!winnerMessage) {
      const winCondition = game.config?.wolfWin || 'edge';
      if (winCondition === 'exterminate') { // 屠城
        if (livingGoods === 0) {
          winnerMessage = '狼人阵营胜利！(屠城：好人全部出局)';
        }
      } else { // 屠边
        const gods = all.filter(p => p.originalIdentities.some(id => ROLES[id.role].isGod));
        const civilians = all.filter(p => p.originalIdentities.every(id => !ROLES[id.role].isGod && ROLES[id.role].faction === 'good'));
        
        const livingGods = gods.filter(p => p.isAlive).length;
        const livingCivilians = civilians.filter(p => p.isAlive).length;

        if (gods.length > 0 && livingGods === 0) {
          winnerMessage = '狼人阵营胜利！(屠边：神职全部出局)';
        } else if (civilians.length > 0 && livingCivilians === 0) {
          winnerMessage = '狼人阵营胜利！(屠边：平民全部出局)';
        }
      }
    }

    if (winnerMessage) {
      await db.ref(`games/${this.gameId}/state`).update({ phase: 'GAME_OVER', winner: winnerMessage });
      await this.addGameLog(`🏆 ${winnerMessage}`, false);
      return true;
    }
    
    return false;
  },

  // --- 辅助工具函数 ---
  getActiveRole(p) { if (!p || !p.isAlive || p.deaths >= p.identities.length) return null; return p.identities[p.deaths]?.role || null; },
  isAnyWolfInGame() { return Object.values(this.allPlayers).some(p => p.isAlive && ['狼人', '隐狼'].includes(this.getActiveRole(p))); },
  getSkillState(key, player = null, lifeIndex = -1) { const p = player || this.playerData; if (!p) return undefined; const i = lifeIndex !== -1 ? lifeIndex : p.deaths; return (p.skillStates || {})[`${i}_${key}`]; },
  async setSkillState(key, value) { const i = this.playerData.deaths; await db.ref(`games/${this.gameId}/players/${this.playerId}/skillStates/${i}_${key}`).set(value); },
  getGlobalSkillState(key) { return (this.playerData?.skillStates || {})[`global_${key}`]; },
  async setGlobalSkillState(key, val) { await db.ref(`games/${this.gameId}/players/${this.playerId}/skillStates/global_${key}`).set(val); },
  async setNightAction(data) { const round = this.gameState.round; await db.ref(`games/${this.gameId}/nightActions/${round}/${this.playerId}`).set({ ...data, actorId: this.playerId, inProgress: true }); }
};

// --- 应用启动 ---
// 将App对象挂载到window上，方便调试
window.App = App;
// DOM加载完成后，初始化应用
document.addEventListener('DOMContentLoaded', () => App.init());
