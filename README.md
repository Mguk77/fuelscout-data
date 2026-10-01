# fuelscout-data

Publishes UK fuel prices from the GOV.UK [Fuel Finder](https://www.gov.uk/guidance/access-the-latest-fuel-prices-and-forecourt-data-via-api-or-email)
API as small area files on GitHub Pages, for the FuelScout iPhone/CarPlay app.

Every 15 minutes a GitHub Action downloads what's changed, splits the UK into
~20 km tiles and publishes them. The app downloads only the 1–4 tiles around you.
Free, with no server to run.

```
https://<you>.github.io/fuelscout-data/meta.json            last update, tile size
https://<you>.github.io/fuelscout-data/tiles/257_-9.json    forecourts + prices in one tile
```

## Setup (about 10 minutes)

1. **Create the repo.** On github.com: **New repository** → name `fuelscout-data` → **Public** → don't add a README → **Create**.
   (Public is required for free GitHub Pages and unlimited Actions minutes. Your API secret stays private in step 2;
   the fuel data itself is public under the Open Government Licence.)

2. **Add your Fuel Finder credentials** (from the [developer portal](https://www.developer.fuel-finder.service.gov.uk/access-latest-fuelprices)):
   repo **Settings → Secrets and variables → Actions → New repository secret**, twice:
   - `FUEL_FINDER_CLIENT_ID`
   - `FUEL_FINDER_CLIENT_SECRET`

3. **Turn on Pages.** Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.

4. **Upload this folder.** In Terminal:
   ```bash
   cd ~/"Watch Apps/FuelScout/fuelscout-data"
   git init -b main
   git add .
   git commit -m "Fuel price publisher"
   git remote add origin https://github.com/<you>/fuelscout-data.git
   git push -u origin main
   ```
   When asked for a password, use a [personal access token](https://github.com/settings/tokens) (classic, `repo` + `workflow` scopes),
   not your GitHub password. Or skip the terminal and use GitHub Desktop.

5. **Run it once.** Repo **Actions → Update fuel prices → Run workflow** (tick *Re-download every forecourt*).
   The first run takes a few minutes. Then open `https://<you>.github.io/fuelscout-data/meta.json`;
   it should show a `stationCount` of several thousand.

6. **Point the app at it.** In the app project, set `AppConfig.dataURL` to `https://<you>.github.io/fuelscout-data`.

From then on it updates itself every 15 minutes.

## Good to know

- **Schedules can run late.** GitHub may start scheduled runs a few minutes late at busy times.
- **60-day pause.** GitHub pauses schedules in public repos after 60 days with no commits. It emails you first;
  re-enable it under **Actions**, or push any small commit.
- **Failures are safe.** If a run fails (e.g. the API is down), the previous data stays published. See the error under **Actions**.
- **Incremental by design.** Each run reads the last published `snapshot.json` and asks Fuel Finder only for changes.
  A full re-download happens weekly, or when you tick the box in step 5.
- Prices sent in pounds (1.379) or tenths of a penny (1379) are converted to pence; values outside 50–400p are dropped.
