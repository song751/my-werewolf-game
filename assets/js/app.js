/**********************************************************************
 * 双身份狼人杀 - 电子法官 (V12.0 增强版) [修复版]
 * 修复内容（本次提交）：
 * 1) 致命/阻塞问题：
 *    - 新增 App.infoBox，修复子渲染函数调用 this.infoBox 崩溃问题
 *    - 修复“警长被票死/击杀后移交”使用布尔而非座位号的问题（kill 返回 sheriffDied 为座位号）
 *    - 引擎可被主持按钮直接触发的方法统一在开头刷新快照，避免使用过期缓存
 * 2) 日志与缓存：
 *    - onValueChange 更新 uiState.lastUpdate 并清理缓存，openLogs 将正确刷新
 * 3) 选择玩家 toast 频繁闪烁：
 *    - toast 支持 key 复用和定时器重置；选人提示使用 key=selection，更新文本而不反复创建
 *    - 仅在选中目标发生变化时才弹出提示，避免刷屏
 * 4) 易错/易漏：
 *    - 去除 app.js 内重复的 ripple-animation 动画定义（与 styles.css 重复）
 *********************************************************************/

/* ==================================================================
 *  0. 全局常量与配置
 * ================================================================== */

const ROLES = {
  平民:   { faction: 'good', icon: '👤', isGod: false, key: 'CIVILIAN' },
  守卫:   { faction: 'good', icon: '🛡️', isGod: true,  key: 'GUARD' },
  白痴:   { faction: 'good', icon: '🤪', isGod: true,  key: 'IDIOT' },
  预言家: { faction: 'good', icon: '🔮', isGod: true,  key: 'SEER' },
  骑士:   { faction: 'good', icon: '⚔️', isGod: true,  key: 'KNIGHT' },
  女巫:   { faction: 'good', icon: '🧪', isGod: true,  key: 'WITCH' },
  猎人:   { faction: 'good', icon: '🔫', isGod: true,  key: 'HUNTER' },
  狼人:   { faction: 'bad',  icon: '🐺', isGod: false, key: 'WOLF' },
  隐狼:   { faction: 'bad',  icon: '🌑', isGod: false, isInvisible: true, key: 'HIDDEN_WOLF' },
  盗贼:   { faction: 'neu',  icon: '🎭', isGod: false, isThief: true, key: 'THIEF' },
};

const GOD_ROLES = new Set(Object.keys(ROLES).filter(k => ROLES[k].isGod));
const UNIQUE_ROLES = new Set(['守卫','白痴','预言家','骑士','女巫','猎人','盗贼','隐狼']);
const FORBIDDEN_PAIRS = new Set([
  '狼人|隐狼',
  '预言家|狼人',
  '预言家|隐狼',
  '盗贼|狼人',
  '盗贼|隐狼'
]);
const DEFAULT_SETUP = { 平民: 6, 守卫: 1, 白痴: 1, 预言家: 1, 骑士: 1, 女巫: 1, 猎人: 1, 狼人: 2, 隐狼: 1, 盗贼: 1 };

const PHASE = {
  SETUP: 'SETUP', LOBBY: 'LOBBY', NIGHT: 'NIGHT', NIGHT_WITCH: 'NIGHT_WITCH',
  DAWN: 'DAWN', SHERIFF_CAND: 'SHERIFF_CAND', SHERIFF_SPEECH: 'SHERIFF_SPEECH',
  SHERIFF_VOTE: 'SHERIFF_VOTE', DAY_TALK: 'DAY_TALK', DAY_VOTE: 'DAY_VOTE',
  HUNTER: 'HUNTER', BADGE: 'BADGE', GAME_OVER: 'GAME_OVER'
};

// 预留：操作类型常量（后续可统一使用，减少硬编码）
const ACTION_TYPES = {
  WOLF_VOTE: 'WOLF_VOTE',
  WOLF_FINAL: 'WOLF_FINAL',
  GUARD: 'GUARD',
  SEER: 'SEER',
  WITCH_CURE: 'WITCH_CURE',
  WITCH_POISON: 'WITCH_POISON',
  KNIGHT_DUEL: 'KNIGHT_DUEL',
  HUNTER_SHOOT: 'HUNTER_SHOOT',
  VOTE: 'VOTE',
  SHERIFF_VOTE: 'SHERIFF_VOTE'
};

/* ==================================================================
 *  1. 工具函数
 * ================================================================== */

const $ = id => document.getElementById(id);
const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };
const escapeHtml = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const shuffle = a => { let i = a.length; while (i) { const r = Math.random() * i-- | 0;[a[i], a[r]] = [a[r], a[i]] } return a };
const now = () => Date.now();

// 防抖函数
const debounce = (func, wait) => {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

// 深拷贝函数
const deepClone = (obj) => {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return new Date(obj.getTime());
  if (obj instanceof Array) return obj.map(item => deepClone(item));
  if (typeof obj === 'object') {
    const clonedObj = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        clonedObj[key] = deepClone(obj[key]);
      }
    }
    return clonedObj;
  }
};

// 高精度时间戳（保留与旧数据兼容）
const getHighPrecisionTimestamp = () => {
  return Date.now() + Math.random();
};

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
    this.settings = null;
    this.isProcessing = false; // 处理状态锁
  }
  
  ref(p) { return db.ref(`games/${this.id}/${p}`); }
  
  async read(p) { 
    try {
      return (await this.ref(p).once('value')).val();
    } catch (error) {
      console.error(`Failed to read ${p}:`, error);
      return null;
    }
  }
  
  write(p, v) { 
    return this.ref(p).set(v).catch(err => {
      console.error(`Failed to write ${p}:`, err);
      throw err;
    });
  }
  
  update(obj) { 
    return db.ref(`games/${this.id}`).update(obj).catch(err => {
      console.error('Failed to update:', err);
      throw err;
    });
  }
  
  push(p, v) { 
    return this.ref(p).push(v).catch(err => {
      console.error(`Failed to push to ${p}:`, err);
      throw err;
    });
  }

  // 新增：统一刷新最新快照（避免主持按钮触发时使用旧缓存）
  async refresh() {
    const [state, players, actions, settings] = await Promise.all([
      this.read('state'), this.read('players'), this.read('actions'), this.read('settings')
    ]);
    this.state = state || {};
    this.players = players || {};
    this.actions = actions || {};
    this.settings = settings || {};
  }

  // 统一状态跳转（带锁机制）
  async to(phase, extraState = {}) {
    if (this.isProcessing) {
      console.warn('Engine is busy, skipping state transition');
      return;
    }
    
    this.isProcessing = true;
    try {
      const updates = { 'state/phase': phase };
      Object.entries(extraState || {}).forEach(([k, v]) => { 
        updates[`state/${k}`] = v; 
      });
      await this.update(updates);
    } finally {
      this.isProcessing = false;
    }
  }

  /* ============================
   *  主循环（主持端）
   * ============================ */
  async tick() {
    if (this.isProcessing) return; // 防止重复处理
    
    const state = await this.read('state') || {};
    this.state = state;
    if (state.phase === PHASE.DAWN || state.phase === PHASE.GAME_OVER) return;

    const players = await this.read('players') || {};
    const actions = await this.read('actions') || {};
    const settings = await this.read('settings') || {};
    this.players = players; 
    this.actions = actions; 
    this.settings = settings;

    switch (state.phase) {
      case PHASE.NIGHT:        return this.checkNightEnd();
      case PHASE.NIGHT_WITCH:  return this.checkWitchEnd();
      case PHASE.SHERIFF_CAND: return this.checkSheriffCandComplete();
      case PHASE.SHERIFF_VOTE: return this.checkSheriffVote();
      case PHASE.DAY_TALK:     await this.processKnightActions(); return;
      case PHASE.DAY_VOTE:     return this.checkDayVote();
      case PHASE.HUNTER:       return this.checkHunterQueue();
      default: return;
    }
  }

  /* ============================
   *  通用方法（优化版）
   * ============================ */
  activeIdx(p) { return Math.min(p.deaths || 0, 1); }
  activeRole(p) { return p.isAlive ? p.identities[this.activeIdx(p)].role : null; }

  // 统一隐狼激活计算
  computeHiddenActive(players = this.players, settings = this.settings) {
    const mode = settings?.hiddenActivation || 'noActiveWolf';
    if (mode === 'noWolfCardAlive') {
      const anyWolfCardAlive = Object.values(players).some(p => 
        p.isAlive && p.identities.some(id => id.role === '狼人' || id.role === '隐狼')
      );
      return !anyWolfCardAlive;
    } else {
      return !Object.values(players).some(p => 
        p.isAlive && this.activeRole(p) === '狼人'
      );
    }
  }

  isHiddenWolfActivated(players = this.players, state = this.state) {
    return this.computeHiddenActive(players, this.settings);
  }

  getAliveActingWolves(players = this.players, state = this.state) {
    const activated = this.isHiddenWolfActivated(players, state);
    return Object.values(players).filter(p => {
      if (!p.isAlive) return false;
      const ar = this.activeRole(p);
      return ar === '狼人' || (ar === '隐狼' && activated);
    });
  }

  // 守卫相关
  async getGuardTargetByGuardId(round, guardId) {
    try {
      const guardSnapshot = await this.read(`players/${guardId}/skill`);
      const actionSnapshot = await this.read(`actions/${round}/NIGHT/GUARD/${guardId}`);
      return {
        target: actionSnapshot?.target,
        lastGuard: guardSnapshot?.lastGuard
      };
    } catch (error) {
      console.error('Failed to get guard data:', error);
      return { target: null, lastGuard: null };
    }
  }

  getWolfFinalTarget() { return this.actions?.[this.state.round]?.NIGHT?.WOLF?.final; }

  // 女巫取值
  _parseWitchEntry(entry) {
    if (!entry && entry !== 0) return null;
    if (typeof entry === 'object' && entry !== null) {
      const t = entry.target ?? null;
      const ts = typeof entry.ts === 'number' ? entry.ts : 0;
      return { target: t, ts };
    }
    return { target: entry, ts: 0 };
  }

  getWitchCureEntry() {
    const raw = this.actions?.[this.state.round]?.NIGHT_WITCH?.cure;
    return this._parseWitchEntry(raw);
  }

  getWitchPoisonEntry() {
    const raw = this.actions?.[this.state.round]?.NIGHT_WITCH?.poison;
    return this._parseWitchEntry(raw);
  }

  getWitchCureTarget() { return this.getWitchCureEntry()?.target || null; }
  getWitchPoisonTarget() { return this.getWitchPoisonEntry()?.target || null; }
  isWitchActionDone() { return this.actions?.[this.state.round]?.NIGHT_WITCH?.done === true; }

  /* ============================
   *  夜晚与女巫阶段
   * ============================ */
  async checkNightEnd() {
    const actingWolves = this.getAliveActingWolves(this.players, this.state);
    const finalTarget = this.getWolfFinalTarget();
    if (actingWolves.length > 0 && finalTarget === undefined) return;
    
    const witchAlive = Object.values(this.players).some(p => p.isAlive && this.activeRole(p) === '女巫');
    if (witchAlive) {
      await this.to(PHASE.NIGHT_WITCH);
    } else {
      await this.dawnResolve();
    }
  }

  async checkWitchEnd() {
    const witchAlive = Object.values(this.players).some(p => p.isAlive && this.activeRole(p) === '女巫');
    if (!witchAlive || this.isWitchActionDone()) {
      await this.dawnResolve();
    }
  }

  async dawnResolve() {
    // 每次被按钮或引擎触发都刷新快照（避免过期）
    await this.refresh();

    if (this.state.resolving) return;
    
    this.isProcessing = true;
    await this.write('state/resolving', true);
    await this.log('黎明到来，开始结算夜晚事件...', true);

    try {
      const r = this.state.round;
      const deaths = [];
      const wolfTarget = this.getWolfFinalTarget();

      // 女巫互斥：时间戳择一
      const cureEntry = this.getWitchCureEntry();
      const poisonEntry = this.getWitchPoisonEntry();
      let cureTarget = cureEntry?.target || null;
      let poisonTarget = poisonEntry?.target || null;
      
      if (cureTarget && poisonTarget) {
        const cureTs = cureEntry.ts || 0;
        const poisonTs = poisonEntry.ts || 0;
        
        let pick;
        if (cureTs < poisonTs) {
          pick = 'cure';
        } else if (cureTs > poisonTs) {
          pick = 'poison';
        } else {
          // 时间戳相等时，倾向解药
          pick = Math.random() > 0.3 ? 'cure' : 'poison';
        }
        
        if (pick === 'cure') {
          await this.log('🧪 女巫当夜仅能使用一瓶药：优先保留"解药"，毒药本夜无效。', true);
          poisonTarget = null;
        } else {
          await this.log('🧪 女巫当夜仅能使用一瓶药：优先保留"毒药"，解药本夜无效。', true);
          cureTarget = null;
        }
      }

      // 守卫逻辑
      const alivePlayers = Object.values(this.players || {}).filter(p => p.isAlive);
      const guard = alivePlayers.find(p => this.activeRole(p) === '守卫');
      let guardTarget = null, guardValid = false, guardTriedSame = false;
      
      if (guard) {
        const guardData = await this.getGuardTargetByGuardId(r, guard.id);
        const lastGuard = guardData.lastGuard ?? null;
        const target = guardData.target;
        
        if (target === null) {
          guardTarget = null;
          guardValid = true;
        } else if (target !== undefined && String(target) !== String(lastGuard)) {
          guardTarget = target;
          guardValid = true;
        } else if (target !== undefined && String(target) === String(lastGuard)) {
          guardTarget = null;
          guardValid = false;
          guardTriedSame = true;
          await this.log(`🛡️ 守卫本夜尝试连守同一目标，守护无效（视为未守护）。`, true);
        }
      }

      await this.log(
        `[结算细节] 狼刀:${wolfTarget ?? '无'}, 守卫:${guardValid ? (guardTarget ?? '空守') : '无'}, 解药:${cureTarget ?? '无'}, 毒药:${poisonTarget ?? '无'}`,
        true
      );

      // 女巫自救规则校验
      if (cureTarget && wolfTarget && String(cureTarget) === String(wolfTarget)) {
        const rule = this.settings?.witchRule || 'noFirstNightSelfSave';
        const firstNight = r === 1;
        let allowed = true;
        if (rule === 'noFirstNightSelfSave' && firstNight) allowed = false;
        if (rule === 'onlyFirstNightSelfSave' && !firstNight) allowed = false;
        if (!allowed) {
          await this.log('🧪 解药自救不符合规则，本次解药无效。', true);
          cureTarget = null;
        }
      }

      // 狼刀结算
      if (wolfTarget && wolfTarget !== '0') {
        const isGuarded = guardValid && guardTarget !== null && String(guardTarget) === String(wolfTarget);
        const isCured = cureTarget === wolfTarget;
        if (isGuarded) await this.log(`🛡️ ${guardTarget}号玩家被守卫成功守护。`, true);
        if (isCured) await this.log(`🧪 女巫使用解药救活了 ${cureTarget}号玩家。`, true);
        if (!isGuarded && !isCured) {
          deaths.push({ pid: wolfTarget, cause: 'WOLF' });
          await this.log(`🔪 ${wolfTarget}号玩家被狼人杀害。`, true);
        }
      }

      // 毒药结算
      if (poisonTarget && !deaths.some(d => String(d.pid) === String(poisonTarget))) {
        deaths.push({ pid: poisonTarget, cause: 'POISON' });
        await this.log(`☠️ ${poisonTarget}号玩家被女巫毒杀。`, true);
      }

      // 守卫lastGuard更新
      if (guard) {
        if (guardTriedSame) {
          // 连守尝试：不更新lastGuard
        } else if (guardValid) {
          await this.update({ [`players/${guard.id}/skill/lastGuard`]: guardTarget ?? null });
        }
      }

      // 死亡处理
      let anyHunterTriggered = false, sheriffDiedPid = null;
      if (deaths.length > 0) {
        const deadIds = [...new Set(deaths.map(d => d.pid))].sort((a, b) => a - b).join('号、');
        await this.log(`昨夜死亡的玩家是：${deadIds}号。`, false);
        await this.write('state/peace', 0);
        
        for (const d of deaths) {
          const pSnap = (await this.read('players')) || this.players;
          this.players = pSnap;
          const p = this.players[d.pid];
          if (p && p.isAlive) {
            const deathResult = await this.kill(d.pid, d.cause);
            if (deathResult.hunterTriggered) anyHunterTriggered = true;
            if (deathResult.sheriffDied) sheriffDiedPid = deathResult.sheriffDied;
          }
        }
      } else {
        await this.log('昨夜是平安夜。', false);
        await this.write('state/peace', (this.state.peace || 0) + 1);
      }

      if (await this.checkWin()) {
        return;
      }

      let nextPhase = r === 1 ? PHASE.SHERIFF_CAND : PHASE.DAY_TALK;
      if (r === 1) await this.update({ 'state/sheriff': { candidates: {}, votes: {}, drops: {}, isPK: false } });

      if (sheriffDiedPid) {
        await this.to(PHASE.BADGE, { postBadge: { dead: sheriffDiedPid, next: nextPhase } });
      } else if (anyHunterTriggered) {
        await this.to(PHASE.HUNTER, { nextPhaseAfterHunter: nextPhase });
      } else {
        await this.to(nextPhase);
      }
    } finally {
      await this.write('state/resolving', null);
      this.isProcessing = false;
    }
  }

  /* ============================
   *  击杀逻辑（修复：返回 sheriffDied 为座位号）
   * ============================ */
  async kill(pid, cause) {
    const freshPlayers = (await this.read('players')) || this.players;
    this.players = freshPlayers;

    const p = this.players[pid];
    if (!p || !p.isAlive) return {};

    const newDeaths = (p.deaths || 0) + 1;
    const isOut = newDeaths >= 2;
    const updates = { [`players/${pid}/deaths`]: newDeaths, [`players/${pid}/isAlive`]: !isOut };
    let hunterTriggered = false;
    let sheriffDiedPid = (p.badge && isOut) ? pid : null;

    // 白痴翻牌免死（投票触发）
    const currentRole = this.activeRole(p);
    const hasIdiotCard = p.identities.some(id => id.role === '白痴');
    
    if (hasIdiotCard && currentRole === '白痴' && cause === 'VOTE' && !p.isExposedIdiot) {
      if (newDeaths <= 1) {
        updates[`players/${pid}/isExposedIdiot`] = true;
        updates[`players/${pid}/isAlive`] = true;
        updates[`players/${pid}/deaths`] = 1;
        sheriffDiedPid = null; // 没有真正出局，不触发移交
        await this.log(`🤪 ${pid}号白痴被票出，翻牌免死，但失去投票权。`, false);
        await this.update(updates);
        
        this.players[pid] = { ...p, deaths: 1, isAlive: true, isExposedIdiot: true };
        return { hunterTriggered: false, sheriffDied: null };
      }
    }

    // 猎人触发（仅被狼刀/被票时，且真正出局）
    const hasHunterCard = p.identities.some(id => id.role === '猎人');
    if (isOut && hasHunterCard && currentRole === '猎人' && ['WOLF', 'VOTE'].includes(cause)) {
      const q = (await this.read('state/hunters')) || {};
      q[pid] = true;
      updates['state/hunters'] = q;
      hunterTriggered = true;
      await this.log(`🔫 ${pid}号猎人出局，可以开枪。`, false);
    }

    await this.update(updates);

    this.players[pid] = {
      ...p,
      deaths: updates[`players/${pid}/deaths`],
      isAlive: updates[`players/${pid}/isAlive`],
      isExposedIdiot: updates[`players/${pid}/isExposedIdiot`] ?? p.isExposedIdiot
    };
    return { hunterTriggered, sheriffDied: sheriffDiedPid };
  }

  /* ============================
   *  其他核心方法（保持原有逻辑）
   * ============================ */
  async checkDayVote() {
    // 刷新快照，避免过期
    await this.refresh();

    const r = this.state.round;
    const voters = Object.values(this.players).filter(p => p.isAlive && !p.isExposedIdiot);
    const rec = this.actions?.[r]?.DAY_VOTE || {};
    if (voters.length === 0 || voters.every(v => rec[v.id] !== undefined)) {
      await this.tallyDayVote();
    }
  }

  async tallyDayVote() {
    // 刷新快照，避免过期
    await this.refresh();

    const r = this.state.round;
    const rec = this.actions?.[r]?.DAY_VOTE || {};
    const sheriff = Object.values(this.players).find(p => p.badge);

    const weightInt = pid => (sheriff && String(pid) === String(sheriff.id)) ? 3 : 2;
    const fmtVoteNum = n => (Number.isInteger(n) ? `${n}票` : `${n.toFixed(1).replace(/\.0$/, '')}票`);

    const countsInt = {};
    const votesByTarget = {};
    const abstainers = [];

    Object.entries(rec).forEach(([voterPid, { target }]) => {
      if (target === '0') {
        abstainers.push(voterPid);
        return;
      }
      countsInt[target] = (countsInt[target] || 0) + weightInt(voterPid);
      if (!votesByTarget[target]) votesByTarget[target] = [];
      const isSheriff = sheriff && String(voterPid) === String(sheriff.id);
      votesByTarget[target].push(isSheriff ? `${voterPid}号(警长)` : `${voterPid}号`);
    });

    const maxInt = Math.max(0, ...Object.values(countsInt));
    const outPlayers = Object.keys(countsInt).filter(k => countsInt[k] === maxInt);

    const lines = ['放逐投票'];
    Object.keys(votesByTarget)
      .map(k => Number(k)).sort((a,b) => a - b).forEach(target => {
        const voters = votesByTarget[target].sort((a,b) => {
          const na = parseInt(a), nb = parseInt(b);
          return isNaN(na) || isNaN(nb) ? a.localeCompare(b) : na - nb;
        });
        const totalDisplay = (countsInt[String(target)] || 0) / 2;
        lines.push(`${target}号：${voters.join(' ')} ---- 共${fmtVoteNum(totalDisplay)}`);
      });
    if (abstainers.length > 0) {
      const abst = abstainers.map(id => `${id}号`).sort((a,b) => parseInt(a) - parseInt(b));
      lines.push(`弃票：${abst.join(' ')}`);
    }
    await this.log(lines.join('\n'), false);

    if (outPlayers.length === 1) {
      await this.log(`放逐投票结果：${outPlayers[0]}号玩家被公投出局。`, false);
      const deathResult = await this.kill(outPlayers[0], 'VOTE');
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

  async checkSheriffVote() {
    // 刷新快照
    await this.refresh();

    const voters = Object.values(this.players).filter(p => p.isAlive && !p.isExposedIdiot);
    const votes = this.state.sheriff?.votes || {};
    if (voters.every(pl => votes[pl.id] !== undefined)) {
      await this.tallySheriff();
    }
  }

  async tallySheriff() {
    // 刷新快照
    await this.refresh();

    const { candidates, votes, isPK, drops } = this.state.sheriff || {};
    const validCandidates = Object.keys(candidates || {}).filter(id => {
      const alive = this.players?.[id]?.isAlive;
      return candidates[id] && !(drops || {})[id] && alive;
    });

    if (!validCandidates.length) {
      await this.log('所有候选人退水或无人参选，本局无警长。', false);
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
      winners.forEach(id => pkCandidates[id] = true);
      await this.log(winners.length > 1 ? `⚖️ 平票：${winners.join('、')}号进入PK。` : '无人当选，流警。', false);
      if (winners.length > 1) {
        await this.update({ 'state/sheriff': { candidates: pkCandidates, votes: {}, drops: {}, isPK: true } });
        await this.to(PHASE.SHERIFF_SPEECH);
      } else {
        await this.to(PHASE.DAY_TALK, { sheriff: null });
      }
    }
  }

  async checkSheriffCandComplete() {
    // 刷新快照
    await this.refresh();

    const players = await this.read('players') || {};
    const alive = Object.values(players).filter(p => p.isAlive);
    const sheriff = (await this.read('state/sheriff')) || { candidates: {}, votes: {}, drops: {}, isPK: false };
    const cand = sheriff.candidates || {};
    const submitted = alive.filter(p => Object.prototype.hasOwnProperty.call(cand, p.id)).length;
    if (submitted === alive.length) {
      await this.log('所有玩家已提交上警意向，进入发言阶段。', false);
      await this.to(PHASE.SHERIFF_SPEECH);
    }
  }

  async forceSheriffSpeech() {
    // 刷新快照
    await this.refresh();

    const players = await this.read('players') || {};
    const alive = Object.values(players).filter(p => p.isAlive);
    const sheriff = (await this.read('state/sheriff')) || { candidates: {}, votes: {}, drops: {}, isPK: false };
    const cand = sheriff.candidates || {};
    for (const p of alive) {
      if (!Object.prototype.hasOwnProperty.call(cand, p.id)) {
        cand[p.id] = false;
      }
    }
    await this.update({ 'state/sheriff': { ...sheriff, candidates: cand } });
    await this.log('主持人强制进入发言阶段：未提交者视为未上警。', false);
    await this.to(PHASE.SHERIFF_SPEECH);
  }

  async startNight(round) {
    const freshPlayers = (await this.read('players')) || this.players || {};
    this.settings = (await this.read('settings')) || this.settings || {};
    const hiddenActive = this.computeHiddenActive(freshPlayers, this.settings);
    const updates = { 'state/round': round, 'state/phase': PHASE.NIGHT, 'state/hiddenActive': hiddenActive };
    if (round === 1) updates['state/gameStartTs'] = firebase.database.ServerValue.TIMESTAMP;
    await this.update(updates);
    await this.log(`第 ${round} 夜来临...`, false);
  }

  async processKnightActions() {
    // 刷新快照
    await this.refresh();

    const r = this.state.round;
    const rec = this.actions?.[r]?.DAY?.KNIGHT || {};
    for (const [fromPid, action] of Object.entries(rec)) {
      if (!action || action.processed || !action.target) continue;
      const from = this.players[fromPid];
      if (!from?.isAlive) {
        await this.update({ [`actions/${r}/DAY/KNIGHT/${fromPid}/processed`]: true });
        continue;
      }
      const ar = this.activeRole(from);
      const used = !!from.skill?.knightUsed;
      if (ar !== '骑士' || used) {
        await this.update({ [`actions/${r}/DAY/KNIGHT/${fromPid}/processed`]: true });
        continue;
      }
      await this.update({ [`players/${fromPid}/skill/knightUsed`]: true });
      await this.duel(fromPid, action.target);
      await this.update({ [`actions/${r}/DAY/KNIGHT/${fromPid}/processed`]: true });
      break;
    }
  }

  async checkHunterQueue() {
    // 刷新快照
    await this.refresh();

    const r = this.state.round;
    const q = (await this.read('state/hunters')) || {};
    let shooters = Object.keys(q).filter(pid => q[pid]);

    if (shooters.length === 0) {
      const nextPhase = (await this.read('state/nextPhaseAfterHunter')) || PHASE.DAY_TALK;
      await this.update({ 'state/hunters': null, 'state/nextPhaseAfterHunter': null, 'state/phase': nextPhase });
      return;
    }

    const hunterActs = (await this.read(`actions/${r}/HUNTER`)) || {};

    for (const pid of shooters) {
      const act = hunterActs[pid];
      if (act && !act.processed && act.target) {
        const targetPid = act.target;
        await this.log(`🔫 ${pid}号猎人开枪，指向 ${targetPid}号。`, false);
        const deathResult = await this.kill(targetPid, 'SHOT');

        await this.update({
          [`actions/${r}/HUNTER/${pid}/processed`]: true,
          [`state/hunters/${pid}`]: null
        });

        if (await this.checkWin()) return;

        if (deathResult.sheriffDied) {
          const next = (await this.read('state/nextPhaseAfterHunter')) || PHASE.DAY_TALK;
          await this.to(PHASE.BADGE, { postBadge: { dead: deathResult.sheriffDied, next } });
          return;
        }
      }
    }

    const q2 = (await this.read('state/hunters')) || {};
    shooters = Object.keys(q2).filter(pid => q2[pid]);

    if (shooters.length === 0) {
      const nextPhase = (await this.read('state/nextPhaseAfterHunter')) || PHASE.DAY_TALK;
      await this.update({ 'state/hunters': null, 'state/nextPhaseAfterHunter': null, 'state/phase': nextPhase });
    }
  }

  async duel(fromPid, targetPid) {
    // 刷新快照
    await this.refresh();

    const from = this.players[fromPid], target = this.players[targetPid];
    if (!from?.isAlive || !target?.isAlive) return;

    const isWolfFaction = target.identities?.some(i => i.role === '狼人' || i.role === '隐狼');

    if (isWolfFaction) {
      await this.log(`⚔️ ${fromPid}号骑士对 ${targetPid}号 发动决斗成功，目标是狼人阵营！`, false);
      const deathResult = await this.kill(targetPid, 'DUEL');
      if (await this.checkWin()) return;
      if (deathResult.sheriffDied) await this.to(PHASE.BADGE, { postBadge: { dead: deathResult.sheriffDied, next: PHASE.NIGHT } });
      else if (deathResult.hunterTriggered) await this.to(PHASE.HUNTER, { nextPhaseAfterHunter: PHASE.NIGHT });
      else await this.startNight(this.state.round + 1);
    } else {
      await this.log(`⚔️ ${fromPid}号骑士对 ${targetPid}号 决斗失败，目标非狼人阵营。`, false);
      const deathResult = await this.kill(fromPid, 'DUEL');
      if (await this.checkWin()) return;
      if (deathResult.sheriffDied) await this.to(PHASE.BADGE, { postBadge: { dead: deathResult.sheriffDied, next: this.state.phase } });
      else if (deathResult.hunterTriggered) await this.to(PHASE.HUNTER, { nextPhaseAfterHunter: this.state.phase });
    }
  }

  async checkWin() {
    // 注意：用户要求胜负判定保持“按阵营”而非“活跃身份”，保持原有逻辑不改动
    const playersFresh = (await this.read('players')) || this.players;
    this.players = playersFresh;

    const alivePlayers = Object.values(this.players).filter(p => p.isAlive);
    const anyWolfCardHolderAlive = Object.values(this.players).some(p => 
      p.isAlive && p.identities.some(id => id.role === '狼人' || id.role === '隐狼')
    );

    if (!anyWolfCardHolderAlive || (this.state.peace || 0) >= 3) {
      const reason = !anyWolfCardHolderAlive ? '所有狼人阵营玩家出局' : '连续3晚平安夜';
      await this.to(PHASE.GAME_OVER, { winner: '🏆 好人获胜' });
      await this.log(`🏁 游戏结束：好人获胜（${reason}）。`, false);
      return true;
    }

    const winCondition = this.settings?.wolfWin || 'edge';
    if (winCondition === 'exterminate') {
      if (!alivePlayers.some(p => ROLES[this.activeRole(p)]?.faction === 'good')) {
        await this.to(PHASE.GAME_OVER, { winner: '🐺 狼人屠城获胜' });
        await this.log('🏁 游戏结束：狼人屠城获胜。', false);
        return true;
      }
    } else {
      const godAlive = alivePlayers.some(p => p.identities?.some(i => GOD_ROLES.has(i.role)));
      const goldenAlive = alivePlayers.some(p => {
        const roles = (p.identities || []).map(i => i.role);
        return roles.length >= 2 && roles[0] === '平民' && roles[1] === '平民';
      });
      if (!godAlive || !goldenAlive) {
        const reason = !godAlive ? '所有神职出局' : '所有金宝宝出局';
        await this.to(PHASE.GAME_OVER, { winner: '🐺 狼人屠边获胜' });
        await this.log(`🏁 游戏结束：狼人屠边获胜（${reason}）。`, false);
        return true;
      }
    }
    return false;
  }

  async log(msg, secret = false) {
    let round = this.state?.round;
    if (typeof round !== 'number') {
      const r = await this.read('state/round');
      round = typeof r === 'number' ? r : 0;
    }
    await this.push('logs', { msg, ts: firebase.database.ServerValue.TIMESTAMP, round: round || 0, secret });
  }
}

/* ==================================================================
 *  4. 前端应用 (App) - 客户端UI与交互（优化&修复版）
 * ================================================================== */

const App = {
  me: null, 
  gameId: null, 
  engine: null,
  listener: { ref: null, cb: null, onlineRef: null },
  full: null, 
  selection: null, 
  autorun: null,
  
  // UI状态管理
  uiState: {
    loading: new Set(),
    animations: new Map(),
    pendingActions: new Map(),
    lastUpdate: 0,
    optimisticUpdates: new Map()
  },

  // Toast 复用与定时器（解决选人刷屏）
  _toastKeyMap: new Map(),
  _toastTimers: new Map(),
  _lastSelectionPid: null,

  init() {
    this.destroy();
    this.initEventListeners();
    this.initKeyboardShortcuts();
    this.initAccessibility();

    const p = new URLSearchParams(location.search);
    this.gameId = p.get('game') || '';
    this.me = p.get('player') || '';

    if (this.gameId) {
      $('setup-view').classList.add('hidden');
      const gameView = $('game-view');
      gameView.classList.remove('hidden');
      this.showLoadingState('正在加入游戏房间...');
      if (this.me) this.enterGame();
      else this.renderJoinPrompt();
    } else {
      this.renderSetup();
    }
  },

  // 新增：全局 infoBox（修复 this.infoBox 未定义崩溃）
  infoBox(text) {
    return `<div class="action-feedback">${escapeHtml(text)}</div>`;
  },

  // 初始化事件监听器
  initEventListeners() {
    // 全局按钮按压反馈
    document.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest('button');
      if (btn && !btn.disabled && !btn.classList.contains('loading')) {
        btn.classList.add('is-pressed');
        this.addRippleEffect(btn, e);
      }
    });
    
    document.addEventListener('pointerup', (e) => {
      const btn = e.target.closest('button');
      if (btn) btn.classList.remove('is-pressed');
    });
    
    document.addEventListener('pointerleave', (e) => {
      const btn = e.target.closest('button');
      if (btn) btn.classList.remove('is-pressed');
    });

    // 点击事件（防抖）
    document.addEventListener('click', debounce((e) => this.onClick(e), 150));
    
    // 取消选择
    document.body.addEventListener('click', (e) => {
      if (e.target.closest('#game-layout') && 
          !e.target.closest('.player-card, .action-panel, .host-controls')) {
        this.clearSelection();
      }
    }, true);

    // 窗口焦点变化
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.full) {
        this.markAsViewed();
      }
    });
  },

  // 键盘快捷键
  initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      
      switch(e.key) {
        case 'Escape':
          this.clearSelection();
          this.closeAnyModal();
          break;
        case 'l':
        case 'L':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this.openLogs();
          }
          break;
        case '1': case '2': case '3': case '4': case '5':
        case '6': case '7': case '8': case '9':
          if (this.full && !e.ctrlKey && !e.metaKey) {
            const playerNum = parseInt(e.key);
            const player = this.full.players?.[playerNum];
            if (player && player.isAlive) {
              this.selectPlayer(playerNum);
            }
          }
          break;
      }
    });
  },

  // 可访问性改进
  initAccessibility() {
    // 为动态元素添加ARIA标签
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) { // Element node
            this.enhanceAccessibility(node);
          }
        });
      });
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
  },

  // 增强可访问性
  enhanceAccessibility(element) {
    // 为按钮添加ARIA标签
    const buttons = element.querySelectorAll ? element.querySelectorAll('button') : [];
    buttons.forEach(btn => {
      if (!btn.getAttribute('aria-label') && !btn.textContent.trim()) {
        const action = btn.dataset.action;
        if (action) {
          btn.setAttribute('aria-label', this.getActionDescription(action));
        }
      }
    });

    // 为玩家卡片添加ARIA标签
    if (element.classList && element.classList.contains('player-card')) {
      const playerNum = element.dataset.pid;
      if (playerNum) {
        element.setAttribute('role', 'button');
        element.setAttribute('aria-label', `玩家${playerNum}`);
        element.setAttribute('tabindex', '0');
      }
    }
  },

  // 获取操作描述
  getActionDescription(action) {
    const descriptions = {
      'wolf-final': '确认狼人击杀目标',
      'guard-confirm': '确认守护目标',
      'seer-confirm': '确认查验目标',
      'witch-cure': '使用解药',
      'witch-poison': '使用毒药',
      'day-vote': '投票放逐',
      'sheriff-vote': '投票选举警长',
      'hunter-shoot': '猎人开枪',
      'knight-duel': '骑士决斗',
      'ready': '确认身份',
      'swap': '交换身份',
      'open-logs': '查看游戏日志'
    };
    return descriptions[action] || '执行操作';
  },

  // 涟漪效果
  addRippleEffect(button, event) {
    const ripple = document.createElement('div');
    ripple.className = 'ripple-effect';
    
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = event.clientX - rect.left - size / 2;
    const y = event.clientY - rect.top - size / 2;
    
    ripple.style.cssText = `
      position: absolute;
      width: ${size}px;
      height: ${size}px;
      left: ${x}px;
      top: ${y}px;
      background: rgba(255,255,255,0.3);
      border-radius: 50%;
      transform: scale(0);
      animation: ripple-animation 0.6s linear;
      pointer-events: none;
      z-index: 1;
    `;
    
    button.style.position = 'relative';
    button.style.overflow = 'hidden';
    button.appendChild(ripple);
    
    setTimeout(() => {
      if (ripple.parentNode) {
        ripple.parentNode.removeChild(ripple);
      }
    }, 600);
  },

  // 加载状态管理
  showLoadingState(message = '处理中...', target = null) {
    if (target) {
      target.classList.add('loading');
      target.disabled = true;
      const originalText = target.textContent;
      target.textContent = message;
      target.dataset.originalText = originalText;
    } else {
      const gameView = $('game-view');
      if (gameView) {
        gameView.innerHTML = `<div class="loading-prompt">${escapeHtml(message)}</div>`;
      }
    }
  },

  hideLoadingState(target = null) {
    if (target) {
      target.classList.remove('loading');
      target.disabled = false;
      if (target.dataset.originalText) {
        target.textContent = target.dataset.originalText;
        delete target.dataset.originalText;
      }
    }
  },

  // 选择管理（防刷屏：仅变更时提示，且复用 keyed toast）
  selectPlayer(pid) {
    const prevPid = this.selection?.pid;
    this.selection = { pid: String(pid) };
    if (this.full) {
      this.renderPlayers(this.full);
      this.renderActions(this.full);
    }
    if (String(prevPid) !== String(pid)) {
      this.showSelectionFeedback(pid);
    }
  },

  clearSelection() {
    if (this.selection) {
      this.selection = null;
      if (this.full) {
        this.renderPlayers(this.full);
        this.renderActions(this.full);
      }
    }
  },

  showSelectionFeedback(pid) {
    // 使用 keyed toast，更新内容不重新创建，避免“闪烁/刷屏”
    this.toast(`已选择 ${pid}号玩家`, 'info', 1000, { key: 'selection' });
  },

  // 关闭任何打开的模态框
  closeAnyModal() {
    const openModal = document.querySelector('.modal.open');
    if (openModal) {
      openModal.classList.remove('open');
    }
  },

  // 标记为已查看
  markAsViewed() {
    // 可扩展：已读标记
  },

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
      const item = el(`
        <div class="role-setup-item">
          <span class="role-name">${ROLES[role].icon} ${role}</span>
          <div class="custom-number-input">
            <button class="num-btn" data-role="${role}" data-op="-" aria-label="减少${role}数量">-</button>
            <input id="role-${role}" type="number" value="${def}" readonly aria-label="${role}数量" />
            <button class="num-btn" data-role="${role}" data-op="+" aria-label="增加${role}数量">+</button>
          </div>
        </div>
      `);
      item.querySelectorAll('.num-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const input = $(`role-${btn.dataset.role}`);
          let val = parseInt(input.value, 10);
          val += (btn.dataset.op === '+') ? 1 : -1;
          val = Math.max(0, val);
          
          // 唯一角色限制
          if (UNIQUE_ROLES.has(btn.dataset.role) && val > 1) {
            val = 1;
            this.toast(`${btn.dataset.role}是唯一角色，最多只能有1个`, 'warning');
          }
          
          input.value = val;
          this.updateSetupStats();
          
          // 轻微视觉反馈
          input.style.transform = 'scale(1.1)';
          setTimeout(() => {
            input.style.transform = 'scale(1)';
          }, 150);
        });
      });
      grid.appendChild(item);
    });

    // 设置默认值
    $('opt-witch-selfsave').value = 'noFirstNightSelfSave';
    $('opt-seer-mode').value = 'faction';
    $('opt-wolf-win').value = 'edge';
    $('opt-wolf-visibility').value = 'activeOnly';
    $('opt-hidden-activation').value = 'noActiveWolf';

    $('btn-create').setAttribute('data-action', 'create-game');
    this.updateSetupStats();
  },

  updateSetupStats() {
    const inputs = $('role-grid').querySelectorAll('input[type="number"]');
    let total = 0;
    inputs.forEach(i => { total += parseInt(i.value || '0', 10); });
    const players = Math.floor(total / 2);
    $('total-roles').textContent = String(total);
    $('player-cnt').textContent = String(players);
    
    const warn = $('player-count-warning');
    if (total === 0 || total % 2 !== 0) {
      warn.textContent = '身份总数必须为偶数且大于 0';
      warn.style.color = 'var(--color-danger)';
    } else if (players < 6 || players > 20) {
      warn.textContent = `建议玩家数量：6-20人（当前：${players}人）`;
      warn.style.color = 'var(--color-warning)';
    } else {
      warn.textContent = '配置看起来不错！';
      warn.style.color = 'var(--color-success)';
    }
  },

  _clampUniqueCounts(counts) {
    UNIQUE_ROLES.forEach(r => {
      if (counts[r] && counts[r] > 1) counts[r] = 1;
    });
    return counts;
  },

  async createGame() {
    const createBtn = $('btn-create');
    this.showLoadingState('创建中...', createBtn);
    
    try {
      const counts = {};
      $('role-grid').querySelectorAll('input').forEach(i => {
        const r = i.id.replace('role-', '');
        const v = +i.value || 0;
        if (v) counts[r] = v;
      });

      this._clampUniqueCounts(counts);

      const pool = [];
      for (const [r, c] of Object.entries(counts)) {
        for (let i = 0; i < c; i++) pool.push(r);
      }

      if (pool.length === 0 || pool.length % 2 !== 0) {
        throw new Error('身份总数必须为偶数且大于0');
      }

      const dealt = this.dealWithGolden(pool);
      if (!dealt) {
        throw new Error(this._lastDealError || '无法生成合规的牌组，请检查配置。');
      }

      const id = db.ref('games').push().key;
      const players = {};
      dealt.pairs.forEach((pair, i) => {
        players[i + 1] = {
          id: i + 1, 
          name: `玩家${i + 1}`, 
          identities: pair,
          deaths: 0, 
          isAlive: true, 
          isReady: false,
          isExposedIdiot: false, 
          badge: 0, 
          skill: {}
        };
      });

      const hiddenActivationSelect = document.getElementById('opt-hidden-activation');
      const hiddenActivation = hiddenActivationSelect ? hiddenActivationSelect.value : 'noActiveWolf';

      const settings = {
        witchRule: $('opt-witch-selfsave').value,
        seerMode: $('opt-seer-mode').value,
        wolfWin: $('opt-wolf-win').value,
        wolfVisibility: $('opt-wolf-visibility').value,
        hiddenActivation
      };

      const initData = {
        meta: { createdAt: now(), creator: 'FSM-v12.0' },
        config: { counts, settings }, 
        players, 
        settings, 
        actions: {}, 
        logs: {},
        state: { 
          phase: PHASE.LOBBY, 
          round: 0, 
          host: 1, 
          peace: 0, 
          winner: null, 
          sheriff: null 
        }
      };

      await db.ref(`games/${id}`).set(initData);
      this.toast('游戏房间创建成功！', 'success');
      
      // 创建成功动画
      createBtn.style.transform = 'scale(1.1)';
      setTimeout(() => {
        createBtn.style.transform = 'scale(1)';
        location.href = `${location.pathname}?game=${id}&player=1`;
      }, 300);
      
    } catch (error) {
      this.toast(error.message || '创建失败', 'error');
      this.hideLoadingState(createBtn);
    }
  },

  async restartGame() {
    const restartBtn = document.querySelector('[data-action="host-restart"]');
    if (restartBtn) this.showLoadingState('重开中...', restartBtn);
    
    try {
      this.toast('正在准备新对局...', 'info');
      const oldGameId = this.gameId;
      const config = this.full.config;
      
      if (!config || !config.counts) {
        throw new Error('无法找到游戏配置，无法重开。');
      }

      const counts = { ...config.counts };
      this._clampUniqueCounts(counts);

      const pool = [];
      for (const [r, c] of Object.entries(counts)) {
        for (let i = 0; i < c; i++) pool.push(r);
      }
      
      const dealt = this.dealWithGolden(pool);
      if (!dealt) {
        throw new Error(this._lastDealError || '重新发牌失败，无法重开。');
      }

      const newGameId = db.ref('games').push().key;
      const players = {};
      const oldPlayers = Object.values(this.full.players);
      
      dealt.pairs.forEach((pair, i) => {
        players[i + 1] = {
          id: i + 1, 
          name: oldPlayers[i]?.name || `玩家${i + 1}`, 
          identities: pair,
          deaths: 0, 
          isAlive: true, 
          isReady: false,
          isExposedIdiot: false, 
          badge: 0, 
          skill: {}
        };
      });

      const initData = {
        meta: { createdAt: now(), creator: 'FSM-v12.0', from: oldGameId },
        config: { counts, settings: config.settings }, 
        players, 
        settings: config.settings, 
        actions: {}, 
        logs: {},
        state: { 
          phase: PHASE.LOBBY, 
          round: 0, 
          host: this.full.state.host, 
          peace: 0, 
          winner: null, 
          sheriff: null 
        }
      };

      await db.ref(`games/${newGameId}`).set(initData);
      await db.ref(`games/${oldGameId}/state/nextGameId`).set(newGameId);
      
      this.toast('新对局已创建，即将跳转...', 'success');
      
    } catch (error) {
      this.toast(error.message || '重开失败', 'error');
      if (restartBtn) this.hideLoadingState(restartBtn);
    }
  },

  dealWithGolden(pool) {
    let forbiddenHits = 0, doubleThiefHits = 0, noGoldenHits = 0;
    
    for (let t = 0; t < 10000; t++) {
      const d = shuffle([...pool]);
      const pairs = [];
      let isCombinationOk = true;
      let hasGolden = false;

      // 原始禁配检查
      for (let i = 0; i < d.length; i += 2) {
        const role1 = d[i], role2 = d[i + 1];
        const origKey = [role1, role2].sort().join('|');
        if (FORBIDDEN_PAIRS.has(origKey)) { 
          isCombinationOk = false; 
          forbiddenHits++; 
          break; 
        }
        if (role1 === '盗贼' && role2 === '盗贼') { 
          isCombinationOk = false; 
          doubleThiefHits++; 
          break; 
        }
      }
      if (!isCombinationOk) continue;

      // 展开盗贼复制
      for (let i = 0; i < d.length; i += 2) {
        let role1 = d[i], role2 = d[i + 1];
        if (role1 === '盗贼') pairs.push([{ role: role2, isCopy: true }, { role: role2 }]);
        else if (role2 === '盗贼') pairs.push([{ role: role1 }, { role: role1, isCopy: true }]);
        else pairs.push([{ role: role1 }, { role: role2 }]);
      }

      // 展开后禁配检查
      for (const pair of pairs) {
        const key = [pair[0].role, pair[1].role].sort().join('|');
        if (FORBIDDEN_PAIRS.has(key)) { 
          isCombinationOk = false; 
          forbiddenHits++; 
          break; 
        }
      }
      if (!isCombinationOk) continue;

      hasGolden = pairs.some(pr => pr[0].role === '平民' && pr[1].role === '平民');
      if (hasGolden) return { pairs };
      noGoldenHits++;
    }
    
    this._lastDealError = `发牌失败：禁配命中${forbiddenHits}次，双盗${doubleThiefHits}次，无金宝宝${noGoldenHits}次。`;
    return null;
  },

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
        <input type="number" id="player-number-input" placeholder="例如: 1" min="1" max="20" />
        <button class="btn-primary" data-action="join-game">确认进入</button>
      </div>
    `;
    
    // 自动聚焦输入框
    setTimeout(() => {
      const input = $('player-number-input');
      if (input) input.focus();
    }, 100);
  },

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
    const readyCount = players.filter(p => p.isReady).length;

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
          <div class="lobby-progress">
            <div class="progress-text">准备进度: ${readyCount}/${players.length}</div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${players.length ? (readyCount / players.length * 100) : 0}%"></div>
            </div>
          </div>
          <button class="btn-primary btn-large" data-action="host-start-from-lobby" ${!allReady ? 'disabled' : ''}>
            ${allReady ? '🚀 开始游戏' : `等待全员准备 (${readyCount}/${players.length})`}
          </button>
        </div>
      `;
    }

    lobbyView.innerHTML = `
      <div class="lobby-container">
        <div class="lobby-header">
          <h2>游戏大厅</h2>
          <p>请确认身份，等待游戏开始</p>
        </div>
        <div class="lobby-link-section">
          <p>邀请朋友加入房间:</p>
          <div class="game-link-item">
            <input type="text" class="fancy-input" value="${location.origin}${location.pathname}?game=${this.gameId}" readonly />
            <button class="control-btn" data-action="copy-link" data-link="${location.origin}${location.pathname}?game=${this.gameId}">📋 复制链接</button>
          </div>
        </div>
        <div class="player-status-grid">
          ${players.map(p => `
            <div class="player-status-item ${p.isReady ? 'ready' : 'waiting'}" style="animation-delay: ${p.id * 0.1}s">
              <span class="player-status-dot"></span>
              玩家 ${p.id} ${String(p.id) === String(data.state.host) ? '(👑)' : ''}
              ${p.isReady ? '✓' : '⏳'}
            </div>
          `).join('')}
        </div>
        <div id="lobby-identity-section">
          ${me ? this.generateIdentityHtml(me, data.state.phase) : ''}
        </div>
        ${hostControls}
      </div>
    `;

    // 添加入场动画
    const statusItems = lobbyView.querySelectorAll('.player-status-item');
    statusItems.forEach((item, index) => {
      setTimeout(() => {
        item.style.opacity = '1';
        item.style.transform = 'translateY(0)';
      }, index * 100);
    });
  },

  async enterGame() {
    this.engine = new Engine(this.gameId);
    const rootRef = db.ref(`games/${this.gameId}`);
    const onlineRef = db.ref(`games/${this.gameId}/players/${this.me}/online`);
    
    try {
      await onlineRef.set(true);
      onlineRef.onDisconnect().set(false);
    } catch (error) {
      console.error('Failed to set online status:', error);
    }

    const onValueChange = snap => {
      const data = snap.val();
      if (!data) { 
        this.toast('游戏数据不存在或已被删除。', 'error'); 
        this.destroy(); 
        return; 
      }

      // 记录 UI 更新时间并清理日志缓存（修复日志不刷新的问题）
      this.uiState.lastUpdate = Date.now();
      this._cachedLogs = null;

      // 处理游戏重开跳转
      if (data.state?.nextGameId) {
        const newUrl = `${location.pathname}?game=${data.state.nextGameId}&player=${this.me}`;
        this.toast('即将开始新对局...', 'success');
        
        const manualLink = el(`
          <div class="notification info">
            如果页面没有自动跳转，请 
            <a href="${newUrl}" style="color: white; font-weight: bold;">点击这里</a>
          </div>
        `);
        $('notification-container').appendChild(manualLink);
        
        setTimeout(() => { location.href = newUrl; }, 2500);
        return;
      }

      const prevPhase = this.full?.state?.phase;
      this.full = data;

      // 引擎管理
      const isHost = String(data.state.host) === this.me;
      if (isHost && !this.autorun) {
        this.autorun = setInterval(() => this.engine.tick().catch(console.error), 1000);
        console.log("主持端引擎已启动。");
      } else if (!isHost && this.autorun) {
        clearInterval(this.autorun); 
        this.autorun = null; 
        console.log("非主持端，引擎已停止。");
      }

      // 首夜开始过渡动画
      if (data.state?.gameStartTs && Date.now() - data.state.gameStartTs < 3000) {
        document.body.classList.add('game-start-anim');
        setTimeout(() => document.body.classList.remove('game-start-anim'), 2000);
      }

      // 阶段变化提示
      if (prevPhase && prevPhase !== data.state.phase) {
        this.handlePhaseChange(prevPhase, data.state.phase);
      }

      // 渲染UI
      if (data.state.phase !== PHASE.LOBBY) {
        this.initGameLayout();
      }

      if (data.state.phase === PHASE.LOBBY) {
        this.renderLobby(data);
      } else {
        $('lobby-view').classList.add('hidden');
        $('game-view').classList.remove('hidden');
        this.renderAll(data);
      }
    };

    rootRef.on('value', onValueChange);
    this.listener = { ref: rootRef, cb: onValueChange, onlineRef };
  },

  // 初始化游戏布局
  initGameLayout() {
    const gv = $('game-view');
    if (gv.querySelector('.loading-prompt')) {
      gv.innerHTML = `
        <div id="game-layout">
          <div id="player-grid-left" class="player-grid"></div>
          <div class="center-panel">
            <div id="status-bar" class="status-bar"></div>
            <div id="identity-card" class="identity-card"></div>
            <div id="persist" class="persist-info hidden"></div>
            <div id="action-panel" class="action-panel"></div>
            <div id="host-controls" class="host-controls hidden"></div>
          </div>
          <div id="player-grid-right" class="player-grid"></div>
        </div>`;
    }
  },

  // 处理阶段变化
  handlePhaseChange(fromPhase, toPhase) {
    const phaseMessages = {
      [PHASE.NIGHT]: '🌙 夜幕降临，请闭眼...',
      [PHASE.NIGHT_WITCH]: '🧪 女巫，请睁眼...',
      [PHASE.DAWN]: '🌅 天亮了...',
      [PHASE.SHERIFF_CAND]: '⭐ 警长竞选开始',
      [PHASE.DAY_TALK]: '☀️ 白天发言阶段',
      [PHASE.DAY_VOTE]: '🗳️ 放逐投票开始',
      [PHASE.HUNTER]: '🔫 猎人请开枪',
      [PHASE.BADGE]: '⭐ 警徽移交',
      [PHASE.GAME_OVER]: '🏁 游戏结束'
    };

    const message = phaseMessages[toPhase];
    if (message) {
      this.toast(message, 'info', 2000);
    }

    // 相位变化动画
    const gameLayout = $('game-layout');
    if (gameLayout) {
      gameLayout.style.opacity = '0.8';
      setTimeout(() => {
        gameLayout.style.opacity = '1';
      }, 300);
    }
  },

  renderAll(data) {
    this.renderStatus(data.state);
    const me = data.players?.[this.me];
    if (me) this.renderIdentity(me, data);
    this.renderPlayers(data);
    this.renderActions(data);
    this.renderHost(data);
  },

  renderStatus(st) {
    const phaseMap = {
      [PHASE.SETUP]: '等待所有玩家确认身份',
      [PHASE.LOBBY]: '游戏大厅 - 等待开始',
      [PHASE.NIGHT]: `第 ${st.round} 夜晚 - 行动中`,
      [PHASE.NIGHT_WITCH]: `第 ${st.round} 夜晚 - 女巫行动`,
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

    const statusBar = $('status-bar');
    const statusText = phaseMap[st.phase] || '未知状态';
    
    // 状态变化动画
    if (statusBar.textContent !== statusText) {
      statusBar.style.transform = 'scale(1.05)';
      setTimeout(() => {
        statusBar.style.transform = 'scale(1)';
      }, 200);
    }
    
    statusBar.innerHTML = `<span class="status-text">${statusText}</span>`;
  },

  generateIdentityHtml(me, phase) {
    const fmt = id => {
      const icon = id.isCopy ? '🎭' : ROLES[id.role].icon;
      return `<span class="identity-item"><span class="identity-icon">${icon}</span><span class="identity-name${id.isCopy ? ' thief-copy-text' : ''}">${id.role}</span></span>`;
    };
    
    const canInteract = phase === PHASE.LOBBY && !me.isReady;
    const id1Html = me.deaths >= 1 ? `<span class="identity-dead">${fmt(me.identities[0])}</span>` : fmt(me.identities[0]);
    const id2Html = me.deaths >= 2 ? `<span class="identity-dead">${fmt(me.identities[1])}</span>` : fmt(me.identities[1]);
    
    let interactionHtml = '';
    if (phase === PHASE.LOBBY) {
      interactionHtml = canInteract
        ? `<div class="identity-actions">
             <button class="control-btn" data-action="swap" aria-label="交换身份顺序">🔄 交换</button>
             <button class="confirm-btn" data-action="ready" aria-label="确认当前身份配置">✓ 确认身份</button>
           </div>`
        : `<div class="action-feedback">${me.isReady ? '✅ 已确认，等待其他玩家...' : '请确认身份'}</div>`;
    }
    
    return `
      <div class="identity-card">
        <div class="identity-header">你的身份</div>
        <div class="identity-display">${id1Html}<span class="identity-separator">+</span>${id2Html}</div>
        ${interactionHtml}
      </div>
    `;
  },

  renderIdentity(me, data) {
    const identityCard = $('identity-card');
    const newHtml = this.generateIdentityHtml(me, data.state.phase);
    
    if (identityCard.innerHTML !== newHtml) {
      identityCard.innerHTML = newHtml;
      identityCard.style.transform = 'scale(1.02)';
      setTimeout(() => {
        identityCard.style.transform = 'scale(1)';
      }, 200);
    }

    // 持久化信息
    const persist = [];
    const ar = this.getActiveRole(me, data.players, data.state, data.settings);
    
    if (ar === '女巫') {
      const cureStatus = me.skill?.cureUsed ? '🚫 已用' : '✅ 可用';
      const poisonStatus = me.skill?.poisonUsed ? '🚫 已用' : '✅ 可用';
      persist.push(`女巫药瓶：解药${cureStatus}，毒药${poisonStatus}`);
    }
    
    if (ar === '骑士') {
      const knightStatus = me.skill?.knightUsed ? '🚫 已使用' : '⚔️ 可使用';
      persist.push(`骑士技能：${knightStatus}`);
    }
    
    if (ar === '守卫') {
      if (me.skill?.lastGuard !== undefined) {
        const lastTarget = me.skill.lastGuard === null ? '空守' : `${me.skill.lastGuard}号`;
        persist.push(`上一夜守护：${lastTarget}`);
      }
    }
    
    const seerResults = this.getSeerResultsForMe(data);
    if (seerResults.length > 0) {
      const resultsText = seerResults
        .map(r => `[N${r.round}] ${r.target}号 → ${r.result}`)
        .join('; ');
      persist.push(`查验历史：${resultsText}`);
    }
    
    const persistEl = $('persist');
    persistEl.classList.toggle('hidden', persist.length === 0);
    persistEl.innerHTML = persist.map(s => `<div>• ${escapeHtml(s)}</div>`).join('');
  },

  // 统一隐狼激活计算
  getHiddenActive(data) {
    if (typeof data.state?.hiddenActive === 'boolean') return data.state.hiddenActive;
    const mode = data.settings?.hiddenActivation || 'noActiveWolf';
    if (mode === 'noWolfCardAlive') {
      const anyWolfCardAlive = Object.values(data.players || {}).some(p => 
        p.isAlive && p.identities.some(id => id.role === '狼人' || id.role === '隐狼')
      );
      return !anyWolfCardAlive;
    } else {
      return !Object.values(data.players || {}).some(p => 
        p.isAlive && this.getActiveRole(p, data.players, data.state, data.settings) === '狼人'
      );
    }
  },

  renderPlayers(data) {
    const left = $('player-grid-left'), right = $('player-grid-right');
    if (!left || !right) return;
    
    left.innerHTML = ''; 
    right.innerHTML = '';
    
    const players = Object.values(data.players || {}).sort((a, b) => a.id - b.id);
    const mid = Math.ceil(players.length / 2);

    const hiddenActive = this.getHiddenActive(data);
    const myPlayer = data.players?.[this.me];
    const wolfVisRule = data.settings?.wolfVisibility || 'activeOnly';
    const meIsActingWolf = myPlayer ? this.isPlayerActingWolf(myPlayer, data, hiddenActive) : false;
    const meHasWolfCard = myPlayer ? myPlayer.identities.some(i => i.role === '狼人' || i.role === '隐狼') : false;
    const meCanSeeWolves = (wolfVisRule === 'allWolves' ? meHasWolfCard : meIsActingWolf);

    // 狼投票信息
    const wolfVotes = data.actions?.[data.state.round]?.NIGHT?.WOLF || {};
    const voteMap = {};
    Object.entries(wolfVotes).forEach(([voterId, voteData]) => {
      if (voterId === 'final' || !voteData?.target) return;
      const targetId = voteData.target === '0' ? voterId : voteData.target;
      if (!voteMap[targetId]) voteMap[targetId] = [];
      voteMap[targetId].push({ voter: voterId, isEmpty: voteData.target === '0' });
    });
    const wolfFinalTarget = wolfVotes?.final;

    players.forEach((p, index) => {
      const card = this.renderPlayerCard(p, data, { 
        meCanSeeWolves, 
        wolfVisRule, 
        voteMap, 
        wolfFinalTarget, 
        hiddenActive 
      });
      
      // 轻微延迟动画
      card.style.opacity = '0';
      card.style.transform = 'translateY(10px)';
      setTimeout(() => {
        card.style.opacity = '1';
        card.style.transform = 'translateY(0)';
      }, index * 50);
      
      (p.id <= mid ? left : right).appendChild(card);
    });
  },

  renderPlayerCard(p, data, ctx) {
    const isMe = p.id === Number(this.me);
    const hearts = (2 - (p.deaths || 0));
    const sheriffIcon = p.badge ? '⭐' : '';
    const hostIcon = (String(data.state.host) === String(p.id)) ? '👑' : '';
    const numberHtml = `<span class="player-number">${p.id}${sheriffIcon ? ` <span class="sheriff-icon">${sheriffIcon}</span>` : ''}${hostIcon ? ` <span class="host-mark">${hostIcon}</span>` : ''}</span>`;
    
    let tags = [];
    if (data.state.phase !== PHASE.LOBBY && this.shouldShowWolfTag(p, data, ctx)) {
      tags.push('<span class="tag tag-team">狼</span>');
    }
    if (p.isExposedIdiot) {
      tags.push('<span class="tag tag-idiot">白痴</span>');
    }
    if (p.online) {
      tags.push('<span class="tag tag-online">在线</span>');
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

    // 狼人相关标记
    if (ctx.meCanSeeWolves && ctx.voteMap[p.id]) {
      ctx.voteMap[p.id].forEach(vote => {
        const voteDisplay = vote.isEmpty ? '🔪' : vote.voter;
        card.appendChild(el(`<div class="wolf-corner">${voteDisplay}</div>`));
      });
    }
    
    if (ctx.meCanSeeWolves && ctx.wolfFinalTarget && String(ctx.wolfFinalTarget) === String(p.id)) {
      card.classList.add('wolf-final-target');
    }
    
    if (this.selection && this.selection.pid === String(p.id)) {
      card.classList.add('selected');
    }

    // 事件监听器
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handlePlayerCardClick(p, ctx);
    });

    // 键盘导航支持
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.handlePlayerCardClick(p, ctx);
      }
    });

    return card;
  },

  // 处理玩家卡片点击
  handlePlayerCardClick(player, ctx) {
    if (!player.isAlive && this.full.state.phase !== PHASE.BADGE) {
      this.toast('该玩家已出局', 'warning');
      return;
    }

    const mePlayer = this.full.players[this.me];
    if (this.isPlayerActingWolf(mePlayer, this.full, ctx.hiddenActive) && 
        this.full.state.phase === PHASE.NIGHT) {
      this.handleWolfVote(player.id);
    } else {
      this.selectPlayer(player.id);
    }
  },

  shouldShowWolfTag(targetPlayer, data, ctx) {
    if (!ctx.meCanSeeWolves) return false;
    const hiddenActive = ctx.hiddenActive;
    const isWolfVisible = targetPlayer.identities.some(i => 
      i.role === '狼人' || (i.role === '隐狼' && hiddenActive)
    );
    if (!isWolfVisible) return false;
    
    if (ctx.wolfVisRule === 'allWolves') {
      return isWolfVisible;
    } else {
      return this.isPlayerActingWolf(targetPlayer, data, hiddenActive);
    }
  },

  renderActions(data) {
    const panel = $('action-panel');
    const st = data.state;
    const me = data.players?.[this.me];
    
    if (!me) {
      panel.innerHTML = this.infoBox('玩家数据加载中...');
      return;
    }

    const infoBox = (text) => `<div class="action-feedback">${escapeHtml(text)}</div>`;
    const allowWhenDead = st.phase === PHASE.HUNTER && st.hunters?.[this.me];
    
    if (!me.isAlive && !allowWhenDead && ![PHASE.BADGE, PHASE.GAME_OVER].includes(st.phase)) {
      panel.innerHTML = infoBox('💀 你已出局，无法行动。');
      return;
    }

    const ar = this.getActiveRole(me, data.players, data.state, data.settings);
    const sel = this.selection?.pid;

    // 根据阶段渲染不同的操作面板
    try {
      switch(st.phase) {
        case PHASE.NIGHT:
          this.renderNightActions(panel, data, me, ar, sel);
          break;
        case PHASE.NIGHT_WITCH:
          this.renderWitchActions(panel, data, me, ar, sel);
          break;
        case PHASE.SHERIFF_CAND:
          this.renderSheriffCandActions(panel, data, me);
          break;
        case PHASE.SHERIFF_SPEECH:
          this.renderSheriffSpeechActions(panel, data, me);
          break;
        case PHASE.SHERIFF_VOTE:
          this.renderSheriffVoteActions(panel, data, sel);
          break;
        case PHASE.DAY_TALK:
          this.renderDayTalkActions(panel, data, me, ar, sel);
          break;
        case PHASE.DAY_VOTE:
          this.renderDayVoteActions(panel, data, me, sel);
          break;
        case PHASE.HUNTER:
          this.renderHunterActions(panel, data, me, sel);
          break;
        case PHASE.BADGE:
          this.renderBadgeActions(panel, data, me, sel);
          break;
        case PHASE.GAME_OVER:
          this.renderGameOverActions(panel, data);
          break;
        default:
          panel.innerHTML = infoBox('等待中...');
      }
    } catch (error) {
      console.error('Error rendering actions:', error);
      panel.innerHTML = infoBox('操作面板加载失败');
    }
  },

  // 各阶段的操作面板渲染方法
  renderNightActions(panel, data, me, ar, sel) {
    const hiddenActive = this.getHiddenActive(data);
    
    if (this.isPlayerActingWolf(me, data, hiddenActive)) {
      this.renderWolfNightActions(panel, data, me);
    } else {
      this.renderOtherNightActions(panel, data, me, ar, sel);
    }
  },

  renderWolfNightActions(panel, data, me) {
    const st = data.state;
    const wolfData = data.actions?.[st.round]?.NIGHT?.WOLF || {};
    const myVote = wolfData[me.id]?.target;
    const finalTarget = wolfData.final;
    const alphaId = this.getAlphaWolfId(data);
    const isAlpha = String(alphaId) === String(me.id);
    
    // 获取所有狼人投票状况
    const hiddenActive = this.getHiddenActive(data);
    const actingWolves = Object.values(data.players).filter(p => 
      this.isPlayerActingWolf(p, data, hiddenActive)
    );
    const votedWolves = actingWolves.filter(w => wolfData[w.id]?.target !== undefined);
    
    panel.innerHTML = `
      <div class="action-prompt">🐺 狼人行动（${isAlpha ? '你是拍板狼' : `拍板狼：${alphaId}号`}）</div>
      <div class="action-target">
        我的目标: ${myVote === '0' ? '🔪 空刀' : (myVote ? `${myVote}号` : '❓ 未选择')} | 
        最终目标: ${finalTarget ? `⚔️ ${finalTarget}号` : '⏳ 未定'}
      </div>
      <div class="vote-progress">投票进度: ${votedWolves.length}/${actingWolves.length}</div>
      <div class="action-buttons">
        <button class="control-btn" data-action="wolf-empty" ${myVote === '0' ? 'disabled' : ''}>🔪 空刀</button>
        ${isAlpha ? `<button class="confirm-btn" data-action="wolf-final" ${!myVote ? 'disabled' : ''}>⚔️ 确认击杀</button>` : ''}
      </div>
    `;
  },

  renderOtherNightActions(panel, data, me, ar, sel) {
    const st = data.state;
    const roleKey = ar ? ROLES[ar].key : null;
    
    if (roleKey && data.actions?.[st.round]?.NIGHT?.[roleKey]?.[me.id]) {
      panel.innerHTML = this.infoBox('✅ 你已完成夜晚行动');
      return;
    }

    if (ar === '守卫') {
      const last = me.skill?.lastGuard;
      const canGuard = sel && String(sel) !== String(last);
      
      panel.innerHTML = `
        <div class="action-prompt">🛡️ 守卫行动</div>
        <div class="action-target">
          当前选择: ${sel ? `${sel}号` : '❓ 未选择'}
          ${last !== undefined ? `<br>上一夜：${last === null ? '空守' : last + '号'}` : ''}
        </div>
        <div class="action-buttons">
          <button class="control-btn" data-action="guard-null">🚫 空守</button>
          <button class="confirm-btn" data-action="guard-confirm" ${!canGuard ? 'disabled' : ''}>
            🛡️ 确认守护${sel ? ` ${sel}号` : ''}
          </button>
        </div>
      `;
    } else if (ar === '预言家') {
      panel.innerHTML = `
        <div class="action-prompt">🔮 预言家行动</div>
        <div class="action-target">当前目标: ${sel ? `${sel}号` : '❓ 未选择'}</div>
        <div class="action-buttons">
          <button class="confirm-btn" data-action="seer-confirm" ${!sel ? 'disabled' : ''}>
            🔮 确认查验${sel ? ` ${sel}号` : ''}
          </button>
        </div>
      `;
    } else {
      panel.innerHTML = this.infoBox('🌙 夜晚进行中...');
    }
  },

  renderWitchActions(panel, data, me, ar, sel) {
    if (ar !== '女巫') {
      panel.innerHTML = this.infoBox('🌙 夜晚进行中...');
      return;
    }

    if (this.isWitchActionDone(data)) {
      panel.innerHTML = this.infoBox('✅ 你已完成女巫行动');
      return;
    }

    const wolfTarget = this.getWolfFinalTarget(data);
    const usedCure = !!me.skill?.cureUsed;
    const usedPoison = !!me.skill?.poisonUsed;
    const st = data.state;
    const witchAct = data.actions?.[st.round]?.NIGHT_WITCH || {};
    const cureUsedThisNight = !!witchAct.cure;
    const poisonUsedThisNight = !!witchAct.poison;
    const alreadyUsedThisNight = cureUsedThisNight || poisonUsedThisNight;

    // 女巫自救规则检查
    const rule = data.settings?.witchRule || 'noFirstNightSelfSave';
    const firstNight = st.round === 1;
    let selfSaveAllowed = !((rule === 'noFirstNightSelfSave' && firstNight) || 
                           (rule === 'onlyFirstNightSelfSave' && !firstNight));

    let knifeInfo = '';
    if (usedCure) {
      knifeInfo = '🚫 解药已用，无法查看刀口';
    } else if (wolfTarget && wolfTarget !== '0') {
      knifeInfo = `🔪 今晚 ${wolfTarget}号 被刀`;
    } else {
      knifeInfo = '🕊️ 今晚无人被刀';
    }

    const canCure = !usedCure && !alreadyUsedThisNight && wolfTarget && wolfTarget !== '0' && 
                   (selfSaveAllowed || String(wolfTarget) !== String(me.id));
    const canPoison = !usedPoison && !alreadyUsedThisNight && sel;

    panel.innerHTML = `
      <div class="action-prompt">🧪 女巫行动</div>
      <div class="action-target">${knifeInfo}</div>
      <div class="witch-status">
        解药: ${usedCure ? '🚫 已用' : (cureUsedThisNight ? '⏳ 本夜已用' : '✅ 可用')} | 
        毒药: ${usedPoison ? '🚫 已用' : (poisonUsedThisNight ? '⏳ 本夜已用' : '✅ 可用')}
      </div>
      <div class="witch-actions-container">
        <button class="control-btn" data-action="witch-cure" ${!canCure ? 'disabled' : ''}>
          💊 使用解药${wolfTarget && wolfTarget !== '0' ? ` 救 ${wolfTarget}号` : ''}
        </button>
        <button class="action-btn" data-action="witch-poison" ${!canPoison ? 'disabled' : ''}>
          ☠️ 毒杀${sel ? ` ${sel}号` : ' (选择目标)'}
        </button>
        <button class="confirm-btn" data-action="witch-done">✅ 结束操作</button>
      </div>
    `;
  },

  renderSheriffCandActions(panel, data, me) {
    const decided = Object.prototype.hasOwnProperty.call(data.state.sheriff?.candidates || {}, me.id);
    const optedUp = data.state.sheriff?.candidates?.[me.id] === true;
    
    panel.innerHTML = decided
      ? this.infoBox(`✅ 你的上警意向已提交：${optedUp ? '🏅 上警' : '🚫 不上警'}。等待其他玩家提交...`)
      : `<div class="action-prompt">⭐ 是否参与警长竞选？</div>
         <div class="action-buttons">
           <button class="confirm-btn" data-action="sheriff-up">🏅 上警</button>
           <button class="control-btn" data-action="sheriff-down">🚫 不上警</button>
         </div>`;
  },

  renderSheriffSpeechActions(panel, data, me) {
    const isCandidate = data.state.sheriff?.candidates?.[me.id] && !data.state.sheriff?.drops?.[me.id];
    
    panel.innerHTML = isCandidate 
      ? `<div class="action-prompt">⭐ 你是警长候选人</div>
         <div class="action-buttons">
           <button class="action-btn" data-action="sheriff-drop">💧 退水</button>
         </div>`
      : this.infoBox('🎤 警上候选人发言中...');
  },

  renderSheriffVoteActions(panel, data, sel) {
    const validCandidates = Object.keys(data.state.sheriff?.candidates || {})
      .filter(id => data.state.sheriff.candidates[id] && !data.state.sheriff.drops?.[id] && data.players?.[id]?.isAlive);
    
    panel.innerHTML = `
      <div class="action-prompt">⭐ 为警长候选人投票</div>
      <div class="action-target">候选人: ${validCandidates.map(id => `${id}号`).join('、') || '无'}</div>
      <div class="action-buttons">
        <button class="control-btn" data-action="sheriff-vote-abstain">🚫 弃票</button>
        <button class="confirm-btn" data-action="sheriff-vote" ${!sel || !validCandidates.includes(sel) ? 'disabled' : ''}>
          ⭐ 投票给${sel ? ` ${sel}号` : ' (选择候选人)'}
        </button>
      </div>
    `;
  },

  renderDayTalkActions(panel, data, me, ar, sel) {
    const knightReady = (ar === '骑士') && !me.skill?.knightUsed;
    
    panel.innerHTML = knightReady 
      ? `<div class="action-prompt">⚔️ 你可以发动决斗</div>
         <div class="action-buttons">
           <button class="action-btn" data-action="knight-duel" ${!sel ? 'disabled' : ''}>
             ⚔️ 决斗${sel ? ` ${sel}号` : ' (选择目标)'}
           </button>
         </div>`
      : this.infoBox('💬 白天发言阶段...');
  },

  renderDayVoteActions(panel, data, me, sel) {
    if (me.isExposedIdiot) {
      panel.innerHTML = this.infoBox('🤪 你是已翻牌白痴，失去投票权。');
      return;
    }

    panel.innerHTML = `
      <div class="action-prompt">🗳️ 放逐投票</div>
      <div class="action-buttons">
        <button class="control-btn" data-action="day-vote-abstain">🚫 弃票</button>
        <button class="confirm-btn" data-action="day-vote" ${!sel ? 'disabled' : ''}>
          🗳️ 投票放逐${sel ? ` ${sel}号` : ' (选择目标)'}
        </button>
      </div>
    `;
  },

  renderHunterActions(panel, data, me, sel) {
    if (!data.state.hunters?.[me.id]) {
      panel.innerHTML = this.infoBox('🔫 等待猎人开枪...');
      return;
    }

    panel.innerHTML = `
      <div class="action-prompt">🔫 你是猎人，请开枪！</div>
      <div class="action-buttons">
        <button class="action-btn" data-action="hunter-shoot" ${!sel ? 'disabled' : ''}>
          🔫 带走${sel ? ` ${sel}号` : ' (选择目标)'}
        </button>
      </div>
    `;
  },

  renderBadgeActions(panel, data, me, sel) {
    if (String(data.state.postBadge?.dead) !== String(me.id)) {
      panel.innerHTML = this.infoBox('⭐ 等待警长移交警徽...');
      return;
    }

    const target = data.players?.[sel];
    const canPass = sel && target?.isAlive && String(sel) !== String(me.id);

    panel.innerHTML = `
      <div class="action-prompt">⭐ 你倒在了警长的位置上，请移交警徽</div>
      <div class="action-buttons">
        <button class="action-btn" data-action="badge-destroy">🗑️ 撕毁警徽</button>
        <button class="confirm-btn" data-action="badge-pass" ${!canPass ? 'disabled' : ''}>
          ⭐ 移交给${sel ? ` ${sel}号` : ' (选择继任者)'}
        </button>
      </div>
    `;
  },

  renderGameOverActions(panel, data) {
    panel.innerHTML = `
      <div class="action-feedback game-over-result" style="font-size: 1.2em; font-weight: bold;">
        ${data.state.winner || '🏁 游戏结束'}
      </div>
    `;
  },

  renderHost(data) {
    const host = $('host-controls');
    const isHost = String(data.state?.host || '1') === String(this.me);
    host.classList.toggle('hidden', !isHost);
    
    if (!isHost) { 
      host.innerHTML = ''; 
      return; 
    }

    const st = data.state;
    let html = `<div class="host-panel">`;
    html += this.renderHostStatusDashboard(data);

    let actionsHtml = `<div class="host-actions-wrapper"><div class="host-status-title">🎮 主持控制台</div><div class="host-actions">`;

    switch(st.phase) {
      case PHASE.NIGHT:
      case PHASE.NIGHT_WITCH: {
        const btnText = st.round === 1 ? '⏩ 强制进入警长竞选' : '☀️ 强制天亮';
        actionsHtml += `<button class="action-btn" data-action="host-force-dawn">${btnText}</button>`;
        break;
      }
      case PHASE.SHERIFF_CAND:
        actionsHtml += `<button class="btn-primary" data-action="host-speech">🎤 进入发言</button>`;
        break;
      case PHASE.SHERIFF_SPEECH:
        actionsHtml += `<button class="btn-primary" data-action="host-sheriff-vote">🗳️ 进入投票</button>`;
        break;
      case PHASE.SHERIFF_VOTE:
        actionsHtml += `<button class="action-btn" data-action="host-force-sheriff-tally">📊 强制计票</button>`;
        break;
      case PHASE.DAY_TALK:
        actionsHtml += `<button class="btn-primary" data-action="host-day-vote">🗳️ 开启放逐投票</button>`;
        actionsHtml += `<button class="control-btn" data-action="host-skip-day">🌙 直接入夜</button>`;
        break;
      case PHASE.DAY_VOTE:
        actionsHtml += `<button class="action-btn" data-action="host-force-day-tally">📊 强制计票</button>`;
        break;
      case PHASE.HUNTER:
        actionsHtml += `<button class="action-btn" data-action="host-force-hunter-end">⏭️ 结束猎人阶段</button>`;
        break;
      case PHASE.BADGE:
        actionsHtml += `<button class="action-btn" data-action="host-force-badge-end">⏭️ 结束移交阶段</button>`;
        break;
      case PHASE.GAME_OVER:
        html = `
          <div class="host-panel">
            <div class="host-status-title">🏁 游戏已结束</div>
            <div class="host-actions">
              <button class="btn-primary" data-action="host-restart">🔄 重开一局</button>
            </div>
            <div class="host-transfer" style="margin-top: 16px;">
              <span>移交主持给:</span>
              <select id="host-transfer-select">
                ${Object.values(data.players).map(p => 
                  `<option value="${p.id}" ${String(p.id) === String(st.host) ? 'selected' : ''}>玩家 ${p.id}</option>`
                ).join('')}
              </select>
              <button class="control-btn" data-action="host-transfer">确认移交</button>
            </div>
          </div>`;
        host.innerHTML = html;
        return;
    }
    
    actionsHtml += `</div></div>`;
    html += actionsHtml;
    html += `</div>`;
    host.innerHTML = html;
  },

  async onClick(e) {
    const a = e.target.closest('[data-action]');
    if (!a || a.disabled || a.classList.contains('loading')) return;
    
    const act = a.dataset.action;
    const sel = this.selection?.pid;

    // 显示操作反馈
    this.showOperationFeedback(a);

    // 基础操作（不需要游戏数据）
    if (act === 'create-game') return this.createGame();
    if (act === 'open-logs') return this.openLogs();
    if (act === 'close-modal') return this.closeModal(a.dataset.target);
    
    if (act === 'join-game') {
      const playerNum = $('player-number-input').value?.trim();
      if (!playerNum) { 
        this.toast('请输入你的座位号', 'error'); 
        return; 
      }
      return this.handleJoinGame(playerNum);
    }
    
    if (act === 'copy-link') {
      return this.handleCopyLink(a.dataset.link);
    }

    // 需要游戏数据的操作
    if (!this.full) {
      this.toast('游戏数据未加载', 'error');
      return;
    }

    const r = this.full.state.round;
    const meId = this.me;

    // 数据库操作的便捷方法
    const setDB = (path, val) => this.performDatabaseOperation(
      () => db.ref(path).set(val), 
      `设置 ${path.split('/').pop()}`
    );
    
    const updateDB = (obj) => this.performDatabaseOperation(
      () => db.ref(`games/${this.gameId}`).update(obj), 
      '更新游戏状态'
    );

    // 主持人操作
    if (act.startsWith('host-')) {
      return this.handleHostAction(act, setDB, updateDB);
    }

    // 玩家操作
    const actionPath = `games/${this.gameId}/actions/${r}`;
    return this.handlePlayerAction(act, sel, setDB, updateDB, actionPath, meId, r);
  },

  // 显示操作反馈
  showOperationFeedback(button) {
    button.style.transform = 'scale(0.95)';
    setTimeout(() => {
      button.style.transform = 'scale(1)';
    }, 100);
  },

  // 处理加入游戏
  async handleJoinGame(playerNum) {
    const joinBtn = document.querySelector('[data-action="join-game"]');
    this.showLoadingState('验证中...', joinBtn);
    
    try {
      const playerSnap = await db.ref(`games/${this.gameId}/players/${playerNum}`).once('value');
      if (!playerSnap.exists()) {
        throw new Error('该座位号不存在，请联系主持人或更换座位号');
      }
      
      const onlineSnap = await db.ref(`games/${this.gameId}/players/${playerNum}/online`).once('value');
      if (onlineSnap.val()) {
        throw new Error('该座位已被占用，请更换座位号');
      }
      
      location.href = `${location.pathname}?game=${this.gameId}&player=${playerNum}`;
    } catch (error) {
      this.toast(error.message || '验证失败，请重试', 'error');
      this.hideLoadingState(joinBtn);
    }
  },

  // 处理复制链接
  async handleCopyLink(link) {
    try {
      await navigator.clipboard.writeText(link);
      this.toast('📋 链接已复制到剪贴板', 'success');
    } catch (error) {
      // 降级处理
      const textArea = document.createElement('textarea');
      textArea.value = link;
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        this.toast('📋 链接已复制到剪贴板', 'success');
      } catch (err) {
        this.toast('❌ 复制失败，请手动复制', 'error');
      }
      document.body.removeChild(textArea);
    }
  },

  // 执行数据库操作（带错误处理）
  async performDatabaseOperation(operation, description = '操作') {
    try {
      await operation();
      return true;
    } catch (error) {
      console.error(`${description}失败:`, error);
      this.toast(`${description}失败: ${error.message || '未知错误'}`, 'error');
      return false;
    }
  },

  // 处理主持人操作
  async handleHostAction(act, setDB, updateDB) {
    switch(act) {
      case 'host-start-from-lobby':
        await this.engine.log('全员准备就绪，游戏开始！');
        return this.engine.startNight(1);
      
      case 'host-transfer':
        const newHostId = $('host-transfer-select').value;
        await setDB(`games/${this.gameId}/state/host`, Number(newHostId));
        this.toast(`主持人已移交给玩家 ${newHostId}`, 'success');
        return;
      
      case 'host-force-dawn': return this.engine.dawnResolve();
      case 'host-speech': return this.engine.forceSheriffSpeech();
      case 'host-sheriff-vote': return this.engine.to(PHASE.SHERIFF_VOTE);
      case 'host-force-sheriff-tally': return this.engine.tallySheriff();
      case 'host-day-vote': return this.engine.to(PHASE.DAY_VOTE);
      case 'host-force-day-tally': return this.engine.tallyDayVote();
      case 'host-skip-day': return this.engine.startNight(this.full.state.round + 1);
      case 'host-restart': return this.restartGame();
      
      case 'host-force-hunter-end':
        const nextPhase = this.full.state.nextPhaseAfterHunter || PHASE.DAY_TALK;
        await this.engine.log('主持人强制结束猎人阶段。', false);
        return updateDB({ 
          'state/hunters': null, 
          'state/nextPhaseAfterHunter': null, 
          'state/phase': nextPhase 
        });
      
      case 'host-force-badge-end':
        const post = this.full.state.postBadge;
        if (post?.dead) {
          await setDB(`games/${this.gameId}/players/${post.dead}/badge`, 0);
        }
        await this.engine.log(`主持人强制结束警徽移交，警徽被撕毁。`, false);
        return this.engine.to(post?.next || PHASE.DAY_TALK, { postBadge: null });
    }
  },

  // 处理玩家操作
  async handlePlayerAction(act, sel, setDB, updateDB, actionPath, meId, r) {
    switch(act) {
      case 'swap':
        return this.handleSwapIdentities(setDB, meId);
      
      case 'ready':
        return setDB(`games/${this.gameId}/players/${meId}/isReady`, true);
      
      // 狼人操作
      case 'wolf-final':
        return this.handleWolfFinal(setDB, actionPath, meId);
      
      case 'wolf-empty':
        return this.handleWolfVote('0');
      
      // 守卫操作
      case 'guard-null':
        return setDB(`${actionPath}/NIGHT/GUARD/${meId}`, { target: null, ts: getHighPrecisionTimestamp() });
      
      case 'guard-confirm':
        if (!sel) return;
        return setDB(`${actionPath}/NIGHT/GUARD/${meId}`, { target: sel, ts: getHighPrecisionTimestamp() });
      
      // 预言家操作
      case 'seer-confirm':
        if (!sel) return;
        const result = this.computeSeerResult(this.full, sel);
        return setDB(`${actionPath}/NIGHT/SEER/${meId}`, { target: sel, result, ts: getHighPrecisionTimestamp() });
      
      // 女巫操作
      case 'witch-cure':
        return this.handleWitchCure(setDB, actionPath, meId, r);
      
      case 'witch-poison':
        if (!sel) return;
        return this.handleWitchPoison(setDB, actionPath, meId, sel);
      
      case 'witch-done':
        return setDB(`${actionPath}/NIGHT_WITCH/done`, true);
      
      // 警长相关操作
      case 'sheriff-up':
        return setDB(`games/${this.gameId}/state/sheriff/candidates/${meId}`, true);
      
      case 'sheriff-down':
        return setDB(`games/${this.gameId}/state/sheriff/candidates/${meId}`, false);
      
      case 'sheriff-drop':
        return setDB(`games/${this.gameId}/state/sheriff/drops/${meId}`, true);
      
      case 'sheriff-vote':
        if (!sel) return;
        return setDB(`games/${this.gameId}/state/sheriff/votes/${meId}`, sel);
      
      case 'sheriff-vote-abstain':
        return setDB(`games/${this.gameId}/state/sheriff/votes/${meId}`, '0');
      
      // 骑士操作
      case 'knight-duel':
        if (!sel) return;
        return setDB(`${actionPath}/DAY/KNIGHT/${meId}`, { 
          target: sel, 
          ts: getHighPrecisionTimestamp(), 
          processed: false 
        });
      
      // 白天投票
      case 'day-vote':
        if (!sel) return;
        return setDB(`${actionPath}/DAY_VOTE/${meId}`, { target: sel, ts: getHighPrecisionTimestamp() });
      
      case 'day-vote-abstain':
        return setDB(`${actionPath}/DAY_VOTE/${meId}`, { target: '0', ts: getHighPrecisionTimestamp() });
      
      // 猎人操作
      case 'hunter-shoot':
        if (!sel) return;
        return setDB(`${actionPath}/HUNTER/${meId}`, { 
          target: sel, 
          ts: getHighPrecisionTimestamp(), 
          processed: false 
        });
      
      // 警徽操作
      case 'badge-pass':
        return this.handleBadgePass(setDB, sel);
      
      case 'badge-destroy':
        return this.handleBadgeDestroy(setDB);
    }
  },

  // 各种操作的具体处理方法
  async handleSwapIdentities(setDB, meId) {
    const mePlayer = this.full.players?.[meId];
    if (!mePlayer || mePlayer.isReady) return;
    
    // 乐观更新
    const swapped = [...mePlayer.identities].reverse();
    mePlayer.identities = swapped;
    this.renderIdentity(mePlayer, this.full);
    
    return setDB(`games/${this.gameId}/players/${meId}/identities`, swapped);
  },

  async handleWolfFinal(setDB, actionPath, meId) {
    // 修复权限验证：仅拍板狼可确认最终目标
    const alphaId = this.getAlphaWolfId(this.full);
    if (String(alphaId) !== String(meId)) {
      this.toast('只有拍板狼可以确认最终目标', 'error');
      return;
    }
    
    const myVote = this.full.actions?.[this.full.state.round]?.NIGHT?.WOLF?.[meId]?.target;
    if (myVote) {
      return setDB(`${actionPath}/NIGHT/WOLF/final`, myVote);
    }
  },

  async handleWitchCure(setDB, actionPath, meId, r) {
    const witchAct = this.full.actions?.[r]?.NIGHT_WITCH || {};
    if (witchAct.poison) { 
      this.toast('本夜已使用毒药，不能再用解药', 'error'); 
      return; 
    }
    
    const wolfTarget = this.getWolfFinalTarget(this.full);
    if (!wolfTarget || wolfTarget === '0') { 
      this.toast('本夜无可救目标', 'error'); 
      return; 
    }
    
    await setDB(`${actionPath}/NIGHT_WITCH/cure`, { 
      target: wolfTarget, 
      ts: getHighPrecisionTimestamp() 
    });
    return setDB(`games/${this.gameId}/players/${meId}/skill/cureUsed`, true);
  },

  async handleWitchPoison(setDB, actionPath, meId, sel) {
    const witchAct = this.full.actions?.[this.full.state.round]?.NIGHT_WITCH || {};
    if (witchAct.cure) { 
      this.toast('本夜已使用解药，不能再用毒药', 'error'); 
      return; 
    }
    
    await setDB(`${actionPath}/NIGHT_WITCH/poison`, { 
      target: sel, 
      ts: getHighPrecisionTimestamp() 
    });
    return setDB(`games/${this.gameId}/players/${meId}/skill/poisonUsed`, true);
  },

  async handleBadgePass(setDB, sel) {
    const post = this.full.state.postBadge;
    const target = this.full.players?.[sel];
    
    if (!target?.isAlive) { 
      this.toast('只能把警徽移交给存活的玩家', 'error'); 
      return; 
    }
    if (String(sel) === String(post.dead)) { 
      this.toast('不能移交给自己', 'error'); 
      return; 
    }
    
    await setDB(`games/${this.gameId}/players/${post.dead}/badge`, 0);
    await setDB(`games/${this.gameId}/players/${sel}/badge`, 1);
    await this.engine.log(`⭐ 警徽移交给了 ${sel}号。`, false);
    return this.engine.to(post.next || PHASE.DAY_TALK, { postBadge: null });
  },

  async handleBadgeDestroy(setDB) {
    const post = this.full.state.postBadge;
    await setDB(`games/${this.gameId}/players/${post.dead}/badge`, 0);
    await this.engine.log(`🗑️ 警徽被撕毁。`, false);
    return this.engine.to(post.next || PHASE.DAY_TALK, { postBadge: null });
  },

  async handleWolfVote(targetId) {
    const r = this.full.state.round;
    const meId = this.me;
    
    return this.performDatabaseOperation(
      () => db.ref(`games/${this.gameId}/actions/${r}/NIGHT/WOLF/${meId}`).set({ 
        target: String(targetId), 
        ts: getHighPrecisionTimestamp() 
      }),
      '狼人投票'
    );
  },

// 工具方法（与Engine保持一致）
  getActiveRole(player, players, state, settings) {
    if (!player || !player.isAlive) return null;
    const idx = Math.min(player.deaths || 0, 1);
    return player.identities?.[idx]?.role || null;
  },

  isPlayerActingWolf(player, data, hiddenActive) {
    if (!player?.isAlive) return false;
    const ar = this.getActiveRole(player, data.players, data.state, data.settings);
    return ar === '狼人' || (ar === '隐狼' && hiddenActive);
  },

  getWolfFinalTarget(data) { 
    return data.actions?.[data.state.round]?.NIGHT?.WOLF?.final || null; 
  },

  isWitchActionDone(data) { 
    return data.actions?.[data.state.round]?.NIGHT_WITCH?.done === true; 
  },

  getAlphaWolfId(data) {
    const hiddenActive = this.getHiddenActive(data);
    const actingWolves = Object.values(data.players || {}).filter(p => 
      this.isPlayerActingWolf(p, data, hiddenActive)
    );
    return actingWolves.length > 0 ? Math.min(...actingWolves.map(p => p.id)) : null;
  },

  computeSeerResult(data, targetPid) {
    const target = data.players?.[targetPid];
    if (!target) return '无效目标';
    
    const mode = data.settings?.seerMode || 'faction';
    const hiddenActive = this.getHiddenActive(data);
    
    if (mode === 'identity') {
      const role = this.getActiveRole(target, data.players, data.state, data.settings);
      if (role === '隐狼' && !hiddenActive) {
        // 修复边界情况：确保总是返回有效角色
        const otherRole = (target.identities || []).find(id => id.role !== '隐狼')?.role;
        return otherRole || '平民';
      }
      return role || '未知身份';
    } else {
      const isWolfFaction = (target.identities || []).some(i => 
        i.role === '狼人' || (i.role === '隐狼' && hiddenActive)
      );
      return isWolfFaction ? '狼人阵营' : '好人阵营';
    }
  },

  getSeerResultsForMe(data) {
    const results = [];
    if (!data.actions) return results;
    
    for (const round in data.actions) {
      const seerAction = data.actions[round]?.NIGHT?.SEER?.[this.me];
      if (seerAction) {
        results.push({ round: parseInt(round, 10), ...seerAction });
      }
    }
    return results.sort((a, b) => a.round - b.round);
  },

  // 日志相关（优化：缓存随 onValueChange 更新）
  openLogs() {
    if (!this.full) return;
    
    // 如果缓存过期（根据 uiState.lastUpdate），重新生成
    if (!this._cachedLogs || (this._cachedLogs.timestamp || 0) < (this.uiState.lastUpdate || 0)) {
      const logs = Object.values(this.full.logs || {})
        .filter(l => !l.secret)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      
      this._cachedLogs = {
        logs,
        timestamp: Date.now()
      };
    }
    
    const box = $('game-log-content');
    box.innerHTML = this._cachedLogs.logs.length
      ? this._cachedLogs.logs
          .map(l => `
            <div class="log-item">
              <span class="log-round">第${l.round || 0}轮</span> 
              ${escapeHtml(l.msg)}
            </div>
          `)
          .join('')
      : '<div class="log-item">暂无日志</div>';
    
    $('logs-modal').classList.add('open');
    
    // 聚焦到模态框以支持键盘导航
    setTimeout(() => {
      const modal = $('logs-modal')?.querySelector('.modal-content .modal-close');
      if (modal && typeof modal.focus === 'function') modal.focus();
    }, 100);
  },

  closeModal(id) {
    const m = id ? document.getElementById(id) : document.querySelector('.modal.open');
    if (m) {
      m.classList.remove('open');
      const trigger = document.activeElement;
      if (trigger && trigger.blur) trigger.blur();
    }
  },

  // 改进的通知系统（支持 key 复用，避免选人刷屏；并重置计时器维持同一动画体验）
  toast(txt, type = 'info', duration = 3000, options = {}) {
    const { key } = options || {};
    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    };
    const icon = icons[type] || icons.info;

    const container = $('notification-container');
    if (!container) return;

    // 如果提供 key，复用对应的通知节点
    if (key) {
      let n = this._toastKeyMap.get(key);
      if (n && n.parentNode) {
        // 更新内容并重置定时器
        n.innerHTML = `${icon} ${escapeHtml(txt)}`;
        // 清除旧的定时器
        const oldTimer = this._toastTimers.get(key);
        if (oldTimer) clearTimeout(oldTimer);
        // 重新设置定时器
        const timer = setTimeout(() => {
          n.style.opacity = '0';
          n.style.transform = 'translateX(100%)';
          setTimeout(() => {
            if (n.parentNode) n.parentNode.removeChild(n);
            this._toastKeyMap.delete(key);
            this._toastTimers.delete(key);
          }, 300);
        }, duration);
        this._toastTimers.set(key, timer);
        return;
      }
    }

    // 创建新的通知
    const n = el(`
      <div class="notification ${type}" style="opacity: 0; transform: translateX(100%);">
        ${icon} ${escapeHtml(txt)}
      </div>
    `);
    container.appendChild(n);

    // 入场动画
    requestAnimationFrame(() => {
      n.style.opacity = '1';
      n.style.transform = 'translateX(0)';
    });

    // 自动移除
    const autoRemove = () => {
      n.style.opacity = '0';
      n.style.transform = 'translateX(100%)';
      setTimeout(() => {
        if (n.parentNode) n.parentNode.removeChild(n);
        if (key) {
          this._toastKeyMap.delete(key);
          this._toastTimers.delete(key);
        }
      }, 300);
    };

    let timer = setTimeout(autoRemove, duration);

    // 点击关闭（立即移除）
    n.addEventListener('click', () => {
      clearTimeout(timer);
      autoRemove();
    });

    // 记录 key 映射
    if (key) {
      this._toastKeyMap.set(key, n);
      this._toastTimers.set(key, timer);
    }
  },

  // 主机状态面板（增强版）
  renderHostStatusDashboard(data) {
    const st = data.state;
    let statusText = '';
    let progressInfo = null;
    
    switch (st.phase) {
      case PHASE.NIGHT:
      case PHASE.NIGHT_WITCH: {
        const hiddenActive = this.getHiddenActive(data);
        const actingWolves = Object.values(data.players || {}).filter(p => 
          this.isPlayerActingWolf(p, data, hiddenActive)
        );
        const wolfVotes = data.actions?.[st.round]?.NIGHT?.WOLF || {};
        const votedWolves = actingWolves.filter(w => wolfVotes[w.id]?.target !== undefined);
        
        statusText = `夜晚进行中 - 狼人投票: ${votedWolves.length}/${actingWolves.length}`;
        
        if (st.phase === PHASE.NIGHT_WITCH) {
          const witchAlive = Object.values(data.players || {}).some(p => 
            p.isAlive && this.getActiveRole(p, data.players, data.state, data.settings) === '女巫'
          );
          const witchDone = this.isWitchActionDone(data);
          statusText += ` | 女巫: ${witchAlive ? (witchDone ? '已完成' : '行动中') : '不在场'}`;
        }
        break;
      }
      
      case PHASE.SHERIFF_CAND: {
        const players = Object.values(data.players || {});
        const alivePlayers = players.filter(p => p.isAlive);
        const submitted = Object.keys(st.sheriff?.candidates || {}).length;
        statusText = `上警意向提交：${submitted} / ${alivePlayers.length}`;
        progressInfo = { current: submitted, total: alivePlayers.length };
        break;
      }
      
      case PHASE.SHERIFF_VOTE:
      case PHASE.DAY_VOTE: {
        const players = Object.values(data.players || {});
        const voters = players.filter(p => p.isAlive && !p.isExposedIdiot);
        const votes = (st.phase === PHASE.SHERIFF_VOTE) ? 
          (st.sheriff?.votes || {}) : 
          (data.actions?.[st.round]?.DAY_VOTE || {});
        statusText = `投票进度: ${Object.keys(votes).length} / ${voters.length}`;
        progressInfo = { current: Object.keys(votes).length, total: voters.length };
        break;
      }
      
      default:
        return '';
    }
    
    let html = `<div class="host-status-dashboard">${statusText}`;
    
    if (progressInfo) {
      const percentage = progressInfo.total > 0 ? 
        (progressInfo.current / progressInfo.total * 100) : 0;
      html += `
        <div class="progress-bar" style="margin-top: 8px;">
          <div class="progress-fill" style="width: ${percentage}%"></div>
        </div>
      `;
    }
    
    html += `</div>`;
    return html;
  },

  // 清理和销毁
  destroy() {
    try {
      if (this.listener.ref && this.listener.cb) {
        this.listener.ref.off('value', this.listener.cb);
        console.log('Firebase listener removed.');
      }
      
      if (this.listener.onlineRef) {
        this.listener.onlineRef.onDisconnect().cancel();
        this.listener.onlineRef.set(false);
        console.log('Firebase onDisconnect handler cancelled.');
      }
      
      if (this.autorun) {
        clearInterval(this.autorun);
        this.autorun = null;
        console.log('Engine timer cleared.');
      }
      
      // 清理UI状态
      this.clearSelection();
      this.uiState.loading.clear();
      this.uiState.animations.clear();
      this.uiState.pendingActions.clear();
      this.uiState.optimisticUpdates.clear();
      
      // 清理 toast timers
      this._toastTimers.forEach((t) => clearTimeout(t));
      this._toastTimers.clear();
      this._toastKeyMap.clear();

      this.listener = { ref: null, cb: null, onlineRef: null };
      this.full = null;
      this._cachedLogs = null;
    } catch (e) {
      console.warn('Destroy encountered an error:', e);
    }
  }
};

/* ==================================================================
 *  5. 样式增强和动画支持
 * 说明：为避免与 styles.css 重复，这里不再注入 ripple-animation 等样式。
 * ================================================================== */

/* ==================================================================
 *  6. 启动应用 & 全局事件
 * ================================================================== */

// 性能监控
const performanceMonitor = {
  startTime: Date.now(),
  
  mark(label) {
    if (window.performance && performance.mark) {
      performance.mark(label);
    }
  },
  
  measure(name, startMark, endMark) {
    if (window.performance && performance.measure) {
      try {
        performance.measure(name, startMark, endMark);
      } catch (e) {
        console.warn('Performance measurement failed:', e);
      }
    }
  }
};

// 错误处理
window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
  if (App.toast) {
    App.toast('发生了意外错误，请刷新页面重试', 'error', 5000);
  }
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  if (App.toast) {
    App.toast('网络连接可能存在问题', 'warning', 3000);
  }
});

// 页面卸载时清理
window.addEventListener('beforeunload', () => {
  performanceMonitor.mark('app-destroy-start');
  App.destroy();
  performanceMonitor.mark('app-destroy-end');
  performanceMonitor.measure('app-destroy', 'app-destroy-start', 'app-destroy-end');
});

// 页面可见性变化处理
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && App.full) {
    // 页面重新可见时，刷新连接状态
    if (App.listener.onlineRef) {
      App.listener.onlineRef.set(true).catch(console.error);
    }
  }
});

// 应用初始化
document.addEventListener('DOMContentLoaded', () => {
  performanceMonitor.mark('app-init-start');
  
  try {
    App.init();
    performanceMonitor.mark('app-init-end');
    performanceMonitor.measure('app-init', 'app-init-start', 'app-init-end');
    
    console.log('狼人杀应用已启动 (v12.0 修复版)');
  } catch (error) {
    console.error('App initialization failed:', error);
    document.body.innerHTML = `
      <div style="
        display: flex; 
        align-items: center; 
        justify-content: center; 
        height: 100vh; 
        background: var(--bg-primary);
        color: var(--text-primary);
        text-align: center;
        padding: 20px;
      ">
        <div>
          <h2>应用启动失败</h2>
          <p>请刷新页面重试，或检查网络连接</p>
          <button onclick="location.reload()" style="
            margin-top: 20px;
            padding: 10px 20px;
            background: var(--accent-primary);
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
          ">刷新页面</button>
        </div>
      </div>
    `;
  }
});

// 导出用于调试
if (typeof window !== 'undefined') {
  window.WerewolfApp = App;
  window.WerewolfEngine = Engine;
}
