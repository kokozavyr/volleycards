const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
 
const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
 
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
 
const rooms = {};
 
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? makeCode() : code;
}
 
// ── DECK ────────────────────────────────────────────────
const CT = { Zone:'Zone', PowerSpike:'PowerSpike', Tip:'Tip', Block:'Block', Libero:'Libero', Ace:'Ace' };
let _uid = 0;
function mkCard(type, zone=0) { return { type, zone, id: ++_uid }; }
function makeDeck() {
  const d = [];
  for (let z=1;z<=9;z++) { d.push(mkCard(CT.Zone,z)); d.push(mkCard(CT.Zone,z)); }
  for (let i=0;i<3;i++) d.push(mkCard(CT.PowerSpike));
  for (let i=0;i<2;i++) d.push(mkCard(CT.Tip));
  for (let i=0;i<4;i++) d.push(mkCard(CT.Block));
  for (let i=0;i<2;i++) d.push(mkCard(CT.Libero));
  d.push(mkCard(CT.Ace));
  return shuffle(d);
}
function shuffle(a) {
  for (let i=a.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
 
// ── GAME CONSTANTS ──────────────────────────────────────
const AT = { Zone:'Zone', PowerSpike:'PowerSpike', Tip:'Tip', Ace:'Ace' };
const TS = { Serve:'Serve', Attack:'Attack', Defense:'Defense', Cover:'Cover' };
const CORR = [[1,7,2],[6,8,3],[5,9,4]];
const CORR_SETS = CORR.map(r => new Set(r));
const POINTS_WIN=2, MAX_PTS=25, SETS_WIN=2;
 
function sameCorridor(a,b){ return CORR_SETS.some(s=>s.has(a)&&s.has(b)); }
function isAdjacent(a,b){
  for(const r of CORR){const ia=r.indexOf(a),ib=r.indexOf(b);if(ia!==-1&&ib!==-1&&Math.abs(ia-ib)===1)return true;}
  return false;
}
function winsSet(ps,os){ return ps>=POINTS_WIN&&(ps>=MAX_PTS||ps-os>=2); }
 
// ── STATE ───────────────────────────────────────────────
function initGameState(firstP1, p1name, p2name) {
  return {
    p1Score:0, p2Score:0, p1Sets:0, p2Sets:0,
    setNum:1, firstSetP1:firstP1, p1Serving:firstP1,
    p1Hand:[], p2Hand:[],
    turnState:TS.Serve,
    atkType:null, atkZone:0, isServePhase:true,
    attPlayer:firstP1?1:2, defPlayer:firstP1?2:1,
    p1name: p1name||'Player 1', p2name: p2name||'Player 2',
    log:[], matchOver:false, winner:null,
    paused:false, pointScorer:null,
    lastAction:'serve', ballSide:firstP1?1:2,
    ballZone:0,         // targeted zone (0 = no specific zone)
    pointHow:'',        // human-readable how point was scored
  };
}
 
function dealHands(state) {
  state.p1Hand = makeDeck().slice(0,6);
  state.p2Hand = makeDeck().slice(0,6);
}
 
function getHand(state, player) { return player===1 ? state.p1Hand : state.p2Hand; }
function removeCard(hand, id) { const i=hand.findIndex(c=>c.id===id); if(i!==-1)hand.splice(i,1); }
function removeCards(hand, ids) { ids.forEach(id=>removeCard(hand,id)); }
 
function playerName(state, num) { return num===1 ? state.p1name : state.p2name; }
 
function addLog(state, icon, player, text) {
  state.log.push({icon, player, text});
  if(state.log.length>30) state.log.shift();
}
 
// ── MESSAGE HELPERS (perspective-aware) ─────────────────
// actorNum = who did the action, viewerNum = who is receiving this payload
function perspMsg(actorNum, viewerNum, youText, theyText) {
  return actorNum===viewerNum ? youText : theyText;
}
 
// ── PAYLOAD ─────────────────────────────────────────────
function buildPayload(state, playerNum) {
  const myHand = playerNum===1 ? state.p1Hand : state.p2Hand;
  const oppHandCount = playerNum===1 ? state.p2Hand.length : state.p1Hand.length;
  const paused = state.paused||false;
  const isMyTurn = !paused && (
    (state.turnState!==TS.Defense && state.attPlayer===playerNum) ||
    (state.turnState===TS.Defense && state.defPlayer===playerNum)
  );
  const myName   = playerNum===1 ? state.p1name : state.p2name;
  const oppName  = playerNum===1 ? state.p2name : state.p1name;
  return {
    type:'STATE',
    myHand, oppHandCount,
    p1Score:state.p1Score, p2Score:state.p2Score,
    p1Sets:state.p1Sets, p2Sets:state.p2Sets,
    p1name:state.p1name, p2name:state.p2name,
    myName, oppName,
    turnState:state.turnState,
    atkType:state.atkType, atkZone:state.atkZone,
    isServePhase:state.isServePhase,
    attPlayer:state.attPlayer, defPlayer:state.defPlayer,
    attName: state.attPlayer===playerNum ? 'You' : (state.attPlayer===1?state.p1name:state.p2name),
    defName: state.defPlayer===playerNum ? 'You' : (state.defPlayer===1?state.p1name:state.p2name),
    isMyTurn, myPlayerNum:playerNum,
    log:state.log, matchOver:state.matchOver,
    winner:state.winner||null,
    winnerName:state.winner ? playerName(state,state.winner) : null,
    p1Serving:state.p1Serving,
    paused, pointScorer:state.pointScorer||null,
    pointScorerName:state.pointScorer ? playerName(state,state.pointScorer) : null,
    lastAction:state.lastAction||null,
    ballSide:state.ballSide||null,
    ballZone:state.ballZone||0,
    pointHow:state.pointHow||'',
  };
}
 
function broadcast(room, state) {
  const [p1ws, p2ws] = room.players;
  if(p1ws&&p1ws.readyState===WebSocket.OPEN) p1ws.send(JSON.stringify(buildPayload(state,1)));
  if(p2ws&&p2ws.readyState===WebSocket.OPEN) p2ws.send(JSON.stringify(buildPayload(state,2)));
}
 
// ── GAME ACTIONS ────────────────────────────────────────
function doSwap(state, defHand, cards, playerNum, desc) {
  removeCards(defHand, cards.map(c=>c.id));
  addLog(state,'✅','p'+playerNum, playerName(state,playerNum)+' — '+desc);
  state.isServePhase = false;
  [state.attPlayer, state.defPlayer] = [state.defPlayer, state.attPlayer];
  state.turnState = TS.Attack;
  state.lastAction = 'defend';
  state.ballSide = state.attPlayer;
  state.atkZone = 0;
}
 
function awardPoint(room, scorerNum, how) {
  const state = room.state;
  Object.values(room.timers).forEach(t=>clearTimeout(t));
  room.timers = {};
  if(scorerNum===1){ state.p1Score++; state.p1Serving=true; }
  else{ state.p2Score++; state.p1Serving=false; }
  state.pointHow = how || '';
  addLog(state,'🎉','point', playerName(state,scorerNum)+' wins the point!'+(how?' ('+how+')':''));
  state.lastAction='point'; state.pointScorer=scorerNum; state.paused=true;
 
  if(winsSet(state.p1Score,state.p2Score)){
    state.p1Sets++;
    addLog(state,'🏆','point', state.p1name+' wins the set!');
    if(state.p1Sets>=SETS_WIN){
      state.matchOver=true; state.winner=1; state.paused=false;
      addLog(state,'🏆','point', state.p1name+' wins the match!');
      broadcast(room,state); return;
    }
    broadcast(room,state);
    setTimeout(()=>{ nextSet(room,!state.firstSetP1); },3500); return;
  }
  if(winsSet(state.p2Score,state.p1Score)){
    state.p2Sets++;
    addLog(state,'🏆','point', state.p2name+' wins the set!');
    if(state.p2Sets>=SETS_WIN){
      state.matchOver=true; state.winner=2; state.paused=false;
      addLog(state,'🏆','point', state.p2name+' wins the match!');
      broadcast(room,state); return;
    }
    broadcast(room,state);
    setTimeout(()=>{ nextSet(room,state.firstSetP1); },3500); return;
  }
  broadcast(room,state);
  setTimeout(()=>{ nextRally(room); },3000);
}
 
function nextSet(room, p1serves) {
  const s = room.state;
  s.setNum++; s.p1Score=0; s.p2Score=0;
  s.p1Serving=p1serves; s.paused=false; s.pointScorer=null;
  dealHands(s); startRally(s); broadcast(room,s);
  scheduleTimeout(room); checkNoPlayable(room);
}
 
function nextRally(room) {
  const s = room.state;
  s.paused=false; s.pointScorer=null;
  dealHands(s); startRally(s); broadcast(room,s);
  scheduleTimeout(room); checkNoPlayable(room);
}
 
function startRally(state) {
  state.attPlayer = state.p1Serving?1:2;
  state.defPlayer = state.p1Serving?2:1;
  state.isServePhase=true; state.atkType=null; state.atkZone=0;
  state.turnState=TS.Serve; state.selected=[];
  state.lastAction='serve'; state.ballSide=state.attPlayer;
}
 
function checkNoPlayable(room) {
  const state = room.state;
  if(!state||state.matchOver||state.paused) return;
  const active = state.turnState===TS.Defense ? state.defPlayer : state.attPlayer;
  const hand = getHand(state,active);
  const at=state.atkType, az=state.atkZone, sp=state.isServePhase, ts=state.turnState;
  const hasPlay = hand.some(card=>{
    if(ts===TS.Serve) return card.type==='Zone'||card.type==='Ace';
    if(ts===TS.Attack){ if(card.type==='PowerSpike'||card.type==='Zone')return true; if(card.type==='Tip')return hand.some(c=>c.type==='Zone'); return false; }
    if(ts===TS.Defense){
      if(['Ace','PowerSpike','Tip'].includes(card.type))return false;
      if(sp){if(at==='Zone')return(card.type==='Zone'&&sameCorridor(card.zone,az))||card.type==='Libero';if(at==='Ace')return card.type==='Libero';return false;}
      if(at==='Tip'){if(card.type==='Block')return false;if(card.type==='Zone'&&(card.zone===az||isAdjacent(card.zone,az)))return true;return card.type==='Libero';}
      if(at==='Zone')return card.type==='Block'||(card.type==='Zone'&&sameCorridor(card.zone,az))||card.type==='Libero';
      if(at==='PowerSpike')return card.type==='Block'||card.type==='Libero';
    }
    if(ts===TS.Cover){if(at==='PowerSpike')return card.type==='Zone'||card.type==='Libero';if(at==='Zone')return(card.type==='Zone'&&sameCorridor(card.zone,az))||card.type==='Libero';return false;}
    return false;
  });
  if(!hasPlay){
    const winner = active===1?2:1;
    addLog(state,'⚠️','point', playerName(state,active)+' has no valid cards');
    awardPoint(room,winner,'No valid cards for '+playerName(state,active));
  }
}
 
function handleTimeout(room, playerNum) {
  const state=room.state;
  if(!state||state.matchOver||state.paused) return;
  const active=state.turnState===TS.Defense?state.defPlayer:state.attPlayer;
  if(active!==playerNum) return;
  const winner=playerNum===state.attPlayer?state.defPlayer:state.attPlayer;
  addLog(state,'⏰','point', playerName(state,playerNum)+' ran out of time');
  awardPoint(room,winner,playerName(state,playerNum)+' ran out of time');
}
 
function scheduleTimeout(room) {
  if(!room.state||room.state.matchOver||room.state.paused) return;
  const active=room.state.turnState===TS.Defense?room.state.defPlayer:room.state.attPlayer;
  Object.values(room.timers).forEach(t=>clearTimeout(t));
  room.timers={};
  room.timers[active]=setTimeout(()=>handleTimeout(room,active), 13000);
}
 
// ── PLAY PROCESSOR ──────────────────────────────────────
function processPlay(room, playerNum, cardIds) {
  const state=room.state;
  if(!state||state.matchOver||state.paused) return;
  const myHand=getHand(state,playerNum);
  const cards=cardIds.map(id=>myHand.find(c=>c.id===id)).filter(Boolean);
  if(!cards.length) return;
  const ts=state.turnState, at=state.atkType;
  if(ts!==TS.Defense&&state.attPlayer!==playerNum) return;
  if(ts===TS.Defense&&state.defPlayer!==playerNum) return;
 
  const me = playerName(state,playerNum);
 
  if(ts===TS.Serve){
    const c=cards[0];
    if(c.type!==CT.Zone&&c.type!==CT.Ace) return;
    removeCard(myHand,c.id);
    if(c.type===CT.Ace){
      state.atkType=AT.Ace;
      addLog(state,'🚀','p'+playerNum, me+' served an Ace!');
    } else {
      state.atkType=AT.Zone; state.atkZone=c.zone;
      addLog(state,'🏐','p'+playerNum, me+' served to Zone '+c.zone);
    }
    state.turnState=TS.Defense; state.isServePhase=true;
    state.lastAction='serve';
    state.ballSide = state.defPlayer;  // ball is now on defender's side
    state.ballZone = (state.atkType===AT.Ace) ? 0 : state.atkZone;
    broadcast(room,state); checkNoPlayable(room); return;
  }
 
  if(ts===TS.Attack){
    const tip=cards.find(c=>c.type===CT.Tip);
    const zone=cards.find(c=>c.type===CT.Zone);
    const spike=cards.find(c=>c.type===CT.PowerSpike);
    if(spike&&cards.length===1){
      removeCard(myHand,spike.id); state.atkType=AT.PowerSpike;
      addLog(state,'💥','p'+playerNum, me+' hit a Power Spike!');
      state.turnState=TS.Defense; state.isServePhase=false;
      state.lastAction='attack'; state.ballSide=state.defPlayer;
      broadcast(room,state); checkNoPlayable(room); return;
    }
    if(zone&&!tip&&cards.length===1){
      removeCard(myHand,zone.id); state.atkType=AT.Zone; state.atkZone=zone.zone;
      addLog(state,'🏐','p'+playerNum, me+' attacked Zone '+zone.zone);
      state.turnState=TS.Defense; state.isServePhase=false;
      state.lastAction='attack'; state.ballSide=state.defPlayer;
      broadcast(room,state); checkNoPlayable(room); return;
    }
    if(tip&&zone&&cards.length===2){
      removeCards(myHand,[tip.id,zone.id]); state.atkType=AT.Tip; state.atkZone=zone.zone;
      addLog(state,'🤫','p'+playerNum, me+' tipped to Zone '+zone.zone);
      state.turnState=TS.Defense; state.isServePhase=false;
      state.lastAction='attack'; state.ballSide=state.defPlayer;
      broadcast(room,state); checkNoPlayable(room); return;
    }
    return;
  }
 
  if(ts===TS.Defense){
    const defHand=getHand(state,playerNum);
    const bc=cards.filter(c=>c.type===CT.Block).length;
    const zc=cards.filter(c=>c.type===CT.Zone).length;
    const lib=cards.some(c=>c.type===CT.Libero);
    const cids=cards.map(c=>c.id);
 
    if(at===AT.PowerSpike){
      if(lib&&cards.length===1){ doSwap(state,defHand,cards,playerNum,'passed with Libero'); broadcast(room,state); checkNoPlayable(room); return; }
      if(bc===1&&zc===1){ removeCards(defHand,cids); addLog(state,'🛡️','p'+playerNum,me+' blocked and dug — ball returns'); state.turnState=TS.Attack; state.lastAction='defend'; state.ballSide=state.attPlayer; state.atkZone=0; broadcast(room,state); checkNoPlayable(room); return; }
      if(bc>=2&&zc===0){
        removeCards(defHand,cids);
        if(bc>=3){ addLog(state,'🏆','p'+playerNum,me+' triple blocked!'); awardPoint(room,playerNum,'Triple Block by '+me); return; }
        addLog(state,'🛡️','p'+playerNum,me+' double blocked — cover needed!'); state.turnState=TS.Cover; state.lastAction='block'; state.ballSide=state.defPlayer; state.ballZone=0; broadcast(room,state); checkNoPlayable(room); return;
      }
      return;
    }
    if(at===AT.Zone){
      if(lib&&cards.length===1){ doSwap(state,defHand,cards,playerNum,'passed with Libero'); broadcast(room,state); checkNoPlayable(room); return; }
      if(zc===1&&bc===0&&sameCorridor(cards[0].zone,state.atkZone)){ doSwap(state,defHand,cards,playerNum,'received in corridor'); broadcast(room,state); checkNoPlayable(room); return; }
      if(bc>=1&&zc===0){
        removeCards(defHand,cids);
        if(bc>=3){ addLog(state,'🏆','p'+playerNum,me+' triple blocked!'); awardPoint(room,playerNum,'Triple Block by '+me); return; }
        if(bc===2){ addLog(state,'🛡️','p'+playerNum,me+' double blocked — cover needed!'); state.turnState=TS.Cover; state.lastAction='block'; state.ballSide=state.defPlayer; state.ballZone=0; broadcast(room,state); checkNoPlayable(room); return; }
        addLog(state,'🛡️','p'+playerNum,me+' single blocked — ball returns'); state.turnState=TS.Attack; state.lastAction='defend'; state.ballSide=state.defPlayer; state.ballZone=0; state.atkZone=0; broadcast(room,state); checkNoPlayable(room); return;
      }
      return;
    }
    if(at===AT.Tip){
      if(lib&&cards.length===1){ doSwap(state,defHand,cards,playerNum,'passed with Libero'); broadcast(room,state); checkNoPlayable(room); return; }
      if(zc===1&&bc===0&&(cards[0].zone===state.atkZone||isAdjacent(cards[0].zone,state.atkZone))){ doSwap(state,defHand,cards,playerNum,'dug the tip'); broadcast(room,state); checkNoPlayable(room); return; }
      return;
    }
    if(at===AT.Ace){
      if(lib&&cards.length===1){ doSwap(state,defHand,cards,playerNum,'received the Ace with Libero'); broadcast(room,state); checkNoPlayable(room); return; }
      addLog(state,'🚀','p'+state.attPlayer, playerName(state,state.attPlayer)+' aced it — point!');
      awardPoint(room,state.attPlayer,'Ace by '+playerName(state,state.attPlayer)); return;
    }
    return;
  }
 
  if(ts===TS.Cover){
    if(cards.length!==1) return;
    const c=cards[0]; let ok=false;
    if(at===AT.PowerSpike&&(c.type===CT.Zone||c.type===CT.Libero)) ok=true;
    if(at===AT.Zone&&((c.type===CT.Zone&&sameCorridor(c.zone,state.atkZone))||c.type===CT.Libero)) ok=true;
    if(!ok) return;
    removeCard(myHand,c.id);
    addLog(state,'✅','p'+playerNum, me+' covered — back to attack');
    state.turnState=TS.Attack; state.lastAction='defend'; state.ballSide=state.attPlayer; state.atkZone=0;
    broadcast(room,state); checkNoPlayable(room); return;
  }
}
 
// ── WEBSOCKET HANDLER ────────────────────────────────────
wss.on('connection', (ws) => {
  ws.isAlive=true;
  ws.on('pong',()=>{ ws.isAlive=true; });
 
  ws.on('message',(raw)=>{
    let msg; try{ msg=JSON.parse(raw); }catch(e){ return; }
 
    // CREATE
    if(msg.type==='CREATE'){
      const code=makeCode();
      rooms[code]={
        players:[ws,null], state:null, timers:{},
        firstP1:Math.random()>0.5,
        ready:[false,false],
        names:['Player 1','Player 2'],
      };
      ws.roomCode=code; ws.playerNum=1;
      ws.send(JSON.stringify({type:'CREATED',code}));
      return;
    }
 
    // JOIN
    if(msg.type==='JOIN'){
      const code=(msg.code||'').toUpperCase().trim();
      const room=rooms[code];
      if(!room){ ws.send(JSON.stringify({type:'ERROR',msg:'Room not found. Check the code and try again.'})); return; }
      if(room.players[1]){ ws.send(JSON.stringify({type:'ERROR',msg:'Room is already full.'})); return; }
      room.players[1]=ws; ws.roomCode=code; ws.playerNum=2;
      // Tell P1 opponent joined, both go to name entry
      room.players[0].send(JSON.stringify({type:'OPPONENT_JOINED'}));
      ws.send(JSON.stringify({type:'JOINED',code}));
      return;
    }
 
    // SET NAME + READY
    if(msg.type==='READY'){
      const room=rooms[ws.roomCode];
      if(!room) return;
      const pIdx=ws.playerNum-1;
      const name=(msg.name||'').trim().slice(0,20)||('Player '+ws.playerNum);
      room.names[pIdx]=name;
      room.ready[pIdx]=true;
      // Tell other player this one is ready
      const other=room.players.find(p=>p&&p!==ws);
      if(other&&other.readyState===WebSocket.OPEN)
        other.send(JSON.stringify({type:'OPP_READY',name}));
      // Both ready — start game
      if(room.ready[0]&&room.ready[1]){
        room.state=initGameState(room.firstP1, room.names[0], room.names[1]);
        dealHands(room.state);
        startRally(room.state);
        broadcast(room,room.state);
        scheduleTimeout(room);
        checkNoPlayable(room);
      }
      return;
    }
 
    // PLAY
    if(msg.type==='PLAY'){
      const room=rooms[ws.roomCode];
      if(!room||!room.state) return;
      if(room.timers[ws.playerNum]){ clearTimeout(room.timers[ws.playerNum]); delete room.timers[ws.playerNum]; }
      processPlay(room,ws.playerNum,msg.cardIds);
      scheduleTimeout(room);
      return;
    }
 
    // TIMEOUT
    if(msg.type==='TIMEOUT'){
      const room=rooms[ws.roomCode];
      if(!room||!room.state) return;
      handleTimeout(room,ws.playerNum);
      return;
    }
 
    // REMATCH
    if(msg.type==='REMATCH'){
      const room=rooms[ws.roomCode];
      if(!room) return;
      room.ready=[true,true];
      room.state=initGameState(Math.random()>0.5, room.names[0], room.names[1]);
      dealHands(room.state); startRally(room.state);
      broadcast(room,room.state);
      scheduleTimeout(room); checkNoPlayable(room);
      return;
    }
  });
 
  ws.on('close',()=>{
    const room=rooms[ws.roomCode];
    if(!room) return;
    // Stop all timers
    Object.values(room.timers).forEach(t=>clearTimeout(t));
    room.timers={};
    // Notify other player
    const other=room.players.find(p=>p&&p!==ws);
    if(other&&other.readyState===WebSocket.OPEN)
      other.send(JSON.stringify({type:'OPPONENT_LEFT'}));
    delete rooms[ws.roomCode];
  });
});
 
// Keep connections alive through Railway proxy
setInterval(()=>{
  wss.clients.forEach(ws=>{
    if(ws.isAlive===false){ ws.terminate(); return; }
    ws.isAlive=false; ws.ping();
  });
},25000);
 
server.listen(PORT,()=>console.log('VolleyCards running on port '+PORT));
