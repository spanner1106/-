'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const G=require('../game');
function roomSeed(){return {target:50,phase:'playing',players:[0,1,2,3].map(seat=>({seat,token:`token-${seat}-abcdefghijklmnop`,name:`P${seat}`,points:0})),game:null};}

test('server-authoritative round state hides other hands in individualized snapshot',()=>{
 const room=roomSeed();G.startRound(room,1);const snap=G.serializeSnapshot(room,room.players[2].token);
 assert.equal(snap.ownSeat,2);assert.equal(snap.seats[2].hand.length,13);assert.equal(snap.seats[0].hand.length,0);assert.equal(snap.seats[0].handCount,13);
 assert.equal(snap.game.teamInfo,null);
});

test('round settlement reveals fixed initial team and independently applies points',()=>{
 const room=roomSeed();
 let n=17;const rng=()=>{n=(n*48271)%2147483647;return (n-1)/2147483646;};
 const original=Math.random; Math.random=rng;
 try {
   G.startRound(room,1);const g=room.game;const expectedTeamA=g.teamA.slice();let guard=0;
   while(g.mode==='play'||g.mode==='resolving'){
     assert.ok(++guard<70);
     if(g.mode==='resolving'){G.resolveTrick(room);continue;}
     const seat=g.currentTurnSeat;const legal=G.legalCards(g.hands[seat],g.leadSuit);const result=G.playCard(room,seat,legal[0].id);assert.equal(result.ok,true);if(result.complete)G.resolveTrick(room);
   }
   const result=g.result;
   assert.ok(result);assert.equal(result.changes.reduce((a,b)=>a+b,0),0);
   assert.ok([1,2,3].includes(result.winningTeam.length));
   assert.deepEqual(new Set(result.teamA),new Set(expectedTeamA));
   const snap=G.serializeSnapshot(room,room.players[0].token);assert.ok(snap.game.teamInfo);assert.equal(snap.game.result.specialType,result.specialType);
 } finally { Math.random=original; }
});
