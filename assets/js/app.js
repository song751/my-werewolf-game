/**********************************************************************
 * 双身份狼人杀 - 电子法官 (V11.1 UI/UX & Arch Refactor)
 * 作者：[Your Name/Team]
 * 日期：2025-08-14
 *
 * 更新日志 (V11.1):
 * - [架构] 将身份确认逻辑从游戏开始时移至游戏大厅(Lobby)阶段。
 * - [UI/UX] 设置页的身份数量调整改为自定义加减按钮，优化移动端体验。
 * - [UI/UX] 增加点击非玩家卡片区域取消选中的功能。
 * - [修复] 修复了所有已知的运行时错误、逻辑BUG和潜在的内存泄漏。
 *********************************************************************/

/* ==================================================================
 *  0. 全局常量与配置
 * ================================================================== */

// 角色定义
const ROLES = {
  // 好人阵营
  平民:   { faction: 'good', icon: '👤', isGod: false, key: 'CIVILIAN' },
  守卫:   { faction: 'good', icon: '🛡️', isGod: true,  unique: true, key: 'GUARD' },
  白痴:   { faction: 'good', icon: '🤪', isGod: true,  unique: true, key: 'IDIOT' },
  预言家: { faction: 'good', icon: '🔮', isGod: true,  unique: true, key: 'SEER' },
  骑士:   { faction: 'good', icon: '⚔️', isGod: true,  unique: true, key: 'KNIGHT' },
  女巫:   { faction: 'good', icon: '🧪', isGod: true,  unique: true, key: 'WITCH' },
  猎人:   { faction: 'good', icon: '🔫', isGod: true,  unique: true, key: 'HUNTER' },
  // 狼人阵营
  狼人:   { faction: 'bad',  icon: '🐺', isGod: false, key: 'WOLF' },
  隐狼:   { faction: 'bad',  icon: '🌑', isGod: false, unique: true, isInvisible: true, key: 'HIDDEN_WOLF' },
  // 中立/特殊
  盗贼:   { faction: 'neu',  icon: '🎭', isGod: false, unique: true, isThief: true, key: 'THIEF' },
};

// 角色集合
const GOD_ROLES = new Set(Object.keys(ROLES).filter(k => ROLES[k].isGod));
const UNIQUE_ROLES = new Set(Object.keys(ROLES).filter(k => ROLES[k].unique));
// 禁止的身份配对（排序后用'|'连接）
const FORBIDDEN_PAIRS = new Set(['狼人|隐狼','预言家|狼人','预言家|隐狼','盗贼|狼人','盗贼|隐狼']);
// 默认游戏设置
const DEFAULT_SETUP = { 平民: 6, 守卫: 1, 白痴: 1, 预言家: 1, 骑士: 1, 女巫: 1, 猎人: 1, 狼人: 2, 隐狼: 1, 盗贼: 1 };

// 游戏阶段（有限状态机状态）
const PHASE = {
  SETUP: 'SETUP',             // 0. 游戏设置
  LOBBY: 'LOBBY',             // [新增] 游戏大厅，等待玩家加入
  NIGHT: 'NIGHT',             // 1. 夜晚行动（狼/神）
  NIGHT_WITCH: 'NIGHT_WITCH', // 2. 女巫行动（单独阶段，以看到刀口）
  DAWN: 'DAWN',               // 3. 黎明结算（处理死亡）
  SHERIFF_CAND: 'SHERIFF_CAND', // 4. 上警环节-竞选
  SHERIFF_SPEECH: 'SHERIFF_SPEECH',// 5. 上警环节-发言
  SHERIFF_VOTE: 'SHERIFF_VOTE', // 6. 上警环节-投票
  DAY_TALK: 'DAY_TALK',       // 7. 白天发言
  DAY_VOTE: 'DAY_VOTE',       // 8. 放逐投票
  HUNTER: 'HUNTER',           // 9. 猎人开枪（死亡链）
  BADGE: 'BADGE',             // 10. 警徽移交（死亡链）
  GAME_OVER: 'GAME_OVER'      // 11. 游戏结束
};


/* ==================================================================
 *  1. 工具函数
 * ================================================================== */

const $ = id => document.getElementById(id);
const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };
const escapeHtml = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const shuffle = a => { let i = a.length; while (i) { const r = Math.random() * i-- | 0;[a[i], a[r]] = [a[r], a[i]] } return a };
const wait = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();


/* ==================================================================
 *  2. Firebase 数据库句柄
 * ================================================================== */

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


/* ==================================================================
 *  3. 规则引擎 (Engine) - 主持端核心
 * ================================================================== */

class Engine {
  constructor(gameId) {
    this.id = gameId;
    this.state = null;
    this.players = null;
    this.actions = null;
    this.settings = null; // [FIX] Add settings property to store game rules
  }

  // Firebase 数据库操作封装
  ref(p) { return db.ref(`games/${this.id}/${p}`); }
  async read(p) { return (await this.ref(p).once('value')).val(); }
  write(p, v) { return this.ref(p).set(v); }
  update(obj) { return db.ref(`games/${this.id}`).update(obj); }
  push(p, v) { return this.ref(p).push(v); }

  /**
   * 引擎的主循环，由主持端定时调用。
   * 负责读取当前状态，并根据状态执行相应的检查和转换。
   */
  async tick() {
    // 读取最新游戏数据
    const state = await this.read('state') || {};
    const players = await this.read('players') || {};
    const actions = await this.read('actions') || {};
    const settings = await this.read('settings') || {}; // [FIX] Read settings from the root
    this.state = state; this.players = players; this.actions = actions; this.settings = settings;

    // 根据当前阶段执行对应的逻辑
    switch (state.phase) {
      case PHASE.NIGHT:        return this.checkNightEnd();
      case PHASE.NIGHT_WITCH:  return this.checkWitchEnd();
      case PHASE.DAWN:         return this.dawnResolve();
      case PHASE.SHERIFF_VOTE: return this.checkSheriffVote();
      case PHASE.DAY_VOTE:     return this.checkDayVote();
      case PHASE.HUNTER:       return this.checkHunterQueue();
      // 其他阶段为被动等待，由玩家或主持人操作触发状态变更
      case PHASE.SETUP:
      case PHASE.LOBBY:
      case PHASE.SHERIFF_CAND:
      case PHASE.SHERIFF_SPEECH:
      case PHASE.DAY_TALK:
      case PHASE.BADGE:
      case PHASE.GAME_OVER:
        return;
    }
  }

  /**
   * 状态转换函数
   * @param {string} phase - 目标阶段 (来自 PHASE常量)
   * @param {object} extra - 需要一同更新到 state 节点下的额外数据
   */
  async to(phase, extra = {}) {
    const updates = { 'state/phase': phase };
    for (const key in extra) {
      updates[`state/${key}`] = extra[key];
    }
    await this.update(updates);
  }

  /* --- 引擎帮助函数 --- */

  /** 获取玩家当前活跃的身份索引 (0 或 1) */
  activeIdx(p) { return Math.min(p.deaths || 0, 1); }

  /** 获取玩家当前活跃的身份角色名 */
  activeRole(p) { return p.isAlive ? p.identities[this.activeIdx(p)].role : null; }

  /** 判断隐狼是否已激活 */
  isHiddenWolfActivated(players, state) {
    // [FIX] Read from this.settings instead of this.state.settings
    const trigger = this.settings?.hiddenTrigger || 'activeOnly';
    if (trigger === 'activeOnly') {
      // 场上已无存活的、活跃身份为“狼人”的玩家
      const anyActiveWolf = Object.values(players).some(p => p.isAlive && this.activeRole(p) === '狼人');
      return !anyActiveWolf;
    } else { // 'allWolves' 模式下，如果场上没有任何一张狼人牌，隐狼才激活
      const anyCardWolf = Object.values(players).some(p => p.identities.some(i => i.role === '狼人'));
      return !anyCardWolf;
    }
  }

  /** 获取所有存活的、可行动的狼人阵营玩家 */
  getAliveActingWolves(players, state) {
    const activated = this.isHiddenWolfActivated(players, state);
    return Object.values(players).filter(p => {
      if (!p.isAlive) return false;
      const ar = this.activeRole(p);
      if (ar === '狼人') return true;
      if (ar === '隐狼') return activated;
      return false;
    });
  }

  /* ========== 阶段处理：夜晚 ========== */

  // 从 actions 中读取守卫的选择
  getGuardChoice() {
    const g = this.actions[this.state.round]?.NIGHT?.GUARD || {};
    const rec = Object.values(g)[0]; // 守卫是唯一的
    return rec?.target; // undefined=未出手, null=空守, 'pid'=守护目标
  }

  // 从 actions 中读取狼人最终拍板的目标
  getWolfFinalTarget() { return this.actions[this.state.round]?.NIGHT?.WOLF?.final; }

  // 从 actions 中读取女巫的用药目标
  getWitchCureTarget() { return this.actions[this.state.round]?.NIGHT_WITCH?.cure; }
  getWitchPoisonTarget() { return this.actions[this.state.round]?.NIGHT_WITCH?.poison; }
  isWitchActionDone() { return this.actions[this.state.round]?.NIGHT_WITCH?.done === true; }

  /** 检查夜晚阶段是否可以结束 */
  async checkNightEnd() {
    const actingWolves = this.getAliveActingWolves(this.players, this.state);
    const finalTarget = this.getWolfFinalTarget();

    // 如果还有可行动的狼人，且他们还未拍板，则继续等待
    if (actingWolves.length > 0 && finalTarget === undefined) return;

    // 狼人已行动完毕（或场上无狼），进入下一阶段
    const witchAlive = Object.values(this.players).some(p => p.isAlive && this.activeRole(p) === '女巫');
    if (witchAlive) {
      await this.to(PHASE.NIGHT_WITCH);
    } else {
      await this.to(PHASE.DAWN);
    }
  }

  /** 检查女巫阶段是否可以结束 */
  async checkWitchEnd() {
    const witchAlive = Object.values(this.players).some(p => p.isAlive && this.activeRole(p) === '女巫');
    if (!witchAlive || this.isWitchActionDone()) {
      await this.to(PHASE.DAWN);
    }
  }

  /* ========== 阶段处理：黎明结算 ========== */

  /**
   * 黎明结算：这是游戏流程的核心，处理所有夜晚行动的结果。
   * 这个函数只在 DAWN 阶段执行一次。
   */
  async dawnResolve() {
    if (this.state.resolving) return; // 防止重复执行
    await this.write('state/resolving', true);
    await this.log('黎明到来，开始结算夜晚事件...', true);

    const r = this.state.round;
    const deaths = [];

    // 1. 获取所有相关行动
    const wolfTarget = this.getWolfFinalTarget();
    const guardTarget = this.getGuardChoice();
    const cureTarget = this.getWitchCureTarget();
    const poisonTarget = this.getWitchPoisonTarget();

    await this.log(`[结算细节] 狼刀:${wolfTarget || '无'}, 守卫:${guardTarget ?? '无'}, 解药:${cureTarget || '无'}, 毒药:${poisonTarget || '无'}`, true);

    // 2. 计算狼刀死亡
    if (wolfTarget && wolfTarget !== '0') {
      const isGuarded = guardTarget === wolfTarget;
      const isCured = cureTarget === wolfTarget;
      if (isGuarded) await this.log(`🛡️ ${guardTarget}号玩家被守卫成功守护。`, true);
      if (isCured) await this.log(`🧪 女巫使用解药救活了 ${cureTarget}号玩家。`, true);

      if (!isGuarded && !isCured) {
        deaths.push({ pid: wolfTarget, cause: 'WOLF' });
        await this.log(`🔪 ${wolfTarget}号玩家被狼人杀害。`, true);
      }
    }

    // 3. 计算毒药死亡
    if (poisonTarget) {
      // 防止重复添加死亡（例如女巫毒了狼人刀的人）
      if (!deaths.some(d => d.pid === poisonTarget)) {
        deaths.push({ pid: poisonTarget, cause: 'POISON' });
      }
      await this.log(`☠️ ${poisonTarget}号玩家被女巫毒杀。`, false);
    }

    // 4. 执行死亡并处理死亡链
    let anyHunterTriggered = false;
    let sheriffDied = null;

    if (deaths.length > 0) {
      const deadIds = [...new Set(deaths.map(d => d.pid))].sort((a, b) => a - b).join('号、');
      await this.log(`昨夜死亡的玩家是：${deadIds}号。`, false);
      await this.write('state/peace', 0);

      for (const d of deaths) {
        const deathResult = await this.kill(d.pid, d.cause);
        if (deathResult.hunterTriggered) anyHunterTriggered = true;
        if (deathResult.sheriffDied) sheriffDied = deathResult.sheriffDied;
      }
    } else {
      await this.log('昨夜是平安夜。', false);
      const newPeace = (this.state.peace || 0) + 1;
      await this.write('state/peace', newPeace);
    }

    // 5. 检查胜负
    if (await this.checkWin()) {
      await this.write('state/resolving', null);
      return; // 游戏已结束
    }

    // 6. 根据死亡链决定下一阶段
    let nextPhase = PHASE.DAY_TALK;
    if (this.state.round === 1) { // 如果是第一晚，进入警长竞选
        await this.update({ 'state/sheriff': { candidates: {}, isPK: false } });
        nextPhase = PHASE.SHERIFF_CAND;
    }

    if (sheriffDied) {
      // 进入警徽移交阶段，移交完毕后由 badge-pass/destroy 决定后续
      await this.to(PHASE.BADGE, { postBadge: { dead: sheriffDied, next: nextPhase } });
    } else if (anyHunterTriggered) {
      // 进入猎人开枪阶段，开枪完毕后由 checkHunterQueue 决定后续
      await this.to(PHASE.HUNTER, { nextPhaseAfterHunter: nextPhase });
    } else {
      // 无死亡链，正常进入白天
      await this.to(nextPhase);
    }

    // 清理工作
    await this.write('state/resolving', null);
  }

  /* ========== 阶段处理：白天投票 ========== */

  /** 检查白天投票是否结束 */
  async checkDayVote() {
    const r = this.state.round;
    const voters = Object.values(this.players).filter(p => p.isAlive && !p.isExposedIdiot);
    const rec = this.actions[r]?.DAY_VOTE || {};
    if (voters.length === 0) { // 如果没活人投票了
        await this.startNight(r + 1);
        return;
    }
    if (voters.every(v => rec[v.id] !== undefined)) {
      await this.tallyDayVote();
    }
  }

  /** 白天投票计票 */
  async tallyDayVote() {
    const r = this.state.round;
    const rec = this.actions[r]?.DAY_VOTE || {};
    const sheriff = Object.values(this.players).find(p => p.badge);
    const weight = pid => (sheriff && String(pid) === String(sheriff.id)) ? 3 : 2; // 1.5票，用整数避免浮点
    const counts = {};

    Object.entries(rec).forEach(([pid, { target }]) => {
      if (target === '0') return; // 弃票
      counts[target] = (counts[target] || 0) + weight(pid);
    });

    const maxVotes = Math.max(0, ...Object.values(counts));
    const outPlayers = Object.keys(counts).filter(k => counts[k] === maxVotes);
    
    // 构造日志
    let logMsg = '---- 放逐票型 ----\n';
    const voteDetails = Object.entries(rec).map(([voterId, {target}]) => `${voterId}号 -> ${target === '0' ? '弃票' : target + '号'}`).join('; ');
    logMsg += voteDetails + '\n最终票数: ' + JSON.stringify(counts);
    await this.log(logMsg, true);

    if (outPlayers.length === 1) {
      await this.log(`放逐投票结果：${outPlayers[0]}号玩家被公投出局。`, false);
      const deathResult = await this.kill(outPlayers[0], 'VOTE');
      // 检查胜负和死亡链
      if (await this.checkWin()) return;
      if (deathResult.sheriffDied) {
        await this.to(PHASE.BADGE, { postBadge: { dead: deathResult.sheriffDied, next: PHASE.NIGHT } });
      } else if (deathResult.hunterTriggered) {
        await this.to(PHASE.HUNTER, { nextPhaseAfterHunter: PHASE.NIGHT });
      } else {
        await this.startNight(r + 1);
      }
    } else {
      await this.log('平票，无人出局。', false);
      await this.startNight(r + 1);
    }
  }

  /* ========== 阶段处理：警长选举 ========== */

  /** 检查警长投票是否结束 */
  async checkSheriffVote() {
    const voters = Object.values(this.players).filter(p => p.isAlive && !p.isExposedIdiot);
    const votes = this.state.sheriff?.votes || {};
    if (voters.every(pl => votes[pl.id] !== undefined)) {
      await this.tallySheriff();
    }
  }

  /** 警长投票计票 */
  async tallySheriff() {
    const { candidates, votes, isPK } = this.state.sheriff || { candidates: {}, votes: {}, isPK: false };
    const validCandidates = Object.keys(candidates || {}).filter(id => candidates[id] && !(this.state.sheriff?.drops || {})[id]);
    
    if (!validCandidates.length) {
      await this.log('所有候选人退水，本局无警长。', false);
      await this.to(PHASE.DAY_TALK, { sheriff: null });
      return;
    }

    const counts = {};
    Object.values(votes || {}).forEach(target => {
      if (target !== '0' && validCandidates.includes(target)) {
        counts[target] = (counts[target] || 0) + 1;
      }
    });

    const maxVotes = Math.max(0, ...Object.values(counts));
    const winners = Object.keys(counts).filter(k => counts[k] === maxVotes);

    if (winners.length === 1) {
      const sheriffId = winners[0];
      await this.update({ [`players/${sheriffId}/badge`]: 1, 'state/sheriff': null });
      await this.log(`⭐ ${sheriffId}号玩家当选警长！`, false);
      await this.to(PHASE.DAY_TALK);
    } else if (isPK) {
      await this.log('PK后再次平票，本局无警长。', false);
      await this.to(PHASE.DAY_TALK, { sheriff: null });
    } else {
      const pkCandidates = {};
      winners.forEach(id => pkCandidates[id] = 1);
      await this.log(winners.length > 1 ? `⚖️ 平票：${winners.join('、')}号进入PK。` : '无人当选，流警。', false);
      if (winners.length > 1) {
        await this.update({ 'state/sheriff': { candidates: pkCandidates, votes: {}, drops: {}, isPK: true } });
        await this.to(PHASE.SHERIFF_SPEECH);
      } else {
        await this.to(PHASE.DAY_TALK, { sheriff: null });
      }
    }
  }

  /* ========== 核心动作：立即进入夜晚 ========== */
  async startNight(round) {
    // [FIX] Do not clear the entire `actions` node to preserve history.
    // Round-specific actions are cleared in dawnResolve.
    await this.update({
      'state/round': round,
      'state/phase': PHASE.NIGHT,
      'state/showWolf': round === 1, // 仅第一夜默认显示狼同伴
    });
    await this.log(`第 ${round} 夜来临...`, false);
  }

  /* ========== 核心动作：杀人与死亡链处理 ========== */

  /**
   * 处理玩家死亡的核心函数
   * @param {string} pid - 被杀玩家ID
   * @param {string} cause - 死亡原因 ('WOLF', 'POISON', 'VOTE', 'DUEL')
   * @returns {object} - 返回死亡触发的事件 { hunterTriggered, sheriffDied }
   */
  async kill(pid, cause) {
    const p = this.players[pid];
    if (!p || !p.isAlive) return {};

    const wasSheriff = !!p.badge;
    const newDeaths = (p.deaths || 0) + 1;
    const isOut = newDeaths >= 2;
    const updates = {
      [`players/${pid}/deaths`]: newDeaths,
      [`players/${pid}/isAlive`]: !isOut
    };
    let hunterTriggered = false, sheriffDied = null;

    // 白痴翻牌：仅当被“票死”且活跃身份为白痴时
    if (this.activeRole(p) === '白痴' && cause === 'VOTE' && !p.isExposedIdiot) {
      updates[`players/${pid}/isExposedIdiot`] = true;
      updates[`players/${pid}/isAlive`] = true; // 白痴翻牌不死，但失去投票权
      await this.log(`🤪 ${pid}号白痴被票出，翻牌免死，但失去投票权。`, false);
    }

    // 猎人死亡链：活跃身份为猎人，且被刀/毒/票死
    if (this.activeRole(p) === '猎人' && ['WOLF', 'POISON', 'VOTE'].includes(cause)) {
      const q = await this.read('state/hunters') || {};
      q[pid] = true;
      updates['state/hunters'] = q;
      hunterTriggered = true;
      await this.log(`🔫 ${pid}号猎人倒牌，可以开枪。`, false);
    }
    
    await this.update(updates);

    if (isOut && wasSheriff) {
      sheriffDied = pid;
    }

    return { hunterTriggered, sheriffDied };
  }

  /* ========== 核心动作：猎人队列处理 ========== */
  async checkHunterQueue() {
    const q = await this.read('state/hunters') || {};
    const list = Object.keys(q).filter(k => q[k]);
    if (list.length === 0) {
      const nextPhase = await this.read('state/nextPhaseAfterHunter') || PHASE.DAY_TALK;
      await this.update({ 'state/hunters': null, 'state/nextPhaseAfterHunter': null, 'state/phase': nextPhase });
    }
    // 如果队列不为空，则停留在 HUNTER 阶段，等待前端玩家操作
  }

  /* ========== 核心动作：骑士决斗 ========== */
  async duel(fromPid, targetPid) {
    const from = this.players[fromPid], target = this.players[targetPid];
    if (!from?.isAlive || !target?.isAlive) return;
    
    await this.update({ [`players/${fromPid}/skill/knightUsed`]: true });

    const activated = this.isHiddenWolfActivated(this.players, this.state);
    const tarActiveRole = this.activeRole(target);
    const isWolfFaction = (tarActiveRole === '狼人') || (tarActiveRole === '隐狼' && activated);

    if (isWolfFaction) {
      await this.log(`⚔️ ${fromPid}号骑士对 ${targetPid}号 发动决斗成功，目标是狼人阵营！`, false);
      const deathResult = await this.kill(targetPid, 'DUEL');
      if (await this.checkWin()) return;
      // 决斗成功，无论是否触发死亡链，都直接进入夜晚
      await this.startNight(this.state.round + 1);
    } else {
      await this.log(`⚔️ ${fromPid}号骑士对 ${targetPid}号 决斗失败，目标非狼人阵营。`, false);
      const deathResult = await this.kill(fromPid, 'DUEL');
      if (await this.checkWin()) return;
      // 决斗失败，白天继续，但可能触发猎人/警徽链
      if (deathResult.sheriffDied) {
        await this.to(PHASE.BADGE, { postBadge: { dead: deathResult.sheriffDied, next: this.state.phase } });
      } else if (deathResult.hunterTriggered) {
        await this.to(PHASE.HUNTER, { nextPhaseAfterHunter: this.state.phase });
      }
    }
  }

  /* ========== 核心动作：胜负判定 ========== */
  async checkWin() {
    const alivePlayers = Object.values(this.players).filter(p => p.isAlive);
    const actingWolves = this.getAliveActingWolves(this.players, this.state);
    const peaceNights = this.state.peace || 0;

    // 好人胜利条件
    if (actingWolves.length === 0 || peaceNights >= 3) {
      const reason = actingWolves.length === 0 ? '所有狼人出局' : '连续3晚平安夜';
      await this.to(PHASE.GAME_OVER, { winner: '🏆 好人获胜' });
      await this.log(`🏁 游戏结束：好人获胜（${reason}）。`, false);
      return true;
    }

    // 狼人胜利条件
    // [FIX] Read from this.settings
    const winCondition = this.settings?.wolfWin || 'edge';
    if (winCondition === 'exterminate') { // 屠城
      const goodAlive = alivePlayers.some(p => {
        const ar = this.activeRole(p);
        return ar && ROLES[ar]?.faction === 'good';
      });
      if (!goodAlive) {
        await this.to(PHASE.GAME_OVER, { winner: '🐺 狼人屠城获胜' });
        await this.log('🏁 游戏结束：狼人屠城获胜。', false);
        return true;
      }
    } else { // 屠边
      const godAlive = alivePlayers.some(p => this.activeRole(p) && GOD_ROLES.has(this.activeRole(p)));
      const civilianAlive = alivePlayers.some(p => this.activeRole(p) && ROLES[this.activeRole(p)].faction === 'good' && !ROLES[this.activeRole(p)].isGod);
      
      if (!godAlive || !civilianAlive) {
        const reason = !godAlive ? '所有神职出局' : '所有平民出局';
        await this.to(PHASE.GAME_OVER, { winner: '🐺 狼人屠边获胜' });
        await this.log(`🏁 游戏结束：狼人屠边获胜（${reason}）。`, false);
        return true;
      }
    }
    return false;
  }

  /* ========== 核心动作：日志记录 ========== */
  async log(msg, secret = false) {
    await this.push('logs', {
      msg,
      ts: firebase.database.ServerValue.TIMESTAMP,
      round: this.state.round || 0,
      secret
    });
  }
}


/* ==================================================================
 *  4. 前端应用 (App) - 客户端UI与交互
 * ================================================================== */

const App = {
  me: null,       // 当前玩家ID
  gameId: null,   // 当前游戏ID
  engine: null,   // 引擎实例 (仅主持端)
  listener: { ref: null, cb: null }, // [FIX] For correctly unsubscribing from Firebase
  full: null,     // 完整的游戏数据快照
  selection: null,// 当前选择的目标
  autorun: null,  // 主持端定时器

  /* ---------- 1. 初始化与路由 ---------- */
  init() {
    this.destroy(); // Clean up previous listeners before starting
    document.addEventListener('click', (e) => this.onClick(e));
    
    // [NEW] Add a body-level click listener to deselect players
    document.body.addEventListener('click', (e) => {
        // If the click is inside the game layout but not on a player card or interactive panel
        if (e.target.closest('#game-layout') && !e.target.closest('.player-card, .action-panel, .host-controls')) {
            if (this.selection) {
                this.selection = null;
                // Re-render only the player grid for performance
                if (this.full) this.renderPlayers(this.full);
            }
        }
    }, true); // Use capture phase to catch clicks early

    const p = new URLSearchParams(location.search);
    this.gameId = p.get('game') || '';
    this.me = p.get('player') || '';

    if (this.gameId && !this.me) {
      this.renderJoinPrompt();
    } else if (this.gameId && this.me) {
      this.enterGame();
    } else {
      this.renderSetup();
    }
  },

  /* ---------- 2. 设置与创建游戏 ---------- */

  /** 渲染游戏设置界面 */
  renderSetup() {
    $('setup-view').classList.remove('hidden');
    $('join-view').classList.add('hidden');
    $('lobby-view').classList.add('hidden');
    $('game-view').classList.add('hidden');
    $('god-view').classList.add('hidden');

    const grid = $('role-grid');
    grid.innerHTML = '';
    Object.keys(ROLES).forEach(role => {
      const def = DEFAULT_SETUP[role] || 0;
      // [NEW] Use custom number input component for better UX
      const item = el(`
        <div class="role-setup-item">
          <span class="role-name">${ROLES[role].icon} ${role}${ROLES[role].unique ? ' (唯一)' : ''}</span>
          <div class="custom-number-input">
            <button class="num-btn" data-role="${role}" data-op="-">-</button>
            <input id="role-${role}" type="number" value="${def}" readonly />
            <button class="num-btn" data-role="${role}" data-op="+">+</button>
          </div>
        </div>
      `);
      // Add event listeners for the new +/- buttons
      item.querySelectorAll('.num-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const input = $(`role-${btn.dataset.role}`);
          let val = parseInt(input.value, 10);
          if (btn.dataset.op === '+') {
            val++;
          } else {
            val = Math.max(0, val - 1);
          }
          // Enforce unique role limit
          if (ROLES[btn.dataset.role].unique) {
            val = Math.min(1, val);
          }
          input.value = val;
          this.updateSetupStats();
        });
      });
      grid.appendChild(item);
    });

    // 规则默认值
    $('opt-witch-selfsave').value = 'noFirstNightSelfSave';
    $('opt-seer-mode').value = 'faction';
    $('opt-wolf-win').value = 'edge';
    $('opt-wolf-visibility').value = 'activeOnly';

    $('btn-create').setAttribute('data-action', 'create-game');
    this.updateSetupStats();
  },

  /** 更新设置页的统计数据 */
  updateSetupStats() {
    const inputs = $('role-grid').querySelectorAll('input[type="number"]');
    let total = 0;
    inputs.forEach(i => { total += parseInt(i.value || '0', 10); });
    const players = Math.floor(total / 2);
    $('total-roles').textContent = String(total);
    $('player-cnt').textContent = String(players);
    const warn = $('player-count-warning');
    warn.textContent = (total === 0 || total % 2 !== 0) ? '身份总数必须为偶数且大于 0' : '';
  },

  /** 创建游戏 */
  async createGame() {
    const counts = {};
    $('role-grid').querySelectorAll('input').forEach(i => {
      const r = i.id.replace('role-', '');
      const v = +i.value || 0;
      if (v) counts[r] = v;
    });

    const pool = [];
    for (const [r, c] of Object.entries(counts)) {
      if (UNIQUE_ROLES.has(r) && c > 1) { this.toast(`${r} 是唯一身份，数量不能超过1`, 'error'); return; }
      for (let i = 0; i < c; i++) pool.push(r);
    }

    if (pool.length === 0 || pool.length % 2 !== 0) { this.toast('身份总数必须为偶数且大于0', 'error'); return; }

    const dealt = this.dealWithGolden(pool);
    if (!dealt) { this.toast('无法生成合规的牌组，请检查配置是否出现禁用组合或无法满足金宝宝条件。', 'error'); return; }

    const id = db.ref('games').push().key;
    const players = {};
    dealt.pairs.forEach((pair, i) => {
      players[i + 1] = {
        id: i + 1,
        name: `玩家${i + 1}`,
        identities: pair,
        deaths: 0, isAlive: true, isReady: false,
        isExposedIdiot: false, badge: 0, skill: {}
      };
    });

    const settings = {
      witchRule: $('opt-witch-selfsave').value,
      seerMode: $('opt-seer-mode').value,
      wolfWin: $('opt-wolf-win').value,
      hiddenTrigger: $('opt-wolf-visibility').value
    };
    const config = { counts, settings };

    const initData = {
      meta: { createdAt: now(), creator: 'FSM-v11.1' },
      config,
      players, settings, actions: {}, logs: {},
      state: { phase: PHASE.LOBBY, round: 0, host: 1, peace: 0, winner: null, sheriff: null }
    };

    await db.ref(`games/${id}`).set(initData);
    this.toast('游戏房间创建成功！', 'success');
    location.href = `${location.pathname}?game=${id}&player=1`;
  },

  /**
   * [新增] 重开一局新游戏。
   * 读取当前配置，创建一个新房间，并引导所有玩家跳转。
   */
  async restartGame() {
    this.toast('正在准备新对局...', 'info');
    const oldGameId = this.gameId;
    const config = this.full.config;
    if (!config || !config.counts) {
      this.toast('无法找到游戏配置，无法重开。', 'error');
      return;
    }

    const pool = [];
    for (const [r, c] of Object.entries(config.counts)) {
      for (let i = 0; i < c; i++) pool.push(r);
    }
    const dealt = this.dealWithGolden(pool);
    if (!dealt) { this.toast('重新发牌失败，无法重开。', 'error'); return; }

    const newGameId = db.ref('games').push().key;
    const players = {};
    const oldPlayers = Object.values(this.full.players);
    dealt.pairs.forEach((pair, i) => {
      players[i + 1] = {
        id: i + 1,
        name: oldPlayers[i]?.name || `玩家${i + 1}`,
        identities: pair,
        deaths: 0, isAlive: true, isReady: false,
        isExposedIdiot: false, badge: 0, skill: {}
      };
    });

    const initData = {
      meta: { createdAt: now(), creator: 'FSM-v11.1', from: oldGameId },
      config,
      players,
      settings: config.settings,
      actions: {}, logs: {},
      state: { phase: PHASE.LOBBY, round: 0, host: this.full.state.host, peace: 0, winner: null, sheriff: null }
    };

    await db.ref(`games/${newGameId}`).set(initData);
    await db.ref(`games/${oldGameId}/state/nextGameId`).set(newGameId);
  },

  /**
   * 发牌算法，确保满足禁配和金宝宝规则
   * @param {Array<string>} pool - 待分配的身份池
   * @returns {object|null} - 返回 { pairs: [...] } 或 null
   */
  dealWithGolden(pool) {
    for (let t = 0; t < 8000; t++) {
      const d = shuffle([...pool]);
      let isCombinationOk = true;
      const pairs = [];

      for (let i = 0; i < d.length; i += 2) {
        const role1 = d[i], role2 = d[i + 1];
        const key = [role1, role2].sort().join('|');
        if (FORBIDDEN_PAIRS.has(key) || (role1 === '盗贼' && role2 === '盗贼')) {
          isCombinationOk = false;
          break;
        }
        if (role1 === '盗贼') {
          pairs.push([{ role: role2, isCopy: true }, { role: role2 }]);
        } else if (role2 === '盗贼') {
          pairs.push([{ role: role1 }, { role: role1, isCopy: true }]);
        } else {
          pairs.push([{ role: role1 }, { role: role2 }]);
        }
      }
      if (!isCombinationOk) continue;

      const hasGolden = pairs.some(pr => pr[0].role === '平民' && pr[1].role === '平民' && !pr[0].isCopy && !pr[1].isCopy);
      if (hasGolden) return { pairs };
      
      if (t > 5000) {
          // 随机多次无法产生，认为配置有问题
      }
    }
    return null; // 尝试失败
  },

  /* ---------- 3. 进入游戏与渲染 ---------- */

  /** 渲染加入游戏的提示框 */
  renderJoinPrompt() {
    $('setup-view').classList.add('hidden');
    $('lobby-view').classList.add('hidden');
    $('game-view').classList.add('hidden');
    const joinView = $('join-view');
    joinView.classList.remove('hidden');
    joinView.innerHTML = `
      <div class="join-container">
        <h2>进入游戏房间</h2>
        <p>请输入你的座位号</p>
        <input type="number" id="player-number-input" placeholder="例如: 1" />
        <button class="btn-primary" data-action="join-game">确认进入</button>
      </div>
    `;
  },

  /** 渲染游戏大厅界面 */
  renderLobby(data) {
    $('setup-view').classList.add('hidden');
    $('join-view').classList.add('hidden');
    $('game-view').classList.add('hidden');
    const lobbyView = $('lobby-view');
    lobbyView.classList.remove('hidden');

    const isHost = String(data.state.host) === this.me;
    const players = Object.values(data.players || {});
    const me = data.players?.[this.me];
    const allReady = players.length > 0 && players.every(p => p.isReady);

    let hostControls = '';
    if (isHost) {
      hostControls = `
        <div class="host-lobby-controls">
          <div class="host-transfer">
            <span>移交主持给:</span>
            <select id="host-transfer-select">
              ${players.map(p => `<option value="${p.id}" ${String(p.id) === String(data.state.host) ? 'selected' : ''}>玩家 ${p.id}</option>`).join('')}
            </select>
            <button class="control-btn" data-action="host-transfer">确认移交</button>
          </div>
          <button class="btn-primary btn-large" data-action="host-start-from-lobby" ${!allReady ? 'disabled' : ''}>
            ${allReady ? '开始游戏' : '等待全员准备'}
          </button>
        </div>
      `;
    }
    
    // [NEW] Dynamically generate the entire lobby view, including the identity confirmation part
    lobbyView.innerHTML = `
      <div class="lobby-container">
        <div class="lobby-header">
          <h2>游戏大厅</h2>
          <p>请确认身份，等待游戏开始</p>
        </div>
        <div class="player-status-grid">
          ${players.map(p => `
            <div class="player-status-item ${p.isReady ? 'ready' : 'waiting'}">
              <span class="player-status-dot"></span>
              玩家 ${p.id} ${String(p.id) === String(data.state.host) ? '(👑)' : ''}
            </div>
          `).join('')}
        </div>
        
        <div id="lobby-identity-section">
          ${me ? this.generateIdentityHtml(me, data.state.phase) : ''}
        </div>

        ${hostControls}
      </div>
    `;
  },

  /** 进入游戏房间，启动监听 */
  async enterGame() {
    this.engine = new Engine(this.gameId);

    const rootRef = db.ref(`games/${this.gameId}`);
    const onlineRef = db.ref(`games/${this.gameId}/players/${this.me}/online`);
    await onlineRef.set(true);
    onlineRef.onDisconnect().set(false);

    // [FIX] Use a named function for the listener to allow proper removal
    const onValueChange = snap => {
      const data = snap.val();
      if (!data) {
        this.toast('游戏数据不存在或已被删除。', 'error');
        this.destroy();
        return;
      }
      
      if (data.state?.nextGameId) {
        this.toast('即将开始新对局，页面跳转中...', 'success');
        const newUrl = `${location.pathname}?game=${data.state.nextGameId}&player=${this.me}`;
        setTimeout(() => { location.href = newUrl; }, 1500);
        return;
      }
      
      this.full = data;

      // [FIX] Dynamically start/stop the engine based on who is the host
      const isHost = String(data.state.host) === this.me;
      if (isHost && !this.autorun) {
        this.autorun = setInterval(() => this.engine.tick().catch(console.error), 400);
        console.log("主持端引擎已启动。");
      } else if (!isHost && this.autorun) {
        clearInterval(this.autorun);
        this.autorun = null;
        console.log("非主持端，引擎已停止。");
      }

      // [FIX] Core rendering logic: render lobby or game view based on phase
      if (data.state.phase === PHASE.LOBBY) {
        this.renderLobby(data);
      } else {
        $('lobby-view').classList.add('hidden');
        $('game-view').classList.remove('hidden');
        this.renderAll(data);
      }
    };
    
    rootRef.on('value', onValueChange);
    this.listener = { ref: rootRef, cb: onValueChange };
  },

  /** 渲染所有UI组件的主函数 */
  renderAll(data) {
    this.renderStatus(data.state);
    // [FIX] Identity is now part of the main game view again for display purposes
    const me = data.players?.[this.me];
    if (me) this.renderIdentity(me, data);
    this.renderPlayers(data);
    this.renderActions(data);
    this.renderHost(data);
  },

  /** 渲染顶部状态栏 */
  renderStatus(st) {
    const phaseMap = {
      [PHASE.SETUP]: '等待所有玩家确认身份',
      [PHASE.LOBBY]: '游戏大厅 - 等待开始',
      [PHASE.NIGHT]: `第 ${st.round} 夜晚 - 行动中`,
      [PHASE.NIGHT_WITCH]: `第 ${st.round} 夜晚 - 等待女巫行动`,
      [PHASE.DAWN]: '黎明结算中...',
      [PHASE.SHERIFF_CAND]: '警长竞选 - 上警意向',
      [PHASE.SHERIFF_SPEECH]: '警长竞选 - 发言阶段',
      [PHASE.SHERIFF_VOTE]: '警长竞选 - 投票阶段',
      [PHASE.DAY_TALK]: `第 ${st.round} 白天 - 发言阶段`,
      [PHASE.DAY_VOTE]: `第 ${st.round} 白天 - 放逐投票`,
      [PHASE.HUNTER]: '猎人开枪中...',
      [PHASE.BADGE]: '警徽移交中...',
      [PHASE.GAME_OVER]: this.full?.state?.winner || '游戏结束'
    };
    $('status-bar').innerHTML = `<span class="status-text">${phaseMap[st.phase] || '未知状态'}</span>`;
  },

  /** [NEW] Generates HTML for identity display, used in both lobby and game */
  generateIdentityHtml(me, phase) {
    const fmt = id => `<span class="identity-item"><span class="identity-icon">${ROLES[id.role].icon}</span><span class="identity-name${id.isCopy ? ' thief-copy-text' : ''}">${id.role}</span></span>`;
    const canInteract = phase === PHASE.LOBBY && !me.isReady;
    
    const id1Html = me.deaths >= 1 ? `<span class="identity-dead">${fmt(me.identities[0])}</span>` : fmt(me.identities[0]);
    const id2Html = me.deaths >= 2 ? `<span class="identity-dead">${fmt(me.identities[1])}</span>` : fmt(me.identities[1]);

    let interactionHtml = '';
    if (phase === PHASE.LOBBY) {
        if (canInteract) {
            interactionHtml = `<div class="identity-actions"><button class="control-btn" data-action="swap">交换</button><button class="confirm-btn" data-action="ready">确认身份</button></div>`;
        } else {
            interactionHtml = `<div class="action-feedback">${me.isReady ? '已确认，等待其他玩家...' : '请确认身份'}</div>`;
        }
    }

    return `
      <div class="identity-card">
        <div class="identity-header">你的身份</div>
        <div class="identity-display">${id1Html}<span class="identity-separator">+</span>${id2Html}</div>
        ${interactionHtml}
      </div>
    `;
  },

  /** 渲染中央的身份卡片 (for in-game display) */
  renderIdentity(me, data) {
    $('identity-card').innerHTML = this.generateIdentityHtml(me, data.state.phase);

    // Render persistent info for roles like Witch, Seer, etc.
    const persist = [];
    const ar = this.engine.activeRole(me);
    if (ar === '女巫') {
      const usedCure = !!me.skill?.cureUsed;
      const usedPoison = !!me.skill?.poisonUsed;
      persist.push(`女巫药瓶：解药${usedCure ? '已用' : '可用'}，毒药${usedPoison ? '已用' : '可用'}`);
    }
    if (ar === '骑士') {
      persist.push(`骑士技能：${me.skill?.knightUsed ? '已使用' : '可使用'}`);
    }
    if (ar === '守卫') {
      if (me.skill?.lastGuard) persist.push(`上夜守护：${me.skill.lastGuard}号`);
    }
    const seerResults = this.getSeerResultsForMe(data);
    if (seerResults.length > 0) {
        persist.push('查验历史：' + seerResults.map(r => `[N${r.round}] ${r.target}号 -> ${r.result}`).join('; '));
    }
    
    const persistEl = $('persist');
    persistEl.classList.toggle('hidden', persist.length === 0);
    persistEl.innerHTML = persist.map(s => `<div>• ${escapeHtml(s)}</div>`).join('');
  },

  /* ---------- 4. 玩家列表渲染 ---------- */

  /** 渲染左右两侧的玩家列表 */
  renderPlayers(data) {
    const left = $('player-grid-left'), right = $('player-grid-right');
    if (!left || !right) return; // Guard against rendering when view is hidden
    left.innerHTML = ''; right.innerHTML = '';
    const players = Object.values(data.players || {}).sort((a, b) => a.id - b.id);
    const mid = Math.ceil(players.length / 2);

    const activatedHidden = this.engine.isHiddenWolfActivated(data.players, data.state);
    const myPlayer = data.players?.[this.me];
    const wolfVisRule = data.settings?.hiddenTrigger || 'activeOnly';

    const meIsActingWolf = myPlayer ? this.isPlayerActingWolf(myPlayer, activatedHidden) : false;
    const meHasWolfCard = myPlayer ? myPlayer.identities.some(i => i.role === '狼人' || i.role === '隐狼') : false;
    const meCanSeeWolves = wolfVisRule === 'allWolves' ? meHasWolfCard : meIsActingWolf;
    
    const wolfVotes = data.actions?.[data.state.round]?.NIGHT?.WOLF || {};
    const wolfFinalTarget = wolfVotes?.final;

    players.forEach(p => {
      const card = this.renderPlayerCard(p, data, {
        meCanSeeWolves,
        activatedHidden,
        wolfVisRule,
        wolfVotes,
        wolfFinalTarget
      });
      (p.id <= mid ? left : right).appendChild(card);
    });
  },

  /** 渲染单个玩家卡片 */
  renderPlayerCard(p, data, ctx) {
    const meId = Number(this.me);
    const isMe = p.id === meId;
    const hearts = (2 - (p.deaths || 0));
    const sheriffIcon = p.badge ? '⭐' : '';
    const hostIcon = (String(data.state.host) === String(p.id)) ? '👑' : '';
    const numberHtml = `<span class="player-number">${p.id}${sheriffIcon ? ` <span class="sheriff-icon">${sheriffIcon}</span>` : ''}${hostIcon ? ` <span class="host-mark">${hostIcon}</span>` : ''}</span>`;

    let tags = [];
    if (data.state.phase !== PHASE.LOBBY && this.shouldShowWolfTag(p, ctx)) {
      tags.push('<span class="tag tag-team">狼</span>');
    }
    if (p.isExposedIdiot) {
      tags.push('<span class="tag tag-idiot">白痴</span>');
    }

    const card = el(`
      <div class="player-card ${isMe ? 'me' : ''} ${!p.isAlive ? 'disabled' : ''}" data-pid="${p.id}">
        ${numberHtml}
        <div class="tagline">${tags.join('')}</div>
        <div class="hearts">
          <span class="heart ${hearts >= 1 ? '' : 'off'}">❤</span>
          <span class="heart ${hearts >= 2 ? '' : 'off'}">❤</span>
        </div>
      </div>
    `);
    
    const myVote = ctx.wolfVotes?.[p.id]?.target;
    if (ctx.meCanSeeWolves && myVote !== undefined) {
        const voteDisplay = myVote === '0' ? '🔪' : myVote;
        card.appendChild(el(`<div class="wolf-corner">${voteDisplay}</div>`));
    }
    if (ctx.wolfFinalTarget && String(ctx.wolfFinalTarget) === String(p.id)) {
        card.classList.add('wolf-final-target');
    }

    if (this.selection && this.selection.pid === String(p.id)) {
      card.classList.add('selected');
    }

    card.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent body click listener from firing
      if (!p.isAlive && this.full.state.phase !== PHASE.BADGE) return;
      this.selection = { pid: String(p.id) };
      this.renderPlayers(this.full);
    });

    return card;
  },

  /** 判断玩家是否是可行动的狼 */
  isPlayerActingWolf(player, activatedHidden) {
    const ar = this.engine.activeRole(player);
    return ar === '狼人' || (ar === '隐狼' && activatedHidden);
  },

  /** 判断是否应该为目标玩家显示狼人标签 */
  shouldShowWolfTag(targetPlayer, ctx) {
    if (!ctx.meCanSeeWolves) return false;
    const targetHasWolfCard = targetPlayer.identities.some(i => i.role === '狼人' || i.role === '隐狼');
    if (ctx.wolfVisRule === 'allWolves') {
      return targetHasWolfCard;
    } else {
      return this.isPlayerActingWolf(targetPlayer, ctx.activatedHidden);
    }
  },

  /* ---------- 5. 操作面板渲染 ---------- */

  /** 渲染中央操作面板 */
  renderActions(data) {
    const panel = $('action-panel');
    panel.innerHTML = '';
    const st = data.state;
    const me = data.players?.[this.me];
    if (!me) return;

    const infoBox = (text) => `<div class="action-feedback">${text}</div>`;

    if (!me.isAlive && ![PHASE.BADGE, PHASE.GAME_OVER].includes(st.phase)) {
      panel.innerHTML = infoBox('你已出局，无法行动。');
      return;
    }

    const ar = this.engine.activeRole(me);
    const sel = this.selection?.pid;

    if (st.phase === PHASE.NIGHT) {
      // [FIX] Use role's `key` for correct action path
      const roleKey = ar ? ROLES[ar].key : null;
      const myAction = roleKey ? data.actions?.[st.round]?.NIGHT?.[roleKey]?.[me.id] : null;
      if (myAction) { panel.innerHTML = infoBox('操作已提交，等待其他玩家...'); return; }

      let html = '';
      if (ar === '守卫') {
        const lastGuard = me.skill?.lastGuard;
        html = `<div class="action-prompt">选择一名玩家守护</div>
                <div class="action-target">当前目标: ${sel ? sel + '号' : '未选择'}</div>
                <div class="action-buttons">
                    <button class="control-btn" data-action="guard-null">空守</button>
                    <button class="confirm-btn" data-action="guard-confirm" ${!sel || sel === lastGuard ? 'disabled' : ''}>确认守护</button>
                </div>`;
      } else if (ar === '预言家') {
        html = `<div class="action-prompt">选择一名玩家查验</div>
                <div class="action-target">当前目标: ${sel ? sel + '号' : '未选择'}</div>
                <div class="action-buttons">
                    <button class="confirm-btn" data-action="seer-confirm" ${!sel ? 'disabled' : ''}>确认查验</button>
                </div>`;
      } else if (this.isPlayerActingWolf(me, this.engine.isHiddenWolfActivated(data.players, st))) {
        const wolfData = data.actions?.[st.round]?.NIGHT?.WOLF || {};
        const finalTarget = wolfData.final;
        const alphaId = this.getAlphaWolfId(data);
        const isAlpha = String(alphaId) === String(me.id);
        
        html = `<div class="action-prompt">狼人请统一刀口</div>
                <div class="action-target">我的投票: ${wolfData[me.id]?.target || '未投'} | 最终目标: ${finalTarget ?? '未定'}</div>
                <div class="action-buttons">
                  <button class="control-btn" data-action="wolf-vote" ${!sel ? 'disabled' : ''}>投 ${sel||'X'} 号</button>
                  <button class="control-btn" data-action="wolf-empty">投空刀</button>
                  ${isAlpha ? `<button class="confirm-btn" data-action="wolf-final" ${!sel ? 'disabled' : ''}>拍板 ${sel||'X'} 号</button>
                               <button class="action-btn" data-action="wolf-final-empty">拍板空刀</button>` : ''}
                </div>`;
      } else {
        html = infoBox('静谧的夜晚，等待天明...');
      }
      panel.innerHTML = html;
      return;
    }

    if (st.phase === PHASE.NIGHT_WITCH) {
      if (ar !== '女巫') { panel.innerHTML = infoBox('等待女巫行动...'); return; }
      // [FIX] Call method on `engine` instance, not `App`
      if (this.engine.isWitchActionDone()) { panel.innerHTML = infoBox('操作已完成，等待天亮。'); return; }

      const wolfTarget = this.engine.getWolfFinalTarget();
      const usedCure = !!me.skill?.cureUsed;
      const usedPoison = !!me.skill?.poisonUsed;
      const rule = data.settings?.witchRule || 'noFirstNightSelfSave';
      const firstNight = st.round === 1;
      let selfSaveAllowed = true;
      if ((rule === 'noFirstNightSelfSave' && firstNight) || (rule === 'onlyFirstNightSelfSave' && !firstNight)) {
        selfSaveAllowed = false;
      }

      let knifeHtml = '';
      if (!usedCure) {
        knifeHtml = (wolfTarget && wolfTarget !== '0') ? `今晚 ${wolfTarget}号 被刀。` : '今晚无人被刀。';
      } else {
        knifeHtml = '（解药已用，无法查看刀口）';
      }

      panel.innerHTML = `
        <div class="action-prompt">女巫行动</div>
        <div class="action-target">${knifeHtml}</div>
        <div class="witch-actions-container">
          <button class="control-btn" data-action="witch-cure" ${usedCure || !wolfTarget || wolfTarget==='0' || (!selfSaveAllowed && String(wolfTarget)===String(me.id)) ? 'disabled' : ''}>使用解药</button>
          <button class="action-btn" data-action="witch-poison" ${usedPoison || !sel ? 'disabled' : ''}>毒杀 ${sel||'X'} 号</button>
          <button class="confirm-btn" data-action="witch-done">结束操作</button>
        </div>`;
      return;
    }
    
    if (st.phase === PHASE.SHERIFF_CAND) {
        const myCandStatus = st.sheriff?.candidates?.[me.id];
        panel.innerHTML = `<div class="action-prompt">是否上警？</div><div class="action-buttons"><button class="confirm-btn" data-action="sheriff-up" ${myCandStatus ? 'disabled' : ''}>上警</button><button class="control-btn" data-action="sheriff-down" ${myCandStatus === undefined ? 'disabled' : ''}>下警</button></div>`;
        return;
    }
    if (st.phase === PHASE.SHERIFF_SPEECH) {
        const isCandidate = st.sheriff?.candidates?.[me.id] && !st.sheriff?.drops?.[me.id];
        panel.innerHTML = isCandidate ? `<div class="action-buttons"><button class="action-btn" data-action="sheriff-drop">退水</button></div>` : infoBox('警上候选人发言中...');
        return;
    }
    if (st.phase === PHASE.SHERIFF_VOTE) {
        const validCandidates = Object.keys(st.sheriff?.candidates||{}).filter(id => st.sheriff.candidates[id] && !st.sheriff.drops?.[id]);
        panel.innerHTML = `<div class="action-prompt">为警长候选人投票</div><div class="action-target">候选人: ${validCandidates.join('、 ')}号</div><div class="action-buttons"><button class="control-btn" data-action="sheriff-vote-abstain">弃票</button><button class="confirm-btn" data-action="sheriff-vote" ${!sel || !validCandidates.includes(sel) ? 'disabled' : ''}>投 ${sel||'X'} 号</button></div>`;
        return;
    }

    if (st.phase === PHASE.DAY_TALK) {
        const knightReady = (ar === '骑士') && !me.skill?.knightUsed;
        panel.innerHTML = knightReady ? `<div class="action-prompt">你可以发动“决斗”</div><div class="action-buttons"><button class="action-btn" data-action="knight-duel" ${!sel ? 'disabled' : ''}>决斗 ${sel||'X'} 号</button></div>` : infoBox('白天发言阶段...');
        return;
    }

    if (st.phase === PHASE.DAY_VOTE) {
        if (me.isExposedIdiot) { panel.innerHTML = infoBox('你是已翻牌白痴，失去投票权。'); return; }
        panel.innerHTML = `<div class="action-prompt">放逐投票</div><div class="action-buttons"><button class="control-btn" data-action="day-vote-abstain">弃票</button><button class="confirm-btn" data-action="day-vote" ${!sel ? 'disabled' : ''}>投 ${sel||'X'} 号</button></div>`;
        return;
    }

    if (st.phase === PHASE.HUNTER) {
        const myTurn = st.hunters?.[me.id];
        panel.innerHTML = myTurn ? `<div class="action-prompt">你是猎人，请开枪！</div><div class="action-buttons"><button class="action-btn" data-action="hunter-shoot" ${!sel ? 'disabled' : ''}>带走 ${sel||'X'} 号</button></div>` : infoBox('等待猎人开枪...');
        return;
    }

    if (st.phase === PHASE.BADGE) {
        const isDeadSheriff = String(st.postBadge?.dead) === String(me.id);
        panel.innerHTML = isDeadSheriff ? `<div class="action-prompt">你倒在了警长的位置上，请移交警徽</div><div class="action-buttons"><button class="action-btn" data-action="badge-destroy">撕毁警徽</button><button class="confirm-btn" data-action="badge-pass" ${!sel ? 'disabled' : ''}>移交给 ${sel||'X'} 号</button></div>` : infoBox('等待警长移交警徽...');
        return;
    }

    if (st.phase === PHASE.GAME_OVER) {
        panel.innerHTML = `<div class="action-feedback" style="font-size: 1.2em; font-weight: bold;">${st.winner || '游戏结束'}</div>`;
    }
  },

  /* ---------- 6. 主持人控件渲染 ---------- */
  renderHost(data) {
    const host = $('host-controls');
    const isHost = String(data.state?.host || '1') === String(this.me);
    host.classList.toggle('hidden', !isHost);
    if (!isHost) { host.innerHTML = ''; return; }

    const st = data.state;
    let html = `<div class="host-panel">`;
    html += this.renderHostStatusDashboard();
    html += `<div class="host-actions-wrapper"><div class="host-status-title">主持控制台</div><div class="host-actions">`;

    if (st.phase === PHASE.SHERIFF_CAND) {
      html += `<button class="btn-primary" data-action="host-speech">进入发言</button>`;
    }
    if (st.phase === PHASE.SHERIFF_SPEECH) {
      html += `<button class="btn-primary" data-action="host-sheriff-vote">进入投票</button>`;
    }
    if (st.phase === PHASE.SHERIFF_VOTE) {
        html += `<button class="action-btn" data-action="host-force-sheriff-tally">强制计票</button>`;
    }
    if (st.phase === PHASE.DAY_TALK) {
      html += `<button class="btn-primary" data-action="host-day-vote">开启放逐投票</button>`;
      html += `<button class="control-btn" data-action="host-skip-day">直接入夜</button>`;
    }
    if (st.phase === PHASE.DAY_VOTE) {
        html += `<button class="action-btn" data-action="host-force-day-tally">强制计票</button>`;
    }
    if (st.phase === PHASE.GAME_OVER) {
      html = `
        <div class="host-panel">
          <div class="host-status-title">游戏已结束</div>
          <div class="host-actions">
            <button class="btn-primary" data-action="host-restart">重开一局</button>
          </div>
          <div class="host-transfer" style="margin-top: 16px;">
            <span>移交主持给:</span>
            <select id="host-transfer-select">
              ${Object.values(data.players).map(p => `<option value="${p.id}" ${String(p.id) === String(st.host) ? 'selected' : ''}>玩家 ${p.id}</option>`).join('')}
            </select>
            <button class="control-btn" data-action="host-transfer">确认移交</button>
          </div>
        </div>
      `;
    }
    html += `</div></div></div>`;
    host.innerHTML = html;
  },

  /* ---------- 7. 事件处理 ---------- */
  async onClick(e) {
    const a = e.target.closest('[data-action]');
    if (!a || a.disabled) return;
    const act = a.dataset.action;
    const sel = this.selection?.pid;
    
    // Actions that don't require `this.full`
    if (act === 'create-game') return this.createGame();
    if (act === 'open-logs') return this.openLogs();
    if (act === 'close-modal') return this.closeModal(a.dataset.target);
    if (act === 'join-game') {
      const playerNum = $('player-number-input').value;
      if (playerNum) {
        location.href = `${location.pathname}?game=${this.gameId}&player=${playerNum}`;
      } else {
        this.toast('请输入你的座位号', 'error');
      }
      return;
    }
    if (act === 'copy-link') {
        const link = a.dataset.link;
        try {
            await navigator.clipboard.writeText(link);
            this.toast('链接已复制到剪贴板', 'success');
        } catch (err) {
            this.toast('复制失败', 'error');
        }
        return;
    }

    if (!this.full) return;
    const r = this.full.state.round;
    const meId = this.me;

    // Lobby & Identity actions
    if (act === 'host-start-from-lobby') {
        await this.engine.log('全员准备就绪，游戏开始！');
        return this.engine.startNight(1);
    }
    if (act === 'host-transfer') {
        const newHostId = $('host-transfer-select').value;
        await db.ref(`games/${this.gameId}/state/host`).set(Number(newHostId));
        this.toast(`主持人已移交给玩家 ${newHostId}`, 'success');
        return;
    }
    if (act === 'swap') {
        const mePlayer = this.full.players?.[meId];
        if (!mePlayer || mePlayer.isReady) return;
        const ids = [...mePlayer.identities].reverse();
        return db.ref(`games/${this.gameId}/players/${meId}/identities`).set(ids);
    }
    if (act === 'ready') return db.ref(`games/${this.gameId}/players/${meId}/isReady`).set(true);

    // In-game Host controls
    if (act === 'host-speech') return this.engine.to(PHASE.SHERIFF_SPEECH);
    if (act === 'host-sheriff-vote') return this.engine.to(PHASE.SHERIFF_VOTE);
    if (act === 'host-force-sheriff-tally') {
        this.toast('主持人强制结束警长投票', 'info');
        return this.engine.tallySheriff();
    }
    if (act === 'host-day-vote') return this.engine.to(PHASE.DAY_VOTE);
    if (act === 'host-force-day-tally') {
        this.toast('主持人强制结束放逐投票', 'info');
        return this.engine.tallyDayVote();
    }
    if (act === 'host-skip-day') return this.engine.startNight(r + 1);
    if (act === 'host-restart') {
        return this.restartGame();
    }

    // Player actions
    const ar = this.engine.activeRole(this.full.players[meId]);
    const actionPath = `games/${this.gameId}/actions/${r}`;
    const roleKey = ar ? ROLES[ar].key : null;

    if (act === 'guard-null') return db.ref(`${actionPath}/NIGHT/GUARD/${meId}`).set({ target: null, ts: now() });
    if (act === 'guard-confirm' && sel) return db.ref(`${actionPath}/NIGHT/GUARD/${meId}`).set({ target: sel, ts: now() }).then(() => db.ref(`games/${this.gameId}/players/${meId}/skill/lastGuard`).set(sel));
    if (act === 'seer-confirm' && sel) {
        const res = this.computeSeerResult(this.full, sel);
        return db.ref(`${actionPath}/NIGHT/SEER/${meId}`).set({ target: sel, result: res, ts: now() });
    }
    if (act === 'wolf-vote' && sel) return db.ref(`${actionPath}/NIGHT/WOLF/${meId}`).set({ target: sel, ts: now() });
    if (act === 'wolf-empty') return db.ref(`${actionPath}/NIGHT/WOLF/${meId}`).set({ target: '0', ts: now() });
    if (act === 'wolf-final' && sel) return db.ref(`${actionPath}/NIGHT/WOLF/final`).set(sel);
    if (act === 'wolf-final-empty') return db.ref(`${actionPath}/NIGHT/WOLF/final`).set('0');

    if (act === 'witch-cure') {
        const wolfTarget = this.engine.getWolfFinalTarget();
        await db.ref(`${actionPath}/NIGHT_WITCH/cure`).set(wolfTarget);
        return db.ref(`games/${this.gameId}/players/${meId}/skill/cureUsed`).set(true);
    }
    if (act === 'witch-poison' && sel) {
        await db.ref(`${actionPath}/NIGHT_WITCH/poison`).set(sel);
        return db.ref(`games/${this.gameId}/players/${meId}/skill/poisonUsed`).set(true);
    }
    if (act === 'witch-done') return db.ref(`${actionPath}/NIGHT_WITCH/done`).set(true);

    if (act === 'sheriff-up') return db.ref(`games/${this.gameId}/state/sheriff/candidates/${meId}`).set(true);
    if (act === 'sheriff-down') return db.ref(`games/${this.gameId}/state/sheriff/candidates/${meId}`).set(null);
    if (act === 'sheriff-drop') return db.ref(`games/${this.gameId}/state/sheriff/drops/${meId}`).set(true);
    if (act === 'sheriff-vote' && sel) return db.ref(`games/${this.gameId}/state/sheriff/votes/${meId}`).set(sel);
    if (act === 'sheriff-vote-abstain') return db.ref(`games/${this.gameId}/state/sheriff/votes/${meId}`).set('0');

    if (act === 'knight-duel' && sel) return this.engine.duel(meId, sel);

    if (act === 'day-vote' && sel) return db.ref(`${actionPath}/DAY_VOTE/${meId}`).set({ target: sel, ts: now() });
    if (act === 'day-vote-abstain') return db.ref(`${actionPath}/DAY_VOTE/${meId}`).set({ target: '0', ts: now() });

    if (act === 'hunter-shoot' && sel) {
        await this.engine.kill(sel, 'DUEL'); // 猎人开枪效果等同决斗
        return db.ref(`games/${this.gameId}/state/hunters/${meId}`).set(null); // 从队列移除
    }

    if (act === 'badge-pass' && sel) {
        const post = this.full.state.postBadge;
        await db.ref(`games/${this.gameId}/players/${post.dead}/badge`).set(0);
        await db.ref(`games/${this.gameId}/players/${sel}/badge`).set(1);
        await this.engine.log(`⭐ 警徽移交给了 ${sel}号。`, false);
        return this.engine.to(post.next || PHASE.DAY_TALK, { postBadge: null });
    }
    if (act === 'badge-destroy') {
        const post = this.full.state.postBadge;
        await db.ref(`games/${this.gameId}/players/${post.dead}/badge`).set(0);
        await this.engine.log(`🗑️ 警徽被撕毁。`, false);
        return this.engine.to(post.next || PHASE.DAY_TALK, { postBadge: null });
    }
  },

  /* ---------- 8. 辅助函数 ---------- */
  
  /** 计算预言家查验结果 */
  computeSeerResult(data, targetPid) {
    const settings = data.settings || {};
    const mode = settings.seerMode || 'faction';
    const target = data.players?.[targetPid];
    if (!target) return '无效目标';

    if (mode === 'identity') {
      const role = this.engine.activeRole(target);
      if (role === '隐狼' && !this.engine.isHiddenWolfActivated(data.players, data.state)) {
        const otherIdentity = target.identities.find(id => id.role !== '隐狼');
        return otherIdentity ? otherIdentity.role : '好人';
      }
      return role;
    } else { // 查阵营
      const hasWolfCard = target.identities.some(i => i.role === '狼人');
      const hasInvisibleWolf = target.identities.some(i => i.role === '隐狼');
      const isWolfFaction = hasWolfCard || (hasInvisibleWolf && this.engine.isHiddenWolfActivated(data.players, data.state));
      return isWolfFaction ? '狼人阵营' : '好人阵营';
    }
  },

  /** 获取我的所有查验结果 */
  getSeerResultsForMe(data) {
    const results = [];
    if (!data.actions) return results;
    for (const round in data.actions) {
      const seerAction = data.actions[round]?.NIGHT?.SEER?.[this.me];
      if (seerAction) {
        results.push({ round, ...seerAction });
      }
    }
    return results;
  },

  /** 获取当前拍板狼（最小号的可行动狼）的ID */
  getAlphaWolfId(data) {
    const actingWolves = this.engine.getAliveActingWolves(data.players, data.state);
    if (actingWolves.length === 0) return null;
    return Math.min(...actingWolves.map(p => p.id));
  },

  /** 打开日志模态框 */
  openLogs() {
    if (!this.full) return;
    const logs = Object.values(this.full.logs || {}).sort((a, b) => a.ts - b.ts);
    const box = $('game-log-content');
    const isHost = String(this.full.state.host) === this.me;
    box.innerHTML = logs
      .filter(l => !l.secret || isHost) // 主持人可见所有日志
      .map(l => `<div class="log-item ${l.secret ? 'log-secret' : ''}"><span class="log-round">[N${l.round || 0}]</span> ${escapeHtml(l.msg)}</div>`)
      .join('') || '<div class="log-item">暂无日志</div>';
    $('logs-modal').classList.add('open');
  },

  /** 关闭模态框 */
  closeModal(id) {
    const m = id ? document.getElementById(id) : document.querySelector('.modal.open');
    if (m) m.classList.remove('open');
  },

  /** 显示浮动通知 */
  toast(txt, type = 'info') {
    const n = el(`<div class="notification ${type}">${escapeHtml(txt)}</div>`);
    $('notification-container').appendChild(n);
    setTimeout(() => n.remove(), 3000);
  },
   /**
   * [新增] 生成游戏链接，用于主持人分享给其他玩家。
   * @returns {string} - 包含所有玩家链接的HTML字符串。
   */
  generateGameLinks() {
    if (!this.gameId) return '游戏ID无效。';
    const players = Object.values(this.full.players || {});
    if (players.length === 0) return '没有玩家信息。';

    const baseUrl = `${location.origin}${location.pathname}`;
    let linksHtml = '<div class="game-links-container">';
    players.forEach(p => {
      const link = `${baseUrl}?game=${this.gameId}&player=${p.id}`;
      linksHtml += `
        <div class="game-link-item">
          <span>玩家 ${p.id}:</span>
          <input type="text" class="fancy-input" value="${link}" readonly />
          <button class="control-btn" data-action="copy-link" data-link="${link}">复制</button>
        </div>
      `;
    });
    linksHtml += '</div>';
    return linksHtml;
  },

  /**
   * [新增] 渲染主持人专用的状态监控面板。
   * @returns {string} - 包含当前阶段完成情况的HTML字符串。
   */
  renderHostStatusDashboard() {
    const st = this.full.state;
    const players = Object.values(this.full.players || {});
    const alivePlayers = players.filter(p => p.isAlive);
    let statusText = '';

    switch (st.phase) {
      case PHASE.NIGHT: {
        const actingWolves = this.engine.getAliveActingWolves(this.full.players, st);
        const seer = alivePlayers.find(p => this.engine.activeRole(p) === '预言家');
        const guard = alivePlayers.find(p => this.engine.activeRole(p) === '守卫');
        
        let total = actingWolves.length > 0 ? 1 : 0; // 狼人算一个集体行动
        if (seer) total++;
        if (guard) total++;

        let acted = 0;
        const nightActions = this.full.actions?.[st.round]?.NIGHT || {};
        if (nightActions.WOLF?.final !== undefined || actingWolves.length === 0) acted++;
        if (nightActions.SEER) acted++;
        if (nightActions.GUARD) acted++;
        
        statusText = `夜晚行动: ${acted} / ${total} 组完成`;
        break;
      }
      case PHASE.NIGHT_WITCH: {
        const witchDone = this.full.actions?.[st.round]?.NIGHT_WITCH?.done;
        statusText = `女巫行动: ${witchDone ? '已完成' : '进行中'}`;
        break;
      }
      case PHASE.SHERIFF_CAND: {
        const decidedCount = Object.keys(st.sheriff?.candidates || {}).length;
        statusText = `上警意向: ${decidedCount} / ${alivePlayers.length}`;
        break;
      }
      case PHASE.SHERIFF_VOTE:
      case PHASE.DAY_VOTE: {
        const voters = alivePlayers.filter(p => !p.isExposedIdiot);
        const votes = (st.phase === PHASE.SHERIFF_VOTE) 
            ? (st.sheriff?.votes || {}) 
            : (this.full.actions?.[st.round]?.DAY_VOTE || {});
        const votedCount = Object.keys(votes).length;
        statusText = `投票进度: ${votedCount} / ${voters.length}`;
        break;
      }
      default:
        return '';
    }
    
    return `<div class="host-status-dashboard">${statusText}</div>`;
  },

  /* ---------- 9. 清理工作 ---------- */
  destroy() {
    // [FIX] Correctly unsubscribe from the Firebase listener to prevent memory leaks
    if (this.listener.ref && this.listener.cb) {
      this.listener.ref.off('value', this.listener.cb);
      this.listener = { ref: null, cb: null };
      console.log('Firebase listener removed.');
    }
    if (this.autorun) {
      clearInterval(this.autorun);
      this.autorun = null;
      console.log('Engine timer cleared.');
    }
  }
};

/* ==================================================================
 *  5. 启动应用
 * ================================================================== */

// Add a listener to clean up resources when the page is closed/reloaded
window.addEventListener('beforeunload', () => App.destroy());
document.addEventListener('DOMContentLoaded', () => App.init());
