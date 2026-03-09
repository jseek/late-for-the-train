# Late for the Train

Static web app for viewing upcoming Amtrak arrivals.

## Run locally (Docker)

Requirements:
- Docker Desktop (or Docker Engine + Compose)

Commands:
```bash
docker compose up --build
```

Open:
- http://localhost:8080

If port `8080` is already in use:
```bash
PORT=8081 docker compose up --build
```
Then open `http://localhost:8081`.

Stop:
```bash
docker compose down
```

Notes:
- The app is static and runs in Nginx.
- `docker-compose.yml` mounts the repo read-only into the container so frontend edits reload on refresh.

## Run locally (without Docker)

Because this app uses ES modules, serve it over HTTP (do not open `index.html` directly via `file://`).

Example with Python:
```bash
python3 -m http.server 8080
```

Open:
- http://localhost:8080

## Data/CORS caveat

The app fetches data from `https://api-v3.amtraker.com`.
Some browsers or networks may block those requests because of CORS. If that happens, use a proxy endpoint and point the frontend at it (the footer in `index.html` includes example proxy URLs).
