const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const allowedOrigins = ["http://localhost:3000", "http://172.25.32.1:3000","https://ar-deathmatch-frontend.vercel.app","https://ar-deathmatch-frontend-rithvickkrs-projects.vercel.app"];
app.use(cors({ origin: allowedOrigins, methods: ["GET", "POST"] }));
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
});

app.get("/", (req, res) => {
    res.send("🟢  backend is alive!");
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
        players[socket.id].ready = true;
        const playerList = Object.values(players);
        io.emit("playerUpdate", playerList);

        if (playerList.length === 2 && playerList.every((p) => p.ready)) {
            console.log("Game is ready!");
        }
    });

    socket.on("shoot", ({ shooterId, damage }) => {
        console.log("Shoot received:", { shooterId, damage });
        const targetId = Object.keys(players).find((id) => id !== shooterId);
        if (targetId && players[targetId].health > 0) {
            players[targetId].health -= damage;
            console.log(`Player ${shooterId} shot ${targetId} for ${damage} damage`);
            if (players[targetId].health <= 0) {
                console.log(`Player ${targetId} is dead!`);
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