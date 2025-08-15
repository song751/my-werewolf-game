/**********************************************************************
 * 双身份狼人杀 - 电子法官 (稳定修复 + 多神职支持 + 首夜上警先于结算 + 交互优化)
 * 修复要点：
 * - 守护+解药同时作用 → 仍判定死亡
 * - 隐狼激活 noWolfCardAlive 仅检查“狼人”牌（不含“隐狼”）
 * - 点击确认后锁定UI（本轮面板禁用），大厅交换差分渲染避免频繁闪烁
 *********************************************************************/

/* ==================================================================
 *  0. 常量与配置
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

// 仅隐狼与盗贼唯一
const UNIQUE_ROLES = new Set(['隐狼', '盗贼']);

// 禁配：允许 狼人+狼人；禁止 狼人+盗贼、狼人+隐狼、预言家+狼人、预言家+隐狼、盗贼+隐狼
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
const shuffle = a => { let i = a.length; while (i) { const r = Math.random() * i-- | 0; [a[i], a[r]] = [a[r], a[i]] } return a; };
const now = () => Date.now();
const getHighPrecisionTimestamp = () => Date.now() + Math.random();

/* ==================================================================
 *  2. Firebase
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
 *  3. 规则引擎（稳定实现 + 多神职 + 流程修复）
 * ================================================================== */

class Engine {
  constructor(gameId) { 
    this.id = gameId; 
    this.state = null; 
    this.players = null; 
    this.actions = null; 
    this.settings = null;
    this.isProcessing = false;
  }
  
  ref(p) { return db.ref(`games/${this.id}/${p}`); }
  async read(p) { try { return (await this.ref(p).once('value')).val(); } catch (e) { console.error('read fail:', p, e); return null; } }
  write(p, v) { return this.ref(p).set(v); }
  update(obj) { return db.ref(`games/${this.id}`).update(obj); }
  push(p, v) { return this.ref(p).push(v); }

  async refresh() {
    const [state, players, actions, settings] = await Promise.all([
      this.read('state'), this.read('players'), this.read('actions'), this.read('settings')
    ]);
    this.state = state || {};
    this.players = players || {};
    this.actions = actions || {};
    this.settings = settings || {};
  }

  async to(phase, extra = {}) {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      const updates = { 'state/phase': phase };
      Object.entries(extra || {}).forEach(([k, v]) => updates[`state/${k}`] = v);
      await this.update(updates);
    } finally {
      this.isProcessing = false;
    }
  }

  async tick() {
    if (this.isProcessing) return;
    const state = await this.read('state') || {};
    this.state = state;

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

  activeIdx(p) { return Math.min(p.deaths || 0, 1); }
  activeRole(p) { return p.isAlive ? p.identities[this.activeIdx(p)].role : null; }

  computeHiddenActive(players = this.players, settings = this.settings) {
    const mode = settings?.hiddenActivation || 'noActiveWolf';
    if (mode === 'noWolfCardAlive') {
      // 修正：只检查“狼人”牌是否仍存活；隐狼不计入
      const anyPureWolfCardAlive = Object.values(players).some(p => 
        p.isAlive && p.identities.some(id => id.role === '狼人')
      );
      return !anyPureWolfCardAlive;
    } else {
      // 无活跃狼人（活跃身份为“狼人”的存活玩家不存在）
      return !Object.values(players).some(p => 
        p.isAlive && this.activeRole(p) === '狼人'
      );
    }
  }
  isHiddenWolfActivated(players = this.players) { return this.computeHiddenActive(players, this.settings); }

  getAliveActingWolves(players = this.players) {
    const activated = this.isHiddenWolfActivated(players);
    return Object.values(players).filter(p => {
      if (!p.isAlive) return false;
      const ar = this.activeRole(p);
      return ar === '狼人' || (ar === '隐狼' && activated);
    });
  }

  getLivingWitches(players = this.players) {
    return Object.values(players).filter(p => p.isAlive && this.activeRole(p) === '女巫');
  }
  getLivingGuards(players = this.players) {
    return Object.values(players).filter(p => p.isAlive && this.activeRole(p) === '守卫');
  }

  async getGuardTargetByGuardId(round, guardId) {
    try {
      const guardSnapshot = await this.read(`players/${guardId}/skill`);
      const actionSnapshot = await this.read(`actions/${round}/NIGHT/GUARD/${guardId}`);
      return { target: actionSnapshot?.target, lastGuard: guardSnapshot?.lastGuard };
    } catch (e) {
      console.error('getGuardTargetByGuardId fail:', e);
      return { target: null, lastGuard: null };
    }
  }

  getWolfFinalTarget() { return this.actions?.[this.state.round]?.NIGHT?.WOLF?.final; }

  // 女巫（多实例）读取
  getWitchBuckets(round = this.state.round) {
    const path = this.actions?.[round]?.NIGHT_WITCH || {};
    const cures = path.cures || {};    // { witchId: { target, ts } }
    const poisons = path.poisons || {}; // { witchId: { target, ts } }
    const done = path.done || {};      // { witchId: true }
    return { cures, poisons, done };
  }

  isAllWitchesDone() {
    const witches = this.getLivingWitches();
    const { cures, poisons, done } = this.getWitchBuckets();
    if (witches.length === 0) return true;
    return witches.every(w => !!cures[w.id] || !!poisons[w.id] || done[w.id] === true);
  }

  /* ============================
   *  夜晚与女巫阶段（首夜上警：女巫后直接上警，未天亮）
   * ============================ */
  async checkNightEnd() {
    const actingWolves = this.getAliveActingWolves(this.players);
    const finalTarget = this.getWolfFinalTarget();
    if (actingWolves.length > 0 && finalTarget === undefined) return;
    
    const witchAlive = this.getLivingWitches().length > 0;
    if (witchAlive) {
      await this.to(PHASE.NIGHT_WITCH);
    } else {
      // 若首夜且无女巫，直接进入上警（未天亮）
      if ((this.state.round || 1) === 1) {
        await this.to(PHASE.SHERIFF_CAND, { sheriff: { candidates: {}, votes: {}, drops: {}, isPK: false } });
      } else {
        await this.dawnResolve();
      }
    }
  }

  async checkWitchEnd() {
    const witchAlive = this.getLivingWitches().length > 0;
    if (!witchAlive || this.isAllWitchesDone()) {
      // 首夜：上警（未天亮）；其它夜晚：直接黎明结算
      if ((this.state.round || 1) === 1) {
        await this.to(PHASE.SHERIFF_CAND, { sheriff: { candidates: {}, votes: {}, drops: {}, isPK: false } });
      } else {
        await this.dawnResolve();
      }
    }
  }

  /* ============================
   *  黎明结算（统一结算夜间行为）
   * ============================ */
  async dawnResolve() {
    await this.refresh();
    if (this.state.resolving) return;
    
    this.isProcessing = true;
    await this.write('state/resolving', true);
    await this.log('黎明到来，开始结算夜晚事件...', true);

    try {
      const r = this.state.round;
      const deaths = [];
      const wolfTarget = this.getWolfFinalTarget();

      // 读取多守卫、多女巫行动
      const guards = this.getLivingGuards();
      const witches = this.getLivingWitches();
      const { cures, poisons } = this.getWitchBuckets(r);

      // 校验并生效守卫
      const guardValidMap = {};
      for (const g of guards) {
        const { target, lastGuard } = await this.getGuardTargetByGuardId(r, g.id);
        if (target === undefined) {
          guardValidMap[g.id] = { valid: false, target: null };
        } else if (target === null) {
          guardValidMap[g.id] = { valid: true, target: null }; // 空守有效
        } else if (String(target) === String(lastGuard)) {
          guardValidMap[g.id] = { valid: false, target: null };
          await this.log(`🛡️ 守卫${g.id}尝试连守同一目标，守护无效（视为未守护）。`, true);
        } else {
          guardValidMap[g.id] = { valid: true, target };
        }
      }

      // 女巫：每位独立，择一生效
      const allowedCures = new Set();
      const poisonTargets = [];
      const witchRule = this.settings?.witchRule || 'noFirstNightSelfSave';
      const firstNight = r === 1;

      for (const w of witches) {
        const c = cures[w.id];
        const p = poisons[w.id];
        let picked = null;

        if (c && p) {
          const cts = typeof c.ts === 'number' ? c.ts : 0;
          const pts = typeof p.ts === 'number' ? p.ts : 0;
          if (cts === pts) picked = Math.random() > 0.5 ? { type: 'cure', target: c.target, ts: cts } : { type: 'poison', target: p.target, ts: pts };
          else picked = (cts > pts) ? { type: 'cure', target: c.target, ts: cts } : { type: 'poison', target: p.target, ts: pts };
          await this.log(`🧪 女巫${w.id}本夜提交两瓶，采用较晚一项：${picked.type==='cure'?'解药':'毒药'}`, true);
        } else if (c) {
          picked = { type: 'cure', target: c.target, ts: c.ts || 0 };
        } else if (p) {
          picked = { type: 'poison', target: p.target, ts: p.ts || 0 };
        }

        if (!picked) continue;

        const skill = (await this.read(`players/${w.id}/skill`)) || {};
        if (picked.type === 'cure') {
          if (skill.cureUsed) { await this.log(`🧪 女巫${w.id}重复使用解药，忽略。`, true); continue; }
          if (wolfTarget && String(wolfTarget) === String(w.id)) {
            let allowed = true;
            if (witchRule === 'noFirstNightSelfSave' && firstNight) allowed = false;
            if (witchRule === 'onlyFirstNightSelfSave' && !firstNight) allowed = false;
            if (!allowed) { await this.log(`🧪 女巫${w.id}自救不符合规则，解药无效。`, true); continue; }
          }
          if (wolfTarget && wolfTarget !== '0' && String(picked.target) === String(wolfTarget)) {
            allowedCures.add(String(wolfTarget));
            await this.update({ [`players/${w.id}/skill/cureUsed`]: true });
          } else {
            await this.log(`🧪 女巫${w.id}解药不是刀口，忽略。`, true);
          }
        } else {
          if (skill.poisonUsed) { await this.log(`🧪 女巫${w.id}重复使用毒药，忽略。`, true); continue; }
          if (!picked.target || picked.target === '0') { await this.log(`🧪 女巫${w.id}未选择有效毒杀目标。`, true); continue; }
          poisonTargets.push(String(picked.target));
          await this.update({ [`players/${w.id}/skill/poisonUsed`]: true });
        }
      }

      // 是否守住刀口
      const guarded = wolfTarget && wolfTarget !== '0'
        ? Object.values(guardValidMap).some(g => g.valid && g.target !== null && String(g.target) === String(wolfTarget))
        : false;

      // 更新 lastGuard
      for (const g of guards) {
        const gv = guardValidMap[g.id];
        if (!gv) continue;
        if (gv.valid) {
          await this.update({ [`players/${g.id}/skill/lastGuard`]: gv.target === undefined ? null : gv.target });
        }
      }

      // 狼刀结算
      if (wolfTarget && wolfTarget !== '0') {
        const cured = allowedCures.has(String(wolfTarget));
        if (guarded) await this.log(`🛡️ ${wolfTarget}号被守住。`, true);
        if (cured) await this.log(`🧪 解药作用于 ${wolfTarget}号。`, true);

        // 修复：守+救同时发生 → 仍然死亡
        if (guarded && cured) {
          await this.log(`⚠️ ${wolfTarget}号同时被守与被解，按规则仍然死亡。`, true);
          deaths.push({ pid: String(wolfTarget), cause: 'WOLF' });
          await this.log(`🔪 ${wolfTarget}号玩家被狼人杀害。`, true);
        } else if (!guarded && !cured) {
          deaths.push({ pid: String(wolfTarget), cause: 'WOLF' });
          await this.log(`🔪 ${wolfTarget}号玩家被狼人杀害。`, true);
        }
      }

      // 毒药结算
      const uniquePoisons = [...new Set(poisonTargets)];
      for (const t of uniquePoisons) {
        if (!deaths.some(d => String(d.pid) === String(t))) {
          deaths.push({ pid: String(t), cause: 'POISON' });
          await this.log(`☠️ ${t}号被女巫毒杀。`, true);
        }
      }

      // 死亡执行
      let anyHunterTriggered = false, sheriffDiedPid = null;
      if (deaths.length > 0) {
        const deadIds = [...new Set(deaths.map(d => d.pid))].sort((a, b) => a - b).join('号、');
        await this.log(`昨夜死亡：${deadIds}号。`, false);
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

      if (await this.checkWin()) return;

      // 下个阶段计算
      let nextPhase;
      if (r === 1 && (this.state.phase === PHASE.NIGHT || this.state.phase === PHASE.NIGHT_WITCH)) {
        nextPhase = PHASE.SHERIFF_CAND;
        await this.update({ 'state/sheriff': { candidates: {}, votes: {}, drops: {}, isPK: false } });
      } else {
        nextPhase = PHASE.DAY_TALK;
      }

      // 顺序：BADGE -> HUNTER -> nextPhase
      if (sheriffDiedPid && anyHunterTriggered) {
        await this.to(PHASE.BADGE, { postBadge: { dead: sheriffDiedPid, next: PHASE.HUNTER }, nextPhaseAfterHunter: nextPhase });
      } else if (sheriffDiedPid) {
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

  // 返回死亡时的信息，用于猎人触发与警徽判断
  async kill(pid, cause) {
    const freshPlayers = (await this.read('players')) || this.players;
    this.players = freshPlayers;

    const p = this.players[pid];
    if (!p || !p.isAlive) return {};

    const dyingIdx = this.activeIdx(p);
    const dyingRole = p.identities?.[dyingIdx]?.role;
    const newDeaths = (p.deaths || 0) + 1;
    const isOut = newDeaths >= 2;
    const updates = { [`players/${pid}/deaths`]: newDeaths, [`players/${pid}/isAlive`]: !isOut };
    let hunterTriggered = false;
    let sheriffDiedPid = (p.badge && isOut) ? pid : null;

    // 白痴：仅“投票”时翻牌免死一次（第一条命时）
    const hasIdiotCard = p.identities.some(id => id.role === '白痴');
    if (hasIdiotCard && dyingRole === '白痴' && cause === 'VOTE' && !p.isExposedIdiot) {
      if (newDeaths <= 1) {
        updates[`players/${pid}/isExposedIdiot`] = true;
        updates[`players/${pid}/isAlive`] = true;
        updates[`players/${pid}/deaths`] = 1;
        sheriffDiedPid = null;
        await this.log(`🤪 ${pid}号白痴被票出，翻牌免死，但失去投票权。`, false);
        await this.update(updates);
        this.players[pid] = { ...p, deaths: 1, isAlive: true, isExposedIdiot: true };
        return { hunterTriggered: false, sheriffDied: null };
      }
    }

    // 猎人：当猎人身份死亡且死因为狼刀/被票时触发（第一条命也可）
    const hasHunterCard = p.identities.some(id => id.role === '猎人');
    if (hasHunterCard && dyingRole === '猎人' && ['WOLF', 'VOTE'].includes(cause)) {
      const q = (await this.read('state/hunters')) || {};
      q[pid] = true;
      updates['state/hunters'] = q;
      hunterTriggered = true;
      await this.log(`🔫 ${pid}号猎人身份倒下，可以开枪。`, false);
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

  async checkDayVote() {
    await this.refresh();
    const r = this.state.round;
    const voters = Object.values(this.players).filter(p => p.isAlive && !p.isExposedIdiot);
    const rec = this.actions?.[r]?.DAY_VOTE || {};
    if (voters.length === 0 || voters.every(v => rec[v.id] !== undefined)) {
      await this.tallyDayVote();
    }
  }

  async tallyDayVote() {
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
      if (target === '0') { abstainers.push(voterPid); return; }
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
      if (deathResult.sheriffDied && deathResult.hunterTriggered) {
        await this.to(PHASE.BADGE, { postBadge: { dead: deathResult.sheriffDied, next: PHASE.HUNTER }, nextPhaseAfterHunter: PHASE.NIGHT });
      } else if (deathResult.sheriffDied) {
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
    await this.refresh();
    const voters = Object.values(this.players).filter(p => p.isAlive && !p.isExposedIdiot);
    const sheriff = this.state.sheriff || { candidates: {}, votes: {}, drops: {}, isPK: false };
    const candidates = sheriff.candidates || {};
    const drops = sheriff.drops || {};

    const validCandidates = Object.keys(candidates).filter(id => candidates[id] && !drops[id] && this.players?.[id]?.isAlive);
    if (validCandidates.length === 0) {
      await this.log('本局无警长（无人上警或全部退水）。', false);
      await this.update({ 'state/sheriff': null });
      if ((this.state.round || 1) === 1) return this.dawnResolve();
      return this.to(PHASE.DAY_TALK);
    }

    const votes = sheriff.votes || {};
    if (voters.every(pl => votes[pl.id] !== undefined)) {
      await this.tallySheriff();
    }
  }

  async tallySheriff() {
    await this.refresh();
    const { candidates, votes, isPK, drops } = this.state.sheriff || {};
    const validCandidates = Object.keys(candidates || {}).filter(id => {
      const alive = this.players?.[id]?.isAlive;
      return candidates[id] && !(drops || {})[id] && alive;
    });

    const afterSheriffGoNext = async () => {
      if ((this.state.round || 1) === 1) {
        await this.dawnResolve();
      } else {
        await this.to(PHASE.DAY_TALK);
      }
    };

    if (!validCandidates.length) {
      await this.log('本局无警长（无人上警或全部退水）。', false);
      await this.update({ 'state/sheriff': null });
      return afterSheriffGoNext();
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
      return afterSheriffGoNext();
    } else if (isPK) {
      await this.log('PK后再次平票，本局无警长。', false);
      await this.update({ 'state/sheriff': null });
      return afterSheriffGoNext();
    } else {
      const pkCandidates = {};
      winners.forEach(id => pkCandidates[id] = true);
      await this.log(winners.length > 1 ? `⚖️ 平票：${winners.join('、')}号进入PK。` : '无人当选，流警。', false);
      if (winners.length > 1) {
        await this.update({ 'state/sheriff': { candidates: pkCandidates, votes: {}, drops: {}, isPK: true } });
        await this.to(PHASE.SHERIFF_SPEECH);
      } else {
        await this.update({ 'state/sheriff': null });
        return afterSheriffGoNext();
      }
    }
  }

  async checkSheriffCandComplete() {
    await this.refresh();
    const players = await this.read('players') || {};
    const alive = Object.values(players).filter(p => p.isAlive);
    const sheriff = (await this.read('state/sheriff')) || { candidates: {}, votes: {}, drops: {}, isPK: false };
    const cand = sheriff.candidates || {};
    const submitted = alive.filter(p => Object.prototype.hasOwnProperty.call(cand, p.id)).length;
    if (submitted === alive.length) {
      await this.log('上警意向已提交，进入发言阶段。', false);
      await this.to(PHASE.SHERIFF_SPEECH);
    }
  }

  async forceSheriffSpeech() {
    await this.refresh();
    const players = await this.read('players') || {};
    const alive = Object.values(players).filter(p => p.isAlive);
    const sheriff = (await this.read('state/sheriff')) || { candidates: {}, votes: {}, drops: {}, isPK: false };
    const cand = sheriff.candidates || {};
    for (const p of alive) if (!Object.prototype.hasOwnProperty.call(cand, p.id)) cand[p.id] = false;
    await this.update({ 'state/sheriff': { ...sheriff, candidates: cand } });
    await this.log('主持人进入发言阶段：未提交者视为不上警。', false);
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
    await this.refresh();
    const r = this.state.round;
    const rec = this.actions?.[r]?.DAY?.KNIGHT || {};
    for (const [fromPid, action] of Object.entries(rec)) {
      if (!action || action.processed || !action.target) continue;
      const from = this.players[fromPid];
      if (!from?.isAlive) { await this.update({ [`actions/${r}/DAY/KNIGHT/${fromPid}/processed`]: true }); continue; }
      const ar = this.activeRole(from);
      const used = !!from.skill?.knightUsed;
      if (ar !== '骑士' || used) { await this.update({ [`actions/${r}/DAY/KNIGHT/${fromPid}/processed`]: true }); continue; }
      await this.update({ [`players/${fromPid}/skill/knightUsed`]: true });
      await this.duel(fromPid, action.target);
      await this.update({ [`actions/${r}/DAY/KNIGHT/${fromPid}/processed`]: true });
      break;
    }
  }

  async checkHunterQueue() {
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
        await this.update({ [`actions/${r}/HUNTER/${pid}/processed`]: true, [`state/hunters/${pid}`]: null });
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
    await this.refresh();
    const from = this.players[fromPid], target = this.players[targetPid];
    if (!from?.isAlive || !target?.isAlive) return;

    // 决斗：隐狼无论是否激活均视为狼人阵营
    const isWolfFaction = target.identities?.some(i => i.role === '狼人' || i.role === '隐狼');

    if (isWolfFaction) {
      await this.log(`⚔️ ${fromPid}号骑士决斗成功，目标 ${targetPid} 属于狼人阵营！`, false);
      const deathResult = await this.kill(targetPid, 'DUEL');
      if (await this.checkWin()) return;
      if (deathResult.sheriffDied && deathResult.hunterTriggered) {
        await this.to(PHASE.BADGE, { postBadge: { dead: deathResult.sheriffDied, next: PHASE.HUNTER }, nextPhaseAfterHunter: PHASE.NIGHT });
      } else if (deathResult.sheriffDied) {
        await this.to(PHASE.BADGE, { postBadge: { dead: deathResult.sheriffDied, next: PHASE.NIGHT } });
      } else if (deathResult.hunterTriggered) {
        await this.to(PHASE.HUNTER, { nextPhaseAfterHunter: PHASE.NIGHT });
      } else {
        await this.startNight(this.state.round + 1);
      }
    } else {
      await this.log(`⚔️ ${fromPid}号骑士决斗失败，目标 ${targetPid} 非狼人阵营。`, false);
      const deathResult = await this.kill(fromPid, 'DUEL');
      if (await this.checkWin()) return;
      if (deathResult.sheriffDied && deathResult.hunterTriggered) {
        await this.to(PHASE.BADGE, { postBadge: { dead: deathResult.sheriffDied, next: PHASE.HUNTER }, nextPhaseAfterHunter: this.state.phase });
      } else if (deathResult.sheriffDied) {
        await this.to(PHASE.BADGE, { postBadge: { dead: deathResult.sheriffDied, next: this.state.phase } });
      } else if (deathResult.hunterTriggered) {
        await this.to(PHASE.HUNTER, { nextPhaseAfterHunter: this.state.phase });
      }
    }
  }

  async checkWin() {
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
      const godAlive = alivePlayers.some(p => p.identities?.some(i => ROLES[i.role]?.isGod));
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

  computeSeerResultServer(targetPid) {
    const dataPlayers = this.players;
    const settings = this.settings || {};
    const target = dataPlayers?.[targetPid];
    if (!target) return '无效目标';
    const mode = settings?.seerMode || 'faction';
    const hiddenActive = this.computeHiddenActive(this.players, this.settings);
    if (mode === 'identity') {
      const idx = Math.min(target.deaths || 0, 1);
      let role = target.identities?.[idx]?.role || '未知身份';
      if (role === '隐狼') {
        if (hiddenActive) role = '狼人';
        else {
          const otherRole = (target.identities || []).find(id => id.role !== '隐狼')?.role;
          role = otherRole || '平民';
        }
      }
      return role;
    } else {
      const isWolfFaction = (target.identities || []).some(i => i.role === '狼人' || (i.role === '隐狼' && hiddenActive));
      return isWolfFaction ? '狼人阵营' : '好人阵营';
    }
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
 *  4. 前端应用（交互优化 + 差分渲染 + 面板锁定）
 * ================================================================== */

const App = {
  me: null, 
  gameId: null, 
  engine: null,
  listener: { ref: null, onlineRef: null },
  full: null, 
  selection: null, 
  autorun: null,

  // 本地 UI 锁：在当前 (round, phase) 锁定操作面板
  lockedAction: null,
  _lobbyStructSig: null,
  _myIdentitySig: null,

  init() {
    this.applyAppleTheme();
    this.initButtonEffects();

    const p = new URLSearchParams(location.search);
    this.gameId = p.get('game') || '';
    this.me = p.get('player') || '';

    this.initEventListeners();
    this.initKeyboardShortcuts();

    if (this.gameId) {
      $('setup-view').classList.add('hidden');
      $('game-view').classList.remove('hidden');
      if (this.me) this.enterGame();
      else this.renderJoinPrompt();
    } else {
      this.renderSetup();
    }
  },

  applyAppleTheme() {
    const root = document.documentElement;
    const vars = {
      '--bg-primary': '#0b1020',
      '--bg-secondary': '#0f1529',
      '--bg-tertiary': '#141b33',
      '--bg-card': '#18213c',
      '--text-primary': '#f2f3f7',
      '--text-secondary': '#b3bdd9',
      '--text-tertiary': '#93a0c2',
      '--accent-primary': '#6c7ff7',
      '--accent-secondary': '#8a9bff',
      '--color-info': '#4e7df6',
      '--color-success': '#22c38e',
      '--color-danger': '#f05252',
      '--color-warning': '#f4a11e',
    };
    Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
  },

  initButtonEffects() {
    const onDown = e => {
      const btn = e.target.closest('button');
      if (btn && !btn.disabled) btn.classList.add('is-pressed');
    };
    const onUp = () => {
      document.querySelectorAll('button.is-pressed').forEach(b => b.classList.remove('is-pressed'));
    };
    document.addEventListener('mouseover', e => {
      const btn = e.target.closest('button.confirm-btn');
      if (btn && !btn.disabled) {
        btn.style.filter = 'brightness(1.1) drop-shadow(0 0 20px rgba(99, 102, 241, 0.4))';
      }
    });
    document.addEventListener('mouseout', e => {
      const btn = e.target.closest('button.confirm-btn');
      if (btn) btn.style.filter = '';
    });
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointerleave', onUp);
  },

  toast(txt, type = 'info', duration = 3000) {
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️', magic: '✨' };
    const colors = {
      success: 'rgba(16, 185, 129, 0.3)',
      error: 'rgba(239, 68, 68, 0.3)',
      warning: 'rgba(245, 158, 11, 0.3)',
      info: 'rgba(59, 130, 246, 0.3)',
      magic: 'rgba(139, 92, 246, 0.3)'
    };
    const icon = icons[type] || icons.info;
    const container = $('notification-container');
    if (!container) return;
    const n = el(`<div class="notification ${type}" style="border-left-color: ${colors[type]}">${icon} ${escapeHtml(txt)}</div>`);
    container.appendChild(n);
    setTimeout(() => {
      if (n.parentNode) {
        n.style.animation = 'slideOutRight 0.3s ease-in-out';
        setTimeout(() => n.remove(), 300);
      }
    }, duration);
  },

  infoBox(text) {
    return `<div class="action-feedback">${escapeHtml(text)}</div>`;
  },

  // 面板锁定
  lockActionPanel() {
    const st = this.full?.state;
    if (!st) return;
    this.lockedAction = { phase: st.phase, round: st.round };
    const panel = $('action-panel');
    if (panel) {
      panel.setAttribute('aria-busy', 'true');
      panel.dataset.locked = '1';
      panel.querySelectorAll('button').forEach(b => { b.disabled = true; });
    }
  },
  unlockActionPanel() {
    const panel = $('action-panel');
    if (panel) {
      panel.removeAttribute('aria-busy');
      delete panel.dataset.locked;
      panel.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
    this.lockedAction = null;
  },
  isActionLockedForState(st) {
    return !!(this.lockedAction && this.lockedAction.phase === st.phase && this.lockedAction.round === st.round);
  },
  applyActionPanelLock(panel, st) {
    if (this.isActionLockedForState(st)) {
      panel.setAttribute('aria-busy', 'true');
      panel.dataset.locked = '1';
      panel.querySelectorAll('button').forEach(b => { b.disabled = true; });
    }
  },
  lockLobbyIdentity() {
    const box = $('lobby-identity-section');
    if (!box) return;
    box.querySelectorAll('button').forEach(b => b.disabled = true);
    box.setAttribute('aria-busy', 'true');
  },

  initEventListeners() {
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-action]');
      if (!a || a.disabled) return;
      this.onClick(e).catch(err => {
        console.error('onClick error:', err);
        this.toast(`操作失败：${err?.message || '未知错误'}`, 'error');
      });
    });

    // 点击空白区清空选中
    document.body.addEventListener('click', (e) => {
      if (e.target.closest('#game-layout') && 
          !e.target.closest('.player-card, .action-panel, .host-controls, .identity-card')) {
        this.clearSelection();
      }
    }, true);
  },

  initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        this.clearSelection();
        this.closeAnyModal();
        return;
      }
      if ((e.key === 'l' || e.key === 'L') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.openLogs();
        return;
      }
      if (/^[1-9]$/.test(e.key) && this.full) {
        const pid = parseInt(e.key, 10);
        const p = this.full.players?.[pid];
        if (p && p.isAlive) this.selectPlayer(pid);
      }
    });
  },

  closeAnyModal() {
    const m = document.querySelector('.modal.open');
    if (m) m.classList.remove('open');
  },

  /* ============================
   *  视图渲染
   * ============================ */

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
            <button class="num-btn" data-role="${role}" data-op="-" type="button" aria-label="减少${role}数量">-</button>
            <input id="role-${role}" type="number" value="${def}" readonly aria-label="${role}数量" />
            <button class="num-btn" data-role="${role}" data-op="+" type="button" aria-label="增加${role}数量">+</button>
          </div>
        </div>
      `);
      item.querySelectorAll('.num-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const input = $(`role-${btn.dataset.role}`);
          let val = parseInt(input.value, 10);
          val += (btn.dataset.op === '+') ? 1 : -1;
          val = Math.max(0, val);
          if (UNIQUE_ROLES.has(btn.dataset.role) && val > 1) {
            val = 1;
            this.toast(`${btn.dataset.role}是唯一角色，最多只能有1个`, 'warning');
          }
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
    $('opt-hidden-activation').value = 'noActiveWolf';

    const createBtn = $('btn-create');
    if (createBtn) {
      createBtn.classList.add('confirm-btn');
    }
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
        <button class="confirm-btn" data-action="join-game" type="button">确认进入</button>
      </div>
    `;
    setTimeout(() => { $('player-number-input')?.focus(); }, 100);
  },

  // 大厅差分渲染
  buildLobbyStructSig(data) {
    const host = data.state?.host;
    const arr = Object.values(data.players || {}).map(p => [p.id, !!p.isReady]);
    arr.sort((a,b)=>a[0]-b[0]);
    return JSON.stringify({ host, arr });
  },
  buildMyIdentitySig(me) {
    if (!me) return 'null';
    const ids = (me.identities || []).map(id => `${id.role}${id.isCopy ? '*' : ''}`);
    return JSON.stringify({ ids });
  },
  renderLobbyDiff(data) {
    $('setup-view').classList.add('hidden');
    $('join-view').classList.add('hidden');
    const needFull = $('lobby-view').classList.contains('hidden')
      || !this._lobbyStructSig
      || this._lobbyStructSig !== this.buildLobbyStructSig(data);

    if (needFull) {
      this.renderLobby(data);
    } else {
      const me = data.players?.[this.me];
      const mySig = this.buildMyIdentitySig(me);
      if (this._myIdentitySig !== mySig) {
        const box = $('lobby-identity-section');
        if (box) box.innerHTML = this.generateIdentityHtml(me, data.state.phase);
      }
      $('lobby-view').classList.remove('hidden');
      $('game-view').classList.add('hidden');
    }
    this._lobbyStructSig = this.buildLobbyStructSig(data);
    this._myIdentitySig = this.buildMyIdentitySig(data.players?.[this.me]);
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
            <button class="control-btn" data-action="host-transfer" type="button">确认移交</button>
          </div>
          <div class="lobby-progress">
            <div class="progress-text">准备进度: ${readyCount}/${players.length}</div>
            <div class="progress-bar"><div class="progress-fill" style="width: ${players.length ? (readyCount / players.length * 100) : 0}%"></div></div>
          </div>
          <button class="confirm-btn" data-action="host-start-from-lobby" type="button">
            ${allReady ? '开始游戏' : `强制开始（${readyCount}/${players.length}）`}
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
            <button class="control-btn" data-action="copy-link" data-link="${location.origin}${location.pathname}?game=${this.gameId}" type="button">复制链接</button>
          </div>
        </div>
        <div class="player-status-grid">
          ${players.map(p => `
            <div class="player-status-item ${p.isReady ? 'ready' : 'waiting'}">
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

    this._lobbyStructSig = this.buildLobbyStructSig(data);
    this._myIdentitySig = this.buildMyIdentitySig(me);
  },

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
      [PHASE.SETUP]: '等待确认',
      [PHASE.LOBBY]: '大厅',
      [PHASE.NIGHT]: `第 ${st.round} 夜晚`,
      [PHASE.NIGHT_WITCH]: `第 ${st.round} 夜晚 · 女巫行动`,
      [PHASE.SHERIFF_CAND]: '首夜上警 · 意向',
      [PHASE.SHERIFF_SPEECH]: '首夜上警 · 发言',
      [PHASE.SHERIFF_VOTE]: '首夜上警 · 投票',
      [PHASE.DAY_TALK]: `第 ${st.round} 白天`,
      [PHASE.DAY_VOTE]: `第 ${st.round} 放逐投票`,
      [PHASE.HUNTER]: '猎人行动',
      [PHASE.BADGE]: '警徽移交',
      [PHASE.GAME_OVER]: this.full?.state?.winner || '游戏结束'
    };
    $('status-bar').innerHTML = `<span class="status-text">${phaseMap[st.phase] || '未知状态'}</span>`;
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
             <button class="control-btn" data-action="swap" type="button" aria-label="交换身份顺序">交换</button>
             <button class="confirm-btn" data-action="ready" type="button" aria-label="确认当前身份配置">确认</button>
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
    $('identity-card').innerHTML = this.generateIdentityHtml(me, data.state.phase);

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
      const resultsText = seerResults.map(r => `[N${r.round}] ${r.target}号 → ${r.result}`).join('; ');
      persist.push(`查验历史：${resultsText}`);
    }
    const persistEl = $('persist');
    persistEl.classList.toggle('hidden', persist.length === 0);
    persistEl.innerHTML = persist.map(s => `<div>• ${escapeHtml(s)}</div>`).join('');
  },

  getHiddenActive(data) {
    if (typeof data.state?.hiddenActive === 'boolean') return data.state.hiddenActive;
    const mode = data.settings?.hiddenActivation || 'noActiveWolf';
    if (mode === 'noWolfCardAlive') {
      const anyPureWolfCardAlive = Object.values(data.players || {}).some(p => 
        p.isAlive && p.identities.some(id => id.role === '狼人')
      );
      return !anyPureWolfCardAlive;
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
    const iAmInactiveHiddenWolf = myPlayer ? (this.getActiveRole(myPlayer, data.players, data.state, data.settings) !== '隐狼' && myPlayer.identities.some(i=>i.role==='隐狼') && !hiddenActive) : false;
    const meCanSeeWolves = meIsActingWolf || (wolfVisRule === 'allWolves' && meHasWolfCard && !iAmInactiveHiddenWolf);

    // 狼投票信息（仅狼人可见）
    const wolfVotes = data.actions?.[data.state.round]?.NIGHT?.WOLF || {};
    const voteMap = {};
    Object.entries(wolfVotes).forEach(([voterId, voteData]) => {
      if (voterId === 'final' || voteData?.target === undefined) return;
      const targetId = voteData.target === '0' ? voterId : voteData.target;
      if (!voteMap[targetId]) voteMap[targetId] = [];
      voteMap[targetId].push({ voter: voterId, isEmpty: voteData.target === '0' });
    });
    const wolfFinalTarget = wolfVotes?.final;

    players.forEach((p) => {
      const card = this.renderPlayerCard(p, data, { 
        meCanSeeWolves, wolfVisRule, voteMap, wolfFinalTarget, hiddenActive 
      });
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
    if (p.isExposedIdiot) tags.push('<span class="tag tag-idiot">白痴</span>');
    
    const card = el(`
      <div class="player-card ${isMe ? 'me' : ''} ${!p.isAlive ? 'disabled' : ''}" data-pid="${p.id}" tabindex="0" role="button" aria-label="玩家${p.id}">
        ${numberHtml}
        <div class="tagline">${tags.join('')}</div>
        <div class="hearts">
          <span class="heart ${hearts >= 1 ? '' : 'off'}">❤</span>
          <span class="heart ${hearts >= 2 ? '' : 'off'}">❤</span>
        </div>
      </div>
    `);

    if (ctx.meCanSeeWolves && ctx.voteMap[p.id]) {
      ctx.voteMap[p.id].forEach(vote => {
        const voteDisplay = vote.isEmpty ? '空刀' : vote.voter;
        card.appendChild(el(`<div class="wolf-corner">${voteDisplay}</div>`));
      });
    }
    if (ctx.meCanSeeWolves && ctx.wolfFinalTarget && String(ctx.wolfFinalTarget) === String(p.id)) {
      card.classList.add('wolf-final-target');
    }
    if (this.selection && this.selection.pid === String(p.id)) {
      card.classList.add('selected');
    }

    card.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handlePlayerCardClick(p, ctx);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.handlePlayerCardClick(p, ctx);
      }
    });

    return card;
  },

  handlePlayerCardClick(player, ctx) {
    if (!player.isAlive && this.full.state.phase !== PHASE.BADGE) {
      this.toast('该玩家已出局', 'warning');
      return;
    }
    const mePlayer = this.full.players[this.me];
    if (this.isPlayerActingWolf(mePlayer, this.full, ctx.hiddenActive) && this.full.state.phase === PHASE.NIGHT) {
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
    if (ctx.wolfVisRule === 'allWolves') return isWolfVisible;
    return this.isPlayerActingWolf(targetPlayer, data, hiddenActive);
  },

  selectPlayer(pid) {
    this.selection = { pid: String(pid) };
    if (this.full) {
      this.renderPlayers(this.full);
      this.renderActions(this.full);
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

  renderActions(data) {
    const panel = $('action-panel');
    const st = data.state;
    const me = data.players?.[this.me];
    if (!me) { panel.innerHTML = this.infoBox('玩家数据加载中...'); return; }

    const allowWhenDead = st.phase === PHASE.HUNTER && st.hunters?.[this.me];
    if (!me.isAlive && !allowWhenDead && ![PHASE.BADGE, PHASE.GAME_OVER].includes(st.phase)) {
      panel.innerHTML = this.infoBox('💀 你已出局，无法行动。');
      return;
    }

    const ar = this.getActiveRole(me, data.players, data.state, data.settings);
    const sel = this.selection?.pid;

    switch(st.phase) {
      case PHASE.NIGHT:        this.renderNightActions(panel, data, me, ar, sel); break;
      case PHASE.NIGHT_WITCH:  this.renderWitchActions(panel, data, me, ar, sel); break;
      case PHASE.SHERIFF_CAND: this.renderSheriffCandActions(panel, data, me); break;
      case PHASE.SHERIFF_SPEECH:this.renderSheriffSpeechActions(panel, data, me); break;
      case PHASE.SHERIFF_VOTE: this.renderSheriffVoteActions(panel, data, sel); break;
      case PHASE.DAY_TALK:     this.renderDayTalkActions(panel, data, me, ar, sel); break;
      case PHASE.DAY_VOTE:     this.renderDayVoteActions(panel, data, me, sel); break;
      case PHASE.HUNTER:       this.renderHunterActions(panel, data, me, sel); break;
      case PHASE.BADGE:        this.renderBadgeActions(panel, data, me, sel); break;
      case PHASE.GAME_OVER:    this.renderGameOverActions(panel, data); break;
      default:                 panel.innerHTML = this.infoBox('等待中...'); break;
    }

    // 应用面板锁（若此前已被用户在本阶段锁定）
    this.applyActionPanelLock(panel, st);
  },

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
    const hasMyVote = Object.prototype.hasOwnProperty.call(wolfData, me.id) && (wolfData[me.id]?.target !== undefined);
    const finalTarget = wolfData.final;
    const alphaId = this.getAlphaWolfId(data);
    const isAlpha = String(alphaId) === String(me.id);

    const voteDisplay = (v) => (v === '0' ? '🔪 空刀' : (v ? `${v}号` : '未选择'));
    const finalDisplay = (finalTarget === '0') ? '⚔️ 空刀' : (finalTarget ? `⚔️ ${finalTarget}号` : '未定');

    const hiddenActive = this.getHiddenActive(data);
    const actingWolves = Object.values(data.players).filter(p => this.isPlayerActingWolf(p, data, hiddenActive));
    const votedWolves = actingWolves.filter(w => wolfData[w.id]?.target !== undefined);
    
    panel.innerHTML = `
      <div class="action-prompt">🐺 狼人行动 ${isAlpha ? '(你是拍板狼)' : `(拍板狼：${alphaId ?? '--'}号)`}</div>
      <div class="action-target">我的目标: ${voteDisplay(myVote)} | 最终目标: ${finalDisplay}</div>
      <div class="vote-progress">投票进度: ${votedWolves.length}/${actingWolves.length}</div>
      <div class="action-buttons">
        <button class="control-btn" data-action="wolf-empty" type="button" ${myVote === '0' ? 'disabled' : ''}>空刀</button>
        ${isAlpha ? `<button class="confirm-btn" data-action="wolf-final" type="button" ${!hasMyVote ? 'disabled' : ''}>确认击杀</button>` : ''}
      </div>
    `;
  },

  renderOtherNightActions(panel, data, me, ar, sel) {
    if (ar === '守卫') {
      const last = me.skill?.lastGuard;
      const canGuard = sel && String(sel) !== String(last);
      panel.innerHTML = `
        <div class="action-prompt">🛡️ 守卫</div>
        <div class="action-target">
          当前选择: ${sel ? `${sel}号` : '未选择'}
          ${last !== undefined ? `<br>上一夜：${last === null ? '空守' : last + '号'}` : ''}
        </div>
        <div class="action-buttons">
          <button class="control-btn" data-action="guard-null" type="button">空守</button>
          <button class="confirm-btn" data-action="guard-confirm" type="button" ${!canGuard ? 'disabled' : ''}>
            确认守护${sel ? ` ${sel}号` : ''}
          </button>
        </div>
      `;
    } else if (ar === '预言家') {
      panel.innerHTML = `
        <div class="action-prompt">🔮 预言家</div>
        <div class="action-target">当前目标: ${sel ? `${sel}号` : '未选择'}</div>
        <div class="action-buttons">
          <button class="confirm-btn" data-action="seer-confirm" type="button" ${!sel ? 'disabled' : ''}>
            确认查验${sel ? ` ${sel}号` : ''}
          </button>
        </div>
      `;
    } else {
      panel.innerHTML = this.infoBox('🌙 夜晚进行中...');
    }
  },

  renderWitchActions(panel, data, me, ar, sel) {
    if (ar !== '女巫') { panel.innerHTML = this.infoBox('🌙 夜晚进行中...'); return; }

    const st = data.state;
    const witchAct = data.actions?.[st.round]?.NIGHT_WITCH || {};
    const cures = witchAct.cures || {};
    const poisons = witchAct.poisons || {};
    const done = witchAct.done || {};
    const usedCure = !!me.skill?.cureUsed;
    const usedPoison = !!me.skill?.poisonUsed;
    const cureUsedThisNight = !!cures[me.id];
    const poisonUsedThisNight = !!poisons[me.id];
    const alreadyUsedThisNight = cureUsedThisNight || poisonUsedThisNight;

    const wolfTarget = this.getWolfFinalTarget(data);

    const rule = data.settings?.witchRule || 'noFirstNightSelfSave';
    const firstNight = st.round === 1;
    let selfSaveAllowed = !((rule === 'noFirstNightSelfSave' && firstNight) || (rule === 'onlyFirstNightSelfSave' && !firstNight));

    let knifeInfo = '';
    if (usedCure) knifeInfo = '🚫 解药已用，无法查看刀口';
    else if (wolfTarget && wolfTarget !== '0') knifeInfo = `🔪 今晚 ${wolfTarget}号 被刀`;
    else knifeInfo = '🕊️ 今晚无人被刀';

    const canCure = !usedCure && !alreadyUsedThisNight && wolfTarget && wolfTarget !== '0' && (selfSaveAllowed || String(wolfTarget) !== String(me.id));
    const canPoison = !usedPoison && !alreadyUsedThisNight && sel && String(sel) !== '0';

    panel.innerHTML = `
      <div class="action-prompt">🧪 女巫</div>
      <div class="action-target">${knifeInfo}</div>
      <div class="witch-status">
        解药: ${usedCure ? '🚫 已用' : (cureUsedThisNight ? '⏳ 本夜已用' : '✅ 可用')} | 
        毒药: ${usedPoison ? '🚫 已用' : (poisonUsedThisNight ? '⏳ 本夜已用' : '✅ 可用')}
      </div>
      <div class="witch-actions-container">
        <button class="control-btn" data-action="witch-cure" type="button" ${!canCure ? 'disabled' : ''}>
          使用解药${wolfTarget && wolfTarget !== '0' ? ` 救 ${wolfTarget}号` : ''}
        </button>
        <button class="control-btn" data-action="witch-poison" type="button" ${!canPoison ? 'disabled' : ''}>
          毒杀${sel ? ` ${sel}号` : ' (选择目标)'}
        </button>
        <button class="confirm-btn" data-action="witch-done" type="button" ${done[me.id] ? 'disabled' : ''}>结束操作</button>
      </div>
    `;
  },

  renderSheriffCandActions(panel, data, me) {
    const decided = Object.prototype.hasOwnProperty.call(data.state.sheriff?.candidates || {}, me.id);
    const optedUp = data.state.sheriff?.candidates?.[me.id] === true;
    panel.innerHTML = decided
      ? this.infoBox(`你的上警意向已提交：${optedUp ? '上警' : '不上警'}。`)
      : `<div class="action-prompt">⭐ 是否参与警长竞选（首夜）</div>
         <div class="action-buttons">
           <button class="confirm-btn" data-action="sheriff-up" type="button">上警</button>
           <button class="control-btn" data-action="sheriff-down" type="button">不上警</button>
         </div>`;
  },

  renderSheriffSpeechActions(panel, data, me) {
    const isCandidate = data.state.sheriff?.candidates?.[me.id] && !data.state.sheriff?.drops?.[me.id];
    panel.innerHTML = isCandidate 
      ? `<div class="action-prompt">⭐ 你是警长候选人（首夜）</div>
         <div class="action-buttons">
           <button class="control-btn" data-action="sheriff-drop" type="button">退水</button>
         </div>`
      : this.infoBox('🎤 候选人发言中...');
  },

  renderSheriffVoteActions(panel, data, sel) {
    const validCandidates = Object.keys(data.state.sheriff?.candidates || {})
      .filter(id => data.state.sheriff.candidates[id] && !data.state.sheriff.drops?.[id] && data.players?.[id]?.isAlive);
    if (validCandidates.length === 0) {
      panel.innerHTML = this.infoBox('本局无警长。');
      return;
    }
    panel.innerHTML = `
      <div class="action-prompt">⭐ 投票选出警长（首夜）</div>
      <div class="action-target">候选人: ${validCandidates.map(id => `${id}号`).join('、')}</div>
      <div class="action-buttons">
        <button class="control-btn" data-action="sheriff-vote-abstain" type="button">弃票</button>
        <button class="confirm-btn" data-action="sheriff-vote" type="button" ${!sel || !validCandidates.includes(sel) ? 'disabled' : ''}>
          投票给${sel ? ` ${sel}号` : ' (选择候选人)'}
        </button>
      </div>
    `;
  },

  renderDayTalkActions(panel, data, me, ar, sel) {
    const knightReady = (ar === '骑士') && !me.skill?.knightUsed;
    panel.innerHTML = knightReady 
      ? `<div class="action-prompt">⚔️ 你可以发动决斗</div>
         <div class="action-buttons">
           <button class="confirm-btn" data-action="knight-duel" type="button" ${!sel ? 'disabled' : ''}>
             决斗${sel ? ` ${sel}号` : ' (选择目标)'}
           </button>
         </div>`
      : this.infoBox('💬 白天发言中...');
  },

  renderDayVoteActions(panel, data, me, sel) {
    if (me.isExposedIdiot) { panel.innerHTML = this.infoBox('🤪 你是已翻牌白痴，失去投票权。'); return; }
    panel.innerHTML = `
      <div class="action-prompt">🗳️ 放逐投票</div>
      <div class="action-buttons">
        <button class="control-btn" data-action="day-vote-abstain" type="button">弃票</button>
        <button class="confirm-btn" data-action="day-vote" type="button" ${!sel ? 'disabled' : ''}>
          投票放逐${sel ? ` ${sel}号` : ' (选择目标)'}
        </button>
      </div>
    `;
  },

  renderHunterActions(panel, data, me, sel) {
    if (!data.state.hunters?.[me.id]) { panel.innerHTML = this.infoBox('🔫 等待猎人开枪...'); return; }
    panel.innerHTML = `
      <div class="action-prompt">🔫 你是猎人，请开枪！</div>
      <div class="action-buttons">
        <button class="confirm-btn" data-action="hunter-shoot" type="button" ${!sel ? 'disabled' : ''}>
          带走${sel ? ` ${sel}号` : ' (选择目标)'}
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
        <button class="control-btn" data-action="badge-destroy" type="button">撕毁警徽</button>
        <button class="confirm-btn" data-action="badge-pass" type="button" ${!canPass ? 'disabled' : ''}>
          移交给${sel ? ` ${sel}号` : ' (选择继任者)'}
        </button>
      </div>
    `;
  },

  renderGameOverActions(panel, data) {
    panel.innerHTML = `<div class="action-feedback game-over-result">${data.state.winner || '🏁 游戏结束'}</div>`;
  },

  renderHost(data) {
    const host = $('host-controls');
    const isHost = String(data.state?.host || '1') === String(this.me);
    host.classList.toggle('hidden', !isHost);
    if (!isHost) { host.innerHTML = ''; return; }

    const st = data.state;
    let html = `<div class="host-panel">`;
    let actionsHtml = `<div class="host-actions-wrapper"><div class="host-status-title">主持控制台</div><div class="host-actions">`;
    switch(st.phase) {
      case PHASE.NIGHT:
      case PHASE.NIGHT_WITCH:
        actionsHtml += `<button class="control-btn" data-action="host-force-dawn" type="button">${st.round === 1 ? '进入上警（首夜）' : '强制天亮'}</button>`;
        break;
      case PHASE.SHERIFF_CAND:
        actionsHtml += `<button class="confirm-btn" data-action="host-speech" type="button">进入发言</button>`;
        break;
      case PHASE.SHERIFF_SPEECH:
        actionsHtml += `<button class="confirm-btn" data-action="host-sheriff-vote" type="button">进入投票</button>`;
        break;
      case PHASE.SHERIFF_VOTE:
        actionsHtml += `<button class="control-btn" data-action="host-force-sheriff-tally" type="button">强制计票</button>`;
        break;
      case PHASE.DAY_TALK:
        actionsHtml += `<button class="confirm-btn" data-action="host-day-vote" type="button">开启放逐投票</button>`;
        actionsHtml += `<button class="control-btn" data-action="host-skip-day" type="button">直接入夜</button>`;
        break;
      case PHASE.DAY_VOTE:
        actionsHtml += `<button class="control-btn" data-action="host-force-day-tally" type="button">强制计票</button>`;
        break;
      case PHASE.HUNTER:
        actionsHtml += `<button class="control-btn" data-action="host-force-hunter-end" type="button">结束猎人阶段</button>`;
        break;
      case PHASE.BADGE:
        actionsHtml += `<button class="control-btn" data-action="host-force-badge-end" type="button">结束移交阶段</button>`;
        break;
      case PHASE.GAME_OVER:
        html = `
          <div class="host-panel">
            <div class="host-status-title">游戏已结束</div>
            <div class="host-actions">
              <button class="confirm-btn" data-action="host-restart" type="button">重开一局</button>
            </div>
            <div class="host-transfer" style="margin-top: 16px;">
              <span>移交主持给:</span>
              <select id="host-transfer-select">
                ${Object.values(data.players).map(p => 
                  `<option value="${p.id}" ${String(p.id) === String(st.host) ? 'selected' : ''}>玩家 ${p.id}</option>`
                ).join('')}
              </select>
              <button class="control-btn" data-action="host-transfer" type="button">确认移交</button>
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

  /* ============================
   *  事件与操作
   * ============================ */

  async onClick(e) {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    const act = a.dataset.action;
    const sel = this.selection?.pid;

    // 基础操作
    if (act === 'create-game') return this.createGame(a);
    if (act === 'open-logs') return this.openLogs();
    if (act === 'close-modal') return this.closeModal(a.dataset.target);
    if (act === 'join-game') {
      const playerNum = $('player-number-input').value?.trim();
      if (!playerNum) { this.toast('请输入你的座位号', 'error'); return; }
      return this.handleJoinGame(playerNum, a);
    }
    if (act === 'copy-link') return this.handleCopyLink(a.dataset.link);

    // 游戏数据依赖
    if (!this.full) { this.toast('游戏数据未加载', 'error'); return; }
    const r = this.full.state.round;
    const meId = this.me;
    const actionPath = `games/${this.gameId}/actions/${r}`;

    // 主持人操作（不锁）
    if (act.startsWith('host-')) return this.handleHostAction(act);

    // 玩家操作
    switch(act) {
      case 'swap': {
        return this.handleSwapIdentities(meId);
      }
      case 'ready': {
        this.lockLobbyIdentity();
        return db.ref(`games/${this.gameId}/players/${meId}/isReady`).set(true);
      }

      // 狼人
      case 'wolf-empty': {
        return db.ref(`${actionPath}/NIGHT/WOLF/${meId}`).set({ target: '0', ts: getHighPrecisionTimestamp() });
      }
      case 'wolf-final': {
        await this.handleWolfFinal(actionPath, meId);
        this.lockActionPanel();
        return;
      }

      // 守卫
      case 'guard-null': {
        await db.ref(`${actionPath}/NIGHT/GUARD/${meId}`).set({ target: null, ts: getHighPrecisionTimestamp() });
        this.lockActionPanel();
        return;
      }
      case 'guard-confirm': {
        if (!sel) return;
        await db.ref(`${actionPath}/NIGHT/GUARD/${meId}`).set({ target: sel, ts: getHighPrecisionTimestamp() });
        this.lockActionPanel();
        return;
      }

      // 预言家
      case 'seer-confirm': {
        if (!sel) return;
        const serverResult = this.engine.computeSeerResultServer(sel);
        await db.ref(`${actionPath}/NIGHT/SEER/${meId}`).set({ 
          target: sel, 
          result: serverResult,
          ts: getHighPrecisionTimestamp()
        });
        this.toast(`已查验 ${sel}号`, 'success');
        this.lockActionPanel();
        return;
      }

      // 女巫
      case 'witch-cure': {
        const wolfTarget = this.getWolfFinalTarget(this.full);
        if (!wolfTarget || wolfTarget === '0') { this.toast('本夜无可救目标', 'error'); return; }
        const witchAct = this.full.actions?.[this.full.state.round]?.NIGHT_WITCH || {};
        if (witchAct.poisons?.[meId]) { this.toast('本夜已使用毒药，不能再用解药', 'error'); return; }
        await db.ref(`${actionPath}/NIGHT_WITCH/cures/${meId}`).set({ target: wolfTarget, ts: getHighPrecisionTimestamp() });
        this.toast(`已使用解药救 ${wolfTarget}号`, 'success');
        this.lockActionPanel();
        return;
      }
      case 'witch-poison': {
        if (!sel || sel === '0') return;
        const witchAct = this.full.actions?.[this.full.state.round]?.NIGHT_WITCH || {};
        if (witchAct.cures?.[meId]) { this.toast('本夜已使用解药，不能再用毒药', 'error'); return; }
        await db.ref(`${actionPath}/NIGHT_WITCH/poisons/${meId}`).set({ target: sel, ts: getHighPrecisionTimestamp() });
        this.toast(`已使用毒药毒杀 ${sel}号`, 'success');
        this.lockActionPanel();
        return;
      }
      case 'witch-done': {
        await db.ref(`${actionPath}/NIGHT_WITCH/done/${meId}`).set(true);
        this.lockActionPanel();
        return;
      }

      // 警长
      case 'sheriff-up':    await db.ref(`games/${this.gameId}/state/sheriff/candidates/${meId}`).set(true); this.lockActionPanel(); return;
      case 'sheriff-down':  await db.ref(`games/${this.gameId}/state/sheriff/candidates/${meId}`).set(false); this.lockActionPanel(); return;
      case 'sheriff-drop':  await db.ref(`games/${this.gameId}/state/sheriff/drops/${meId}`).set(true); this.lockActionPanel(); return;
      case 'sheriff-vote': {
        if (!sel) return;
        await db.ref(`games/${this.gameId}/state/sheriff/votes/${meId}`).set(sel);
        this.lockActionPanel();
        return;
      }
      case 'sheriff-vote-abstain': {
        await db.ref(`games/${this.gameId}/state/sheriff/votes/${meId}`).set('0');
        this.lockActionPanel();
        return;
      }

      // 骑士
      case 'knight-duel': {
        if (!sel) return;
        await db.ref(`${actionPath}/DAY/KNIGHT/${meId}`).set({ target: sel, ts: getHighPrecisionTimestamp(), processed: false });
        this.lockActionPanel();
        return;
      }

      // 白天投票
      case 'day-vote': {
        if (!sel) return;
        await db.ref(`${actionPath}/DAY_VOTE/${meId}`).set({ target: sel, ts: getHighPrecisionTimestamp() });
        this.lockActionPanel();
        return;
      }
      case 'day-vote-abstain': {
        await db.ref(`${actionPath}/DAY_VOTE/${meId}`).set({ target: '0', ts: getHighPrecisionTimestamp() });
        this.lockActionPanel();
        return;
      }

      // 猎人
      case 'hunter-shoot': {
        if (!sel) return;
        await db.ref(`${actionPath}/HUNTER/${meId}`).set({ target: sel, ts: getHighPrecisionTimestamp(), processed: false });
        this.lockActionPanel();
        return;
      }

      // 警徽
      case 'badge-pass': {
        await this.handleBadgePass(sel);
        this.lockActionPanel();
        return;
      }
      case 'badge-destroy': {
        await this.handleBadgeDestroy();
        this.lockActionPanel();
        return;
      }
    }
  },

  async handleHostAction(act) {
    switch(act) {
      case 'host-start-from-lobby': {
        const players = Object.values(this.full?.players || {});
        const allReady = players.length > 0 && players.every(p => p.isReady);
        if (!allReady) {
          const ok = window.confirm(`仍有玩家未准备（${players.filter(p => p.isReady).length}/${players.length}），确定强制开始吗？`);
          if (!ok) return;
        }
        await this.engine.log(allReady ? '全员准备就绪，游戏开始！' : '主持人强制开始游戏。');
        return this.engine.startNight(1);
      }
      case 'host-transfer': {
        const newHostId = $('host-transfer-select').value;
        await db.ref(`games/${this.gameId}/state/host`).set(Number(newHostId));
        this.toast(`主持人已移交给玩家 ${newHostId}`, 'success');
        return;
      }
      case 'host-force-dawn': {
        if ((this.full.state.round || 1) === 1 && (this.full.state.phase === PHASE.NIGHT || this.full.state.phase === PHASE.NIGHT_WITCH)) {
          return this.engine.to(PHASE.SHERIFF_CAND, { sheriff: { candidates: {}, votes: {}, drops: {}, isPK: false } });
        }
        return this.engine.dawnResolve();
      }
      case 'host-speech':               return this.engine.forceSheriffSpeech();
      case 'host-sheriff-vote':         return this.engine.to(PHASE.SHERIFF_VOTE);
      case 'host-force-sheriff-tally':  return this.engine.tallySheriff();
      case 'host-day-vote':             return this.engine.to(PHASE.DAY_VOTE);
      case 'host-force-day-tally':      return this.engine.tallyDayVote();
      case 'host-skip-day':             return this.engine.startNight(this.full.state.round + 1);
      case 'host-restart':              return this.restartGame();
      case 'host-force-hunter-end': {
        const nextPhase = this.full.state.nextPhaseAfterHunter || PHASE.DAY_TALK;
        await this.engine.log('主持人强制结束猎人阶段。', false);
        return db.ref(`games/${this.gameId}/state`).update({ hunters: null, nextPhaseAfterHunter: null, phase: nextPhase });
      }
      case 'host-force-badge-end': {
        const post = this.full.state.postBadge;
        if (post?.dead) await db.ref(`games/${this.gameId}/players/${post.dead}/badge`).set(0);
        await this.engine.log(`主持人结束警徽移交，警徽被撕毁。`, false);
        return this.engine.to(post?.next || PHASE.DAY_TALK, { postBadge: null });
      }
    }
  },

  async handleSwapIdentities(meId) {
    const mePlayer = this.full.players?.[meId];
    if (!mePlayer) return;
    if (mePlayer.isReady) { this.toast('已确认身份，无法再交换', 'warning'); return; }
    const original = mePlayer.identities || [];
    if (original.length !== 2) { this.toast('身份数据异常', 'error'); return; }
    const swapped = [original[1], original[0]];
    await db.ref(`games/${this.gameId}/players/${meId}/identities`).set(swapped);
    this.toast('已交换身份', 'success');
  },

  async handleWolfFinal(actionPath, meId) {
    const alphaId = this.getAlphaWolfId(this.full);
    if (String(alphaId) !== String(meId)) { this.toast('只有拍板狼可以确认最终目标', 'error'); return; }
    const rec = this.full.actions?.[this.full.state.round]?.NIGHT?.WOLF || {};
    const myVote = rec?.[meId]?.target; // 可能是 '0'
    if (myVote === undefined) { this.toast('请先选择击杀目标或空刀', 'warning'); return; }
    await db.ref(`${actionPath}/NIGHT/WOLF/final`).set(myVote);
    this.toast(myVote === '0' ? '已拍板：空刀' : `已拍板：击杀 ${myVote}号`, 'success');
  },

  async handleBadgePass(sel) {
    const post = this.full.state.postBadge;
    const target = this.full.players?.[sel];
    if (!target?.isAlive) { this.toast('只能把警徽移交给存活的玩家', 'error'); return; }
    if (String(sel) === String(post.dead)) { this.toast('不能移交给自己', 'error'); return; }
    await db.ref(`games/${this.gameId}/players/${post.dead}/badge`).set(0);
    await db.ref(`games/${this.gameId}/players/${sel}/badge`).set(1);
    await this.engine.log(`⭐ 警徽移交给了 ${sel}号。`, false);
    return this.engine.to(post.next || PHASE.DAY_TALK, { postBadge: null });
  },

  async handleBadgeDestroy() {
    const post = this.full.state.postBadge;
    await db.ref(`games/${this.gameId}/players/${post.dead}/badge`).set(0);
    await this.engine.log(`🗑️ 警徽被撕毁。`, false);
    return this.engine.to(post.next || PHASE.DAY_TALK, { postBadge: null });
  },

  async handleWolfVote(targetId) {
    const r = this.full.state.round;
    const meId = this.me;
    await db.ref(`games/${this.gameId}/actions/${r}/NIGHT/WOLF/${meId}`).set({ 
      target: String(targetId), 
      ts: getHighPrecisionTimestamp() 
    });
  },

  /* ============================
   *  计算与辅助
   * ============================ */

  getActiveRole(player) {
    if (!player || !player.isAlive) return null;
    const idx = Math.min(player.deaths || 0, 1);
    return player.identities?.[idx]?.role || null;
  },

  isPlayerActingWolf(player, data, hiddenActive) {
    if (!player?.isAlive) return false;
    const idx = Math.min(player.deaths || 0, 1);
    const role = player.identities?.[idx]?.role || null;
    return role === '狼人' || (role === '隐狼' && hiddenActive);
  },

  getWolfFinalTarget(data) { 
    return (data || this.full)?.actions?.[(data || this.full)?.state?.round]?.NIGHT?.WOLF?.final || null; 
  },

  getAlphaWolfId(data) {
    const hiddenActive = this.getHiddenActive(data || this.full);
    const actingWolves = Object.values((data || this.full).players || {}).filter(p => this.isPlayerActingWolf(p, data || this.full, hiddenActive));
    return actingWolves.length > 0 ? Math.min(...actingWolves.map(p => p.id)) : null;
  },

  getSeerResultsForMe(data) {
    const results = [];
    if (!data.actions) return results;
    for (const round in data.actions) {
      const seerAction = data.actions[round]?.NIGHT?.SEER?.[this.me];
      if (seerAction) results.push({ round: parseInt(round, 10), ...seerAction });
    }
    return results.sort((a, b) => a.round - b.round);
  },

  openLogs() {
    if (!this.full) return;
    const logs = Object.values(this.full.logs || {})
      .filter(l => !l.secret)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const box = $('game-log-content');
    box.innerHTML = logs.length
      ? logs.map(l => `<div class="log-item"><span class="log-round">第${l.round || 0}轮</span> ${escapeHtml(l.msg)}</div>`).join('')
      : '<div class="log-item">暂无日志</div>';
    $('logs-modal').classList.add('open');

    const footer = document.querySelector('#logs-modal .modal-footer');
    if (footer) footer.style.display = 'none';

    setTimeout(() => { $('logs-modal')?.querySelector('.modal-close')?.focus?.(); }, 50);
  },

  closeModal(id) {
    const m = id ? document.getElementById(id) : document.querySelector('.modal.open');
    if (m) m.classList.remove('open');
  },

  /* ============================
   *  游戏创建/加入/重开
   * ============================ */

  _clampUniqueCounts(counts) { UNIQUE_ROLES.forEach(r => { if (counts[r] && counts[r] > 1) counts[r] = 1; }); return counts; },

  async createGame(btn) {
    const originalText = btn.textContent;
    btn.disabled = true; btn.textContent = '创建中...';
    try {
      const counts = {};
      $('role-grid').querySelectorAll('input').forEach(i => {
        const r = i.id.replace('role-', ''); const v = +i.value || 0;
        if (v) counts[r] = v;
      });
      this._clampUniqueCounts(counts);
      const pool = [];
      for (const [r, c] of Object.entries(counts)) for (let i = 0; i < c; i++) pool.push(r);
      if (pool.length === 0 || pool.length % 2 !== 0) throw new Error('身份总数必须为偶数且大于0');

      const dealt = this.dealWithGolden(pool);
      if (!dealt) throw new Error(this._lastDealError || '无法生成合规的牌组，请检查配置。');

      const id = db.ref('games').push().key;
      const players = {};
      dealt.pairs.forEach((pair, i) => {
        players[i + 1] = {
          id: i + 1, name: `玩家${i + 1}`, identities: pair,
          deaths: 0, isAlive: true, isReady: false, isExposedIdiot: false, badge: 0, skill: {}
        };
      });

      const hiddenActivation = $('opt-hidden-activation')?.value || 'noActiveWolf';
      const settings = {
        witchRule: $('opt-witch-selfsave')?.value || 'noFirstNightSelfSave',
        seerMode: $('opt-seer-mode')?.value || 'faction',
        wolfWin: $('opt-wolf-win')?.value || 'edge',
        wolfVisibility: $('opt-wolf-visibility')?.value || 'activeOnly',
        hiddenActivation
      };

      const initData = {
        meta: { createdAt: now(), creator: 'FSM-simplified' },
        config: { counts, settings }, 
        players, 
        settings, 
        actions: {}, 
        logs: {},
        state: { phase: PHASE.LOBBY, round: 0, host: 1, peace: 0, winner: null, sheriff: null }
      };

      await db.ref(`games/${id}`).set(initData);
      this.toast('游戏房间创建成功！', 'success');
      location.href = `${location.pathname}?game=${id}&player=1`;
    } catch (e) {
      console.error(e);
      this.toast(e.message || '创建失败', 'error');
      btn.disabled = false; btn.textContent = originalText;
    }
  },

  async restartGame() {
    try {
      this.toast('正在准备新对局...', 'info');
      const oldGameId = this.gameId;
      const config = this.full.config;
      if (!config || !config.counts) throw new Error('无法找到游戏配置，无法重开。');

      const counts = { ...config.counts };
      this._clampUniqueCounts(counts);
      const pool = [];
      for (const [r, c] of Object.entries(counts)) for (let i = 0; i < c; i++) pool.push(r);
      const dealt = this.dealWithGolden(pool);
      if (!dealt) throw new Error(this._lastDealError || '重新发牌失败，无法重开。');

      const newGameId = db.ref('games').push().key;
      const players = {};
      const oldPlayers = Object.values(this.full.players);
      dealt.pairs.forEach((pair, i) => {
        players[i + 1] = {
          id: i + 1, 
          name: oldPlayers[i]?.name || `玩家${i + 1}`, 
          identities: pair,
          deaths: 0, isAlive: true, isReady: false, isExposedIdiot: false, badge: 0, skill: {}
        };
      });

      const initData = {
        meta: { createdAt: now(), creator: 'FSM-simplified', from: oldGameId },
        config: { counts, settings: config.settings }, 
        players, settings: config.settings, actions: {}, logs: {},
        state: { phase: PHASE.LOBBY, round: 0, host: this.full.state.host, peace: 0, winner: null, sheriff: null }
      };
      await db.ref(`games/${newGameId}`).set(initData);
      await db.ref(`games/${oldGameId}/state/nextGameId`).set(newGameId);
      this.toast('新对局已创建，即将跳转...', 'success');
    } catch (e) {
      console.error(e);
      this.toast(e.message || '重开失败', 'error');
    }
  },

  dealWithGolden(pool) {
    let forbiddenHits = 0, doubleThiefHits = 0, noGoldenHits = 0;
    for (let t = 0; t < 10000; t++) {
      const d = shuffle([...pool]);
      const pairs = [];
      let ok = true, hasGolden = false;

      for (let i = 0; i < d.length; i += 2) {
        const role1 = d[i], role2 = d[i + 1];
        const origKey = [role1, role2].sort().join('|');
        if (FORBIDDEN_PAIRS.has(origKey)) { ok = false; forbiddenHits++; break; }
        if (role1 === '盗贼' && role2 === '盗贼') { ok = false; doubleThiefHits++; break; }
      }
      if (!ok) continue;

      for (let i = 0; i < d.length; i += 2) {
        let role1 = d[i], role2 = d[i + 1];
        if (role1 === '盗贼') pairs.push([{ role: role2, isCopy: true }, { role: role2 }]);
        else if (role2 === '盗贼') pairs.push([{ role: role1 }, { role: role1, isCopy: true }]);
        else pairs.push([{ role: role1 }, { role: role2 }]);
      }

      for (const pair of pairs) {
        const key = [pair[0].role, pair[1].role].sort().join('|');
        if (FORBIDDEN_PAIRS.has(key)) { ok = false; forbiddenHits++; break; }
      }
      if (!ok) continue;

      hasGolden = pairs.some(pr => pr[0].role === '平民' && pr[1].role === '平民');
      if (hasGolden) return { pairs };
      noGoldenHits++;
    }
    this._lastDealError = `发牌失败：禁配命中${forbiddenHits}次，双盗${doubleThiefHits}次，无金宝宝${noGoldenHits}次。`;
    return null;
  },

  async handleJoinGame(playerNum, btn) {
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = '验证中...';
    try {
      const playerSnap = await db.ref(`games/${this.gameId}/players/${playerNum}`).once('value');
      if (!playerSnap.exists()) throw new Error('该座位号不存在，请联系主持人或更换座位号');
      const onlineSnap = await db.ref(`games/${this.gameId}/players/${playerNum}/online`).once('value');
      if (onlineSnap.val()) throw new Error('该座位已被占用，请更换座位号');
      location.href = `${location.pathname}?game=${this.gameId}&player=${playerNum}`;
    } catch (e) {
      console.error(e);
      this.toast(e.message || '验证失败，请重试', 'error');
      btn.disabled = false; btn.textContent = original;
    }
  },

  async handleCopyLink(link) {
    try { await navigator.clipboard.writeText(link); this.toast('📋 链接已复制', 'success'); }
    catch {
      const ta = document.createElement('textarea'); ta.value = link; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); this.toast('📋 链接已复制', 'success'); }
      catch { this.toast('❌ 复制失败，请手动复制', 'error'); }
      document.body.removeChild(ta);
    }
  },

  /* ============================
   *  进入房间与监听
   * ============================ */

  async enterGame() {
    this.engine = new Engine(this.gameId);
    const rootRef = db.ref(`games/${this.gameId}`);
    const onlineRef = db.ref(`games/${this.gameId}/players/${this.me}/online`);
    try {
      await onlineRef.set(true);
      onlineRef.onDisconnect().set(false);
    } catch (e) {
      console.warn('online status set failed:', e);
    }

    const onValueChange = (snap) => {
      const data = snap.val();
      if (!data) { this.toast('游戏数据不存在或已被删除。', 'error'); this.destroy(); return; }

      if (data.state?.nextGameId) {
        const newUrl = `${location.pathname}?game=${data.state.nextGameId}&player=${this.me}`;
        this.toast('即将开始新对局...', 'success');
        setTimeout(() => { location.href = newUrl; }, 1200);
        return;
      }

      const prevPhase = this.full?.state?.phase;
      const prevRound = this.full?.state?.round;
      this.full = data;

      // 阶段/回合变化时，解除上一轮的面板锁
      if (this.lockedAction && (this.lockedAction.phase !== data.state.phase || this.lockedAction.round !== data.state.round)) {
        this.unlockActionPanel();
      }

      const isHost = String(data.state.host) === this.me;
      if (isHost && !this.autorun) {
        this.autorun = setInterval(() => this.engine.tick().catch(console.error), 800);
      } else if (!isHost && this.autorun) {
        clearInterval(this.autorun); this.autorun = null;
      }

      if (data.state.phase !== PHASE.LOBBY) {
        this.initGameLayout();
      }

      if (prevPhase && (prevPhase !== data.state.phase || prevRound !== data.state.round)) {
        const phaseMessages = {
          [PHASE.NIGHT]: '🌙 夜幕降临',
          [PHASE.NIGHT_WITCH]: '🧪 女巫行动',
          [PHASE.SHERIFF_CAND]: '⭐ 首夜上警',
          [PHASE.SHERIFF_SPEECH]: '🎤 上警发言',
          [PHASE.SHERIFF_VOTE]: '🗳️ 上警投票',
          [PHASE.DAY_TALK]: '☀️ 白天发言',
          [PHASE.DAY_VOTE]: '🗳️ 放逐投票',
          [PHASE.HUNTER]: '🔫 猎人行动',
          [PHASE.BADGE]: '⭐ 警徽移交',
          [PHASE.GAME_OVER]: '🏁 游戏结束'
        };
        const msg = phaseMessages[data.state.phase];
        if (msg) this.toast(msg, 'info', 1500);
      }

      if (data.state.phase === PHASE.LOBBY) {
        this.renderLobbyDiff(data);
      } else {
        $('lobby-view').classList.add('hidden');
        $('game-view').classList.remove('hidden');
        this.renderAll(data);
      }
    };

    rootRef.on('value', onValueChange);
    this.listener = { ref: rootRef, onlineRef };
  },

  /* ============================
   *  清理
   * ============================ */

  destroy() {
    try {
      if (this.listener.ref) this.listener.ref.off();
      if (this.listener.onlineRef) {
        this.listener.onlineRef.onDisconnect().cancel();
        this.listener.onlineRef.set(false).catch(()=>{});
      }
      if (this.autorun) { clearInterval(this.autorun); this.autorun = null; }
      this.full = null; this.selection = null;
      this.lockedAction = null;
    } catch (e) {
      console.warn('destroy error:', e);
    }
  }
};

/* ==================================================================
 *  5. 启动应用
 * ================================================================== */

window.addEventListener('beforeunload', () => {
  try { App.destroy(); } catch (e) {}
});

document.addEventListener('DOMContentLoaded', () => {
  try {
    App.init();
    console.log('狼人杀应用已启动 (稳定修复版)');
  } catch (e) {
    console.error('App init failed:', e);
    document.body.innerHTML = `
      <div style="
        display:flex;align-items:center;justify-content:center;height:100vh;
        background:var(--bg-primary);color:var(--text-primary);text-align:center;padding:20px;
      ">
        <div>
          <h2>应用启动失败</h2>
          <p>请刷新页面重试，或检查网络连接</p>
          <button onclick="location.reload()" style="
            margin-top: 20px; padding: 10px 20px; background: var(--accent-primary);
            color: white; border: none; border-radius: 8px; cursor: pointer;
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
