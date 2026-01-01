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
  /^https:\/\/ar-deathmatch-frontend.*\.vercel\.app$/,
  "*"
];
app.use(cors({ 
  origin: true, // Allow all origins for development
  methods: ["GET", "POST"],
  credentials: true
}));
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { 
    origin: true, // Allow all origins
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['polling', 'websocket'], // Prioritize polling for Vercel
  allowEIO3: true
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
  // Check if any disconnected player matches this socket by looking for the same session
  const potentialMatch = Object.entries(disconnectedPlayers).find(([oldId, data]) => {
    // For development with hot reload, we can't reliably match socket IDs
    // So let's check if there's a recent disconnection in the same room
    return Date.now() - data.disconnectedAt < 60000; // Within 1 minute
  });
  
  if (potentialMatch) {
    const [oldSocketId, disconnectedPlayer] = potentialMatch;
    const { roomCode, playerData } = disconnectedPlayer;
    
    if (rooms[roomCode]) {
      // Update the player ID to the new socket ID
      const updatedPlayerData = { ...playerData, id: socket.id };
      rooms[roomCode].players[socket.id] = updatedPlayerData;
      playerRooms[socket.id] = roomCode;
      
      console.log(`Player reconnected: old ID ${oldSocketId} -> new ID ${socket.id} in room ${roomCode} as ${playerData.isHost ? 'host' : 'guest'}`);
      console.log(`Joining socket ${socket.id} to room ${roomCode}`);
      socket.join(roomCode);
      
      // Notify about rejoining
      if (playerData.isHost) {
        socket.emit("roomCreated", { roomCode });
      } else {
        socket.emit("roomJoined", { roomCode });
      }
      
      // Send updated player list
      const playersData = Object.values(rooms[roomCode].players);
      console.log(`Sending playerUpdate after reconnection with ${playersData.length} players`);
      console.log(`Room ${roomCode} sockets:`, Array.from(io.sockets.adapter.rooms.get(roomCode) || []));
      io.to(roomCode).emit("playerUpdate", playersData);
      
      // Clear from disconnected players
      delete disconnectedPlayers[oldSocketId];
      return true;
    }
  }
  return false;
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);
  
  // Debug: Show current playerRooms state
  console.log("Current playerRooms:", playerRooms);
  console.log("Current disconnectedPlayers:", Object.keys(disconnectedPlayers));

  // Check if this is a reconnection
  const wasReconnected = handleReconnection(socket);
  if (wasReconnected) {
    console.log("Player successfully reconnected");
    return; // Skip normal connection setup since player was restored
  }

  console.log("New connection - no reconnection match found");

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

  socket.on("setReady", ({ playerId, ready, isHost }) => {
    console.log(`=== setReady event received ===`);
    console.log(`Player ID: ${playerId}`);
    console.log(`Ready state: ${ready}`);
    console.log(`Is Host: ${isHost}`);
    console.log(`Socket ID: ${socket.id}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Request origin: ${socket.handshake.headers.origin}`);
    
    // Use the current socket ID for operations since that's who's actually making the request
    const actualSocketId = socket.id;
    let roomCode = playerRooms[actualSocketId];
    
    console.log(`Initial room code lookup: ${roomCode}`);
    console.log(`playerRooms mapping:`, playerRooms);
    
    // If no room mapping found for current socket, try multiple approaches to find it
    if (!roomCode) {
      console.log(`No room mapping found for socket ${actualSocketId}, searching...`);
      
      // Method 1: Check if socket is already in any room
      for (const [code, room] of Object.entries(rooms)) {
        const socketsInRoom = Array.from(io.sockets.adapter.rooms.get(code) || []);
        console.log(`Room ${code} has sockets:`, socketsInRoom);
        if (socketsInRoom.includes(actualSocketId)) {
          roomCode = code;
          playerRooms[actualSocketId] = roomCode;
          console.log(`Method 1: Found socket ${actualSocketId} in room ${roomCode}, updated mapping`);
          break;
        }
      }
      
      // Method 2: If still not found, look for a room with a player matching the host status
      if (!roomCode) {
        console.log(`Method 1 failed, trying method 2...`);
        for (const [code, room] of Object.entries(rooms)) {
          const playersWithSameHostStatus = Object.values(room.players).filter(p => p.isHost === isHost);
          console.log(`Room ${code} has ${playersWithSameHostStatus.length} players with host status ${isHost}`);
          if (playersWithSameHostStatus.length === 1) {
            roomCode = code;
            playerRooms[actualSocketId] = roomCode;
            socket.join(roomCode);
            console.log(`Method 2: Assigned socket ${actualSocketId} to room ${roomCode} based on host status`);
            break;
          }
        }
      }
      
      // Method 3: If still not found, use any existing room mapping and update it
      if (!roomCode) {
        console.log(`Method 2 failed, trying method 3...`);
        const existingMappings = Object.entries(playerRooms);
        if (existingMappings.length > 0) {
          const [oldSocketId, existingRoomCode] = existingMappings[0];
          if (rooms[existingRoomCode]) {
            roomCode = existingRoomCode;
            playerRooms[actualSocketId] = roomCode;
            socket.join(roomCode);
            console.log(`Method 3: Reassigned socket ${actualSocketId} to room ${roomCode} from old mapping ${oldSocketId}`);
          }
        }
      }
    }
    
    console.log(`Final room code: ${roomCode}`);
    
    if (!roomCode) {
      console.error(`❌ setReady failed: No room found for socket ${actualSocketId}`);
      socket.emit("setReadyError", { message: "Room not found" });
      return;
    }
    
    if (!rooms[roomCode]) {
      console.error(`❌ setReady failed: Room ${roomCode} does not exist`);
      socket.emit("setReadyError", { message: "Room does not exist" });
      return;
    }
    
    // Find the player record that matches the host status
    let targetPlayerId = null;
    for (const [pid, player] of Object.entries(rooms[roomCode].players)) {
      if (player.isHost === isHost) {
        targetPlayerId = pid;
        break;
      }
    }
    
    console.log(`Target player ID: ${targetPlayerId}`);
    console.log(`Available players:`, Object.keys(rooms[roomCode].players));
    
    if (!targetPlayerId) {
      console.error(`❌ setReady failed: No player found with host status ${isHost} in room ${roomCode}`);
      console.log(`Available players:`, Object.values(rooms[roomCode].players).map(p => ({ id: p.id, isHost: p.isHost })));
      socket.emit("setReadyError", { message: `Player with host status ${isHost} not found` });
      return;
    }
    
    if (!rooms[roomCode].players[targetPlayerId]) {
      console.error(`❌ setReady failed: Player ${targetPlayerId} not found in room ${roomCode}`);
      socket.emit("setReadyError", { message: "Player not found" });
      return;
    }
    
    console.log(`Found target player ${targetPlayerId} with host status: ${isHost}`);
    
    // If this is a different socket ID, update the player record
    if (targetPlayerId !== actualSocketId) {
      console.log(`Updating player record from ${targetPlayerId} to ${actualSocketId}`);
      const playerData = rooms[roomCode].players[targetPlayerId];
      delete rooms[roomCode].players[targetPlayerId];
      rooms[roomCode].players[actualSocketId] = { ...playerData, id: actualSocketId };
      
      // Clean up old mapping
      delete playerRooms[targetPlayerId];
      playerRooms[actualSocketId] = roomCode;
      targetPlayerId = actualSocketId; // Update the target player ID
    }
    
    // Ensure socket is in the room
    socket.join(roomCode);
    
    console.log(`Setting player ${targetPlayerId} ready state to: ${ready}`);
    const oldReadyState = rooms[roomCode].players[targetPlayerId].ready;
    rooms[roomCode].players[targetPlayerId].ready = ready;
    
    // Verify the update was successful
    const newReadyState = rooms[roomCode].players[targetPlayerId].ready;
    console.log(`Ready state update: ${oldReadyState} → ${newReadyState}`);
    
    if (newReadyState !== ready) {
      console.error(`❌ Failed to update ready state for player ${targetPlayerId}`);
      socket.emit("setReadyError", { message: "Failed to update ready state" });
      return;
    }
    
    const playerList = Object.values(rooms[roomCode].players);
    console.log(`Updated player list:`, playerList.map(p => ({ id: p.id.slice(0, 8), ready: p.ready, isHost: p.isHost })));
    
    console.log(`Room ${roomCode} sockets before emit:`, Array.from(io.sockets.adapter.rooms.get(roomCode) || []));
    
    // Emit to the room and also directly to the requesting socket
    io.to(roomCode).emit("playerUpdate", playerList);
    socket.emit("playerUpdate", playerList); // Ensure the requesting socket gets the update
    
    console.log(`✅ Successfully sent playerUpdate to room ${roomCode}`);
    console.log(`✅ setReady completed successfully for player ${targetPlayerId} (ready: ${ready})`);
  });

  // Add a heartbeat handler to maintain room mappings
  socket.on("heartbeat", () => {
    const roomCode = playerRooms[socket.id];
    if (roomCode && rooms[roomCode] && rooms[roomCode].players[socket.id]) {
      console.log(`💓 Heartbeat from ${socket.id} in room ${roomCode}`);
      socket.emit("heartbeatAck", { roomCode, playerId: socket.id });
    } else {
      console.log(`💔 Heartbeat from unmapped socket ${socket.id}`);
      socket.emit("heartbeatAck", { roomCode: null, playerId: socket.id });
    }
  });

  socket.on("shoot", ({ shooterId, damage }) => {
    console.log("Shoot received:", { shooterId, damage });
    console.log(`Actual sender socket ID: ${socket.id}`);
    
    const actualShooterId = socket.id;
    
    // Try to find room via playerRooms mapping
    let roomCode = playerRooms[actualShooterId];
    console.log(`Shooter ${actualShooterId} room code: ${roomCode}`);
    
    // If not found, this is a hot reload case - find any active room and join
    if (!roomCode) {
      console.log(`🔧 Hot reload detected - finding any active room for shooter`);
      
      // Find the first room with players in "ready" or "playing" state
      for (const [code, room] of Object.entries(rooms)) {
        const playerIds = Object.keys(room.players);
        
        if (playerIds.length > 0) {
          console.log(`🎯 Found active room ${code} with ${playerIds.length} players`);
          
          // Check if this socket is already one of the players (different ID due to hot reload)
          // Find the current frontend session by checking socket rooms that aren't the socket ID itself
          const shooterRooms = Array.from(socket.rooms).filter(r => r !== actualShooterId);
          console.log(`Shooter is in rooms: ${shooterRooms}`);
          
          // If the shooter is in this room via socket rooms, update the mapping
          if (shooterRooms.includes(code)) {
            roomCode = code;
            playerRooms[actualShooterId] = roomCode;
            console.log(`✅ Updated playerRooms mapping for existing room member`);
            break;
          }
          
          // If no existing room membership but this is the only/main active room,
          // treat the shooter as one of the existing players (hot reload scenario)
          if (!roomCode && playerIds.length <= 2) {
            roomCode = code;
            playerRooms[actualShooterId] = roomCode;
            
            // Ensure socket is in the room
            if (!socket.rooms.has(code)) {
              socket.join(code);
              console.log(`🚪 Joined socket ${actualShooterId} to room ${code}`);
            }
            
            console.log(`✅ Assigned shooter to active room ${code}`);
            break;
          }
        }
      }
    }
    
    if (!roomCode || !rooms[roomCode]) {
      console.log(`❌ Still no room found for shooter ${actualShooterId}`);
      console.log(`Available rooms:`, Object.keys(rooms));
      return;
    }
    
    const room = rooms[roomCode];
    console.log(`✅ Using room ${roomCode} for shooting`);
    console.log(`All players in room:`, Object.keys(room.players));
    console.log(`Shooter socket ID: ${actualShooterId}`);
    
    // Check if the shooter is actually one of the existing players (hot reload case)
    let shooterPlayerRecord = null;
    let targetPlayerRecord = null;
    
    const connectedSockets = Array.from(io.sockets.adapter.rooms.get(roomCode) || []);
    console.log(`Connected sockets in room: ${connectedSockets}`);
    
    // If shooter socket is in the room but not in player records, 
    // they must be a hot-reloaded version of one of the existing players
    if (connectedSockets.includes(actualShooterId) && !room.players[actualShooterId]) {
      console.log(`🔄 Shooter is hot-reloaded version - finding their original player record`);
      
      // Check if any existing player IDs are NOT in the connected sockets (disconnected)
      const playerIds = Object.keys(room.players);
      const disconnectedPlayerIds = playerIds.filter(id => !connectedSockets.includes(id));
      
      console.log(`Disconnected player IDs: ${disconnectedPlayerIds}`);
      
      // If no clear disconnected players, but we have more sockets than players,
      // this means hot reload created new sockets. Assign the shooter to the first player
      if (disconnectedPlayerIds.length === 0 && connectedSockets.length > playerIds.length) {
        console.log(`🔧 Hot reload detected: more sockets than players, assigning shooter to host player`);
        
        // Find the host player (assuming this is the original creator who's been hot reloading)
        const hostPlayer = Object.values(room.players).find(p => p.isHost);
        if (hostPlayer) {
          console.log(`📝 Assigning shooter ${actualShooterId} as host player (replacing ${hostPlayer.id})`);
          
          // Replace host player with new shooter socket
          delete room.players[hostPlayer.id];
          room.players[actualShooterId] = { ...hostPlayer, id: actualShooterId };
          
          // Clean up old playerRooms mapping
          if (playerRooms[hostPlayer.id]) {
            delete playerRooms[hostPlayer.id];
          }
          
          console.log(`✅ Updated player records - shooter is now host`);
          
          // Send updated player list
          const playersData = Object.values(room.players);
          io.to(roomCode).emit("playerUpdate", playersData);
        }
      } else if (disconnectedPlayerIds.length > 0) {
        // Replace the disconnected player with the new shooter
        const oldPlayerId = disconnectedPlayerIds[0];
        shooterPlayerRecord = room.players[oldPlayerId];
        
        console.log(`📝 Replacing ${oldPlayerId} with ${actualShooterId}`);
        
        // Transfer player data to new ID
        delete room.players[oldPlayerId];
        room.players[actualShooterId] = { ...shooterPlayerRecord, id: actualShooterId };
        
        // Clean up old playerRooms mapping
        if (playerRooms[oldPlayerId]) {
          delete playerRooms[oldPlayerId];
        }
        
        console.log(`✅ Updated player records`);
        
        // Send updated player list
        const playersData = Object.values(room.players);
        io.to(roomCode).emit("playerUpdate", playersData);
      }
    }
    
    // Now find the target (the other player that's NOT the shooter)
    const allPlayerIds = Object.keys(room.players);
    console.log(`All players in room after processing: ${allPlayerIds}`);
    console.log(`Shooter ID: ${actualShooterId}`);
    
    // Filter out the shooter to get potential targets
    const potentialTargets = allPlayerIds.filter(id => id !== actualShooterId);
    console.log(`Potential targets: ${potentialTargets}`);
    
    if (potentialTargets.length === 0) {
      console.log(`❌ No other players found to target`);
      return;
    }
    
    const targetId = potentialTargets[0]; // Take the first (and should be only) other player
    
    if (!targetId || !room.players[targetId]) {
      console.log(`❌ No valid target found in room ${roomCode}`);
      console.log(`Players in room after update:`, Object.keys(room.players));
      console.log(`Shooter ID: ${actualShooterId}`);
      return;
    }
    
    console.log(`🎯 Target identified: ${targetId}`);
    console.log(`🎯 Target isHost: ${room.players[targetId].isHost}, health: ${room.players[targetId].health}`);
    console.log(`👤 Shooter isHost: ${room.players[actualShooterId] ? room.players[actualShooterId].isHost : 'unknown'}, health: ${room.players[actualShooterId] ? room.players[actualShooterId].health : 'unknown'}`);
    
    // Additional safety check: make sure we're not targeting ourselves
    if (targetId === actualShooterId) {
      console.log(`❌ ERROR: Target is same as shooter! This would be self-damage.`);
      console.log(`Shooter: ${actualShooterId}`);
      console.log(`Target: ${targetId}`);
      return;
    }
    
    // Verify players have different roles (one should be host, one guest)
    if (room.players[actualShooterId] && room.players[targetId]) {
      const shooterIsHost = room.players[actualShooterId].isHost;
      const targetIsHost = room.players[targetId].isHost;
      
      console.log(`🔍 Role check - Shooter isHost: ${shooterIsHost}, Target isHost: ${targetIsHost}`);
      
      if (shooterIsHost === targetIsHost) {
        console.log(`⚠️ WARNING: Both players have same host status (${shooterIsHost})`);
        // Don't return here - still allow the shot for now, but log the issue
      } else {
        console.log(`✅ Confirmed: Shooter (host: ${shooterIsHost}) targeting enemy (host: ${targetIsHost})`);
      }
    }
    
    if (room.players[targetId].health <= 0) {
      console.log(`❌ Target ${targetId} is already dead`);
      return;
    }
    
    console.log(`💥 Applying ${damage} damage to ${targetId} (current health: ${room.players[targetId].health})`);
    
    room.players[targetId].health = Math.max(0, room.players[targetId].health - damage);
    
    console.log(`🩺 Target health after damage: ${room.players[targetId].health}`);
    
    // Check game over
    if (room.players[targetId].health <= 0) {
      console.log(`🏁 Game over! ${targetId} eliminated by ${actualShooterId}`);
      room.gameState = "ended";
      
      // Reset ready states
      Object.values(room.players).forEach(p => p.ready = false);
      
      // Get winner's role for frontend to determine victory/defeat
      const winnerRole = room.players[actualShooterId] ? room.players[actualShooterId].isHost : null;
      console.log(`Winner ${actualShooterId} is host: ${winnerRole}`);
      
      io.to(roomCode).emit("gameOver", { 
        winner: actualShooterId, 
        winnerIsHost: winnerRole 
      });
    }
    
    // Send updated player data
    const playersData = Object.values(room.players);
    console.log(`📡 Sending health update:`, playersData.map(p => ({ id: p.id, health: p.health })));
    io.to(roomCode).emit("playerUpdate", playersData);
  });

  socket.on("leaveRoom", () => {
    console.log(`Player ${socket.id} intentionally leaving room`);
    const roomCode = playerRooms[socket.id];
    
    if (roomCode && rooms[roomCode]) {
      console.log(`Removing player ${socket.id} from room ${roomCode}`);
      
      // Remove from active players
      delete rooms[roomCode].players[socket.id];
      
      // Remove from player rooms mapping  
      delete playerRooms[socket.id];
      
      // Remove from disconnected players to prevent reconnection
      delete disconnectedPlayers[socket.id];
      
      // Leave the socket room
      socket.leave(roomCode);
      
      // Notify remaining players
      const remainingPlayers = Object.values(rooms[roomCode].players);
      if (remainingPlayers.length > 0) {
        io.to(roomCode).emit("playerUpdate", remainingPlayers);
      }
      
      // Clean up empty room
      setTimeout(() => {
        cleanupRoom(roomCode);
      }, 1000);
      
      console.log(`Player ${socket.id} successfully left room ${roomCode}`);
    }
  });

  socket.on("resetGame", () => {
    console.log("=== resetGame event received ===");
    console.log(`Socket ID: ${socket.id}`);
    
    const actualSocketId = socket.id;
    let roomCode = playerRooms[actualSocketId];
    
    console.log(`Initial room code lookup: ${roomCode}`);
    console.log(`playerRooms mapping:`, playerRooms);
    
    // If no room mapping found for current socket, try to find it
    if (!roomCode) {
      console.log(`No room mapping found for socket ${actualSocketId}, searching...`);
      
      // Method 1: Check if socket is already in any room
      for (const [code, room] of Object.entries(rooms)) {
        const socketsInRoom = Array.from(io.sockets.adapter.rooms.get(code) || []);
        console.log(`Room ${code} has sockets:`, socketsInRoom);
        if (socketsInRoom.includes(actualSocketId)) {
          roomCode = code;
          playerRooms[actualSocketId] = roomCode;
          console.log(`Method 1: Found socket ${actualSocketId} in room ${roomCode}, updated mapping`);
          break;
        }
      }
      
      // Method 2: If still not found, use any existing room mapping
      if (!roomCode) {
        console.log(`Method 1 failed, trying method 2...`);
        const existingMappings = Object.entries(playerRooms);
        if (existingMappings.length > 0) {
          const [oldSocketId, existingRoomCode] = existingMappings[0];
          if (rooms[existingRoomCode]) {
            roomCode = existingRoomCode;
            playerRooms[actualSocketId] = roomCode;
            socket.join(roomCode);
            console.log(`Method 2: Reassigned socket ${actualSocketId} to room ${roomCode} from old mapping ${oldSocketId}`);
          }
        }
      }
    }
    
    console.log(`Final room code: ${roomCode}`);
    
    if (roomCode && rooms[roomCode]) {
      console.log("Resetting game for room:", roomCode);
      console.log("Players before reset:", Object.values(rooms[roomCode].players).map(p => ({ id: p.id.slice(0, 8), health: p.health, ready: p.ready })));
      
      // Reset player health and ready states for ALL players
      for (const id in rooms[roomCode].players) {
        rooms[roomCode].players[id].health = 100;
        rooms[roomCode].players[id].ready = false;
      }
      
      // Reset game state back to waiting
      rooms[roomCode].gameState = "waiting";
      
      console.log("Players after reset:", Object.values(rooms[roomCode].players).map(p => ({ id: p.id.slice(0, 8), health: p.health, ready: p.ready })));
      console.log("Game reset complete, sending player update");
      
      const playersData = Object.values(rooms[roomCode].players);
      io.to(roomCode).emit("playerUpdate", playersData);
    } else {
      console.log(`Failed to reset game - room: ${roomCode}, roomExists: ${!!rooms[roomCode]}`);
      console.log(`Available rooms:`, Object.keys(rooms));
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