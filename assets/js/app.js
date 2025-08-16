/**
 * 双身份狼人杀 - 核心引擎 (重构版)
 * 按照游戏规则文档完整实现
 */

// ==================== 常量定义 ====================
const ROLES = {
  '平民': { faction: 'good', icon: '👤', isGod: false },
  '预言家': { faction: 'good', icon: '🔮', isGod: true },
  '女巫': { faction: 'good', icon: '🧪', isGod: true },
  '守卫': { faction: 'good', icon: '🛡️', isGod: true },
  '猎人': { faction: 'good', icon: '🔫', isGod: true },
  '骑士': { faction: 'good', icon: '⚔️', isGod: true },
  '白痴': { faction: 'good', icon: '🤪', isGod: true },
  '狼人': { faction: 'bad', icon: '🐺', isGod: false },
  '隐狼': { faction: 'bad', icon: '🌑', isGod: false, isHidden: true },
  '盗贼': { faction: 'neutral', icon: '🎭', isGod: false, isThief: true }
};

const PHASES = {
  SETUP: 'SETUP',
  LOBBY: 'LOBBY',
  NIGHT: 'NIGHT',
  DAWN: 'DAWN',
  SHERIFF_ELECTION: 'SHERIFF_ELECTION',
  DAY: 'DAY',
  VOTE: 'VOTE',
  DUEL: 'DUEL',
  HUNTER: 'HUNTER',
  BADGE: 'BADGE',
  GAME_OVER: 'GAME_OVER'
};

const FORBIDDEN_PAIRS = [
  ['狼人', '盗贼'],
  ['狼人', '隐狼'],
  ['预言家', '狼人'],
  ['预言家', '隐狼'],
  ['盗贼', '隐狼']
];

// ==================== Firebase配置 ====================
const firebaseConfig = {
  apiKey: "AIzaSyCEAgB6DoY8YA6lZnYblhIDVTYH_q8UimI",
  authDomain: "werewolf-game-master-1f37f.firebaseapp.com",
  databaseURL: "https://werewolf-game-master-1f37f-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "werewolf-game-master-1f37f",
  storageBucket: "werewolf-game-master-1f37f.appspot.com",
  messagingSenderId: "626014452910",
  appId: "1:626014452910:web:35b6eba412f95f1878013f"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();

// ==================== 工具函数 ====================
const $ = id => document.getElementById(id);
const $$ = selector => document.querySelectorAll(selector);

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateGameId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ==================== 发牌系统 ====================
class CardDealer {
  static deal(rolePool) {
    if (rolePool.length === 0 || rolePool.length % 2 !== 0) {
      throw new Error('身份总数必须为偶数且大于0');
    }

    const maxAttempts = 10000;
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const shuffled = shuffle(rolePool);
      const pairs = [];
      let valid = true;
      let hasGoldenBaby = false;

      // 生成配对
      for (let i = 0; i < shuffled.length; i += 2) {
        const role1 = shuffled[i];
        const role2 = shuffled[i + 1];

        // 检查禁止组合
        if (this.isForbiddenPair(role1, role2)) {
          valid = false;
          break;
        }

        // 检查金宝宝
        if (role1 === '平民' && role2 === '平民') {
          hasGoldenBaby = true;
        }

        // 处理盗贼复制
        let identity1, identity2;
        if (role1 === '盗贼') {
          identity1 = { role: role2, isCopy: true };
          identity2 = { role: role2, isCopy: false };
          if (role2 === '平民') hasGoldenBaby = true;
        } else if (role2 === '盗贼') {
          identity1 = { role: role1, isCopy: false };
          identity2 = { role: role1, isCopy: true };
          if (role1 === '平民') hasGoldenBaby = true;
        } else {
          identity1 = { role: role1, isCopy: false };
          identity2 = { role: role2, isCopy: false };
        }

        pairs.push(Math.random() < 0.5 ? [identity1, identity2] : [identity2, identity1]);
      }

      // 必须有金宝宝
      if (valid && hasGoldenBaby) {
        return shuffle(pairs);
      }
    }

    throw new Error('无法生成合法的牌组（需要至少一个金宝宝且满足禁止组合规则）');
  }

  static isForbiddenPair(role1, role2) {
    for (const [a, b] of FORBIDDEN_PAIRS) {
      if ((role1 === a && role2 === b) || (role1 === b && role2 === a)) {
        return true;
      }
    }
    return false;
  }
}

// ==================== 游戏引擎 ====================
class GameEngine {
  constructor(gameId) {
    this.gameId = gameId;
    this.gameRef = db.ref(`games/${gameId}`);
  }

  async getGameData() {
    const snapshot = await this.gameRef.once('value');
    return snapshot.val();
  }

  async updateGame(updates) {
    return this.gameRef.update(updates);
  }

  async log(message, isSecret = false) {
    const gameData = await this.getGameData();
    const logEntry = {
      message,
      round: gameData.state.round || 0,
      timestamp: firebase.database.ServerValue.TIMESTAMP,
      secret: isSecret
    };
    return this.gameRef.child('logs').push(logEntry);
  }

  // 获取玩家当前活跃身份
  getActiveRole(player) {
    if (!player || !player.isAlive) return null;
    const deathCount = player.deaths || 0;
    return player.identities[deathCount]?.role || null;
  }

  // 检查隐狼是否激活
  async checkHiddenWolfActivation() {
    const gameData = await this.getGameData();
    const players = Object.values(gameData.players);
    const mode = gameData.settings.hiddenActivation;

    if (mode === 'noWolfCardAlive') {
      // 检查是否还有狼人牌存活（不包括隐狼）
      return !players.some(p => 
        p.isAlive && p.identities.some(id => id.role === '狼人')
      );
    } else {
      // 检查是否还有活跃狼人
      return !players.some(p => 
        p.isAlive && this.getActiveRole(p) === '狼人'
      );
    }
  }

  // 获取可行动狼人
  async getActingWolves() {
    const gameData = await this.getGameData();
    const hiddenActive = gameData.state.hiddenWolfActive || false;
    
    return Object.values(gameData.players).filter(p => {
      if (!p.isAlive) return false;
      const role = this.getActiveRole(p);
      return role === '狼人' || (role === '隐狼' && hiddenActive);
    });
  }

  // 处理玩家死亡
  async killPlayer(playerId, cause) {
    const gameData = await this.getGameData();
    const player = gameData.players[playerId];
    
    if (!player || !player.isAlive) return { success: false };

    const activeRole = this.getActiveRole(player);
    const newDeaths = (player.deaths || 0) + 1;
    const isOut = newDeaths >= 2;

    const updates = {
      [`players/${playerId}/deaths`]: newDeaths,
      [`players/${playerId}/isAlive`]: !isOut
    };

    let triggerHunter = false;
    let sheriffDied = false;

    // 白痴翻牌（仅投票）
    if (activeRole === '白痴' && cause === 'VOTE' && !player.isExposedIdiot) {
      updates[`players/${playerId}/isExposedIdiot`] = true;
      updates[`players/${playerId}/isAlive`] = true;
      updates[`players/${playerId}/deaths`] = Math.min(newDeaths, 1);
      await this.log(`🤪 ${playerId}号是白痴，翻牌免死，失去投票权`);
    }

    // 猎人技能（仅票和刀触发）
    if (activeRole === '猎人' && ['WOLF', 'VOTE'].includes(cause)) {
      triggerHunter = true;
      await this.log(`🔫 猎人倒下，可以开枪`);
    }

    // 警长死亡
    if (player.badge && isOut) {
      sheriffDied = playerId;
    }

    await this.updateGame(updates);

    return { 
      success: true, 
      triggerHunter, 
      sheriffDied,
      isOut 
    };
  }

  // 检查胜利条件
  async checkWinCondition() {
    const gameData = await this.getGameData();
    const alivePlayers = Object.values(gameData.players).filter(p => p.isAlive);

    // 检查狼人阵营是否存活
    const hasWolfAlive = alivePlayers.some(p => 
      p.identities.some(id => id.role === '狼人' || id.role === '隐狼')
    );

    // 好人胜利条件1：消灭所有狼人
    if (!hasWolfAlive) {
      await this.updateGame({ 'state/phase': PHASES.GAME_OVER, 'state/winner': '好人阵营' });
      await this.log('🎉 游戏结束：好人获胜（消灭所有狼人）');
      return true;
    }

    // 好人胜利条件2：连续3个平安夜
    if ((gameData.state.peacefulNights || 0) >= 3) {
      await this.updateGame({ 'state/phase': PHASES.GAME_OVER, 'state/winner': '好人阵营' });
      await this.log('🎉 游戏结束：好人获胜（连续3个平安夜）');
      return true;
    }

    // 狼人胜利条件
    const winCondition = gameData.settings.wolfWin;
    
    if (winCondition === 'exterminate') {
      // 屠城：消灭所有好人
      const hasGoodAlive = alivePlayers.some(p => 
        p.identities.some(id => ROLES[id.role]?.faction === 'good')
      );
      
      if (!hasGoodAlive) {
        await this.updateGame({ 'state/phase': PHASES.GAME_OVER, 'state/winner': '狼人阵营' });
        await this.log('🐺 游戏结束：狼人屠城获胜');
        return true;
      }
    } else {
      // 屠边：消灭所有神职或金宝宝
      const hasGodAlive = alivePlayers.some(p => 
        p.identities.some(id => ROLES[id.role]?.isGod)
      );
      
      const hasGoldenBaby = alivePlayers.some(p => {
        const roles = p.identities.map(id => id.role);
        return roles[0] === '平民' && roles[1] === '平民';
      });

      if (!hasGodAlive) {
        await this.updateGame({ 'state/phase': PHASES.GAME_OVER, 'state/winner': '狼人阵营' });
        await this.log('🐺 游戏结束：狼人屠神获胜');
        return true;
      }

      if (!hasGoldenBaby) {
        await this.updateGame({ 'state/phase': PHASES.GAME_OVER, 'state/winner': '狼人阵营' });
        await this.log('🐺 游戏结束：狼人屠金获胜');
        return true;
      }
    }

    return false;
  }

  // 处理夜晚结算
  async processDawn() {
    const gameData = await this.getGameData();
    const round = gameData.state.round;
    const deaths = [];

    // 获取狼刀目标
    const wolfTarget = gameData.actions?.[round]?.wolf?.target;
    
    // 获取守卫守护
    const guardTarget = gameData.actions?.[round]?.guard?.target;
    const isGuarded = wolfTarget && guardTarget === wolfTarget;

    // 获取女巫行动
    const witchCure = gameData.actions?.[round]?.witch?.cure;
    const witchPoison = gameData.actions?.[round]?.witch?.poison;
    const isCured = wolfTarget && witchCure === wolfTarget;

    // 判定狼刀死亡（守+救=死）
    if (wolfTarget && wolfTarget !== '0') {
      if (!isGuarded && !isCured) {
        deaths.push({ id: wolfTarget, cause: 'WOLF' });
      } else if (isGuarded && isCured) {
        deaths.push({ id: wolfTarget, cause: 'WOLF' });
        await this.log('⚠️ 同时被守护和解救，规则判定死亡', true);
      }
    }

    // 毒药死亡
    if (witchPoison && witchPoison !== '0') {
      deaths.push({ id: witchPoison, cause: 'POISON' });
    }

    // 执行死亡
    let hunterQueue = [];
    let sheriffQueue = [];

    if (deaths.length > 0) {
      const deadNames = deaths.map(d => `${d.id}号`).join('、');
      await this.log(`昨夜死亡：${deadNames}`);
      
      for (const death of deaths) {
        const result = await this.killPlayer(death.id, death.cause);
        if (result.triggerHunter) hunterQueue.push(death.id);
        if (result.sheriffDied) sheriffQueue.push(death.id);
      }
    } else {
      await this.log('昨夜是平安夜');
      const peaceful = (gameData.state.peacefulNights || 0) + 1;
      await this.updateGame({ 'state/peacefulNights': peaceful });
    }

    // 检查胜利
    if (await this.checkWinCondition()) return;

    // 处理后续流程
    if (sheriffQueue.length > 0) {
      await this.updateGame({ 
        'state/phase': PHASES.BADGE,
        'state/badgeTransfer': sheriffQueue[0]
      });
    } else if (hunterQueue.length > 0) {
      await this.updateGame({ 
        'state/phase': PHASES.HUNTER,
        'state/hunterQueue': hunterQueue
      });
    } else {
      await this.updateGame({ 'state/phase': PHASES.DAY });
    }
  }
}

// ==================== UI管理器 ====================
class UIManager {
  constructor() {
    this.gameId = null;
    this.playerId = null;
    this.engine = null;
    this.listeners = [];
    this.selectedPlayer = null;
  }

  async init() {
    try {
      // 解析URL参数
      const params = new URLSearchParams(window.location.search);
      this.gameId = params.get('game');
      this.playerId = params.get('player');

      if (this.gameId) {
        this.engine = new GameEngine(this.gameId);
        
        if (this.playerId === '0') {
          // 上帝视角
          this.initGodView();
        } else if (this.playerId) {
          // 玩家视角
          this.initPlayerView();
        } else {
          // 选择座位
          this.showJoinView();
        }
      } else {
        // 创建游戏
        this.showSetupView();
      }

      this.hideLoading();
    } catch (error) {
      console.error('初始化失败:', error);
      this.showNotification('初始化失败: ' + error.message, 'error');
    }
  }

  hideLoading() {
    const loading = $('loading-screen');
    if (loading) loading.classList.add('hidden');
  }

  showNotification(message, type = 'info') {
    const container = $('notification-container');
    if (!container) return;

    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    container.appendChild(notification);

    setTimeout(() => notification.remove(), 3000);
  }

  switchView(viewId) {
    $$('.view').forEach(v => v.classList.remove('active'));
    const view = $(viewId);
    if (view) view.classList.add('active');
  }

  // 显示游戏设置界面
  showSetupView() {
    this.switchView('setup-view');
    this.initSetupForm();
  }

  initSetupForm() {
    const roleGrid = $('role-grid');
    if (!roleGrid) return;

    roleGrid.innerHTML = '';
    
    // 默认配置
    const defaultSetup = {
      '平民': 4, '预言家': 1, '女巫': 1, '守卫': 1,
      '猎人': 1, '骑士': 1, '白痴': 1,
      '狼人': 4, '隐狼': 0, '盗贼': 0
    };

    for (const [role, info] of Object.entries(ROLES)) {
      const count = defaultSetup[role] || 0;
      const item = document.createElement('div');
      item.className = 'role-item';
      item.innerHTML = `
        <div class="role-name">
          <span class="role-icon">${info.icon}</span>
          <span>${role}</span>
        </div>
        <div class="number-input">
          <button onclick="UI.changeRoleCount('${role}', -1)">-</button>
          <input type="number" id="role-${role}" value="${count}" readonly>
          <button onclick="UI.changeRoleCount('${role}', 1)">+</button>
        </div>
      `;
      roleGrid.appendChild(item);
    }

    this.updateSetupSummary();
  }

  changeRoleCount(role, delta) {
    const input = $(`role-${role}`);
    if (!input) return;

    let count = parseInt(input.value) || 0;
    count = Math.max(0, count + delta);

    // 唯一角色限制
    if (role === '隐狼' || role === '盗贼') {
      count = Math.min(1, count);
    }

    input.value = count;
    this.updateSetupSummary();
  }

  updateSetupSummary() {
    let total = 0;
    for (const role of Object.keys(ROLES)) {
      const input = $(`role-${role}`);
      if (input) total += parseInt(input.value) || 0;
    }

    const totalRoles = $('total-roles');
    const playerCount = $('player-count');
    const warning = $('setup-warning');

    if (totalRoles) totalRoles.textContent = total;
    if (playerCount) playerCount.textContent = Math.floor(total / 2);

    if (warning) {
      if (total === 0) {
        warning.textContent = '请配置角色';
      } else if (total % 2 !== 0) {
        warning.textContent = '身份总数必须为偶数';
      } else {
        warning.textContent = '';
      }
    }
  }

  // 创建游戏
  async createGame() {
    try {
      // 收集角色配置
      const rolePool = [];
      for (const role of Object.keys(ROLES)) {
        const input = $(`role-${role}`);
        if (input) {
          const count = parseInt(input.value) || 0;
          for (let i = 0; i < count; i++) {
            rolePool.push(role);
          }
        }
      }

      if (rolePool.length === 0 || rolePool.length % 2 !== 0) {
        this.showNotification('身份配置不正确', 'error');
        return;
      }

      // 发牌
      const pairs = CardDealer.deal(rolePool);
      
      // 创建玩家数据
      const players = {};
      pairs.forEach((identities, index) => {
        const pid = index + 1;
        players[pid] = {
          id: pid,
          name: `玩家${pid}`,
          identities,
          deaths: 0,
          isAlive: true,
          isReady: false,
          badge: 0
        };
      });

      // 收集游戏设置
      const settings = {
        witchRule: $('witch-rule')?.value || 'noFirstNightSelfSave',
        seerMode: $('seer-mode')?.value || 'faction',
        wolfWin: $('wolf-win')?.value || 'edge',
        wolfVisibility: $('wolf-visibility')?.value || 'activeOnly',
        hiddenActivation: $('hidden-activation')?.value || 'noActiveWolf'
      };

      // 生成游戏ID
      const gameId = generateGameId();

      // 创建游戏数据
      const gameData = {
        id: gameId,
        created: firebase.database.ServerValue.TIMESTAMP,
        settings,
        players,
        state: {
          phase: PHASES.LOBBY,
          round: 0,
          host: 1,
          peacefulNights: 0
        },
        actions: {},
        logs: []
      };

      // 保存到数据库
      await db.ref(`games/${gameId}`).set(gameData);

      // 跳转到游戏
      window.location.href = `?game=${gameId}&player=1`;

    } catch (error) {
      console.error('创建游戏失败:', error);
      this.showNotification(error.message || '创建游戏失败', 'error');
    }
  }

  // 显示加入界面
  showJoinView() {
    this.switchView('join-view');
  }

  // 加入游戏
  async joinGame() {
    const input = $('player-number-input');
    if (!input) return;

    const playerNum = parseInt(input.value);
    if (!playerNum || playerNum < 1 || playerNum > 20) {
      this.showNotification('请输入有效的座位号', 'error');
      return;
    }

    // 检查座位是否存在
    const playerSnap = await db.ref(`games/${this.gameId}/players/${playerNum}`).once('value');
    if (!playerSnap.exists()) {
      this.showNotification('该座位不存在', 'error');
      return;
    }

    // 跳转到游戏
    window.location.href = `?game=${this.gameId}&player=${playerNum}`;
  }

  // 初始化玩家视角
  async initPlayerView() {
    this.setupGameListeners();
    this.setupActionBindings();
  }

  // 初始化上帝视角
  async initGodView() {
    this.switchView('god-view');
    this.setupGodListeners();
  }

  // 设置游戏监听器
  setupGameListeners() {
    const gameRef = db.ref(`games/${this.gameId}`);
    this.listeners.push(gameRef);

    gameRef.on('value', snapshot => {
      const gameData = snapshot.val();
      if (!gameData) return;

      this.renderGame(gameData);
    });
  }

  // 设置上帝视角监听器
  setupGodListeners() {
    const gameRef = db.ref(`games/${this.gameId}`);
    this.listeners.push(gameRef);

    gameRef.on('value', snapshot => {
      const gameData = snapshot.val();
      if (!gameData) return;

      this.renderGodView(gameData);
    });
  }

  // 渲染游戏界面
  renderGame(gameData) {
    const phase = gameData.state.phase;

    switch (phase) {
      case PHASES.LOBBY:
        this.renderLobby(gameData);
        break;
      case PHASES.GAME_OVER:
        this.renderGameOver(gameData);
        break;
      default:
        this.renderGamePlay(gameData);
    }
  }

  // 渲染大厅
  renderLobby(gameData) {
    this.switchView('lobby-view');

    // 显示游戏链接
    const linkInput = $('game-link');
    if (linkInput) {
      linkInput.value = `${window.location.origin}${window.location.pathname}?game=${this.gameId}`;
    }

    // 显示玩家状态
    const grid = $('player-status-grid');
    if (grid) {
      grid.innerHTML = '';
      const players = Object.values(gameData.players).sort((a, b) => a.id - b.id);
      
      for (const player of players) {
        const item = document.createElement('div');
        item.className = `player-status-item ${player.isReady ? 'ready' : ''}`;
        item.innerHTML = `
          <div>${player.id}号</div>
          <div>${player.isReady ? '✅ 已准备' : '⏳ 等待中'}</div>
        `;
        grid.appendChild(item);
      }
    }

    // 显示身份
    const identityDisplay = $('lobby-identity-display');
    if (identityDisplay && this.playerId) {
      const me = gameData.players[this.playerId];
      if (me) {
        identityDisplay.innerHTML = `
          <div class="identity-card ${me.identities[0].isCopy ? 'thief-copy' : ''}">
            <span>${me.identities[0].isCopy ? '🎭' : ROLES[me.identities[0].role].icon}</span>
            <span>${me.identities[0].role}</span>
          </div>
          <div class="identity-card ${me.identities[1].isCopy ? 'thief-copy' : ''}">
            <span>${me.identities[1].isCopy ? '🎭' : ROLES[me.identities[1].role].icon}</span>
            <span>${me.identities[1].role}</span>
          </div>
        `;
      }
    }

    // 显示操作按钮
    this.renderLobbyActions(gameData);
  }

  // 渲染大厅操作
  renderLobbyActions(gameData) {
    const actions = $('lobby-actions');
    if (!actions || !this.playerId) return;

    const me = gameData.players[this.playerId];
    if (!me) return;

    let html = '';

    if (!me.isReady) {
      html += `
        <button class="btn btn-secondary" onclick="UI.swapIdentities()">交换身份</button>
        <button class="btn btn-primary" onclick="UI.confirmReady()">确认准备</button>
      `;
    }

    if (String(this.playerId) === '1') {
      const allReady = Object.values(gameData.players).every(p => p.isReady);
      if (allReady) {
        html += `<button class="btn btn-success" onclick="UI.startGame()">开始游戏</button>`;
      }
    }

    actions.innerHTML = html;
  }

  // 渲染游戏进行中
  renderGamePlay(gameData) {
    this.switchView('game-view');
    
    // 渲染头部状态
    const status = document.querySelector('.game-status');
    if (status) {
      status.innerHTML = `第${gameData.state.round}轮 · ${this.getPhaseText(gameData.state.phase)}`;
    }

    // 渲染玩家列表
    this.renderPlayerList(gameData);

    // 渲染身份信息
    this.renderIdentityPanel(gameData);

    // 渲染操作面板
    this.renderActionPanel(gameData);
  }

  // 渲染玩家列表
  renderPlayerList(gameData) {
    const leftList = $('players-left');
    const rightList = $('players-right');
    
    if (!leftList || !rightList) return;

    leftList.innerHTML = '';
    rightList.innerHTML = '';

    const players = Object.values(gameData.players).sort((a, b) => a.id - b.id);
    const half = Math.ceil(players.length / 2);

    players.forEach((player, index) => {
      const card = this.createPlayerCard(player);
      if (index < half) {
        leftList.appendChild(card);
      } else {
        rightList.appendChild(card);
      }
    });
  }

  // 创建玩家卡片
  createPlayerCard(player) {
    const card = document.createElement('div');
    card.className = 'player-card';
    card.dataset.playerId = player.id;
    
    if (!player.isAlive) card.classList.add('dead');
    if (String(player.id) === String(this.playerId)) card.classList.add('me');
    if (String(player.id) === String(this.selectedPlayer)) card.classList.add('selected');

    const hearts = 2 - (player.deaths || 0);
    const heartDisplay = '❤️'.repeat(hearts) + '🖤'.repeat(2 - hearts);

    card.innerHTML = `
      <div class="player-number">${player.id}号</div>
      <div class="player-hearts">${heartDisplay}</div>
      ${player.badge ? '<div class="player-badges">👑</div>' : ''}
      ${player.isExposedIdiot ? '<div class="player-badges">🤪</div>' : ''}
    `;

    card.addEventListener('click', () => this.selectPlayer(player.id));

    return card;
  }

  // 选择玩家
  selectPlayer(playerId) {
    $$('.player-card').forEach(card => card.classList.remove('selected'));
    document.querySelectorAll(`[data-player-id="${playerId}"]`).forEach(card => {
      card.classList.add('selected');
    });
    this.selectedPlayer = playerId;
  }

  // 渲染身份面板
  renderIdentityPanel(gameData) {
    const panel = $('identity-panel');
    if (!panel || !this.playerId) return;

    const me = gameData.players[this.playerId];
    if (!me) return;

    const activeIdx = Math.min(me.deaths || 0, 1);
    const activeRole = me.identities[activeIdx];
    const roleInfo = ROLES[activeRole.role];

    panel.innerHTML = `
      <h3>你的身份</h3>
      <div class="identity-display">
        <div class="identity-card ${activeRole.isCopy ? 'thief-copy' : ''}">
          <span class="role-icon">${activeRole.isCopy ? '🎭' : roleInfo.icon}</span>
          <span>${activeRole.role}</span>
        </div>
      </div>
      <div class="identity-info">
        生命值：${2 - me.deaths}/2
        ${me.badge ? ' · 警长' : ''}
        ${me.isExposedIdiot ? ' · 已翻牌' : ''}
      </div>
    `;
  }

  // 渲染操作面板
  renderActionPanel(gameData) {
    const panel = $('action-panel');
    if (!panel || !this.playerId) return;

    const me = gameData.players[this.playerId];
    if (!me || !me.isAlive) {
      panel.innerHTML = '<div class="text-muted">你已出局</div>';
      return;
    }

    const phase = gameData.state.phase;
    const activeRole = this.engine.getActiveRole(me);

    // 根据阶段和角色渲染不同操作
    switch (phase) {
      case PHASES.NIGHT:
        this.renderNightActions(gameData, activeRole);
        break;
      case PHASES.SHERIFF_ELECTION:
        this.renderSheriffElection(gameData);
        break;
      case PHASES.DAY:
        this.renderDayActions(gameData, activeRole);
        break;
      case PHASES.VOTE:
        this.renderVoteActions(gameData);
        break;
      case PHASES.HUNTER:
        this.renderHunterActions(gameData);
        break;
      case PHASES.BADGE:
        this.renderBadgeTransfer(gameData);
        break;
      default:
        panel.innerHTML = '<div class="text-muted">等待中...</div>';
    }
  }

  // 渲染夜晚行动
  renderNightActions(gameData, activeRole) {
    const panel = $('action-panel');
    const round = gameData.state.round;

    if (activeRole === '狼人' || (activeRole === '隐狼' && gameData.state.hiddenWolfActive)) {
      // 狼人行动界面
      panel.innerHTML = `
        <div class="action-prompt">选择今晚的袭击目标</div>
        <div class="action-buttons">
          <button class="btn btn-danger" onclick="UI.wolfAttack()">确认袭击</button>
        </div>
      `;
    } else if (activeRole === '预言家') {
      // 预言家查验
      panel.innerHTML = `
        <div class="action-prompt">选择查验目标</div>
        <div class="action-buttons">
          <button class="btn btn-primary" onclick="UI.seerCheck()">查验</button>
        </div>
      `;
    } else if (activeRole === '守卫') {
      // 守卫守护
      panel.innerHTML = `
        <div class="action-prompt">选择守护目标</div>
        <div class="action-buttons">
          <button class="btn btn-primary" onclick="UI.guardProtect()">守护</button>
          <button class="btn btn-secondary" onclick="UI.guardEmpty()">空守</button>
        </div>
      `;
    } else if (activeRole === '女巫') {
      // 女巫用药（需要特殊处理）
      this.renderWitchActions(gameData);
    } else {
      panel.innerHTML = '<div class="text-muted">夜深了，请闭眼</div>';
    }
  }

  // 渲染女巫行动
  renderWitchActions(gameData) {
    const panel = $('action-panel');
    const round = gameData.state.round;
    const me = gameData.players[this.playerId];
    
    // 获取今晚狼刀目标
    const wolfTarget = gameData.actions?.[round]?.wolf?.target;
    const canSeeKnife = !me.skill?.cureUsed;

    let html = '<div class="action-prompt">女巫行动</div>';

    if (canSeeKnife && wolfTarget && wolfTarget !== '0') {
      html += `<div class="witch-info">今晚${wolfTarget}号被刀</div>`;
      
      if (!me.skill?.cureUsed) {
        const canSelfSave = this.checkWitchSelfSave(gameData, wolfTarget);
        if (canSelfSave) {
          html += `<button class="btn btn-success" onclick="UI.witchCure(${wolfTarget})">解救</button>`;
        }
      }
    }

    if (!me.skill?.poisonUsed) {
      html += `<button class="btn btn-danger" onclick="UI.witchPoison()">使用毒药</button>`;
    }

    html += `<button class="btn btn-secondary" onclick="UI.witchPass()">不使用药水</button>`;

    panel.innerHTML = `<div class="action-buttons">${html}</div>`;
  }

  // 检查女巫是否能自救
  checkWitchSelfSave(gameData, target) {
    if (String(target) !== String(this.playerId)) return true;
    
    const rule = gameData.settings.witchRule;
    const round = gameData.state.round;
    
    if (rule === 'onlyFirstNightSelfSave') {
      return round === 1;
    } else {
      return round !== 1;
    }
  }

  // 渲染上帝视角
  renderGodView(gameData) {
    const content = $('god-content');
    if (!content) return;

    let html = `
      <div class="god-tables">
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">玩家信息</h3>
          </div>
          <div class="card-body">
            <table class="god-table">
              <thead>
                <tr>
                  <th>座位</th>
                  <th>身份1</th>
                  <th>身份2</th>
                  <th>生命</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
    `;

    const players = Object.values(gameData.players).sort((a, b) => a.id - b.id);
    for (const player of players) {
      const hearts = 2 - (player.deaths || 0);
      html += `
        <tr class="${!player.isAlive ? 'dead' : ''}">
          <td>${player.id}号 ${player.badge ? '👑' : ''}</td>
          <td>${player.identities[0].role} ${player.identities[0].isCopy ? '🎭' : ''}</td>
          <td>${player.identities[1].role} ${player.identities[1].isCopy ? '🎭' : ''}</td>
          <td>${'❤️'.repeat(hearts)}${'🖤'.repeat(2-hearts)}</td>
          <td>${player.isAlive ? '存活' : '出局'} ${player.isExposedIdiot ? '🤪' : ''}</td>
        </tr>
      `;
    }

    html += `
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">游戏状态</h3>
        </div>
        <div class="card-body">
          <div class="god-status">
            <p>当前阶段：${this.getPhaseText(gameData.state.phase)}</p>
            <p>轮数：第${gameData.state.round}轮</p>
            <p>平安夜数：${gameData.state.peacefulNights || 0}</p>
            <p>隐狼状态：${gameData.state.hiddenWolfActive ? '已激活' : '未激活'}</p>
          </div>
        </div>
      </div>
    </div>
    `;

    content.innerHTML = html;
  }

  // 获取阶段文本
  getPhaseText(phase) {
    const texts = {
      [PHASES.SETUP]: '游戏设置',
      [PHASES.LOBBY]: '游戏大厅',
      [PHASES.NIGHT]: '夜晚',
      [PHASES.DAWN]: '黎明',
      [PHASES.SHERIFF_ELECTION]: '警长竞选',
      [PHASES.DAY]: '白天发言',
      [PHASES.VOTE]: '放逐投票',
      [PHASES.DUEL]: '骑士决斗',
      [PHASES.HUNTER]: '猎人开枪',
      [PHASES.BADGE]: '警徽移交',
      [PHASES.GAME_OVER]: '游戏结束'
    };
    return texts[phase] || '未知阶段';
  }

  // 渲染游戏结束
  renderGameOver(gameData) {
    this.switchView('game-view');
    const panel = $('action-panel');
    if (panel) {
      panel.innerHTML = `
        <div class="game-over">
          <h2>游戏结束</h2>
          <div class="winner">🎉 ${gameData.state.winner}获胜！</div>
          <button class="btn btn-primary" onclick="UI.backToLobby()">返回大厅</button>
        </div>
      `;
    }
  }

  // 绑定操作方法
  setupActionBindings() {
    // 这里绑定所有游戏操作方法
  }

  // === 游戏操作方法 ===

  async swapIdentities() {
    const gameData = await this.engine.getGameData();
    const me = gameData.players[this.playerId];
    const swapped = [me.identities[1], me.identities[0]];
    
    await db.ref(`games/${this.gameId}/players/${this.playerId}/identities`).set(swapped);
    this.showNotification('身份已交换', 'success');
  }

  async confirmReady() {
    await db.ref(`games/${this.gameId}/players/${this.playerId}/isReady`).set(true);
    this.showNotification('已准备', 'success');
  }

  async startGame() {
    await this.engine.updateGame({
      'state/phase': PHASES.NIGHT,
      'state/round': 1,
      'state/hiddenWolfActive': await this.engine.checkHiddenWolfActivation()
    });
    await this.engine.log('游戏开始！');
  }

  async wolfAttack() {
    if (!this.selectedPlayer) {
      this.showNotification('请先选择目标', 'error');
      return;
    }
    
    const gameData = await this.engine.getGameData();
    const round = gameData.state.round;
    
    await db.ref(`games/${this.gameId}/actions/${round}/wolf`).set({
      target: this.selectedPlayer,
      timestamp: firebase.database.ServerValue.TIMESTAMP
    });
    
    this.showNotification('已选择袭击目标', 'success');
  }

  async seerCheck() {
    if (!this.selectedPlayer) {
      this.showNotification('请先选择目标', 'error');
      return;
    }
    
    const gameData = await this.engine.getGameData();
    const round = gameData.state.round;
    const target = gameData.players[this.selectedPlayer];
    const mode = gameData.settings.seerMode;
    
    let result;
    if (mode === 'identity') {
      result = this.engine.getActiveRole(target);
      // 处理隐狼
      if (result === '隐狼' && !gameData.state.hiddenWolfActive) {
        const otherRole = target.identities.find(id => id.role !== '隐狼')?.role;
        result = otherRole || '未知';
      }
    } else {
      // 查阵营
      const hasWolf = target.identities.some(id => id.role === '狼人' || id.role === '隐狼');
      if (hasWolf) {
        const isHidden = target.identities.some(id => id.role === '隐狼');
        result = (isHidden && !gameData.state.hiddenWolfActive) ? '好人阵营' : '狼人阵营';
      } else {
        result = '好人阵营';
      }
    }
    
    await db.ref(`games/${this.gameId}/actions/${round}/seer/${this.playerId}`).set({
      target: this.selectedPlayer,
      result,
      timestamp: firebase.database.ServerValue.TIMESTAMP
    });
    
    this.showNotification(`查验结果：${result}`, 'info');
  }

  async guardProtect() {
    if (!this.selectedPlayer) {
      this.showNotification('请先选择目标', 'error');
      return;
    }
    
    const gameData = await this.engine.getGameData();
    const round = gameData.state.round;
    const me = gameData.players[this.playerId];
    
    // 检查连续守护
    if (me.lastGuard === this.selectedPlayer && round > 1) {
      this.showNotification('不能连续守护同一人', 'error');
      return;
    }
    
    await db.ref(`games/${this.gameId}/actions/${round}/guard`).set({
      target: this.selectedPlayer,
      timestamp: firebase.database.ServerValue.TIMESTAMP
    });
    
    await db.ref(`games/${this.gameId}/players/${this.playerId}/lastGuard`).set(this.selectedPlayer);
    
    this.showNotification('守护成功', 'success');
  }

  async guardEmpty() {
    const gameData = await this.engine.getGameData();
    const round = gameData.state.round;
    
    await db.ref(`games/${this.gameId}/actions/${round}/guard`).set({
      target: '0',
      timestamp: firebase.database.ServerValue.TIMESTAMP
    });
    
    await db.ref(`games/${this.gameId}/players/${this.playerId}/lastGuard`).set('0');
    
    this.showNotification('选择空守', 'success');
  }

  async witchCure(target) {
    const gameData = await this.engine.getGameData();
    const round = gameData.state.round;
    
    await db.ref(`games/${this.gameId}/actions/${round}/witch/cure`).set(target);
    await db.ref(`games/${this.gameId}/players/${this.playerId}/skill/cureUsed`).set(true);
    
    this.showNotification('使用解药', 'success');
  }

  async witchPoison() {
    if (!this.selectedPlayer) {
      this.showNotification('请先选择目标', 'error');
      return;
    }
    
    const gameData = await this.engine.getGameData();
    const round = gameData.state.round;
    
    await db.ref(`games/${this.gameId}/actions/${round}/witch/poison`).set(this.selectedPlayer);
    await db.ref(`games/${this.gameId}/players/${this.playerId}/skill/poisonUsed`).set(true);
    
    this.showNotification('使用毒药', 'success');
  }

  async witchPass() {
    const gameData = await this.engine.getGameData();
    const round = gameData.state.round;
    
    await db.ref(`games/${this.gameId}/actions/${round}/witch/pass`).set(true);
    
    this.showNotification('不使用药水', 'success');
  }

  backToLobby() {
    window.location.href = `?game=${this.gameId}&player=${this.playerId}`;
  }

  copyGameLink() {
    const input = $('game-link');
    if (input) {
      input.select();
      document.execCommand('copy');
      this.showNotification('链接已复制', 'success');
    }
  }

  // 清理
  destroy() {
    this.listeners.forEach(ref => ref.off());
    this.listeners = [];
  }
}

// ==================== 初始化 ====================
window.UI = new UIManager();

document.addEventListener('DOMContentLoaded', () => {
  console.log('🐺 双身份狼人杀系统启动');
  window.UI.init();
});

window.addEventListener('beforeunload', () => {
  if (window.UI) window.UI.destroy();
});

// 全局函数（供HTML使用）
window.closeModal = () => {
  $$('.modal').forEach(modal => modal.classList.remove('active'));
};
