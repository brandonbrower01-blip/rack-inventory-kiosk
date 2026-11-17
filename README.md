# Rack Inventory Kiosk

A simple, self-hosted kiosk for tracking what people take from your storage racks.
Run the server on one machine, then open it in a web browser on any tablet, phone or PC on
the same network. Every device stays in sync live.

- Photo cards for every item, with search and sort
- Tap an item, use the **−** / **+** counter to set how many, enter your name, confirm
- Put items back, or restock when new stock arrives
- Activity log of **who** took **what**, **how many**, and **when**, with filters
- Export inventory and activity to CSV (opens in Excel or Google Sheets)
- Add, edit or remove items, with photos taken right from a tablet's camera

No database to install and no extra packages. Only [Node.js](https://nodejs.org) 18 or newer.

## Install and run

### 1. Get the code

```bash
git clone https://github.com/brandonbrower01-blip/rack-inventory-kiosk.git
cd rack-inventory-kiosk
```

(Or on GitHub: **Code → Download ZIP**, then unzip it.)

### 2. Start the server

- **Windows:** install Node.js (LTS) from https://nodejs.org, then double-click `start-windows.bat`.
- **Mac / Linux:**
  ```bash
  ./start.sh
  ```
  or `npm start`.
- **Docker:**
  ```bash
  docker compose up -d
  ```

When it starts, it prints the addresses to use:

```
Rack Inventory Kiosk running. Data folder: /path/to/rack-inventory-kiosk/data
  On this machine:   http://localhost:3000
  On your network:   http://192.168.1.50:3000
```

### 3. Connect devices

On each kiosk tablet, phone or computer, open the **On your network** address in a browser.
Tip: use the browser's "Add to Home Screen" for a full-screen kiosk icon.

The green **Live** dot at the top means that device is synced. If it turns red, the device
can't reach the server. It reconnects by itself once the server is back.

If other devices can't connect, allow port 3000 through the server machine's firewall
(Windows asks the first time Node.js starts; choose **Private networks**).

## Settings

Set these as environment variables before starting:

| Variable   | Default        | What it does                          |
|------------|----------------|---------------------------------------|
| `PORT`     | `3000`         | Port the web server listens on        |
| `HOST`     | `0.0.0.0`      | Network address to listen on          |
| `DATA_DIR` | `./data`       | Where items, activity and photos live |

## Your data

Everything is saved in the `data` folder:

- `items.json`: the item list and counts
- `activity.jsonl`: every take, return, restock and correction, one per line
- `uploads/`: item photos

**Back up by copying the `data` folder.** To move to a new machine, copy it over before
starting the server there. Updating the app (`git pull`) never touches it.

## Keep it running after a reboot

- **Docker:** `restart: unless-stopped` is already set in `docker-compose.yml`.
- **Linux (systemd):** create `/etc/systemd/system/rack-kiosk.service`:
  ```ini
  [Unit]
  Description=Rack Inventory Kiosk
  After=network.target

  [Service]
  WorkingDirectory=/opt/rack-inventory-kiosk
  ExecStart=/usr/bin/node server.js
  Restart=always
  User=www-data

  [Install]
  WantedBy=multi-user.target
  ```
  then run `sudo systemctl enable --now rack-kiosk`.
- **Windows:** add a shortcut to `start-windows.bat` in the Startup folder (`Win + R`, type `shell:startup`).

## Security note

There are no logins. Anyone who can reach the server's address can log, edit and export.
Keep it on your internal network and don't expose port 3000 to the internet.

## API

The page talks to a small JSON API, which you can also script against:

| Method & path                          | Purpose                                              |
|----------------------------------------|------------------------------------------------------|
| `GET /api/items`                       | All items                                            |
| `POST /api/items`                      | Add item `{name, qty, unit}`                         |
| `PUT /api/items/:id`                   | Edit item `{name, unit, qty, person}`                |
| `DELETE /api/items/:id`                | Remove item                                          |
| `POST /api/items/:id/image`            | Upload photo (raw JPEG/PNG/WebP/GIF body)            |
| `POST /api/items/:id/transactions`     | `{type: take\|return\|restock, qty, person, note}`   |
| `GET /api/log?limit=1000`              | Latest activity, newest first                        |
| `GET /api/events`                      | Live change notifications (Server-Sent Events)       |
| `GET /api/export/inventory.csv`        | Inventory CSV                                        |
| `GET /api/export/activity.csv`         | Activity CSV (`q`, `type`, `from`, `to` in ms)       |
