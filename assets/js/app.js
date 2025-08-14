/**********************************************************************
 * 双身份狼人杀 - 电子法官 (V11.5 Focused Edition)
 * 关键更新：
 * - 放逐投票：比较用3/2（避免浮点误差），公布显示1.5/1，并按“目标 -> 投其者列表 + 合计票数”格式记录日志。
 * - 夜晚信息完全保密：夜晚阶段（含女巫阶段）对所有人只显示“夜晚进行中”，日志中的夜晚细节均标记为秘密，任何人都看不到。
 * - 上警意向二选一：上/不上警提交即锁定；全员提交自动进入发言；主持强制进入发言会把未提交者视为不上警。
 * - 骑士决斗：按是否“携带狼牌（狼人/隐狼）”判定，忽视隐狼隐匿与当前活跃身份。
 * - 猎人开枪：允许猎人第二张身份死亡后（玩家已出局）仍可在猎人阶段开枪；猎人开枪不影响“平安夜”统计。
 * - 发牌：原始对偶先禁配（盗贼+狼人/隐狼禁止），金宝宝允许盗贼复制得到。
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

/* ==================================================================
 *  1. 工具函数
 * ================================================================== */

const $ = id => document.getElementById(id);
const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };
const escapeHtml = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const shuffle = a => { let i = a.length; while (i) { const r = Math.random() * i-- | 0;[a[i], a[r]] = [a[r], a[i]] } return a };
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
  constructor(gameId) { this.id = gameId; this.state = null; this.players = null; this.actions = null; this.settings = null; }
  ref(p) { return db.ref(`games/${this.id}/${p}`); }
  async read(p) { return (await this.ref(p).once('value')).val(); }
  write(p, v) { return this.ref(p).set(v); }
  update(obj) { return db.ref(`games/${this.id}`).update(obj); }
  push(p, v) { return this.ref(p).push(v); }

  async tick() {
    const state = await this.read('state') || {};
    this.state = state;
    // 黎明结算和游戏结束由事件驱动，tick不主动处理，防止重入
    if (state.phase === PHASE.DAWN || state.phase === PHASE.GAME_OVER) return;

    const players = await this.read('players') || {};
    const actions = await this.read('actions') || {};
    const settings = await this.read('settings') || {};
    this.players = players; this.actions = actions; this.settings = settings;

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

  async to(phase, extra = {}) {
    const updates = { 'state/phase': phase };
    for (const key in extra) { updates[`state/${key}`] = extra[key]; }
    await this.update(updates);
  }

  activeIdx(p) { return Math.min(p.deaths || 0, 1); }
  activeRole(p) { return p.isAlive ? p.identities[this.activeIdx(p)].role : null; }

  // 引擎侧隐狼激活：固定为“场上没有存活且活跃狼人时激活”
  isHiddenWolfActivated(players, state) {
    return !Object.values(players).some(p => p.isAlive && this.activeRole(p) === '狼人');
  }

  getAliveActingWolves(players, state) {
    const activated = this.isHiddenWolfActivated(players, state);
    return Object.values(players).filter(p => {
      if (!p.isAlive) return false;
      const ar = this.activeRole(p);
      return ar === '狼人' || (ar === '隐狼' && activated);
    });
  }

  getGuardChoice() { return Object.values(this.actions?.[this.state.round]?.NIGHT?.GUARD || {})[0]?.target; }
  getWolfFinalTarget() { return this.actions?.[this.state.round]?.NIGHT?.WOLF?.final; }
  getWitchCureTarget() { return this.actions?.[this.state.round]?.NIGHT_WITCH?.cure; }
  getWitchPoisonTarget() { return this.actions?.[this.state.round]?.NIGHT_WITCH?.poison; }
  isWitchActionDone() { return this.actions?.[this.state.round]?.NIGHT_WITCH?.done === true; }

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
    if (this.state.resolving) return;
    await this.write('state/resolving', true);
    await this.log('黎明到来，开始结算夜晚事件...', true);

    const r = this.state.round;
    const deaths = [];
    const wolfTarget = this.getWolfFinalTarget();
    const guardTarget = this.getGuardChoice();
    let cureTarget = this.getWitchCureTarget();
    const poisonTarget = this.getWitchPoisonTarget();

    await this.log(`[结算细节] 狼刀:${wolfTarget || '无'}, 守卫:${guardTarget ?? '无'}, 解药:${cureTarget || '无'}, 毒药:${poisonTarget || '无'}`, true);

    // 女巫自救规则后端校验
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

    // 狼刀
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

    // 毒
    if (poisonTarget && !deaths.some(d => String(d.pid) === String(poisonTarget))) {
      deaths.push({ pid: poisonTarget, cause: 'POISON' });
      await this.log(`☠️ ${poisonTarget}号玩家被女巫毒杀。`, true);
    }

    let anyHunterTriggered = false, sheriffDied = null;
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
          if (deathResult.sheriffDied) sheriffDied = d.pid;
        }
      }
    } else {
      await this.log('昨夜是平安夜。', false);
      await this.write('state/peace', (this.state.peace || 0) + 1);
    }

    if (await this.checkWin()) {
      await this.write('state/resolving', null); return;
    }

    let nextPhase = r === 1 ? PHASE.SHERIFF_CAND : PHASE.DAY_TALK;
    if (r === 1) await this.update({ 'state/sheriff': { candidates: {}, votes: {}, drops: {}, isPK: false } });

    if (sheriffDied) {
      await this.to(PHASE.BADGE, { postBadge: { dead: sheriffDied, next: nextPhase } });
    } else if (anyHunterTriggered) {
      await this.to(PHASE.HUNTER, { nextPhaseAfterHunter: nextPhase });
    } else {
      await this.to(nextPhase);
    }
    await this.write('state/resolving', null);
  }

  async checkDayVote() {
    const r = this.state.round;
    const voters = Object.values(this.players).filter(p => p.isAlive && !p.isExposedIdiot);
    const rec = this.actions?.[r]?.DAY_VOTE || {};
    if (voters.length === 0 || voters.every(v => rec[v.id] !== undefined)) {
      await this.tallyDayVote();
    }
  }

  async tallyDayVote() {
    const r = this.state.round;
    const rec = this.actions?.[r]?.DAY_VOTE || {};
    const sheriff = Object.values(this.players).find(p => p.badge);

    const weightInt = pid => (sheriff && String(pid) === String(sheriff.id)) ? 3 : 2; // 比较用 3/2
    const weightDisp = pid => (sheriff && String(pid) === String(sheriff.id)) ? 1.5 : 1; // 公布显示 1.5/1

    // 统计
    const countsInt = {}; // 目标 -> 累计（2/3整数权重）
    const votesByTarget = {}; // 目标 -> [投票者id(附带是否警长标记)]
    const abstainers = [];    // 弃票者列表

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

    // 计算结果
    const maxInt = Math.max(0, ...Object.values(countsInt));
    const outPlayers = Object.keys(countsInt).filter(k => countsInt[k] === maxInt);

    // 票型日志（按你给定格式）
    const fmtVoteNum = n => (Number.isInteger(n) ? `${n}票` : `${n.toFixed(1).replace(/\.0$/, '')}票`);
    const lines = [];
    lines.push('放逐投票');
    // 按被投目标升序
    Object.keys(votesByTarget)
      .map(k => Number(k)).sort((a,b) => a - b).forEach(target => {
        const voters = votesByTarget[target].map(String).sort((a,b) => {
          const na = parseInt(a), nb = parseInt(b);
          if (isNaN(na) || isNaN(nb)) return a.localeCompare(b);
          return na - nb;
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
    const voters = Object.values(this.players).filter(p => p.isAlive && !p.isExposedIdiot);
    const votes = this.state.sheriff?.votes || {};
    if (voters.every(pl => votes[pl.id] !== undefined)) {
      await this.tallySheriff();
    }
  }

  async tallySheriff() {
    const { candidates, votes, isPK, drops } = this.state.sheriff || {};
    const validCandidates = Object.keys(candidates || {}).filter(id => candidates[id] && !(drops || {})[id]);

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
    const players = await this.read('players') || {};
    const alive = Object.values(players).filter(p => p.isAlive);
    const sheriff = (await this.read('state/sheriff')) || { candidates: {}, votes: {}, drops: {}, isPK: false };
    const cand = sheriff.candidates || {};
    for (const p of alive) {
      if (!Object.prototype.hasOwnProperty.call(cand, p.id)) {
        cand[p.id] = false; // 未提交视为不上警
      }
    }
    await this.update({ 'state/sheriff': { ...sheriff, candidates: cand } });
    await this.log('主持人强制进入发言阶段：未提交者视为未上警。', false);
    await this.to(PHASE.SHERIFF_SPEECH);
  }

  async startNight(round) {
    await this.update({ 'state/round': round, 'state/phase': PHASE.NIGHT });
    await this.log(`第 ${round} 夜来临...`, false);
  }

  async kill(pid, cause) {
    // 读取最新 players，避免并发时快照过期
    const freshPlayers = (await this.read('players')) || this.players;
    this.players = freshPlayers;

    const p = this.players[pid];
    if (!p || !p.isAlive) return {};

    const newDeaths = (p.deaths || 0) + 1;
    const isOut = newDeaths >= 2;
    const updates = { [`players/${pid}/deaths`]: newDeaths, [`players/${pid}/isAlive`]: !isOut };
    let hunterTriggered = false, sheriffDied = !!p.badge && isOut;

    // 白痴翻牌免死（仅VOTE触发）
    if (this.activeRole(p) === '白痴' && cause === 'VOTE' && !p.isExposedIdiot) {
      updates[`players/${pid}/isExposedIdiot`] = true;
      updates[`players/${pid}/isAlive`] = true;
      updates[`players/${pid}/deaths`] = 1;
      sheriffDied = false;
      await this.log(`🤪 ${pid}号白痴被票出，翻牌免死，但失去投票权。`, false);
    }

    // 猎人触发（被狼/毒/票/决斗/枪带走）
    if (this.activeRole(p) === '猎人' && ['WOLF', 'POISON', 'VOTE', 'DUEL', 'SHOT'].includes(cause)) {
      const q = (await this.read('state/hunters')) || {};
      q[pid] = true;
      updates['state/hunters'] = q;
      hunterTriggered = true;
      await this.log(`🔫 ${pid}号猎人倒牌，可以开枪。`, false);
    }

    await this.update(updates);

    // 同步内存快照
    this.players[pid] = { ...p, deaths: updates[`players/${pid}/deaths`], isAlive: updates[`players/${pid}/isAlive`], isExposedIdiot: updates[`players/${pid}/isExposedIdiot`] ?? p.isExposedIdiot };
    return { hunterTriggered, sheriffDied };
  }

  async processKnightActions() {
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
    const r = this.state.round;
    const q = (await this.read('state/hunters')) || {};
    const shooters = Object.keys(q).filter(pid => q[pid]);

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
          await this.to(PHASE.BADGE, { postBadge: { dead: targetPid, next } });
        }
        return;
      }
    }
  }

  async duel(fromPid, targetPid) {
    const from = this.players[fromPid], target = this.players[targetPid];
    if (!from?.isAlive || !target?.isAlive) return;

    // 忽视隐匿与活跃身份：只要携带狼人/隐狼牌，骑士即判定成功
    const isWolfFaction = target.identities?.some(i => i.role === '狼人' || i.role === '隐狼');

    if (isWolfFaction) {
      await this.log(`⚔️ ${fromPid}号骑士对 ${targetPid}号 发动决斗成功，目标是狼人阵营！`, false);
      const deathResult = await this.kill(targetPid, 'DUEL');
      if (await this.checkWin()) return;
      if (deathResult.sheriffDied) await this.to(PHASE.BADGE, { postBadge: { dead: targetPid, next: PHASE.NIGHT } });
      else if (deathResult.hunterTriggered) await this.to(PHASE.HUNTER, { nextPhaseAfterHunter: PHASE.NIGHT });
      else await this.startNight(this.state.round + 1);
    } else {
      await this.log(`⚔️ ${fromPid}号骑士对 ${targetPid}号 决斗失败，目标非狼人阵营。`, false);
      const deathResult = await this.kill(fromPid, 'DUEL');
      if (await this.checkWin()) return;
      if (deathResult.sheriffDied) await this.to(PHASE.BADGE, { postBadge: { dead: fromPid, next: this.state.phase } });
      else if (deathResult.hunterTriggered) await this.to(PHASE.HUNTER, { nextPhaseAfterHunter: this.state.phase });
    }
  }

  async checkWin() {
    const playersFresh = (await this.read('players')) || this.players;
    this.players = playersFresh;

    const alivePlayers = Object.values(this.players).filter(p => p.isAlive);
    const anyWolfCardHolderAlive = Object.values(this.players).some(p => p.isAlive && p.identities.some(id => id.role === '狼人' || id.role === '隐狼'));

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
      const godAlive = alivePlayers.some(p => GOD_ROLES.has(this.activeRole(p)));
      const civilianAlive = alivePlayers.some(p => { const r = this.activeRole(p); return r && ROLES[r].faction === 'good' && !ROLES[r].isGod; });
      if (!godAlive || !civilianAlive) {
        const reason = !godAlive ? '所有神职出局' : '所有平民出局';
        await this.to(PHASE.GAME_OVER, { winner: '🐺 狼人屠边获胜' });
        await this.log(`🏁 游戏结束：狼人屠边获胜（${reason}）。`, false);
        return true;
      }
    }
    return false;
  }

  async log(msg, secret = false) {
    await this.push('logs', { msg, ts: firebase.database.ServerValue.TIMESTAMP, round: this.state.round || 0, secret });
  }
}

/* ==================================================================
 *  4. 前端应用 (App) - 客户端UI与交互
 * ================================================================== */

const App = {
  me: null, gameId: null, engine: null,
  listener: { ref: null, cb: null, onlineRef: null },
  full: null, selection: null, autorun: null,

  init() {
    this.destroy();
    document.addEventListener('click', (e) => this.onClick(e));
    document.body.addEventListener('click', (e) => {
        if (e.target.closest('#game-layout') && !e.target.closest('.player-card, .action-panel, .host-controls')) {
            if (this.selection) {
                this.selection = null;
                if (this.full) { this.renderPlayers(this.full); this.renderActions(this.full); }
            }
        }
    }, true);

    const p = new URLSearchParams(location.search);
    this.gameId = p.get('game') || '';
    this.me = p.get('player') || '';

    if (this.gameId) {
        $('setup-view').classList.add('hidden');
        const gameView = $('game-view');
        gameView.classList.remove('hidden');
        gameView.innerHTML = `<div class="loading-prompt">正在加入游戏房间...</div>`;
        if (this.me) this.enterGame();
        else this.renderJoinPrompt();
    } else {
        this.renderSetup();
    }
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
            <button class="num-btn" data-role="${role}" data-op="-">-</button>
            <input id="role-${role}" type="number" value="${def}" readonly />
            <button class="num-btn" data-role="${role}" data-op="+">+</button>
          </div>
        </div>
      `);
        item.querySelectorAll('.num-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const input = $(`role-${btn.dataset.role}`);
          let val = parseInt(input.value, 10);
          val += (btn.dataset.op === '+') ? 1 : -1;
          val = Math.max(0, val);
          input.value = val;
          this.updateSetupStats();
        });
      });
      grid.appendChild(item);
    });

    $('opt-witch-selfsave').value = 'noFirstNightSelfSave';
    $('opt-seer-mode').value = 'faction';
    $('opt-wolf-win').value = 'edge';
    $('opt-wolf-visibility').value = 'activeOnly';

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
    warn.textContent = (total === 0 || total % 2 !== 0) ? '身份总数必须为偶数且大于 0' : '';
  },

  async createGame() {
    const counts = {};
    $('role-grid').querySelectorAll('input').forEach(i => {
      const r = i.id.replace('role-', '');
      const v = +i.value || 0;
      if (v) counts[r] = v;
    });

    const pool = [];
    for (const [r, c] of Object.entries(counts)) {
      for (let i = 0; i < c; i++) pool.push(r);
    }

    if (pool.length === 0 || pool.length % 2 !== 0) { this.toast('身份总数必须为偶数且大于0', 'error'); return; }

    const dealt = this.dealWithGolden(pool);
    if (!dealt) { this.toast('无法生成合规的牌组，请检查配置是否出现禁用组合或无法满足金宝宝条件。', 'error'); return; }

    const id = db.ref('games').push().key;
    const players = {};
    dealt.pairs.forEach((pair, i) => {
      players[i + 1] = {
        id: i + 1, name: `玩家${i + 1}`, identities: pair,
        deaths: 0, isAlive: true, isReady: false,
        isExposedIdiot: false, badge: 0, skill: {}
      };
    });

    const settings = {
      witchRule: $('opt-witch-selfsave').value,
      seerMode: $('opt-seer-mode').value,
      wolfWin: $('opt-wolf-win').value,
      // 仅用于“互见”逻辑；引擎侧隐狼激活不依赖此项
      hiddenTrigger: $('opt-wolf-visibility').value
    };
    const config = { counts, settings };

    const initData = {
      meta: { createdAt: now(), creator: 'FSM-v11.5' },
      config, players, settings, actions: {}, logs: {},
      state: { phase: PHASE.LOBBY, round: 0, host: 1, peace: 0, winner: null, sheriff: null }
    };

    await db.ref(`games/${id}`).set(initData);
    this.toast('游戏房间创建成功！', 'success');
    location.href = `${location.pathname}?game=${id}&player=1`;
  },

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
        id: i + 1, name: oldPlayers[i]?.name || `玩家${i + 1}`, identities: pair,
        deaths: 0, isAlive: true, isReady: false,
        isExposedIdiot: false, badge: 0, skill: {}
      };
    });

    const initData = {
      meta: { createdAt: now(), creator: 'FSM-v11.5', from: oldGameId },
      config, players, settings: config.settings, actions: {}, logs: {},
      state: { phase: PHASE.LOBBY, round: 0, host: this.full.state.host, peace: 0, winner: null, sheriff: null }
    };

    await db.ref(`games/${newGameId}`).set(initData);
    await db.ref(`games/${oldGameId}/state/nextGameId`).set(newGameId);
  },

  // 发牌：原始对偶先禁配（盗贼+狼），再展开盗贼复制；金宝宝允许盗贼复制得到
  dealWithGolden(pool) {
    for (let t = 0; t < 10000; t++) {
      const d = shuffle([...pool]);
      const pairs = [];
      let isCombinationOk = true;

      // 原始对偶禁配
      for (let i = 0; i < d.length; i += 2) {
        const role1 = d[i], role2 = d[i + 1];
        const origKey = [role1, role2].sort().join('|');
        if (FORBIDDEN_PAIRS.has(origKey)) { isCombinationOk = false; break; }
        if (role1 === '盗贼' && role2 === '盗贼') { isCombinationOk = false; break; }
      }
      if (!isCombinationOk) continue;

      // 展开盗贼复制
      for (let i = 0; i < d.length; i += 2) {
        let role1 = d[i], role2 = d[i + 1];
        if (role1 === '盗贼') pairs.push([{ role: role2, isCopy: true }, { role: role2 }]);
        else if (role2 === '盗贼') pairs.push([{ role: role1 }, { role: role1, isCopy: true }]);
        else pairs.push([{ role: role1 }, { role: role2 }]);
      }

      // 展开后禁配（例如预言家|狼人）
      for (const pair of pairs) {
        const key = [pair[0].role, pair[1].role].sort().join('|');
        if (FORBIDDEN_PAIRS.has(key)) { isCombinationOk = false; break; }
      }
      if (!isCombinationOk) continue;

      // 金宝宝：允许盗贼复制得到
      const hasGolden = pairs.some(pr => pr[0].role === '平民' && pr[1].role === '平民');
      if (hasGolden) return { pairs };
    }
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
        <h2>进入游戏房间</h2> <p>请输入你的座位号</p>
        <input type="number" id="player-number-input" placeholder="例如: 1" />
        <button class="btn-primary" data-action="join-game">确认进入</button>
      </div>
    `;
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
            <button class="control-btn" data-action="copy-link" data-link="${location.origin}${location.pathname}?game=${this.gameId}">复制链接</button>
          </div>
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

  async enterGame() {
    this.engine = new Engine(this.gameId);
    const rootRef = db.ref(`games/${this.gameId}`);
    const onlineRef = db.ref(`games/${this.gameId}/players/${this.me}/online`);
    await onlineRef.set(true);
    onlineRef.onDisconnect().set(false);

    const onValueChange = snap => {
      const data = snap.val();
      if (!data) { this.toast('游戏数据不存在或已被删除。', 'error'); this.destroy(); return; }

      if (data.state?.nextGameId) {
        const newUrl = `${location.pathname}?game=${data.state.nextGameId}&player=${this.me}`;
        this.toast('即将开始新对局...', 'success');
        const manualLink = el(`<div class="notification info">如果页面没有自动跳转，请 <a href="${newUrl}" style="color: white; font-weight: bold;">点击这里</a></div>`);
        $('notification-container').appendChild(manualLink);
        setTimeout(() => { location.href = newUrl; }, 2500);
        return;
      }

      this.full = data;
      const isHost = String(data.state.host) === this.me;
      if (isHost && !this.autorun) {
        this.autorun = setInterval(() => this.engine.tick().catch(console.error), 500);
        console.log("主持端引擎已启动。");
      } else if (!isHost && this.autorun) {
        clearInterval(this.autorun); this.autorun = null; console.log("非主持端，引擎已停止。");
      }

      if (data.state.phase !== PHASE.LOBBY) {
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
      [PHASE.SETUP]: '等待所有玩家确认身份', [PHASE.LOBBY]: '游戏大厅 - 等待开始',
      [PHASE.NIGHT]: `第 ${st.round} 夜晚 - 行动中`, [PHASE.NIGHT_WITCH]: `第 ${st.round} 夜晚 - 行动中`,
      [PHASE.DAWN]: '黎明结算中...', [PHASE.SHERIFF_CAND]: '警长竞选 - 上警意向',
      [PHASE.SHERIFF_SPEECH]: '警长竞选 - 发言阶段', [PHASE.SHERIFF_VOTE]: '警长竞选 - 投票阶段',
      [PHASE.DAY_TALK]: `第 ${st.round} 白天 - 发言阶段`, [PHASE.DAY_VOTE]: `第 ${st.round} 白天 - 放逐投票`,
      [PHASE.HUNTER]: '猎人开枪中...', [PHASE.BADGE]: '警徽移交中...',
      [PHASE.GAME_OVER]: this.full?.state?.winner || '游戏结束'
    };
    $('status-bar').innerHTML = `<span class="status-text">${phaseMap[st.phase] || '未知状态'}</span>`;
  },

  generateIdentityHtml(me, phase) {
    const fmt = id => `<span class="identity-item"><span class="identity-icon">${ROLES[id.role].icon}</span><span class="identity-name${id.isCopy ? ' thief-copy-text' : ''}">${id.role}</span></span>`;
    const canInteract = phase === PHASE.LOBBY && !me.isReady;
    const id1Html = me.deaths >= 1 ? `<span class="identity-dead">${fmt(me.identities[0])}</span>` : fmt(me.identities[0]);
    const id2Html = me.deaths >= 2 ? `<span class="identity-dead">${fmt(me.identities[1])}</span>` : fmt(me.identities[1]);
    let interactionHtml = '';
    if (phase === PHASE.LOBBY) {
      interactionHtml = canInteract
        ? `<div class="identity-actions"><button class="control-btn" data-action="swap">交换</button><button class="confirm-btn" data-action="ready">确认身份</button></div>`
        : `<div class="action-feedback">${me.isReady ? '已确认，等待其他玩家...' : '请确认身份'}</div>`;
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
    $('identity-card').innerHTML = this.generateIdentityHtml(me, data.state.phase);
    const persist = [];
    const ar = this.getActiveRole(me, data.players, data.state, data.settings);
    if (ar === '女巫') {
      persist.push(`女巫药瓶：解药${me.skill?.cureUsed ? '已用' : '可用'}，毒药${me.skill?.poisonUsed ? '已用' : '可用'}`);
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

  renderPlayers(data) {
    const left = $('player-grid-left'), right = $('player-grid-right');
    if (!left || !right) return;
    left.innerHTML = ''; right.innerHTML = '';
    const players = Object.values(data.players || {}).sort((a, b) => a.id - b.id);
    const mid = Math.ceil(players.length / 2);

    const activatedHidden = this.isHiddenWolfActivated(data.players, data.state, data.settings);
    const myPlayer = data.players?.[this.me];
    const wolfVisRule = data.settings?.hiddenTrigger || 'activeOnly'; // 仅用于互见
    const meIsActingWolf = myPlayer ? this.isPlayerActingWolf(myPlayer, data) : false;
    const meHasWolfCard = myPlayer ? myPlayer.identities.some(i => i.role === '狼人' || i.role === '隐狼') : false;
    const meCanSeeWolves = wolfVisRule === 'allWolves' ? meHasWolfCard : meIsActingWolf;

    const wolfVotes = data.actions?.[data.state.round]?.NIGHT?.WOLF || {};
    const voteMap = {};
    Object.entries(wolfVotes).forEach(([voterId, voteData]) => {
      if (voterId === 'final' || !voteData.target) return;
      const targetId = voteData.target === '0' ? voterId : voteData.target;
      if (!voteMap[targetId]) voteMap[targetId] = [];
      voteMap[targetId].push({ voter: voterId, isEmpty: voteData.target === '0' });
    });
    const wolfFinalTarget = wolfVotes?.final;

    players.forEach(p => {
      const card = this.renderPlayerCard(p, data, { meCanSeeWolves, activatedHidden, wolfVisRule, voteMap, wolfFinalTarget });
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

    // 狼人角标与最终刀口仅在狼队可见
    if (ctx.meCanSeeWolves && ctx.voteMap[p.id]) {
      ctx.voteMap[p.id].forEach(vote => {
        const voteDisplay = vote.isEmpty ? '🔪' : vote.voter;
        card.appendChild(el(`<div class="wolf-corner">${voteDisplay}</div>`));
      });
    }
    if (ctx.meCanSeeWolves && ctx.wolfFinalTarget && String(ctx.wolfFinalTarget) === String(p.id)) {
      card.classList.add('wolf-final-target');
    }
    if (this.selection && this.selection.pid === String(p.id)) card.classList.add('selected');

    card.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!p.isAlive && this.full.state.phase !== PHASE.BADGE) return;

      const mePlayer = this.full.players[this.me];
      if (this.isPlayerActingWolf(mePlayer, this.full) && this.full.state.phase === PHASE.NIGHT) {
        this.handleWolfVote(p.id);
      } else {
        this.selection = { pid: String(p.id) };
        this.renderPlayers(this.full);
        this.renderActions(this.full);
      }
    });
    return card;
  },

  renderActions(data) {
    const panel = $('action-panel');
    panel.innerHTML = '';
    const st = data.state;
    const me = data.players?.[this.me];
    if (!me) return;
    const infoBox = (text) => `<div class="action-feedback">${text}</div>`;
    const allowWhenDead = st.phase === PHASE.HUNTER && st.hunters?.[this.me];
    if (!me.isAlive && !allowWhenDead && ![PHASE.BADGE, PHASE.GAME_OVER].includes(st.phase)) {
      panel.innerHTML = infoBox('你已出局，无法行动。'); return;
    }
    const ar = this.getActiveRole(me, data.players, data.state, data.settings);
    const sel = this.selection?.pid;

    if (st.phase === PHASE.NIGHT) {
      let html = '';
      if (this.isPlayerActingWolf(me, data)) {
        const wolfData = data.actions?.[st.round]?.NIGHT?.WOLF || {};
        const myVote = wolfData[me.id]?.target;
        const finalTarget = wolfData.final;
        const alphaId = this.getAlphaWolfId(data);
        const isAlpha = String(alphaId) === String(me.id);
        html = `<div class="action-prompt">夜晚进行中...</div>
                <div class="action-target">我的目标: ${myVote === '0' ? '空刀' : (myVote || '未选择')} | 最终目标: ${finalTarget ?? '未定'}</div>
                <div class="action-buttons">
                  <button class="control-btn" data-action="wolf-empty">空刀</button>
                  ${isAlpha ? `<button class="confirm-btn" data-action="wolf-final" ${!myVote ? 'disabled' : ''}>确认击杀</button>` : ''}
                </div>`;
      } else {
        const roleKey = ar ? ROLES[ar].key : null;
        if (roleKey && data.actions?.[st.round]?.NIGHT?.[roleKey]?.[me.id]) {
          panel.innerHTML = infoBox('夜晚进行中...'); return;
        }
        if (ar === '守卫') {
          html = `<div class="action-prompt">夜晚进行中...</div>
                  <div class="action-target">当前目标: ${sel ? sel + '号' : '未选择'}</div>
                  <div class="action-buttons">
                      <button class="control-btn" data-action="guard-null">空守</button>
                      <button class="confirm-btn" data-action="guard-confirm" ${!sel || sel === me.skill?.lastGuard ? 'disabled' : ''}>确认守护</button>
                  </div>`;
        } else if (ar === '预言家') {
          html = `<div class="action-prompt">夜晚进行中...</div>
                  <div class="action-target">当前目标: ${sel ? sel + '号' : '未选择'}</div>
                  <div class="action-buttons"><button class="confirm-btn" data-action="seer-confirm" ${!sel ? 'disabled' : ''}>确认查验</button></div>`;
        } else {
          html = infoBox('夜晚进行中...');
        }
      }
      panel.innerHTML = html;
      return;
    }

    if (st.phase === PHASE.NIGHT_WITCH) {
      if (ar !== '女巫') { panel.innerHTML = infoBox('夜晚进行中...'); return; }
      if (this.isWitchActionDone(data)) { panel.innerHTML = infoBox('夜晚进行中...'); return; }
      const wolfTarget = this.getWolfFinalTarget(data);
      const usedCure = !!me.skill?.cureUsed;
      const usedPoison = !!me.skill?.poisonUsed;
      const rule = data.settings?.witchRule || 'noFirstNightSelfSave';
      const firstNight = st.round === 1;
      let selfSaveAllowed = !((rule === 'noFirstNightSelfSave' && firstNight) || (rule === 'onlyFirstNightSelfSave' && !firstNight));
      let knifeHtml = usedCure ? '（解药已用，无法查看刀口）' : ((wolfTarget && wolfTarget !== '0') ? `今晚 ${wolfTarget}号 被刀。` : '今晚无人被刀。');
      panel.innerHTML = `
        <div class="action-prompt">女巫行动</div> <div class="action-target">${knifeHtml}</div>
        <div class="witch-actions-container">
          <button class="control-btn" data-action="witch-cure" ${usedCure || !wolfTarget || wolfTarget==='0' || (!selfSaveAllowed && String(wolfTarget)===String(me.id)) ? 'disabled' : ''}>使用解药</button>
          <button class="action-btn" data-action="witch-poison" ${usedPoison || !sel ? 'disabled' : ''}>毒杀 ${sel||'X'} 号</button>
          <button class="confirm-btn" data-action="witch-done">结束操作</button>
        </div>`;
      return;
    }

    if (st.phase === PHASE.SHERIFF_CAND) {
      const decided = Object.prototype.hasOwnProperty.call(st.sheriff?.candidates || {}, me.id);
      const optedUp = st.sheriff?.candidates?.[me.id] === true;
      panel.innerHTML = decided
        ? `<div class="action-feedback">你的上警意向已提交：${optedUp ? '上警' : '不上警'}。等待其他玩家提交...</div>`
        : `<div class="action-prompt">是否上警？</div>
           <div class="action-buttons">
             <button class="confirm-btn" data-action="sheriff-up">上警</button>
             <button class="control-btn" data-action="sheriff-down">不上警</button>
           </div>`;
      return;
    }
    if (st.phase === PHASE.SHERIFF_SPEECH) {
      const isCandidate = st.sheriff?.candidates?.[me.id] && !st.sheriff?.drops?.[me.id];
      panel.innerHTML = isCandidate ? `<div class="action-buttons"><button class="action-btn" data-action="sheriff-drop">退水</button></div>` : infoBox('警上候选人发言中...');
      return;
    }
    if (st.phase === PHASE.SHERIFF_VOTE) {
      const validCandidates = Object.keys(st.sheriff?.candidates||{}).filter(id => st.sheriff.candidates[id] && !st.sheriff.drops?.[id]);
      panel.innerHTML = `<div class="action-prompt">为警长候选人投票</div><div class="action-target">候选人: ${validCandidates.join('、 ') || '无'}号</div><div class="action-buttons"><button class="control-btn" data-action="sheriff-vote-abstain">弃票</button><button class="confirm-btn" data-action="sheriff-vote" ${!sel || !validCandidates.includes(sel) ? 'disabled' : ''}>投 ${sel||'X'} 号</button></div>`;
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
      panel.innerHTML = st.hunters?.[me.id] ? `<div class="action-prompt">你是猎人，请开枪！</div><div class="action-buttons"><button class="action-btn" data-action="hunter-shoot" ${!sel ? 'disabled' : ''}>带走 ${sel||'X'} 号</button></div>` : infoBox('等待猎人开枪...');
      return;
    }
    if (st.phase === PHASE.BADGE) {
      panel.innerHTML = String(st.postBadge?.dead) === String(me.id) ? `<div class="action-prompt">你倒在了警长的位置上，请移交警徽</div><div class="action-buttons"><button class="action-btn" data-action="badge-destroy">撕毁警徽</button><button class="confirm-btn" data-action="badge-pass" ${!sel ? 'disabled' : ''}>移交给 ${sel||'X'} 号</button></div>` : infoBox('等待警长移交警徽...');
      return;
    }
    if (st.phase === PHASE.GAME_OVER) {
      panel.innerHTML = `<div class="action-feedback" style="font-size: 1.2em; font-weight: bold;">${st.winner || '游戏结束'}</div>`;
    }
  },

  renderHost(data) {
    const host = $('host-controls');
    const isHost = String(data.state?.host || '1') === String(this.me);
    host.classList.toggle('hidden', !isHost);
    if (!isHost) { host.innerHTML = ''; return; }

    const st = data.state;
    let html = `<div class="host-panel">`;
    html += this.renderHostStatusDashboard(data);

    let actionsHtml = `<div class="host-actions-wrapper"><div class="host-status-title">主持控制台</div><div class="host-actions">`;

    switch(st.phase) {
      case PHASE.NIGHT:
      case PHASE.NIGHT_WITCH: {
        const btnText = st.round === 1 ? '强制进入警长竞选' : '强制天亮';
        actionsHtml += `<button class="action-btn" data-action="host-force-dawn">${btnText}</button>`;
        break;
      }
      case PHASE.SHERIFF_CAND:
        actionsHtml += `<button class="btn-primary" data-action="host-speech">进入发言</button>`;
        break;
      case PHASE.SHERIFF_SPEECH:
        actionsHtml += `<button class="btn-primary" data-action="host-sheriff-vote">进入投票</button>`;
        break;
      case PHASE.SHERIFF_VOTE:
        actionsHtml += `<button class="action-btn" data-action="host-force-sheriff-tally">强制计票</button>`;
        break;
      case PHASE.DAY_TALK:
        actionsHtml += `<button class="btn-primary" data-action="host-day-vote">开启放逐投票</button>`;
        actionsHtml += `<button class="control-btn" data-action="host-skip-day">直接入夜</button>`;
        break;
      case PHASE.DAY_VOTE:
        actionsHtml += `<button class="action-btn" data-action="host-force-day-tally">强制计票</button>`;
        break;
      case PHASE.HUNTER:
        actionsHtml += `<button class="action-btn" data-action="host-force-hunter-end">结束猎人阶段</button>`;
        break;
      case PHASE.BADGE:
        actionsHtml += `<button class="action-btn" data-action="host-force-badge-end">结束移交阶段</button>`;
        break;
      case PHASE.GAME_OVER:
        html = `
          <div class="host-panel">
            <div class="host-status-title">游戏已结束</div>
            <div class="host-actions"><button class="btn-primary" data-action="host-restart">重开一局</button></div>
            <div class="host-transfer" style="margin-top: 16px;">
              <span>移交主持给:</span>
              <select id="host-transfer-select">${Object.values(data.players).map(p => `<option value="${p.id}" ${String(p.id) === String(st.host) ? 'selected' : ''}>玩家 ${p.id}</option>`).join('')}</select>
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
    if (!a || a.disabled) return;
    const act = a.dataset.action;
    const sel = this.selection?.pid;

    if (act === 'create-game') return this.createGame();
    if (act === 'open-logs') return this.openLogs();
    if (act === 'close-modal') return this.closeModal(a.dataset.target);
    if (act === 'join-game') {
      const playerNum = $('player-number-input').value;
      if (playerNum) location.href = `${location.pathname}?game=${this.gameId}&player=${playerNum}`;
      else this.toast('请输入你的座位号', 'error');
      return;
    }
    if (act === 'copy-link') {
      try {
        await navigator.clipboard.writeText(a.dataset.link);
        this.toast('链接已复制到剪贴板', 'success');
      } catch (err) { this.toast('复制失败', 'error'); }
      return;
    }

    if (!this.full) return;
    const r = this.full.state.round;
    const meId = this.me;

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
      return db.ref(`games/${this.gameId}/players/${meId}/identities`).set([...mePlayer.identities].reverse());
    }
    if (act === 'ready') return db.ref(`games/${this.gameId}/players/${meId}/isReady`).set(true);

    // Host actions
    if (act === 'host-force-dawn') return this.engine.dawnResolve();
    if (act === 'host-speech') return this.engine.forceSheriffSpeech();
    if (act === 'host-sheriff-vote') return this.engine.to(PHASE.SHERIFF_VOTE);
    if (act === 'host-force-sheriff-tally') return this.engine.tallySheriff();
    if (act === 'host-day-vote') return this.engine.to(PHASE.DAY_VOTE);
    if (act === 'host-force-day-tally') return this.engine.tallyDayVote();
    if (act === 'host-skip-day') return this.engine.startNight(r + 1);
    if (act === 'host-force-hunter-end') {
      const nextPhase = this.full.state.nextPhaseAfterHunter || PHASE.DAY_TALK;
      await this.engine.log('主持人强制结束猎人阶段。', false);
      return this.engine.update({ 'state/hunters': null, 'state/nextPhaseAfterHunter': null, 'state/phase': nextPhase });
    }
    if (act === 'host-force-badge-end') {
      const post = this.full.state.postBadge;
      if (post?.dead) {
        await db.ref(`games/${this.gameId}/players/${post.dead}/badge`).set(0);
      }
      await this.engine.log(`主持人强制结束警徽移交，警徽被撕毁。`, false);
      return this.engine.to(post?.next || PHASE.DAY_TALK, { postBadge: null });
    }
    if (act === 'host-restart') return this.restartGame();

    const actionPath = `games/${this.gameId}/actions/${r}`;

    // 狼人夜投
    if (act === 'wolf-final') {
      const myVote = this.full.actions?.[r]?.NIGHT?.WOLF?.[meId]?.target;
      if (myVote) return db.ref(`${actionPath}/NIGHT/WOLF/final`).set(myVote);
    }
    if (act === 'wolf-empty') return this.handleWolfVote('0');

    // 守卫
    if (act === 'guard-null') {
      await db.ref(`games/${this.gameId}/players/${meId}/skill/lastGuard`).set(null);
      return db.ref(`${actionPath}/NIGHT/GUARD/${meId}`).set({ target: null, ts: now() });
    }
    if (act === 'guard-confirm' && sel) {
      await db.ref(`games/${this.gameId}/players/${meId}/skill/lastGuard`).set(sel);
      return db.ref(`${actionPath}/NIGHT/GUARD/${meId}`).set({ target: sel, ts: now() });
    }

    // 预言家
    if (act === 'seer-confirm' && sel) {
      const result = this.computeSeerResult(this.full, sel);
      return db.ref(`${actionPath}/NIGHT/SEER/${meId}`).set({ target: sel, result, ts: now() });
    }

    // 女巫
    if (act === 'witch-cure') {
      const wolfTarget = this.getWolfFinalTarget(this.full);
      await db.ref(`${actionPath}/NIGHT_WITCH/cure`).set(wolfTarget);
      return db.ref(`games/${this.gameId}/players/${meId}/skill/cureUsed`).set(true);
    }
    if (act === 'witch-poison' && sel) {
      await db.ref(`${actionPath}/NIGHT_WITCH/poison`).set(sel);
      return db.ref(`games/${this.gameId}/players/${meId}/skill/poisonUsed`).set(true);
    }
    if (act === 'witch-done') return db.ref(`${actionPath}/NIGHT_WITCH/done`).set(true);

    // 警长
    if (act === 'sheriff-up') return db.ref(`games/${this.gameId}/state/sheriff/candidates/${meId}`).set(true);
    if (act === 'sheriff-down') return db.ref(`games/${this.gameId}/state/sheriff/candidates/${meId}`).set(false);
    if (act === 'sheriff-drop') return db.ref(`games/${this.gameId}/state/sheriff/drops/${meId}`).set(true);
    if (act === 'sheriff-vote' && sel) return db.ref(`games/${this.gameId}/state/sheriff/votes/${meId}`).set(sel);
    if (act === 'sheriff-vote-abstain') return db.ref(`games/${this.gameId}/state/sheriff/votes/${meId}`).set('0');

    // 骑士（动作入库，由主持端消费）
    if (act === 'knight-duel' && sel) {
      return db.ref(`${actionPath}/DAY/KNIGHT/${meId}`).set({ target: sel, ts: now(), processed: false });
    }

    // 白天放逐
    if (act === 'day-vote' && sel) return db.ref(`${actionPath}/DAY_VOTE/${meId}`).set({ target: sel, ts: now() });
    if (act === 'day-vote-abstain') return db.ref(`${actionPath}/DAY_VOTE/${meId}`).set({ target: '0', ts: now() });

    // 猎人（动作入库，由主持端消费）
    if (act === 'hunter-shoot' && sel) {
      return db.ref(`${actionPath}/HUNTER/${meId}`).set({ target: sel, ts: now(), processed: false });
    }

    // 警徽
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

  handleWolfVote(targetId) {
    const r = this.full.state.round;
    const meId = this.me;
    return db.ref(`games/${this.gameId}/actions/${r}/NIGHT/WOLF/${meId}`).set({ target: String(targetId), ts: now() });
  },

  getActiveRole(player, players, state, settings) {
    if (!player.isAlive) return null;
    const idx = Math.min(player.deaths || 0, 1);
    return player.identities[idx].role;
  },
  isHiddenWolfActivated(players, state, settings) {
    return !Object.values(players).some(p => p.isAlive && this.getActiveRole(p, players, state, settings) === '狼人');
  },
  isPlayerActingWolf(player, data) {
    if (!player.isAlive) return false;
    const ar = this.getActiveRole(player, data.players, data.state, data.settings);
    return ar === '狼人' || (ar === '隐狼' && this.isHiddenWolfActivated(data.players, data.state, data.settings));
  },
  shouldShowWolfTag(targetPlayer, data, ctx) {
    if (!ctx.meCanSeeWolves) return false;
    const targetHasWolfCard = targetPlayer.identities.some(i => i.role === '狼人' || i.role === '隐狼');
    if (ctx.wolfVisRule === 'allWolves') {
      return targetHasWolfCard;
    } else {
      return this.isPlayerActingWolf(targetPlayer, data);
    }
  },
  getWolfFinalTarget(data) { return data.actions?.[data.state.round]?.NIGHT?.WOLF?.final; },
  isWitchActionDone(data) { return data.actions?.[data.state.round]?.NIGHT_WITCH?.done === true; },
  getAlphaWolfId(data) {
    const actingWolves = Object.values(data.players).filter(p => this.isPlayerActingWolf(p, data));
    return actingWolves.length > 0 ? Math.min(...actingWolves.map(p => p.id)) : null;
  },
  computeSeerResult(data, targetPid) {
    const target = data.players?.[targetPid];
    if (!target) return '无效目标';
    const mode = data.settings?.seerMode || 'faction';
    if (mode === 'identity') {
      const role = this.getActiveRole(target, data.players, data.state, data.settings);
      if (role === '隐狼' && !this.isHiddenWolfActivated(data.players, data.state, data.settings)) {
        return target.identities.find(id => id.role !== '隐狼')?.role || '好人';
      }
      return role;
    } else {
      const isWolfFaction = target.identities.some(i => i.role === '狼人' || (i.role === '隐狼' && this.isHiddenWolfActivated(data.players, data.state, data.settings)));
      return isWolfFaction ? '狼人阵营' : '好人阵营';
    }
  },
  getSeerResultsForMe(data) {
    const results = [];
    if (!data.actions) return results;
    for (const round in data.actions) {
      const seerAction = data.actions[round]?.NIGHT?.SEER?.[this.me];
      if (seerAction) results.push({ round, ...seerAction });
    }
    return results;
  },

  openLogs() {
    if (!this.full) return;
    const logs = Object.values(this.full.logs || {}).sort((a, b) => a.ts - b.ts);
    const box = $('game-log-content');
    // 秘密日志不对任何人展示
    box.innerHTML = logs
      .filter(l => !l.secret)
      .map(l => `<div class="log-item"><span class="log-round">第${l.round || 0}轮</span> ${escapeHtml(l.msg)}</div>`)
      .join('') || '<div class="log-item">暂无日志</div>';
    $('logs-modal').classList.add('open');
  },
  closeModal(id) {
    const m = id ? document.getElementById(id) : document.querySelector('.modal.open');
    if (m) m.classList.remove('open');
  },
  toast(txt, type = 'info') {
    const n = el(`<div class="notification ${type}">${escapeHtml(txt)}</div>`);
    $('notification-container').appendChild(n);
    setTimeout(() => n.remove(), 3000);
  },
  renderHostStatusDashboard(data) {
    const st = data.state;
    let statusText = '';
    switch (st.phase) {
      case PHASE.NIGHT:
      case PHASE.NIGHT_WITCH:
        statusText = '夜晚进行中';
        break;
      case PHASE.SHERIFF_CAND: {
        const players = Object.values(data.players || {});
        const alivePlayers = players.filter(p => p.isAlive);
        const submitted = Object.keys(st.sheriff?.candidates || {}).length;
        statusText = `上警意向提交：${submitted} / ${alivePlayers.length}`;
        break;
      }
      case PHASE.SHERIFF_VOTE:
      case PHASE.DAY_VOTE: {
        const players = Object.values(data.players || {});
        const alivePlayers = players.filter(p => p.isAlive);
        const voters = alivePlayers.filter(p => !p.isExposedIdiot);
        const votes = (st.phase === PHASE.SHERIFF_VOTE) ? (st.sheriff?.votes || {}) : (data.actions?.[st.round]?.DAY_VOTE || {});
        statusText = `投票进度: ${Object.keys(votes).length} / ${voters.length}`;
        break;
      }
      default: return '';
    }
    return `<div class="host-status-dashboard">${statusText}</div>`;
  },

  destroy() {
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
    this.listener = { ref: null, cb: null, onlineRef: null };
  }
};

/* ==================================================================
 *  5. 启动应用
 * ================================================================== */
window.addEventListener('beforeunload', () => App.destroy());
document.addEventListener('DOMContentLoaded', () => App.init());
