const trainsEndpoint = "https://api-v3.amtraker.com/v3/trains";
const staleEndpoint = "https://api-v3.amtraker.com/v3/stale";
const stationsEndpoint = "https://api-v3.amtraker.com/v3/stations";

function normalizeTrainsPayload(data) {
  if (data && Array.isArray(data.trains)) {
    return data.trains.filter((item) => item && typeof item === "object");
  }
  if (data && typeof data === "object") {
    const flattened = [];
    Object.values(data).forEach((value) => {
      if (!Array.isArray(value)) {
        return;
      }
      value.forEach((item) => {
        if (item && typeof item === "object") {
          flattened.push(item);
        }
      });
    });
    return flattened;
  }
  return [];
}

function normalizeStationsPayload(data) {
  if (!data) {
    return [];
  }
  if (Array.isArray(data)) {
    return data.filter((item) => item && typeof item === "object");
  }
  if (typeof data === "object") {
    if (Array.isArray(data.stations)) {
      return data.stations.filter((item) => item && typeof item === "object");
    }
    return Object.values(data).filter((item) => item && typeof item === "object");
  }
  return [];
}

function parseTimestamp(value) {
  if (!value) {
    return null;
  }
  const cleaned = value.trim();
  if (!cleaned) {
    return null;
  }
  const hasTimezone = /([+-]\d{2}:\d{2}|Z)$/.test(cleaned);
  const normalized = hasTimezone ? cleaned : `${cleaned}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function computeEtaMinutes(arrivalTime, now) {
  const deltaMinutes = (arrivalTime - now) / 60000;
  if (deltaMinutes <= 1) {
    return 0;
  }
  return Math.ceil(deltaMinutes);
}

function chooseArrivalTime(station) {
  const actual = parseTimestamp(station.arr);
  if (actual) {
    return { time: actual, source: "actual" };
  }
  const scheduled = parseTimestamp(station.schArr);
  if (scheduled) {
    return { time: scheduled, source: "scheduled" };
  }
  return { time: null, source: "unknown" };
}

function readNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function getCoordinates(entity) {
  if (!entity || typeof entity !== "object") {
    return null;
  }
  const lat = readNumber(entity.lat ?? entity.latitude ?? entity.latit);
  const lon = readNumber(entity.lon ?? entity.lng ?? entity.long ?? entity.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return { lat, lon };
}

function buildStationLookup(stations) {
  const lookup = new Map();
  stations.forEach((station) => {
    const code = (station.code || station.station_code || station.stationCode || "").trim();
    if (!code) {
      return;
    }
    const coords = getCoordinates(station);
    if (!coords) {
      return;
    }
    lookup.set(code.toUpperCase(), {
      coords,
      name: station.name || station.stationName || "",
    });
  });
  return lookup;
}

function normalizeTrainNumber(train) {
  return String(train?.trainNum || train?.trainID || "").trim();
}

function selectStationArrivals(trains, station, now, stationLookup) {
  const arrivals = [];
  const graceWindowMs = 15 * 60 * 1000;
  const delayThresholdMs = 5 * 60 * 1000;

  trains.forEach((train) => {
    const stations = Array.isArray(train.stations) ? train.stations : [];
    const stationStop = stations.find((item) => (item.code || "").toUpperCase() === station.toUpperCase());
    if (!stationStop) {
      return;
    }
    const stationStatus = (stationStop.status || "").toLowerCase();
    if (stationStatus.includes("departed")) {
      return;
    }

    const scheduledArrival = parseTimestamp(stationStop.schArr);
    const actualArrival = parseTimestamp(stationStop.arr);
    const { time: arrivalTime, source: timeSource } = chooseArrivalTime(stationStop);
    if (!arrivalTime) {
      return;
    }
    if (arrivalTime.getTime() < now.getTime() - graceWindowMs) {
      return;
    }

    let statusMsg = train.statusMsg || stationStop.status;
    if (scheduledArrival) {
      if (actualArrival && actualArrival - scheduledArrival >= delayThresholdMs) {
        statusMsg = "Delayed";
      } else if (!actualArrival && now.getTime() > scheduledArrival.getTime() + delayThresholdMs) {
        statusMsg = "Delayed";
      } else if (!statusMsg?.trim()) {
        statusMsg = "On time";
      }
    }

    const trainLocation = getCoordinates(train);
    const lookupEntry = stationLookup?.get(station.toUpperCase());
    const stationLocation = lookupEntry?.coords || getCoordinates(stationStop);
    const stationName = lookupEntry?.name || stationStop.name || "";

    arrivals.push({
      station_code: station,
      station_name: stationName,
      trainNum: normalizeTrainNumber(train),
      routeName: train.routeName || train.route || "",
      origin: {
        name: train.origName || train.origin || "",
        code: train.origCode || train.originCode || "",
      },
      destination: {
        name: train.destName || train.destination || "",
        code: train.destCode || train.destinationCode || "",
      },
      arrivalTime: arrivalTime.toISOString(),
      etaMinutes: computeEtaMinutes(arrivalTime, now),
      statusMsg,
      timeSource,
      trainLocation,
      stationLocation,
    });
  });

  return arrivals.sort((a, b) => new Date(a.arrivalTime) - new Date(b.arrivalTime));
}

function selectUpcomingStops(train, now, stationLookup) {
  const stops = [];
  const graceWindowMs = 10 * 60 * 1000;
  const stations = Array.isArray(train.stations) ? train.stations : [];

  stations.forEach((stop, index) => {
    const status = (stop.status || "").toLowerCase();
    if (status.includes("departed") || status.includes("completed")) {
      return;
    }
    const { time: arrivalTime, source: timeSource } = chooseArrivalTime(stop);
    if (!arrivalTime || arrivalTime.getTime() < now.getTime() - graceWindowMs) {
      return;
    }

    const stationCode = (stop.code || "").toUpperCase();
    const stationLookupEntry = stationLookup.get(stationCode);
    const previousStop = stations[index - 1] || null;
    const previousName = previousStop?.name || previousStop?.code || train.origName || train.origCode || "";

    stops.push({
      station_code: stationCode,
      station_name: stationLookupEntry?.name || stop.name || stationCode,
      trainNum: normalizeTrainNumber(train),
      routeName: train.routeName || train.route || "",
      origin: {
        name: previousName,
        code: previousStop?.code || "",
      },
      destination: {
        name: stationLookupEntry?.name || stop.name || stationCode,
        code: stationCode,
      },
      arrivalTime: arrivalTime.toISOString(),
      etaMinutes: computeEtaMinutes(arrivalTime, now),
      statusMsg: stop.status || train.statusMsg || "On time",
      timeSource,
      trainLocation: getCoordinates(train),
      stationLocation: stationLookupEntry?.coords || getCoordinates(stop),
    });
  });

  return stops.sort((a, b) => new Date(a.arrivalTime) - new Date(b.arrivalTime));
}

async function fetchStaleFlag() {
  try {
    const response = await fetch(staleEndpoint, { cache: "no-store" });
    if (!response.ok) {
      return false;
    }
    const data = await response.json();
    return Boolean(data.stale);
  } catch (error) {
    return false;
  }
}

async function fetchTrainsPayload() {
  const response = await fetch(trainsEndpoint, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Bad response: ${response.status}`);
  }
  return response.json();
}

async function fetchStationsPayload() {
  const response = await fetch(stationsEndpoint, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Bad response: ${response.status}`);
  }
  return response.json();
}

export async function fetchStationLocations() {
  const stationsPayload = await fetchStationsPayload();
  const stations = normalizeStationsPayload(stationsPayload);
  return stations
    .map((station) => {
      const code = (station.code || station.station_code || station.stationCode || "").trim();
      const coords = getCoordinates(station);
      if (!code || !coords) {
        return null;
      }
      return {
        code: code.toUpperCase(),
        name: station.name || station.stationName || "",
        coords,
      };
    })
    .filter(Boolean);
}

export async function fetchTrainsList() {
  const payload = await fetchTrainsPayload();
  const trains = normalizeTrainsPayload(payload);
  return trains
    .map((train) => {
      const trainNum = normalizeTrainNumber(train);
      const coords = getCoordinates(train);
      if (!trainNum || !coords) {
        return null;
      }
      return {
        trainNum,
        routeName: train.routeName || train.route || "",
        label: `${train.routeName || "Train"} ${trainNum}`.trim(),
        coords,
      };
    })
    .filter(Boolean);
}

export async function fetchArrivalsData({ stationCode, trainNum, mode = "station" }) {
  const [payload, stale, stationsPayload] = await Promise.all([
    fetchTrainsPayload(),
    fetchStaleFlag(),
    fetchStationsPayload().catch(() => null),
  ]);
  const trains = normalizeTrainsPayload(payload);
  const stations = normalizeStationsPayload(stationsPayload);
  const stationLookup = buildStationLookup(stations);
  const now = new Date();

  if (mode === "train") {
    const selectedTrain = trains.find((item) => normalizeTrainNumber(item) === String(trainNum || ""));
    const upcoming = selectedTrain ? selectUpcomingStops(selectedTrain, now, stationLookup) : [];
    const nextTrain = upcoming[0] || null;
    return {
      mode,
      station_code: stationCode || "",
      train_num: trainNum || "",
      context_code: trainNum || "",
      context_label: "Train",
      now_utc: now.toISOString(),
      next_train: nextTrain,
      upcoming_trains: upcoming.slice(0, 8),
      last_updated_utc: now.toISOString(),
      data_source: "amtraker_v3_unofficial",
      stale,
      now,
    };
  }

  const arrivals = selectStationArrivals(trains, stationCode, now, stationLookup);
  const nextTrain = arrivals[0] || null;

  return {
    mode,
    station_code: stationCode,
    context_code: stationCode,
    context_label: "Next arrival at",
    now_utc: now.toISOString(),
    next_train: nextTrain,
    upcoming_trains: arrivals.slice(0, 8),
    last_updated_utc: now.toISOString(),
    data_source: "amtraker_v3_unofficial",
    stale,
    now,
  };
}
