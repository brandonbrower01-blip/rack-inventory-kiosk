# Rack Inventory Kiosk

A simple, touch-friendly kiosk page for tracking what people take from storage racks.

- Browse items as photo cards, search and sort by name or stock level
- Tap an item, use the − / + counter to set how many, enter your name, and confirm
- Put items back or restock new deliveries
- Activity log of who took what, how many, and when, with type and date filters
- Export inventory and activity as CSV
- Add, edit, or remove items (with photos)

## How it runs

`index.html` is a single-file page published as a claude.ai Artifact. It relies on the
Artifact runtime (`window.claude.use(...)`) for:

| Capability | Used for |
|---|---|
| `db` | Shared item list (`items`) and activity log (`log`) |
| `user` | Recording the signed-in account on each log entry, read-only detection |
| `assets` | Storing item photos (`upload: "interact"`) |
| `downloads` | Saving CSV exports |

Opened outside claude.ai (for example straight from GitHub Pages) the page loads but shows a
notice that the inventory database isn't reachable. To run it standalone you'd swap those calls
for your own backend (e.g. Firebase/Supabase for data and images).

Live version: https://claude.ai/artifact/D8B8WTLknvWXsiJMY6GnRK

## Data model

- `items/{id}`: `name`, `qty`, `unit`, `imageId`, `createdAt`, `updatedAt`
- `log/{id}`: `itemId`, `itemName`, `type` (`take` | `return` | `restock` | `adjust` | `add`),
  `qty`, `delta`, `after`, `person`, `note`, `at` (ms), `uid`
