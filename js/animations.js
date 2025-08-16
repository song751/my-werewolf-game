/**
 * 双身份狼人杀 - 动画管理器
 */

class AnimationManager {
  static init() {
    this.createParticles();
    this.initScrollAnimations();
    this.initHoverEffects();
  }

  // 创建背景粒子效果
  static createParticles() {
    const particleCount = 20;
    const container = document.body;
    
    for (let i = 0; i < particleCount; i++) {
      const particle = document.createElement('div');
      particle.className = 'particle';
      particle.style.left = Math.random() * 100 + '%';
      particle.style.animationDelay = Math.random() * 15 + 's';
      particle.style.animationDuration = (15 + Math.random() * 10) + 's';
      container.appendChild(particle);
    }
  }

  // 初始化滚动动画
  static initScrollAnimations() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('animate-in');
        }
      });
    }, {
      threshold: 0.1
    });

    document.querySelectorAll('.card-animated').forEach(card => {
      observer.observe(card);
    });
  }

  // 初始化悬停效果
  static initHoverEffects() {
    // 按钮涟漪效果
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn');
      if (!btn) return;
      
      const ripple = document.createElement('span');
      const rect = btn.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const x = e.clientX - rect.left - size / 2;
      const y = e.clientY - rect.top - size / 2;
      
      ripple.style.width = ripple.style.height = size + 'px';
      ripple.style.left = x + 'px';
      ripple.style.top = y + 'px';
      ripple.className = 'ripple';
      
      btn.appendChild(ripple);
      
      setTimeout(() => ripple.remove(), 600);
    });
  }

  // 更新主题动画
  static updateTheme(theme) {
    const particles = document.querySelectorAll('.particle');
    
    if (theme === 'dark') {
      // 夜晚粒子效果 - 星星
      particles.forEach(particle => {
        particle.style.background = 'white';
        particle.style.boxShadow = '0 0 10px white';
        particle.style.opacity = '0.8';
      });
    } else {
      // 白天粒子效果 - 光点
      particles.forEach(particle => {
        particle.style.background = 'var(--primary-400)';
        particle.style.boxShadow = 'none';
        particle.style.opacity = '0.6';
      });
    }
  }

  // 显示攻击动画
  static showAttackAnimation(fromId, toId) {
    const fromCard = document.querySelector(`[data-player-id="${fromId}"]`);
    const toCard = document.querySelector(`[data-player-id="${toId}"]`);
    
    if (!fromCard || !toCard) return;
    
    const fromRect = fromCard.getBoundingClientRect();
    const toRect = toCard.getBoundingClientRect();
    
    const slash = document.createElement('div');
    slash.className = 'attack-animation';
    slash.style.left = fromRect.left + fromRect.width / 2 + 'px';
    slash.style.top = fromRect.top + fromRect.height / 2 + 'px';
    
    document.body.appendChild(slash);
    
    // 动画移动到目标
    requestAnimationFrame(() => {
      slash.style.transform = `translate(${toRect.left - fromRect.left}px, ${toRect.top - fromRect.top}px)`;
      slash.style.opacity = '0';
    });
    
    setTimeout(() => {
      slash.remove();
      toCard.classList.add('shake');
      setTimeout(() => toCard.classList.remove('shake'), 500);
    }, 500);
  }

  // 显示治疗动画
  static showHealAnimation(targetId) {
    const card = document.querySelector(`[data-player-id="${targetId}"]`);
    if (!card) return;
    
    card.classList.add('heal-animation');
    
    // 创建治疗光环
    const heal = document.createElement('div');
    heal.className = 'heal-effect';
    card.appendChild(heal);
    
    setTimeout(() => {
      heal.remove();
      card.classList.remove('heal-animation');
    }, 1500);
  }

  // 显示死亡动画
  static showDeathAnimation(targetId) {
    const card = document.querySelector(`[data-player-id="${targetId}"]`);
    if (!card) return;
    
    card.classList.add('death-animation');
    
    setTimeout(() => {
      card.classList.add('dead');
      card.classList.remove('death-animation');
    }, 1000);
  }

  // 显示投票动画
  static showVoteAnimation(fromId, toId) {
    const fromCard = document.querySelector(`[data-player-id="${fromId}"]`);
    const toCard = document.querySelector(`[data-player-id="${toId}"]`);
    
    if (!fromCard || !toCard) return;
    
    const fromRect = fromCard.getBoundingClientRect();
    const toRect = toCard.getBoundingClientRect();
    
    const vote = document.createElement('div');
    vote.className = 'vote-animation';
    vote.innerHTML = '🗳️';
    vote.style.left = fromRect.left + fromRect.width / 2 + 'px';
    vote.style.top = fromRect.top + fromRect.height / 2 + 'px';
    
    document.body.appendChild(vote);
    
    requestAnimationFrame(() => {
      vote.style.transform = `translate(${toRect.left - fromRect.left}px, ${toRect.top - fromRect.top}px) scale(0.5)`;
      vote.style.opacity = '0';
    });
    
    setTimeout(() => vote.remove(), 800);
  }

  // 显示决斗动画
  static showDuelAnimation(knightId, targetId) {
    const knightCard = document.querySelector(`[data-player-id="${knightId}"]`);
    const targetCard = document.querySelector(`[data-player-id="${targetId}"]`);
    
    if (!knightCard || !targetCard) return;
    
    // 添加决斗光环
    knightCard.classList.add('duel-attacker');
    targetCard.classList.add('duel-target');
    
    // 创建剑光效果
    const sword = document.createElement('div');
    sword.className = 'sword-effect';
    sword.innerHTML = '⚔️';
    
    const rect = knightCard.getBoundingClientRect();
    sword.style.left = rect.left + rect.width / 2 + 'px';
    sword.style.top = rect.top + rect.height / 2 + 'px';
    
    document.body.appendChild(sword);
    
    setTimeout(() => {
      sword.remove();
      knightCard.classList.remove('duel-attacker');
      targetCard.classList.remove('duel-target');
    }, 2000);
  }

  // 显示阶段转换动画
  static showPhaseTransition(newPhase) {
    const overlay = document.createElement('div');
    overlay.className = 'phase-transition';
    
    const text = document.createElement('div');
    text.className = 'phase-text';
    
    if (newPhase === 'NIGHT') {
      text.innerHTML = '🌙 天黑请闭眼';
      overlay.style.background = 'linear-gradient(180deg, #000428 0%, #004e92 100%)';
    } else if (newPhase === 'DAWN' || newPhase === 'DAY_START') {
      text.innerHTML = '☀️ 天亮了';
      overlay.style.background = 'linear-gradient(180deg, #ffd89b 0%, #19547b 100%)';
    }
    
    overlay.appendChild(text);
    document.body.appendChild(overlay);
    
    setTimeout(() => {
      overlay.classList.add('fade-out');
      setTimeout(() => overlay.remove(), 500);
    }, 1500);
  }

  // 显示胜利动画
  static showVictoryAnimation(winner) {
    const overlay = document.createElement('div');
    overlay.className = 'victory-overlay';
    
    const content = document.createElement('div');
    content.className = 'victory-content';
    
    if (winner === '好人阵营') {
      content.innerHTML = `
        <div class="victory-icon">🎉</div>
        <div class="victory-title">好人获胜！</div>
        <div class="victory-subtitle">正义战胜了邪恶</div>
      `;
      overlay.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
    } else {
      content.innerHTML = `
        <div class="victory-icon">🐺</div>
        <div class="victory-title">狼人获胜！</div>
        <div class="victory-subtitle">黑暗笼罩了村庄</div>
      `;
      overlay.style.background = 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)';
    }
    
    overlay.appendChild(content);
    document.body.appendChild(overlay);
    
    // 创建烟花效果
    this.createFireworks(overlay);
  }

  // 创建烟花效果
  static createFireworks(container) {
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        const firework = document.createElement('div');
        firework.className = 'firework';
        firework.style.left = Math.random() * 100 + '%';
        firework.style.top = Math.random() * 50 + '%';
        container.appendChild(firework);
        
        setTimeout(() => firework.remove(), 2000);
      }, i * 300);
    }
  }
}

// 添加必要的CSS动画
const style = document.createElement('style');
style.textContent = `
  .ripple {
    position: absolute;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.6);
    animation: ripple-effect 0.6s ease-out;
    pointer-events: none;
  }
  
  @keyframes ripple-effect {
    to {
      transform: scale(4);
      opacity: 0;
    }
  }
  
  .animate-in {
    animation: fadeInUp 0.5s ease-out;
  }
  
  @keyframes fadeInUp {
    from {
      opacity: 0;
      transform: translateY(30px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  
  .shake {
    animation: shake 0.5s ease-in-out;
  }
  
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-10px); }
    75% { transform: translateX(10px); }
  }
  
  .heal-animation {
    animation: heal-pulse 1.5s ease-in-out;
  }
  
  @keyframes heal-pulse {
    0%, 100% { 
      box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.7);
    }
    50% { 
      box-shadow: 0 0 20px 10px rgba(76, 175, 80, 0);
    }
  }
  
  .heal-effect {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(76, 175, 80, 0.8) 0%, transparent 70%);
    animation: heal-expand 1.5s ease-out;
  }
  
  @keyframes heal-expand {
    from {
      transform: translate(-50%, -50%) scale(0);
      opacity: 1;
    }
    to {
      transform: translate(-50%, -50%) scale(2);
      opacity: 0;
    }
  }
  
  .death-animation {
    animation: death-fade 1s ease-in-out;
  }
  
  @keyframes death-fade {
    0% { 
      transform: scale(1);
      filter: grayscale(0);
    }
    100% { 
      transform: scale(0.9);
      filter: grayscale(100%);
      opacity: 0.5;
    }
  }
  
  .attack-animation {
    position: fixed;
    width: 100px;
    height: 2px;
    background: linear-gradient(90deg, transparent, red, transparent);
    transform-origin: left center;
    transition: all 0.5s ease-out;
    pointer-events: none;
    z-index: 9999;
  }
  
  .vote-animation {
    position: fixed;
    font-size: 24px;
    transition: all 0.8s ease-out;
    pointer-events: none;
    z-index: 9999;
  }
  
  .duel-attacker {
    animation: duel-attack 2s ease-in-out;
  }
  
  .duel-target {
    animation: duel-defend 2s ease-in-out;
  }
  
  @keyframes duel-attack {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.1); }
  }
  
  @keyframes duel-defend {
    25%, 75% { transform: translateX(-5px); }
    50% { transform: translateX(5px); }
  }
  
  .sword-effect {
    position: fixed;
    font-size: 48px;
    animation: sword-swing 2s ease-in-out;
    pointer-events: none;
    z-index: 9999;
  }
  
  @keyframes sword-swing {
    0% { 
      transform: rotate(0deg) scale(1);
      opacity: 1;
    }
    50% { 
      transform: rotate(360deg) scale(1.5);
    }
    100% { 
      transform: rotate(720deg) scale(0);
      opacity: 0;
    }
  }
  
  .phase-transition {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    animation: fade-in 0.5s ease-out;
  }
  
  .phase-transition.fade-out {
    animation: fade-out 0.5s ease-out;
  }
  
  .phase-text {
    font-size: 3rem;
    font-weight: bold;
    color: white;
    text-shadow: 0 0 20px rgba(0, 0, 0, 0.5);
    animation: zoom-in 1s ease-out;
  }
  
  @keyframes zoom-in {
    from {
      transform: scale(0);
      opacity: 0;
    }
    to {
      transform: scale(1);
      opacity: 1;
    }
  }
  
  @keyframes fade-out {
    to {
      opacity: 0;
    }
  }
  
  .victory-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    animation: fade-in 1s ease-out;
  }
  
  .victory-content {
    text-align: center;
    color: white;
    animation: victory-bounce 1s ease-out;
  }
  
  .victory-icon {
    font-size: 5rem;
    margin-bottom: 1rem;
  }
  
  .victory-title {
    font-size: 3rem;
    font-weight: bold;
    margin-bottom: 0.5rem;
  }
  
  .victory-subtitle {
    font-size: 1.5rem;
    opacity: 0.8;
  }
  
  @keyframes victory-bounce {
    0% {
      transform: scale(0) rotate(0deg);
    }
    50% {
      transform: scale(1.2) rotate(180deg);
    }
    100% {
      transform: scale(1) rotate(360deg);
    }
  }
  
  .firework {
    position: absolute;
    width: 4px;
    height: 4px;
    background: white;
    border-radius: 50%;
  }
  
  .firework::before,
  .firework::after {
    content: '';
    position: absolute;
    width: 4px;
    height: 4px;
    background: inherit;
    border-radius: 50%;
  }
  
  .firework::before {
    animation: firework-particle 2s ease-out;
  }
  
  .firework::after {
    animation: firework-particle 2s ease-out 0.2s;
  }
  
  @keyframes firework-particle {
    0% {
      transform: translate(0, 0);
      opacity: 1;
    }
    100% {
      transform: translate(var(--x, 100px), var(--y, -100px));
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);

// 导出
window.AnimationManager = AnimationManager;
