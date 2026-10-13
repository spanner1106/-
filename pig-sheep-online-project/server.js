'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const Game = require('./game');

const PORT = Number(process.env.PORT || 3000);
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: true, credentials: false }, pingInterval: 25000, pingTimeout: 20000 });
const rooms = new Map();
const tokenIndex = new Map(); // token -> {code, seat}
const reconnectTimers = new Map();
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECONNECT_GRACE_MS = 120000;
const TURN_TIMEOUT_MS = 30000;
const TRICK_REVEAL_MS = 1050;

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size, service: 'pig-sheep-online' }));
app.get('/api/status', (_req,res)=>res.json({ rooms: rooms.size, connectedPlayers: [...rooms.values()].reduce((n,r)=>n+r.players.filter(p=>p&&p.connected).length,0) }));

function cleanName(input) {
  const name = String(input || '').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,12);
  return name || '玩家';
}
function cleanChat(input) { return String(input || '').replace(/[\u0000-\u001f]/g,'').trim().slice(0,120); }
function makeRoomCode() {
  let code;
  do { code = Array.from({length:6},()=>ROOM_CODE_CHARS[Math.floor(Math.random()*ROOM_CODE_CHARS.length)]).join(''); } while(rooms.has(code));
  return code;
}
function notifyError(socket, message) { socket.emit('notice', { type:'error', message }); }
function clearReconnectTimer(token) {
  const t=reconnectTimers.get(token); if(t) clearTimeout(t); reconnectTimers.delete(token);
}
function getPlayerRoom(socket, payload = {}) {
  const code = String(payload.roomCode || socket.data.roomCode || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) return { error:'房间不存在或已关闭' };
  const token = socket.data.token || payload.token;
  const seat = room.players.findIndex(p=>p && p.token===token);
  if (seat < 0) return { error:'你不在这个房间，请重新加入' };
  return { room, seat, player:room.players[seat], token };
}
function enterSocket(socket, room, seat, token) {
  const player=room.players[seat];
  if (player.socketId && player.socketId!==socket.id) {
    const old=io.sockets.sockets.get(player.socketId);
    if(old) { old.emit('notice',{type:'info',message:'账号已在另一个连接恢复，本连接已切换。'}); old.leave(room.code); old.data.token=null; old.data.roomCode=null; }
  }
  clearReconnectTimer(token);
  player.socketId=socket.id; player.connected=true;
  if(!room.hostToken) room.hostToken=token;
  socket.data.token=token; socket.data.roomCode=room.code; socket.join(room.code);
  socket.emit('room:entered',{roomCode:room.code,token,seat,isHost:room.hostToken===token,phase:room.phase});
  broadcastRoom(room);
}
function roomSummary(room) {
  return { roomCode:room.code,phase:room.phase,hostSeat:room.players.findIndex(p=>p&&p.token===room.hostToken),
    occupiedCount:room.players.filter(Boolean).length,readyCount:room.players.filter(p=>p&&p.ready).length,
    target:room.target,players:room.players.map((p,seat)=>p?({seat,name:p.name,avatar:p.avatar,connected:!!p.connected,ready:!!p.ready,points:p.points}):null) };
}
function sendPrivateState(room) {
  for (const p of room.players) {
    if (!p || !p.socketId || !p.connected) continue;
    const socket=io.sockets.sockets.get(p.socketId);
    if (!socket) continue;
    const gameSnapshot=Game.serializeSnapshot(room,p.token);
    socket.emit('room:state',{room:roomSummary(room),game:gameSnapshot&&gameSnapshot.game?gameSnapshot:null});
  }
}
function broadcastRoom(room) {
  io.to(room.code).emit('room:summary', roomSummary(room));
  sendPrivateState(room);
}
function cancelRoomTimers(room) {
  if(room.turnTimer) clearTimeout(room.turnTimer);
  if(room.trickTimer) clearTimeout(room.trickTimer);
  room.turnTimer=null;room.trickTimer=null;
}
function armTurnTimer(room) {
  if(room.turnTimer) clearTimeout(room.turnTimer);
  if(!room.game || room.game.mode!=='play') return;
  const expectedSeat=room.game.currentTurnSeat;
  const current=room.players[room.game.currentTurnSeat];
  const timeoutMs=current && current.connected ? TURN_TIMEOUT_MS : 5000;
  room.game.turnDeadline=Date.now()+timeoutMs;
  room.turnTimer=setTimeout(()=>{
    if(!room.game || room.game.mode!=='play' || room.game.currentTurnSeat!==expectedSeat) return;
    const hand=room.game.hands[expectedSeat];
    const legal=Game.legalCards(hand,room.game.leadSuit);
    legal.sort((a,b)=>(Game.RANK_VALUE[a.rank]-Game.RANK_VALUE[b.rank]));
    const chosen=legal[0];
    if(!chosen) return;
    const result=Game.playCard(room,expectedSeat,chosen.id);
    if(!result.ok) return;
    if(result.complete) {
      broadcastRoom(room);
      room.trickTimer=setTimeout(()=>resolveTrick(room),TRICK_REVEAL_MS);
    } else {
      armTurnTimer(room);broadcastRoom(room);
    }
  },timeoutMs);
}
function startRound(room, roundNumber) {
  cancelRoomTimers(room);
  Game.startRound(room, roundNumber);
  for(const p of room.players) if(p) p.ready=true;
  armTurnTimer(room);
  broadcastRoom(room);
}
function resolveTrick(room) {
  if(!room.game || room.game.mode!=='resolving') return;
  const outcome=Game.resolveTrick(room);
  if(!outcome) return;
  if(outcome.roundOver) {
    broadcastRoom(room);
  } else {
    armTurnTimer(room);broadcastRoom(room);
  }
}
function findRoomByToken(token) {
  const ref=tokenIndex.get(token); if(!ref) return null;
  const room=rooms.get(ref.code); if(!room) { tokenIndex.delete(token);return null; }
  const p=room.players[ref.seat]; if(!p||p.token!==token) { tokenIndex.delete(token);return null; }
  return {room,seat:ref.seat,player:p};
}
function removeSeat(room, seat) {
  const p=room.players[seat]; if(!p) return;
  clearReconnectTimer(p.token);tokenIndex.delete(p.token);
  if(room.hostToken===p.token) {
    const replacement=room.players.find((other,i)=>i!==seat&&other&&other.connected);
    room.hostToken=replacement?replacement.token:null;
  }
  room.players[seat]=null;
  if(!room.players.some(Boolean)) { cancelRoomTimers(room);rooms.delete(room.code);return; }
  if(room.phase==='playing' && room.game) {
    // 正在牌局中不抽走座位：超时后服务器会自动打出合法牌，允许玩家稍后重连。
    room.players[seat]=p; tokenIndex.set(p.token,{code:room.code,seat});
    return;
  }
  if(room.phase==='lobby') room.phase='lobby';
  broadcastRoom(room);
}
function reconnectExpiry(token) {
  const found=findRoomByToken(token); if(!found) return;
  const {room,seat,player}=found;
  if(player.connected) return;
  if(room.phase==='playing') {
    // 不因掉线破坏牌局；结算后再清理长时间未回来的席位。
    player.expireAfterRound=true;
    return;
  }
  removeSeat(room,seat);
}

io.on('connection',socket=>{
  socket.emit('server:hello',{ok:true,version:'online-0.1'});

  socket.on('room:create',(data={})=>{
    const token=String(data.token||'');
    if(token.length<20||token.length>100) return notifyError(socket,'客户端会话标识无效，请刷新页面重试。');
    if(findRoomByToken(token)) return notifyError(socket,'该会话已在一个房间内，请先恢复或退出原房间。');
    const code=makeRoomCode();
    const room={code,hostToken:token,target:Math.max(1,Math.min(999,Math.floor(Number(data.target)||50))),phase:'lobby',players:[null,null,null,null],game:null,turnTimer:null,trickTimer:null,chat:[]};
    const p={token,socketId:socket.id,name:cleanName(data.name),avatar:['🦊','🐼','🐯','🐉'][0],connected:true,ready:false,points:0,expireAfterRound:false};
    room.players[0]=p;rooms.set(code,room);tokenIndex.set(token,{code,seat:0});
    enterSocket(socket,room,0,token);
    socket.emit('chat:history',room.chat);
  });

  socket.on('room:join',(data={})=>{
    const token=String(data.token||''), code=String(data.roomCode||'').trim().toUpperCase();
    if(token.length<20||token.length>100) return notifyError(socket,'客户端会话标识无效，请刷新页面重试。');
    const existing=findRoomByToken(token);
    if(existing) return notifyError(socket,'该会话已有房间记录，请使用“恢复上次房间”。');
    const room=rooms.get(code);
    if(!room) return notifyError(socket,'没有找到这个房间码，请检查后重试。');
    if(room.phase!=='lobby') return notifyError(socket,'牌局已经开始，本轮不允许新玩家中途加入。');
    const seat=room.players.findIndex(p=>!p);
    if(seat<0) return notifyError(socket,'房间已满，最多 4 名玩家。');
    const p={token,socketId:socket.id,name:cleanName(data.name),avatar:['🐼','🐯','🐉','🦊'][seat],connected:true,ready:false,points:0,expireAfterRound:false};
    room.players[seat]=p;tokenIndex.set(token,{code,seat});
    enterSocket(socket,room,seat,token);socket.emit('chat:history',room.chat);
  });

  socket.on('room:resume',(data={})=>{
    const token=String(data.token||'');
    const found=findRoomByToken(token);
    if(!found) return notifyError(socket,'没有找到可恢复的房间。请创建或加入房间。');
    const {room,seat}=found;
    enterSocket(socket,room,seat,token);socket.emit('chat:history',room.chat);
  });

  socket.on('room:ready',data=>{
    const found=getPlayerRoom(socket,data||{});if(found.error)return notifyError(socket,found.error);
    const {room,player}=found;
    if(room.phase!=='lobby') return notifyError(socket,'牌局开始后不能更改准备状态。');
    player.ready=!player.ready;broadcastRoom(room);
  });

  socket.on('game:start',data=>{
    const found=getPlayerRoom(socket,data||{});if(found.error)return notifyError(socket,found.error);
    const {room,token}=found;
    if(token!==room.hostToken) return notifyError(socket,'只有房主可以开始游戏。');
    if(room.phase!=='lobby') return notifyError(socket,'房间已经开始游戏。');
    if(room.players.some(p=>!p||!p.connected)) return notifyError(socket,'需要 4 名玩家全部进入房间。');
    if(room.players.some(p=>!p.ready)) return notifyError(socket,'请等待所有玩家准备完成。');
    startRound(room,1);
  });

  socket.on('game:playCard',(data={})=>{
    const found=getPlayerRoom(socket,data);if(found.error)return notifyError(socket,found.error);
    const {room,seat}=found;
    if(room.phase!=='playing'||!room.game) return notifyError(socket,'当前没有进行中的牌局。');
    const result=Game.playCard(room,seat,String(data.cardId||''));
    if(!result.ok) return notifyError(socket,result.reason);
    if(result.complete){if(room.turnTimer)clearTimeout(room.turnTimer);room.turnTimer=null;broadcastRoom(room);room.trickTimer=setTimeout(()=>resolveTrick(room),TRICK_REVEAL_MS);}
    else {armTurnTimer(room);broadcastRoom(room);}
  });

  socket.on('game:nextRound',data=>{
    const found=getPlayerRoom(socket,data);if(found.error)return notifyError(socket,found.error);
    const {room,token}=found;
    const currentHost=room.players.find(p=>p&&p.token===room.hostToken);
    if(token!==room.hostToken && currentHost && currentHost.connected) return notifyError(socket,'只有房主可以开始下一局。');
    if(token!==room.hostToken && (!currentHost || !currentHost.connected)) room.hostToken=token;
    if(room.phase!=='settlement'&&room.phase!=='matchEnd') return notifyError(socket,'当前不能开始下一局。');
    let next=room.game.roundNumber+1;
    if(room.phase==='matchEnd') { for(const p of room.players)if(p)p.points=0;next=1; }
    for(const p of room.players) if(p) p.expireAfterRound=false;
    startRound(room,next);
  });

  socket.on('chat:send',(data={})=>{
    const found=getPlayerRoom(socket,data);if(found.error)return notifyError(socket,found.error);
    const {room,player,seat}=found;const text=cleanChat(data.text);
    if(!text)return;
    const msg={id:randomUUID(),seat,name:player.name,text,at:Date.now()};
    room.chat.push(msg);if(room.chat.length>60)room.chat.shift();io.to(room.code).emit('chat:message',msg);
  });

  socket.on('room:leave',(data={})=>{
    const found=getPlayerRoom(socket,data);if(found.error)return notifyError(socket,found.error);
    const {room,seat,player}=found;
    socket.leave(room.code);socket.data.roomCode=null;socket.data.token=null;
    if(room.phase==='playing') {
      player.connected=false;player.socketId=null;player.expireAfterRound=true;
      if(room.hostToken===player.token){const nextHost=room.players.find(q=>q&&q.connected&&q.token!==player.token);if(nextHost)room.hostToken=nextHost.token;}
      if(room.game && room.game.mode==='play' && room.game.currentTurnSeat===seat) armTurnTimer(room);
      broadcastRoom(room);socket.emit('room:left',{reserved:true,roomCode:room.code,message:'当前局的座位已保留；你可回到页面后选择“恢复上次房间”。'});return;
    }
    removeSeat(room,seat);socket.emit('room:left',{});
  });

  socket.on('disconnect',()=>{
    const token=socket.data.token;
    if(!token)return;
    const found=findRoomByToken(token);if(!found)return;
    const {room,seat,player}=found;
    if(player.socketId===socket.id) {player.connected=false;player.socketId=null;}
    if(room.hostToken===token){const nextHost=room.players.find(q=>q&&q.connected&&q.token!==token);if(nextHost)room.hostToken=nextHost.token;}
    if(room.game && room.game.mode==='play' && room.game.currentTurnSeat===seat) armTurnTimer(room);
    broadcastRoom(room);
    clearReconnectTimer(token);
    const timer=setTimeout(()=>reconnectExpiry(token),RECONNECT_GRACE_MS);
    reconnectTimers.set(token,timer);
  });
});

httpServer.listen(PORT,'0.0.0.0',()=>console.log(`猪羊弟联机服务器已启动，端口 ${PORT}`));
