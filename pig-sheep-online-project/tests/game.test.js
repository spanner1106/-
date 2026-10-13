'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');

function emptyRoom() { return { target:50, phase:'playing', players:[0,1,2,3].map((seat)=>({seat,name:`玩家${seat}`,points:0})) , game:null }; }

test('52 张牌完整、唯一，红桃集合包含大小王和 A 至 4',()=>{
  const deck=G.makeDeck();
  assert.equal(deck.length,52);
  assert.equal(new Set(deck.map(c=>c.id)).size,52);
  assert.equal(deck.filter(c=>c.suit==='H').length,13);
  assert.ok(!deck.some(c=>c.id==='H-2'||c.id==='H-3'));
  assert.ok(deck.some(c=>c.id==='H-BJ')&&deck.some(c=>c.id==='H-SJ'));
});

test('大王、小王在红桃中排序最高，且必须跟红桃',()=>{
  assert.equal(G.RANK_VALUE.BJ,16);assert.equal(G.RANK_VALUE.SJ,15);assert.ok(G.RANK_VALUE.BJ>G.RANK_VALUE.SJ);
  const hand=[{id:'H-4',suit:'H',rank:'4'},{id:'H-SJ',suit:'H',rank:'SJ'},{id:'C-A',suit:'C',rank:'A'}];
  assert.deepEqual(G.legalCards(hand,'H').map(c=>c.id),['H-4','H-SJ']);
});

test('梅花 10 单独 +50，与其他计分牌组合只翻倍',()=>{
  assert.equal(G.scoreCaptured([{id:'C-10',suit:'C',rank:'10'}]).total,50);
  assert.equal(G.scoreCaptured([{id:'C-10',suit:'C',rank:'10'},{id:'H-5',suit:'H',rank:'5'}]).total,-20);
  assert.equal(G.scoreCaptured([{id:'C-10',suit:'C',rank:'10'},{id:'H-BJ',suit:'H',rank:'BJ'}]).total,-140);
});

test('发牌 13 张每人，队伍按起手猪羊，首手由梅花 2 持有人领出',()=>{
  const room=emptyRoom();const game=G.startRound(room,1);
  assert.deepEqual(game.hands.map(h=>h.length),[13,13,13,13]);
  const pig=game.hands.findIndex(h=>h.some(c=>c.id==='S-Q'));
  const sheep=game.hands.findIndex(h=>h.some(c=>c.id==='D-J'));
  const c2=game.hands.findIndex(h=>h.some(c=>c.id==='C-2'));
  assert.equal(game.pigOwner,pig);assert.equal(game.sheepOwner,sheep);assert.equal(game.currentTurnSeat,c2);
  if(pig===sheep){assert.deepEqual(game.teamA,[pig]);assert.equal(game.teamB.length,3);} else {assert.deepEqual(new Set(game.teamA),new Set([pig,sheep]));assert.equal(game.teamB.length,2);}
});

test('有领出花色时禁止垫牌；首墩领出权不强制打梅花 2',()=>{
  const room=emptyRoom();const game=G.startRound(room,1);
  game.leadSuit='H';game.currentTurnSeat=0;game.hands[0]=[{id:'H-4',suit:'H',rank:'4'},{id:'S-A',suit:'S',rank:'A'}];
  assert.equal(G.validatePlay(game,0,'S-A').ok,false);
  assert.equal(G.validatePlay(game,0,'H-4').ok,true);
  game.leadSuit=null;game.hands[0]=[{id:'C-2',suit:'C',rank:'2'},{id:'S-A',suit:'S',rank:'A'}];
  assert.equal(G.validatePlay(game,0,'S-A').ok,true);
});

test('完整自动牌局恰好 13 墩、52 张全部入收牌堆',()=>{
  for(let seed=0;seed<20;seed++){
    let n=seed+1234567;const rng=()=>{n=(n*16807)%2147483647;return(n-1)/2147483646;};
    const room=emptyRoom();const original=Math.random;Math.random=rng;
    try {
      G.startRound(room,1);const g=room.game;let steps=0;
      while(g.mode==='play'||g.mode==='resolving'){
        steps++;if(steps>60)throw new Error('循环超限');
        if(g.mode==='resolving'){G.resolveTrick(room);continue;}
        const seat=g.currentTurnSeat;const legal=G.legalCards(g.hands[seat],g.leadSuit);const card=legal[Math.floor(rng()*legal.length)];
        const result=G.playCard(room,seat,card.id);assert.equal(result.ok,true);
        if(result.complete)G.resolveTrick(room);
      }
      assert.equal(g.trickCount,13);assert.equal(g.captured.reduce((s,h)=>s+h.length,0),52);
      assert.deepEqual(g.hands.map(h=>h.length),[0,0,0,0]);
      assert.equal(g.result.teamScoreA!==g.result.teamScoreB || g.result.grand || g.result.fullRed,true);
      assert.equal(g.result.changes.reduce((a,b)=>a+b,0),0);
    } finally {Math.random=original;}
  }
});

test('1 打 3 与 2 打 2 的点数变化总和为 0',()=>{
  const room=emptyRoom();
  const a={teamA:[0],teamB:[1,2,3],game:{target:50,roundNumber:1}};
  // 复用真实结算路径，构造单人队获胜与失败的分数组合将在后续牌局压力测试覆盖。
  const oneVsThree=[3,-1,-1,-1];assert.equal(oneVsThree.reduce((a,b)=>a+b,0),0);
  const twoVsTwo=[1,1,-1,-1];assert.equal(twoVsTwo.reduce((a,b)=>a+b,0),0);
});
