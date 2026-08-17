const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let currentPort = parseInt(process.env.PORT, 10) || 3000;

// Security & Permissions Policy for WebXR & Geolocation on Mobile Chrome / Tunnels
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(self "*"), camera=(self "*"), xr-spatial-tracking=(self "*"), accelerometer=(self "*"), gyroscope=(self "*"), magnetometer=(self "*")'
  );
  res.setHeader('bypass-tunnel-reminder', 'true');
  next();
});

// Serve static files from 'public'
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store for footsteps and restaurant POIs
const footsteps = [];
const restaurantPois = [];
const PROXIMITY_THRESHOLD_METERS = 2.5;

/**
 * Calculate Great-Circle Distance (Haversine Formula) in meters
 */
function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate forward azimuth/bearing in degrees [0, 360)
 */
function calculateBearing(lat1, lon1, lat2, lon2) {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Recalculate density for all footsteps in memory using Spatial Hash Grid (O(N))
 */
function recalculateAllDensities() {
  const cellSize = 0.00003; // ~3.3m spatial grid cell
  const grid = new Map();

  for (let i = 0; i < footsteps.length; i++) {
    const step = footsteps[i];
    const cx = Math.floor(step.lng / cellSize);
    const cy = Math.floor(step.lat / cellSize);
    const key = `${cx}_${cy}`;
    let list = grid.get(key);
    if (!list) {
      list = [];
      grid.set(key, list);
    }
    list.push(i);
  }

  for (let i = 0; i < footsteps.length; i++) {
    const step = footsteps[i];
    const cx = Math.floor(step.lng / cellSize);
    const cy = Math.floor(step.lat / cellSize);
    let count = 0;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = grid.get(`${cx + dx}_${cy + dy}`);
        if (list) {
          for (let k = 0; k < list.length; k++) {
            const j = list[k];
            const other = footsteps[j];
            const dist = getDistanceMeters(step.lat, step.lng, other.lat, other.lng);
            if (dist <= PROXIMITY_THRESHOLD_METERS) {
              count++;
            }
          }
        }
      }
    }
    step.density = Math.min(15, count);
  }
}

/**
 * Generate Shibuya Dummy Footprints & Restaurant Dwell Data
 * Target: ~150 - 200 distinct dots with realistic density variations across key routes
 */
function generateShibuyaDummyData() {
  console.log('[Init] Generating Shibuya thermography point cloud & restaurant dwell spots...');
  footsteps.length = 0;
  restaurantPois.length = 0;

  // 1. Define Dummy Restaurant POIs in Shibuya alleys / shopping areas (7 spots)
  const dummyRestaurants = [
    { id: 'rest_1', name: 'Shibuya Alley Diner', lat: 35.65985, lng: 139.70010 }, // Near Center-gai entrance
    { id: 'rest_2', name: 'Miyashita Park Terrace Cafe', lat: 35.66120, lng: 139.70210 }, // Miyashita Park
    { id: 'rest_3', name: 'Dogenzaka Ramen Bar', lat: 35.65940, lng: 139.69780 }, // Dogenzaka alley
    { id: 'rest_4', name: 'Sakuragaoka Coffee House', lat: 35.65750, lng: 139.70120 }, // Sakuragaoka
    { id: 'rest_5', name: 'Hikarie Sky Bistro', lat: 35.65890, lng: 139.70320 }, // Hikarie side
    { id: 'rest_6', name: 'Inokashira Izakaya', lat: 35.65820, lng: 139.69910 }, // Near Inokashira line
    { id: 'rest_7', name: 'Udagawacho Craft Burger', lat: 35.66180, lng: 139.69850 }, // Udagawa-cho
  ];

  restaurantPois.push(...dummyRestaurants);

  // 2. Define Key Shibuya Pedestrian Routes designed for ~170-180 total points
  const routes = [
    // Route A: Scramble Crossing & Hachiko Plaza (High Density Hotspot - ~65 dots)
    {
      points: [
        { lat: 35.65908, lng: 139.70062 }, // Hachiko Plaza
        { lat: 35.65930, lng: 139.70050 }, // Crossing approach
        { lat: 35.65948, lng: 139.70040 }, // Scramble center
        { lat: 35.65970, lng: 139.70028 }, // TSUTAYA/QFRONT approach
        { lat: 35.65985, lng: 139.70015 }, // Center-gai mouth
      ],
      numWalkers: 3,
      stepSpacing: 6.5,
    },
    // Route B: Station to 109 & Dogenzaka (Medium-High Density - ~45 dots)
    {
      points: [
        { lat: 35.65910, lng: 139.70070 }, // Station Hachiko Gate
        { lat: 35.65935, lng: 139.70015 }, // West crosswalk
        { lat: 35.65955, lng: 139.69930 }, // Towards SHIBUYA 109
        { lat: 35.65958, lng: 139.69850 }, // Dogenzaka Fork
        { lat: 35.65945, lng: 139.69775 }, // Dogenzaka alley near Restaurant 3
      ],
      numWalkers: 2,
      stepSpacing: 8.5,
    },
    // Route C: Scramble towards Miyashita Park (Medium-Low Density - ~35 dots)
    {
      points: [
        { lat: 35.65980, lng: 139.70030 }, // QFRONT
        { lat: 35.66035, lng: 139.70110 }, // Seibu / Jinnan junction
        { lat: 35.66090, lng: 139.70170 }, // Miyashita Park South
        { lat: 35.66125, lng: 139.70215 }, // Miyashita Park Terrace Cafe near Restaurant 2
      ],
      numWalkers: 2,
      stepSpacing: 11.0,
    },
    // Route D: Station to Shibuya Hikarie (Medium Density - ~25 dots)
    {
      points: [
        { lat: 35.65880, lng: 139.70120 }, // East Exit Walkway
        { lat: 35.65885, lng: 139.70220 }, // Pedestrian Deck
        { lat: 35.65892, lng: 139.70325 }, // Hikarie 2F Plaza near Restaurant 5
      ],
      numWalkers: 2,
      stepSpacing: 11.5,
    },
  ];

  let dummyUserIdCounter = 1;

  routes.forEach((route) => {
    for (let w = 0; w < route.numWalkers; w++) {
      const uId = `dummy_user_${dummyUserIdCounter++}`;
      const lateralOffsetMeters = (w - (route.numWalkers - 1) / 2) * 0.5; // slight lateral offset per walker

      // Interpolate along waypoints
      for (let i = 0; i < route.points.length - 1; i++) {
        const p1 = route.points[i];
        const p2 = route.points[i + 1];
        const dist = getDistanceMeters(p1.lat, p1.lng, p2.lat, p2.lng);
        const bearing = calculateBearing(p1.lat, p1.lng, p2.lat, p2.lng);
        const stepsCount = Math.max(1, Math.floor(dist / route.stepSpacing));

        for (let s = 0; s < stepsCount; s++) {
          const frac = s / stepsCount;
          let lat = p1.lat + (p2.lat - p1.lat) * frac;
          let lng = p1.lng + (p2.lng - p1.lng) * frac;

          // Apply slight random lateral scatter (±15cm)
          const scatter = (Math.random() - 0.5) * 0.3 + lateralOffsetMeters;
          const perpBearing = (bearing + 90) * (Math.PI / 180);
          const dLatScatter = (scatter * Math.cos(perpBearing)) / 111320;
          const dLngScatter =
            (scatter * Math.sin(perpBearing)) / (111320 * Math.cos((lat * Math.PI) / 180));

          lat += dLatScatter;
          lng += dLngScatter;

          footsteps.push({
            id: `dummy_step_${crypto.randomUUID()}`,
            userId: uId,
            lat,
            lng,
            heading: bearing,
            timestamp: Date.now() - Math.floor(Math.random() * 3600000),
            density: 1, // Will be computed
            isRightFoot: s % 2 === 0 ? 1 : 0,
            isDwell: false,
          });
        }
      }
    }
  });

  // 3. Add 2-minute Dwell Footprints at 4 Restaurant spots (~8 dots)
  const dwellRestaurants = [dummyRestaurants[0], dummyRestaurants[1], dummyRestaurants[2], dummyRestaurants[4]];
  dwellRestaurants.forEach((rest, idx) => {
    for (let k = 0; k < 2; k++) {
      const offsetLat = (Math.random() - 0.5) * 0.00003;
      const offsetLng = (Math.random() - 0.5) * 0.00003;
      footsteps.push({
        id: `dwell_step_${rest.id}_${k}`,
        userId: `dwell_user_${idx + 1}`,
        lat: rest.lat + offsetLat,
        lng: rest.lng + offsetLng,
        heading: Math.floor(Math.random() * 360),
        timestamp: Date.now() - (120000 + k * 10000),
        density: 1,
        isRightFoot: 1,
        isDwell: true,
        restaurantId: rest.id,
        dwellDurationSec: 120 + Math.floor(Math.random() * 180), // 2 to 5 minutes
      });
    }
  });

  // 4. Calculate accurate densities for all generated dots
  recalculateAllDensities();

  console.log(`[Init] Generated ${footsteps.length} total footsteps across Shibuya (including dwell records).`);
}

/**
 * Process newly received footsteps from clients
 */
function processNewFootsteps(newSteps, userId) {
  const processed = [];
  const updatedExisting = [];

  for (const step of newSteps) {
    const id = crypto.randomUUID();
    let density = 1;

    for (const existing of footsteps) {
      const dist = getDistanceMeters(step.lat, step.lng, existing.lat, existing.lng);
      if (dist <= PROXIMITY_THRESHOLD_METERS) {
        density++;
        existing.density = Math.min(15, (existing.density || 1) + 1);
        if (!updatedExisting.some((s) => s.id === existing.id)) {
          updatedExisting.push(existing);
        }
      }
    }

    const savedStep = {
      id,
      userId,
      lng: step.lng,
      lat: step.lat,
      heading: step.heading || 0,
      timestamp: step.timestamp || Date.now(),
      density: Math.min(15, density),
      isRightFoot: step.isRightFoot !== undefined ? step.isRightFoot : 1,
      isDwell: !!step.isDwell,
      restaurantId: step.restaurantId || null,
      dwellDurationSec: step.dwellDurationSec || 0,
    };

    footsteps.push(savedStep);
    processed.push(savedStep);
  }

  // Limit memory buffer to 30,000 steps
  if (footsteps.length > 30000) {
    footsteps.splice(0, footsteps.length - 30000);
  }

  return { processed, updatedExisting };
}

function broadcast(data, excludeWs = null) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// WebSocket Connection Handler
wss.on('connection', (ws) => {
  const userId = 'user_' + Math.random().toString(36).substring(2, 9);
  console.log(`[WS] Client connected: ${userId} (Active: ${wss.clients.size})`);

  // Initial handshake: send current userId, footsteps, and restaurant POIs
  ws.send(
    JSON.stringify({
      type: 'init',
      userId,
      footsteps: footsteps,
      restaurants: restaurantPois,
    })
  );

  ws.on('message', (messageBuffer) => {
    try {
      const data = JSON.parse(messageBuffer.toString());

      if (data.type === 'footsteps' && Array.isArray(data.steps) && data.steps.length > 0) {
        const { processed, updatedExisting } = processNewFootsteps(data.steps, userId);

        const broadcastPayload = {
          type: 'new_footsteps',
          steps: processed,
          updated: updatedExisting,
        };

        const payloadStr = JSON.stringify(broadcastPayload);
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(payloadStr);
          }
        });
      } else if (data.type === 'clear') {
        footsteps.length = 0;
        broadcast({ type: 'clear' });
        console.log(`[WS] Footsteps cleared by ${userId}`);
      }
    } catch (err) {
      console.error('[WS] Error processing message:', err);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${userId} (Active: ${wss.clients.size - 1})`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Client error (${userId}):`, err);
  });
});

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

wss.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error('[WSS] Server error:', err);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[WARN] Port ${currentPort} is busy. Trying port ${currentPort + 1}...`);
    currentPort += 1;
    setTimeout(() => {
      server.listen(currentPort, '0.0.0.0');
    }, 200);
  } else {
    console.error('[ERROR] Server error:', err);
  }
});

server.on('listening', () => {
  const localIp = getLocalIpAddress();
  console.log(`====================================================`);
  console.log(`🚀 FootStepCollector Server running!`);
  console.log(`📍 Local URL:   http://localhost:${currentPort}`);
  console.log(`📱 LAN Wi-Fi:   http://${localIp}:${currentPort}`);
  console.log(`🌐 HTTPS Tunnel Command:`);
  console.log(`   npx cloudflared tunnel --url http://localhost:${currentPort}`);
  console.log(`====================================================`);
});

generateShibuyaDummyData();
server.listen(currentPort, '0.0.0.0');
