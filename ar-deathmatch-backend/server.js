const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const allowedOrigins = [
  "http://localhost:3000",
  "http://172.25.32.1:3000",
  "https://ar-deathmatch-frontend.vercel.app",
  "https://ar-deathmatch-frontend-rithvickkrs-projects.vercel.app",
];
app.use(cors({ origin: allowedOrigins, methods: ["GET", "POST"] }));
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
});

app.get("/", (req, res) => {
  res.send("🟢 backend is alive!");
});

const players = {};

io.on("connection", (socket) => {
  if (Object.keys(players).length >= 2) {
    socket.emit("gameFull");
    socket.disconnect();
    return;
  }

  console.log("Player connected:", socket.id);
  players[socket.id] = { id: socket.id, health: 100, ready: false };

  socket.on("joinGame", () => {
    const playerList = Object.values(players);
    io.emit("playerUpdate", playerList);
  });

  socket.on("setReady", ({ playerId, ready }) => {
    console.log(`Player ${playerId} set ready: ${ready}`);
    if (players[playerId]) {
      players[playerId].ready = ready;
      const playerList = Object.values(players);
      io.emit("playerUpdate", playerList);
    }
  });

  socket.on("shoot", ({ shooterId, damage, targetId }) => {
    console.log("Shoot received:", { shooterId, damage, targetId });
    if (targetId && players[targetId] && players[targetId].health > 0) {
      players[targetId].health -= damage;
      console.log(`Player ${shooterId} shot ${targetId} for ${damage} damage`);
      // Notify target of damage for blood effect
      io.to(targetId).emit("damageTaken", { playerId: targetId });
      if (players[targetId].health <= 0) {
        console.log(`Player ${targetId} is dead!`);
        for (const id in players) {
          players[id].ready = false;
        }
        io.emit("gameOver", { winner: shooterId });
      }
      io.emit("playerUpdate", Object.values(players));
    } else {
      console.log("No valid target or target already dead");
    }
  });

  socket.on("resetGame", () => {
    console.log("Resetting game...");
    for (const id in players) {
      players[id].health = 100;
      players[id].ready = false;
    }
    io.emit("playerUpdate", Object.values(players));
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    delete players[socket.id];
    io.emit("playerUpdate", Object.values(players));
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});