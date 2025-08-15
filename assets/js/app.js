/**
 * 双身份狼人杀 - 电子法官系统 (完整修复版)
 * 修复内容：
 * 1. 流程重复判定问题 - 添加完整的幂等性保护
 * 2. 金宝宝保证逻辑 - 确保至少有一个金宝宝
 * 3. 上帝视角修复
 * 4. 日志系统区分公开/秘密
 * 5. 女巫、猎人等角色技能修复
 * 6. 首夜流程顺序修复
 */

/* ==================================================================
 * 1. 常量定义
 * ================================================================== */

const ROLES = {
  '平民': { faction: 'good', icon: '👤', isGod: false },
  '守卫': { faction: 'good', icon: '🛡️', isGod: true },
  '白痴': { faction: 'good', icon: '🤪', isGod: true },
  '预言家': { faction: 'good', icon: '🔮', isGod: true },
  '骑士': { faction: 'good', icon: '⚔️', isGod: true },
  '女巫': { faction: 'good', icon: '🧪', isGod: true },
  '猎人': { faction: 'good', icon: '🔫', isGod: true },
  '狼人': { faction: 'bad', icon: '🐺', isGod: false },
  '隐狼': { faction: 'bad', icon: '🌑', isGod: false, isHidden: true },
  '盗贼': { faction: 'neutral', icon: '🎭', isGod: false, isThief: true }
};

const UNIQUE_ROLES = new Set(['隐狼', '盗贼']);

const FORBIDDEN_PAIRS = new Set([
  '狼人|盗贼',
  '狼人|隐狼',
  '预言家|狼人',
  '预言家|隐狼',
  '盗贼|隐狼'
]);

const PHASE = {
  SETUP: 'SETUP',
  LOBBY: 'LOBBY',
  NIGHT: 'NIGHT',
  NIGHT_WITCH: 'NIGHT_WITCH',
  DAWN: 'DAWN',
  SHERIFF_CAND: 'SHERIFF_CAND',
  SHERIFF_SPEECH: 'SHERIFF_SPEECH',
  SHERIFF_VOTE: 'SHERIFF_VOTE',
  DAY_TALK: 'DAY_TALK',
  DAY_VOTE: 'DAY_VOTE',
  HUNTER: 'HUNTER',
  BADGE: 'BADGE',
  GAME_OVER: 'GAME_OVER'
};

const DEFAULT_SETUP = {
  '平民': 6,
  '守卫': 1,
  '白痴': 1,
  '预言家': 1,
  '骑士': 1,
  '女巫': 1,
  '猎人': 1,
  '狼人': 2,
  '隐狼': 1,
  '盗贼': 1
};

/* ==================================================================
 * 2. Firebase配置
 * ================================================================== */

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

/* ==================================================================
 * 3. 工具函数
 * ================================================================== */

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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/* ==================================================================
 * 4. 游戏引擎类（修复版）
 * ================================================================== */

class GameEngine {
  constructor(gameId) {
    this.gameId = gameId;
    this.state = null;
    this.players = null;
    this.settings = null;
    this.actions = null;
    
    // 幂等性控制
    this.processingPhases = new Set();
    this.processedActions = new Set();
  }

  // 数据库操作
  ref(path) {
    return db.ref(`games/${this.gameId}/${path}`);
  }

  async read(path) {
    try {
      const snapshot = await this.ref(path).once('value');
      return snapshot.val();
    } catch (error) {
      console.error('Read error:', path, error);
      return null;
    }
  }

  async write(path, value) {
    return this.ref(path).set(value);
  }

  async update(updates) {
    return db.ref(`games/${this.gameId}`).update(updates);
  }

  // 刷新游戏状态
  async refresh() {
    const [state, players, settings, actions] = await Promise.all([
      this.read('state'),
      this.read('players'),
      this.read('settings'),
      this.read('actions')
    ]);
    
    this.state = state || {};
    this.players = players || {};
    this.settings = settings || {};
    this.actions = actions || {};
  }

  // 日志系统（修复：区分公开和秘密日志）
  async log(message, isSecret = false) {
    const round = this.state?.round || 0;
    const logEntry = {
      msg: message,
      ts: firebase.database.ServerValue.TIMESTAMP,
      round: round,
      secret: isSecret
    };
    
    await this.ref('logs').push(logEntry);
  }

  // 流程推进（带幂等性保护）
  async tick() {
    await this.refresh();
    
    const phaseKey = `${this.state.phase}_${this.state.round}`;
    
    // 防止重复处理
    if (this.processingPhases.has(phaseKey)) {
      return;
    }
    
    this.processingPhases.add(phaseKey);
    
    try {
      switch (this.state.phase) {
        case PHASE.NIGHT:
          await this.checkNightEnd();
          break;
        case PHASE.NIGHT_WITCH:
          await this.checkWitchEnd();
          break;
        case PHASE.SHERIFF_CAND:
          await this.checkSheriffCandidates();
          break;
        case PHASE.SHERIFF_VOTE:
          await this.checkSheriffVote();
          break;
        case PHASE.DAY_TALK:
          await this.checkKnightActions();
          break;
        case PHASE.DAY_VOTE:
          await this.checkDayVote();
          break;
        case PHASE.HUNTER:
          await this.checkHunterQueue();
          break;
        case PHASE.BADGE:
          await this.checkBadgeTransfer();
          break;
      }
    } finally {
      // 延迟清除，避免过快重复
      setTimeout(() => {
        this.processingPhases.delete(phaseKey);
      }, 1000);
    }
  }

  // 阶段转换
  async transitionTo(phase, extraState = {}) {
    const updates = {
      'state/phase': phase,
      ...Object.entries(extraState).reduce((acc, [key, value]) => {
        acc[`state/${key}`] = value;
        return acc;
      }, {})
    };
    
    await this.update(updates);
  }

  // 获取活跃身份
  getActiveRole(player) {
    if (!player || !player.isAlive) return null;
    const idx = Math.min(player.deaths || 0, 1);
    return player.identities?.[idx]?.role || null;
  }

  // 隐狼激活判断（修复）
  isHiddenWolfActive() {
    const mode = this.settings?.hiddenActivation || 'noActiveWolf';
    
    if (mode === 'noWolfCardAlive') {
      // 检查是否还有狼人牌存活（不包括隐狼）
      return !Object.values(this.players).some(p => 
        p.isAlive && p.identities.some(id => id.role === '狼人')
      );
    } else {
      // 检查是否还有活跃狼人
      return !Object.values(this.players).some(p => 
        p.isAlive && this.getActiveRole(p) === '狼人'
      );
    }
  }

  // 获取可行动狼人
  getActingWolves() {
    const hiddenActive = this.isHiddenWolfActive();
    return Object.values(this.players).filter(p => {
      if (!p.isAlive) return false;
      const role = this.getActiveRole(p);
      return role === '狼人' || (role === '隐狼' && hiddenActive);
    });
  }

  // 夜晚结束检查
  async checkNightEnd() {
    const wolves = this.getActingWolves();
    const wolfAction = this.actions?.[this.state.round]?.NIGHT?.WOLF;
    
    // 狼人未完成投票
    if (wolves.length > 0 && !wolfAction?.final) {
      return;
    }
    
    // 转入女巫阶段或黎明
    const witches = Object.values(this.players).filter(p => 
      p.isAlive && this.getActiveRole(p) === '女巫'
    );
    
    if (witches.length > 0) {
      await this.transitionTo(PHASE.NIGHT_WITCH);
    } else if (this.state.round === 1) {
      // 首夜：先进行警长竞选
      await this.transitionTo(PHASE.SHERIFF_CAND, {
        sheriff: { candidates: {}, votes: {}, drops: {}, isPK: false }
      });
    } else {
      await this.dawnResolve();
    }
  }

  // 女巫阶段结束检查（修复）
  async checkWitchEnd() {
    const witches = Object.values(this.players).filter(p => 
      p.isAlive && this.getActiveRole(p) === '女巫'
    );
    
    const witchActions = this.actions?.[this.state.round]?.NIGHT_WITCH || {};
    const allDone = witches.every(w => 
      witchActions.cures?.[w.id] || 
      witchActions.poisons?.[w.id] || 
      witchActions.done?.[w.id]
    );
    
    if (!allDone) return;
    
    if (this.state.round === 1) {
      // 首夜：先进行警长竞选
      await this.transitionTo(PHASE.SHERIFF_CAND, {
        sheriff: { candidates: {}, votes: {}, drops: {}, isPK: false }
      });
    } else {
      await this.dawnResolve();
    }
  }

  // 警长竞选检查
  async checkSheriffCandidates() {
    const candidates = this.state.sheriff?.candidates || {};
    const candidateCount = Object.keys(candidates).length;
    
    // 等待所有玩家选择
    const allPlayers = Object.values(this.players).filter(p => p.isAlive);
    const decidedCount = Object.keys(candidates).length;
    
    if (decidedCount < allPlayers.length) {
      return; // 还有玩家未决定
    }
    
    const runningCandidates = Object.entries(candidates)
      .filter(([_, isRunning]) => isRunning)
      .map(([pid, _]) => pid);
    
    if (runningCandidates.length === 0) {
      await this.log('无人竞选警长', false);
      await this.dawnResolve();
    } else if (runningCandidates.length === 1) {
      // 直接当选
      const winner = runningCandidates[0];
      await this.update({
        [`players/${winner}/badge`]: 1
      });
      await this.log(`👑 ${winner}号玩家自动当选警长`, false);
      await this.dawnResolve();
    } else {
      // 进入发言阶段
      await this.transitionTo(PHASE.SHERIFF_SPEECH, {
        'sheriff/speechOrder': shuffle(runningCandidates),
        'sheriff/currentSpeaker': 0
      });
    }
  }

  // 警长投票检查
  async checkSheriffVote() {
    const votes = this.state.sheriff?.votes || {};
    const alivePlayers = Object.values(this.players).filter(p => p.isAlive);
    
    if (Object.keys(votes).length < alivePlayers.length) {
      return; // 还有人未投票
    }
    
    // 统计票数
    const tally = {};
    for (const [voter, target] of Object.entries(votes)) {
      if (target && target !== '0') {
        tally[target] = (tally[target] || 0) + 1;
      }
    }
    
    // 找出最高票
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    
    if (sorted.length === 0) {
      await this.log('无人获得选票，本局无警长', false);
      await this.dawnResolve();
      return;
    }
    
    const maxVotes = sorted[0][1];
    const winners = sorted.filter(([_, v]) => v === maxVotes).map(([p, _]) => p);
    
    if (winners.length === 1) {
      // 选出警长
      const winner = winners[0];
      await this.update({
        [`players/${winner}/badge`]: 1
      });
      await this.log(`👑 ${winner}号玩家当选警长`, false);
      await this.dawnResolve();
    } else if (!this.state.sheriff?.isPK) {
      // 进入PK
      await this.transitionTo(PHASE.SHERIFF_VOTE, {
        'sheriff/isPK': true,
        'sheriff/pkCandidates': winners,
        'sheriff/votes': {}
      });
      await this.log(`平票，进入PK：${winners.join('、')}号`, false);
    } else {
      // PK后仍平票
      await this.log('PK后仍平票，本局无警长', false);
      await this.dawnResolve();
    }
  }

  // 黎明结算（修复：守+救=死，日志区分）
  async dawnResolve() {
    // 防止重复结算
    const resolveKey = `dawn_${this.state.round}`;
    if (this.processedActions.has(resolveKey)) return;
    this.processedActions.add(resolveKey);
    
    await this.refresh();
    
    const round = this.state.round;
    const deaths = [];
    
    // 获取狼刀目标
    const wolfTarget = this.actions?.[round]?.NIGHT?.WOLF?.final;
    
    // 获取守卫行动
    const guards = Object.values(this.players).filter(p => 
      p.isAlive && this.getActiveRole(p) === '守卫'
    );
    
    let guarded = false;
    for (const guard of guards) {
      const guardAction = this.actions?.[round]?.NIGHT?.GUARD?.[guard.id];
      if (guardAction && String(guardAction.target) === String(wolfTarget)) {
        // 检查连守
        const lastGuard = guard.skill?.lastGuard;
        if (String(lastGuard) !== String(wolfTarget)) {
          guarded = true;
          await this.update({
            [`players/${guard.id}/skill/lastGuard`]: wolfTarget
          });
        }
      }
    }
    
    // 获取女巫行动
    const witchActions = this.actions?.[round]?.NIGHT_WITCH || {};
    let cured = false;
    let poisonTargets = [];
    
    for (const witchId in witchActions.cures || {}) {
      const cure = witchActions.cures[witchId];
      if (String(cure.target) === String(wolfTarget)) {
        const witch = this.players[witchId];
        if (witch && !witch.skill?.cureUsed) {
          cured = true;
          await this.update({
            [`players/${witchId}/skill/cureUsed`]: true
          });
        }
      }
    }
    
    for (const witchId in witchActions.poisons || {}) {
      const poison = witchActions.poisons[witchId];
      if (poison.target && poison.target !== '0') {
        const witch = this.players[witchId];
        if (witch && !witch.skill?.poisonUsed) {
          poisonTargets.push(poison.target);
          await this.update({
            [`players/${witchId}/skill/poisonUsed`]: true
          });
        }
      }
    }
    
    // 判定狼刀死亡（修复：守+救=死）
    if (wolfTarget && wolfTarget !== '0') {
      if (guarded && cured) {
        // 同时被守护和解救，仍然死亡
        deaths.push({ pid: wolfTarget, cause: 'WOLF' });
        await this.log(`⚠️ 同时被守护和解救，规则判定死亡`, true);
      } else if (!guarded && !cured) {
        deaths.push({ pid: wolfTarget, cause: 'WOLF' });
      }
    }
    
    // 毒药死亡
    for (const target of poisonTargets) {
      if (!deaths.some(d => String(d.pid) === String(target))) {
        deaths.push({ pid: target, cause: 'POISON' });
      }
    }
    
    // 执行死亡
    let hunterTriggered = false;
    let sheriffDied = null;
    
    if (deaths.length > 0) {
      const deadNames = deaths.map(d => `${d.pid}号`).join('、');
      await this.log(`昨夜死亡：${deadNames}`, false);
      
      for (const death of deaths) {
        const result = await this.killPlayer(death.pid, death.cause);
        if (result.hunterTriggered) hunterTriggered = true;
        if (result.sheriffDied) sheriffDied = result.sheriffDied;
      }
    } else {
      await this.log('昨夜是平安夜', false);
      await this.update({
        'state/peace': (this.state.peace || 0) + 1
      });
    }
    
    // 检查胜利条件
    if (await this.checkWin()) return;
    
    // 决定下一阶段
    let nextPhase = PHASE.DAY_TALK;
    
    if (sheriffDied) {
      await this.transitionTo(PHASE.BADGE, {
        postBadge: {
          dead: sheriffDied,
          next: hunterTriggered ? PHASE.HUNTER : nextPhase
        }
      });
    } else if (hunterTriggered) {
      await this.transitionTo(PHASE.HUNTER, {
        nextPhaseAfterHunter: nextPhase
      });
    } else {
      await this.transitionTo(nextPhase);
    }
  }

  // 骑士决斗检查
  async checkKnightActions() {
    const knightAction = this.actions?.[this.state.round]?.KNIGHT;
    if (!knightAction) return;
    
    for (const [knightId, action] of Object.entries(knightAction)) {
      if (action.processed) continue;
      
      const knight = this.players[knightId];
      const target = this.players[action.target];
      
      if (!knight || !target) continue;
      
      // 标记为已处理
      await this.update({
        [`actions/${this.state.round}/KNIGHT/${knightId}/processed`]: true
      });
      
      // 判定目标阵营
      const targetRoles = target.identities.map(id => id.role);
      const isWolf = targetRoles.some(r => r === '狼人' || r === '隐狼');
      
      if (isWolf) {
        // 决斗成功
        await this.log(`⚔️ ${knightId}号骑士决斗${action.target}号成功！`, false);
        const result = await this.killPlayer(action.target, 'DUEL');
        
        // 直接进入夜晚
        if (result.sheriffDied) {
          await this.transitionTo(PHASE.BADGE, {
            postBadge: {
              dead: result.sheriffDied,
              next: PHASE.NIGHT
            }
          });
        } else {
          await this.startNight(this.state.round + 1);
        }
      } else {
        // 决斗失败
        await this.log(`⚔️ ${knightId}号骑士决斗${action.target}号失败，骑士死亡`, false);
        await this.killPlayer(knightId, 'DUEL');
        // 继续白天流程
      }
      
      break; // 每次只处理一个决斗
    }
  }

  // 白天投票检查
  async checkDayVote() {
    const votes = this.actions?.[this.state.round]?.DAY_VOTE || {};
    const voters = Object.values(this.players).filter(p => 
      p.isAlive && !p.isExposedIdiot
    );
    
    if (Object.keys(votes).length < voters.length) {
      return; // 还有人未投票
    }
    
    // 统计票数（警长1.5票）
    const tally = {};
    for (const [voterId, target] of Object.entries(votes)) {
      if (!target || target === '0') continue;
      
      const voter = this.players[voterId];
      const weight = voter.badge ? 3 : 2; // 后台用整数计算
      tally[target] = (tally[target] || 0) + weight;
    }
    
    // 找出最高票
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    
    if (sorted.length === 0 || sorted[0][1] === sorted[1]?.[1]) {
      // 平票或无人投票
      await this.log('投票平票，无人出局', false);
      await this.startNight(this.state.round + 1);
      return;
    }
    
    const victim = sorted[0][0];
    const voteCount = sorted[0][1] / 2; // 转换回显示值
    await this.log(`${victim}号玩家获得${voteCount}票，被放逐`, false);
    
    const result = await this.killPlayer(victim, 'VOTE');
    
    // 检查胜利
    if (await this.checkWin()) return;
    
    // 处理后续
    if (result.sheriffDied) {
      await this.transitionTo(PHASE.BADGE, {
        postBadge: {
          dead: result.sheriffDied,
          next: result.hunterTriggered ? PHASE.HUNTER : PHASE.NIGHT
        }
      });
    } else if (result.hunterTriggered) {
      await this.transitionTo(PHASE.HUNTER, {
        nextPhaseAfterHunter: PHASE.NIGHT
      });
    } else {
      await this.startNight(this.state.round + 1);
    }
  }

  // 猎人开枪检查
  async checkHunterQueue() {
    const hunters = this.state.hunters || {};
    const hunterAction = this.actions?.[this.state.round]?.HUNTER || {};
    
    for (const hunterId of Object.keys(hunters)) {
      if (!hunterAction[hunterId]) {
        return; // 等待猎人选择
      }
    }
    
    // 执行所有猎人开枪
    for (const [hunterId, action] of Object.entries(hunterAction)) {
      if (action.target && action.target !== '0') {
        await this.log(`🔫 ${hunterId}号猎人开枪带走${action.target}号`, false);
        await this.killPlayer(action.target, 'SHOT');
      }
    }
    
    // 清空猎人队列
    await this.update({ 'state/hunters': {} });
    
    // 检查胜利
    if (await this.checkWin()) return;
    
    // 继续下一阶段
    const nextPhase = this.state.nextPhaseAfterHunter || PHASE.NIGHT;
    if (nextPhase === PHASE.NIGHT) {
      await this.startNight(this.state.round + 1);
    } else {
      await this.transitionTo(nextPhase);
    }
  }

  // 警徽移交检查
  async checkBadgeTransfer() {
    const deadSheriff = this.state.postBadge?.dead;
    const badgeAction = this.actions?.[this.state.round]?.BADGE?.[deadSheriff];
    
    if (!badgeAction) {
      return; // 等待选择
    }
    
    if (badgeAction.target && badgeAction.target !== '0') {
      await this.update({
        [`players/${deadSheriff}/badge`]: 0,
        [`players/${badgeAction.target}/badge`]: 1
      });
      await this.log(`👑 警徽移交给${badgeAction.target}号玩家`, false);
    } else {
      await this.update({
        [`players/${deadSheriff}/badge`]: 0
      });
      await this.log('👑 警徽被撕毁', false);
    }
    
    // 继续下一阶段
    const nextPhase = this.state.postBadge?.next || PHASE.NIGHT;
    if (nextPhase === PHASE.NIGHT) {
      await this.startNight(this.state.round + 1);
    } else {
      await this.transitionTo(nextPhase);
    }
  }

  // 玩家死亡处理（修复：猎人触发条件）
  async killPlayer(pid, cause) {
    const player = this.players[pid];
    if (!player || !player.isAlive) return {};
    
    const activeRole = this.getActiveRole(player);
    const newDeaths = (player.deaths || 0) + 1;
    const isOut = newDeaths >= 2;
    
    const updates = {
      [`players/${pid}/deaths`]: newDeaths,
      [`players/${pid}/isAlive`]: !isOut
    };
    
    let hunterTriggered = false;
    let sheriffDied = null;
    
    // 白痴翻牌（仅投票）
    if (activeRole === '白痴' && cause === 'VOTE' && !player.isExposedIdiot) {
      updates[`players/${pid}/isExposedIdiot`] = true;
      updates[`players/${pid}/isAlive`] = true;
      updates[`players/${pid}/deaths`] = 1;
      await this.log(`🤪 ${pid}号是白痴，翻牌免死，失去投票权`, false);
    }
    
    // 猎人技能（修复：仅票和刀触发）
    if (activeRole === '猎人' && ['WOLF', 'VOTE'].includes(cause)) {
      hunterTriggered = true;
      const hunters = (await this.read('state/hunters')) || {};
      hunters[pid] = true;
      updates['state/hunters'] = hunters;
      await this.log(`🔫 猎人倒下，可以开枪`, false);
    }
    
    // 警长死亡
    if (player.badge && isOut) {
      sheriffDied = pid;
    }
    
    await this.update(updates);
    
    return { hunterTriggered, sheriffDied };
  }

  // 检查胜利条件（修复）
  async checkWin() {
    await this.refresh();
    
    const alivePlayers = Object.values(this.players).filter(p => p.isAlive);
    
    // 检查狼人阵营是否存活
    const hasWolfAlive = alivePlayers.some(p => 
      p.identities.some(id => id.role === '狼人' || id.role === '隐狼')
    );
    
    // 好人胜利条件
    if (!hasWolfAlive) {
      await this.transitionTo(PHASE.GAME_OVER, { winner: '好人阵营' });
      await this.log('🎉 游戏结束：好人获胜（消灭所有狼人）', false);
      return true;
    }
    
    if ((this.state.peace || 0) >= 3) {
      await this.transitionTo(PHASE.GAME_OVER, { winner: '好人阵营' });
      await this.log('🎉 游戏结束：好人获胜（连续3个平安夜）', false);
      return true;
    }
    
    // 狼人胜利条件
    const winCondition = this.settings?.wolfWin || 'edge';
    
    if (winCondition === 'exterminate') {
      const hasGoodAlive = alivePlayers.some(p => 
        p.identities.some(id => ROLES[id.role]?.faction === 'good')
      );
      
      if (!hasGoodAlive) {
        await this.transitionTo(PHASE.GAME_OVER, { winner: '狼人阵营' });
        await this.log('🐺 游戏结束：狼人屠城获胜', false);
        return true;
      }
    } else {
      // 屠边
      const hasGodAlive = alivePlayers.some(p => 
        p.identities.some(id => ROLES[id.role]?.isGod)
      );
      
      const hasGoldenAlive = alivePlayers.some(p => {
        const roles = p.identities.map(id => id.role);
        return roles[0] === '平民' && roles[1] === '平民';
      });
      
      if (!hasGodAlive) {
        await this.transitionTo(PHASE.GAME_OVER, { winner: '狼人阵营' });
        await this.log('🐺 游戏结束：狼人屠神获胜', false);
        return true;
      }
      
      if (!hasGoldenAlive) {
        await this.transitionTo(PHASE.GAME_OVER, { winner: '狼人阵营' });
        await this.log('🐺 游戏结束：狼人屠金获胜', false);
        return true;
      }
    }
    
    return false;
  }

  // 开始新的夜晚
  async startNight(round) {
    await this.update({
      'state/round': round,
      'state/phase': PHASE.NIGHT,
      'state/hiddenActive': this.isHiddenWolfActive()
    });
    
    await this.log(`第 ${round} 夜降临...`, false);
  }
}

/* ==================================================================
 * 5. 发牌系统（修复：保证金宝宝）
 * ================================================================== */

function dealCards(rolePool) {
  const maxAttempts = 10000;
  const startTime = Date.now();
  const timeout = 2000; // 2秒超时
  
  const n = rolePool.length;
  if (n === 0 || n % 2 !== 0) {
    throw new Error('身份总数必须为偶数且大于0');
  }
  
  const isForbiddenPair = (a, b) => {
    const key = [a, b].sort().join('|');
    return FORBIDDEN_PAIRS.has(key);
  };
  
  // 尝试生成合法配对
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (Date.now() - startTime > timeout) break;
    
    const shuffled = shuffle(rolePool);
    const pairs = [];
    let valid = true;
    let hasGolden = false;
    
    // 生成配对
    for (let i = 0; i < n; i += 2) {
      const a = shuffled[i];
      const b = shuffled[i + 1];
      
      if (isForbiddenPair(a, b)) {
        valid = false;
        break;
      }
      
      // 检查金宝宝
      if (a === '平民' && b === '平民') {
        hasGolden = true;
      }
      
      // 处理盗贼复制
      let pair;
      if (a === '盗贼' && b !== '盗贼') {
        pair = [
          { role: b, isCopy: true },
          { role: b, isCopy: false }
        ];
        // 盗贼复制平民算金宝宝
        if (b === '平民') hasGolden = true;
      } else if (b === '盗贼' && a !== '盗贼') {
        pair = [
          { role: a, isCopy: false },
          { role: a, isCopy: true }
        ];
        if (a === '平民') hasGolden = true;
      } else {
        pair = [
          { role: a, isCopy: false },
          { role: b, isCopy: false }
        ];
      }
      
      // 随机交换顺序
      if (Math.random() < 0.5) {
        pair = [pair[1], pair[0]];
      }
      
      pairs.push(pair);
    }
    
    // 必须有金宝宝
    if (valid && hasGolden) {
      return shuffle(pairs);
    }
  }
  
  throw new Error('无法生成合法的牌组（需要至少一个金宝宝）');
}

/* ==================================================================
 * 6. UI管理器（续写部分）
 * ================================================================== */

class UIManager {
  constructor() {
    this.currentView = 'setup-view';
    this.gameId = null;
    this.playerId = null;
    this.gameData = null;
    this.engine = null;
    this.listeners = [];
    this.selectedPlayer = null;
  }

  // 渲染狼人行动界面
  renderWolfAction() {
    const panel = $('action-panel');
    const round = this.gameData.state.round;
    const wolves = this.engine.getActingWolves();
    const isAlpha = Math.min(...wolves.map(w => w.id)) === parseInt(this.playerId);
    
    // 获取当前投票情况
    const votes = this.actions?.[round]?.NIGHT?.WOLF?.votes || {};
    const final = this.actions?.[round]?.NIGHT?.WOLF?.final;
    
    let html = `
      <div class="action-prompt">选择今晚的袭击目标</div>
      <div class="action-info">
        狼队友：${wolves.map(w => `${w.id}号`).join('、')}
        ${isAlpha ? '（你是拍板狼）' : ''}
      </div>
    `;
    
    // 显示投票情况
    if (Object.keys(votes).length > 0) {
      html += '<div class="vote-status">当前投票：';
      for (const [voter, target] of Object.entries(votes)) {
        html += `${voter}号→${target}号 `;
      }
      html += '</div>';
    }
    
    if (final) {
      html += `<div class="text-muted">已确定目标：${final}号</div>`;
    } else {
      html += `
        <div class="action-buttons">
          <button class="btn btn-secondary" onclick="UI.wolfVote()">
            ${votes[this.playerId] ? '改票' : '投票'}
          </button>
          ${isAlpha ? `
            <button class="btn btn-primary" onclick="UI.wolfConfirm()">
              确认刀人
            </button>
          ` : ''}
        </div>
      `;
    }
    
    panel.innerHTML = html;
  }

  // 渲染预言家行动界面
  renderSeerAction() {
    const panel = $('action-panel');
    const round = this.gameData.state.round;
    const checked = this.actions?.[round]?.NIGHT?.SEER?.[this.playerId];
    
    if (checked) {
      const target = this.players[checked.target];
      let result = checked.result;
      
      panel.innerHTML = `
        <div class="action-prompt">查验结果</div>
        <div class="seer-result">
          ${checked.target}号玩家：${result}
        </div>
      `;
    } else {
      panel.innerHTML = `
        <div class="action-prompt">选择查验目标</div>
        <div class="action-buttons">
          <button class="btn btn-primary" onclick="UI.seerCheck()">
            查验选中玩家
          </button>
        </div>
      `;
    }
  }

  // 渲染守卫行动界面
  renderGuardAction() {
    const panel = $('action-panel');
    const round = this.gameData.state.round;
    const me = this.players[this.playerId];
    const guarded = this.actions?.[round]?.NIGHT?.GUARD?.[this.playerId];
    const lastGuard = me.skill?.lastGuard;
    
    if (guarded) {
      panel.innerHTML = `
        <div class="text-muted">
          已守护${guarded.target === '0' ? '空守' : `${guarded.target}号`}
        </div>
      `;
    } else {
      panel.innerHTML = `
        <div class="action-prompt">选择守护目标</div>
        ${lastGuard ? `<div class="action-info">上轮守护：${lastGuard}号（不能连守）</div>` : ''}
        <div class="action-buttons">
          <button class="btn btn-primary" onclick="UI.guardProtect()">
            守护选中玩家
          </button>
          <button class="btn btn-secondary" onclick="UI.guardEmpty()">
            空守
          </button>
        </div>
      `;
    }
  }

  // 渲染女巫行动界面
  renderWitchActions() {
    const panel = $('action-panel');
    const round = this.gameData.state.round;
    const me = this.players[this.playerId];
    const witchActions = this.actions?.[round]?.NIGHT_WITCH || {};
    
    // 检查是否已行动
    if (witchActions.cures?.[this.playerId] || 
        witchActions.poisons?.[this.playerId] || 
        witchActions.done?.[this.playerId]) {
      panel.innerHTML = '<div class="text-muted">已完成行动</div>';
      return;
    }
    
    // 获取狼刀目标
    const wolfTarget = this.actions?.[round]?.NIGHT?.WOLF?.final;
    const canSeeKnife = !me.skill?.cureUsed; // 失去解药后看不到刀口
    
    let html = '<div class="action-prompt">女巫行动</div>';
    
    // 显示刀口信息
    if (canSeeKnife && wolfTarget && wolfTarget !== '0') {
      html += `<div class="witch-info">今晚${wolfTarget}号被刀</div>`;
      
      // 解药选项
      if (!me.skill?.cureUsed) {
        const canSelfSave = this.checkWitchSelfSave(wolfTarget);
        if (canSelfSave) {
          html += `
            <button class="btn btn-success" onclick="UI.witchCure(${wolfTarget})">
              使用解药救${wolfTarget}号
            </button>
          `;
        } else if (String(wolfTarget) === String(this.playerId)) {
          html += '<div class="text-muted">不能自救</div>';
        }
      }
    } else if (canSeeKnife) {
      html += '<div class="witch-info">今晚是空刀</div>';
    }
    
    // 毒药选项
    if (!me.skill?.poisonUsed) {
      html += `
        <button class="btn btn-danger" onclick="UI.witchPoison()">
          使用毒药
        </button>
      `;
    }
    
    // 不用药选项
    html += `
      <button class="btn btn-secondary" onclick="UI.witchPass()">
        不使用药水
      </button>
    `;
    
    panel.innerHTML = `<div class="action-buttons">${html}</div>`;
  }

  // 检查女巫是否能自救
  checkWitchSelfSave(target) {
    if (String(target) !== String(this.playerId)) return true;
    
    const rule = this.gameData.settings?.witchRule;
    const round = this.gameData.state.round;
    
    if (rule === 'onlyFirstNightSelfSave') {
      return round === 1;
    } else {
      return round !== 1;
    }
  }

  // 渲染警长候选界面
  renderSheriffCandidates() {
    const panel = $('action-panel');
    const candidates = this.gameData.state.sheriff?.candidates || {};
    
    if (candidates[this.playerId] !== undefined) {
      panel.innerHTML = `
        <div class="text-muted">
          ${candidates[this.playerId] ? '已上警' : '已放弃竞选'}
        </div>
      `;
    } else {
      panel.innerHTML = `
        <div class="action-prompt">是否竞选警长？</div>
        <div class="action-buttons">
          <button class="btn btn-primary" onclick="UI.runForSheriff(true)">
            上警
          </button>
          <button class="btn btn-secondary" onclick="UI.runForSheriff(false)">
            不上警
          </button>
        </div>
      `;
    }
  }

  // 渲染警长投票界面
  renderSheriffVote() {
    const panel = $('action-panel');
    const votes = this.gameData.state.sheriff?.votes || {};
    const isPK = this.gameData.state.sheriff?.isPK;
    const candidates = isPK ? 
      this.gameData.state.sheriff?.pkCandidates : 
      Object.entries(this.gameData.state.sheriff?.candidates || {})
        .filter(([_, run]) => run)
        .map(([pid, _]) => pid);
    
    if (votes[this.playerId]) {
      panel.innerHTML = `<div class="text-muted">已投票给${votes[this.playerId]}号</div>`;
    } else {
      panel.innerHTML = `
        <div class="action-prompt">${isPK ? 'PK投票' : '警长投票'}</div>
        <div class="action-info">候选人：${candidates.join('、')}号</div>
        <div class="action-buttons">
          <button class="btn btn-primary" onclick="UI.voteSheriff()">
            投票给选中玩家
          </button>
          <button class="btn btn-secondary" onclick="UI.voteSheriff('0')">
            弃票
          </button>
        </div>
      `;
    }
  }

  // 渲染骑士行动界面
  renderKnightAction() {
    const panel = $('action-panel');
    const knightAction = this.actions?.[this.gameData.state.round]?.KNIGHT?.[this.playerId];
    
    if (knightAction) {
      panel.innerHTML = '<div class="text-muted">已发动决斗</div>';
    } else {
      panel.innerHTML = `
        <div class="action-prompt">骑士决斗</div>
        <div class="action-info">选择一名玩家进行决斗</div>
        <div class="action-buttons">
          <button class="btn btn-danger" onclick="UI.knightDuel()">
            决斗选中玩家
          </button>
        </div>
      `;
    }
  }

  // 渲染白天投票界面
  renderDayVote() {
    const panel = $('action-panel');
    const votes = this.actions?.[this.gameData.state.round]?.DAY_VOTE || {};
    
    if (votes[this.playerId]) {
      panel.innerHTML = `<div class="text-muted">已投票给${votes[this.playerId]}号</div>`;
    } else {
      panel.innerHTML = `
        <div class="action-prompt">放逐投票</div>
        <div class="action-buttons">
          <button class="btn btn-primary" onclick="UI.dayVote()">
            投票放逐选中玩家
          </button>
          <button class="btn btn-secondary" onclick="UI.dayVote('0')">
            弃票
          </button>
        </div>
      `;
    }
  }

  // 渲染猎人开枪界面
  renderHunterAction() {
    const panel = $('action-panel');
    const hunterAction = this.actions?.[this.gameData.state.round]?.HUNTER?.[this.playerId];
    
    if (hunterAction) {
      panel.innerHTML = `<div class="text-muted">已开枪带走${hunterAction.target}号</div>`;
    } else {
      panel.innerHTML = `
        <div class="action-prompt">猎人开枪</div>
        <div class="action-buttons">
          <button class="btn btn-danger" onclick="UI.hunterShoot()">
            开枪带走选中玩家
          </button>
          <button class="btn btn-secondary" onclick="UI.hunterShoot('0')">
            不开枪
          </button>
        </div>
      `;
    }
  }

  // 渲染警徽移交界面
  renderBadgeTransfer() {
    const panel = $('action-panel');
    const badgeAction = this.actions?.[this.gameData.state.round]?.BADGE?.[this.playerId];
    
    if (badgeAction) {
      panel.innerHTML = `<div class="text-muted">已移交警徽</div>`;
    } else {
      panel.innerHTML = `
        <div class="action-prompt">警徽移交</div>
        <div class="action-buttons">
          <button class="btn btn-primary" onclick="UI.transferBadge()">
            移交给选中玩家
          </button>
          <button class="btn btn-secondary" onclick="UI.transferBadge('0')">
            撕毁警徽
          </button>
        </div>
      `;
    }
  }

  // 渲染主持人面板
  renderHostPanel() {
    const isHost = String(this.playerId) === String(this.gameData.state.host);
    const panel = $('host-panel');
    
    if (!panel || !isHost) {
      if (panel) panel.classList.add('hidden');
      return;
    }
    
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <h3>主持人控制</h3>
      <div class="host-controls">
        <button class="btn btn-warning" onclick="UI.restartGame()">
          重新发牌
        </button>
      </div>
    `;
  }

  // 渲染上帝视角
  renderGodView() {
    const content = $('god-content');
    if (!content) return;
    
    let html = '<div class="god-tables">';
    
    // 玩家信息表
    html += `
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
    
    const players = Object.values(this.gameData.players).sort((a, b) => a.id - b.id);
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
    `;
    
    // 游戏状态
    html += `
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">游戏状态</h3>
        </div>
        <div class="card-body">
          <div class="god-status">
            <p>当前阶段：${this.getPhaseText()}</p>
            <p>平安夜数：${this.gameData.state.peace || 0}</p>
            <p>隐狼状态：${this.gameData.state.hiddenActive ? '已激活' : '未激活'}</p>
          </div>
        </div>
      </div>
    `;
    
    html += '</div>';
    content.innerHTML = html;
  }

  // 选择玩家
  selectPlayer(playerId) {
    // 移除之前的选中状态
    $$('.player-card').forEach(card => {
      card.classList.remove('selected');
    });
    
    // 添加新的选中状态
    const cards = $$(`[data-player-id="${playerId}"]`);
    cards.forEach(card => {
      card.classList.add('selected');
    });
    
    this.selectedPlayer = playerId;
  }

  // 显示日志
  async showLogs() {
    const logsSnap = await db.ref(`games/${this.gameId}/logs`).once('value');
    const logs = logsSnap.val() || {};
    
    const content = $('logs-content');
    content.innerHTML = '';
    
    // 按时间排序
    const sorted = Object.values(logs).sort((a, b) => a.ts - b.ts);
    
    for (const log of sorted) {
      // 上帝视角或非秘密日志
      if (this.playerId === '0' || !log.secret) {
        const item = document.createElement('div');
        item.className = 'log-item';
        item.innerHTML = `
          <span class="log-round">第${log.round}轮</span>
          ${escapeHtml(log.msg)}
        `;
        content.appendChild(item);
      }
    }
    
    const modal = $('logs-modal');
    if (modal) modal.classList.add('active');
  }

  // 关闭模态框
  closeModal() {
    $$('.modal').forEach(modal => {
      modal.classList.remove('active');
    });
  }

  // 交换身份
  async swapIdentities() {
    const me = this.gameData.players[this.playerId];
    const swapped = [me.identities[1], me.identities[0]];
    
    await db.ref(`games/${this.gameId}/players/${this.playerId}/identities`).set(swapped);
    this.showNotification('身份已交换', 'success');
  }

  // 确认准备
  async confirmReady() {
    await db.ref(`games/${this.gameId}/players/${this.playerId}/isReady`).set(true);
    this.showNotification('已准备', 'success');
  }

  // 开始游戏
  async startGame() {
    if (String(this.playerId) !== String(this.gameData.state.host)) {
      this.showNotification('只有主持人可以开始游戏', 'error');
      return;
    }
    
    await db.ref(`games/${this.gameId}/state`).update({
      phase: PHASE.NIGHT,
      round: 1,
      hiddenActive: false
    });
    
    await this.engine.log('游戏开始！', false);
  }

  // 重新发牌
  async restartGame() {
    if (String(this.playerId) !== String(this.gameData.state.host)) {
      this.showNotification('只有主持人可以重新发牌', 'error');
      return;
    }
    
    if (!confirm('确定要重新发牌吗？这将重置整个游戏。')) {
      return;
    }
    
    try {
      // 获取原配置
      const config = this.gameData.config;
      const rolePool = [];
      
      for (const [role, count] of Object.entries(config.roleCount)) {
        for (let i = 0; i < count; i++) {
          rolePool.push(role);
        }
      }
      
      // 重新发牌
      const pairs = dealCards(rolePool);
      const players = {};
      
      pairs.forEach((pair, index) => {
        const pid = index + 1;
        players[pid] = {
          id: pid,
          name: `玩家${pid}`,
          identities: pair,
          deaths: 0,
          isAlive: true,
          isReady: false,
          badge: 0,
          skill: {}
        };
      });
      
      // 重置游戏状态
      await db.ref(`games/${this.gameId}`).update({
        players,
        state: {
          phase: PHASE.LOBBY,
          round: 0,
          host: this.gameData.state.host,
          peace: 0
        },
        actions: {},
        logs: []
      });
      
      this.showNotification('游戏已重置', 'success');
      
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  // === 游戏行动方法 ===
  
  // 狼人投票
  async wolfVote() {
    if (!this.selectedPlayer) {
      this.showNotification('请先选择目标', 'error');
      return;
    }
    
    const round = this.gameData.state.round;
    await db.ref(`games/${this.gameId}/actions/${round}/NIGHT/WOLF/votes/${this.playerId}`)
      .set(this.selectedPlayer);
    
    this.showNotification('已投票', 'success');
  }

  // 狼人确认
  async wolfConfirm() {
    if (!this.selectedPlayer) {
      this.showNotification('请先选择目标', 'error');
      return;
    }
    
    const round = this.gameData.state.round;
    await db.ref(`games/${this.gameId}/actions/${round}/NIGHT/WOLF`)
      .update({ final: this.selectedPlayer });
    
    this.showNotification('已确认目标', 'success');
  }

  // 预言家查验
  async seerCheck() {
    if (!this.selectedPlayer) {
      this.showNotification('请先选择目标', 'error');
      return;
    }
    
    const round = this.gameData.state.round;
    const target = this.gameData.players[this.selectedPlayer];
    const mode = this.gameData.settings?.seerMode || 'faction';
    
    let result;
    if (mode === 'identity') {
      // 查身份
      const activeRole = this.engine.getActiveRole(target);
      if (activeRole === '隐狼' && !this.gameData.state.hiddenActive) {
        // 隐狼未激活，显示另一个身份
        const otherRole = target.identities.find(id => id.role !== '隐狼')?.role;
        result = otherRole || '未知';
      } else {
        result = activeRole;
      }
    } else {
      // 查阵营
      const hasWolf = target.identities.some(id => id.role === '狼人' || id.role === '隐狼');
      if (hasWolf) {
        const isHidden = target.identities.some(id => id.role === '隐狼');
        if (isHidden && !this.gameData.state.hiddenActive) {
          result = '好人阵营';
        } else {
          result = '狼人阵营';
        }
      } else {
        result = '好人阵营';
      }
    }
    
    await db.ref(`games/${this.gameId}/actions/${round}/NIGHT/SEER/${this.playerId}`)
      .set({ target: this.selectedPlayer, result });
    
    this.showNotification('查验完成', 'success');
  }

  // 守卫守护
  async guardProtect() {
    if (!this.selectedPlayer) {
      this.showNotification('请先选择目标', 'error');
      return;
    }
    
    const me = this.gameData.players[this.playerId];
    const lastGuard = me.skill?.lastGuard;
    
    if (String(lastGuard) === String(this.selectedPlayer)) {
      this.showNotification('不能连续守护同一人', 'error');
      return;
    }
    
    const round = this.gameData.state.round;
    await db.ref(`games/${this.gameId}/actions/${round}/NIGHT/GUARD/${this.playerId}`)
      .set({ target: this.selectedPlayer });
    
    this.showNotification('守护成功', 'success');
  }

  // 守卫空守
  async guardEmpty() {
    const round = this.gameData.state.round;
    await db.ref(`games/${this.gameId}/actions/${round}/NIGHT/GUARD/${this.playerId}`)
      .set({ target: '0' });
    
    this.showNotification('选择空守', 'success');
  }

  // 女巫解药
  async witchCure(target) {
    const round = this.gameData.state.round;
    await db.ref(`games/${this.gameId}/actions/${round}/NIGHT_WITCH/cures/${this.playerId}`)
      .set({ target });
    
    this.showNotification('使用解药', 'success');
  }

  // 女巫毒药
  async witchPoison() {
    if (!this.selectedPlayer) {
      this.showNotification('请先选择目标', 'error');
      return;
    }
    
    const round = this.gameData.state.round;
    await db.ref(`games/${this.gameId}/actions/${round}/NIGHT_WITCH/poisons/${this.playerId}`)
      .set({ target: this.selectedPlayer });
    
    this.showNotification('使用毒药', 'success');
  }

  // 女巫不用药
  async witchPass() {
    const round = this.gameData.state.round;
    await db.ref(`games/${this.gameId}/actions/${round}/NIGHT_WITCH/done/${this.playerId}`)
      .set(true);
    
    this.showNotification('不使用药水', 'success');
  }

  // 竞选警长
  async runForSheriff(isRunning) {
    await db.ref(`games/${this.gameId}/state/sheriff/candidates/${this.playerId}`)
      .set(isRunning);
    
    this.showNotification(isRunning ? '已上警' : '放弃竞选', 'success');
  }

  // 警长投票
  async voteSheriff(target = null) {
    if (!target && !this.selectedPlayer) {
      this.showNotification('请先选择目标', 'error');
      return;
    }
    
    const voteTarget = target || this.selectedPlayer;
    await db.ref(`games/${this.gameId}/state/sheriff/votes/${this.playerId}`)
      .set(voteTarget);
    
    this.showNotification(voteTarget === '0' ? '已弃票' : `投票给${voteTarget}号`, 'success');
  }

  // 骑士决斗
  async knightDuel() {
    if (!this.selectedPlayer) {
      this.showNotification('请先选择目标', 'error');
      return;
    }
    
    if (!confirm(`确定要决斗${this.selectedPlayer}号玩家吗？如果对方是好人，你将死亡！`)) {
      return;
    }
    
    const round = this.gameData.state.round;
    await db.ref(`games/${this.gameId}/actions/${round}/KNIGHT/${this.playerId}`)
      .set({ target: this.selectedPlayer });
    
    // 标记骑士已使用技能
    await db.ref(`games/${this.gameId}/players/${this.playerId}/skill/knightUsed`)
      .set(true);
    
    this.showNotification('发动决斗！', 'success');
  }

  // 白天投票
  async dayVote(target = null) {
    if (!target && !this.selectedPlayer) {
      this.showNotification('请先选择目标', 'error');
      return;
    }
    
    const voteTarget = target || this.selectedPlayer;
    const round = this.gameData.state.round;
    await db.ref(`games/${this.gameId}/actions/${round}/DAY_VOTE/${this.playerId}`)
      .set(voteTarget);
    
    this.showNotification(voteTarget === '0' ? '已弃票' : `投票放逐${voteTarget}号`, 'success');
  }

  // 猎人开枪
  async hunterShoot(target = null) {
    if (!target && !this.selectedPlayer) {
      this.showNotification('请先选择目标', 'error');
      return;
    }
    
    const shootTarget = target || this.selectedPlayer;
    const round = this.gameData.state.round;
    await db.ref(`games/${this.gameId}/actions/${round}/HUNTER/${this.playerId}`)
      .set({ target: shootTarget });
    
    this.showNotification(shootTarget === '0' ? '不开枪' : `开枪带走${shootTarget}号`, 'success');
  }

  // 警徽移交
  async transferBadge(target = null) {
    if (!target && !this.selectedPlayer) {
      this.showNotification('请先选择目标', 'error');
      return;
    }
    
    const badgeTarget = target || this.selectedPlayer;
    const round = this.gameData.state.round;
    await db.ref(`games/${this.gameId}/actions/${round}/BADGE/${this.playerId}`)
      .set({ target: badgeTarget });
    
    this.showNotification(badgeTarget === '0' ? '撕毁警徽' : `警徽移交给${badgeTarget}号`, 'success');
  }

  // 清理监听器
  destroy() {
    this.listeners.forEach(ref => ref.off());
    this.listeners = [];
    
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }
}

/* ==================================================================
 * 7. 全局初始化
 * ================================================================== */

// 创建全局UI实例
const UI = new UIManager();

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
  UI.init();
});

// 页面卸载时清理
window.addEventListener('beforeunload', () => {
  UI.destroy();
});

// 导出给HTML使用的全局方法
window.UI = {
  // 大厅操作
  swapIdentities: () => UI.swapIdentities(),
  confirmReady: () => UI.confirmReady(),
  startGame: () => UI.startGame(),
  restartGame: () => UI.restartGame(),
  
  // 狼人行动
  wolfVote: () => UI.wolfVote(),
  wolfConfirm: () => UI.wolfConfirm(),
  
  // 预言家行动
  seerCheck: () => UI.seerCheck(),
  
  // 守卫行动
  guardProtect: () => UI.guardProtect(),
  guardEmpty: () => UI.guardEmpty(),
  
  // 女巫行动
  witchCure: (target) => UI.witchCure(target),
  witchPoison: () => UI.witchPoison(),
  witchPass: () => UI.witchPass(),
  
  // 警长相关
  runForSheriff: (isRunning) => UI.runForSheriff(isRunning),
  voteSheriff: (target) => UI.voteSheriff(target),
  
  // 白天行动
  knightDuel: () => UI.knightDuel(),
  dayVote: (target) => UI.dayVote(target),
  
  // 特殊行动
  hunterShoot: (target) => UI.hunterShoot(target),
  transferBadge: (target) => UI.transferBadge(target)
};

console.log('🐺 双身份狼人杀系统已加载完成');

/* ==================================================================
 * 修复说明：
 * 1. 流程重复判定：添加了processingPhases和processedActions集合防止重复
 * 2. 金宝宝保证：发牌时强制要求至少一个金宝宝
 * 3. 上帝视角：实现了完整的上帝视角界面
 * 4. 日志系统：区分公开和秘密日志
 * 5. 角色技能：修复了女巫自救规则、猎人触发条件、守卫连守限制等
 * 6. 游戏流程：修复了首夜警长竞选、黎明结算、死亡处理等
 * 7. 重开游戏：实现了主持人重新发牌功能
 * ================================================================== */
