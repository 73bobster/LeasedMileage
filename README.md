# LeasedMileage — setup

A companion app to MotoringMonitor. Same Neon database, same household
and vehicle data, no schema changes. Plain HTML/CSS/JS, no build step.

## 1. Database connection

The connection to the shared Neon project is set in `neon-compat.js`
(the same values MotoringMonitor uses). Do not create a new database;
this app is designed to read and write the same households, vehicles,
and readings.

## 2. Run it locally

Any static file server works, since the browser needs to load `index.html`
relative to `sync.js`, `app.js`, `style.css`, and `icon.svg` sitting next
to it. From inside the `leasedmileage` folder:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080` in a browser. Opening `index.html`
directly via `file://` will not work — Neon auth requires a proper
origin.

## 3. Smoke test checklist

Run through this once against your real Neon database before treating
it as done. All of it should also be checkable directly from MotoringMonitor's
own screens, since both apps read the same tables.

- **Register → new household** — creates a household row, logs you in,
  lands on an empty main screen ("Add your first car").
- **Register → join with code** — use a join code from an existing
  MotoringMonitor household; confirm you land on the *same* cars that
  household already has.
- **Log in with an existing MotoringMonitor account** — confirm the
  same cars appear here as in MotoringMonitor, with the same mileage.
- **Add a car** — fill all 7 fields, save, confirm it appears in
  MotoringMonitor too (with `ownership_type` showing as leased there).
- **Add a car with no lease dates/cap** — confirm the card shows plain
  mileage with no progress bars or forecast strip (no error).
- **Log a reading higher than current** — confirm it saves, the "Reading
  saved" confirmation shows, and the card's mileage/bars update.
- **Log a reading lower than current** — confirm it's rejected with the
  inline error and nothing is written to `readings`.
- **Edit a car's capped miles / term end** — confirm the progress bars
  and forecast update accordingly on next load.
- **Go offline (dev tools → network → offline), log a reading** — confirm
  the offline banner shows and the reading is queued, not lost.
- **Come back online** — confirm the queued reading flushes automatically
  and a "Synced" toast appears.
- **Log out, log back in** — confirm the session persists correctly and
  you're not stuck on the auth screen after a refresh mid-session.

## Known limitations to flag if they matter to you

- The mileage forecast is a straight-line projection from a single pace
  calculation (miles so far ÷ time elapsed so far). It will be noisy
  early in a lease when little time has passed — that's expected, not
  a bug.
- There's no confirmation dialog before saving a reading or vehicle edit
  — saves are immediate. Deleting a vehicle isn't implemented in this
  slimmed-down app at all (that stays a MotoringMonitor-only action,
  consistent with "member can add/edit, only owner can delete" in the
  handoff note).
- Household join codes aren't validated for format client-side — an
  invalid code surfaces whatever error Postgres/RLS returns, which may
  be a little raw ("Invalid join code" from the RPC, so it's readable,
  but not styled).
