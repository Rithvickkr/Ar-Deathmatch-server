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

app.get("/rooms", (req, res) => {
  const roomList = Object.keys(rooms).map(code => ({
    code,
    playerCount: Object.keys(rooms[code].players).length,
    createdAt: new Date(rooms[code].createdAt).toISOString(),
    players: Object.values(rooms[code].players).map(p => ({
      id: p.id.slice(0, 8),
      isHost: p.isHost,
      ready: p.ready
    }))
  }));
  
  res.json({
    totalRooms: roomList.length,
    rooms: roomList
  });
});

app.get("/", (req, res) => {
  res.send("🟢 backend is alive!");
});

const rooms = {}; // Store all game rooms
const playerRooms = {}; // Track which room each player is in
const disconnectedPlayers = {}; // Track recently disconnected players for reconnection
const playerSessions = {}; // Track player session info for reconnection

// Generate a random 6-character room code
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms[code]); // Ensure unique code
  return code;
}

// Clean up empty rooms with more conservative approach
function cleanupRoom(roomCode) {
  if (rooms[roomCode] && Object.keys(rooms[roomCode].players).length === 0) {
    // Only clean up rooms that are older than 2 minutes and empty, unless there are disconnected players
    const roomAge = Date.now() - rooms[roomCode].createdAt;
    const hasDisconnectedPlayers = Object.values(disconnectedPlayers).some(p => p.roomCode === roomCode);
    
    if (roomAge > 120000 && !hasDisconnectedPlayers) { // 2 minutes
      delete rooms[roomCode];
      console.log(`Room ${roomCode} cleaned up - was empty for 2+ minutes with no disconnected players`);
    } else {
      console.log(`Room ${roomCode} not cleaned up - age: ${Math.round(roomAge/1000)}s, has disconnected players: ${hasDisconnectedPlayers}`);
    }
  }
}

// Debug function to list all active rooms
function listActiveRooms() {
  console.log("=== Active Rooms ===");
  Object.keys(rooms).forEach(code => {
    const room = rooms[code];
    console.log(`Room ${code}: ${Object.keys(room.players).length} players`);
    Object.values(room.players).forEach(player => {
      console.log(`  - ${player.id} (${player.isHost ? 'Host' : 'Guest'})`);
    });
  });
  console.log("==================");
}

// Handle player reconnection
function handleReconnection(socket) {
  const disconnectedPlayer = disconnectedPlayers[socket.id];
  if (disconnectedPlayer) {
    const { roomCode, playerData } = disconnectedPlayer;
    if (rooms[roomCode]) {
      // Restore player to their room
      rooms[roomCode].players[socket.id] = playerData;
      playerRooms[socket.id] = roomCode;
      socket.join(roomCode);
      
      console.log(`Player ${socket.id} reconnected to room ${roomCode} as ${playerData.isHost ? 'host' : 'guest'}`);
      
      // Notify about rejoining
      if (playerData.isHost) {
        socket.emit("roomCreated", { roomCode });
      } else {
        socket.emit("roomJoined", { roomCode });
      }
      
      // Send updated player list
      io.to(roomCode).emit("playerUpdate", Object.values(rooms[roomCode].players));
      
      // Clear from disconnected players
      delete disconnectedPlayers[socket.id];
      return true;
    }
  }
  return false;
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  // Check if this is a reconnection
  const wasReconnected = handleReconnection(socket);
  if (wasReconnected) {
    console.log("Player successfully reconnected");
    return; // Skip normal connection setup since player was restored
  }

  // Handle room creation
  socket.on("createRoom", () => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode,
      players: {},
      createdAt: Date.now(),
      gameState: "waiting"
    };
    
    // Add player to the new room
    rooms[roomCode].players[socket.id] = { 
      id: socket.id, 
      health: 100, 
      ready: false,
      isHost: true 
    };
    playerRooms[socket.id] = roomCode;
    socket.join(roomCode);
    
    console.log(`Room ${roomCode} created by ${socket.id}`);
    console.log(`Host player data:`, rooms[roomCode].players[socket.id]);
    listActiveRooms(); // Debug: show all active rooms
    
    socket.emit("roomCreated", { roomCode });
    
    const playersData = Object.values(rooms[roomCode].players);
    console.log(`Sending initial playerUpdate to host with ${playersData.length} players`);
    socket.emit("playerUpdate", playersData);
  });

  // Handle room joining
  socket.on("joinRoom", ({ roomCode }) => {
    console.log(`Player ${socket.id} attempting to join room ${roomCode}`);
    listActiveRooms(); // Debug: show all active rooms before join attempt
    
    if (!roomCode || !rooms[roomCode]) {
      console.log(`Join failed: Room ${roomCode} not found`);
      console.log("Available rooms:", Object.keys(rooms));
      socket.emit("joinError", { message: "Room not found" });
      return;
    }
    
    const room = rooms[roomCode];
    
    if (Object.keys(room.players).length >= 2) {
      console.log(`Join failed: Room ${roomCode} is full`);
      socket.emit("joinError", { message: "Room is full" });
      return;
    }
    
    // Add player to room
    room.players[socket.id] = { 
      id: socket.id, 
      health: 100, 
      ready: false,
      isHost: false 
    };
    playerRooms[socket.id] = roomCode;
    socket.join(roomCode);
    
    console.log(`Player ${socket.id} successfully joined room ${roomCode}`);
    console.log(`Room ${roomCode} now has players:`, Object.keys(room.players));
    console.log(`Player data:`, Object.values(room.players));
    listActiveRooms(); // Debug: show all active rooms after join
    
    socket.emit("roomJoined", { roomCode });
    
    // Send update to all players in the room
    const playersData = Object.values(room.players);
    console.log(`Sending playerUpdate to room ${roomCode} with ${playersData.length} players`);
    io.to(roomCode).emit("playerUpdate", playersData);
  });

  socket.on("joinGame", () => {
    // Legacy support - create or join a default room
    const defaultRoom = "DEFAULT";
    if (!rooms[defaultRoom]) {
      rooms[defaultRoom] = {
        code: defaultRoom,
        players: {},
        createdAt: Date.now(),
        gameState: "waiting"
      };
    }
    
    if (Object.keys(rooms[defaultRoom].players).length >= 2) {
      socket.emit("gameFull");
      socket.disconnect();
      return;
    }
    
    rooms[defaultRoom].players[socket.id] = { 
      id: socket.id, 
      health: 100, 
      ready: false,
      isHost: Object.keys(rooms[defaultRoom].players).length === 0 
    };
    playerRooms[socket.id] = defaultRoom;
    socket.join(defaultRoom);
    
    const playerList = Object.values(rooms[defaultRoom].players);
    io.to(defaultRoom).emit("playerUpdate", playerList);
  });

  socket.on("setReady", ({ playerId, ready }) => {
    console.log(`Player ${playerId} set ready: ${ready}`);
    const roomCode = playerRooms[playerId];
    if (roomCode && rooms[roomCode] && rooms[roomCode].players[playerId]) {
      rooms[roomCode].players[playerId].ready = ready;
      const playerList = Object.values(rooms[roomCode].players);
      io.to(roomCode).emit("playerUpdate", playerList);
    }
  });

  socket.on("shoot", ({ shooterId, damage }) => {
    console.log("Shoot received:", { shooterId, damage });
    const roomCode = playerRooms[shooterId];
    if (!roomCode || !rooms[roomCode]) return;
    
    const room = rooms[roomCode];
    const targetId = Object.keys(room.players).find((id) => id !== shooterId);
    
    if (targetId && room.players[targetId].health > 0) {
      room.players[targetId].health -= damage;
      console.log(`Player ${shooterId} shot ${targetId} for ${damage} damage in room ${roomCode}`);
      
      if (room.players[targetId].health <= 0) {
        console.log(`Player ${targetId} is dead!`);
        // Reset ready status for next game
        for (const id in room.players) {
          room.players[id].ready = false;
        }
        io.to(roomCode).emit("gameOver", { winner: shooterId });
      }
      io.to(roomCode).emit("playerUpdate", Object.values(room.players));
    } else {
      console.log("No valid target or target already dead");
    }
  });

  socket.on("resetGame", () => {
    console.log("Resetting game...");
    const roomCode = playerRooms[socket.id];
    if (roomCode && rooms[roomCode]) {
      for (const id in rooms[roomCode].players) {
        rooms[roomCode].players[id].health = 100;
        rooms[roomCode].players[id].ready = false;
      }
      io.to(roomCode).emit("playerUpdate", Object.values(rooms[roomCode].players));
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("Player disconnected:", socket.id, "Reason:", reason);
    const roomCode = playerRooms[socket.id];
    
    if (roomCode && rooms[roomCode]) {
      const playerData = rooms[roomCode].players[socket.id];
      
      if (playerData) {
        // Store disconnected player data for potential reconnection
        disconnectedPlayers[socket.id] = {
          roomCode,
          playerData: { ...playerData },
          disconnectedAt: Date.now()
        };
        
        console.log(`Stored disconnected ${playerData.isHost ? 'host' : 'guest'} ${socket.id} for potential reconnection`);
      }
      
      // Remove from active players but keep room alive
      delete rooms[roomCode].players[socket.id];
      io.to(roomCode).emit("playerUpdate", Object.values(rooms[roomCode].players));
      
      // Clean up disconnected players after 5 minutes
      setTimeout(() => {
        if (disconnectedPlayers[socket.id]) {
          console.log(`Removing disconnected player ${socket.id} from reconnection queue`);
          delete disconnectedPlayers[socket.id];
        }
      }, 300000); // 5 minutes
      
      // Only clean up room after a delay to allow for reconnection
      setTimeout(() => {
        cleanupRoom(roomCode);
      }, 10000); // 10 second delay before cleanup
    }
    
    delete playerRooms[socket.id];
    listActiveRooms(); // Debug: show active rooms after disconnect
  });

  // Debug endpoint to get room info
  socket.on("getRoomInfo", ({ roomCode }) => {
    console.log(`Room info request for: ${roomCode}`);
    if (rooms[roomCode]) {
      socket.emit("roomInfo", {
        code: roomCode,
        players: Object.values(rooms[roomCode].players),
        createdAt: rooms[roomCode].createdAt
      });
    } else {
      socket.emit("roomInfo", { error: "Room not found" });
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});