/**
 * 双身份狼人杀 - 游戏引擎
 */

class GameEngine {
  constructor(gameId) {
    this.gameId = gameId;
    this.gameRef = null;
    this.gameData = null;
    this.listeners = [];
  }

  // 初始化
  async init() {
    if (!firebase.apps.length) {
      firebase.initializeApp(GameConfig.FIREBASE_CONFIG);
    }
    this.db = firebase.database();
    this.gameRef = this.db.ref(`games/${this.gameId}`);
  }

  // 获取游戏数据
  async getGameData() {
    const snapshot = await this.gameRef.once('value');
    this.gameData = snapshot.val();
    return this.gameData;
  }

  // 更新游戏数据
  async updateGame(updates) {
    return this.gameRef.update(updates);
  }

  // 监听游戏变化
  onGameChange(callback) {
    const listener = this.gameRef.on('value', snapshot => {
      this.gameData = snapshot.val();
      callback(this.gameData);
    });
    this.listeners.push({ ref: this.gameRef, listener });
  }

  // 停止监听
  stopListening() {
    this.listeners.forEach(({ ref, listener }) => {
      ref.off('value', listener);
    });
    this.listeners = [];
  }

  // 创建游戏
  static async createGame(settings, roleSetup) {
    const db = firebase.database();
    const gameId = GameEngine.generateGameId();
    
    // 发牌
    const rolePool = [];
    for (const [role, count] of Object.entries(roleSetup)) {
      for (let i = 0; i < count; i++) {
        rolePool.push(role);
      }
    }
    
    if (rolePool.length === 0 || rolePool.length % 2 !== 0) {
      throw new Error('身份总数必须为偶数且大于0');
    }
    
    const pairs = CardDealer.deal(rolePool);
    
    // 创建玩家数据
    const players = {};
    pairs.forEach((identities, index) => {
      const playerId = index + 1;
      players[playerId] = {
        id: playerId,
        identities,
        deaths: 0,
        isAlive: true,
        isReady: false,
        isSitting: false
      };
    });
    
    // 创建游戏数据
    const gameData = {
      id: gameId,
      created: firebase.database.ServerValue.TIMESTAMP,
      settings,
      players,
      state: {
        phase: GameConfig.PHASES.LOBBY,
        round: 0,
        host: 1,
        peacefulNights: 0,
        hiddenWolfActive: false
      },
      actions: {},
      logs: []
    };
    
    await db.ref(`games/${gameId}`).set(gameData);
    return gameId;
  }

  // 生成游戏ID
  static generateGameId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  // 添加日志
  async addLog(message, isSecret = false, round = null) {
    const logEntry = {
      message,
      round: round || this.gameData?.state?.round || 0,
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

  // 检查隐狼激活
  checkHiddenWolfActivation() {
    const players = Object.values(this.gameData.players);
    const mode = this.gameData.settings.hiddenActivation;
    
    if (mode === 'noWolfCardAlive') {
      // 不存在狼人牌
      return !players.some(p => 
        p.identities.some(id => id.role === '狼人')
      );
    } else {
      // 无活跃狼人
      return !players.some(p => 
        p.isAlive && this.getActiveRole(p) === '狼人'
      );
    }
  }

  // 获取可行动狼人
  getActingWolves() {
    const hiddenActive = this.gameData.state.hiddenWolfActive || false;
    
    return Object.values(this.gameData.players).filter(p => {
      if (!p.isAlive) return false;
      const role = this.getActiveRole(p);
      return role === '狼人' || (role === '隐狼' && hiddenActive);
    });
  }

  // 获取拍板狼
  getAlphaWolf() {
    const wolves = this.getActingWolves();
    if (wolves.length === 0) return null;
    
    // 号码最小的狼人为拍板狼
    return wolves.reduce((min, wolf) => 
      wolf.id < min.id ? wolf : min
    );
  }

  // 处理玩家死亡
  async killPlayer(playerId, cause) {
    const player = this.gameData.players[playerId];
    if (!player || !player.isAlive) return { success: false };
    
    const activeRole = this.getActiveRole(player);
    const newDeaths = (player.deaths || 0) + 1;
    const isOut = newDeaths >= 2;
    
    const updates = {
      [`players/${playerId}/deaths`]: newDeaths,
      [`players/${playerId}/isAlive`]: !isOut
    };
    
    let triggerHunter = false;
    let needBadgeTransfer = false;
    
    // 白痴翻牌（仅投票）
    if (activeRole === '白痴' && cause === 'VOTE' && !player.isExposedIdiot) {
      updates[`players/${playerId}/isExposedIdiot`] = true;
      updates[`players/${playerId}/isAlive`] = true;
      updates[`players/${playerId}/deaths`] = Math.min(newDeaths, 1);
      await this.addLog(`🤪 ${playerId}号是白痴，翻牌免死，失去投票权`);
      await this.updateGame(updates);
      return { success: true, isIdiot: true };
    }
    
    // 猎人技能（仅票和刀）
    if (activeRole === '猎人' && ['WOLF', 'VOTE'].includes(cause)) {
      triggerHunter = true;
    }
    
    // 警徽移交
    if (player.badge && isOut) {
      needBadgeTransfer = true;
    }
    
    await this.updateGame(updates);
    
    const deathMessage = isOut ? 
      `💀 ${playerId}号玩家出局` : 
      `💔 ${playerId}号失去一条生命`;
    await this.addLog(deathMessage);
    
    return { 
      success: true, 
      triggerHunter,
      needBadgeTransfer,
      isOut
    };
  }

  // 检查胜利条件
  async checkWinCondition() {
    const alivePlayers = Object.values(this.gameData.players)
      .filter(p => p.isAlive);
    
    // 检查狼人阵营是否存活
    const hasWolfAlive = alivePlayers.some(p => 
      p.identities.some(id => 
        id.role === '狼人' || id.role === '隐狼'
      )
    );
    
    // 好人胜利条件1：消灭所有狼人
    if (!hasWolfAlive) {
      await this.updateGame({ 
        'state/phase': GameConfig.PHASES.GAME_OVER,
        'state/winner': '好人阵营'
      });
      await this.addLog('🎉 游戏结束：好人获胜（消灭所有狼人）');
      return true;
    }
    
    // 好人胜利条件2：连续3个平安夜
    if ((this.gameData.state.peacefulNights || 0) >= 3) {
      await this.updateGame({ 
        'state/phase': GameConfig.PHASES.GAME_OVER,
        'state/winner': '好人阵营'
      });
      await this.addLog('🎉 游戏结束：好人获胜（连续3个平安夜）');
      return true;
    }
    
    // 狼人胜利条件
    const winCondition = this.gameData.settings.wolfWin;
    
    if (winCondition === 'exterminate') {
      // 屠城：消灭所有好人
      const hasGoodAlive = alivePlayers.some(p => 
        p.identities.some(id => 
          GameConfig.ROLES[id.role]?.faction === 'good'
        )
      );
      
      if (!hasGoodAlive) {
        await this.updateGame({ 
          'state/phase': GameConfig.PHASES.GAME_OVER,
          'state/winner': '狼人阵营'
        });
        await this.addLog('🐺 游戏结束：狼人屠城获胜');
        return true;
      }
    } else {
      // 屠边：消灭所有神职或金宝宝
      const hasGodAlive = alivePlayers.some(p => 
        p.identities.some(id => 
          GameConfig.ROLES[id.role]?.isGod
        )
      );
      
      const hasGoldenBaby = alivePlayers.some(p => {
        const roles = p.identities.map(id => id.role);
        return roles[0] === '平民' && roles[1] === '平民';
      });
      
      if (!hasGodAlive) {
        await this.updateGame({ 
          'state/phase': GameConfig.PHASES.GAME_OVER,
          'state/winner': '狼人阵营'
        });
        await this.addLog('🐺 游戏结束：狼人屠神获胜');
        return true;
      }
      
      if (!hasGoldenBaby) {
        await this.updateGame({ 
          'state/phase': GameConfig.PHASES.GAME_OVER,
          'state/winner': '狼人阵营'
        });
        await this.addLog('🐺 游戏结束：狼人屠金获胜');
        return true;
      }
    }
    
    return false;
  }

  // 处理黎明结算
  async processDawn() {
    const round = this.gameData.state.round;
    const deaths = [];
    
    // 获取狼刀目标
    const wolfTarget = this.gameData.actions?.[round]?.wolf?.target;
    
    // 获取守卫守护
    const guardTarget = this.gameData.actions?.[round]?.guard?.target;
    const isGuarded = wolfTarget && guardTarget === wolfTarget;
    
    // 获取女巫行动
    const witchCure = this.gameData.actions?.[round]?.witch?.cure;
    const witchPoison = this.gameData.actions?.[round]?.witch?.poison;
    const isCured = wolfTarget && witchCure === wolfTarget;
    
    // 判定狼刀死亡（守+救=死）
    if (wolfTarget && wolfTarget !== '0') {
      if (!isGuarded && !isCured) {
        deaths.push({ id: wolfTarget, cause: 'WOLF' });
      } else if (isGuarded && isCured) {
        deaths.push({ id: wolfTarget, cause: 'WOLF' });
        await this.addLog('⚠️ 同时被守护和解救，规则判定死亡', true);
      }
    }
    
    // 毒药死亡
    if (witchPoison && witchPoison !== '0') {
      deaths.push({ id: witchPoison, cause: 'POISON' });
    }
    
    // 执行死亡
    let hunterQueue = [];
    let badgeQueue = [];
    
    if (deaths.length > 0) {
      const deadNames = deaths.map(d => `${d.id}号`).join('、');
      await this.addLog(`☀️ 天亮了，昨夜死亡：${deadNames}`);
      
      for (const death of deaths) {
        const result = await this.killPlayer(death.id, death.cause);
        if (result.triggerHunter) hunterQueue.push(death.id);
        if (result.needBadgeTransfer) badgeQueue.push(death.id);
      }
    } else {
      await this.addLog('☀️ 天亮了，昨夜是平安夜');
      const peaceful = (this.gameData.state.peacefulNights || 0) + 1;
      await this.updateGame({ 'state/peacefulNights': peaceful });
    }
    
    // 检查胜利
    if (await this.checkWinCondition()) return;
    
    // 处理后续流程
    if (badgeQueue.length > 0) {
      await this.updateGame({ 
        'state/phase': GameConfig.PHASES.BADGE_TRANSFER,
        'state/badgeTransfer': badgeQueue[0]
      });
    } else if (hunterQueue.length > 0) {
      await this.updateGame({ 
        'state/phase': GameConfig.PHASES.HUNTER,
        'state/hunterQueue': hunterQueue
      });
    } else if (round === 1) {
      // 第一轮进入警长竞选
      await this.updateGame({ 
        'state/phase': GameConfig.PHASES.SHERIFF_ELECTION
      });
    } else {
      // 进入白天发言
      await this.updateGame({ 
        'state/phase': GameConfig.PHASES.DAY_START
      });
    }
  }

  // 开始游戏
  async startGame() {
    // 检查隐狼激活
    const hiddenActive = this.checkHiddenWolfActivation();
    
    await this.updateGame({
      'state/phase': GameConfig.PHASES.NIGHT,
      'state/round': 1,
      'state/hiddenWolfActive': hiddenActive
    });
    
    await this.addLog('🌙 游戏开始，天黑请闭眼');
    
    if (hiddenActive) {
      await this.addLog('🌑 隐狼已激活', true);
    }
  }

  // 重新开始游戏
  async restartGame() {
    const players = this.gameData.players;
    const settings = this.gameData.settings;
    
    // 重新发牌
    const rolePool = [];
    for (const player of Object.values(players)) {
      player.identities.forEach(id => {
        rolePool.push(id.role === '盗贼' && !id.isCopy ? '盗贼' : id.role);
      });
    }
    
    const pairs = CardDealer.deal(rolePool);
    
    // 重置玩家数据
    const newPlayers = {};
    pairs.forEach((identities, index) => {
      const playerId = index + 1;
      newPlayers[playerId] = {
        id: playerId,
        identities,
        deaths: 0,
        isAlive: true,
        isReady: false,
        isSitting: true // 保持座位
      };
    });
    
    // 重置游戏数据
    await this.gameRef.set({
      id: this.gameId,
      created: firebase.database.ServerValue.TIMESTAMP,
      settings,
      players: newPlayers,
      state: {
        phase: GameConfig.PHASES.LOBBY,
        round: 0,
        host: this.gameData.state.host,
        peacefulNights: 0,
        hiddenWolfActive: false
      },
      actions: {},
      logs: []
    });
    
    await this.addLog('🔄 游戏已重新开始');
  }
}

// 发牌器
class CardDealer {
  static deal(rolePool) {
    const maxAttempts = 10000;
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const shuffled = this.shuffle(rolePool);
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
        
        pairs.push(Math.random() < 0.5 ? 
          [identity1, identity2] : [identity2, identity1]);
      }
      
      // 必须有金宝宝
      if (valid && hasGoldenBaby) {
        return this.shuffle(pairs);
      }
    }
    
    throw new Error('无法生成合法的牌组');
  }
  
  static isForbiddenPair(role1, role2) {
    for (const [a, b] of GameConfig.FORBIDDEN_PAIRS) {
      if ((role1 === a && role2 === b) || 
          (role1 === b && role2 === a)) {
        return true;
      }
    }
    // 狼人+狼人是允许的
    if (role1 === '狼人' && role2 === '狼人') {
      return false;
    }
    return false;
  }
  
  static shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// 导出
window.GameEngine = GameEngine;
window.CardDealer = CardDealer;
