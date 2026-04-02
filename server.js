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

// ── DECK ─────────────────────────
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
  for (let i=a.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

// ── GAME STATE ───────────────────
function initGameState(firstP1, p1name, p2name) {
  return {
    p1Score:0, p2Score:0,
    p1Sets:0, p2Sets:0,
    p1Serving:firstP1,

    p1Hand:[], p2Hand:[],

    turnState:'Serve',
    atkType:null,
    atkZone:0,

    attPlayer:firstP1?1:2,
    defPlayer:firstP1?2:1,

    p1name, p2name,

    ballSide:firstP1?1:2,
    ballZone:0,

    paused:false,
    matchOver:false
  };
}

function dealHands(state) {
  state.p1Hand = makeDeck().slice(0,6);
  state.p2Hand = makeDeck().slice(0,6);
}

function getHand(state, p) {
  return p===1 ? state.p1Hand : state.p2Hand;
}

function removeCard(hand, id) {
  const i=hand.findIndex(c=>c.id===id);
  if(i!==-1) hand.splice(i,1);
}

// ── BALL SYSTEM (CORE FIX) ───────
function moveBallTo(state, side, zone=0) {
  state.ballSide = side;
  state.ballZone = zone; // 0 = middle/back
}

// ── GAME FLOW ────────────────────
function startRally(state) {
  state.attPlayer = state.p1Serving?1:2;
  state.defPlayer = state.p1Serving?2:1;

  state.turnState='Serve';
  state.atkType=null;
  state.atkZone=0;

  moveBallTo(state, state.attPlayer, 0);
}

// ── PLAY LOGIC ───────────────────
function processPlay(room, playerNum, cardIds) {
  const state = room.state;
  if(state.matchOver || state.paused) return;

  const hand = getHand(state, playerNum);
  const cards = cardIds.map(id => hand.find(c=>c.id===id)).filter(Boolean);

  if(!cards.length) return;

  // ── SERVE ──
  if(state.turnState==='Serve') {
    const c = cards[0];
    removeCard(hand, c.id);

    state.attPlayer = playerNum;
    state.defPlayer = playerNum===1?2:1;

    if(c.type==='Ace') {
      state.atkType='Ace';
      state.atkZone=0;
      moveBallTo(state, state.defPlayer, 0);
    } else {
      state.atkType='Zone';
      state.atkZone=c.zone;
      moveBallTo(state, state.defPlayer, c.zone);
    }

    state.turnState='Defense';
    return;
  }

  // ── ATTACK ──
  if(state.turnState==='Attack') {
    const c = cards[0];

    if(c.type==='PowerSpike') {
      removeCard(hand, c.id);
      state.atkType='PowerSpike';
      state.atkZone=0;

      moveBallTo(state, state.defPlayer, 0);
    }

    if(c.type==='Zone') {
      removeCard(hand, c.id);
      state.atkType='Zone';
      state.atkZone=c.zone;

      moveBallTo(state, state.defPlayer, c.zone);
    }

    const tip = cards.find(x=>x.type==='Tip');
    const zone = cards.find(x=>x.type==='Zone');

    if(tip && zone) {
      removeCard(hand, tip.id);
      removeCard(hand, zone.id);

      state.atkType='Tip';
      state.atkZone=zone.zone;

      moveBallTo(state, state.defPlayer, zone.zone);
    }

    state.turnState='Defense';
    return;
  }

  // ── DEFENSE ──
  if(state.turnState==='Defense') {

    // LIBERO → PASS → SAME SIDE CENTER
    if(cards[0].type==='Libero') {
      removeCard(hand, cards[0].id);

      moveBallTo(state, playerNum, 0);

      state.attPlayer = playerNum;
      state.defPlayer = playerNum===1?2:1;

      state.turnState='Attack';
      return;
    }

    // SINGLE BLOCK → RETURN TO ATTACK
    const blocks = cards.filter(c=>c.type==='Block').length;

    if(blocks===1) {
      cards.forEach(c=>removeCard(hand,c.id));

      moveBallTo(state, playerNum, 0);

      state.attPlayer = playerNum;
      state.defPlayer = playerNum===1?2:1;

      state.turnState='Attack';
      return;
    }

    // DOUBLE / TRIPLE BLOCK → (simplified)
    if(blocks>=2) {
      cards.forEach(c=>removeCard(hand,c.id));

      state.paused=true;
      return;
    }

    // NORMAL DIG (Zone)
    if(cards[0].type==='Zone') {
      removeCard(hand, cards[0].id);

      moveBallTo(state, playerNum, 0);

      state.attPlayer = playerNum;
      state.defPlayer = playerNum===1?2:1;

      state.turnState='Attack';
      return;
    }
  }
}

// ── NETWORK ──────────────────────
function buildPayload(state, playerNum) {
  return {
    type:'STATE',
    p1Hand: playerNum===1?state.p1Hand:[],
    p2Hand: playerNum===2?state.p2Hand:[],
    ballSide: state.ballSide,
    ballZone: state.ballZone,
    turnState: state.turnState,
    attPlayer: state.attPlayer
  };
}

function broadcast(room) {
  room.players.forEach((ws,i)=>{
    if(ws && ws.readyState===WebSocket.OPEN) {
      ws.send(JSON.stringify(buildPayload(room.state,i+1)));
    }
  });
}

// ── WS ───────────────────────────
wss.on('connection', (ws) => {

  ws.on('message',(raw)=>{
    const msg = JSON.parse(raw);

    if(msg.type==='CREATE') {
      const code=makeCode();
      rooms[code]={ players:[ws,null], state:null };
      ws.roomCode=code;
      ws.playerNum=1;
      ws.send(JSON.stringify({type:'CREATED',code}));
      return;
    }

    if(msg.type==='JOIN') {
      const room=rooms[msg.code];
      room.players[1]=ws;
      ws.roomCode=msg.code;
      ws.playerNum=2;

      room.state = initGameState(true,'P1','P2');
      dealHands(room.state);
      startRally(room.state);
      broadcast(room);
      return;
    }

    if(msg.type==='PLAY') {
      const room=rooms[ws.roomCode];
      processPlay(room, ws.playerNum, msg.cardIds);
      broadcast(room);
    }
  });

});

server.listen(PORT,()=>console.log('RUNNING'));
