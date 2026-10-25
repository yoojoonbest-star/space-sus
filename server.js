
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};
const tasksNeeded = 3;

function sendState(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit("state", {
    phase: room.phase,
    players: Object.entries(room.players).map(([id, p]) => ({
      id,
      name: p.name,
      x: p.x,
      y: p.y,
      role: id === room.impostor ? p.role : undefined,
      alive: p.alive,
      tasks: p.tasks
    })),
    votes: room.votes
  });
}

function finishMeeting(code) {
  const room = rooms[code];
  if (!room) return;

  const counts = {};
  for (const target of Object.values(room.votes)) {
    if (target) counts[target] = (counts[target] || 0) + 1;
  }

  const highest = Math.max(0, ...Object.values(counts));
  const winners = Object.keys(counts).filter(id => counts[id] === highest);

  if (winners.length === 1 && highest > 0 && room.players[winners[0]]) {
    room.players[winners[0]].alive = false;
  }

  const crew = Object.values(room.players).filter(p => p.role === "crew" && p.alive).length;
  const imp = Object.values(room.players).filter(p => p.role === "impostor" && p.alive).length;

  if (imp === 0) room.phase = "crewWin";
  else if (imp >= crew) room.phase = "impWin";
  else room.phase = "playing";

  room.votes = {};
  sendState(code);
}

io.on("connection", socket => {
  socket.on("createRoom", (name, done) => {
    const code = Math.random().toString(36).slice(2, 6).toUpperCase();
    rooms[code] = {
      players: {},
      phase: "lobby",
      votes: {},
      impostor: null
    };

    rooms[code].players[socket.id] = {
      name: String(name || "Player").slice(0, 15),
      x: 100,
      y: 100,
      role: "crew",
      alive: true,
      tasks: 0
    };

    socket.join(code);
    socket.data.room = code;
    done({ code });
    sendState(code);
  });

  socket.on("joinRoom", ({ code, name }, done) => {
    code = String(code || "").toUpperCase();
    const room = rooms[code];

    if (!room || room.phase !== "lobby" ||
        Object.keys(room.players).length >= 6) {
      return done({ error: "방이 없거나 꽉 찼어!" });
    }

    room.players[socket.id] = {
      name: String(name || "Player").slice(0, 15),
      x: 100 + Math.random() * 100,
      y: 100 + Math.random() * 100,
      role: "crew",
      alive: true,
      tasks: 0
    };

    socket.join(code);
    socket.data.room = code;
    done({ code });
    sendState(code);
  });

  socket.on("startGame", () => {
    const code = socket.data.room;
    const room = rooms[code];

    if (!room || room.phase !== "lobby" ||
        Object.keys(room.players).length < 2) return;

    const ids = Object.keys(room.players);
    room.impostor = ids[Math.floor(Math.random() * ids.length)];

    for (const p of Object.values(room.players)) {
      p.role = "crew";
      p.alive = true;
      p.tasks = 0;
    }

    room.players[room.impostor].role = "impostor";
    room.phase = "playing";
    sendState(code);
  });

  socket.on("move", ({ x, y }) => {
    const code = socket.data.room;
    const room = rooms[code];
    const p = room?.players[socket.id];

    if (!p || !p.alive || room.phase !== "playing") return;

    p.x = Math.max(15, Math.min(585, Number(x) || p.x));
    p.y = Math.max(15, Math.min(385, Number(y) || p.y));
    sendState(code);
  });

  socket.on("task", () => {
    const code = socket.data.room;
    const room = rooms[code];
    const p = room?.players[socket.id];

    if (!p || !p.alive || p.role !== "crew" ||
        room.phase !== "playing") return;

    p.tasks++;

    const crew = Object.values(room.players)
      .filter(p => p.role === "crew" && p.alive);

    if (crew.length && crew.every(p => p.tasks >= tasksNeeded)) {
      room.phase = "crewWin";
    }

    sendState(code);
  });

  socket.on("kill", targetId => {
    const code = socket.data.room;
    const room = rooms[code];
    const p = room?.players[socket.id];
    const victim = room?.players[targetId];

    if (!p || !victim || p.role !== "impostor" ||
        !p.alive || !victim.alive ||
        room.phase !== "playing" || targetId === socket.id) return;

    if (Math.hypot(p.x - victim.x, p.y - victim.y) > 35) return;

    victim.alive = false;

    const crew = Object.values(room.players).filter(p => p.role === "crew" && p.alive).length;
    const imp = Object.values(room.players).filter(p => p.role === "impostor" && p.alive).length;

    if (imp === 0) room.phase = "crewWin";
    else if (imp >= crew) room.phase = "impWin";

    sendState(code);
  });

  socket.on("meeting", () => {
    const code = socket.data.room;
    const room = rooms[code];
    const p = room?.players[socket.id];

    if (!p || !p.alive || room.phase !== "playing") return;

    room.phase = "meeting";
    room.votes = {};
    sendState(code);
  });

  socket.on("vote", targetId => {
    const code = socket.data.room;
    const room = rooms[code];
    const p = room?.players[socket.id];

    if (!room || room.phase !== "meeting" || !p ||
        !p.alive || room.votes[socket.id]) return;

    if (targetId !== "skip" && !room.players[targetId]) return;

    room.votes[socket.id] = targetId;

    const living = Object.entries(room.players)
      .filter(([, player]) => player.alive);

    if (living.every(([id]) => room.votes[id])) {
      finishMeeting(code);
    } else {
      sendState(code);
    }
  });

  socket.on("reset", () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;

    room.phase = "lobby";
    room.votes = {};
    room.impostor = null;

    for (const p of Object.values(room.players)) {
      p.role = "crew";
      p.alive = true;
      p.tasks = 0;
    }

    sendState(code);
  });

  socket.on("disconnect", () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;

    delete room.players[socket.id];

    if (Object.keys(room.players).length === 0) {
      delete rooms[code];
    } else {
      sendState(code);
    }
  });
});

server.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("Space Sus server started");
});
