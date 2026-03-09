import { fetchArrivalsData, fetchStationLocations, fetchTrainsList } from "./arrivals-data.js";
import { buildSplitTrains, initArrivalsRenderer } from "./arrivals-render.js";

const refreshIntervalMs = 30000;

const contextLabelEl = document.getElementById("context-label");
const stationCodeEl = document.getElementById("station-code");
const stationInput = document.getElementById("station-input");
const displaySelect = document.getElementById("display-select");
const mapStyleSelect = document.getElementById("map-style");
const viewModeSelect = document.getElementById("view-mode-select");
const trainSelect = document.getElementById("train-select");
const trainSelectControl = document.getElementById("train-select-control");
const applyStationBtn = document.getElementById("apply-station");
const toggleNightBtn = document.getElementById("toggle-night");
const toggleControlsBtn = document.getElementById("toggle-controls");
const showControlsBtn = document.getElementById("show-controls");
const heroSection = document.getElementById("hero-section");
const upcomingSection = document.getElementById("upcoming-section");
const splitSection = document.getElementById("split-section");
const upcomingHeadingEl = upcomingSection.querySelector("h2");
const splitHeadingEl = splitSection.querySelector("h2");
const nextTimeEl = document.getElementById("next-time");
const nextRouteEl = document.getElementById("next-route");
const nextStatusEl = document.getElementById("next-status");
const nextOriginEl = document.getElementById("next-origin");
const nextDestEl = document.getElementById("next-destination");
const nextSourceEl = document.getElementById("next-source");
const upcomingListEl = document.getElementById("upcoming-list");
const splitListEl = document.getElementById("split-list");
const refreshTimeEl = document.getElementById("refresh-time");
const staleIndicatorEl = document.getElementById("stale-indicator");
const footerEl = document.querySelector(".footer");

const renderer = initArrivalsRenderer({
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
});

const urlParams = new URLSearchParams(window.location.search);
let stationCode = (urlParams.get("station") || "FLG").toUpperCase();
let trainNumber = urlParams.get("train") || "";
let viewMode = urlParams.get("view") || "station";
let nightMode = urlParams.get("night") === "1" || !urlParams.has("night");
let displayType = urlParams.get("display") || "cards";
let mapStyle = urlParams.get("map") || "slate";
let userPosition = null;

if (!["cards", "split"].includes(displayType)) {
  displayType = "cards";
}
if (!["light", "slate", "dark"].includes(mapStyle)) {
  mapStyle = "slate";
}
if (!["station", "train"].includes(viewMode)) {
  viewMode = "station";
}

function applyNightMode(enabled) {
  document.body.classList.toggle("night", enabled);
  toggleNightBtn.textContent = enabled ? "Day mode" : "Night mode";
  renderer.setNightMode(enabled);
}

function applyDisplayType(value) {
  const isSplit = value === "split";
  const showHero = !isSplit && viewMode === "station";
  heroSection.classList.toggle("is-hidden", !showHero);
  upcomingSection.classList.toggle("is-hidden", isSplit);
  splitSection.classList.toggle("is-hidden", !isSplit);
}

function applyMapStyle(value) {
  renderer.setMapStyle(value);
}

function setControlsCollapsed(collapsed) {
  document.body.classList.toggle("controls-collapsed", collapsed);
  showControlsBtn.classList.toggle("is-hidden", !collapsed);
  toggleControlsBtn.textContent = collapsed ? "Show controls" : "Hide controls";
}

function computeDistanceKm(a, b) {
  const earthRadiusKm = 6371;
  const toRadians = (value) => (value * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const haversine = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function getCurrentPosition() {
  if (!("geolocation" in navigator)) {
    return Promise.reject(new Error("Geolocation unavailable"));
  }
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error("Geolocation timeout"));
    }, 8000);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        window.clearTimeout(timeoutId);
        resolve(position);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
      { enableHighAccuracy: false, timeout: 7000, maximumAge: 600000 },
    );
  });
}

function updateUrl() {
  const params = new URLSearchParams();
  params.set("view", viewMode);
  if (viewMode === "station") {
    params.set("station", stationCode);
  } else if (trainNumber) {
    params.set("train", trainNumber);
  }
  if (nightMode) {
    params.set("night", "1");
  }
  params.set("display", displayType);
  params.set("map", mapStyle);
  window.history.replaceState({}, "", `?${params.toString()}`);
}

function syncViewControls() {
  const stationControlsVisible = viewMode === "station";
  stationInput.closest("label")?.classList.toggle("is-hidden", !stationControlsVisible);
  trainSelectControl.classList.toggle("is-hidden", stationControlsVisible);
  applyStationBtn.textContent = stationControlsVisible ? "Update" : "Update train";
  contextLabelEl.textContent = stationControlsVisible ? "Next arrival at" : "Next stop for";
  if (upcomingHeadingEl) {
    upcomingHeadingEl.classList.toggle("is-hidden", !stationControlsVisible);
    upcomingHeadingEl.textContent = "Upcoming arrivals";
  }
  if (splitHeadingEl) {
    splitHeadingEl.textContent = "Arrivals";
  }
  if (footerEl) {
    footerEl.classList.toggle("is-hidden", !stationControlsVisible);
  }
}

function setStation(newCode, options = {}) {
  stationCode = newCode;
  stationInput.value = stationCode;
  renderer.setStationCode(stationCode);
  updateUrl();
  if (options.fetch) {
    fetchData({ forceSplit: true });
  }
}

function setTrain(newTrainNumber, options = {}) {
  trainNumber = String(newTrainNumber || "");
  if (trainSelect.value !== trainNumber) {
    trainSelect.value = trainNumber;
  }
  renderer.setStationCode(trainNumber || "--");
  updateUrl();
  if (options.fetch) {
    fetchData({ forceSplit: true });
  }
}

function setViewMode(mode, options = {}) {
  viewMode = mode;
  syncViewControls();
  applyDisplayType(displayType);
  updateUrl();
  if (options.fetch) {
    fetchData({ forceSplit: true });
  }
}

async function fetchData(options = {}) {
  try {
    const data = await fetchArrivalsData({
      mode: viewMode,
      stationCode,
      trainNum: trainNumber,
    });
    renderer.setStationCode(data.context_code || stationCode);
    contextLabelEl.textContent = data.context_label || contextLabelEl.textContent;
    renderer.renderHero(data.next_train);
    renderer.renderUpcoming(data.upcoming_trains || [], { mode: viewMode, nextTrain: data.next_train });
    renderer.renderSplitFlap(buildSplitTrains(data), options.forceSplit === true);
    renderer.renderRefreshTime(data.now);
    renderer.renderStale(data.stale);
  } catch (error) {
    renderer.renderStale(false, error);
  }
}

async function chooseNearestStationFromLocation() {
  if (urlParams.has("station")) {
    return null;
  }
  if (!userPosition) {
    return null;
  }
  try {
    const stations = await fetchStationLocations();
    if (!stations.length) {
      return null;
    }
    let closest = stations[0];
    let closestDistance = Number.POSITIVE_INFINITY;
    stations.forEach((station) => {
      const distance = computeDistanceKm(userPosition, station.coords);
      if (distance < closestDistance) {
        closest = station;
        closestDistance = distance;
      }
    });
    return closest.code;
  } catch (error) {
    return null;
  }
}

async function loadTrainOptions() {
  try {
    const trains = await fetchTrainsList();
    const sorted = trains
      .map((train) => {
        const distance = userPosition ? computeDistanceKm(userPosition, train.coords) : Number.POSITIVE_INFINITY;
        return { ...train, distance };
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 25);

    trainSelect.innerHTML = "";
    sorted.forEach((train) => {
      const option = document.createElement("option");
      option.value = train.trainNum;
      const miles = Number.isFinite(train.distance) ? ` • ${Math.round(train.distance * 0.621371)} mi` : "";
      option.textContent = `${train.label}${miles}`;
      trainSelect.appendChild(option);
    });

    if (!sorted.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No nearby trains found";
      trainSelect.appendChild(option);
      setTrain("", { fetch: false });
      return;
    }

    const hasRequestedTrain = trainNumber && sorted.some((train) => train.trainNum === trainNumber);
    if (hasRequestedTrain) {
      setTrain(trainNumber, { fetch: false });
      return;
    }
    if (!urlParams.has("train")) {
      setTrain(sorted[0].trainNum, { fetch: false });
      return;
    }
    setTrain(sorted[0].trainNum, { fetch: false });
  } catch (error) {
    trainSelect.innerHTML = "<option value=''>Unable to load trains</option>";
  }
}

applyStationBtn.addEventListener("click", () => {
  if (viewMode === "train") {
    setTrain(trainSelect.value, { fetch: true });
    return;
  }

  const inputValue = stationInput.value.trim().toUpperCase();
  if (inputValue) {
    setStation(inputValue, { fetch: true });
  }
});

stationInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    applyStationBtn.click();
  }
});

trainSelect.addEventListener("change", () => {
  setTrain(trainSelect.value, { fetch: true });
});

viewModeSelect.addEventListener("change", (event) => {
  setViewMode(event.target.value, { fetch: true });
});

toggleNightBtn.addEventListener("click", () => {
  nightMode = !nightMode;
  applyNightMode(nightMode);
  updateUrl();
});

displaySelect.addEventListener("change", (event) => {
  displayType = event.target.value;
  applyDisplayType(displayType);
  updateUrl();
});

mapStyleSelect.addEventListener("change", (event) => {
  mapStyle = event.target.value;
  applyMapStyle(mapStyle);
  updateUrl();
});

toggleControlsBtn.addEventListener("click", () => {
  const collapsed = document.body.classList.contains("controls-collapsed");
  setControlsCollapsed(!collapsed);
});

showControlsBtn.addEventListener("click", () => {
  setControlsCollapsed(false);
});

async function initPage() {
  applyNightMode(nightMode);
  applyDisplayType(displayType);
  applyMapStyle(mapStyle);
  renderer.setStationCode(stationCode);
  stationInput.value = stationCode;
  displaySelect.value = displayType;
  mapStyleSelect.value = mapStyle;
  viewModeSelect.value = viewMode;
  setControlsCollapsed(true);
  syncViewControls();

  try {
    const position = await getCurrentPosition();
    userPosition = {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
    };
  } catch (error) {
    userPosition = null;
  }

  const nearestStation = await chooseNearestStationFromLocation();
  if (nearestStation && viewMode === "station") {
    setStation(nearestStation);
  }

  await loadTrainOptions();
  fetchData({ forceSplit: true });
  setInterval(fetchData, refreshIntervalMs);
}

initPage();
