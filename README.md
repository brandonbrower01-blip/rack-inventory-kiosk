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
- PIN login, with a 30-minute lockout after 4 wrong PINs in a row
- Printer repairs: log what was fixed on each label printer, when, by whom and what it cost
- Barcode labels: every item gets its own code (RK-0001, RK-0002, …). After you add an item
  it offers to print the label; scanning it later opens that item, ready to take out

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
  docker compose logs kiosk   # shows your first-run PIN
  ```
  On Linux, uncomment `network_mode: host` in `docker-compose.yml` so the server sees each
  device's real IP and MAC. Otherwise every device looks the same and a lockout blocks them all.

When it starts, it prints the addresses to use:

```
Rack Inventory Kiosk running. Data folder: /path/to/rack-inventory-kiosk/data
  On this machine:   http://localhost:3000
  On your network:   http://192.168.1.50:3000
```

### 3. Note your PIN

The first time the server starts it creates a random 6-digit PIN and prints it:

```
  ==================================================
   First run. Your kiosk PIN is: 482913
   Change it in the app (Activity > Change PIN)
   or run:  node server.js --set-pin 1234
  ==================================================
```

### 4. Connect devices

On each kiosk tablet, phone or computer, open the **On your network** address in a browser.
Tip: use the browser's "Add to Home Screen" for a full-screen kiosk icon.

The green **Live** dot at the top means that device is synced. If it turns red, the device
can't reach the server. It reconnects by itself once the server is back.

If other devices can't connect, allow port 3000 through the server machine's firewall
(Windows asks the first time Node.js starts; choose **Private networks**).

## Barcode labels and scanning

**Every item gets a barcode code** like `RK-0001`, assigned in order and never reused.
Items added before barcodes existed get one automatically.

**Printing.** After you add an item, the app shows its label and asks you to print it. You
can also print from any item (**Print label**), or print many at once (**Print labels** on
the Inventory screen). The list ticks items that still need a label and tracks which have
been printed. Two layouts:

- **Label printer, 1 × 0.5 in** (1 in wide, ½ in tall). One label per page. Works with Dymo,
  Brother, Zebra and Rollo printers. In the print dialog choose the 1 × 0.5 in label size and set margins
  to none.
- **Regular paper, Letter.** Labels laid out 6 across with cut lines.

Each label has the item name (one line), a **Code 128 barcode** and the code in plain text.
So the bars fit a 1-inch label and still print cleanly, the barcode holds a 6-digit number
instead of the letters: `100001` is item `RK-0001`, `200001` is printer `PR-0001`. The app
understands both, so labels printed before this change still work. (If you scan a label into
another program, such as Excel, you'll see the 6-digit number.)

**Scanning** opens the item with **Take out** selected, so you only set the count and enter
your name:

- **USB or Bluetooth barcode scanner** (works like a keyboard): just scan, on any screen.
  Nothing needs to be clicked first. Scanning on the PIN screen is ignored and never counts
  as a wrong PIN.
- **Scan button:** type a code by hand. On HTTPS setups in Chrome/Edge it can also use the
  device's camera.

## Printer repairs

The **Printer repairs** tab keeps a maintenance history for your label printers.

1. **Add printer**: a name (like "Shipping desk printer"), make and model, serial number,
   where it is, and any notes such as warranty dates. Each printer gets its own barcode code
   (`PR-0001`, `PR-0002`, …) and the app offers to print a label for it.
2. **Stick the label on the printer.** It shows the make and model, serial number and barcode,
   but not the printer's name, so moving or renaming a printer never means relabelling it.
   Scanning it on any screen opens that printer's repair history under its current name. **Print printer labels** prints several at once.
3. **Log a repair** whenever one is fixed: the date, the type of repair, who did it, parts,
   cost and what happened. Common repair types are offered (printhead cleaned or replaced,
   platen roller, label jam, cutter, sensor calibration, firmware, power supply and more), or
   type your own. Scanning the printer's label while the form is open fills in the printer.
4. Tap a printer to see its full history and total repair cost. Tap any repair to correct or
   delete it.

**Parts from inventory.** In the repair form, **+ Add a part** (or scan a part's barcode) and
set how many with − / +. Saving takes those parts out of inventory, logged in Activity under
the person in **Done by** with a note like "Used to repair Warehouse ZT230: Printhead
replaced". Done by is required when parts are taken. Stock is checked first: if any part
doesn't have enough on hand, nothing is saved. Editing a repair takes out or puts back the
difference. Deleting one offers to put its parts back. Parts that aren't in inventory can still
be typed into **Other parts**.

**Search** printers by name, `PR-` code, model, serial number or location; it also searches
repair types, notes, parts and who did them. Typing or scanning a `PR-` code and pressing Enter
opens that printer. Filter the history by printer or repair type, and **Export (CSV)** for a
spreadsheet.

**Full history.** Opening a printer shows everything that has ever happened to it, newest
first: when it was added, every change to its name, model, serial number, location or notes
(old value → new value), every repair logged, edited (what changed), moved or deleted, label
printing, and removal. Each entry records the time, the device it came from and, when entered,
the person's name. Forms that change a printer or a repair have an optional **Your name** box
for this. **Export history** downloads one printer's history as CSV. Printers and repairs that
existed before this feature get their starting entries automatically, marked "recorded before
history tracking started".
Removing a printer keeps its past repairs in the history.

## Settings

Set these as environment variables before starting:

| Variable   | Default        | What it does                          |
|------------|----------------|---------------------------------------|
| `PORT`     | `3000`         | Port the web server listens on        |
| `HOST`     | `0.0.0.0`      | Network address to listen on          |
| `DATA_DIR` | `./data`       | Where items, activity and photos live |
| `KIOSK_PIN` | (random on first run) | Sets the PIN at startup |
| `MAX_PIN_ATTEMPTS` | `4` | Wrong PINs in a row before a lockout |
| `LOCKOUT_MINUTES` | `30` | How long a lockout lasts |
| `SESSION_HOURS` | `24` | How long a device stays logged in |
| `TRUST_PROXY` | off | Set to `1` only behind a reverse proxy, to read the real client IP |

## Your data

Everything is saved in the `data` folder:

- `items.json`: the item list and counts
- `activity.jsonl`: every take, return, restock and correction, one per line
- `uploads/`: item photos
- `printers.json` and `repairs.json`: label printers and their repair records
- `printer-history.jsonl`: every change to each printer and its repairs, one per line
- `config.json`: the PIN (stored hashed, never in plain text)
- `security.json`: logged-in devices and lockouts

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

## PIN and lockouts

Every device must enter the PIN before it can see or change anything. A device stays logged in
for 24 hours (`SESSION_HOURS`) or until someone presses **Lock**.

**4 wrong PINs in a row locks that device out for 30 minutes.** The server recognises a device by:

| What                | Notes |
|---------------------|-------|
| MAC address         | Looked up from the server's ARP table. Only works for devices on the **same local network** as the server (not across routers or VPNs). Browsers can't report their own MAC. |
| IP address          | Always used. |
| Device cookie       | A long-lived cookie set in the browser. |

If any one of these is locked, the device is blocked. So clearing cookies, using a private
window or getting a new IP doesn't get around a lockout. Devices that share an IP address
(for example behind a NAT router or in Docker's default networking) get locked together.
Lockouts are saved, so restarting the server doesn't clear them. Every lockout is recorded in
the Activity log with the device's IP and MAC.

**Changing the PIN** (Activity → Change PIN) logs out every other device.

**Forgot the PIN or need to unlock a device now?** On the server machine:

```bash
node server.js --set-pin 1234   # set a new PIN
node server.js --unlock         # clear all lockouts (restart the server afterwards)
```

With Docker: `docker compose exec kiosk node server.js --set-pin 1234`.

Keep the server on your internal network and don't expose port 3000 to the internet. The
connection is plain HTTP, so anyone able to watch your network traffic could see the PIN as
it's sent. Put it behind an HTTPS reverse proxy if that matters for you (set `TRUST_PROXY=1`
so lockouts use the real client IP).

## API

The page talks to a small JSON API, which you can also script against:

All routes except `/api/auth/*` need a logged-in session cookie (`POST /api/auth/login {pin}`).

| Method & path                          | Purpose                                              |
|----------------------------------------|------------------------------------------------------|
| `GET /api/auth/status`                 | Logged in? Locked? Tries left                        |
| `POST /api/auth/login`                 | `{pin}`                                              |
| `POST /api/auth/logout`                | Lock this device                                     |
| `POST /api/auth/change-pin`            | `{current, next}`                                    |
| `GET /api/items`                       | All items                                            |
| `POST /api/items`                      | Add item `{name, qty, unit}`                         |
| `PUT /api/items/:id`                   | Edit item `{name, unit, qty, person}`                |
| `DELETE /api/items/:id`                | Remove item                                          |
| `POST /api/labels-printed`             | Mark labels printed `{ids: [...]}`                   |
| `GET/POST /api/printers`               | List or add label printers                           |
| `PUT/DELETE /api/printers/:id`         | Edit or remove a printer (its repairs are kept)      |
| `GET/POST /api/repairs`                | List or log repairs `{printerId, date, type, doneBy, parts, cost, notes, inventoryParts: [{itemId, qty}]}` |
| `PUT/DELETE /api/repairs/:id`          | Edit or delete a repair (`?returnParts=1` puts parts back) |
| `GET /api/printer-history`             | Printer history (`?printer=<id>` for one printer)    |
| `GET /api/export/printer-history.csv`  | Printer history CSV (`?printer=<id>`)                |
| `GET /api/export/repairs.csv`          | Repair history CSV (`printer`, `type` filters)       |
| `POST /api/items/:id/image`            | Upload photo (raw JPEG/PNG/WebP/GIF body)            |
| `POST /api/items/:id/transactions`     | `{type: take\|return\|restock, qty, person, note}`   |
| `GET /api/log?limit=1000`              | Latest activity, newest first                        |
| `GET /api/events`                      | Live change notifications (Server-Sent Events)       |
| `GET /api/export/inventory.csv`        | Inventory CSV                                        |
| `GET /api/export/activity.csv`         | Activity CSV (`q`, `type`, `from`, `to` in ms)       |

## Third-party code

`public/vendor/` contains [JsBarcode](https://github.com/lindell/JsBarcode) Code 128
(MIT, © Johan Lindell), bundled so labels print without an internet connection.
