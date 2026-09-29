const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Rules = require("./rules.js");

const PORT = Number(process.env.PORT || 10000);
const PUBLIC_DIR = __dirname;
const rooms = new Map();
const lobbyStreams = new Set();

const mimeTypes = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
};

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function safeText(value, max) { return String(value ?? "").trim().slice(0, max); }
function teamForSeat(seat) { return seat % 2; }
function playerById(room, id) { return room.players.find((player) => player.id === id); }
function playerBySeat(room, seat) { return room.players.find((player) => player.seat === seat); }
function nextSeat(seat) { return (seat + 1) % 4; }
function leftOfDealer(room) { return nextSeat(room.game.dealerSeat); }
function rightOfDealer(room) { return (room.game.dealerSeat + 3) % 4; }
function gameId() { return crypto.randomBytes(4).toString("hex").toUpperCase(); }

function roomList() {
  return [...rooms.values()].sort((a, b) => a.createdAt - b.createdAt).map((room) => ({
    id: room.id,
    name: room.name,
    count: room.players.length,
    capacity: 4,
    status: room.game ? room.game.phase : "waiting",
    players: room.players.map((player) => ({ name: player.name, surname: player.surname, city: player.city, seat: player.seat })),
  }));
}

function publicGame(game, self) {
  if (!game) return null;
  return {
    phase: game.phase,
    dealerSeat: game.dealerSeat,
    chooserSeat: game.chooserSeat,
    turnSeat: game.turnSeat,
    firstSeat: game.firstSeat,
    trump: game.trump,
    contractSeat: game.contractSeat,
    highBid: game.highBid,
    passCount: game.passCount,
    dealMode: game.dealMode,
    packetPattern: game.packetPattern,
    openCards: game.openCards,
    hands: game.hands.map((hand, seat) => seat === self?.seat ? hand : []),
    handCounts: game.hands.map((hand) => hand.length),
    currentTrick: game.currentTrick.map(({ playId, seat, card }) => ({ playId, seat, card })),
    lastTrick: game.lastTrick.map(({ playId, seat, card }) => ({ playId, seat, card })),
    tricks: game.tricks.map((trick) => ({ ...trick, cards: trick.cards.map(({ playId, seat, card }) => ({ playId, seat, card })) })),
    teamPoints: game.teamPoints,
    teamTricks: game.teamTricks,
    heads: game.heads,
    score: game.score,
    questionsAsked: game.questionsAsked,
    answerToFirst: game.answerToFirst,
    mustThroughMarch: game.mustThroughMarch,
    currentQuestion: game.currentQuestion,
    exchangeDone: game.exchangeDone,
    pendingExchange: game.pendingExchange ? { fromSeat: game.pendingExchange.fromSeat, toSeat: game.pendingExchange.toSeat, card: game.pendingExchange.card } : null,
    publicExchanges: game.publicExchanges,
    throughMarch: game.throughMarch,
    result: game.result,
    notice: game.notice,
  };
}

function roomView(room, playerId) {
  const self = playerById(room, playerId);
  return {
    id: room.id,
    name: room.name,
    createdAt: room.createdAt,
    players: room.players.map((player) => ({ id: player.id, name: player.name, surname: player.surname, city: player.city, seat: player.seat, ready: player.ready })),
    game: publicGame(room.game, self),
  };
}

function writeEvent(response, value) {
  if (!response.destroyed && !response.writableEnded) response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function broadcastLobby() {
  const data = { rooms: roomList() };
  for (const stream of lobbyStreams) writeEvent(stream, data);
}

function broadcastRoom(room) {
  for (const stream of room.streams) writeEvent(stream.response, roomView(room, stream.playerId));
  broadcastLobby();
}

function createGame(room) {
  const dealerSeat = room.nextDealerSeat ?? 0;
  room.game = {
    phase: "dealChoice",
    dealerSeat,
    chooserSeat: (dealerSeat + 3) % 4,
    firstSeat: (dealerSeat + 1) % 4,
    turnSeat: (dealerSeat + 1) % 4,
    deck: Rules.shuffle(Rules.makeDeck()),
    hands: Array.from({ length: 4 }, () => []),
    openCards: [],
    trump: null,
    highBid: null,
    passCount: 0,
    lastBidSeat: null,
    dealMode: null,
    packetPattern: null,
    currentTrick: [],
    lastTrick: [],
    tricks: [],
    teamPoints: [0, 0],
    teamTricks: [0, 0],
    score: room.score ?? [0, 0],
    heads: room.heads ?? [0, 0],
    questionsAsked: 0,
    currentQuestion: null,
    exchangeDone: [],
    pendingExchange: null,
    publicExchanges: [],
    throughMarch: false,
    result: null,
    notice: "Der Spieler rechts vom Geber entscheidet über die Verteilart.",
  };
  room.nextDealerSeat = dealerSeat;
}

function dealCards(game, mode, pattern) {
  const packets = { "2-3-3": [2, 3, 3], "3-2-3": [3, 2, 3], "2-2-2-2": [2, 2, 2, 2] };
  if (mode === "abheben") {
    const cutAt = Math.floor(game.deck.length / 2);
    game.deck = [...game.deck.slice(cutAt), ...game.deck.slice(0, cutAt)];
    game.packetPattern = pattern;
  }
  game.dealMode = mode;
  if (mode === "aufdecken") game.packetPattern = "2-2-2-2";
  if (mode === "klopfen") game.packetPattern = "8";
  if (mode === "klopfen") {
    game.packetPattern = "8";
    game.hands = Array.from({ length: 4 }, () => []);
    for (let offset = 0; offset < 4; offset += 1) {
      const seat = (game.firstSeat + offset) % 4;
      game.hands[seat].push(...game.deck.splice(0, 8));
    }
  } else {
    const selectedPackets = mode === "aufdecken" ? packets["2-2-2-2"] : packets[pattern];
    if (!selectedPackets) throw new Error("Bitte eine gültige Kartenverteilung auswählen.");
    game.hands = Array.from({ length: 4 }, () => []);
    for (const count of selectedPackets) {
      for (let offset = 0; offset < 4; offset += 1) {
        const seat = (game.firstSeat + offset) % 4;
        game.hands[seat].push(...game.deck.splice(0, count));
      }
    }
    if (mode === "aufdecken") {
      game.openCards = game.hands.map((hand, seat) => ({ seat, card: hand[0] }));
    }
  }
  game.phase = "meld";
  game.turnSeat = game.firstSeat;
  game.notice = "Die Karten sind verteilt. Die Melde beginnt links vom Geber.";
}

function canBeatBid(count, suit, bid) {
  if (!bid) return true;
  if (count === bid.count + 1) return true;
  return count === bid.count && suit === "clubs" && bid.suit !== "clubs";
}

function nextBidTurn(game) { game.turnSeat = nextSeat(game.turnSeat); }

function moveIntoExchange(room) {
  const game = room.game;
  game.phase = "exchange";
  game.turnSeat = game.firstSeat;
  game.exchangeDone = [];
  game.notice = "Ein Spieler mit genau einem Trumpf darf ihn offen an den Partner geben.";
}

function afterExchange(room) {
  const game = room.game;
  if (game.exchangeDone.length >= 4 && !game.pendingExchange) {
    game.phase = "questions";
    game.turnSeat = game.contractSeat;
    game.notice = "Der Ansager kann seinen Partner fragen oder zum Spiel übergehen.";
  } else {
    game.turnSeat = nextSeat(game.turnSeat);
  }
}

function startPlay(room) {
  const game = room.game;
  game.phase = "play";
  game.currentTrick = [];
  game.lastTrick = [];
  game.turnSeat = game.firstSeat;
  game.notice = "Das Spiel beginnt. Lege deine Karte; ein anderer Spieler kann falsches Legen melden.";
}

function updateResult(room, winningTeam, reason, awardPoints = true) {
  const game = room.game;
  const losingTeam = 1 - winningTeam;
  const callerTeam = teamForSeat(game.contractSeat);
  const contractBase = game.trump === "clubs" ? 4 : 2;
  const callerWon = winningTeam === callerTeam;
  const losingPoints = game.teamPoints[losingTeam];
  const schneider = losingPoints < 31;
  const points = awardPoints ? Math.min(6, contractBase + (callerWon ? 0 : 2) + (schneider ? 2 : 0)) : 0;
  const thresholdHead = awardPoints ? addScore(game, winningTeam, points) : null;
  game.result = { winningTeam, losingTeam, reason, points, schneider, callerWon, thresholdHead };
  room.score = game.score;
  room.heads = game.heads;
  game.phase = "result";
  game.notice = reason;
}

function addScore(game, team, points) {
  game.score[team] += points;
  if (game.score[team] >= 12) {
    game.score[team] -= 12;
    game.heads[1 - team] += 1;
    return 1 - team;
  }
  return null;
}

function finishRound(room) {
  const game = room.game;
  const callerTeam = teamForSeat(game.contractSeat);
  const winnerTeam = game.teamPoints[0] === 60 ? 1 - callerTeam : game.teamPoints[0] > 60 ? 0 : 1;
  if (game.throughMarch) {
    const otherTeam = 1 - callerTeam;
    if (game.teamTricks[otherTeam] === 0) {
      game.heads[otherTeam] += 4;
      game.result = { winningTeam: callerTeam, losingTeam: otherTeam, reason: "Durchmarsch gelungen", headsAwarded: 4, points: 0 };
    } else {
      game.heads[callerTeam] += 4;
      game.result = { winningTeam: otherTeam, losingTeam: callerTeam, reason: "Durchmarsch nicht gelungen", headsAwarded: 4, points: 0 };
    }
    room.heads = game.heads;
    game.phase = "result";
    game.notice = game.result.reason;
    return;
  }
  updateResult(room, winnerTeam, "Die acht Stiche sind gespielt.");
}

function startNextHand(room) {
  const players = room.players;
  if (players.length !== 4) return;
  room.nextDealerSeat = (room.game.dealerSeat + 1) % 4;
  room.score = room.game.score;
  room.heads = room.game.heads;
  createGame(room);
  room.players.forEach((player) => { player.ready = true; });
}

function cardFromHand(game, seat, id) { return game.hands[seat].find((card) => card.id === id); }

function consumeRequest(request, response) {
  let body = "";
  request.on("data", (chunk) => { body += chunk; if (body.length > 1_000_000) request.destroy(); });
  request.on("end", () => {
    try { request.body = body ? JSON.parse(body) : {}; } catch { json(response, 400, { error: "Ungültige Anfrage." }); return; }
    route(request, response);
  });
}

function route(request, response) {
  request.body = request.body || {};
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/api/health" && request.method === "GET") return json(response, 200, { ok: true, service: "melde" });
  if (url.pathname === "/api/rooms" && request.method === "GET") return json(response, 200, { rooms: roomList() });
  if (url.pathname === "/api/stream" && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    response.write("retry: 2000\n\n");
    if (url.searchParams.has("room")) {
      const room = rooms.get(url.searchParams.get("room"));
      if (!room) { response.end(); return; }
      const stream = { response, playerId: url.searchParams.get("playerId") || "" };
      room.streams.add(stream);
      writeEvent(response, roomView(room, stream.playerId));
      request.on("close", () => room.streams.delete(stream));
    } else {
      lobbyStreams.add(response);
      writeEvent(response, { rooms: roomList() });
      request.on("close", () => lobbyStreams.delete(response));
    }
    return;
  }
  if (url.pathname === "/api/rooms" && request.method === "POST") {
    const { profile = {}, roomName, playerId } = request.body;
    const cleanName = safeText(roomName, 15);
    const cleanProfile = { name: safeText(profile.name, 40), surname: safeText(profile.surname, 60), city: safeText(profile.city, 60) };
    if (!cleanName || !cleanProfile.name || !cleanProfile.surname || !cleanProfile.city || !playerId) return json(response, 400, { error: "Bitte Raumname sowie Vorname, Nachname und Stadt angeben." });
    let id = gameId();
    while (rooms.has(id)) id = gameId();
    const room = { id, name: cleanName, createdAt: Date.now(), players: [{ id: String(playerId), ...cleanProfile, seat: 0, ready: false }], game: null, score: [0, 0], heads: [0, 0], streams: new Set(), nextDealerSeat: 0 };
    rooms.set(id, room);
    broadcastRoom(room);
    return json(response, 201, roomView(room, String(playerId)));
  }
  if (parts[0] !== "api" || parts[1] !== "rooms" || !parts[2]) return serveFile(url.pathname, response);

  const room = rooms.get(parts[2]);
  if (!room) return json(response, 404, { error: "Dieser Raum ist nicht mehr verfügbar." });
  const playerId = String(request.body.playerId || url.searchParams.get("playerId") || "");
  const player = playerById(room, playerId);

  if (parts.length === 3 && request.method === "GET") return json(response, 200, roomView(room, playerId));

  if (parts[3] === "join" && request.method === "POST") {
    const { profile = {} } = request.body;
    const cleanProfile = { name: safeText(profile.name, 40), surname: safeText(profile.surname, 60), city: safeText(profile.city, 60) };
    if (!playerId || !cleanProfile.name || !cleanProfile.surname || !cleanProfile.city) return json(response, 400, { error: "Bitte Vorname, Nachname und Stadt angeben." });
    if (player) return json(response, 200, roomView(room, playerId));
    if (room.game || room.players.length >= 4) return json(response, 409, { error: "Der Raum ist voll oder das Spiel hat bereits begonnen." });
    const seat = [0, 1, 2, 3].find((value) => !room.players.some((entry) => entry.seat === value));
    room.players.push({ id: playerId, ...cleanProfile, seat, ready: false });
    broadcastRoom(room);
    return json(response, 200, roomView(room, playerId));
  }

  if (!player) return json(response, 403, { error: "Du sitzt nicht in diesem Raum." });
  if (parts[3] === "leave" && request.method === "POST") {
    room.players = room.players.filter((entry) => entry.id !== playerId);
    if (!room.players.length) rooms.delete(room.id);
    else { room.game = null; room.players.forEach((entry) => { entry.ready = false; }); }
    broadcastLobby();
    if (rooms.has(room.id)) broadcastRoom(room);
    return json(response, 200, { ok: true });
  }
  if (parts[3] === "ready" && request.method === "POST") {
    if (room.players.length !== 4 || room.game) return json(response, 409, { error: "Bereit kann erst bei vier Spielern bestätigt werden." });
    player.ready = Boolean(request.body.ready);
    if (room.players.every((entry) => entry.ready)) createGame(room);
    broadcastRoom(room);
    return json(response, 200, roomView(room, playerId));
  }
  if (!room.game) return json(response, 409, { error: "Das Spiel hat noch nicht begonnen." });
  const game = room.game;
  const seat = player.seat;

  if (parts[3] === "deal" && request.method === "POST") {
    if (game.phase !== "dealChoice" || seat !== game.chooserSeat) return json(response, 409, { error: "Nur der Spieler rechts vom Geber entscheidet über das Austeilen." });
    const mode = request.body.mode;
    if (!["klopfen", "aufdecken", "abheben"].includes(mode)) return json(response, 400, { error: "Unbekannte Verteilart." });
    try { dealCards(game, mode, request.body.pattern); } catch (error) { return json(response, 400, { error: error.message }); }
    broadcastRoom(room);
    return json(response, 200, roomView(room, playerId));
  }

  if (parts[3] === "bid" && request.method === "POST") {
    if (game.phase !== "meld" || seat !== game.turnSeat) return json(response, 409, { error: "Du bist gerade nicht an der Reihe zu melden." });
    const selectedIds = [...new Set((request.body.cardIds || []).map(String))];
    const selected = selectedIds.map((id) => cardFromHand(game, seat, id));
    const suit = String(request.body.suit || "");
    if (selected.some((card) => !card) || !Rules.SUITS.includes(suit) || !Rules.validMelde(selected, suit)) return json(response, 400, { error: "Wähle Trumpfkarten und Karten genau einer Farbe für die Melde." });
    const count = Rules.countMelde(selected, suit);
    if (count < 5 || count > 8) return json(response, 400, { error: "Eine Melde umfasst fünf bis acht Karten." });
    if (!canBeatBid(count, suit, game.highBid)) return json(response, 409, { error: "Diese Melde ist nicht höher als die aktuelle Ansage." });
    game.highBid = { count, suit, seat, playerName: player.name };
    game.lastBidSeat = seat;
    game.passCount = 0;
    nextBidTurn(game);
    game.notice = `${player.name} meldet ${count} in ${Rules.SUIT_NAMES[suit]}.`;
    broadcastRoom(room);
    return json(response, 200, roomView(room, playerId));
  }

  if (parts[3] === "pass" && request.method === "POST") {
    if (game.phase !== "meld" || seat !== game.turnSeat) return json(response, 409, { error: "Du bist gerade nicht an der Reihe." });
    game.passCount += 1;
    if (game.highBid && game.passCount >= 3) {
      game.contractSeat = game.highBid.seat;
      game.trump = game.highBid.suit;
      moveIntoExchange(room);
      game.notice = `${player.name} passt. ${game.highBid.playerName} erhält die Melde in ${Rules.SUIT_NAMES[game.trump]}.`;
    } else if (!game.highBid && game.passCount >= 4) {
      room.nextDealerSeat = (game.dealerSeat + 1) % 4;
      room.score = game.score;
      room.heads = game.heads;
      createGame(room);
      room.game.notice = "Niemand meldet mindestens fünf. Neu geben – der Geber wechselt.";
    } else {
      nextBidTurn(game);
      game.notice = `${player.name} passt.`;
    }
    broadcastRoom(room);
    return json(response, 200, roomView(room, playerId));
  }

  if (parts[3] === "exchange" && request.method === "POST") {
    if (game.phase !== "exchange" || seat !== game.turnSeat) return json(response, 409, { error: "Du bist gerade nicht an der Reihe." });
    if (game.pendingExchange) return json(response, 409, { error: "Der laufende Kartentausch muss erst beendet werden." });
    const kind = request.body.kind;
    if (kind === "pass") {
      if (!game.exchangeDone.includes(seat)) game.exchangeDone.push(seat);
      afterExchange(room);
    } else if (kind === "send") {
      const hand = game.hands[seat];
      const trumps = hand.filter((card) => Rules.isTrump(card, game.trump));
      const chosen = trumps.find((card) => card.id === request.body.cardId);
      if (trumps.length !== 1 || !chosen || chosen.id === "clubs-Q") return json(response, 400, { error: "Du darfst nur deinen einzigen Trumpf weitergeben; die Kreuz-Dame bleibt immer auf der Hand." });
      const partnerSeat = (seat + 2) % 4;
      game.hands[seat] = hand.filter((card) => card.id !== chosen.id);
      game.hands[partnerSeat].push(chosen);
      game.pendingExchange = { fromSeat: seat, toSeat: partnerSeat, card: chosen };
      game.publicExchanges.push({ fromSeat: seat, toSeat: partnerSeat, card: chosen });
      game.turnSeat = partnerSeat;
      game.notice = `${player.name} gibt ${Rules.RANK_NAMES[chosen.rank]} ${Rules.SUIT_NAMES[chosen.suit]} offen an den Partner.`;
    } else if (kind === "return") {
      if (!game.pendingExchange || seat !== game.pendingExchange.toSeat) return json(response, 409, { error: "Du bist nicht am Zug, eine Karte zurückzugeben." });
      const card = cardFromHand(game, seat, String(request.body.cardId));
      if (!card || Rules.isTrump(card, game.trump)) return json(response, 400, { error: "Der Partner muss eine Nicht-Trumpfkarte zurückgeben." });
      const original = game.pendingExchange;
      game.hands[seat] = game.hands[seat].filter((entry) => entry.id !== card.id);
      game.hands[original.fromSeat].push(card);
      game.exchangeDone.push(original.fromSeat);
      game.pendingExchange = null;
      afterExchange(room);
      game.notice = "Der verdeckte Rücktausch ist abgeschlossen.";
    }
    broadcastRoom(room);
    return json(response, 200, roomView(room, playerId));
  }

  if (parts[3] === "question" && request.method === "POST") {
    if (game.phase !== "questions" || seat !== game.contractSeat) return json(response, 409, { error: "Nur der Ansager darf jetzt seinem Partner eine Frage stellen." });
    if (game.questionsAsked >= 2 || game.currentQuestion) return json(response, 409, { error: "Es ist keine weitere Frage möglich." });
    if (game.questionsAsked === 1 && game.answerToFirst !== "yes") return json(response, 409, { error: "Nach einem Nein darf keine zweite Frage gestellt werden." });
    const question = request.body.question || {};
    const partnerSeat = (seat + 2) % 4;
    game.currentQuestion = { ...question, fromSeat: seat, toSeat: partnerSeat };
    game.turnSeat = partnerSeat;
    game.notice = "Dein Partner hat eine Frage gestellt.";
    broadcastRoom(room);
    return json(response, 200, roomView(room, playerId));
  }

  if (parts[3] === "answer" && request.method === "POST") {
    if (game.phase !== "questions" || !game.currentQuestion || seat !== game.currentQuestion.toSeat) return json(response, 409, { error: "Es wartet keine Frage von deinem Partner." });
    const answer = request.body.answer === "yes" ? "yes" : "no";
    game.questionsAsked += 1;
    if (game.questionsAsked === 1) game.answerToFirst = answer;
    game.lastAnswer = answer;
    game.currentQuestion = null;
    game.notice = `${player.name} antwortet ${answer === "yes" ? "Ja" : "Nein"}.`;
    if (game.questionsAsked >= 2 && game.answerToFirst === "yes" && answer === "yes") game.mustThroughMarch = true;
    game.turnSeat = game.contractSeat;
    broadcastRoom(room);
    return json(response, 200, roomView(room, playerId));
  }

  if (parts[3] === "continue" && request.method === "POST") {
    if (game.phase !== "questions" || seat !== game.contractSeat || game.currentQuestion) return json(response, 409, { error: "Du kannst gerade nicht fortfahren." });
    if (game.mustThroughMarch && !request.body.throughMarch) return json(response, 409, { error: "Nach zweimal Ja musst du den Durchmarsch/Klopfer spielen." });
    game.throughMarch = Boolean(request.body.throughMarch);
    startPlay(room);
    broadcastRoom(room);
    return json(response, 200, roomView(room, playerId));
  }

  if (parts[3] === "play" && request.method === "POST") {
    if (game.phase !== "play" || seat !== game.turnSeat || game.currentTrick.some((play) => play.seat === seat)) return json(response, 409, { error: "Du bist gerade nicht am Zug." });
    const card = cardFromHand(game, seat, String(request.body.cardId));
    if (!card) return json(response, 400, { error: "Diese Karte ist nicht auf deiner Hand." });
    const legality = Rules.legalPlay(game.hands[seat], game.currentTrick, card, game.trump);
    game.hands[seat] = game.hands[seat].filter((entry) => entry.id !== card.id);
    game.currentTrick.push({ playId: crypto.randomUUID(), seat, card, legal: legality.legal, reason: legality.reason });
    if (game.currentTrick.length < 4) {
      game.turnSeat = nextSeat(seat);
      game.notice = `${player.name} legt eine Karte.`;
    } else {
      const winnerIndex = Rules.winningPlay(game.currentTrick, game.trump);
      const winner = game.currentTrick[winnerIndex];
      const trickPoints = game.currentTrick.reduce((sum, play) => sum + Rules.cardPoints(play.card), 0);
      const winningTeam = teamForSeat(winner.seat);
      game.teamPoints[winningTeam] += trickPoints;
      game.teamTricks[winningTeam] += 1;
      game.tricks.push({ number: game.tricks.length + 1, winnerSeat: winner.seat, winningTeam, points: trickPoints, cards: game.currentTrick.map(({ playId, seat: playSeat, card: played, legal, reason }) => ({ playId, seat: playSeat, card: played, legal, reason })) });
      game.lastTrick = game.currentTrick;
      game.currentTrick = [];
      if (game.tricks.length === 8) finishRound(room);
      else { game.turnSeat = winner.seat; game.notice = `Stich ${game.tricks.length} gewonnen von Spieler ${winner.seat + 1}; ${trickPoints} Kartenpunkte.`; }
    }
    broadcastRoom(room);
    return json(response, 200, roomView(room, playerId));
  }

  if (parts[3] === "next-hand" && request.method === "POST") {
    if (game.phase !== "result") return json(response, 409, { error: "Diese Runde ist noch nicht beendet." });
    startNextHand(room);
    broadcastRoom(room);
    return json(response, 200, roomView(room, playerId));
  }

  return json(response, 404, { error: "Aktion nicht gefunden." });
}

function serveFile(pathname, response) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return json(response, 400, { error: "Ungültiger Pfad." }); }
  if (decoded === "/") decoded = "/index.html";
  const target = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, "index.html")) return json(response, 403, { error: "Ungültiger Pfad." });
  fs.readFile(target, (error, contents) => {
    if (error) return json(response, 404, { error: "Datei nicht gefunden." });
    response.writeHead(200, { "content-type": mimeTypes[path.extname(target)] || "application/octet-stream", "cache-control": "no-cache" });
    response.end(contents);
  });
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" || request.method === "HEAD") return route(request, response);
  consumeRequest(request, response);
});

setInterval(() => {
  for (const stream of lobbyStreams) if (!stream.destroyed && !stream.writableEnded) stream.write(": keep-alive\n\n");
  for (const room of rooms.values()) for (const stream of room.streams) if (!stream.response.destroyed && !stream.response.writableEnded) stream.response.write(": keep-alive\n\n");
}, 25000).unref();

server.listen(PORT, "0.0.0.0", () => console.log(`Melde listening on ${PORT}`));
