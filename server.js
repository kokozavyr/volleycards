const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
 
const PORT = process.env.PORT || 3000;
 
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
 
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
 
// ── GAME STATE ──────────────────────────────────────────
const rooms = {};
 
function makeCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}
 
const CT = { Zone:'Zone', PowerSpike:'PowerSpike', Tip:'Tip', Block:'Block', Libero:'Libero', Ace:'Ace' };
let _uid = 0;
function mkCard(type, zone=0) { return { type, zone, id: ++_uid }; }
function makeDeck() {
  const d = [];
  for (let z = 1; z <= 9; z++) { d.push(mkCard(CT.Zone,z)); d.push(mkCard(CT.Zone,z)); }
  for (let i = 0; i < 3; i++) d.push(mkCard(CT.PowerSpike));
  for (let i = 0; i < 2; i++) d.push(mkCard(CT.Tip));
  for (let i = 0; i < 4; i++) d.push(mkCard(CT.Block));
  for (let i = 0; i < 2; i++) d.push(mkCard(CT.Libero));
  d.push(mkCard(CT.Ace));
  return shuffle(d);
}
function shuffle(arr) {
  for (let i = arr.length-1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
 
const AT = { Zone:'Zone', PowerSpike:'PowerSpike', Tip:'Tip', Ace:'Ace' };
const TS = { Serve:'Serve', Attack:'Attack', Defense:'Defense', Cover:'Cover' };
const CORR = [[1,7,2],[6,8,3],[5,9,4]];
const CORR_SETS = CORR.map(r => new Set(r));
 
function sameCorridor(a,b){ return CORR_SETS.some(s=>s.has(a)&&s.has(b)); }
function isAdjacent(a,b){
  for(const r of CORR){ const ia=r.indexOf(a),ib=r.indexOf(b); if(ia!==-1&&ib!==-1&&Math.abs(ia-ib)===1)return true; }
  return false;
}
 
function initGameState(firstServerIsP1) {
  const p1Deck = makeDeck();
  const p2Deck = makeDeck();
  return {
    p1Score: 0, p2Score: 0,
    p1Sets: 0, p2Sets: 0,
    setNum: 1, firstSetP1: firstServerIsP1,
    p1Serving: firstServerIsP1,
    p1Hand: p1Deck.slice(0,6),
    p2Hand: p2Deck.slice(0,6),
    turnState: TS.Serve,
    atkType: null, atkZone: 0,
    isServePhase: true,
    selected: [],
    attPlayer: firstServerIsP1 ? 1 : 2,
    defPlayer: firstServerIsP1 ? 2 : 1,
    log: [],
    matchOver: false,
  };
}
 
function dealHands(state) {
  state.p1Hand = makeDeck().slice(0,6);
  state.p2Hand = makeDeck().slice(0,6);
}
 
function getHand(state, player) {
  return player === 1 ? state.p1Hand : state.p2Hand;
}
function removeCard(hand, cardId) {
  const i = hand.findIndex(c=>c.id===cardId);
  if(i!==-1) hand.splice(i,1);
}
function removeCards(hand, cardIds) { cardIds.forEach(id=>removeCard(hand,id)); }
 
function addLog(state, icon, player, text) {
  state.log.push({ icon, player, text });
  if(state.log.length > 30) state.log.shift();
}
 
function buildPayload(state, playerNum) {
  const myHand = playerNum === 1 ? state.p1Hand : state.p2Hand;
  const oppHandCount = playerNum === 1 ? state.p2Hand.length : state.p1Hand.length;
  const isMyTurn = (
    (state.turnState !== TS.Defense && state.attPlayer === playerNum) ||
    (state.turnState === TS.Defense && state.defPlayer === playerNum)
  );
  return {
    type: 'STATE',
    myHand,
    oppHandCount,
    p1Score: state.p1Score, p2Score: state.p2Score,
    p1Sets: state.p1Sets, p2Sets: state.p2Sets,
    turnState: state.turnState,
    atkType: state.atkType, atkZone: state.atkZone,
    isServePhase: state.isServePhase,
    attPlayer: state.attPlayer, defPlayer: state.defPlayer,
    isMyTurn,
    myPlayerNum: playerNum,
    log: state.log,
    matchOver: state.matchOver,
    winner: state.winner || null,
    p1Serving: state.p1Serving,
  };
}
 
function broadcast(room, state) {
  const [p1ws, p2ws] = room.players;
  if(p1ws && p1ws.readyState === WebSocket.OPEN)
    p1ws.send(JSON.stringify(buildPayload(state, 1)));
  if(p2ws && p2ws.readyState === WebSocket.OPEN)
    p2ws.send(JSON.stringify(buildPayload(state, 2)));
}
 
function processPlay(room, playerNum, cardIds) {
  const state = room.state;
  if(state.matchOver) return;
 
  const myHand = getHand(state, playerNum);
  const cards = cardIds.map(id => myHand.find(c=>c.id===id)).filter(Boolean);
  if(cards.length === 0) return;
 
  const ts = state.turnState;
  const at = state.atkType;
 
  if(ts !== TS.Defense && state.attPlayer !== playerNum) return;
  if(ts === TS.Defense && state.defPlayer !== playerNum) return;
 
  if(ts === TS.Serve) {
    const c = cards[0];
    if(c.type !== CT.Zone && c.type !== CT.Ace) return;
    removeCard(myHand, c.id);
    if(c.type === CT.Ace){
      state.atkType = AT.Ace;
      addLog(state,'🚀','p'+playerNum,'Player '+playerNum+' served Ace');
    } else {
      state.atkType = AT.Zone; state.atkZone = c.zone;
      addLog(state,'🏐','p'+playerNum,'Player '+playerNum+' served Zone '+c.zone);
    }
    state.turnState = TS.Defense;
    state.isServePhase = true;
    broadcast(room, state);
    return;
  }
 
  if(ts === TS.Attack) {
    const tip = cards.find(c=>c.type===CT.Tip);
    const zone = cards.find(c=>c.type===CT.Zone);
    const spike = cards.find(c=>c.type===CT.PowerSpike);
 
    if(spike && cards.length===1){
      removeCard(myHand, spike.id);
      state.atkType = AT.PowerSpike;
      addLog(state,'💥','p'+playerNum,'Player '+playerNum+' Power Spike!');
      state.turnState = TS.Defense; state.isServePhase = false;
      broadcast(room, state); return;
    }
    if(zone && !tip && cards.length===1){
      removeCard(myHand, zone.id);
      state.atkType = AT.Zone; state.atkZone = zone.zone;
      addLog(state,'🏐','p'+playerNum,'Player '+playerNum+' attacked Zone '+zone.zone);
      state.turnState = TS.Defense; state.isServePhase = false;
      broadcast(room, state); return;
    }
    if(tip && zone && cards.length===2){
      removeCards(myHand, [tip.id, zone.id]);
      state.atkType = AT.Tip; state.atkZone = zone.zone;
      addLog(state,'🤫','p'+playerNum,'Player '+playerNum+' Tip → Zone '+zone.zone);
      state.turnState = TS.Defense; state.isServePhase = false;
      broadcast(room, state); return;
    }
    return;
  }
 
  if(ts === TS.Defense) {
    const defHand = getHand(state, playerNum);
    const bc = cards.filter(c=>c.type===CT.Block).length;
    const zc = cards.filter(c=>c.type===CT.Zone).length;
    const lib = cards.some(c=>c.type===CT.Libero);
 
    if(at === AT.PowerSpike){
      if(lib && cards.length===1){ doSwap(state, defHand, cards, playerNum, 'Libero defense'); return broadcast(room,state); }
      if(bc===1&&zc===1){ removeCards(defHand,cards.map(c=>c.id)); addLog(state,'🛡️','p'+playerNum,'Block+Zone — ball returns'); state.turnState=TS.Attack; broadcast(room,state); return; }
      if(bc>=2&&zc===0){
        removeCards(defHand,cards.map(c=>c.id));
        if(bc>=3){ addLog(state,'🏆','p'+playerNum,'Triple Block — point!'); awardPoint(room, state.defPlayer); return; }
        addLog(state,'🛡️','p'+playerNum,'Double Block — cover needed'); state.turnState=TS.Cover; broadcast(room,state); return;
      }
      return;
    }
    if(at === AT.Zone){
      if(lib && cards.length===1){ doSwap(state, defHand, cards, playerNum, 'Libero defense'); return broadcast(room,state); }
      if(zc===1&&bc===0&&sameCorridor(cards[0].zone,state.atkZone)){ doSwap(state, defHand, cards, playerNum, 'received in corridor'); return broadcast(room,state); }
      if(bc>=1&&zc===0){
        removeCards(defHand,cards.map(c=>c.id));
        if(bc>=3){ addLog(state,'🏆','p'+playerNum,'Triple Block — point!'); awardPoint(room, state.defPlayer); return; }
        if(bc===2){ addLog(state,'🛡️','p'+playerNum,'Double Block — cover needed'); state.turnState=TS.Cover; broadcast(room,state); return; }
        addLog(state,'🛡️','p'+playerNum,'Single Block — ball returns'); state.turnState=TS.Attack; broadcast(room,state); return;
      }
      return;
    }
    if(at === AT.Tip){
      if(lib && cards.length===1){ doSwap(state, defHand, cards, playerNum, 'Libero defense'); return broadcast(room,state); }
      if(zc===1&&bc===0&&(cards[0].zone===state.atkZone||isAdjacent(cards[0].zone,state.atkZone))){ doSwap(state, defHand, cards, playerNum, 'defended Tip'); return broadcast(room,state); }
      return;
    }
    if(at === AT.Ace){
      if(lib && cards.length===1){ doSwap(state, defHand, cards, playerNum, 'received Ace'); return broadcast(room,state); }
      addLog(state,'🚀','p'+(state.attPlayer),'Ace — point!');
      awardPoint(room, state.attPlayer); return;
    }
    return;
  }
 
  if(ts === TS.Cover){
    const c = cards[0];
    let ok = false;
    if(at===AT.PowerSpike&&(c.type===CT.Zone||c.type===CT.Libero)) ok=true;
    if(at===AT.Zone&&((c.type===CT.Zone&&sameCorridor(c.zone,state.atkZone))||c.type===CT.Libero)) ok=true;
    if(!ok) return;
    removeCard(myHand, c.id);
    addLog(state,'✅','p'+playerNum,'Player '+playerNum+' covered');
    state.turnState = TS.Attack;
    broadcast(room, state); return;
  }
}
 
function doSwap(state, defHand, cards, playerNum, desc) {
  removeCards(defHand, cards.map(c=>c.id));
  addLog(state,'✅','p'+playerNum,'Player '+playerNum+' — '+desc);
  state.isServePhase = false;
  [state.attPlayer, state.defPlayer] = [state.defPlayer, state.attPlayer];
  state.turnState = TS.Attack;
}
 
function awardPoint(room, scorerPlayerNum) {
  const state = room.state;
  if(scorerPlayerNum === 1){ state.p1Score++; state.p1Serving=true; }
  else { state.p2Score++; state.p1Serving=false; }
  addLog(state,'🎉','point','Player '+scorerPlayerNum+' wins the point!');
 
  const POINTS_WIN=2, MAX_PTS=25, SETS_WIN=2;
  function winsSet(ps,os){ return ps>=POINTS_WIN&&(ps>=MAX_PTS||ps-os>=2); }
 
  if(winsSet(state.p1Score,state.p2Score)){
    state.p1Sets++;
    addLog(state,'🏆','point','Player 1 wins the set!');
    if(state.p1Sets>=SETS_WIN){
      state.matchOver=true; state.winner=1;
      addLog(state,'🏆','point','Player 1 wins the match!');
      broadcast(room, state); return;
    }
    state.setNum++; state.p1Score=0; state.p2Score=0;
    state.p1Serving=!state.firstSetP1;
    dealHands(state); startRally(state); broadcast(room,state); return;
  }
  if(winsSet(state.p2Score,state.p1Score)){
    state.p2Sets++;
    addLog(state,'🏆','point','Player 2 wins the set!');
    if(state.p2Sets>=SETS_WIN){
      state.matchOver=true; state.winner=2;
      addLog(state,'🏆','point','Player 2 wins the match!');
      broadcast(room, state); return;
    }
    state.setNum++; state.p1Score=0; state.p2Score=0;
    state.p1Serving=state.firstSetP1;
    dealHands(state); startRally(state); broadcast(room,state); return;
  }
 
  dealHands(state); startRally(state); broadcast(room,state);
}
 
function startRally(state) {
  state.attPlayer = state.p1Serving ? 1 : 2;
  state.defPlayer = state.p1Serving ? 2 : 1;
  state.isServePhase = true;
  state.atkType = null; state.atkZone = 0;
  state.turnState = TS.Serve;
  state.selected = [];
}
 
function handleTimeout(room, playerNum) {
  const state = room.state;
  if(state.matchOver) return;
  const activePlayer = state.turnState===TS.Defense ? state.defPlayer : state.attPlayer;
  if(activePlayer !== playerNum) return;
  const winner = playerNum === state.attPlayer ? state.defPlayer : state.attPlayer;
  addLog(state,'⏰','point','Player '+playerNum+' timed out');
  awardPoint(room, winner);
}
 
function scheduleTimeout(room) {
  if(!room.state||room.state.matchOver) return;
  const activePlayer = room.state.turnState===TS.Defense ? room.state.defPlayer : room.state.attPlayer;
  Object.values(room.timers).forEach(t=>clearTimeout(t));
  room.timers = {};
  room.timers[activePlayer] = setTimeout(()=>{
    handleTimeout(room, activePlayer);
  }, 13000);
}
 
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e){ return; }
 
    if(msg.type === 'CREATE') {
      let code;
      do { code = makeCode(); } while(rooms[code]);
      const firstP1 = Math.random() > 0.5;
      rooms[code] = { players: [ws, null], state: null, timers: {}, firstP1 };
      ws.roomCode = code;
      ws.playerNum = 1;
      ws.send(JSON.stringify({ type:'CREATED', code }));
      return;
    }
 
    if(msg.type === 'JOIN') {
      const code = (msg.code||'').toUpperCase().trim();
      const room = rooms[code];
      if(!room){ ws.send(JSON.stringify({type:'ERROR',msg:'Room not found'})); return; }
      if(room.players[1]){ ws.send(JSON.stringify({type:'ERROR',msg:'Room is full'})); return; }
      room.players[1] = ws;
      ws.roomCode = code;
      ws.playerNum = 2;
      room.state = initGameState(room.firstP1);
      room.players[0].send(JSON.stringify({type:'JOINED', opponentReady:true}));
      broadcast(room, room.state);
      scheduleTimeout(room);
      return;
    }
 
    if(msg.type === 'PLAY') {
      const room = rooms[ws.roomCode];
      if(!room||!room.state) return;
      if(room.timers[ws.playerNum]){
        clearTimeout(room.timers[ws.playerNum]);
        delete room.timers[ws.playerNum];
      }
      processPlay(room, ws.playerNum, msg.cardIds);
      scheduleTimeout(room);
      return;
    }
 
    if(msg.type === 'TIMEOUT') {
      const room = rooms[ws.roomCode];
      if(!room||!room.state) return;
      handleTimeout(room, ws.playerNum);
      return;
    }
 
    if(msg.type === 'REMATCH') {
      const room = rooms[ws.roomCode];
      if(!room) return;
      room.state = initGameState(Math.random()>0.5);
      broadcast(room, room.state);
      scheduleTimeout(room);
      return;
    }
  });
 
  ws.on('close', () => {
    const room = rooms[ws.roomCode];
    if(!room) return;
    Object.values(room.timers).forEach(t=>clearTimeout(t));
    const other = room.players.find(p=>p&&p!==ws);
    if(other&&other.readyState===WebSocket.OPEN)
      other.send(JSON.stringify({type:'OPPONENT_LEFT'}));
    delete rooms[ws.roomCode];
  });
});
 
server.listen(PORT, () => console.log(`VolleyCards server running on port ${PORT}`));
