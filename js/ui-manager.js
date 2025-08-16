/**
 * 双身份狼人杀 - UI管理器
 */

class UIManager {
  constructor() {
    this.gameId = null;
    this.playerId = null;
    this.engine = null;
    this.actions = null;
    this.selectedPlayer = null;
    this.theme = 'light';
  }

  // 初始化
  async init() {
    try {
      // 初始化Firebase
      if (!firebase.apps.length) {
        firebase.initializeApp(GameConfig.FIREBASE_CONFIG);
      }

      // 解析URL参数
      const params = new URLSearchParams(window.location.search);
      this.gameId = params.get('game');
      this.playerId = params.get('player');

      // 初始化动画系统
      AnimationManager.init();

      if (this.gameId) {
        this.engine = new GameEngine(this.gameId);
        await this.engine.init();
        
        if (this.playerId === '0') {
          // 上帝视角
          this.initGodView();
        } else if (this.playerId) {
          // 玩家视角
          this.actions = new GameActions(this.engine, this.playerId);
          this.initPlayerView();
        } else {
          // 选择座位
          this.initLobbyView();
        }
      } else {
        // 创建游戏
        this.showSetupView();
      }

      this.hideLoading();
      this.bindGlobalEvents();
      
    } catch (error) {
      console.error('初始化失败:', error);
      this.showNotification('初始化失败: ' + error.message, 'error');
    }
  }

  // 隐藏加载屏幕
  hideLoading() {
    const loading = document.getElementById('loading-screen');
    if (loading) {
      loading.classList.add('hidden');
      setTimeout(() => loading.remove(), 1000);
    }
  }

  // 显示通知
  showNotification(message, type = 'info') {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = `
      <div class="notification-message">${message}</div>
    `;
    
    container.appendChild(notification);
    
    // 自动移除
    setTimeout(() => {
      notification.classList.add('removing');
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  // 切换视图
  switchView(viewId) {
    document.querySelectorAll('.view').forEach(v => {
      v.classList.remove('active');
    });
    
    const view = document.getElementById(viewId);
    if (view) {
      view.classList.add('active');
    }
  }

  // 切换主题
  toggleTheme(theme = null) {
    if (theme) {
      this.theme = theme;
    } else {
      this.theme = this.theme === 'light' ? 'dark' : 'light';
    }
    
    document.body.setAttribute('data-theme', this.theme);
    AnimationManager.updateTheme(this.theme);
  }

  // ==================== 设置页面 ====================
  
  showSetupView() {
    this.switchView('setup-view');
    this.initSetupForm();
  }

  initSetupForm() {
    const roleGrid = document.getElementById('role-grid');
    if (!roleGrid) return;

    roleGrid.innerHTML = '';
    
    for (const [role, info] of Object.entries(GameConfig.ROLES)) {
      const count = GameConfig.DEFAULT_SETUP[role] || 0;
      
      const item = document.createElement('div');
      item.className = 'role-item';
      item.innerHTML = `
        <div class="role-name">
          <span class="role-icon">${info.icon}</span>
          <span>${role}</span>
        </div>
        <div class="role-controls">
          <button class="role-btn" onclick="UI.changeRoleCount('${role}', -1)">−</button>
          <span class="role-count" id="role-${role}">${count}</span>
          <button class="role-btn" onclick="UI.changeRoleCount('${role}', 1)">+</button>
        </div>
      `;
      
      roleGrid.appendChild(item);
    }
    
    this.updateSetupSummary();
  }

  changeRoleCount(role, delta) {
    const countEl = document.getElementById(`role-${role}`);
    if (!countEl) return;
    
    let count = parseInt(countEl.textContent) || 0;
    count = Math.max(0, count + delta);
    
    // 唯一角色限制
    if (role === '隐狼' || role === '盗贼') {
      count = Math.min(1, count);
    }
    
    countEl.textContent = count;
    this.updateSetupSummary();
  }

  updateSetupSummary() {
    let total = 0;
    
    for (const role of Object.keys(GameConfig.ROLES)) {
      const countEl = document.getElementById(`role-${role}`);
      if (countEl) {
        total += parseInt(countEl.textContent) || 0;
      }
    }
    
    const totalEl = document.getElementById('total-roles');
    const playerEl = document.getElementById('player-count');
    const warningEl = document.getElementById('setup-warning');
    
    if (totalEl) totalEl.textContent = total;
    if (playerEl) playerEl.textContent = Math.floor(total / 2);
    
    if (warningEl) {
      if (total === 0) {
        warningEl.textContent = '请配置角色';
      } else if (total % 2 !== 0) {
        warningEl.textContent = '身份总数必须为偶数';
      } else {
        warningEl.textContent = '';
      }
    }
  }

  async createGame() {
    try {
      // 收集角色配置
      const roleSetup = {};
      for (const role of Object.keys(GameConfig.ROLES)) {
        const countEl = document.getElementById(`role-${role}`);
        if (countEl) {
          const count = parseInt(countEl.textContent) || 0;
          if (count > 0) {
            roleSetup[role] = count;
          }
        }
      }
      
      // 收集游戏设置
      const settings = {
        witchRule: document.getElementById('witch-rule')?.value || 'noFirstNightSelfSave',
        seerMode: document.getElementById('seer-mode')?.value || 'faction',
        wolfWin: document.getElementById('wolf-win')?.value || 'edge',
        hiddenActivation: document.getElementById('hidden-activation')?.value || 'noActiveWolf'
      };
      
      // 创建游戏
      const gameId = await GameEngine.createGame(settings, roleSetup);
      
      // 跳转到游戏
      window.location.href = `?game=${gameId}&player=1`;
      
    } catch (error) {
      console.error('创建游戏失败:', error);
      this.showNotification(error.message || '创建游戏失败', 'error');
    }
  }

  // ==================== 大厅页面 ====================
  
  async initLobbyView() {
    this.switchView('lobby-view');
    
    // 显示房间信息
    const roomIdEl = document.getElementById('room-id');
    if (roomIdEl) roomIdEl.textContent = this.gameId;
    
    const linkEl = document.getElementById('game-link');
    if (linkEl) {
      linkEl.value = `${window.location.origin}${window.location.pathname}?game=${this.gameId}`;
    }
    
    // 监听游戏数据
    this.engine.onGameChange(gameData => {
      this.renderLobby(gameData);
    });
  }

  renderLobby(gameData) {
    const seatGrid = document.getElementById('seat-grid');
    if (!seatGrid) return;
    
    seatGrid.innerHTML = '';
    
    const players = Object.values(gameData.players).sort((a, b) => a.id - b.id);
    
    for (const player of players) {
      const seat = document.createElement('div');
      seat.className = 'seat-item';
      
      if (player.isSitting) {
        seat.classList.add('occupied');
      }
      
      if (String(player.id) === String(this.playerId)) {
        seat.classList.add('me');
      }
      
      if (player.isReady) {
        seat.classList.add('ready');
      }
      
      seat.innerHTML = `
        <div class="seat-number">${player.id}</div>
        ${player.isSitting ? `<div class="seat-name">已落座</div>` : ''}
      `;
      
      // 点击落座
      if (!player.isSitting && !this.playerId) {
        seat.style.cursor = 'pointer';
        seat.onclick = () => this.takeSeat(player.id);
      }
      
      seatGrid.appendChild(seat);
    }
    
    // 如果已落座，显示身份和操作
    if (this.playerId) {
      const me = gameData.players[this.playerId];
      if (me && me.isSitting) {
        this.renderIdentityCard(me);
        this.renderLobbyActions(gameData);
      }
    }
  }

  async takeSeat(seatId) {
    window.location.href = `?game=${this.gameId}&player=${seatId}`;
  }

  renderIdentityCard(player) {
    const card = document.getElementById('identity-card');
    const display = document.getElementById('identity-display');
    
    if (!card || !display) return;
    
    card.classList.remove('hidden');
    
    display.innerHTML = player.identities.map((id, index) => `
      <div class="identity-card ${index === 0 ? 'primary' : ''} ${id.isCopy ? 'thief-copy' : ''}">
        <span class="identity-icon">${id.isCopy ? '🎭' : GameConfig.ROLES[id.role].icon}</span>
        <div class="identity-name">${id.role}</div>
        <div class="identity-desc">${GameConfig.ROLES[id.role].description}</div>
      </div>
    `).join('');
  }

  renderLobbyActions(gameData) {
    const actionsEl = document.getElementById('identity-actions');
    if (!actionsEl) return;
    
    const me = gameData.players[this.playerId];
    if (!me) return;
    
    let html = '';
    
    if (!me.isReady) {
      html += `
        <button class="btn btn-secondary" onclick="UI.swapIdentities()">
          交换身份顺序
        </button>
        <button class="btn btn-primary" onclick="UI.confirmReady()">
          确认准备
        </button>
      `;
    } else {
      html += `<div class="text-center text-muted">已准备，等待其他玩家...</div>`;
    }
    
    actionsEl.innerHTML = html;
    
    // 主持人控制
    if (String(this.playerId) === String(gameData.state.host)) {
      this.renderHostControls(gameData);
    }
  }

  renderHostControls(gameData) {
    const controlsCard = document.getElementById('host-controls');
    const actionsEl = document.getElementById('host-actions');
    
    if (!controlsCard || !actionsEl) return;
    
    controlsCard.classList.remove('hidden');
    
    const allReady = Object.values(gameData.players)
      .filter(p => p.isSitting)
      .every(p => p.isReady);
    
    if (allReady) {
      actionsEl.innerHTML = `
        <button class="btn btn-success btn-large" onclick="UI.startGame()">
          <span class="btn-icon">🚀</span>
          开始游戏
        </button>
      `;
    } else {
      actionsEl.innerHTML = `
        <div class="text-center text-muted">等待所有玩家准备...</div>
      `;
    }
  }

// ==================== 玩家视角 ====================
  
  async initPlayerView() {
    await this.engine.updateGame({
      [`players/${this.playerId}/isSitting`]: true
    });
    
    this.engine.onGameChange(gameData => {
      this.gameData = gameData;
      
      if (gameData.state.phase === GameConfig.PHASES.LOBBY) {
        this.renderLobby(gameData);
      } else if (gameData.state.phase === GameConfig.PHASES.GAME_OVER) {
        this.renderGameOver(gameData);
      } else {
        this.switchView('game-view');
        this.renderGame(gameData);
      }
    });
  }

  renderGame(gameData) {
    // 更新游戏状态
    this.updateGameHeader(gameData);
    
    // 更新玩家列表
    this.renderPlayerList(gameData);
    
    // 更新主界面
    this.renderMainPanel(gameData);
    
    // 根据阶段更新主题
    const isDark = ['NIGHT', 'WOLF', 'WITCH', 'SEER', 'GUARD'].includes(gameData.state.phase);
    this.toggleTheme(isDark ? 'dark' : 'light');
  }

  updateGameHeader(gameData) {
    const phaseEl = document.getElementById('game-phase');
    const roundEl = document.getElementById('game-round');
    
    if (phaseEl) {
      const phaseMap = {
        'NIGHT': '🌙 黑夜',
        'DAWN': '☀️ 黎明',
        'SHERIFF_ELECTION': '👮 警长竞选',
        'SHERIFF_SPEECH': '🗣️ 竞选发言',
        'SHERIFF_VOTE': '🗳️ 警长投票',
        'DAY_START': '☀️ 白天',
        'DAY_SPEECH': '🗣️ 发言',
        'DAY_VOTE': '🗳️ 投票',
        'DUEL': '⚔️ 决斗',
        'HUNTER': '🔫 猎人',
        'BADGE_TRANSFER': '👑 警徽移交'
      };
      phaseEl.textContent = phaseMap[gameData.state.phase] || gameData.state.phase;
    }
    
    if (roundEl) {
      roundEl.textContent = `第${gameData.state.round}轮`;
    }
  }

  renderPlayerList(gameData) {
    const leftList = document.getElementById('players-left');
    const rightList = document.getElementById('players-right');
    
    if (!leftList || !rightList) return;
    
    leftList.innerHTML = '';
    rightList.innerHTML = '';
    
    const players = Object.values(gameData.players).sort((a, b) => a.id - b.id);
    const half = Math.ceil(players.length / 2);
    
    players.forEach((player, index) => {
      const card = this.createPlayerCard(player, gameData);
      if (index < half) {
        leftList.appendChild(card);
      } else {
        rightList.appendChild(card);
      }
    });
  }

  createPlayerCard(player, gameData) {
    const div = document.createElement('div');
    div.className = 'player-card';
    div.dataset.playerId = player.id;
    
    // 添加状态类
    if (!player.isAlive) {
      div.classList.add('dead');
    }
    if (String(player.id) === String(this.playerId)) {
      div.classList.add('me');
    }
    if (player.badge) {
      div.classList.add('sheriff');
    }
    if (player.isExposedIdiot) {
      div.classList.add('exposed-idiot');
    }
    if (String(player.id) === String(this.selectedPlayer)) {
      div.classList.add('selected');
    }
    
    // 构建内容
    let badges = '';
    if (player.badge) badges += '👑';
    if (player.isExposedIdiot) badges += '🤪';
    
    let hearts = '';
    const lives = 2 - (player.deaths || 0);
    for (let i = 0; i < lives; i++) {
      hearts += '❤️';
    }
    
    div.innerHTML = `
      <div class="player-info">
        <span class="player-number">${player.id}号</span>
        <span class="player-badges">${badges}</span>
      </div>
      <div class="player-hearts">${hearts}</div>
    `;
    
    // 添加点击事件
    div.onclick = () => this.selectPlayer(player.id);
    
    return div;
  }

  selectPlayer(playerId) {
    if (String(playerId) === String(this.selectedPlayer)) {
      this.selectedPlayer = null;
    } else {
      this.selectedPlayer = playerId;
    }
    
    // 更新选中状态
    document.querySelectorAll('.player-card').forEach(card => {
      card.classList.remove('selected');
      if (card.dataset.playerId === String(this.selectedPlayer)) {
        card.classList.add('selected');
      }
    });
  }

  renderMainPanel(gameData) {
    const me = gameData.players[this.playerId];
    if (!me) return;
    
    // 渲染身份面板
    this.renderIdentityPanel(me, gameData);
    
    // 根据游戏阶段渲染不同面板
    const phase = gameData.state.phase;
    
    if (phase === 'NIGHT') {
      this.renderNightPanel(me, gameData);
    } else if (phase === 'SHERIFF_ELECTION') {
      this.renderSheriffElectionPanel(me, gameData);
    } else if (phase === 'SHERIFF_VOTE') {
      this.renderSheriffVotePanel(me, gameData);
    } else if (phase === 'DAY_SPEECH') {
      this.renderDaySpeechPanel(me, gameData);
    } else if (phase === 'DAY_VOTE') {
      this.renderDayVotePanel(me, gameData);
    } else if (phase === 'HUNTER') {
      this.renderHunterPanel(me, gameData);
    } else if (phase === 'BADGE_TRANSFER') {
      this.renderBadgeTransferPanel(me, gameData);
    } else {
      this.renderWaitingPanel(gameData);
    }
    
    // 主持人面板
    if (String(this.playerId) === String(gameData.state.host)) {
      this.renderHostPanel(gameData);
    }
  }

  renderIdentityPanel(me, gameData) {
    const panel = document.getElementById('my-identity-panel');
    if (!panel) return;
    
    const activeRole = this.engine.getActiveRole(me);
    const roleInfo = GameConfig.ROLES[activeRole];
    
    panel.innerHTML = `
      <h3>我的身份</h3>
      <div class="identity-display">
        ${me.identities.map((id, index) => {
          const isCurrent = index === (me.deaths || 0);
          return `
            <div class="identity-card ${isCurrent ? 'primary' : ''} ${!isCurrent && me.deaths > index ? 'used' : ''}">
              <span class="identity-icon">${GameConfig.ROLES[id.role].icon}</span>
              <div class="identity-name">${id.role}</div>
              ${id.isCopy ? '<div class="identity-desc">盗贼复制</div>' : ''}
            </div>
          `;
        }).join('')}
      </div>
      <div class="identity-status">
        <div class="status-item">
          <span class="status-label">生命值</span>
          <span class="status-value">${2 - (me.deaths || 0)}/2</span>
        </div>
        <div class="status-item">
          <span class="status-label">当前身份</span>
          <span class="status-value">${activeRole}</span>
        </div>
      </div>
    `;
  }

  renderNightPanel(me, gameData) {
    const panel = document.getElementById('action-panel');
    if (!panel || !me.isAlive) return;
    
    const role = this.engine.getActiveRole(me);
    const round = gameData.state.round;
    
    // 狼人行动
    if (role === '狼人' || (role === '隐狼' && gameData.state.hiddenWolfActive)) {
      this.renderWolfPanel(me, gameData);
      return;
    }
    
    // 其他角色夜间行动
    let content = '<div class="action-prompt">夜深了，请闭眼</div>';
    
    if (role === '预言家') {
      content = `
        <div class="action-prompt">🔮 预言家请睁眼，选择查验对象</div>
        <div class="action-buttons">
          <button class="btn btn-primary" onclick="UI.seerCheck()" 
                  ${!this.selectedPlayer ? 'disabled' : ''}>
            查验 ${this.selectedPlayer || '?'}号
          </button>
        </div>
      `;
    } else if (role === '女巫') {
      const wolfTarget = gameData.actions?.[round]?.wolf?.target;
      const cureUsed = me.cureUsed;
      const poisonUsed = me.poisonUsed;
      
      content = `
        <div class="action-prompt">🧪 女巫请睁眼</div>
        ${wolfTarget && !cureUsed ? `
          <div class="action-info">今晚 ${wolfTarget}号 死了</div>
          <div class="action-buttons">
            <button class="btn btn-success" onclick="UI.witchCure('${wolfTarget}')">
              使用解药救人
            </button>
            <button class="btn btn-secondary" onclick="UI.witchSkip()">
              不救
            </button>
          </div>
        ` : ''}
        ${!poisonUsed ? `
          <div class="action-buttons">
            <button class="btn btn-danger" onclick="UI.witchPoison()"
                    ${!this.selectedPlayer ? 'disabled' : ''}>
              毒杀 ${this.selectedPlayer || '?'}号
            </button>
          </div>
        ` : ''}
        ${cureUsed && poisonUsed ? '<div class="text-muted">药已用尽</div>' : ''}
      `;
    } else if (role === '守卫') {
      const lastGuard = me.lastGuard;
      
      content = `
        <div class="action-prompt">🛡️ 守卫请睁眼，选择守护对象</div>
        ${lastGuard ? `<div class="action-info">上轮守护了 ${lastGuard}号</div>` : ''}
        <div class="action-buttons">
          <button class="btn btn-primary" onclick="UI.guardProtect()"
                  ${!this.selectedPlayer || String(this.selectedPlayer) === String(lastGuard) ? 'disabled' : ''}>
            守护 ${this.selectedPlayer || '?'}号
          </button>
          <button class="btn btn-secondary" onclick="UI.guardSkip()">
            空守
          </button>
        </div>
      `;
    }
    
    panel.innerHTML = content;
  }

  renderWolfPanel(me, gameData) {
    const panel = document.getElementById('action-panel');
    const chatPanel = document.getElementById('wolf-chat-panel');
    
    if (!panel) return;
    
    const wolves = this.engine.getActingWolves();
    const alpha = this.engine.getAlphaWolf();
    const isAlpha = alpha && String(alpha.id) === String(this.playerId);
    
    // 显示狼人聊天区
    if (chatPanel) {
      chatPanel.classList.remove('hidden');
      chatPanel.innerHTML = `
        <div class="wolf-chat-header">
          <div class="wolf-chat-title">
            <span>🐺 狼人频道</span>
          </div>
          <div class="wolf-list">
            ${wolves.map(w => `<span class="wolf-member">${w.id}号</span>`).join('')}
          </div>
        </div>
        <div class="chat-messages" id="wolf-messages"></div>
        <div class="chat-input-area">
          <input type="text" class="chat-input" id="wolf-chat-input" 
                 placeholder="输入消息..." onkeypress="if(event.key==='Enter')UI.sendWolfChat()">
          <button class="btn btn-primary" onclick="UI.sendWolfChat()">发送</button>
        </div>
      `;
      
      this.loadWolfChat(gameData);
    }
    
    // 狼人行动面板
    panel.innerHTML = `
      <div class="action-prompt">🐺 狼人请睁眼，选择袭击目标</div>
      ${isAlpha ? `
        <div class="action-info">你是头狼，请确认今晚的袭击目标</div>
        <div class="action-buttons">
          <button class="btn btn-danger" onclick="UI.wolfAttack()"
                  ${!this.selectedPlayer ? 'disabled' : ''}>
            袭击 ${this.selectedPlayer || '?'}号
          </button>
          <button class="btn btn-secondary" onclick="UI.wolfSkip()">
            空刀
          </button>
        </div>
      ` : `
        <div class="action-info">等待头狼（${alpha?.id}号）决定袭击目标</div>
      `}
    `;
  }

  loadWolfChat(gameData) {
    const messagesEl = document.getElementById('wolf-messages');
    if (!messagesEl) return;
    
    const round = gameData.state.round;
    const messages = gameData.wolfChat?.[round] || {};
    
    messagesEl.innerHTML = Object.values(messages)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(msg => `
        <div class="chat-message">
          <span class="chat-author">${msg.playerId}号:</span>
          <span class="chat-text">${msg.message}</span>
        </div>
      `).join('');
    
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  renderSheriffElectionPanel(me, gameData) {
    const panel = document.getElementById('action-panel');
    if (!panel || !me.isAlive) return;
    
    const candidates = gameData.sheriffElection?.candidates || {};
    const dropouts = gameData.sheriffElection?.dropouts || {};
    
    const isCandidate = candidates[this.playerId];
    const hasDropped = dropouts[this.playerId];
    
    panel.innerHTML = `
      <div class="action-prompt">👮 警长竞选</div>
      ${!isCandidate && !hasDropped ? `
        <div class="action-buttons">
          <button class="btn btn-primary" onclick="UI.sheriffSignup()">
            上警竞选
          </button>
          <button class="btn btn-secondary" onclick="UI.skipSheriff()">
            不上警
          </button>
        </div>
      ` : ''}
      ${isCandidate ? `
        <div class="action-info">你已上警，等待发言</div>
        <div class="action-buttons">
          <button class="btn btn-warning" onclick="UI.sheriffDropout()">
            退水
          </button>
        </div>
      ` : ''}
      ${hasDropped ? `
        <div class="text-muted">你已退水</div>
      ` : ''}
    `;
  }

  renderSheriffVotePanel(me, gameData) {
    const panel = document.getElementById('vote-panel');
    if (!panel || !me.isAlive) return;
    
    const candidates = Object.keys(gameData.sheriffElection?.candidates || {});
    const myVote = gameData.sheriffElection?.votes?.[this.playerId];
    
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <div class="vote-title">👮 警长投票</div>
      <div class="vote-grid">
        ${candidates.map(id => `
          <div class="vote-option ${myVote === id ? 'voted' : ''}"
               onclick="UI.voteSheriff('${id}')">
            <div class="vote-number">${id}号</div>
          </div>
        `).join('')}
      </div>
      ${myVote ? '<div class="text-center text-muted">已投票，等待结果...</div>' : ''}
    `;
  }

  renderDaySpeechPanel(me, gameData) {
    const panel = document.getElementById('action-panel');
    if (!panel || !me.isAlive) return;
    
    const role = this.engine.getActiveRole(me);
    
    let content = '<div class="action-prompt">☀️ 白天发言阶段</div>';
    
    if (role === '骑士' && !me.duelUsed) {
      content += `
        <div class="action-buttons">
          <button class="btn btn-danger" onclick="UI.knightDuel()"
                  ${!this.selectedPlayer ? 'disabled' : ''}>
            ⚔️ 决斗 ${this.selectedPlayer || '?'}号
          </button>
        </div>
      `;
    }
    
    panel.innerHTML = content;
  }

  renderDayVotePanel(me, gameData) {
    const panel = document.getElementById('vote-panel');
    if (!panel || !me.isAlive || me.isExposedIdiot) return;
    
    const round = gameData.state.round;
    const myVote = gameData.votes?.[round]?.[this.playerId];
    const alivePlayers = Object.values(gameData.players).filter(p => p.isAlive);
    
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <div class="vote-title">🗳️ 放逐投票</div>
      <div class="vote-grid">
        ${alivePlayers.map(p => `
          <div class="vote-option ${myVote === String(p.id) ? 'voted' : ''}"
               onclick="UI.dayVote('${p.id}')">
            <div class="vote-number">${p.id}号</div>
          </div>
        `).join('')}
        <div class="vote-option ${myVote === '0' ? 'voted' : ''}"
             onclick="UI.dayVote('0')">
          <div class="vote-number">弃票</div>
        </div>
      </div>
      ${myVote ? '<div class="text-center text-muted">已投票，等待结果...</div>' : ''}
    `;
  }

  renderHunterPanel(me, gameData) {
    const panel = document.getElementById('action-panel');
    if (!panel) return;
    
    const hunterQueue = gameData.state.hunterQueue || [];
    const currentHunter = hunterQueue[0];
    
    if (String(currentHunter) === String(this.playerId)) {
      const alivePlayers = Object.values(gameData.players).filter(p => p.isAlive);
      
      panel.innerHTML = `
        <div class="action-prompt">🔫 猎人技能发动</div>
        <div class="action-info">选择带走的玩家</div>
        <div class="action-buttons">
          ${alivePlayers.map(p => `
            <button class="btn btn-danger" onclick="UI.hunterShoot('${p.id}')">
              ${p.id}号
            </button>
          `).join('')}
        </div>
      `;
    } else {
      panel.innerHTML = `
        <div class="text-center text-muted">等待 ${currentHunter}号 猎人开枪...</div>
      `;
    }
  }

  renderBadgeTransferPanel(me, gameData) {
    const panel = document.getElementById('action-panel');
    if (!panel) return;
    
    const from = gameData.state.badgeTransfer;
    
    if (String(from) === String(this.playerId)) {
      const alivePlayers = Object.values(gameData.players)
        .filter(p => p.isAlive && p.id !== from);
      
      panel.innerHTML = `
        <div class="action-prompt">👑 警徽移交</div>
        <div class="action-buttons">
          ${alivePlayers.map(p => `
            <button class="btn btn-primary" onclick="UI.transferBadge('${p.id}')">
              移交给 ${p.id}号
            </button>
          `).join('')}
          <button class="btn btn-secondary" onclick="UI.transferBadge('0')">
            撕毁警徽
          </button>
        </div>
      `;
    } else {
      panel.innerHTML = `
        <div class="text-center text-muted">等待 ${from}号 移交警徽...</div>
      `;
    }
  }

  renderWaitingPanel(gameData) {
    const panel = document.getElementById('action-panel');
    if (!panel) return;
    
    panel.innerHTML = `
      <div class="text-center text-muted">等待游戏进行...</div>
    `;
  }

  renderHostPanel(gameData) {
    const panel = document.getElementById('host-game-panel');
    if (!panel) return;
    
    panel.classList.remove('hidden');
    
    const phase = gameData.state.phase;
    let content = '<div class="host-title">主持人控制</div><div class="host-actions">';
    
    if (phase === 'DAWN') {
      content += `
        <button class="btn btn-primary" onclick="UI.processDawn()">
          结算夜晚
        </button>
      `;
    } else if (phase === 'SHERIFF_VOTE') {
      content += `
        <button class="btn btn-primary" onclick="UI.processSheriffVote()">
          结算警长投票
        </button>
      `;
    } else if (phase === 'DAY_SPEECH') {
      content += `
        <button class="btn btn-primary" onclick="UI.startDayVote()">
          开始投票
        </button>
      `;
    } else if (phase === 'DAY_VOTE') {
      content += `
        <button class="btn btn-primary" onclick="UI.processDayVote()">
          结算投票
        </button>
      `;
    }
    
    content += '</div>';
    panel.innerHTML = content;
  }

  renderGameOver(gameData) {
    this.switchView('game-view');
    
    const panel = document.getElementById('action-panel');
    if (!panel) return;
    
    const winner = gameData.state.winner;
    const players = Object.values(gameData.players);
    
    panel.innerHTML = `
      <div class="game-over">
        <h2>${winner === '好人阵营' ? '🎉 好人获胜！' : '🐺 狼人获胜！'}</h2>
        <div class="final-roles">
          ${players.map(p => `
            <div class="final-player">
              <span class="player-number">${p.id}号</span>
              <span class="player-roles">
                ${p.identities.map(id => `${GameConfig.ROLES[id.role].icon}${id.role}`).join(' / ')}
              </span>
            </div>
          `).join('')}
        </div>
        ${String(this.playerId) === String(gameData.state.host) ? `
          <div class="host-actions">
            <button class="btn btn-primary" onclick="UI.restartGame()">
              重新开始
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }

  // ==================== 上帝视角 ====================
  
  async initGodView() {
    this.switchView('god-view');
    
    this.engine.onGameChange(gameData => {
      this.renderGodView(gameData);
    });
  }

  renderGodView(gameData) {
    this.renderGodPlayerTable(gameData);
    this.renderGodControls(gameData);
    this.renderGodLogs(gameData);
  }

  renderGodPlayerTable(gameData) {
    const container = document.getElementById('god-player-table');
    if (!container) return;
    
    const players = Object.values(gameData.players).sort((a, b) => a.id - b.id);
    
    container.innerHTML = `
      <table class="god-table">
        <thead>
          <tr>
            <th>座位</th>
            <th>身份1</th>
            <th>身份2</th>
            <th>生命</th>
            <th>状态</th>
            <th>特殊</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${players.map(p => `
            <tr class="${!p.isAlive ? 'dead' : ''}">
              <td>${p.id}号</td>
              <td>${GameConfig.ROLES[p.identities[0].role].icon} ${p.identities[0].role}</td>
              <td>${GameConfig.ROLES[p.identities[1].role].icon} ${p.identities[1].role}</td>
              <td>${2 - (p.deaths || 0)}/2</td>
              <td>${p.isAlive ? '存活' : '出局'}</td>
              <td>
                ${p.badge ? '👑警长' : ''}
                ${p.isExposedIdiot ? '🤪翻牌' : ''}
                ${p.cureUsed ? '💊解药已用' : ''}
                ${p.poisonUsed ? '☠️毒药已用' : ''}
                ${p.duelUsed ? '⚔️决斗已用' : ''}
              </td>
              <td>
                <button onclick="UI.godKill('${p.id}')" ${!p.isAlive ? 'disabled' : ''}>
                  击杀
                </button>
                <button onclick="UI.godRevive('${p.id}')" ${p.isAlive ? 'disabled' : ''}>
                  复活
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  renderGodControls(gameData) {
    const container = document.getElementById('god-controls');
    if (!container) return;
    
    container.innerHTML = `
      <div class="god-control-item">
        <label>游戏阶段</label>
        <select onchange="UI.godChangePhase(this.value)">
          ${Object.values(GameConfig.PHASES).map(phase => `
            <option value="${phase}" ${phase === gameData.state.phase ? 'selected' : ''}>
              ${phase}
            </option>
          `).join('')}
        </select>
      </div>
      <div class="god-control-item">
        <button class="btn btn-primary" onclick="UI.godProcessPhase()">
          推进游戏
        </button>
      </div>
      <div class="god-control-item">
        <button class="btn btn-warning" onclick="UI.godRestartGame()">
          重置游戏
        </button>
      </div>
    `;
  }

  renderGodLogs(gameData) {
    const container = document.getElementById('god-logs');
    if (!container) return;
    
    const logs = Object.values(gameData.logs || {})
      .sort((a, b) => b.timestamp - a.timestamp);
    
    container.innerHTML = logs.map(log => `
      <div class="log-item ${log.secret ? 'secret' : ''}">
        <span class="log-round">第${log.round}轮</span>
        <span class="log-message">${log.message}</span>
      </div>
    `).join('');
  }

  // ==================== 日志系统 ====================
  
  showLogs() {
    const modal = document.getElementById('logs-modal');
    const content = document.getElementById('logs-content');
    
    if (!modal || !content) return;
    
    modal.classList.add('active');
    
    this.engine.getGameData().then(gameData => {
      const logs = Object.values(gameData.logs || {})
        .filter(log => !log.secret || this.playerId === '0')
        .sort((a, b) => a.timestamp - b.timestamp);
      
      content.innerHTML = logs.map(log => `
        <div class="log-item ${log.secret ? 'secret' : ''}">
          <span class="log-round">第${log.round}轮</span>
          <span class="log-message">${log.message}</span>
        </div>
      `).join('');
    });
  }

  hideLogs() {
    const modal = document.getElementById('logs-modal');
    if (modal) {
      modal.classList.remove('active');
    }
  }

  // ==================== 动作处理 ====================
  
  async swapIdentities() {
    try {
      await this.actions.swapIdentities();
      this.showNotification('身份顺序已交换', 'success');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async confirmReady() {
    try {
      await this.actions.playerReady();
      this.showNotification('已准备', 'success');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async startGame() {
    try {
      await this.engine.startGame();
      this.showNotification('游戏开始！', 'success');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async restartGame() {
    if (confirm('确定要重新开始游戏吗？')) {
      try {
        await this.engine.restartGame();
        this.showNotification('游戏已重置', 'success');
      } catch (error) {
        this.showNotification(error.message, 'error');
      }
    }
  }

  // 夜间行动
  async wolfAttack() {
    if (!this.selectedPlayer) return;
    try {
      await this.actions.wolfAttack(this.selectedPlayer);
      this.showNotification('已选择袭击目标', 'success');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async wolfSkip() {
    try {
      await this.actions.wolfAttack('0');
      this.showNotification('今晚空刀', 'info');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async sendWolfChat() {
    const input = document.getElementById('wolf-chat-input');
    if (!input || !input.value.trim()) return;
    
    try {
      await this.actions.wolfChat(input.value.trim());
      input.value = '';
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async seerCheck() {
    if (!this.selectedPlayer) return;
    try {
      const result = await this.actions.seerCheck(this.selectedPlayer);
      this.showNotification(`查验结果：${result}`, 'info');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async guardProtect() {
    if (!this.selectedPlayer) return;
    try {
      await this.actions.guardProtect(this.selectedPlayer);
      this.showNotification('守护成功', 'success');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async guardSkip() {
    try {
      await this.actions.guardProtect('0');
      this.showNotification('今晚空守', 'info');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async witchCure(targetId) {
    try {
      await this.actions.witchAction('cure', targetId);
      this.showNotification('使用解药', 'success');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async witchPoison() {
    if (!this.selectedPlayer) return;
    try {
      await this.actions.witchAction('poison', this.selectedPlayer);
      this.showNotification('使用毒药', 'success');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async witchSkip() {
    this.showNotification('不使用药水', 'info');
  }

  // 白天行动
  async knightDuel() {
    if (!this.selectedPlayer) return;
    if (confirm(`确定要决斗 ${this.selectedPlayer}号 吗？`)) {
      try {
        await this.actions.knightDuel(this.selectedPlayer);
      } catch (error) {
        this.showNotification(error.message, 'error');
      }
    }
  }

  async hunterShoot(targetId) {
    if (confirm(`确定要带走 ${targetId}号 吗？`)) {
      try {
        await this.actions.hunterShoot(targetId);
      } catch (error) {
        this.showNotification(error.message, 'error');
      }
    }
  }

  // 警长相关
  async sheriffSignup() {
    try {
      await this.actions.sheriffElection('signup');
      this.showNotification('已上警', 'success');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async sheriffDropout() {
    try {
      await this.actions.sheriffElection('dropout');
      this.showNotification('已退水', 'info');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async skipSheriff() {
    this.showNotification('不参与警长竞选', 'info');
  }

  async voteSheriff(targetId) {
    try {
      await this.actions.sheriffElection('vote', { targetId });
      this.showNotification('投票成功', 'success');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async transferBadge(targetId) {
    try {
      await this.actions.badgeTransfer(targetId);
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  // 投票
  async dayVote(targetId) {
    try {
      await this.actions.dayVote(targetId);
      this.showNotification('投票成功', 'success');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  // 主持人操作
  async processDawn() {
    try {
      await this.engine.processDawn();
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async processSheriffVote() {
    try {
      await this.actions.processSheriffResult();
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async startDayVote() {
    try {
      await this.engine.updateGame({
        'state/phase': GameConfig.PHASES.DAY_VOTE
      });
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async processDayVote() {
    try {
      await this.actions.processVoteResult();
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  // 上帝操作
  async godKill(playerId) {
    try {
      await this.engine.killPlayer(playerId, 'GOD');
      this.showNotification(`已击杀 ${playerId}号`, 'success');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async godRevive(playerId) {
    try {
      await this.engine.updateGame({
        [`players/${playerId}/isAlive`]: true,
        [`players/${playerId}/deaths`]: 0
      });
      this.showNotification(`已复活 ${playerId}号`, 'success');
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async godChangePhase(phase) {
    try {
      await this.engine.updateGame({
        'state/phase': phase
      });
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async godProcessPhase() {
    try {
      const gameData = await this.engine.getGameData();
      const phase = gameData.state.phase;
      
      if (phase === 'DAWN') {
        await this.engine.processDawn();
      } else if (phase === 'NIGHT') {
        await this.engine.updateGame({
          'state/phase': GameConfig.PHASES.DAWN
        });
      }
    } catch (error) {
      this.showNotification(error.message, 'error');
    }
  }

  async godRestartGame() {
    if (confirm('确定要重置游戏吗？')) {
      try {
        await this.engine.restartGame();
      } catch (error) {
        this.showNotification(error.message, 'error');
      }
    }
  }

  // 绑定全局事件
  bindGlobalEvents() {
    // 日志按钮
    const logsBtn = document.getElementById('logs-btn');
    if (logsBtn) {
      logsBtn.onclick = () => this.showLogs();
    }

    // 模态框关闭
    document.querySelectorAll('.modal-close, .modal-backdrop').forEach(el => {
      el.onclick = (e) => {
        const modal = e.target.closest('.modal');
        if (modal) modal.classList.remove('active');
      };
    });

    // 复制链接
    const copyBtn = document.getElementById('copy-link-btn');
    if (copyBtn) {
      copyBtn.onclick = () => {
        const input = document.getElementById('game-link');
        if (input) {
          input.select();
          document.execCommand('copy');
          this.showNotification('链接已复制', 'success');
        }
      };
    }

    // 创建游戏按钮
    const createBtn = document.getElementById('create-game-btn');
    if (createBtn) {
      createBtn.onclick = () => this.createGame();
    }
  }
}

// 创建全局实例
const UI = new UIManager();

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
  UI.init();
});

// 导出到全局
window.UI = UI;
