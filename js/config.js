/**
 * 双身份狼人杀 - 配置文件
 */

// Firebase配置
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCEAgB6DoY8YA6lZnYblhIDVTYH_q8UimI",
  authDomain: "werewolf-game-master-1f37f.firebaseapp.com",
  databaseURL: "https://werewolf-game-master-1f37f-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "werewolf-game-master-1f37f",
  storageBucket: "werewolf-game-master-1f37f.appspot.com",
  messagingSenderId: "626014452910",
  appId: "1:626014452910:web:35b6eba412f95f1878013f"
};

// 游戏常量
const GAME_CONSTANTS = {
  // 角色定义
  ROLES: {
    '平民': { 
      faction: 'good', 
      icon: '👤', 
      isGod: false,
      description: '无特殊技能，努力找出狼人'
    },
    '预言家': { 
      faction: 'good', 
      icon: '🔮', 
      isGod: true,
      description: '每晚可查验一名玩家'
    },
    '女巫': { 
      faction: 'good', 
      icon: '🧪', 
      isGod: true,
      description: '拥有一瓶解药和一瓶毒药'
    },
    '守卫': { 
      faction: 'good', 
      icon: '🛡️', 
      isGod: true,
      description: '每晚可守护一名玩家'
    },
    '猎人': { 
      faction: 'good', 
      icon: '🔫', 
      isGod: true,
      description: '死亡时可带走一名玩家'
    },
    '骑士': { 
      faction: 'good', 
      icon: '⚔️', 
      isGod: true,
      description: '白天可发起决斗'
    },
    '白痴': { 
      faction: 'good', 
      icon: '🤪', 
      isGod: true,
      description: '被投票出局时翻牌免死'
    },
    '狼人': { 
      faction: 'bad', 
      icon: '🐺', 
      isGod: false,
      description: '每晚袭击一名好人'
    },
    '隐狼': { 
      faction: 'bad', 
      icon: '🌑', 
      isGod: false,
      isHidden: true,
      description: '潜伏的狼人，条件满足时激活'
    },
    '盗贼': { 
      faction: 'neutral', 
      icon: '🎭', 
      isGod: false,
      isThief: true,
      description: '复制另一张身份牌'
    }
  },

  // 游戏阶段
  PHASES: {
    SETUP: 'SETUP',
    LOBBY: 'LOBBY',
    NIGHT: 'NIGHT',
    DAWN: 'DAWN',
    SHERIFF_ELECTION: 'SHERIFF_ELECTION',
    SHERIFF_SPEECH: 'SHERIFF_SPEECH',
    SHERIFF_VOTE: 'SHERIFF_VOTE',
    DAY_START: 'DAY_START',
    DAY_SPEECH: 'DAY_SPEECH',
    DAY_VOTE: 'DAY_VOTE',
    DUEL: 'DUEL',
    HUNTER: 'HUNTER',
    BADGE_TRANSFER: 'BADGE_TRANSFER',
    GAME_OVER: 'GAME_OVER'
  },

  // 禁止组合
  FORBIDDEN_PAIRS: [
    ['狼人', '盗贼'],
    ['狼人', '隐狼'],
    ['预言家', '狼人'],
    ['预言家', '隐狼'],
    ['盗贼', '隐狼']
  ],

  // 默认配置
  DEFAULT_SETUP: {
    '平民': 4,
    '预言家': 1,
    '女巫': 1,
    '守卫': 1,
    '猎人': 1,
    '骑士': 1,
    '白痴': 1,
    '狼人': 4,
    '隐狼': 0,
    '盗贼': 0
  },

  // 时间设置（秒）
  TIMERS: {
    NIGHT_ACTION: 30,
    SHERIFF_SPEECH: 60,
    DAY_SPEECH: 90,
    VOTE: 30,
    DUEL_DECISION: 15
  }
};

// 导出配置
window.GameConfig = {
  FIREBASE_CONFIG,
  ...GAME_CONSTANTS
};
