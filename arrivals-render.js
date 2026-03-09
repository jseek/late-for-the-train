const flapAlphabet = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:-./";
const flapIndex = new Map([...flapAlphabet].map((char, index) => [char, index]));
const flapStepMs = 55;
const flapStaggerMs = 240;
const splitDestinationLength = 15;
const splitTimeLength = 8;
const splitStatusLength = 10;

function formatEta(etaMinutes) {
  if (etaMinutes <= 0) {
    return "Arriving now";
  }
  const totalMinutes = Math.round(etaMinutes);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  parts.push(`${minutes}m`);

  return parts.join(" ");
}

function formatTime(isoString) {
  if (!isoString) {
    return "--";
  }
  const date = new Date(isoString);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatStatus(statusMsg) {
  const status = (statusMsg || "").trim().toLowerCase();
  if (!status) {
    return "ON TIME";
  }
  if (status.includes("board")) {
    return "BOARDING";
  }
  if (status.includes("delay") || status.includes("late")) {
    return "DELAYED";
  }
  if (status.includes("cancel")) {
    return "CANCELED";
  }
  if (status.includes("on time")) {
    return "ON TIME";
  }
  if (status.includes("arriv")) {
    return "ARRIVING";
  }
  if (status.includes("enroute") || status.includes("en route")) {
    return "ON TIME";
  }
  return status.toUpperCase();
}

function normalizeFlapChar(char) {
  const upper = (char || " ").toUpperCase();
  return flapIndex.has(upper) ? upper : " ";
}

function buildFlapChars(text, length) {
  const upper = (text || "").toUpperCase();
  const chars = [];
  for (let i = 0; i < length; i += 1) {
    chars.push(normalizeFlapChar(upper[i]));
  }
  return chars;
}

function setCellChar(cell, char) {
  cell.textContent = char;
  cell.dataset.char = char;
}

function stepCellToward(cell, targetChar) {
  const currentChar = normalizeFlapChar(cell.dataset.char);
  const currentIndex = flapIndex.get(currentChar) ?? 0;
  const nextChar = flapAlphabet[(currentIndex + 1) % flapAlphabet.length];
  setCellChar(cell, nextChar);
  cell.classList.add("is-flipping");
  setTimeout(() => {
    cell.classList.remove("is-flipping");
  }, flapStepMs);
  return nextChar !== targetChar;
}

export function buildSplitTrains(data) {
  const combined = [];
  const seen = new Set();

  function track(train) {
    if (!train) {
      return;
    }
    const key = `${train.trainNum || ""}-${train.arrivalTime || ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    combined.push(train);
  }

  track(data.next_train);
  (data.upcoming_trains || []).forEach(track);
  return combined;
}

export function initArrivalsRenderer(elements) {
  const {
    stationCodeEl,
    nextTimeEl,
    nextRouteEl,
    nextStatusEl,
    nextOriginEl,
    nextDestEl,
    nextSourceEl,
    upcomingListEl,
    splitListEl,
    refreshTimeEl,
    staleIndicatorEl,
  } = elements;
  const flapTimers = new WeakMap();
  const mapInstances = new Set();
  let nightMode = document.body.classList.contains("night");
  let mapStyle = "slate";

  function createTileLayer(style) {
    if (style === "dark") {
      return L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
      });
    }
    if (style === "slate") {
      return L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
      });
    }
    return L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
  }

  function attachTileFallback(map, layer, attributionEl) {
    let tileErrorCount = 0;
    let switchedToFallback = false;

    layer.on("tileerror", () => {
      tileErrorCount += 1;
      if (switchedToFallback || tileErrorCount < 3) {
        return;
      }

      switchedToFallback = true;
      map.removeLayer(layer);
      createTileLayer("light").addTo(map);
      if (attributionEl) {
        attributionEl.textContent = mapAttributionText("light");
      }
    });
  }

  function teardownMaps() {
    mapInstances.forEach((entry) => {
      entry.map.remove();
    });
    mapInstances.clear();
  }

  function formatMapLabel(text) {
    return String(text || "").trim() || "N/A";
  }

  function mapAttributionText(style) {
    if (style === "dark" || style === "slate") {
      return "Map tiles © OpenStreetMap contributors; styled tiles © CARTO.";
    }
    return "Map tiles © OpenStreetMap contributors.";
  }

  function renderMapFallback(mapEl, reason = "Map unavailable for this train.") {
    mapEl.classList.add("map-unavailable");
    mapEl.textContent = reason;
    mapEl.dataset.mapReady = "true";
  }

  function initMap(mapEl, train, attributionEl, options = {}) {
    if (!window.L) {
      renderMapFallback(mapEl, "Map unavailable: map library failed to load.");
      return;
    }
    if (!train?.trainLocation) {
      renderMapFallback(mapEl, "Map unavailable: missing train location data.");
      return;
    }
    const appliedStyle = options.styleOverride || mapStyle;
    const trainLabel = formatMapLabel(train.trainNum);
    const trainCoords = [train.trainLocation.lat, train.trainLocation.lon];
    const hasStationLocation = Boolean(train.stationLocation);
    const stationCoords = hasStationLocation
      ? [train.stationLocation.lat, train.stationLocation.lon]
      : null;
    const stationLabel = hasStationLocation
      ? formatMapLabel(train.station_name || train.station_code || train.destination?.code)
      : null;
    const map = L.map(mapEl, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      doubleClickZoom: false,
      scrollWheelZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
    });
    const tileLayer = createTileLayer(appliedStyle).addTo(map);
    attachTileFallback(map, tileLayer, attributionEl);
    L.marker(trainCoords, {
      icon: L.divIcon({
        className: "map-label map-label-train",
        html: trainLabel,
      }),
      interactive: false,
    }).addTo(map);
    if (hasStationLocation && stationCoords) {
      L.marker(stationCoords, {
        icon: L.divIcon({
          className: "map-label map-label-station",
          html: stationLabel,
        }),
        interactive: false,
      }).addTo(map);
      const bounds = L.latLngBounds([trainCoords, stationCoords]).pad(0.2);
      map.fitBounds(bounds, { animate: false });
    } else {
      map.setView(trainCoords, 7, { animate: false });
    }
    if (attributionEl) {
      attributionEl.textContent = mapAttributionText(appliedStyle);
    }
    requestAnimationFrame(() => {
      map.invalidateSize();
    });
    mapInstances.add({ map, tileLayer, attributionEl, styleOverride: options.styleOverride || null });
    mapEl.dataset.mapReady = "true";
  }

  function animateCellTo(cell, targetChar, force) {
    const normalizedTarget = normalizeFlapChar(targetChar);
    const currentChar = normalizeFlapChar(cell.dataset.char);
    if (!force && currentChar === normalizedTarget) {
      return;
    }

    const existing = flapTimers.get(cell);
    if (existing?.interval) {
      clearInterval(existing.interval);
    }
    if (existing?.delay) {
      clearTimeout(existing.delay);
    }

    if (force && currentChar === normalizedTarget) {
      const targetIndex = flapIndex.get(normalizedTarget) ?? 0;
      const previousChar = flapAlphabet[
        (targetIndex - 1 + flapAlphabet.length) % flapAlphabet.length
      ];
      setCellChar(cell, previousChar);
    }

    const delay = Math.random() * flapStaggerMs;
    const delayId = setTimeout(() => {
      const interval = setInterval(() => {
        const keepGoing = stepCellToward(cell, normalizedTarget);
        if (!keepGoing) {
          clearInterval(interval);
          flapTimers.delete(cell);
        }
      }, flapStepMs);
      flapTimers.set(cell, { interval });
    }, delay);
    flapTimers.set(cell, { delay: delayId });
  }

  function ensureSplitField(fieldEl) {
    const length = Number(fieldEl.dataset.length);
    if (fieldEl.children.length === length) {
      return;
    }
    fieldEl.innerHTML = "";
    for (let i = 0; i < length; i += 1) {
      const cell = document.createElement("span");
      cell.className = "split-cell";
      setCellChar(cell, " ");
      fieldEl.appendChild(cell);
    }
  }

  function updateSplitField(fieldEl, targetText, force) {
    ensureSplitField(fieldEl);
    const length = Number(fieldEl.dataset.length);
    const targetChars = buildFlapChars(targetText, length);
    const cells = fieldEl.querySelectorAll(".split-cell");
    targetChars.forEach((char, index) => {
      animateCellTo(cells[index], char, force);
    });
  }

  function ensureSplitRows(count) {
    while (splitListEl.children.length < count) {
      const row = document.createElement("div");
      row.className = "split-row";

      const destination = document.createElement("div");
      destination.className = "split-field split-destination";
      destination.dataset.length = String(splitDestinationLength);

      const time = document.createElement("div");
      time.className = "split-field split-time";
      time.dataset.length = String(splitTimeLength);

      const status = document.createElement("div");
      status.className = "split-field split-status";
      status.dataset.length = String(splitStatusLength);

      row.appendChild(destination);
      row.appendChild(time);
      row.appendChild(status);
      splitListEl.appendChild(row);
    }

    while (splitListEl.children.length > count) {
      splitListEl.removeChild(splitListEl.lastChild);
    }
  }

  function renderSplitFlap(trains, force) {
    if (!splitListEl) {
      return;
    }
    const maxRows = 8;
    const rows = trains.slice(0, maxRows).map((train) => {
      const destinationText = train.destination.name || train.destination.code || "Unknown destination";
      return {
        destination: destinationText.slice(0, splitDestinationLength),
        time: formatTime(train.arrivalTime),
        status: formatStatus(train.statusMsg),
      };
    });

    if (!rows.length) {
      rows.push({ destination: "No arrivals", time: "--", status: "" });
    }

    while (rows.length < maxRows) {
      rows.push({ destination: "", time: "", status: "" });
    }

    ensureSplitRows(rows.length);
    rows.forEach((rowData, index) => {
      const rowEl = splitListEl.children[index];
      const destinationEl = rowEl.querySelector(".split-destination");
      const timeEl = rowEl.querySelector(".split-time");
      const statusEl = rowEl.querySelector(".split-status");
      updateSplitField(destinationEl, rowData.destination, force);
      updateSplitField(timeEl, rowData.time, force);
      updateSplitField(statusEl, rowData.status, force);
    });
  }

  function renderTrainTimeline(stops, nextStop) {
    const timeline = document.createElement("div");
    timeline.className = "train-timeline";

    const nextStationName = nextStop?.station_name || nextStop?.station_code || "next station";
    const previousStationName = nextStop?.origin?.name || nextStop?.origin?.code || "Unknown";
    const currentTrainName = `${nextStop?.routeName || "Train"} ${nextStop?.trainNum || ""}`.trim();

    const previous = document.createElement("div");
    previous.className = "timeline-stop timeline-previous";
    previous.innerHTML = `
      <div class="timeline-node-wrap"><span class="timeline-node" aria-hidden="true"></span></div>
      <div class="timeline-content">
        <div class="timeline-title">${previousStationName}</div>
        <div class="timeline-subtitle">Previous station</div>
      </div>
    `;
    timeline.appendChild(previous);

    const current = document.createElement("button");
    current.type = "button";
    current.className = "timeline-current";
    current.setAttribute("aria-expanded", "false");
    const detailsId = `train-position-${nextStop?.trainNum || "current"}-${Date.now()}`;
    current.setAttribute("aria-controls", detailsId);
    current.innerHTML = `
      <div class="timeline-node-wrap"><span class="timeline-node timeline-node-live" aria-hidden="true"></span></div>
      <div class="timeline-content">
        <div class="timeline-title">${currentTrainName}</div>
        <div class="timeline-subtitle">${nextStop ? `${formatEta(nextStop.etaMinutes)} to ${nextStationName}` : "No next station available"}</div>
      </div>
    `;
    timeline.appendChild(current);

    const mapPanel = document.createElement("div");
    mapPanel.className = "timeline-map-panel";
    mapPanel.id = detailsId;
    mapPanel.hidden = true;

    const mapEl = document.createElement("div");
    mapEl.className = "train-map";
    mapPanel.appendChild(mapEl);

    const mapAttribution = document.createElement("div");
    mapAttribution.className = "map-attribution";
    mapAttribution.textContent = mapAttributionText("dark");
    mapPanel.appendChild(mapAttribution);

    current.addEventListener("click", () => {
      const isExpanded = current.classList.toggle("is-expanded");
      current.setAttribute("aria-expanded", String(isExpanded));
      mapPanel.hidden = !isExpanded;
      if (isExpanded && !mapEl.dataset.mapReady) {
        requestAnimationFrame(() => {
          initMap(mapEl, nextStop, mapAttribution, { styleOverride: "dark" });
        });
      } else if (isExpanded) {
        requestAnimationFrame(() => {
          const entry = [...mapInstances].find((instance) => instance.map.getContainer() === mapEl);
          if (entry) {
            entry.map.invalidateSize();
          }
        });
      }
    });

    const list = document.createElement("div");
    list.className = "timeline-list";

    stops.forEach((stop, index) => {
      const row = document.createElement("div");
      row.className = "timeline-stop";
      if (index === 0) {
        row.classList.add("is-next");
      }
      row.innerHTML = `
        <div class="timeline-node-wrap"><span class="timeline-node" aria-hidden="true"></span></div>
        <div class="timeline-content">
          <div class="timeline-title">${stop.station_name || stop.station_code || "Unknown station"}</div>
          <div class="timeline-subtitle">${formatEta(stop.etaMinutes)} • ${formatTime(stop.arrivalTime)}</div>
        </div>
      `;
      list.appendChild(row);
    });

    timeline.appendChild(mapPanel);
    timeline.appendChild(list);
    upcomingListEl.appendChild(timeline);
  }

  function renderUpcoming(trains, context = {}) {
    const { mode = "station", nextTrain = null } = context;
    if (!upcomingListEl) {
      return;
    }
    teardownMaps();
    upcomingListEl.innerHTML = "";

    if (mode === "train") {
      if (!trains.length) {
        upcomingListEl.innerHTML = '<div class="upcoming-card">No upcoming stations found.</div>';
        return;
      }
      renderTrainTimeline(trains, nextTrain || trains[0] || null);
      return;
    }

    if (!trains.length) {
      upcomingListEl.innerHTML = '<div class="upcoming-card">No upcoming arrivals found.</div>';
      return;
    }

    trains.forEach((train, index) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "upcoming-card";
      card.setAttribute("aria-expanded", "false");
      const detailsId = `train-details-${index}`;
      card.setAttribute("aria-controls", detailsId);

      const eta = document.createElement("div");
      eta.className = "eta";
      eta.textContent = formatEta(train.etaMinutes);

      const route = document.createElement("div");
      route.className = "route";
      route.innerHTML = `<strong>${train.routeName || "Train"} ${train.trainNum}</strong><div class="source">${formatTime(train.arrivalTime)} • ${train.timeSource}</div>`;

      const origin = document.createElement("div");
      origin.className = "source";
      origin.textContent = `${train.origin.name || ""} → ${train.destination.name || ""}`.trim();

      const indicator = document.createElement("div");
      indicator.className = "expand-indicator";
      indicator.textContent = "Details";

      const trainName = `${train.routeName || "Train"} ${train.trainNum || ""}`.trim();
      const originName = train.origin.name || train.origin.code || "Unknown";
      const destinationName = train.destination.name || train.destination.code || "Unknown";

      const details = document.createElement("div");
      details.className = "train-details";
      details.id = detailsId;
      details.innerHTML = `
        <div><span>Arrival time</span><strong>${formatTime(train.arrivalTime)}</strong></div>
        <div><span>Train name</span><strong>${trainName}</strong></div>
        <div><span>Source</span><strong>${originName}</strong></div>
        <div><span>Destination</span><strong>${destinationName}</strong></div>
      `;

      const mapEl = document.createElement("div");
      mapEl.className = "train-map";
      mapEl.setAttribute("aria-hidden", "true");
      details.appendChild(mapEl);

      const mapAttribution = document.createElement("div");
      mapAttribution.className = "map-attribution";
      mapAttribution.textContent = mapAttributionText(mapStyle);
      details.appendChild(mapAttribution);

      card.addEventListener("click", () => {
        const isExpanded = card.classList.toggle("is-expanded");
        card.setAttribute("aria-expanded", String(isExpanded));
        indicator.textContent = isExpanded ? "Hide details" : "Details";
        if (isExpanded && !mapEl.dataset.mapReady) {
          requestAnimationFrame(() => {
            initMap(mapEl, train, mapAttribution);
          });
        } else if (isExpanded) {
          requestAnimationFrame(() => {
            const entry = [...mapInstances].find((instance) => instance.map.getContainer() === mapEl);
            if (entry) {
              entry.map.invalidateSize();
            }
          });
        }
      });

      card.appendChild(eta);
      card.appendChild(route);
      card.appendChild(origin);
      card.appendChild(indicator);
      card.appendChild(details);
      upcomingListEl.appendChild(card);
    });
  }

  function renderHero(nextTrain) {
    if (!nextTimeEl) {
      return;
    }
    if (nextTrain) {
      nextTimeEl.textContent = formatEta(nextTrain.etaMinutes);
      nextRouteEl.textContent = `${nextTrain.routeName || "Train"} ${nextTrain.trainNum}`;
      nextStatusEl.textContent = nextTrain.statusMsg || "";
      nextOriginEl.textContent = `Origin: ${nextTrain.origin.name || nextTrain.origin.code}`;
      nextDestEl.textContent = `Destination: ${nextTrain.destination.name || nextTrain.destination.code}`;
      nextSourceEl.textContent = `Arrives at ${formatTime(nextTrain.arrivalTime)} (${nextTrain.timeSource})`;
      return;
    }

    nextTimeEl.textContent = "--";
    nextRouteEl.textContent = "No upcoming arrivals";
    nextStatusEl.textContent = "";
    nextOriginEl.textContent = "";
    nextDestEl.textContent = "";
    nextSourceEl.textContent = "";
  }

  function renderRefreshTime(date) {
    if (!refreshTimeEl) {
      return;
    }
    refreshTimeEl.textContent = `Last updated: ${date.toLocaleTimeString()}`;
  }

  function renderStale(isStale, error) {
    if (!staleIndicatorEl) {
      return;
    }
    if (error) {
      staleIndicatorEl.textContent = "Data temporarily unavailable. Check CORS or use a proxy.";
      return;
    }
    staleIndicatorEl.textContent = isStale ? "Data may be stale." : "";
  }

  function setStationCode(value) {
    if (!stationCodeEl) {
      return;
    }
    stationCodeEl.textContent = value;
  }

  function setNightMode(enabled) {
    nightMode = enabled;
    mapInstances.forEach((entry) => {
      entry.map.removeLayer(entry.tileLayer);
      const effectiveStyle = entry.styleOverride || mapStyle;
      entry.tileLayer = createTileLayer(effectiveStyle).addTo(entry.map);
      attachTileFallback(entry.map, entry.tileLayer, entry.attributionEl);
    });
  }

  function setMapStyle(value) {
    mapStyle = value;
    mapInstances.forEach((entry) => {
      entry.map.removeLayer(entry.tileLayer);
      const effectiveStyle = entry.styleOverride || mapStyle;
      entry.tileLayer = createTileLayer(effectiveStyle).addTo(entry.map);
      attachTileFallback(entry.map, entry.tileLayer, entry.attributionEl);
      if (entry.attributionEl) {
        entry.attributionEl.textContent = mapAttributionText(effectiveStyle);
      }
    });
  }

  return {
    renderHero,
    renderUpcoming,
    renderSplitFlap,
    renderRefreshTime,
    renderStale,
    setStationCode,
    setNightMode,
    setMapStyle,
  };
}
