/**
 * 双身份狼人杀 - 游戏行动处理
 */

class GameActions {
  constructor(engine, playerId) {
    this.engine = engine;
    this.playerId = playerId;
  }

  // 玩家准备
  async playerReady() {
    await this.engine.updateGame({
      [`players/${this.playerId}/isReady`]: true
    });
  }

  // 交换身份顺序
  async swapIdentities() {
    const player = this.engine.gameData.players[this.playerId];
    const swapped = [player.identities[1], player.identities[0]];
    
    await this.engine.updateGame({
      [`players/${this.playerId}/identities`]: swapped
    });
  }

  // 夜间行动基类
  async nightAction(actionType, data) {
    const round = this.engine.gameData.state.round;
    const path = `actions/${round}/${actionType}`;
    
    await this.engine.updateGame({
      [path]: {
        ...data,
        playerId: this.playerId,
        timestamp: firebase.database.ServerValue.TIMESTAMP
      }
    });
  }

  // 狼人袭击
  async wolfAttack(targetId) {
    const alpha = this.engine.getAlphaWolf();
    if (!alpha || alpha.id !== parseInt(this.playerId)) {
      throw new Error('只有拍板狼可以确认袭击');
    }
    
    await this.nightAction('wolf', { target: targetId });
    await this.engine.addLog(`🐺 狼人袭击了${targetId}号`, true);
  }

  // 狼人聊天
  async wolfChat(message) {
    const round = this.engine.gameData.state.round;
    const path = `wolfChat/${round}`;
    
    await this.engine.gameRef.child(path).push({
      playerId: this.playerId,
      message,
      timestamp: firebase.database.ServerValue.TIMESTAMP
    });
  }

  // 预言家查验
  async seerCheck(targetId) {
    const gameData = this.engine.gameData;
    const target = gameData.players[targetId];
    const mode = gameData.settings.seerMode;
    
    let result;
    if (mode === 'identity') {
      // 查身份
      result = this.engine.getActiveRole(target);
      
      // 处理隐狼
      if (result === '隐狼' && !gameData.state.hiddenWolfActive) {
        const otherRole = target.identities.find(id => id.role !== '隐狼')?.role;
        result = otherRole || '未知';
      }
    } else {
      // 查阵营
      const hasWolf = target.identities.some(id => 
        id.role === '狼人' || id.role === '隐狼'
      );
      
      if (hasWolf) {
        const isHidden = target.identities.some(id => id.role === '隐狼');
        result = (isHidden && !gameData.state.hiddenWolfActive) ? 
          '好人阵营' : '狼人阵营';
      } else {
        result = '好人阵营';
      }
    }
    
    await this.nightAction('seer', { 
      target: targetId,
      result
    });
    
    await this.engine.addLog(`🔮 预言家查验了${targetId}号：${result}`, true);
    
    return result;
  }

  // 守卫守护
  async guardProtect(targetId) {
    const player = this.engine.gameData.players[this.playerId];
    const round = this.engine.gameData.state.round;
    
    // 检查连续守护
    if (player.lastGuard === targetId && round > 1) {
      throw new Error('不能连续守护同一人');
    }
    
    await this.nightAction('guard', { target: targetId });
    await this.engine.updateGame({
      [`players/${this.playerId}/lastGuard`]: targetId
    });
    
    await this.engine.addLog(`🛡️ 守卫守护了${targetId}号`, true);
  }

  // 女巫用药
  async witchAction(action, targetId = null) {
    const player = this.engine.gameData.players[this.playerId];
    const round = this.engine.gameData.state.round;
    
    if (action === 'cure') {
      if (player.cureUsed) {
        throw new Error('解药已使用');
      }
      
      // 检查自救规则
      const wolfTarget = this.engine.gameData.actions?.[round]?.wolf?.target;
      if (wolfTarget === this.playerId) {
        const rule = this.engine.gameData.settings.witchRule;
        if (rule === 'onlyFirstNightSelfSave' && round !== 1) {
          throw new Error('仅首夜可自救');
        }
        if (rule === 'noFirstNightSelfSave' && round === 1) {
          throw new Error('首夜不可自救');
        }
      }
      
      await this.nightAction('witch', { cure: targetId });
      await this.engine.updateGame({
        [`players/${this.playerId}/cureUsed`]: true
      });
      
      await this.engine.addLog(`🧪 女巫使用了解药`, true);
      
    } else if (action === 'poison') {
      if (player.poisonUsed) {
        throw new Error('毒药已使用');
      }
      
      await this.nightAction('witch', { poison: targetId });
      await this.engine.updateGame({
        [`players/${this.playerId}/poisonUsed`]: true
      });
      
      await this.engine.addLog(`🧪 女巫使用了毒药`, true);
    }
  }

  // 猎人开枪
  async hunterShoot(targetId) {
    const result = await this.engine.killPlayer(targetId, 'HUNTER');
    
    await this.engine.addLog(`🔫 猎人带走了${targetId}号`);
    
    // 继续处理流程
    const gameData = await this.engine.getGameData();
    const hunterQueue = gameData.state.hunterQueue || [];
    hunterQueue.shift();
    
    if (hunterQueue.length > 0) {
      await this.engine.updateGame({
        'state/hunterQueue': hunterQueue
      });
    } else {
      // 检查胜利或继续游戏
      if (!await this.engine.checkWinCondition()) {
        const round = gameData.state.round;
        if (round === 1 && gameData.state.phase === GameConfig.PHASES.HUNTER) {
          await this.engine.updateGame({
            'state/phase': GameConfig.PHASES.SHERIFF_ELECTION
          });
        } else {
          await this.engine.updateGame({
            'state/phase': GameConfig.PHASES.DAY_START
          });
        }
      }
    }
    
    return result;
  }

  // 骑士决斗
  async knightDuel(targetId) {
    const target = this.engine.gameData.players[targetId];
    const targetRole = this.engine.getActiveRole(target);
    
    let isWolf = false;
    if (targetRole === '狼人') {
      isWolf = true;
    } else if (targetRole === '隐狼' && this.engine.gameData.state.hiddenWolfActive) {
      isWolf = true;
    }
    
    if (isWolf) {
      // 决斗成功，狼人死亡
      await this.engine.killPlayer(targetId, 'DUEL');
      await this.engine.addLog(`⚔️ 骑士决斗成功，${targetId}号死亡`);
      
      // 直接进入黑夜
      const round = this.engine.gameData.state.round;
      await this.engine.updateGame({
        'state/phase': GameConfig.PHASES.NIGHT,
        'state/round': round + 1
      });
      
    } else {
      // 决斗失败，骑士死亡
      await this.engine.killPlayer(this.playerId, 'DUEL');
      await this.engine.addLog(`⚔️ 骑士决斗失败，${this.playerId}号（骑士）死亡`);
    }
    
    await this.engine.updateGame({
      [`players/${this.playerId}/duelUsed`]: true
    });
  }

  // 警长竞选
  async sheriffElection(action, data = {}) {
    const playerId = this.playerId;
    
    switch(action) {
      case 'signup':
        // 上警
        await this.engine.updateGame({
          [`sheriffElection/candidates/${playerId}`]: true
        });
        await this.engine.addLog(`${playerId}号上警`);
        break;
        
      case 'dropout':
        // 退水
        await this.engine.updateGame({
          [`sheriffElection/candidates/${playerId}`]: null,
          [`sheriffElection/dropouts/${playerId}`]: true
        });
        await this.engine.addLog(`${playerId}号退水`);
        break;
        
      case 'vote':
        // 投票
        const targetId = data.targetId;
        await this.engine.updateGame({
          [`sheriffElection/votes/${playerId}`]: targetId
        });
        break;
    }
  }

  // 白天投票
  async dayVote(targetId) {
    const round = this.engine.gameData.state.round;
    
    await this.engine.updateGame({
      [`votes/${round}/${this.playerId}`]: targetId
    });
  }

  // 警徽移交
  async badgeTransfer(targetId) {
    const from = this.engine.gameData.state.badgeTransfer;
    
    if (targetId === '0') {
      // 撕毁警徽
      await this.engine.addLog(`👑 ${from}号撕毁了警徽`);
    } else {
      // 移交警徽
      await this.engine.updateGame({
        [`players/${targetId}/badge`]: 1
      });
      await this.engine.addLog(`👑 警徽移交给${targetId}号`);
    }
    
    await this.engine.updateGame({
      [`players/${from}/badge`]: null,
      'state/badgeTransfer': null
    });
    
    // 继续流程
    const gameData = await this.engine.getGameData();
    if (gameData.state.hunterQueue?.length > 0) {
      await this.engine.updateGame({
        'state/phase': GameConfig.PHASES.HUNTER
      });
    } else {
      const nextPhase = gameData.state.round === 1 ? 
        GameConfig.PHASES.SHERIFF_ELECTION : 
        GameConfig.PHASES.DAY_START;
      await this.engine.updateGame({
        'state/phase': nextPhase
      });
    }
  }

  // 处理投票结果
  async processVoteResult() {
    const gameData = await this.engine.getGameData();
    const round = gameData.state.round;
    const votes = gameData.votes?.[round] || {};
    
    // 统计票数
    const voteCount = {};
    for (const [voterId, targetId] of Object.entries(votes)) {
      const voter = gameData.players[voterId];
      if (!voter.isAlive || voter.isExposedIdiot) continue;
      
      const weight = voter.badge ? 1.5 : 1;
      voteCount[targetId] = (voteCount[targetId] || 0) + weight;
    }
    
    // 找出最高票
    let maxVotes = 0;
    let maxTargets = [];
    
    for (const [targetId, count] of Object.entries(voteCount)) {
      if (count > maxVotes) {
        maxVotes = count;
        maxTargets = [targetId];
      } else if (count === maxVotes) {
        maxTargets.push(targetId);
      }
    }
    
    // 记录票型
    const voteLog = Object.entries(votes)
      .map(([voter, target]) => `${voter}→${target}`)
      .join('，');
    await this.engine.addLog(`📊 投票结果：${voteLog || '无人投票'}`);
    
    if (maxTargets.length === 1 && maxVotes > 0) {
      // 单人最高票
      const targetId = maxTargets[0];
      const result = await this.engine.killPlayer(targetId, 'VOTE');
      
      if (result.isIdiot) {
        // 白痴翻牌，继续游戏
        await this.engine.updateGame({
          'state/phase': GameConfig.PHASES.NIGHT,
          'state/round': round + 1
        });
      } else if (result.needBadgeTransfer) {
        await this.engine.updateGame({
          'state/phase': GameConfig.PHASES.BADGE_TRANSFER,
          'state/badgeTransfer': targetId
        });
      } else if (result.triggerHunter) {
        await this.engine.updateGame({
          'state/phase': GameConfig.PHASES.HUNTER,
          'state/hunterQueue': [targetId]
        });
      } else {
        // 进入黑夜
        if (!await this.engine.checkWinCondition()) {
          await this.engine.updateGame({
            'state/phase': GameConfig.PHASES.NIGHT,
            'state/round': round + 1
          });
        }
      }
    } else {
      // 平票或无人投票
      await this.engine.addLog('⚖️ 投票平票，无人出局');
      await this.engine.updateGame({
        'state/phase': GameConfig.PHASES.NIGHT,
        'state/round': round + 1
      });
    }
  }

  // 处理警长选举结果
  async processSheriffResult() {
    const gameData = await this.engine.getGameData();
    const votes = gameData.sheriffElection?.votes || {};
    const candidates = Object.keys(gameData.sheriffElection?.candidates || {});
    
    // 统计票数
    const voteCount = {};
    for (const targetId of Object.values(votes)) {
      if (candidates.includes(targetId)) {
        voteCount[targetId] = (voteCount[targetId] || 0) + 1;
      }
    }
    
    // 找出最高票
    let maxVotes = 0;
    let winners = [];
    
    for (const [candidateId, count] of Object.entries(voteCount)) {
      if (count > maxVotes) {
        maxVotes = count;
        winners = [candidateId];
      } else if (count === maxVotes) {
        winners.push(candidateId);
      }
    }
    
    // 记录票型
    const voteLog = Object.entries(votes)
      .map(([voter, target]) => `${voter}→${target}`)
      .join('，');
    await this.engine.addLog(`👑 警长竞选投票：${voteLog || '无人投票'}`);
    
    if (winners.length === 1 && maxVotes > 0) {
      // 选出警长
      const sheriffId = winners[0];
      await this.engine.updateGame({
        [`players/${sheriffId}/badge`]: 1
      });
      await this.engine.addLog(`👑 ${sheriffId}号当选警长`);
      
      // 进入白天
      await this.engine.processDawn();
      
    } else if (winners.length > 1) {
      // 平票PK
      await this.engine.addLog('⚖️ 警长竞选平票，进入PK');
      await this.engine.updateGame({
        'state/phase': GameConfig.PHASES.SHERIFF_VOTE,
        'sheriffElection/pkCandidates': winners.reduce((obj, id) => {
          obj[id] = true;
          return obj;
        }, {})
      });
      
    } else {
      // 无人当选
      await this.engine.addLog('❌ 无人当选警长');
      await this.engine.processDawn();
    }
  }
}

// 导出
window.GameActions = GameActions;
