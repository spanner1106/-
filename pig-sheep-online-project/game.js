'use strict';

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const TURN_ORDER = [0,1,2,3]; // 每一座位向下一号轮转；客户端按自己的位置旋转视图
const RED_COLLECTION_IDS = ['H-BJ','H-SJ','H-A','H-K','H-Q','H-J','H-10','H-9','H-8','H-7','H-6','H-5','H-4'];
const SPECIAL_IDS = {'S-Q':'猪','D-J':'羊','C-10':'倒板'};
const RANK_VALUE = Object.fromEntries(RANKS.map((r,i)=>[r,i+2]));
RANK_VALUE.SJ = 15; // 小王 > 红桃 A
RANK_VALUE.BJ = 16; // 大王 > 小王

function cardId(card) { return card.id || `${card.suit}-${card.rank}`; }
function makeDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) {
    if (suit === 'H' && (rank === '2' || rank === '3')) continue;
    deck.push({ id: `${suit}-${rank}`, suit, rank });
  }
  deck.push({ id:'H-BJ', suit:'H', rank:'BJ' }, { id:'H-SJ', suit:'H', rank:'SJ' });
  return deck;
}
function shuffle(deck, rng = Math.random) {
  for (let i=deck.length-1;i>0;i--) { const j=Math.floor(rng()*(i+1)); [deck[i],deck[j]]=[deck[j],deck[i]]; }
  return deck;
}
function sortHand(hand) {
  const suitOrder = {S:0,H:1,C:2,D:3};
  hand.sort((a,b)=>(suitOrder[a.suit]-suitOrder[b.suit]) || (RANK_VALUE[b.rank]-RANK_VALUE[a.rank]));
  return hand;
}
function cardScore(card) {
  const id=cardId(card);
  if(id==='S-Q') return -100;
  if(id==='D-J') return 100;
  if(id==='C-10') return 0;
  if(card.rank==='BJ') return -70;
  if(card.rank==='SJ') return -60;
  if(card.suit==='H') return ({A:-50,K:-40,Q:-30,J:-20,10:-10,9:-10,8:-10,7:-10,6:-10,5:-10,4:-5})[card.rank] ?? 0;
  return 0;
}
function legalCards(hand, leadSuit) {
  if (!leadSuit) return hand.slice();
  const following=hand.filter(c=>c.suit===leadSuit); // 大小王的 suit 都是 H，自动跟红桃
  return following.length ? following : hand.slice();
}
function scoreCaptured(captured) {
  const ownsTransformer = captured.some(c=>cardId(c)==='C-10');
  const scoringCards = captured.filter(c=>cardId(c)!=='C-10' && cardScore(c)!==0);
  const raw = scoringCards.reduce((sum,c)=>sum+cardScore(c),0);
  if (ownsTransformer && scoringCards.length===0) return {raw:50,multiplier:1,total:50,transformer:true,standalone:true};
  if (ownsTransformer) return {raw,multiplier:2,total:raw*2,transformer:true,standalone:false};
  return {raw,multiplier:1,total:raw,transformer:false,standalone:false};
}
function hasAllRed(captured) {
  const ids=new Set(captured.map(cardId));
  return RED_COLLECTION_IDS.every(id=>ids.has(id));
}
function hasGrandSlam(captured) {
  const ids=new Set(captured.map(cardId));
  return hasAllRed(captured) && ['S-Q','D-J','C-10'].every(id=>ids.has(id));
}
function nextTurn(seat) { return (seat+1)%4; }

function startRound(room, roundNumber = 1) {
  const deck=shuffle(makeDeck());
  const hands=[[],[],[],[]];
  deck.forEach((card,i)=>hands[i%4].push(card));
  hands.forEach(sortHand);
  const pigOwner=hands.findIndex(hand=>hand.some(c=>cardId(c)==='S-Q'));
  const sheepOwner=hands.findIndex(hand=>hand.some(c=>cardId(c)==='D-J'));
  const c2Owner=hands.findIndex(hand=>hand.some(c=>cardId(c)==='C-2'));
  const teamA = pigOwner===sheepOwner ? [pigOwner] : [pigOwner,sheepOwner];
  const teamB = [0,1,2,3].filter(s=>!teamA.includes(s));
  const game={
    roundNumber, mode:'play', hands, captured:[[],[],[],[]], tricks:[0,0,0,0],
    plays:[null,null,null,null], leadSuit:null, leaderSeat:c2Owner, currentTurnSeat:c2Owner,
    trickCount:1, trickWinnerSeat:null, pigOwner, sheepOwner, teamA, teamB,
    target:room.target || 50, result:null, turnDeadline:Date.now()+30000
  };
  room.game=game;
  room.phase='playing';
  return game;
}
function getTrickWinner(game) {
  const playedSeats=[0,1,2,3].filter(s=>game.plays[s]);
  let best=null;
  for(const seat of playedSeats) {
    const card=game.plays[seat];
    if(card.suit!==game.leadSuit) continue;
    if(!best || RANK_VALUE[card.rank]>RANK_VALUE[game.plays[best].rank]) best=seat;
  }
  return best===null?game.leaderSeat:best;
}
function validatePlay(game, seat, id) {
  if(game.mode!=='play') return {ok:false,reason:'当前牌局不在出牌阶段'};
  if(seat!==game.currentTurnSeat) return {ok:false,reason:'还没轮到你出牌'};
  if(game.plays[seat]) return {ok:false,reason:'你已经出过本墩的牌'};
  const card=game.hands[seat].find(c=>cardId(c)===id);
  if(!card) return {ok:false,reason:'这张牌不在你的手牌中'};
  const legal=legalCards(game.hands[seat],game.leadSuit);
  if(!legal.some(c=>cardId(c)===id)) return {ok:false,reason:'有领出花色必须跟牌'};
  return {ok:true,card};
}
function playCard(room, seat, id) {
  const game=room.game;
  const checked=validatePlay(game,seat,id);
  if(!checked.ok) return checked;
  const card=checked.card;
  const index=game.hands[seat].findIndex(c=>cardId(c)===id);
  game.hands[seat].splice(index,1);
  game.plays[seat]=card;
  if(!game.leadSuit){game.leadSuit=card.suit;game.leaderSeat=seat;}
  const count=game.plays.filter(Boolean).length;
  if(count===4){
    game.mode='resolving';
    game.trickWinnerSeat=getTrickWinner(game);
    game.turnDeadline=null;
  } else {
    game.currentTurnSeat=nextTurn(seat);
    game.turnDeadline=Date.now()+30000;
  }
  return {ok:true,card,complete:count===4,winnerSeat:game.trickWinnerSeat};
}
function scoreRound(room) {
  const game=room.game;
  const playerScores=game.captured.map(scoreCaptured);
  const allRedOwners=game.captured.map((c,i)=>hasAllRed(c)?i:null).filter(x=>x!==null);
  const grandOwners=game.captured.map((c,i)=>hasGrandSlam(c)?i:null).filter(x=>x!==null);
  const grandOwner=grandOwners.length?grandOwners[0]:null;
  const fullRedOwner=allRedOwners.length?allRedOwners[0]:null;
  const grand=grandOwner!==null;
  const fullRed=!grand && fullRedOwner!==null;
  const roundDelta=grand?3:fullRed?2:1;
  const teamA=game.teamA,teamB=game.teamB;
  const teamScoreA=teamA.reduce((sum,s)=>sum+playerScores[s].total,0);
  const teamScoreB=teamB.reduce((sum,s)=>sum+playerScores[s].total,0);
  let winningTeam,winReason;
  if(grand){ winningTeam=teamA.includes(grandOwner)?teamA:teamB; winReason='满贯特殊胜利'; }
  else if(fullRed){ winningTeam=teamA.includes(fullRedOwner)?teamA:teamB; winReason='全红特殊胜利'; }
  else { winningTeam=teamScoreA>teamScoreB?teamA:teamB; winReason='两队最终牌面分总和比较'; }
  const losingTeam=winningTeam===teamA?teamB:teamA;
  const changes=[0,0,0,0];
  const oneVsThree=teamA.length===1 || teamB.length===1;
  if(oneVsThree){
    const solo=teamA.length===1?teamA:teamB;
    const trio=solo===teamA?teamB:teamA;
    if(winningTeam===solo){changes[solo[0]]=roundDelta*3;trio.forEach(s=>changes[s]=-roundDelta);}
    else {changes[solo[0]]=-roundDelta*3;trio.forEach(s=>changes[s]=roundDelta);}
  } else {
    winningTeam.forEach(s=>changes[s]=roundDelta);
    losingTeam.forEach(s=>changes[s]=-roundDelta);
  }
  for(let seat=0;seat<4;seat++) room.players[seat].points += changes[seat];
  const targetWinners=room.players.map((p,s)=>p.points>=game.target?s:null).filter(s=>s!==null);
  game.result={
    specialType:grand?'满贯':fullRed?'全红':'普通对局', grand,fullRed,grandOwner,fullRedOwner,
    roundDelta,teamScoreA,teamScoreB,playerScores,changes,points:room.players.map(p=>p.points),
    teamA:teamA.slice(),teamB:teamB.slice(),pigOwner:game.pigOwner,sheepOwner:game.sheepOwner,
    winningTeam:winningTeam.slice(),losingTeam:losingTeam.slice(),winReason,oneVsThree,
    target:game.target,targetWinners
  };
  game.mode=targetWinners.length?'matchEnd':'settlement';
  game.turnDeadline=null;
  room.phase=game.mode;
  return game.result;
}
function resolveTrick(room) {
  const game=room.game;
  if(!game || game.mode!=='resolving') return null;
  const winner=game.trickWinnerSeat;
  const played=game.plays.filter(Boolean);
  game.captured[winner].push(...played);
  game.tricks[winner]++;
  if(game.trickCount>=13){
    scoreRound(room);
    return {roundOver:true,winnerSeat:winner};
  }
  game.trickCount++;
  game.leaderSeat=winner;
  game.currentTurnSeat=winner;
  game.leadSuit=null;
  game.plays=[null,null,null,null];
  game.trickWinnerSeat=null;
  game.mode='play';
  game.turnDeadline=Date.now()+30000;
  return {roundOver:false,winnerSeat:winner};
}
function serializeSnapshot(room, ownToken) {
  const seat=room.players.findIndex(p=>p && p.token===ownToken);
  if(seat<0) return null;
  const game=room.game;
  const playerList=room.players.map((p,s)=>p?({
    seat:s,name:p.name,avatar:p.avatar,connected:Boolean(p.connected),ready:Boolean(p.ready),points:p.points,
    handCount:game?game.hands[s].length:0,
    hand:(game && s===seat)?game.hands[s].map(c=>({...c})):[],
    captured:game?game.captured[s].map(c=>({...c})):[],tricks:game?game.tricks[s]:0
  }):null);
  const snap={roomCode:room.code,phase:room.phase,hostSeat:room.players.findIndex(p=>p&&p.token===room.hostToken),ownSeat:seat,
    seats:playerList,readyCount:room.players.filter(p=>p&&p.ready).length,occupiedCount:room.players.filter(Boolean).length,
    target:room.target,game:null};
  if(game){
    snap.game={roundNumber:game.roundNumber,mode:game.mode,leadSuit:game.leadSuit,leaderSeat:game.leaderSeat,
      currentTurnSeat:game.currentTurnSeat,trickCount:game.trickCount,trickWinnerSeat:game.trickWinnerSeat,
      plays:game.plays.map((card,s)=>card?({seat:s,card:{...card}}):null),turnDeadline:game.turnDeadline,
      result:game.result?JSON.parse(JSON.stringify(game.result)):null,
      teamInfo:(game.mode==='settlement'||game.mode==='matchEnd')?{pigOwner:game.pigOwner,sheepOwner:game.sheepOwner,teamA:game.teamA,teamB:game.teamB}:null};
  }
  return snap;
}
module.exports={makeDeck,shuffle,sortHand,cardScore,legalCards,scoreCaptured,hasAllRed,hasGrandSlam,startRound,validatePlay,playCard,resolveTrick,scoreRound,serializeSnapshot,cardId,RANK_VALUE,RED_COLLECTION_IDS};
