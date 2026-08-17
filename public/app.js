/**
 * FootStep AR & Thermography Map Sync - Client Application Logic
 * Non-Verbal UI | CartoDB Positron Map | Thermography Circle Dot Point Cloud
 * GPS Moving Average + 1.5m Stationary Guard + Turf.js 0.8m Interpolation (±15cm jitter)
 * 2-Minute Dwell Detection (isDwell: true) & Green Dining Highlights
 * Three.js + WebXR Hit-test Ground Placement & 10m Proximity Culling
 */

(function () {
  'use strict';

  // =========================================================================
  // 1. Constants & Configuration
  // =========================================================================
  const STEP_INTERVAL_METERS = 0.8; // 0.8m step interpolation
  const LATERAL_JITTER_METERS = 0.15; // ±15cm random scatter
  const STATIONARY_GUARD_METERS = 1.5; // 1.5m movement threshold to generate steps
  const DWELL_RADIUS_METERS = 3.0; // 3.0m stationary zone for dwell tracking
  const DWELL_TIME_THRESHOLD_MS = 120000; // 2 minutes (120 seconds)
  const AR_MAX_RENDER_DISTANCE = 10.0; // 10m proximity culling in AR
  const GPS_SMOOTH_WINDOW_SIZE = 5;
  const MAP_THROTTLE_MS = 250;
  const AR_UPDATE_THROTTLE_MS = 100;

  // Shibuya Station default coordinates (Hachiko / Scramble Crossing)
  const DEFAULT_LAT = 35.6591;
  const DEFAULT_LNG = 139.7006;

  // CartoDB Positron GL Style (Minimal Grayscale Map)
  const CARTO_POSITRON_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

  // Fallback Raster Positron Style
  const CARTO_POSITRON_RASTER_STYLE = {
    version: 8,
    sources: {
      'carto-positron-raster': {
        type: 'raster',
        tiles: [
          'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        attribution: '&copy; CartoDB, OpenStreetMap',
        maxzoom: 19,
      },
    },
    layers: [
      {
        id: 'carto-background',
        type: 'background',
        paint: {
          'background-color': '#090d16',
        },
      },
      {
        id: 'carto-raster-layer',
        type: 'raster',
        source: 'carto-positron-raster',
        minzoom: 0,
        maxzoom: 24,
      },
    ],
  };

  // =========================================================================
  // 2. Application State
  // =========================================================================
  const state = {
    userId: null,
    myLat: DEFAULT_LAT,
    myLng: DEFAULT_LNG,
    myHeading: 0,
    hasRealGps: false,
    lastInterpolatedGps: null,
    gpsWindow: [],
    footsteps: new Map(),
    restaurants: [],

    // Dwell Tracking State
    dwellAnchor: null, // { lat, lng, startTime, triggered }

    // Toggle States
    showMyFootprints: false, // Default: OFF
    showDiningDwell: false, // Default: OFF
    isArActive: false,

    // WebXR & Sensors
    webxrSession: null,
    cameraStream: null,
    deviceOrientation: {
      compassHeading: 0,
      pitch: 0,
      roll: 0,
      hasSensor: false,
    },
    groundLevelY: -1.3,
  };

  // ENU Coordinate Cache for AR
  let enuCache = new Map();
  let enuCacheOriginLat = null;
  let enuCacheOriginLng = null;
  const ENU_CACHE_INVALIDATION_METERS = 0.5;

  // DOM Elements
  const elMapView = document.getElementById('map-view');
  const elArViewContainer = document.getElementById('ar-view-container');
  const elArCameraFeed = document.getElementById('ar-camera-feed');
  const elArCanvasContainer = document.getElementById('ar-canvas-container');
  const elBtnToggleMine = document.getElementById('btn-toggle-mine');
  const elBtnToggleDining = document.getElementById('btn-toggle-dining');
  const elBtnToggleAr = document.getElementById('btn-toggle-ar');
  const elBtnRecenter = document.getElementById('btn-recenter');

  // =========================================================================
  // 3. WebSocket Real-time Synchronization
  // =========================================================================
  let socket = null;

  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('[WS] Connected to FootStep Server');
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'init':
            state.userId = data.userId;
            if (Array.isArray(data.footsteps)) {
              data.footsteps.forEach((step) => state.footsteps.set(step.id, step));
            }
            if (Array.isArray(data.restaurants)) {
              state.restaurants = data.restaurants;
            }
            scheduleMapUpdate();
            if (state.isArActive) scheduleArUpdate();
            break;

          case 'new_footsteps':
            if (Array.isArray(data.steps)) {
              data.steps.forEach((step) => state.footsteps.set(step.id, step));
            }
            if (Array.isArray(data.updated)) {
              data.updated.forEach((step) => state.footsteps.set(step.id, step));
            }
            scheduleMapUpdate();
            if (state.isArActive) scheduleArUpdate();
            break;

          case 'clear':
            state.footsteps.clear();
            enuCache.clear();
            scheduleMapUpdate();
            if (state.isArActive) scheduleArUpdate();
            break;
        }
      } catch (err) {
        console.error('[WS] Error parsing message:', err);
      }
    };

    socket.onclose = () => {
      setTimeout(initWebSocket, 2000);
    };

    socket.onerror = (err) => {
      console.error('[WS] Socket error:', err);
    };
  }

  function sendFootsteps(steps) {
    if (socket && socket.readyState === WebSocket.OPEN && steps.length > 0) {
      socket.send(
        JSON.stringify({
          type: 'footsteps',
          steps: steps,
        })
      );
    }
  }

  // =========================================================================
  // 4. GPS Smoothing, 1.5m Stationary Guard & 2-Minute Dwell Detection
  // =========================================================================

  function applyMovingAverage(lat, lng) {
    state.gpsWindow.push({ lat, lng });
    if (state.gpsWindow.length > GPS_SMOOTH_WINDOW_SIZE) {
      state.gpsWindow.shift();
    }

    const sum = state.gpsWindow.reduce(
      (acc, curr) => ({ lat: acc.lat + curr.lat, lng: acc.lng + curr.lng }),
      { lat: 0, lng: 0 }
    );

    return {
      lat: sum.lat / state.gpsWindow.length,
      lng: sum.lng / state.gpsWindow.length,
    };
  }

  /**
   * Track stationary dwell time (2 minutes = 120,000ms within 3m radius)
   */
  function checkDwellStatus(lat, lng) {
    const now = Date.now();
    const currentPt = turf.point([lng, lat]);

    if (!state.dwellAnchor) {
      state.dwellAnchor = {
        lat,
        lng,
        startTime: now,
        triggered: false,
      };
      return;
    }

    const anchorPt = turf.point([state.dwellAnchor.lng, state.dwellAnchor.lat]);
    const distFromAnchor = turf.distance(anchorPt, currentPt, { units: 'meters' });

    if (distFromAnchor <= DWELL_RADIUS_METERS) {
      const dwellDuration = now - state.dwellAnchor.startTime;
      if (dwellDuration >= DWELL_TIME_THRESHOLD_MS && !state.dwellAnchor.triggered) {
        // 2 minutes reached! Record dwell footprint
        state.dwellAnchor.triggered = true;
        console.log('[Dwell] 2-minute stay detected at', lat, lng);

        // Check if near any restaurant POI
        let matchedRestId = null;
        for (const rest of state.restaurants) {
          const restPt = turf.point([rest.lng, rest.lat]);
          if (turf.distance(currentPt, restPt, { units: 'meters' }) <= 25.0) {
            matchedRestId = rest.id;
            break;
          }
        }

        const dwellStep = {
          id: 'dwell_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now(),
          lng: lng,
          lat: lat,
          heading: state.myHeading,
          isRightFoot: 1,
          density: 1,
          userId: state.userId || 'local_user',
          timestamp: Date.now(),
          isDwell: true,
          restaurantId: matchedRestId,
          dwellDurationSec: Math.floor(dwellDuration / 1000),
        };

        state.footsteps.set(dwellStep.id, dwellStep);
        scheduleMapUpdate();
        sendFootsteps([dwellStep]);
      }
    } else {
      // Moved outside 3m zone, reset dwell anchor
      state.dwellAnchor = {
        lat,
        lng,
        startTime: now,
        triggered: false,
      };
    }
  }

  /**
   * Handle incoming raw GPS fix with 1.5m stationary guard and Turf.js 0.8m interpolation
   */
  function handleNewGpsFix(rawLat, rawLng, heading = 0) {
    const smoothed = applyMovingAverage(rawLat, rawLng);
    const { lat, lng } = smoothed;

    state.myLat = lat;
    state.myLng = lng;
    state.hasRealGps = true;
    if (heading) state.myHeading = heading;

    updateUserMarkerOnMap();
    invalidateEnuCacheIfNeeded();

    if (state.isArActive) {
      scheduleArUpdate();
    }

    // Check 2-minute dwell status
    checkDwellStatus(lat, lng);

    // Initial GPS anchor
    if (!state.lastInterpolatedGps) {
      state.lastInterpolatedGps = { lng, lat, heading: state.myHeading };
      return;
    }

    const fromPt = turf.point([state.lastInterpolatedGps.lng, state.lastInterpolatedGps.lat]);
    const toPt = turf.point([lng, lat]);
    const distMeters = turf.distance(fromPt, toPt, { units: 'meters' });

    // 1.5m Stationary Guard: Block footprint generation if moved less than 1.5m
    if (distMeters < STATIONARY_GUARD_METERS) {
      return;
    }

    const bearing = turf.bearing(fromPt, toPt);
    const line = turf.lineString([
      [state.lastInterpolatedGps.lng, state.lastInterpolatedGps.lat],
      [lng, lat],
    ]);

    const newSteps = [];
    let currentDist = STEP_INTERVAL_METERS;

    while (currentDist <= distMeters) {
      const alongPt = turf.along(line, currentDist, { units: 'meters' });

      // Apply ±15cm random scatter perpendicular to heading
      const jitterOffset = (Math.random() - 0.5) * 2 * LATERAL_JITTER_METERS;
      const perpBearing = (bearing + 90) % 360;
      const offsetPt = turf.destination(alongPt, Math.abs(jitterOffset), jitterOffset >= 0 ? perpBearing : (perpBearing + 180) % 360, { units: 'meters' });
      const [finalLng, finalLat] = offsetPt.geometry.coordinates;

      newSteps.push({
        lng: finalLng,
        lat: finalLat,
        heading: (bearing + 360) % 360,
        isRightFoot: 1,
        timestamp: Date.now(),
        isDwell: false,
      });

      currentDist += STEP_INTERVAL_METERS;
    }

    if (newSteps.length > 0) {
      newSteps.forEach((s) => {
        const stepId = 'step_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
        const stepObj = {
          id: stepId,
          lng: s.lng,
          lat: s.lat,
          heading: s.heading || 0,
          isRightFoot: 1,
          density: 1,
          userId: state.userId || 'local_user',
          timestamp: s.timestamp || Date.now(),
          isDwell: false,
        };
        state.footsteps.set(stepId, stepObj);
      });

      scheduleMapUpdate();
      if (state.isArActive) {
        scheduleArUpdate();
      }

      sendFootsteps(newSteps);
      const lastStep = newSteps[newSteps.length - 1];
      state.lastInterpolatedGps = { lng: lastStep.lng, lat: lastStep.lat, heading: bearing };
    }
  }

  function handleOrientationEvent(e) {
    let heading = 0;
    if (typeof e.webkitCompassHeading !== 'undefined' && e.webkitCompassHeading !== null) {
      heading = e.webkitCompassHeading;
      state.deviceOrientation.hasSensor = true;
    } else if (e.alpha !== null) {
      heading = (360 - e.alpha) % 360;
      state.deviceOrientation.hasSensor = true;
    }

    state.myHeading = heading;
    state.deviceOrientation.compassHeading = heading;

    const beta = e.beta || 0;
    const gamma = e.gamma || 0;
    state.deviceOrientation.pitch = (beta - 85) * (Math.PI / 180);
    state.deviceOrientation.roll = -gamma * (Math.PI / 180);

    updateUserMarkerOnMap();
  }

  function startGeolocationWatch() {
    if (!('geolocation' in navigator)) return;

    const options = {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 1000,
    };

    navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, heading } = pos.coords;
        handleNewGpsFix(latitude, longitude, heading || 0);
      },
      (err) => {
        console.warn('[GPS] Position warning:', err.message);
      },
      options
    );

    if (window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientationabsolute', handleOrientationEvent, true);
      window.addEventListener('deviceorientation', handleOrientationEvent, true);
    }
  }

  // =========================================================================
  // 5. MapLibre GL JS (2D Thermography & Dining Dwell Layers)
  // =========================================================================
  let map = null;
  let userMarker = null;
  let mapUpdateTimer = null;
  let lastMapUpdateTime = 0;

  function scheduleMapUpdate() {
    const now = Date.now();
    const elapsed = now - lastMapUpdateTime;

    if (elapsed >= MAP_THROTTLE_MS) {
      lastMapUpdateTime = now;
      performMapUpdate();
    } else if (!mapUpdateTimer) {
      mapUpdateTimer = setTimeout(() => {
        mapUpdateTimer = null;
        lastMapUpdateTime = Date.now();
        performMapUpdate();
      }, MAP_THROTTLE_MS - elapsed);
    }
  }

  function setupMapLayers() {
    if (!map) return;
    if (map.getSource('footsteps')) return;

    // 1. Footprints Point Cloud Source
    map.addSource('footsteps', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // 2. Dwell / Dining Spots Source
    map.addSource('dwell-spots', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Layer A: Thermography Point Cloud (CircleLayer)
    // Sharp, small independent dots with density-driven interpolate gradient:
    // Low (1-2) -> Blue/Cyan, Medium (3-5) -> Yellow/Orange, High (6+) -> Vivid Red
    map.addLayer({
      id: 'footsteps-thermo',
      type: 'circle',
      source: 'footsteps',
      minzoom: 0,
      maxzoom: 24,
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          14, 2.0,
          16, 3.2,
          18, 4.5,
          20, 5.5,
        ],
        'circle-color': [
          'case',
          ['==', ['get', 'isMine'], 1],
          '#ff007f', // Vibrant Magenta for self-footprints
          [
            'interpolate', ['linear'], ['get', 'density'],
            1,  '#00b0ff', // Light Blue (Cold)
            2,  '#00e5ff', // Cyan
            3,  '#76ff03', // Lime / Green
            4,  '#ffea00', // Yellow
            5,  '#ff9100', // Orange
            6,  '#ff1744', // Vivid Red (Hot)
            8,  '#d50000', // Deep Red
          ],
        ],
        'circle-opacity': 0.85,
        'circle-blur': 0.05, // Sharp contour, distinct dots
      },
    });

    // Layer B: Dining 2-Minute Dwell Highlight Layer (Green Dots)
    map.addLayer({
      id: 'footsteps-dwell-glow',
      type: 'circle',
      source: 'dwell-spots',
      minzoom: 0,
      maxzoom: 24,
      layout: {
        visibility: 'none', // Controlled by toggle
      },
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          14, 4.5,
          16, 6.5,
          18, 9.0,
          20, 12.0,
        ],
        'circle-color': '#00ff66',
        'circle-opacity': 0.35,
        'circle-blur': 0.6,
      },
    });

    map.addLayer({
      id: 'footsteps-dwell-core',
      type: 'circle',
      source: 'dwell-spots',
      minzoom: 0,
      maxzoom: 24,
      layout: {
        visibility: 'none', // Controlled by toggle
      },
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          14, 2.8,
          16, 4.2,
          18, 5.8,
          20, 7.5,
        ],
        'circle-color': '#00ff66',
        'circle-opacity': 0.95,
        'circle-blur': 0.05,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#ffffff',
      },
    });
  }

  function performMapUpdate() {
    if (!map || !map.getSource('footsteps')) return;

    const normalFeatures = [];
    const dwellFeatures = [];

    state.footsteps.forEach((step) => {
      const isMine = step.userId === state.userId || step.userId === 'local_user';

      // If it's my footstep and toggle is OFF, don't show on map
      if (isMine && !state.showMyFootprints) return;

      const feature = {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [step.lng, step.lat],
        },
        properties: {
          id: step.id,
          density: Math.min(15, step.density || 1),
          isMine: isMine ? 1 : 0,
          isDwell: step.isDwell ? 1 : 0,
        },
      };

      normalFeatures.push(feature);

      if (step.isDwell) {
        dwellFeatures.push(feature);
      }
    });

    map.getSource('footsteps').setData({
      type: 'FeatureCollection',
      features: normalFeatures,
    });

    if (map.getSource('dwell-spots')) {
      map.getSource('dwell-spots').setData({
        type: 'FeatureCollection',
        features: dwellFeatures,
      });
    }
  }

  function updateUserMarkerOnMap() {
    if (!map) return;

    if (!userMarker) {
      const el = document.createElement('div');
      el.className = 'user-gps-marker';
      el.innerHTML = `
        <div class="user-pulse-ring"></div>
        <div class="user-heading-cone" id="user-heading-cone"></div>
        <div class="user-core-dot"></div>
      `;
      userMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([state.myLng, state.myLat])
        .addTo(map);
    } else {
      userMarker.setLngLat([state.myLng, state.myLat]);
      const cone = document.getElementById('user-heading-cone');
      if (cone) {
        cone.style.transform = `rotate(${state.myHeading}deg)`;
      }
    }
  }

  function initMap() {
    try {
      map = new maplibregl.Map({
        container: 'map-view',
        style: CARTO_POSITRON_STYLE,
        center: [state.myLng, state.myLat],
        zoom: 17.2,
        pitch: 0,
        bearing: 0,
        attributionControl: true,
      });
    } catch (e) {
      console.warn('[Map] GL style failed, using raster fallback', e);
      map = new maplibregl.Map({
        container: 'map-view',
        style: CARTO_POSITRON_RASTER_STYLE,
        center: [state.myLng, state.myLat],
        zoom: 17.2,
        attributionControl: true,
      });
    }

    map.on('load', () => {
      console.log('[Map] MapLibre loaded successfully');
      setupMapLayers();
      performMapUpdate();
      updateUserMarkerOnMap();
    });

    map.on('error', (e) => {
      console.warn('[Map] Map error:', e);
    });
  }

  // =========================================================================
  // 6. Three.js AR Engine (WebXR Hit-Test + 10m Proximity Culling)
  // =========================================================================
  let scene, camera, renderer;
  let instancedDots = null;
  const MAX_TOTAL_AR_INSTANCES = 100;
  const dummyMatrixObj = new THREE.Object3D();
  const dummyColor = new THREE.Color();
  let xrHitTestSource = null;
  let xrRefSpace = null;
  let animationFrameId = null;
  let arUpdateTimer = null;
  let lastArUpdateTime = 0;

  /**
   * Density to THREE.Color mapping:
   * Low (1-2) -> Blue/Cyan, Medium (3-5) -> Yellow/Orange, High (6+) -> Vivid Red
   */
  function densityToThreeColor(density, isMine) {
    if (isMine) return new THREE.Color(1.0, 0.0, 0.5); // Vibrant Magenta (#ff007f)

    const d = Math.min(15, density || 1);
    if (d <= 1) return new THREE.Color(0.0, 0.69, 1.0); // #00b0ff Blue
    if (d <= 2) return new THREE.Color(0.0, 0.90, 1.0); // #00e5ff Cyan
    if (d <= 3) return new THREE.Color(0.46, 1.0, 0.01); // #76ff03 Lime
    if (d <= 4) return new THREE.Color(1.0, 0.92, 0.0); // #ffea00 Yellow
    if (d <= 5) return new THREE.Color(1.0, 0.57, 0.0); // #ff9100 Orange
    if (d <= 6) return new THREE.Color(1.0, 0.09, 0.27); // #ff1744 Vivid Red
    return new THREE.Color(0.83, 0.0, 0.0); // Deep Red
  }

  function scheduleArUpdate() {
    const now = Date.now();
    const elapsed = now - lastArUpdateTime;

    if (elapsed >= AR_UPDATE_THROTTLE_MS) {
      lastArUpdateTime = now;
      updateArInstancedFootsteps();
    } else if (!arUpdateTimer) {
      arUpdateTimer = setTimeout(() => {
        arUpdateTimer = null;
        lastArUpdateTime = Date.now();
        updateArInstancedFootsteps();
      }, AR_UPDATE_THROTTLE_MS - elapsed);
    }
  }

  function invalidateEnuCacheIfNeeded() {
    if (enuCacheOriginLat === null || enuCacheOriginLng === null) {
      enuCacheOriginLat = state.myLat;
      enuCacheOriginLng = state.myLng;
      return;
    }

    const dlat = (state.myLat - enuCacheOriginLat) * 111320;
    const dlng = (state.myLng - enuCacheOriginLng) * 111320 * Math.cos((state.myLat * Math.PI) / 180);
    const dist = Math.sqrt(dlat * dlat + dlng * dlng);

    if (dist > ENU_CACHE_INVALIDATION_METERS) {
      enuCache.clear();
      enuCacheOriginLat = state.myLat;
      enuCacheOriginLng = state.myLng;
    }
  }

  function initThreeScene() {
    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 50);
    camera.position.set(0, 0, 0);

    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;

    elArCanvasContainer.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.5);
    scene.add(ambientLight);

    // CircleGeometry dot (radius 0.07m ≈ 7cm, laying flat on ground XZ plane)
    const circleGeo = new THREE.CircleGeometry(0.07, 32);
    circleGeo.rotateX(-Math.PI / 2);

    const dotMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    instancedDots = new THREE.InstancedMesh(circleGeo, dotMat, MAX_TOTAL_AR_INSTANCES);
    instancedDots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    instancedDots.count = 0;
    scene.add(instancedDots);

    window.addEventListener('resize', onWindowResize);
  }

  function onWindowResize() {
    if (camera && renderer) {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    }
  }

  /**
   * Convert GPS (lat, lng) to local ENU (East-North-Up) coordinates relative to user position
   */
  function gpsToEnu(lat, lng) {
    const latRad = (state.myLat * Math.PI) / 180;
    const dLat = ((lat - state.myLat) * Math.PI) / 180;
    const dLng = ((lng - state.myLng) * Math.PI) / 180;

    const R = 6371000;
    const east = dLng * Math.cos(latRad) * R;
    const north = dLat * R;

    return { east, north };
  }

  /**
   * Update AR Instanced Mesh with 10m Proximity Culling
   */
  function updateArInstancedFootsteps() {
    if (!instancedDots) return;

    const compassRad = (state.deviceOrientation.compassHeading * Math.PI) / 180;
    const sinC = Math.sin(compassRad);
    const cosC = Math.cos(compassRad);

    const nearbySteps = [];

    state.footsteps.forEach((step) => {
      // Exclude dwell green spots from AR as per spec
      if (step.isDwell) return;

      const isMine = step.userId === state.userId || step.userId === 'local_user';
      if (isMine && !state.showMyFootprints) return;

      let enu = enuCache.get(step.id);
      if (!enu) {
        enu = gpsToEnu(step.lat, step.lng);
        enuCache.set(step.id, enu);
      }

      const distSq = enu.east * enu.east + enu.north * enu.north;
      // 10m Proximity Culling
      if (distSq <= AR_MAX_RENDER_DISTANCE * AR_MAX_RENDER_DISTANCE) {
        nearbySteps.push({
          step,
          enu,
          distSq,
          isMine,
        });
      }
    });

    // Sort nearest first and cap at MAX_TOTAL_AR_INSTANCES
    nearbySteps.sort((a, b) => a.distSq - b.distSq);
    const renderList = nearbySteps.slice(0, MAX_TOTAL_AR_INSTANCES);

    const groundY = state.groundLevelY;

    for (let i = 0; i < renderList.length; i++) {
      const item = renderList[i];
      const { east, north } = item.enu;

      // Transform ENU to Camera Space using compass heading
      // East = +X, North = -Z in standard Three.js coordinates
      const camX = east * cosC - north * sinC;
      const camZ = -(east * sinC + north * cosC);

      dummyMatrixObj.position.set(camX, groundY, camZ);
      dummyMatrixObj.rotation.set(0, 0, 0);
      dummyMatrixObj.scale.set(1, 1, 1);
      dummyMatrixObj.updateMatrix();

      instancedDots.setMatrixAt(i, dummyMatrixObj.matrix);

      const color = densityToThreeColor(item.step.density, item.isMine);
      instancedDots.setColorAt(i, color);
    }

    instancedDots.count = renderList.length;
    instancedDots.instanceMatrix.needsUpdate = true;
    if (instancedDots.instanceColor) {
      instancedDots.instanceColor.needsUpdate = true;
    }
  }

  // =========================================================================
  // 7. WebXR AR Session & Hit-Test Ground Detection
  // =========================================================================

  async function startArMode() {
    if (state.isArActive) return;

    if (!navigator.xr) {
      console.warn('[WebXR] WebXR Device API not supported, starting camera fallback...');
      startCameraFallback();
      return;
    }

    const isSupported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
    if (!isSupported) {
      console.warn('[WebXR] immersive-ar not supported, using camera fallback...');
      startCameraFallback();
      return;
    }

    try {
      const session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test', 'local-floor'],
        optionalFeatures: ['dom-overlay'],
        domOverlay: { root: document.body },
      });

      state.webxrSession = session;
      state.isArActive = true;
      elArViewContainer.classList.add('active');
      elBtnToggleAr.classList.add('active');

      await renderer.xr.setSession(session);
      xrRefSpace = await session.requestReferenceSpace('local-floor');
      const viewerSpace = await session.requestReferenceSpace('viewer');
      xrHitTestSource = await session.requestHitTestSource({ space: viewerSpace });

      session.addEventListener('end', () => {
        stopArMode();
      });

      renderer.setAnimationLoop(renderWebXRFrame);
      console.log('[WebXR] AR Session started with hit-test');
    } catch (err) {
      console.warn('[WebXR] requestSession failed:', err);
      startCameraFallback();
    }
  }

  function renderWebXRFrame(timestamp, frame) {
    if (!frame) return;

    if (xrHitTestSource && xrRefSpace) {
      const hitTestResults = frame.getHitTestResults(xrHitTestSource);
      if (hitTestResults.length > 0) {
        const pose = hitTestResults[0].getPose(xrRefSpace);
        if (pose) {
          state.groundLevelY = pose.transform.position.y;
        }
      }
    }

    renderer.render(scene, camera);
  }

  async function startCameraFallback() {
    state.isArActive = true;
    elArViewContainer.classList.add('active');
    elBtnToggleAr.classList.add('active');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      state.cameraStream = stream;
      elArCameraFeed.srcObject = stream;
      await elArCameraFeed.play();
    } catch (e) {
      console.warn('[Camera] Fallback video feed error:', e);
    }

    function animateFallback() {
      if (!state.isArActive) return;
      animationFrameId = requestAnimationFrame(animateFallback);

      // Apply device orientation tilt
      if (state.deviceOrientation.hasSensor) {
        camera.rotation.x = state.deviceOrientation.pitch;
        camera.rotation.z = state.deviceOrientation.roll;
      }

      renderer.render(scene, camera);
    }

    animateFallback();
  }

  function stopArMode() {
    state.isArActive = false;
    elArViewContainer.classList.remove('active');
    elBtnToggleAr.classList.remove('active');

    if (state.webxrSession) {
      state.webxrSession.end().catch(() => {});
      state.webxrSession = null;
    }

    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((track) => track.stop());
      state.cameraStream = null;
    }

    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    renderer.setAnimationLoop(null);
  }

  // =========================================================================
  // 8. Event Handlers & Non-Verbal UI Controls
  // =========================================================================

  function setupUiEvents() {
    // 1. Self Footprints Toggle (Default: OFF)
    elBtnToggleMine.addEventListener('click', () => {
      state.showMyFootprints = !state.showMyFootprints;
      elBtnToggleMine.classList.toggle('active', state.showMyFootprints);
      scheduleMapUpdate();
      if (state.isArActive) scheduleArUpdate();
    });

    // 2. Restaurant Dwell Highlight Toggle (Default: OFF)
    elBtnToggleDining.addEventListener('click', () => {
      state.showDiningDwell = !state.showDiningDwell;
      elBtnToggleDining.classList.toggle('active', state.showDiningDwell);

      if (map) {
        const visibility = state.showDiningDwell ? 'visible' : 'none';
        if (map.getLayer('footsteps-dwell-glow')) {
          map.setLayoutProperty('footsteps-dwell-glow', 'visibility', visibility);
        }
        if (map.getLayer('footsteps-dwell-core')) {
          map.setLayoutProperty('footsteps-dwell-core', 'visibility', visibility);
        }
      }
    });

    // 3. AR / 2D Map Switch
    elBtnToggleAr.addEventListener('click', () => {
      if (state.isArActive) {
        stopArMode();
      } else {
        startArMode();
      }
    });

    // 4. Re-center GPS Location
    elBtnRecenter.addEventListener('click', () => {
      if (map) {
        map.flyTo({
          center: [state.myLng, state.myLat],
          zoom: 17.5,
          pitch: 0,
          speed: 1.6,
          curve: 1.2,
        });
      }
    });
  }

  // =========================================================================
  // 9. Application Initialization
  // =========================================================================
  function initApp() {
    initMap();
    initThreeScene();
    initWebSocket();
    setupUiEvents();
    startGeolocationWatch();
    console.log('[App] FootStepCollector initialized successfully');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
