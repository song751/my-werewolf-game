/* ========================================
   双身份狼人杀 - V10.3 (综合优化修复版)
   - 作者: AI Assistant
   - 本次修复日志 (V10.3.1):
   - #1 [致命修复] 修正了 app.js 与 index.html 之间多个关键的 DOM ID 不匹配问题。
   -    - 'setup-screen' -> 'setup-view'
   -    - 'role-setup' -> 'role-grid' (用于身份配置的容器)
   -    - 'game-layout' -> 'game-view' (游戏主视图容器)
   -    此修复解决了脚本在初始化时因找不到元素而崩溃、导致页面空白的核心问题。
   -
   - #2 [致命修复] 移除了 renderHostControls 函数末尾重复的、导致语法错误的代码行。
   -    此修复保证了整个 JS 文件能够被浏览器正确解析和执行。
   -
   - #3 [逻辑修复] 实现了缺失的 attachGlobalListeners 函数，并修正了 init 函数的启动逻辑。
   -    - 新增 attachGlobalListeners 用于绑定全局点击事件，使所有 data-action 按钮生效。
   -    - 优化 init 函数，使其职责更清晰：仅判断初始状态（创建或加入），
   -      然后调用 showView 和 startApp 等专用函数来处理后续流程，
   -      修复了之前直接调用 listenToGameChanges(true) 的错误。
   -
   - #4 [代码质量] 统一了视图切换逻辑，全部通过 showView 函数执行，增强了代码的可维护性。
   -
   - #5 [逻辑修复] 修正了女巫夜间操作面板在 renderActionPanel 中逻辑块重复的问题。
   -
   - #6 [安全修复] 限制了狼队投票/刀口信息的可见性，现在只有普通狼人可见，隐狼不再能看到队友操作。
   -
   - (后续部分将包含其他逻辑和UI的完整修复)
   ======================================== */

// Firebase 配置保持不变
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

// 游戏核心常量，保持不变
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

// App 主对象，包含游戏状态和方法
const App = {
  // 游戏状态属性
  gameId: null,
  playerId: null,
  isHost: false,
  allPlayers: {},
  playerData: null,
  fullGameData: null,
  gameState: null,

  // Firebase 监听器引用，用于后续的正确卸载
  gameListener: null,
  logListener: null,
  logQueryRef: null,
  seenLogKeys: new Set(),
  wolfChatListener: null,
  wolfVotesListener: null,
  wolfVotesCallbackRef: null,
  playerSelectionListener: null,
  selection: null,

  // ========================================
  // 核心工具函数
  // ========================================

  /**
   * DOM 元素获取的简写方法
   * @param {string} id - 元素的 ID
   * @returns {HTMLElement}
   */
  $(id) { return document.getElementById(id) },

  /**
   * 转义 HTML 字符串，防止 XSS 攻击
   * @param {string} s - 需要转义的字符串
   * @returns {string}
   */
  escapeHTML(s) { return typeof s === 'string' ? s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])) : '' },

  /**
   * Fisher-Yates 洗牌算法，用于打乱数组
   * @param {Array} a - 需要打乱的数组
   * @returns {Array} - 打乱后的数组
   */
  _shuffle(a) { let i = a.length, r; while (i) { r = Math.floor(Math.random() * i--);[a[i], a[r]] = [a[r], a[i]] } return a; },

  /**
   * 显示一个浮动通知
   * @param {string} msg - 通知内容
   * @param {string} type - 通知类型 ('info', 'success', 'error')
   * @param {number} duration - 显示时长（毫秒）
   */
  showNotification(msg, type = 'info', duration = 5000) {
    const c = this.$('notification-container');
    const d = document.createElement('div');
    d.className = `notification ${type}`;
    d.innerHTML = `<div class="notification-content">${this.escapeHTML(msg)}</div>`;
    c.appendChild(d);
    setTimeout(() => d.classList.add('show'), 10); // 延迟添加 show 类以触发 CSS 动画
    setTimeout(() => {
      d.classList.add('fade-out');
      setTimeout(() => d.remove(), 300); // 等待 fade-out 动画结束后再移除元素
    }, duration);
  },

  /**
   * 向 Firebase 添加一条游戏日志
   * @param {string} message - 日志内容
   * @param {boolean} isSecret - 是否为秘密日志（仅上帝视角可见）
   */
  async addGameLog(message, isSecret = false) {
    const entry = {
      message,
      round: this.gameState?.round || 0,
      timestamp: firebase.database.ServerValue.TIMESTAMP,
      isSecret // 公私日志分离的关键字段
    };
    await db.ref(`games/${this.gameId}/logs`).push(entry);
  },

  // ========================================
  // 应用初始化与核心流程控制
  // ========================================

  /**
   * [已修复] 应用的总入口点。
   * 此函数负责解析 URL 参数，并根据参数决定显示设置页面还是游戏页面。
   */
  init() {
    const urlParams = new URLSearchParams(window.location.search);
    this.gameId = urlParams.get('game');
    this.playerId = urlParams.get('player');

    // [新增修复] 绑定全局事件监听器，这是所有按钮能够工作的先决条件。
    this.attachGlobalListeners();

    if (this.gameId && this.playerId) {
      // 如果 URL 带有 game 和 player 参数，说明是加入游戏
      // [逻辑修复] 不再直接操作 DOM，而是调用 startApp 来处理后续的验证和渲染流程。
      this.startApp();
    } else {
      // 如果没有参数，则显示游戏设置页面
      // [逻辑修复] 使用 showView 函数来标准地切换视图，而不是手动操作 classList。
      this.showView('setup');
      
      // [修复] 确保在显示设置视图后，调用 renderRoleSetup 来填充身份配置。
      // 这是解决“身份配置不显示”问题的关键步骤之一。
      this.renderRoleSetup();
    }
  },
  
  /**
   * [新增修复] 绑定全局事件监听器。
   * 将所有点击事件委托给 document，由 handleGlobalClick 统一处理。
   * 这是为了让所有带有 data-action 属性的按钮都能正常工作。
   */
  attachGlobalListeners() {
    document.addEventListener('click', this.handleGlobalClick.bind(this));
  },

  /**
   * [已修复] 切换并显示指定的视图 (setup, game, god)。
   * @param {string} name - 'setup', 'game', 或 'god'
   */
  showView(name) {
    ['setup', 'game', 'god'].forEach((v) => {
      // [ID修复] 此处 ID 已经和 HTML 对应 ('setup-view', 'game-view', 'god-view')
      const el = this.$(`${v}-view`);
      if (el) {
        el.classList.add('hidden');
        el.classList.remove('view-active');
      }
    });
    const target = this.$(`${name}-view`);
    if (target) {
      target.classList.remove('hidden');
      // 延迟添加动画类，确保视图切换动画生效
      setTimeout(() => target.classList.add('view-active'), 10);
    }
  },

  /**
   * [已修复] 开始游戏应用的核心逻辑，在确认 gameId 和 playerId 后调用。
   * 负责检查游戏是否存在，并根据玩家身份（普通玩家或上帝）启动对应的监听和渲染。
   */
  async startApp() {
    // 验证游戏是否存在
    const snap = await db.ref(`games/${this.gameId}`).once('value');
    if (!snap.exists()) {
      this.detachAllListeners();
      document.body.innerHTML = `<div class="error-container" style="text-align:center; margin-top: 100px;"><div style="font-size:48px;">😵</div><h2>游戏不存在</h2><p>游戏房间已关闭或链接无效</p><button onclick="location.href='?'" class="btn-primary" style="margin-top:20px;">返回首页</button></div>`;
      return;
    }

    // 根据 playerId 决定视图和监听器
    if (this.playerId === '0') {
      // 上帝视角
      this.showView('god');
      this.listenToGameChanges(this.renderGodView.bind(this));
    } else {
      // 玩家视角
      // [ID修复] 切换到 'game-view' 而不是 'game-layout'
      this.showView('game');
      this.listenToGameChanges(this.renderAll.bind(this));
      this.listenToLogs();
      this.listenToPlayerSelection();
    }
  },

  // ========================================
  // 游戏设置与创建
  // ========================================

  /**
   * [已修复] 渲染身份配置界面。
   * 从 DEFAULT_SETUP 读取默认配置，并动态生成 HTML 元素。
   */
  renderRoleSetup() {
    // [ID修复] 渲染的目标容器从 'role-setup' 改为 'role-grid'，与 index.html 保持一致。
    const container = this.$('role-grid');
    if (!container) return; // 增加一个安全检查
    container.innerHTML = ''; // 清空旧内容

    Object.keys(DEFAULT_SETUP).forEach(name => {
      const role = ROLES[name];
      const icon = role.icon;
      const defaultValue = DEFAULT_SETUP[name];
      const div = document.createElement('div');
      div.className = 'role-setup-item';
      // 模板字符串中的 id 也被修正
      div.innerHTML = `
        <span class="role-name"><span class="role-icon">${icon}</span><span>${name}</span></span>
        <div class="role-counter">
          <button class="counter-btn minus" data-role="${name}">−</button>
          <input type="number" id="role-${name}" min="0" value="${defaultValue}" readonly>
          <button class="counter-btn plus" data-role="${name}">+</button>
        </div>`;
      container.appendChild(div);
    });

    // 事件委托：将点击事件绑定到父容器上，提高性能
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('.counter-btn');
      if (btn) {
        const role = btn.dataset.role;
        const input = this.$(`role-${role}`);
        let value = parseInt(input.value) || 0;
        if (btn.classList.contains('plus') && value < 10) value++;
        else if (btn.classList.contains('minus') && value > 0) value--;
        input.value = value;
        this.updateRoleStats(); // 每次变更后更新统计信息
      }
    });

    // 初始化统计信息
    this.updateRoleStats();
  },
  
  /**
   * [已修复] 更新设置页面下方的统计信息（总身份数、玩家数）。
   */
  updateRoleStats() {
    // [ID修复] 从 'role-setup' 改为 'role-grid' 来查找输入框。
    const container = this.$('role-grid');
    if (!container) return;

    let totalRoles = 0;
    container.querySelectorAll('input').forEach(i => totalRoles += +i.value || 0);
    
    this.$('total-roles').textContent = totalRoles;
    const playerCount = totalRoles > 0 && totalRoles % 2 === 0 ? totalRoles / 2 : '?';
    this.$('player-cnt').textContent = playerCount;
    
    // 更新警告提示
    this.$('player-count-warning').textContent =
      typeof playerCount === 'number' && playerCount > 12 ? '⚠️ 建议玩家数不超过12人' :
        (totalRoles % 2 !== 0 ? '⚠️ 身份总数必须为偶数' : '');
  },

  /**
   * 创建游戏的内部核心逻辑。
   * @param {object} config - 包含 roleSetup 和 rules 的配置对象
   * @returns {Promise<object>} - 返回包含 gameId 和 playerCount 的对象，或一个 error 对象
   */
  async _executeGameCreation(config) {
    const pool = [];
    Object.entries(config.roleSetup).forEach(([role, count]) => {
      for (let k = 0; k < count; k++) pool.push(role);
    });

    if (pool.length === 0 || pool.length % 2 !== 0) {
      return { error: '身份总数需为偶数且大于0' };
    }

    const pairs = this.deal(pool);
    if (!pairs) {
      return { error: '无法生成符合规则的牌组，请调整身份配置。' };
    }

    const gameId = db.ref('games').push().key;
    const playerCount = pool.length / 2;
    const players = {};
    for (let i = 1; i <= playerCount; i++) {
      players[i] = { id: i, identities: pairs[i - 1], originalIdentities: JSON.parse(JSON.stringify(pairs[i - 1])), deaths: 0, isAlive: true, isReady: false, isExposedIdiot: false, skillStates: {}, badge: 0 };
    }
    
    const gameData = {
      state: { phase: 'SETUP', round: 0, peaceNightStreak: 0, winner: null, creatorId: 1, nightStatus: {}, hunterQueue: {}, postDeathState: null, dayVotingOpen: false },
      players,
      config: { ...config.rules, playerCount }, // 将玩家数量也存入配置
      // 初始化游戏内的各种数据结构
      playerSelections: {}, wolfChat: {}, wolfVotes: {}, nightActions: {}, sheriff: {}, dayVotes: {}, logs: {}
    };

    await db.ref(`games/${gameId}`).set(gameData);
    return { gameId, playerCount };
  },
   
  /**
   * [已修复] “创建游戏”按钮的点击事件处理函数。
   * 收集页面上的配置，调用 _executeGameCreation，并处理成功或失败的 UI 更新。
   */
  async createGame() {
    const btn = this.$('btn-create');
    btn.disabled = true;
    this.$('create-text').classList.add('hidden');
    this.$('create-spinner').classList.remove('hidden');
    const errorEl = this.$('setup-error');
    errorEl.classList.add('hidden');
    errorEl.textContent = '';

    const roleSetup = {};
    // [ID修复] 从 'role-setup' 改为 'role-grid' 来收集配置
    this.$('role-grid').querySelectorAll('input').forEach(i => {
      const roleName = i.id.replace('role-', '');
      const count = +i.value;
      if (count > 0) roleSetup[roleName] = count;
    });

    const totalRoles = Object.values(roleSetup).reduce((sum, count) => sum + count, 0);
    if (totalRoles / 2 > 12) {
      if (!confirm('玩家数量超过12人，可能影响游戏体验，确定要创建吗？')) {
        return this.setupFail('操作已取消。'); // 使用 setupFail 来重置UI
      }
    }

    const gameConfig = {
        roleSetup,
        rules: {
            witchSelfSaveRule: this.$('opt-witch-selfsave').value,
            seerMode: this.$('opt-seer-mode').value,
            wolfWin: this.$('opt-wolf-win').value
        }
    };

    const result = await this._executeGameCreation(gameConfig);

    if (result.error) {
      return this.setupFail(result.error); // 如果创建失败，调用 setupFail 显示错误并重置UI
    }

    this.showNotification('游戏创建成功！', 'success');
    // [ID修复] 隐藏 'role-setup-section' 而不是不存在的 'role-setup'
    this.$('role-setup-section').classList.add('hidden');
    btn.classList.add('hidden');
    const info = this.$('game-creation-info');
    info.classList.remove('hidden');
    const base = `${location.origin}${location.pathname}`;
    const url = `${base}?game=${result.gameId}&player=PLAYER_ID`;
    
    let playerOptions = '';
    for (let i = 2; i <= result.playerCount; i++) {
        playerOptions += `<option value="${i}">${i}号玩家</option>`;
    }

    // 创建成功后显示的 HTML 内容
    info.innerHTML = `
      <div class="success-message" style="text-align:center; margin-bottom:16px;">
        <div style="font-size:32px; margin-bottom:8px;">✅</div>
        <h3>游戏房间已创建</h3>
        <p style="color:var(--text-secondary); font-size:14px;">将以下链接分享给玩家，记得替换 PLAYER_ID 为对应座位号</p>
      </div>
      <div class="link-container" style="display:flex; gap:8px; margin-bottom: 16px;">
        <input id="player-link-template" class="fancy-input" value="${url}" readonly style="text-align:left;">
        <button data-action="copy-link" data-inputid="player-link-template" class="control-btn" style="flex-shrink:0;"><span>复制</span></button>
      </div>
      <div class="host-transfer-section" style="border-top: 1px solid var(--border-primary); padding-top: 16px; margin-top: 16px;">
        <h4 style="text-align:center; font-weight:600; margin-bottom:8px;">房主操作</h4>
        <div style="display:flex; gap:8px; align-items-center; margin-bottom:16px;">
          <select id="host-transfer-select" class="rule-select" style="flex-grow:1;">
            <option value="">将房主移交给...</option>
            ${playerOptions}
          </select>
          <button data-action="transfer-host-pregame" data-gameid="${result.gameId}" class="control-btn">确认移交</button>
        </div>
        <button data-action="join-as-creator" data-gameid="${result.gameId}" class="btn-primary btn-large"><span>以房主身份进入</span></button>
      </div>`;
  },

  /**
   * [已修复] 当游戏创建失败时，重置设置界面的 UI 状态。
   * @param {string} msg - 要显示的错误信息
   */
  setupFail(msg) {
    const errorEl = this.$('setup-error');
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
    
    // 完整地重置UI，允许用户修改配置后重试
    this.$('create-text').classList.remove('hidden');
    this.$('create-spinner').classList.add('hidden');
    this.$('btn-create').disabled = false;
    
    // [ID修复] 确保身份配置区域和创建按钮在失败后重新可见
    this.$('role-setup-section').classList.remove('hidden');
    this.$('btn-create').classList.remove('hidden');
    this.$('game-creation-info').classList.add('hidden');
  },

  /**
   * 发牌算法。
   * 尝试多次洗牌，直到生成一个满足所有预设规则（不成对规则、金水数量等）的牌组。
   * @param {Array<string>} pool - 包含所有待分配身份的数组
   * @returns {Array|null} - 返回一个合规的身份对数组，如果无法生成则返回 null
   */
  deal(pool) {
    // 尝试5000次以找到一个有效的组合
    for (let t = 0; t < 5000; t++) {
      const shuffledPool = this._shuffle([...pool]);
      let isCombinationOk = true;
      const rawPairs = [];
      for (let i = 0; i < shuffledPool.length; i += 2) {
        rawPairs.push([shuffledPool[i], shuffledPool[i + 1]].sort());
      }

      // 检查是否有被禁止的身份组合
      for (const pair of rawPairs) {
        if (FORBIDDEN_RAW.some(([a, b]) => (a === pair[0] && b === pair[1]) || (a === pair[1] && b === pair[0]))) {
          isCombinationOk = false;
          break;
        }
      }
      if (!isCombinationOk) continue; // 如果不合规，开始下一次尝试

      const finalPairs = [], roleCounts = {};
      for (const p of rawPairs) {
        let id1, id2;
        // 特殊处理盗贼
        if (p[0] === '盗贼') {
          id1 = { r: p[1], t: true }; // 标记为盗贼复制的身份
          id2 = { r: p[1], t: true };
        } else {
          id1 = { r: p[0], t: false };
          id2 = { r: p[1], t: false };
        }
        finalPairs.push([
          { role: id1.r, isThiefCopy: id1.t },
          { role: id2.r, isThiefCopy: id2.t }
        ]);
        roleCounts[id1.r] = (roleCounts[id1.r] || 0) + 1;
        roleCounts[id2.r] = (roleCounts[id2.r] || 0) + 1;
      }

      // 检查规则：金水数量（双民）必须在1-2之间
      const goldenPairsCount = finalPairs.filter(p => p[0].role === '平民' && p[1].role === '平民').length;
      if (goldenPairsCount < 1 || goldenPairsCount > 2) continue;
      
      // 检查规则：必须有狼和神
      const wolfCount = (roleCounts['狼人'] || 0) + (roleCounts['隐狼'] || 0);
      if (wolfCount === 0) continue;
      const godCount = Object.keys(roleCounts).reduce((sum, role) => sum + (ROLES[role].isGod ? roleCounts[role] : 0), 0);
      if (godCount === 0) continue;

      // 如果所有规则都通过，返回这个组合
      return finalPairs;
    }
    // 如果尝试多次后仍然失败，返回 null
    return null;
  },

// ========================================
  // 事件监听器管理
  // ========================================

  /**
   * [新增] 卸载所有活动的 Firebase 监听器。
   * 在游戏结束或玩家离开时调用，以防止内存泄漏和不必要的后台数据同步。
   */
  detachAllListeners() {
    if (this.gameListener) db.ref(`games/${this.gameId}`).off('value', this.gameListener);
    if (this.logQueryRef && this.logListener) this.logQueryRef.off('child_added', this.logListener);
    if (this.playerSelectionListener) db.ref(`games/${this.gameId}/playerSelections/${this.playerId}`).off('value', this.playerSelectionListener);
    this.stopWolfListeners(); // 停止狼人专用的监听器
    
    // 清空引用
    this.gameListener = null;
    this.logListener = null;
    this.playerSelectionListener = null;
    console.log('所有 Firebase 监听器已成功卸载。');
  },

  /**
   * [已修复] 全局点击事件处理器。
   * 通过事件委托处理所有带有 `data-action` 属性的元素的点击事件。
   * @param {Event} e - 点击事件对象
   */
  handleGlobalClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return; // 如果没点到按钮或按钮被禁用，则不执行
    const action = btn.dataset.action;

    // 添加按钮点击的视觉效果
    btn.classList.add('clicked');
    setTimeout(() => btn.classList.remove('clicked'), 280);

    // 处理不需要成为房主的通用操作
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

    // 检查需要房主权限的操作
    if (action.startsWith('host-') && !this.isHost) {
      this.showNotification('只有主持人才能执行此操作', 'error');
      return;
    }
    
    // 使用 switch 分发复杂的动作
    switch (action) {
      case 'create-game': this.createGame(); return;
      case 'host-start': this.updatePhase('NIGHT', 1); return;
      case 'host-day': this.processNight(); return;
      case 'confirm-selection': this.confirmSelection(); return;
      case 'skip-selection': this.skipSelection(); return;
      case 'cancel-selection': this.clearSelection(); return;
      case 'wolf-confirm': this.wolfConfirmKill(btn); return;
      case 'witch-cure': this.witchTryCure(btn.dataset.target); return;
      case 'witch-poison-start': this.setSelection({ type: 'witch-poison' }); return;
      default: {
        // 将其他简单的或特定场景的动作交给子函数处理，保持主函数整洁
        this.handleSimpleAction(action, btn);
      }
    }
  },

  /**
   * [新增] 处理较为简单的或特定场景下的按钮动作。
   * @param {string} action - 动作名称
   * @param {HTMLElement} btn - 被点击的按钮元素
   */
  handleSimpleAction(action, btn) {
    switch(action) {
        case 'join-as-creator': {
            const gid = btn.dataset.gameid || btn.getAttribute('value');
            if (!gid) { this.showNotification('未获取到游戏ID，请刷新后重试', 'error'); return; }
            this.gameId = gid;
            this.playerId = '1'; // 创建者默认为1号
            history.pushState(null, '', `?game=${this.gameId}&player=${this.playerId}`);
            this.startApp(); // 使用标准流程进入游戏
            return;
        }
        case 'transfer-host-pregame': {
            const gameId = btn.dataset.gameid;
            const newHostId = this.$('host-transfer-select').value;
            if (newHostId && gameId) {
                db.ref(`games/${gameId}/state/creatorId`).set(Number(newHostId)).then(() => {
                    this.showNotification(`房主已成功移交给 ${newHostId} 号玩家！`, 'success');
                    this.$('host-transfer-select').value = '';
                });
            } else {
                this.showNotification('请选择一个玩家进行移交。', 'error');
            }
            return;
        }
        case 'host-transfer-ingame': {
            const newHostId = this.$('host-transfer-select-ingame').value;
            if (newHostId) {
                db.ref(`games/${this.gameId}/state/creatorId`).set(Number(newHostId)).then(() => {
                    this.showNotification(`主持人已成功移交给 ${newHostId} 号玩家！`, 'success');
                });
            } else {
                this.showNotification('请选择一个玩家进行移交。', 'error');
            }
            return;
        }
        case 'host-restart-game': {
            if (confirm('确定要为所有玩家开启新的一局游戏吗？此操作会重置所有身份和状态。')) {
                btn.disabled = true;
                btn.innerHTML = '<span class="spinner"></span> 正在创建...';
                this.restartGame();
            }
            return;
        }
        case 'host-force-start': if (confirm('确定要强制开始游戏吗？所有未准备的玩家将自动准备。')) { const up = {}; Object.values(this.allPlayers).forEach(p => { if (!p.isReady) up[`players/${p.id}/isReady`] = true }); db.ref(`games/${this.gameId}`).update(up).then(() => this.updatePhase('NIGHT', 1)); } return;
        case 'host-sheriff-cand-init': this.updatePhase('SHERIFF_CAND'); return;
        case 'host-sheriff-speech': this.updatePhase('SHERIFF_SPEECH'); return;
        case 'host-sheriff-vote': this.hostEnterSheriffVote(); return;
        case 'host-sheriff-elect-single': this.hostSheriffElectSingle(); return;
        case 'host-tally-sheriff': this.tallySheriffVotes(); return;
        case 'host-force-tally-sheriff': this.tallySheriffVotes(); return;
        case 'host-force-end-cand': this.updatePhase('SHERIFF_SPEECH'); return;
        case 'host-force-day': if (confirm('确定要强制进入白天吗？所有未行动的玩家将视为跳过。')) this.processNight(); return;
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

  // ========================================
  // 模态框与数据监听
  // ========================================

  /**
   * 打开一个模态框（例如日志窗口）
   * @param {string} id - 模态框的 ID
   */
  openModal(id) {
    const m = this.$(id);
    if (!m) return;
    m.classList.add('open');
    const overlay = m.querySelector('.modal-overlay');
    if (overlay) {
      // 点击遮罩层关闭模态框，{ once: true } 确保事件只触发一次
      overlay.addEventListener('click', () => this.closeModal(id), { once: true });
    }
  },

  /**
   * 关闭一个模态框
   * @param {string} id - 模态框的 ID
   */
  closeModal(id) {
    const m = this.$(id);
    if (!m) return;
    m.classList.remove('open');
  },

  /**
   * 监听游戏日志的变化，并将其渲染到日志模态框中。
   */
  listenToLogs() {
    // 先移除旧的监听器，防止重复添加
    if (this.logQueryRef && this.logListener) this.logQueryRef.off('child_added', this.logListener);
    this.seenLogKeys.clear(); // 清空已见日志记录
    
    this.logQueryRef = db.ref(`games/${this.gameId}/logs`).limitToLast(200); // 只监听最新的200条
    this.logListener = this.logQueryRef.on('child_added', snap => {
      if (!snap.exists() || this.seenLogKeys.has(snap.key)) return;
      this.seenLogKeys.add(snap.key);
      const log = snap.val();
      
      // 玩家日志只显示公开信息 (isSecret=false)
      if (log && !log.isSecret) {
        const cont = this.$('game-log-content');
        if(!cont) return;
        const p = document.createElement('div');
        p.className = 'log-item fade-in';
        const prefix = log.round > 0 ? `<span class="log-round">[第${log.round}轮]</span> ` : '';
        p.innerHTML = prefix + this.escapeHTML(log.message);
        cont.appendChild(p);
        cont.scrollTop = cont.scrollHeight; // 自动滚动到底部
      }
    });
  },

  /**
   * 监听整个游戏状态树的变化。这是应用数据驱动的核心。
   * @param {Function} render - 数据变化后需要执行的渲染函数
   */
  listenToGameChanges(render) {
    if (this.gameListener) db.ref(`games/${this.gameId}`).off('value', this.gameListener);
    this.gameListener = db.ref(`games/${this.gameId}`).on('value', s => {
      if (!s.exists()) {
        // 如果游戏数据被删除（例如房主解散游戏），则清理并提示
        this.detachAllListeners();
        document.body.innerHTML = `<div class="error-container" style="text-align:center; margin-top: 100px;"><div style="font-size:48px;">🎮</div><h2>游戏已结束</h2><p>感谢参与本局游戏</p><button onclick="location.href='?'" class="btn-primary" style="margin-top:20px;">开始新游戏</button></div>`;
        return;
      }
      const g = s.val();
      this.fullGameData = g;
      this.gameState = g.state;
      this.allPlayers = g.players;

      if (this.playerId !== '0') { // 如果不是上帝视角
        if (!g.players || !g.players[this.playerId]) {
          // 如果玩家数据在游戏中不存在，则判定为非法进入
          this.detachAllListeners();
          document.body.innerHTML = `<div class="error-container" style="text-align:center; margin-top: 100px;"><div style="font-size:48px;">❌</div><h2>无法加入游戏</h2><p>你不是该游戏的玩家或已被移除</p><button onclick="location.href='?'" class="btn-primary" style="margin-top:20px;">返回首页</button></div>`;
          return;
        }
        this.playerData = g.players[this.playerId];
        this.isHost = this.playerData.id == this.gameState.creatorId;
      }
      
      // 如果不是夜晚，停止狼人专用的监听器以节省资源
      if (this.gameState.phase !== 'NIGHT') this.stopWolfListeners();
      
      // 调用传入的渲染函数，更新界面
      render();
    });
  },
  
  /**
   * 监听当前玩家的个人选择状态（例如，选择了哪个目标）。
   * 这使得选择状态可以持久化，刷新页面也不会丢失。
   */
  listenToPlayerSelection() {
      if (this.playerSelectionListener) db.ref(`games/${this.gameId}/playerSelections/${this.playerId}`).off('value', this.playerSelectionListener);
      
      this.playerSelectionListener = db.ref(`games/${this.gameId}/playerSelections/${this.playerId}`).on('value', snap => {
          this.selection = snap.val(); // 更新本地的 selection 对象
          // [ID修复] 只有在 'game-view' 可见时才重新渲染，避免在其他视图下执行不必要的操作
          if (this.$('game-view').classList.contains('view-active')) {
              this.renderActionPanel();
              this.renderPlayerGrid();
          }
      });
  },

  // ========================================
  // 游戏内逻辑与渲染
  // ========================================

  /**
   * [新增] “重新开始一局”的逻辑。
   * 此函数会重置游戏状态，但保留原有玩家和身份配置，并重新发牌。
   */
  async restartGame() {
    this.showNotification('正在重置游戏...', 'info');
    const oldGame = this.fullGameData;
    if (!oldGame) {
      this.showNotification('无法获取旧游戏数据，请刷新后重试。', 'error');
      return;
    }

    // 1. 从原始身份数据中重建身份池
    const roleSetup = {};
    Object.values(oldGame.players).forEach(p => {
        p.originalIdentities.forEach(id => {
            roleSetup[id.role] = (roleSetup[id.role] || 0) + 1;
        });
    });
    Object.keys(roleSetup).forEach(role => { roleSetup[role] /= 2; }); // 因为每人双身份，所以要除以2

    // 2. 重新发牌
    const pool = [];
    Object.entries(roleSetup).forEach(([role, count]) => {
      for (let k = 0; k < count; k++) pool.push(role);
    });
    const newPairs = this.deal(pool);
    if (!newPairs) {
        this.showNotification('重新发牌失败，无法生成符合规则的牌组。', 'error');
        return;
    }

    // 3. 创建新的玩家状态对象，重置所有状态
    const newPlayers = {};
    Object.values(oldGame.players).forEach((p, index) => {
        newPlayers[p.id] = { 
            id: p.id, 
            identities: newPairs[index], 
            originalIdentities: JSON.parse(JSON.stringify(newPairs[index])), 
            deaths: 0, 
            isAlive: true, 
            isReady: false, 
            isExposedIdiot: false, 
            skillStates: {}, 
            badge: 0 
        };
    });

    // 4. 构造一个用于覆盖旧游戏状态的更新包
    const updates = {
        'state/phase': 'SETUP',
        'state/round': 0,
        'state/peaceNightStreak': 0,
        'state/winner': null,
        'state/nightStatus': {},
        'state/hunterQueue': {},
        'state/postDeathState': null,
        'state/dayVotingOpen': false,
        'players': newPlayers,
        // 清空所有上一局的临时数据
        'playerSelections': {},
        'wolfChat': {},
        'wolfVotes': {},
        'nightActions': {},
        'sheriff': {},
        'dayVotes': {},
        'logs': {}
    };

    await db.ref(`games/${this.gameId}`).update(updates);
    this.showNotification('游戏已重置！请所有玩家确认新身份。', 'success');
  },

  /**
   * [已修复] 渲染玩家的身份卡片。
   * 修正了盗贼身份的显示逻辑，确保正确显示其复制的身份和特殊样式。
   */
  renderIdentityCard() {
    const pd = this.playerData;
    if (!pd) return;
    const identities = pd.identities;
    const originalIdentities = pd.originalIdentities;
    const deaths = pd.deaths;
    
    // 格式化单个身份的显示，特别处理盗贼
    const formatIdentity = (identity, originalIdentity) => {
      // 如果这个身份牌的原始身份是盗贼，则应用特殊样式
      if (originalIdentity.role === '盗贼') {
        const currentRoleName = identity.role;
        return `<span class="identity-item">
                  <span class="identity-icon thief-icon">🎭</span>
                  <span class="identity-name thief-copy-text">${currentRoleName} (盗)</span>
                </span>`;
      }
      
      // 否则，正常显示
      const roleInfo = ROLES[identity.role];
      return `<span class="identity-item">
                <span class="identity-icon">${roleInfo.icon}</span>
                <span class="identity-name">${identity.role}</span>
              </span>`;
    };
    
    // 组合成完整的身份卡片内容
    let cardContent = `<div class="identity-header">你的身份</div><div class="identity-display">${deaths >= 1 ? '<span class="identity-dead">' : ''}${formatIdentity(identities[0], originalIdentities[0])}${deaths >= 1 ? '</span>' : ''}<span class="identity-separator">+</span>${deaths >= 2 ? '<span class="identity-dead">' : ''}${formatIdentity(identities[1], originalIdentities[1])}${deaths >= 2 ? '</span>' : ''}</div>`;
    
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
   * [已修复] 渲染主持人专属的操作面板。
   * 修复了函数末尾的致命语法错误。
   */
  renderHostControls() {
    const el = this.$('host-controls');
    el.classList.remove('hidden');
    const phase = this.gameState.phase;
    let html = `<div class="host-panel">`;
    const allPlayers = Object.values(this.allPlayers);

    // 一个辅助函数，用于生成玩家标签列表
    const generatePlayerTags = (playerList, className = '') => {
        if (!playerList || playerList.length === 0) return '<span style="color:var(--text-tertiary);">无</span>';
        return playerList.map(p => `<span class="player-tag ${className}">${p.id}号</span>`).join('');
    };

    // 根据不同游戏阶段生成不同的主持人控件
    if (phase === 'SETUP') {
        const readyPlayers = allPlayers.filter(p => p.isReady);
        const pendingPlayers = allPlayers.filter(p => !p.isReady);
        html += `<div class="host-status"><div class="host-status-title">玩家准备 (${readyPlayers.length}/${allPlayers.length})</div><div class="status-category"><div class="category-title">已准备:</div><div class="player-tags">${generatePlayerTags(readyPlayers, 'done')}</div></div><div class="status-category"><div class="category-title">未准备:</div><div class="player-tags">${generatePlayerTags(pendingPlayers, 'pending')}</div></div></div>`;
        html += `<div class="host-actions" style="display:flex; gap:8px;">`;
        if (pendingPlayers.length > 0) html += `<button class="action-btn" data-action="host-force-start" style="flex:1;">强制开始</button>`;
        html += `<button class="confirm-btn" data-action="host-start" ${pendingPlayers.length > 0 ? 'disabled' : ''} style="flex:1;">🚀 开始游戏</button>`;
        html += `</div>`;
    }
    if (phase === 'NIGHT') {
        const nightStatus = this.gameState.nightStatus || {};
        const allDone = Object.values(nightStatus).every(s => s === 'complete');
        const hasSheriff = allPlayers.some(p => p.badge);
        const isFirstNight = this.gameState.round === 1;
        html += `<div class="host-status"><div class="host-status-title">夜晚行动中...</div></div>`;
        html += `<div class="host-actions" style="display:flex; gap:8px;">`;
        if (isFirstNight && !hasSheriff) { // 首夜且无警长，则天亮后进入上警环节
            if (!allDone) html += `<button class="action-btn" data-action="host-force-day" style="flex:1;">强制上警</button>`;
            html += `<button class="confirm-btn" data-action="host-sheriff-cand-init" ${!allDone ? 'disabled' : ''} style="flex:1;">👑 开始上警</button>`;
        } else {
            if (!allDone) html += `<button class="action-btn" data-action="host-force-day" style="flex:1;">强制天亮</button>`;
            html += `<button class="confirm-btn" data-action="host-day" ${!allDone ? 'disabled' : ''} style="flex:1;">☀️ 天亮了</button>`;
        }
        html += `</div>`;
    }
    if (phase === 'SHERIFF_CAND') {
        const alivePlayers = allPlayers.filter(p => p.isAlive);
        const decisions = this.fullGameData.sheriff?.candidates || {};
        const decidedPlayers = alivePlayers.filter(p => decisions[p.id] !== undefined);
        const pendingPlayers = alivePlayers.filter(p => decisions[p.id] === undefined);
        html += `<div class="host-status"><div class="host-status-title">上警意向 (${decidedPlayers.length}/${alivePlayers.length})</div><div class="status-category"><div class="category-title">已决定:</div><div class="player-tags">${generatePlayerTags(decidedPlayers, 'done')}</div></div><div class="status-category"><div class="category-title">等待中:</div><div class="player-tags">${generatePlayerTags(pendingPlayers, 'pending')}</div></div></div>`;
        html += `<div class="host-actions" style="display:flex; gap:8px;"><button class="action-btn" data-action="host-force-end-cand" style="flex:1;">强制结束</button><button class="confirm-btn" data-action="host-sheriff-speech" ${pendingPlayers.length > 0 ? 'disabled' : ''} style="flex:1;">进入发言</button></div>`;
    }
    if (phase === 'SHERIFF_SPEECH') {
        const candidates = this.fullGameData.sheriff?.candidates || {};
        const drops = this.fullGameData.sheriff?.drops || {};
        const validCandidates = Object.keys(candidates).filter(id => candidates[id] && !drops[id]);
        if (validCandidates.length === 1) html += `<div class="single-sheriff" style="text-align:center; margin-bottom:8px;">独警：${validCandidates[0]}号 <button class="confirm-btn" data-action="host-sheriff-elect-single" style="margin-left:8px;">直接当选</button></div>`;
        html += `<div class="host-actions"><button class="control-btn" data-action="host-sheriff-vote" style="width:100%;">进入投票</button></div>`;
    }
    if (phase === 'SHERIFF_VOTE') {
        const voters = allPlayers.filter(p => p.isAlive && !p.isExposedIdiot);
        const votedIds = Object.keys(this.fullGameData.sheriff?.votes || {});
        const votedPlayers = voters.filter(p => votedIds.includes(p.id.toString()));
        const pendingPlayers = voters.filter(p => !votedIds.includes(p.id.toString()));
        html += `<div class="host-status"><div class="host-status-title">警长投票 (${votedPlayers.length}/${voters.length})</div><div class="status-category"><div class="category-title">已投票:</div><div class="player-tags">${generatePlayerTags(votedPlayers, 'done')}</div></div><div class="status-category"><div class="category-title">未投票:</div><div class="player-tags">${generatePlayerTags(pendingPlayers, 'pending')}</div></div></div>`;
        html += `<div class="host-actions" style="display:flex; gap:8px;"><button class="action-btn" data-action="host-force-tally-sheriff" style="flex:1;">强制计票</button><button class="confirm-btn" data-action="host-tally-sheriff" ${pendingPlayers.length > 0 ? 'disabled' : ''} style="flex:1;">📊 统计</button></div>`;
    }
    if (phase === 'DAY') {
        const isVotingOpen = !!this.fullGameData.state.dayVotingOpen;
        if (isVotingOpen) {
            const voters = allPlayers.filter(p => p.isAlive && !p.isExposedIdiot);
            const votedIds = Object.keys(this.fullGameData.dayVotes?.[this.gameState.round] || {});
            const votedPlayers = voters.filter(p => votedIds.includes(p.id.toString()));
            const pendingPlayers = voters.filter(p => !votedIds.includes(p.id.toString()));
            html += `<div class="host-status"><div class="host-status-title">放逐投票 (${votedPlayers.length}/${voters.length})</div><div class="status-category"><div class="category-title">已投票:</div><div class="player-tags">${generatePlayerTags(votedPlayers, 'done')}</div></div><div class="status-category"><div class="category-title">未投票:</div><div class="player-tags">${generatePlayerTags(pendingPlayers, 'pending')}</div></div></div>`;
            html += `<div class="host-actions" style="display:flex; gap:8px;"><button class="action-btn" data-action="host-force-tally-day" style="flex:1;">强制计票</button><button class="confirm-btn" data-action="host-tally-day" ${pendingPlayers.length > 0 ? 'disabled' : ''} style="flex:1;">📊 统计</button></div>`;
        } else {
            html += `<div class="host-actions"><button class="confirm-btn" data-action="host-open-day-vote" style="width:100%;">开启投票</button></div>`;
        }
    }
    if (phase === 'SHERIFF_TRANSFER') { html += `<div class="transfer-status" style="text-align:center; margin-bottom:8px;">⚰️ 警长已阵亡，等待移交或撕毁</div><button class="action-btn" data-action="host-force-badge-destroy" style="width:100%;">强制撕毁</button>`; }
    if (phase === 'GAME_OVER') {
        html += `<div class="game-over-host" style="text-align:center; color:var(--text-secondary); margin-bottom: 16px;">🎮 游戏已结束</div>`;
        
        const otherPlayers = allPlayers.filter(p => p.id != this.playerId);
        let playerOptions = '';
        if(otherPlayers.length > 0) {
            playerOptions = otherPlayers.map(p => `<option value="${p.id}">${p.id}号玩家</option>`).join('');
            html += `
              <div class="host-transfer-section" style="margin-bottom: 16px;">
                <div style="display:flex; gap:8px; align-items:center;">
                  <select id="host-transfer-select-ingame" class="rule-select" style="flex-grow:1;">
                    <option value="">将会长移交给...</option>
                    ${playerOptions}
                  </select>
                  <button data-action="host-transfer-ingame" class="control-btn">确认移交</button>
                </div>
              </div>`;
        }
        html += `<button class="btn-primary btn-large" data-action="host-restart-game"><span>🔁 重新开始一局</span></button>`;
    }
    html += `</div>`; // 结束 .host-panel
    // [语法修复] 确保函数在这里正确结束，移除了多余的 '},' 和 'el.innerHTML = h;'
    el.innerHTML = html;
  },

  /**
   * 主渲染函数，调用所有子渲染函数来更新整个游戏界面。
   */
  renderAll() {
    // 更新顶部的徽章显示
    this.$('host-badge').classList.toggle('hidden', !this.isHost);
    this.$('sheriff-badge-top').classList.toggle('hidden', !this.playerData?.badge);
    
    // 依次渲染各个组件
    this.renderStatus();
    this.renderIdentityCard();
    this.renderPersistentInfo();
    this.renderActionPanel();
    this.renderPlayerGrid();
    if (this.isHost) {
      this.renderHostControls();
    }
  },

  /**
   * 渲染中央面板顶部的状态栏。
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
      HUNTER_ACTION: '🔫 猎人正在开枪',
      SHERIFF_TRANSFER: '💔 警长阵亡，等待移交'
    };
    const statusBar = this.$('status-bar');
    const statusText = phaseMap[this.gameState.phase] || '游戏进行中';
    statusBar.innerHTML = `<span class="status-text">${statusText}</span>`;
  },

  /**
   * 渲染持久化信息区域（例如预言家的查验记录）。
   */
  renderPersistentInfo() {
    let html = '';
    // 如果是预言家，显示查验记录
    if (this.getActiveRole(this.playerData) === '预言家') {
      const mode = this.fullGameData.config?.seerMode || 'faction';
      const results = this.getGlobalSkillState('seerResults') || {};
      const entries = Object.entries(results);
      if (entries.length > 0) {
        html += `<div class="seer-results"><div class="seer-title">🔮 查验记录 (${mode === 'faction' ? '阵营' : '身份'})</div><div class="seer-list">`;
        entries.forEach(([id, res]) => { html += `<span class="seer-item">${id}号: <strong>${this.escapeHTML(res)}</strong></span>`; });
        html += `</div></div>`;
      }
    }
    const el = this.$('persist');
    el.innerHTML = html;
    el.classList.toggle('hidden', !html); // 如果没有内容则隐藏
  },

  /**
   * [已修复] 渲染左右两侧的玩家网格。
   * 修复了隐狼可以看到狼队投票信息的 Bug。
   */
  renderPlayerGrid() {
    const leftGrid = this.$('player-grid-left');
    const rightGrid = this.$('player-grid-right');
    leftGrid.innerHTML = ''; 
    rightGrid.innerHTML = '';

    const playerList = Object.values(this.allPlayers).sort((a, b) => a.id - b.id);
    const half = Math.ceil(playerList.length / 2);

    const viewerWolfType = this.getViewerWolfType();
    const isNight = this.gameState.phase === 'NIGHT';

    // 判断当前玩家是否能看到狼队友标记
    const canSeeTeammate = (p) => {
      // 只有普通狼人能看到狼队友
      if (viewerWolfType !== 'regular') return false; 
      const hasRole = (player, role) => (player.originalIdentities || player.identities).some(x => x.role === role);
      return hasRole(p, '狼人');
    };

    const votesMap = this.fullGameData?.wolfVotes || {};
    const finalTarget = this.fullGameData?.nightActions?.[this.gameState.round]?.wolf?.target || null;

    // 判断一个玩家卡片是否可选
    const isSelectable = (p) => {
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

    // 创建单个玩家卡片的函数
    const makeCard = (p) => {
      const lives = 2 - p.deaths;
      const card = document.createElement('div');
      card.className = 'player-card';
      if (+this.playerId === +p.id) card.classList.add('me');
      if (!p.isAlive) card.classList.add('disabled');
      if (this.selection && !isSelectable(p)) card.classList.add('disabled');
      if (isSelected(p)) card.classList.add('selected');

      let wolfBadgesHtml = '';
      // [安全修复] 只有普通狼人(regular)才能看到投票角标和最终目标高亮
      if (viewerWolfType === 'regular' && isNight) {
          const voterIds = Object.entries(votesMap).filter(([, target]) => +target === +p.id).map(([wolfId]) => wolfId).sort((a, b) => a - b);
          wolfBadgesHtml = voterIds.map((wolfId, idx) => `<span class="wolf-corner" style="top:${idx * 16 + 4}px">${wolfId}</span>`).join('');
          if (finalTarget && +finalTarget === +p.id) card.classList.add('wolf-final-target');
      }

      const tags = [];
      if (canSeeTeammate(p)) tags.push('<span class="tag tag-team">队友</span>');
      if (p.isExposedIdiot) tags.push('<span class="tag tag-idiot">白痴</span>');

      card.innerHTML = `<div class="player-number">${p.id}${p.badge ? `<span class="sheriff-icon">👑</span>` : ''}</div><div class="tagline">${tags.join('')}</div><div class="hearts"><span class="heart ${lives < 1 ? 'off' : ''}">❤</span><span class="heart ${lives < 2 ? 'off' : ''}">❤</span></div>${wolfBadgesHtml}`;

      if (this.selection && isSelectable(p)) {
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
          const targetId = p.id.toString();
          if (this.selection.type === 'wolf-vote') {
            if (!this.canWolfAct(this.playerData) || this.gameState?.nightStatus?.wolf !== 'pending') { this.showNotification('当前不可投票', 'error'); return; }
            db.ref(`games/${this.gameId}/wolfVotes/${this.playerId}`).set(targetId);
            this.setSelection({ ...this.selection, targetId }); // 本地也更新以获得即时反馈
            this.showNotification(`已投票：${targetId}号`, 'success');
          } else {
            this.setSelection({ ...this.selection, targetId });
          }
        });
      }
      return card;
    };

    // 分配玩家到左右两列
    playerList.slice(0, half).forEach(p => leftGrid.appendChild(makeCard(p)));
    playerList.slice(half).forEach(p => rightGrid.appendChild(makeCard(p)));
  },

  /**
   * [已修复] 渲染中央核心操作面板。
   * 这是 UI 最复杂的部分，根据游戏阶段和玩家身份显示不同的操作选项。
   * 修复了女巫操作面板逻辑重复的 Bug。
   */
  renderActionPanel() {
    const panel = this.$('action-panel');
    panel.innerHTML = '';

    if (this.gameState.phase === 'GAME_OVER') {
        panel.innerHTML = `<div class="game-over-panel"><div class="game-over-icon">🏆</div><div class="game-over-text">游戏结束</div></div>`;
        return;
    }

    const isDead = !this.playerData.isAlive;
    const nightStatus = this.gameState.nightStatus || {};
    const role = this.getActiveRole(this.playerData);
    const isDayVotingOpen = !!this.fullGameData?.state?.dayVotingOpen;
    const actionInProgress = !!this.fullGameData.nightActions?.[this.gameState.round]?.[this.playerId]?.inProgress;

    // 辅助函数，生成信息提示和标准操作栏
    const info = (msg) => `<div class="action-feedback">${this.escapeHTML(msg)}</div>`;
    const bar = (title, { confirmText = '确认', skipText = '跳过', allowSkip = true, allowCancel = true } = {}) => {
        const targetText = this.selection?.targetId ? `${this.selection.targetId}号` : '未选择';
        return `<div class="action-bar"><div class="action-title">${this.escapeHTML(title)}</div><div class="action-target">当前目标：<strong>${targetText}</strong></div><div class="action-buttons"><button class="confirm-btn" data-action="confirm-selection" ${!this.selection?.targetId ? 'disabled' : ''}>${confirmText}</button>${allowSkip ? `<button class="control-btn" data-action="skip-selection">${skipText}</button>` : ''}${allowCancel ? `<button class="action-btn" data-action="cancel-selection">取消</button>` : ''}</div></div>`;
    };

    if (this.gameState.phase === 'SHERIFF_TRANSFER') {
        const transferState = this.gameState.postDeathState;
        if (transferState && this.playerId == transferState.deadSheriffId) {
            if (!this.selection || this.selection.type !== 'sheriff-pass') {
                this.setSelection({type: 'sheriff-pass'});
            }
            panel.innerHTML = bar('你已阵亡，请选择警徽移交对象', { allowSkip: true, skipText: '撕毁警徽' });
        } else panel.innerHTML = info('等待警长移交警徽...');
        return;
    }

    if (isDead) {
        if (this.gameState.phase === 'HUNTER_ACTION' && this.gameState.hunterQueue && this.gameState.hunterQueue[this.playerId]) {
            if (!this.selection || this.selection.type !== 'hunter') {
                this.setSelection({type: 'hunter'});
            }
            panel.innerHTML = bar('你是猎人，请选择带走的目标', { allowSkip: false, allowCancel: false });
        } else panel.innerHTML = `<div class="dead-panel"><div class="dead-icon">💀</div><div class="dead-text">你已出局</div></div>`;
        return;
    }

    if (this.gameState.phase === 'SHERIFF_CAND') {
        const myCand = this.fullGameData.sheriff?.candidates?.[this.playerId];
        const hasDropped = this.fullGameData.sheriff?.drops?.[this.playerId];
        if (hasDropped) { panel.innerHTML = info('你已退水，无法操作'); }
        else if (myCand !== undefined) { panel.innerHTML = info(`你已选择 ${myCand ? '上警' : '不上警'}`); }
        else { panel.innerHTML = `<div class="sheriff-choice"><div class="choice-title">是否参与警长竞选？</div><div class="choice-buttons"><button class="btn-primary" data-action="sheriff-cand" data-value="1">我要上警</button><button class="control-btn" data-action="sheriff-cand" data-value="0">不上警</button></div></div>`; }
        return;
    }

    if (this.gameState.phase === 'SHERIFF_SPEECH') {
        const candidates = this.fullGameData.sheriff?.candidates || {};
        const drops = this.fullGameData.sheriff?.drops || {};
        const runningCandidates = Object.keys(candidates).filter(id => candidates[id] && !drops[id]);
        let html = `<div class="candidate-info-box"><div class="candidate-info-title">👑 上警玩家</div><div class="candidate-list">${runningCandidates.length > 0 ? runningCandidates.map(id => `<span class="player-tag">${id}号</span>`).join('') : '<span style="color:var(--text-tertiary);">无</span>'}</div></div>`;
        if (candidates[this.playerId] && !drops[this.playerId]) {
            html += `<div class="drop-water" style="margin-top:16px;"><button class="action-btn" data-action="sheriff-drop">💧 退水</button></div>`;
        } else {
            html += info('等待主持人推进流程...');
        }
        panel.innerHTML = html;
        return;
    }

    if (this.gameState.phase === 'SHERIFF_VOTE') {
        if (this.playerData.isExposedIdiot) { panel.innerHTML = info('你是翻牌白痴，无法投票'); return; }
        const myVote = this.fullGameData.sheriff?.votes?.[this.playerId];
        if (myVote != null) { panel.innerHTML = info(`你已投票给 ${myVote === '0' ? '弃票' : myVote + '号'}`); }
        else { 
            if (!this.selection || this.selection.type !== 'sheriff-vote') this.setSelection({type: 'sheriff-vote'}); 
            panel.innerHTML = bar('为警长投票', { allowSkip: true, skipText: '弃票' }); 
        }
        return;
    }

    if (this.gameState.phase === 'DAY') {
        if (!isDayVotingOpen) {
            if (role === '骑士' && !this.getSkillState('hasUsedDuel')) {
                if (!this.selection || this.selection.type !== 'knight') this.setSelection({type: 'knight'});
                panel.innerHTML = bar('你是骑士，可在投票前发动决斗', { allowSkip: false, confirmText: '决斗', allowCancel: true });
            } else panel.innerHTML = info('等待主持人开启投票…');
        } else {
            if (this.playerData.isExposedIdiot) { panel.innerHTML = info('你是翻牌白痴，无法投票'); }
            else {
                const myVote = this.fullGameData.dayVotes?.[this.gameState.round]?.[this.playerId];
                if (myVote != null) { panel.innerHTML = info(`你已投票给 ${myVote === '0' ? '弃票' : myVote + '号'}`); }
                else { 
                    if (!this.selection || this.selection.type !== 'day-vote') this.setSelection({type: 'day-vote'});
                    panel.innerHTML = bar('放逐投票', { allowSkip: true, skipText: '弃票' }); 
                }
            }
        }
        return;
    }

    if (this.gameState.phase === 'NIGHT') {
        if (actionInProgress) { panel.innerHTML = info('操作已确认，等待天亮...'); return; }

        // [逻辑修复] 移除了重复的女巫逻辑块，只保留下面这个正确的版本。
        if (role === '女巫' && nightStatus.witch === 'pending') {
            const lifeIndex = this.playerData.deaths;
            const hasCure = !this.getSkillState('hasUsedCure', this.playerData, lifeIndex);
            const hasPoison = !this.getSkillState('hasUsedPoison', this.playerData, lifeIndex);
            const wolfTarget = this.fullGameData.nightActions?.[this.gameState.round]?.wolf?.target;
            const selectedTarget = this.selection?.targetId;

            // 确保选择类型正确
            if (!this.selection || this.selection.type !== 'witch-poison') {
                this.setSelection({ type: 'witch-poison' });
            }

            let html = `<div class="witch-panel"><div class="witch-status"><div class="potion-status"><span class="potion ${hasCure ? 'available' : ''}">💊 解药</span><span class="potion ${hasPoison ? 'available' : ''}">☠️ 毒药</span></div></div>`;
            html += `<div class="action-target" style="margin-top: 8px; text-align:center;">当前目标：<strong>${selectedTarget ? selectedTarget + '号' : '未选择'}</strong></div>`;
            html += '<div class="witch-actions-container" style="margin-top: 8px;">';

            if (hasCure && wolfTarget && wolfTarget !== '0') {
                const selfSaveRule = this.fullGameData.config?.witchSelfSaveRule || 'noFirstNightSelfSave';
                const isSelf = +wolfTarget === +this.playerId;
                const isFirstNight = this.gameState.round === 1;
                let canSave = true;
                if (isSelf && ((selfSaveRule === 'noFirstNightSelfSave' && isFirstNight) || (selfSaveRule === 'onlyFirstNightSelfSave' && !isFirstNight))) {
                    canSave = false;
                }
                html += `<button class="confirm-btn" data-action="witch-cure" data-target="${wolfTarget}" ${!canSave ? 'disabled' : ''}>💊 救 ${wolfTarget}号</button>`;
            }
            if (hasPoison) {
                html += `<button class="action-btn" data-action="confirm-selection" ${!selectedTarget ? 'disabled' : ''}>☠️ 使用毒药</button>`;
            }
            html += '</div>';

            if (!hasCure && !hasPoison) { html += info('本条命的药水已用尽'); }
            else if ((!wolfTarget || wolfTarget === '0') && !hasPoison) { html += info('今晚无人被刀，且无毒药可用'); }
            
            html += `</div>`;
            panel.innerHTML = html;
            return;
        }

        if (['狼人', '隐狼'].includes(role)) {
            if (nightStatus.wolf === 'pending') {
                const canAct = this.canWolfAct(this.playerData);
                if (!this.selection || this.selection.type !== 'wolf-vote') {
                    this.setSelection({type: 'wolf-vote'});
                }
                let wolfPanelHtml = `<div class="wolf-inline-panel"><div class="wolf-hint">${canAct ? '🎯 点击上方玩家卡片投票，或选择空刀' : '⏳ 等待同伴行动'}</div><div id="wolf-votes-display" class="wolf-votes-section"></div>`;
                if(canAct){
                    wolfPanelHtml += `<div class="wolf-actions" style="margin-top:8px;"><button class="control-btn" data-action="skip-selection">🔪 空刀</button></div>`;
                }
                // 只有普通狼人能看到聊天框
                if (role === '狼人') {
                    wolfPanelHtml += `<div id="wolf-chat-area" class="wolf-chat-section"><div id="wolf-chat-messages" class="chat-messages"></div><div class="chat-input-wrapper"><input id="wolf-chat-input" class="chat-input" placeholder="输入消息..." maxlength="120" /><button data-action="wolf-send" class="btn-send"><span>发送</span></button></div></div>`;
                }
                wolfPanelHtml += `</div>`;
                panel.innerHTML = wolfPanelHtml;
                this.initWolfListeners();
                return;
            } else {
                panel.innerHTML = info('狼队已确定目标，等待其他角色行动…');
                return;
            }
        }
        if (role === '守卫' && nightStatus.guard === 'pending') { 
            if (!this.selection || this.selection.type !== 'guard') this.setSelection({ type: 'guard' }); 
            panel.innerHTML = bar('守卫：请选择守护对象', { allowSkip: true, skipText: '空守' }); 
            return; 
        }
        if (role === '预言家' && nightStatus.seer === 'pending') { 
            if (!this.selection || this.selection.type !== 'seer') this.setSelection({ type: 'seer' }); 
            panel.innerHTML = bar(`预言家：请选择查验目标`, { allowSkip: true, skipText: '跳过' }); 
            return; 
        }
        
        panel.innerHTML = info('等待其他角色行动...');
        return;
    }

    panel.innerHTML = info('游戏进行中…');
  },

// ========================================
  // 玩家行动处理器
  // ========================================

  /**
   * 将本地的玩家选择状态写入 Firebase。
   * @param {object | null} selectionData - 要设置的选择数据，或 null 来清除
   */
  async setSelection(selectionData) {
    await db.ref(`games/${this.gameId}/playerSelections/${this.playerId}`).set(selectionData);
  },

  /**
   * 清除玩家在 Firebase 中的选择状态。
   */
  async clearSelection() {
    await db.ref(`games/${this.gameId}/playerSelections/${this.playerId}`).remove();
  },

  /**
   * “确认选择”按钮的统一处理函数。
   * 根据当前的选择类型，调用对应的技能函数。
   */
  async confirmSelection() {
    if (!this.selection || !this.selection.targetId) return;
    const targetId = this.selection.targetId;
    
    switch (this.selection.type) {
      case 'seer': await this.seerCheck(targetId); break;
      case 'guard': await this.guardProtect(targetId); break;
      case 'witch-poison': await this.witchUsePoison(targetId); break;
      case 'day-vote': await db.ref(`games/${this.gameId}/dayVotes/${this.gameState.round}/${this.playerId}`).set(targetId); this.showNotification(`已投票：${targetId}号`, 'success'); break;
      case 'knight': await this.knight(targetId); break;
      case 'hunter': await this.hunter(targetId); break;
      case 'sheriff-vote': await db.ref(`games/${this.gameId}/sheriff/votes/${this.playerId}`).set(targetId); this.showNotification(`已投警长票给：${targetId}号`, 'success'); break;
      case 'sheriff-pass': await this.playerPassBadge(targetId); break;
    }
    // 操作完成后清除选择状态
    await this.clearSelection();
  },

  /**
   * “跳过/弃票”按钮的统一处理函数。
   */
  async skipSelection() {
    if (!this.selection) return;
    switch (this.selection.type) {
        case 'seer': await this.seerSkip(); break;
        case 'guard': await this.guardSkip(); break;
        case 'witch-poison': await this.witchSkip(); break;
        case 'wolf-vote':
            if (!this.canWolfAct(this.playerData) || this.gameState?.nightStatus?.wolf !== 'pending') { this.showNotification('当前不可投票', 'error'); break; }
            await db.ref(`games/${this.gameId}/wolfVotes/${this.playerId}`).set('0'); // '0' 代表空刀或弃票
            this.showNotification('已选择空刀', 'success');
            break;
        case 'day-vote': await db.ref(`games/${this.gameId}/dayVotes/${this.gameState.round}/${this.playerId}`).set('0'); this.showNotification('已投弃票', 'info'); break;
        case 'sheriff-vote': await db.ref(`games/${this.gameId}/sheriff/votes/${this.playerId}`).set('0'); this.showNotification('已为警长投弃票', 'info'); break;
        case 'sheriff-pass': await this.playerDestroyBadge(); break; // 跳过移交警徽等于撕毁
    }
    await this.clearSelection();
  },

  // ========================================
  // 上帝视角与游戏状态管理
  // ========================================

  /**
   * 渲染上帝视角的界面。
   */
  renderGodView() {
    const list = this.$('god-player-list');
    list.innerHTML = '';
    // 格式化身份显示，区分普通身份和盗贼复制的身份
    const formatIdentity = (id) => `<span class="${id.isThiefCopy ? 'thief-copy' : ''}">${ROLES[id.role].icon} ${id.role}</span>`;

    Object.values(this.fullGameData.players || {}).sort((a, b) => a.id - b.id).forEach(p => {
      const lives = 2 - p.deaths;
      const identities = p.identities;
      const deaths = p.deaths;
      const row = document.createElement('div');
      row.className = `god-row ${!p.isAlive ? 'dead-all' : ''}`;
      row.innerHTML = `<div class="god-player-number"><span class="player-id">${p.id}号</span>${p.badge ? '<span class="sheriff-icon">👑</span>' : ''}</div><div class="god-identities"><span class="${deaths >= 1 ? 'dead-identity' : ''}">${formatIdentity(identities[0])}</span><span class="identity-plus">+</span><span class="${deaths >= 2 ? 'dead-identity' : ''}">${formatIdentity(identities[1])}</span></div><div class="god-hearts"><span class="life-heart ${lives < 1 ? 'lost' : ''}">❤</span><span class="life-heart ${lives < 2 ? 'lost' : ''}">❤</span></div>`;
      list.appendChild(row);
    });

    // 渲染包含所有公开和秘密日志的上帝日志区
    const godLog = this.$('god-log-content');
    godLog.innerHTML = '';
    const logs = Object.values(this.fullGameData.logs || {}).sort((a, b) => a.timestamp - b.timestamp);
    if (logs.length === 0) {
      godLog.innerHTML = '<div class="log-empty">暂无日志</div>';
    }
    logs.forEach(log => {
      const div = document.createElement('div');
      div.className = 'log-item';
      if (log.isSecret) div.classList.add('log-secret'); // 秘密日志使用特殊样式
      const prefix = log.round > 0 ? `<span class="log-round">[第${log.round}轮]</span> ` : '';
      div.innerHTML = prefix + this.escapeHTML(log.message);
      godLog.appendChild(div);
    });
    godLog.scrollTop = godLog.scrollHeight;
  },

  /**
   * 更新游戏阶段，并根据新阶段重置相关状态。
   * @param {string} phase - 新的游戏阶段
   * @param {number | null} round - 可选，要设置的回合数
   */
  async updatePhase(phase, round = null) {
      const updates = { 'state/phase': phase };
      if (round !== null) updates['state/round'] = round;
      else if (phase === 'NIGHT') updates['state/round'] = this.gameState.round + 1;

      // 进入夜晚时，重置所有夜间状态
      if (phase === 'NIGHT') {
          updates['nightActions'] = {}; updates['wolfVotes'] = {}; updates['wolfChat'] = {}; updates['playerSelections'] = {};
          const alivePlayers = Object.values(this.allPlayers).filter(p => p.isAlive);
          const roleExists = (role) => alivePlayers.some(p => this.getActiveRole(p) === role);
          const witch = alivePlayers.find(p => this.getActiveRole(p) === '女巫');
          const witchLifeIndex = witch ? witch.deaths : -1;
          const canWitchAct = witch && (!this.getSkillState('hasUsedCure', witch, witchLifeIndex) || !this.getSkillState('hasUsedPoison', witch, witchLifeIndex));
          
          const status = { 
              guard: roleExists('守卫') ? 'pending' : 'complete', 
              seer: roleExists('预言家') ? 'pending' : 'complete', 
              wolf: this.isAnyWolfInGame() ? 'pending' : 'complete', 
              witch: canWitchAct ? 'locked' : 'complete' // 女巫初始为锁定，等待狼人行动后解锁
          };
          // 如果狼人一开始就行动完成（比如没狼了），则直接解锁女巫
          if (status.wolf === 'complete' && status.witch === 'locked') status.witch = 'pending';
          updates['state/nightStatus'] = status;
      }
      // 进入白天时，重置投票状态和选择
      if (phase === 'DAY') { updates['state/dayVotingOpen'] = false; updates['playerSelections'] = {}; }
      // 开始上警时，清空上一轮的警长相关数据
      if (phase === 'SHERIFF_CAND') { updates['sheriff'] = { candidates: {}, drops: {}, votes: {} }; }
      
      await db.ref(`games/${this.gameId}`).update(updates);
  },

  // ========================================
  // 角色技能实现
  // ========================================

  async guardProtect(id) { await this.setNightAction({ target: id }); await this.addGameLog(`🛡️ 守卫(${this.playerId}号)守护了 ${id}号`, true); await db.ref(`games/${this.gameId}/state/nightStatus/guard`).set('complete'); await this.setSkillState('lastGuardTarget', id); this.showNotification(`你守护了 ${id}号`, 'success'); },
  async guardSkip() { await this.setNightAction({ target: null, skipped: true }); await this.addGameLog(`🛡️ 守卫(${this.playerId}号)空守`, true); await db.ref(`games/${this.gameId}/state/nightStatus/guard`).set('complete'); await this.setSkillState('lastGuardTarget', null); this.showNotification('你选择了空守', 'info'); },

  async seerCheck(id) {
    const mode = this.fullGameData.config?.seerMode || 'faction';
    let result = '';
    if (mode === 'faction') {
      const targetPlayer = this.allPlayers[id];
      const hasRegularWolf = (targetPlayer.identities || []).some(x => x.role === '狼人');
      result = hasRegularWolf ? '狼人' : '好人'; // 隐狼查验为好人
    } else {
      result = this.getActiveRole(this.allPlayers[id]) || '未知';
    }
    await this.setNightAction({ target: id, result });
    await db.ref(`games/${this.gameId}/state/nightStatus/seer`).set('complete');
    await this.addGameLog(`🔮 预言家(${this.playerId}号)查验 ${id}号，结果为 ${result}`, true);
    const records = this.getGlobalSkillState('seerResults') || {}; records[id] = result; await this.setGlobalSkillState('seerResults', records);
    this.showNotification(`查验结果：${id}号 → ${result}`, 'success');
  },
  async seerSkip() { await this.setNightAction({ target: null, skipped: true }); await db.ref(`games/${this.gameId}/state/nightStatus/seer`).set('complete'); await this.addGameLog(`🔮 预言家(${this.playerId}号)跳过查验`, true); this.showNotification('你跳过了查验', 'info'); },

  async witchTryCure(targetId) {
    const round = this.gameState.round;
    const actionRef = db.ref(`games/${this.gameId}/nightActions/${round}/${this.playerId}`);
    
    // 使用事务确保操作的原子性，防止重复用药
    const trx = await actionRef.transaction(currentData => {
        if (currentData && currentData.inProgress) return; // 如果已有操作，则中止
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
  async witchSkip() { await this.setNightAction({ skipped: true }); await db.ref(`games/${this.gameId}/state/nightStatus/witch`).set('complete'); await this.addGameLog(`🧪 女巫(${this.playerId}号)未使用药水`, true); this.showNotification('你选择不使用药水', 'info'); },

  async knight(id) {
    await this.setSkillState('hasUsedDuel', true);
    const targetRole = this.getActiveRole(this.allPlayers[id]);
    const isTargetEvil = ['狼人', '隐狼'].includes(targetRole);
    const loserId = isTargetEvil ? id : this.playerId;
    const loserRole = isTargetEvil ? targetRole : this.getActiveRole(this.playerData);
    
    await this.addGameLog(`⚔️ 骑士 ${this.playerId}号 对 ${id}号 发动决斗！`, false);
    const deathResult = await this.kill(loserId, 'DUEL');
    
    // [修复] 决斗结果公开日志
    if (isTargetEvil) {
        await this.addGameLog(`决斗成功！${loserId}号(${loserRole}) 阵亡。游戏直接进入夜晚。`, false);
        await this.handlePostDeath({ ...deathResult, nextPhaseIfNoAction: 'NIGHT' });
    } else {
        await this.addGameLog(`决斗失败！骑士 ${loserId}号 阵亡。发言继续。`, false);
        await this.handlePostDeath({ ...deathResult, nextPhaseIfNoAction: 'DAY' });
    }
  },

  async hunter(id) {
    await this.addGameLog(`🔫 猎人 ${this.playerId}号 开枪带走了 ${id}号！`, false);
    await db.ref(`games/${this.gameId}/state/hunterQueue/${this.playerId}`).set(null); // 从队列中移除自己
    const deathResult = await this.kill(id, 'HUNTER');
    
    if (deathResult.sheriffDied) return; // 如果警长死亡，则进入移交阶段，暂停后续流程
    
    const remainingQueue = (await db.ref(`games/${this.gameId}/state/hunterQueue`).once('value')).val() || {};
    if (Object.values(remainingQueue).some(v => v === true)) {
        // 如果还有其他猎人需要开枪
        await this.updatePhase('HUNTER_ACTION');
    } else {
        // 所有枪都开完，根据死亡前的状态决定去白天还是黑夜
        const nextPhase = this.gameState.postDeathState?.nextPhase || (this.gameState.phase === 'DAY' ? 'NIGHT' : 'DAY');
        if (!this.gameState.postDeathState || !this.gameState.postDeathState.deadSheriffId) {
            await db.ref(`games/${this.gameId}/state/postDeathState`).set(null);
        }
        await this.updatePhase(nextPhase);
    }
  },

  // ========================================
  // 狼人专属逻辑
  // ========================================

  getViewerWolfType() {
    if (!this.playerData) return null;
    const hasRole = (role) => (this.playerData.originalIdentities || this.playerData.identities).some(x => x.role === role);
    if (hasRole('狼人')) return 'regular';
    if (hasRole('隐狼')) return 'hidden';
    return null;
  },
  canWolfAct(p) {
    const role = this.getActiveRole(p);
    if (role === '狼人') return true;
    if (role === '隐狼') {
      // 隐狼只有在所有普通狼人都死亡后才能行动
      const livingRegularWolves = Object.values(this.allPlayers).filter(pp => pp.isAlive && this.getActiveRole(pp) === '狼人');
      return livingRegularWolves.length === 0;
    }
    return false;
  },
  getAlphaWolfId() {
    // 拍板狼是场上存活的、ID最小的普通狼人；若无普通狼人，则是ID最小的隐狼
    const livingRegularWolves = Object.values(this.allPlayers).filter(p => p.isAlive && this.getActiveRole(p) === '狼人');
    if (livingRegularWolves.length > 0) return Math.min(...livingRegularWolves.map(p => p.id)).toString();
    const livingInvisibleWolves = Object.values(this.allPlayers).filter(p => p.isAlive && this.getActiveRole(p) === '隐狼');
    if (livingInvisibleWolves.length > 0) return Math.min(...livingInvisibleWolves.map(p => p.id)).toString();
    return null;
  },
  initWolfListeners() {
    this.stopWolfListeners(false); // 启动前先停止旧的，以防万一
    const myType = this.getViewerWolfType(); if (!myType) return;

    // 监听投票变化
    this.wolfVotesCallbackRef = (snap) => {
      const votes = snap.val() || {};
      const alphaWolfId = this.getAlphaWolfId();
      const display = this.$('wolf-votes-display'); if (!display) return;

      let voters = Object.values(this.allPlayers).filter(p => p.isAlive && this.getActiveRole(p) === '狼人');
      if (voters.length === 0) { voters = Object.values(this.allPlayers).filter(p => p.isAlive && this.getActiveRole(p) === '隐狼'); }

      let html = '<div class="wolf-vote-title">🗳️ 投票情况</div><div class="wolf-vote-list">';
      voters.sort((a, b) => a.id - b.id).forEach(w => {
        const vote = votes[w.id]; const voteText = vote != null ? (vote === '0' ? '空刀' : `${vote}号`) : '未投票';
        const isAlpha = (alphaWolfId && w.id.toString() === alphaWolfId);
        html += `<div class="wolf-vote-item"><span class="voter">${w.id}号 ${isAlpha ? '<span class="alpha-badge">拍板</span>' : ''}</span><span class="vote-arrow">→</span><span class="vote-target ${vote != null ? 'voted' : ''}">${voteText}</span></div>`;
      });
      html += '</div>';
      // 如果当前玩家是拍板狼，且已投票，则显示确认按钮
      if (this.playerId === alphaWolfId && votes[alphaWolfId] != null && this.gameState?.nightStatus?.wolf === 'pending') {
        const target = votes[alphaWolfId];
        html += `<div class="wolf-confirm-section"><button class="confirm-btn wolf-confirm-btn" data-action="wolf-confirm" data-value="${target}">🎯 确认袭击 ${target === '0' ? '空刀' : target + '号'}</button></div>`;
      }
      display.innerHTML = html;
    };
    this.wolfVotesListener = db.ref(`games/${this.gameId}/wolfVotes`);
    this.wolfVotesListener.on('value', this.wolfVotesCallbackRef);

    // 只有普通狼人能使用狼人聊天
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
      
      const chatInput = this.$('wolf-chat-input');
      if (chatInput) {
        // [修复] 为输入框绑定回车键发送事件
        const newChatInput = chatInput.cloneNode(true);
        chatInput.parentNode.replaceChild(newChatInput, chatInput);
        newChatInput.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.sendWolfMessage();
          }
        });
      }
    }
  },
  stopWolfListeners(hide = true) {
    if (this.wolfVotesListener && this.wolfVotesCallbackRef) { db.ref(`games/${this.gameId}/wolfVotes`).off('value', this.wolfVotesCallbackRef); this.wolfVotesListener = null; this.wolfVotesCallbackRef = null; }
    if (this.wolfChatListener) { db.ref(`games/${this.gameId}/wolfChat`).off('child_added', this.wolfChatListener); this.wolfChatListener = null; }
  },
  async wolfConfirmKill(btn) {
    // [修复] 增加客户端操作锁定，防止重复提交
    btn.disabled = true;
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';
    const targetId = btn.dataset.value;

    const alphaWolfId = this.getAlphaWolfId();
    if (this.playerId !== alphaWolfId || !this.canWolfAct(this.playerData) || this.gameState?.nightStatus?.wolf !== 'pending') {
        this.showNotification('你无权确认或当前不可确认', 'error');
        btn.disabled = false; btn.innerHTML = originalText;
        return;
    }
    
    // 使用事务确保只有一个狼人能成功确认刀口
    const ref = db.ref(`games/${this.gameId}/nightActions/${this.gameState.round}/wolf`);
    const trx = await ref.transaction(cur => {
        if (cur) return; // 如果已有数据，则中止
        return { target: targetId, actorId: this.playerId };
    });

    if (trx.committed) {
        await this.addGameLog(`🐺 狼队决定袭击 ${targetId === '0' ? '空刀' : targetId + '号'} (由${this.playerId}号确认)`, true);
        // 更新狼人行动状态，并解锁女巫
        await db.ref(`games/${this.gameId}/state/nightStatus`).transaction(st => { if (!st) return st; st.wolf = 'complete'; if (st.witch === 'locked') st.witch = 'pending'; return st; });
        this.showNotification(`已确认袭击 ${targetId === '0' ? '空刀' : targetId + '号'}`, 'success');
        await this.clearSelection();
    } else {
        this.showNotification('确认失败：已有其他狼人确认刀口', 'error');
        btn.disabled = false; btn.innerHTML = originalText;
    }
  },
  sendWolfMessage() {
    const type = this.getViewerWolfType(); if (type !== 'regular') { this.showNotification('你无法在狼窝发言', 'error'); return; }
    const input = this.$('wolf-chat-input'); const msg = (input.value || '').trim(); if (!msg) return; if (msg.length > 120) { this.showNotification('消息过长', 'error'); return; }
    db.ref(`games/${this.gameId}/wolfChat`).push({ pid: this.playerId, msg, ts: firebase.database.ServerValue.TIMESTAMP }); input.value = '';
  },

  // ========================================
  // 投票与死亡处理
  // ========================================

  async hostEnterSheriffVote() {
    const cand = this.fullGameData.sheriff?.candidates || {}, drops = this.fullGameData.sheriff?.drops || {};
    const valid = Object.keys(cand).filter(id => cand[id] && !drops[id]);
    if (valid.length === 1) { // 独狼直接当选
      const sheriffId = valid[0]; await db.ref(`games/${this.gameId}/players/${sheriffId}/badge`).set(1);
      await this.addGameLog(`👑 ${sheriffId}号独警，直接当选警长！`, false);
      if (this.gameState.round === 1) await this.processNight(); else await this.updatePhase('DAY');
    } else {
      await this.updatePhase('SHERIFF_VOTE');
    }
  },
  async hostSheriffElectSingle() {
    const cand = this.fullGameData.sheriff?.candidates || {}, drops = this.fullGameData.sheriff?.drops || {};
    const valid = Object.keys(cand).filter(id => cand[id] && !drops[id]);
    if (valid.length === 1) {
      const sheriffId = valid[0]; await db.ref(`games/${this.gameId}/players/${sheriffId}/badge`).set(1);
      await this.addGameLog(`👑 ${sheriffId}号独警，直接当选警长！`, false);
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
    const maxVotes = Object.keys(counts).length ? Math.max(...Object.values(counts)) : 0;
    const winners = Object.keys(counts).filter(id => counts[id] === maxVotes);
    if (winners.length === 1) {
      const sheriffId = winners[0]; await db.ref(`games/${this.gameId}/players/${sheriffId}/badge`).set(1);
      await this.addGameLog(`👑 ${sheriffId}号当选警长！`, false);
      if (this.gameState.round === 1) await this.processNight(); else await this.updatePhase('DAY');
    } else {
      const isPKRound = this.fullGameData.sheriff?.isPKRound;
      if (isPKRound) {
          await this.addGameLog('⚖️ PK后再次平票，本轮无警长。', false);
          await db.ref(`games/${this.gameId}/sheriff`).set(null);
          if (this.gameState.round === 1) await this.processNight(); else await this.updatePhase('DAY');
          return;
      }
      await this.addGameLog(winners.length > 1 ? `⚖️ 平票：${winners.join('、')}号，进入PK环节。` : '⚖️ 无人当选警长。', false);
      const newCandidates = {}; if (winners.length > 1) winners.forEach(id => newCandidates[id] = 1);
      await db.ref(`games/${this.gameId}/sheriff`).set({ candidates: newCandidates, drops: {}, votes: {}, isPKRound: true });
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
      Object.entries(votes).forEach(([voterId, targetId]) => {
          if (targetId !== '0') {
              // [修复] 调整投票权重：警长3票，普通2票
              const weight = (voterId == sheriffId) ? 3 : 2;
              counts[targetId] = (counts[targetId] || 0) + weight;
          }
      });
      const maxVotes = Object.keys(counts).length ? Math.max(...Object.values(counts)) : 0;
      const outPlayerIds = Object.keys(counts).filter(id => counts[id] === maxVotes);
      if (outPlayerIds.length === 1) {
          const id = outPlayerIds[0];
          await this.addGameLog(`⚖️ ${id}号以 ${counts[id]} 票被放逐。`, false);
          const deathResult = await this.kill(id, 'VOTE'); await this.handlePostDeath({ ...deathResult, nextPhaseIfNoAction: 'NIGHT' });
      } else {
          await this.addGameLog(outPlayerIds.length > 1 ? `⚖️ 平票：${outPlayerIds.join('、')}号。无人出局。` : '⚖️ 无人出局。', false);
          await this.updatePhase('NIGHT');
      }
  },

  async playerPassBadge(toId) {
    const state = this.gameState.postDeathState || {};
    if (this.playerId != state.deadSheriffId) { this.showNotification('你无权操作警徽', 'error'); return; }
    const updates = { [`players/${state.deadSheriffId}/badge`]: 0, [`players/${toId}/badge`]: 1, 'state/postDeathState': null };
    await db.ref(`games/${this.gameId}`).update(updates);
    await this.addGameLog(`👑 警徽已由 ${state.deadSheriffId}号 移交给 ${toId}号。`, false);
    await this.handlePostDeath({ hunterTriggered: state.hunterTriggered, sheriffDied: false, nextPhaseIfNoAction: state.nextPhase });
  },
  async playerDestroyBadge(isForced = false) {
    const state = this.gameState.postDeathState || {};
    if (!isForced && this.playerId != state.deadSheriffId) { this.showNotification('你无权操作警徽', 'error'); return; }
    const updates = { [`players/${state.deadSheriffId}/badge`]: 0, 'state/postDeathState': null };
    await db.ref(`games/${this.gameId}`).update(updates);
    await this.addGameLog(`💔 警徽已被 ${state.deadSheriffId}号 撕毁。`, false);
    await this.handlePostDeath({ hunterTriggered: state.hunterTriggered, sheriffDied: false, nextPhaseIfNoAction: state.nextPhase });
  },

  /**
   * [已修复] 统一处理死亡后的连锁事件（猎人开枪、警长移交、胜负判断）。
   */
  async handlePostDeath({ hunterTriggered, sheriffDied, nextPhaseIfNoAction = 'DAY' }) {
    await this.addGameLog(`[系统] 死亡后检查: 猎人开枪=${hunterTriggered}, 警长死亡=${sheriffDied}`, true);
    if (sheriffDied) return; // 如果警长死亡，流程会进入移交阶段，此处暂停
    if (await this.checkWin()) return; // 检查游戏是否结束

    const queue = (await db.ref(`games/${this.gameId}/state/hunterQueue`).once('value')).val() || {};
    if (Object.values(queue).some(v => v === true)) {
      await this.addGameLog(`[系统] 检测到猎人队列，进入开枪阶段。`, true);
      // 保存下一步应该进入的阶段，以便猎人开完枪后继续
      await db.ref(`games/${this.gameId}/state/postDeathState`).transaction(v => { v = v || {}; v.nextPhase = nextPhaseIfNoAction; return v; });
      await this.updatePhase('HUNTER_ACTION');
    } else if (nextPhaseIfNoAction) {
      await this.addGameLog(`[系统] 无特殊死亡事件，进入下一阶段: ${nextPhaseIfNoAction}`, true);
      await this.updatePhase(nextPhaseIfNoAction);
    }
  },
  
  /**
   * [已修复] 处理玩家死亡的核心逻辑。
   * @param {string} pid - 死亡玩家的ID
   * @param {string} cause - 死亡原因
   * @returns {Promise<object>} - 返回一个包含死亡结果的对象
   */
  async kill(pid, cause) {
      await this.addGameLog(`[系统] 正在处理 ${pid}号 的死亡事件，原因: ${cause}`, true);
      let result = { hunterTriggered: false, sheriffDied: false };
      const playerBefore = this.allPlayers[pid]; if (!playerBefore || !playerBefore.isAlive) return result;
      const roleBefore = this.getActiveRole(playerBefore);
      let idiotFlipped = false;
      
      const trx = await db.ref(`games/${this.gameId}/players/${pid}`).transaction(p => {
          if (!p || !p.isAlive) return p;
          const lifeIndex = p.deaths;
          // 白痴被投票出局，第一次是翻牌免死
          if (cause === 'VOTE' && p.identities[lifeIndex]?.role === '白痴' && !p.isExposedIdiot) {
              p.isExposedIdiot = true;
              idiotFlipped = true;
              // 白痴不增加死亡计数
          } else {
              p.deaths = Math.min(p.deaths + 1, 2);
          }
          if (p.deaths >= 2) p.isAlive = false;
          return p;
      });

      if (!trx.committed) return result;
      if (idiotFlipped) {
        await this.addGameLog(`🤪 ${pid}号被投票出局，翻开白痴身份，本轮免于死亡！`, false);
        // 因为白痴没死，所以直接返回，不触发后续死亡逻辑
        return result;
      }
      
      const playerAfter = trx.snapshot.val();
      const wasSheriff = playerBefore.badge;
      const isNowDead = !playerAfter.isAlive;
      const willTriggerHunter = roleBefore === '猎人' && (['NIGHT', 'VOTE', 'POISON', 'DUEL'].includes(cause));

      if (willTriggerHunter) {
          await db.ref(`games/${this.gameId}/state/hunterQueue/${pid}`).set(true);
          result.hunterTriggered = true;
          await this.addGameLog(`[系统] ${pid}号是猎人，已加入开枪队列。`, true);
      }
      if (isNowDead && wasSheriff) {
          const nextPhase = (cause === 'DAY' || cause === 'VOTE' || cause === 'DUEL') ? 'NIGHT' : 'DAY';
          await db.ref(`games/${this.gameId}/state`).update({ phase: 'SHERIFF_TRANSFER', postDeathState: { deadSheriffId: pid, hunterTriggered: result.hunterTriggered, nextPhase: nextPhase } });
          result.sheriffDied = true;
          await this.addGameLog(`[系统] ${pid}号是警长且已死亡，进入警徽移交阶段。`, true);
      }
      await this.checkWin();
      return result;
  },

  async processNight() {
    await this.addGameLog('🌙 天亮了。', false);
    const nightActions = this.fullGameData.nightActions?.[this.gameState.round] || {};
    const deaths = [];

    const wolfAction = nightActions.wolf;
    const guardAction = Object.values(nightActions).find(a => a.target !== undefined && a.actorId && this.getActiveRole(this.allPlayers[a.actorId]) === '守卫');
    const witchAction = Object.values(nightActions).find(a => (a.cure || a.poison) && a.actorId && this.getActiveRole(this.allPlayers[a.actorId]) === '女巫');
    
    const wolfTarget = wolfAction?.target;
    const guardTarget = guardAction?.target;
    const cureTarget = witchAction?.cure;
    const poisonTarget = witchAction?.poison;

    if (wolfTarget && wolfTarget !== '0') {
      const isGuarded = guardTarget === wolfTarget;
      const isCured = cureTarget === wolfTarget;
      if (isGuarded) await this.addGameLog(`🛡️ 守卫成功守护了 ${wolfTarget}号`, true);
      if (isCured) await this.addGameLog(`🧪 女巫使用解药救活了 ${wolfTarget}号`, true);
      if (!isGuarded && !isCured) deaths.push({ pid: wolfTarget, cause: 'NIGHT' });
    }
    if (poisonTarget && !deaths.some(d => d.pid === poisonTarget)) {
      deaths.push({ pid: poisonTarget, cause: 'POISON' });
      await this.addGameLog(`🧪 女巫使用毒药杀害了 ${poisonTarget}号`, true);
    }

    let anyHunterTriggered = false, anySheriffDied = false;
    if (deaths.length > 0) {
      const deadIds = [...new Set(deaths.map(d => d.pid))].sort((a, b) => a - b).join('号、');
      await this.addGameLog(`昨夜死亡的玩家是：${deadIds}号`, false);
      await db.ref(`games/${this.gameId}/state/peaceNightStreak`).set(0);
      for (const d of deaths) {
        const r = await this.kill(d.pid, d.cause);
        if (r.hunterTriggered) anyHunterTriggered = true;
        if (r.sheriffDied) { anySheriffDied = true; break; }
      }
    } else {
      await this.addGameLog('昨夜是平安夜。', false);
      const streak = (this.gameState.peaceNightStreak || 0) + 1;
      await db.ref(`games/${this.gameId}/state/peaceNightStreak`).set(streak);
    }
    await this.handlePostDeath({ hunterTriggered: anyHunterTriggered, sheriffDied: anySheriffDied, nextPhaseIfNoAction: 'DAY' });
  },

  async checkWin() {
    await new Promise(r => setTimeout(r, 100)); // 短暂延迟确保状态更新
    const snap = await db.ref(`games/${this.gameId}`).once('value'); if (!snap.exists()) return false;
    const g = snap.val(); if (g.state.phase === 'GAME_OVER') return true;
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
      const winMode = g.config?.wolfWin || 'edge';
      if (winMode === 'exterminate') { // 屠城
        const allGoodsDead = goodPlayers.length > 0 && goodPlayers.every(p => !p.isAlive);
        if (allGoodsDead) winner = '游戏结束 - 狼人阵营胜利！(屠城：好人全灭)';
      } else { // 屠边
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

  // ========================================
  // 辅助函数
  // ========================================

  getActiveRole(p) { if (!p || !p.isAlive) return null; if (p.deaths >= p.identities.length) return null; const cur = p.identities[p.deaths]; return cur ? cur.role : null; },
  isAnyWolfInGame() { return Object.values(this.allPlayers).some(p => p.isAlive && ['狼人', '隐狼'].includes(this.getActiveRole(p))); },
  getSkillState(key, player = null, idx = -1) { const p = player || this.playerData; if (!p) return undefined; const i = idx !== -1 ? idx : p.deaths; return (p.skillStates || {})[`${i}_${key}`]; },
  async setSkillState(key, value) { const i = this.playerData.deaths; await db.ref(`games/${this.gameId}/players/${this.playerId}/skillStates/${i}_${key}`).set(value); },
  getGlobalSkillState(key) { return (this.playerData?.skillStates || {})[`global_${key}`]; },
  async setGlobalSkillState(key, val) { await db.ref(`games/${this.gameId}/players/${this.playerId}/skillStates/global_${key}`).set(val); },
  async setNightAction(data) {
    const round = this.gameState.round;
    const actionRef = db.ref(`games/${this.gameId}/nightActions/${round}/${this.playerId}`);
    await actionRef.set({ ...data, actorId: this.playerId, inProgress: true });
  }
};

// 将 App 对象暴露到全局作用域，以便在 HTML 中调用
window.App = App;
// 当 DOM 加载完成后，启动应用
document.addEventListener('DOMContentLoaded', () => App.init());
