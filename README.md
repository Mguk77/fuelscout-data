# fuelscout-data

Publishes UK fuel prices from the GOV.UK [Fuel Finder](https://www.gov.uk/guidance/access-the-latest-fuel-prices-and-forecourt-data-via-api-or-email)
API as small area files on GitHub Pages, for the FuelScout iPhone/CarPlay app.

Every 15 minutes a Google Cloud Run job in London downloads what's changed, splits the UK into
~20 km tiles and pushes them to the `gh-pages` branch, which GitHub Pages serves.
The app downloads only the 1–4 tiles around you. Expected to stay within Google's free allowance.

```
https://<you>.github.io/fuelscout-data/meta.json            last update, tile size
https://<you>.github.io/fuelscout-data/tiles/257_-9.json    forecourts + prices in one tile
```

**Why Google Cloud and not GitHub Actions?** The Fuel Finder API only answers requests from UK addresses.
Anything else (GitHub's runners, AWS Stockholm, servers in the Netherlands, Germany or the US) gets an empty
`403` from CloudFront. Google Cloud's London region (`europe-west2`) gets through.

## How it fits together

| Part | Where | What it does |
|---|---|---|
| `scripts/update.mjs` | Cloud Run job `fuelscout-updater` | Downloads changes from Fuel Finder and writes `./public` |
| `scripts/publish.sh` | same job | Force-pushes `./public` as the single commit on `gh-pages` |
| Cloud Scheduler `fuelscout-every-15-min` | `europe-west2` | Starts the job every 15 minutes |
| Secret Manager | `europe-west2` | `FUEL_FINDER_CLIENT_ID`, `FUEL_FINDER_CLIENT_SECRET`, `GITHUB_TOKEN` |
| GitHub Pages | this repo, `gh-pages` branch | Serves the files to the app |

The job runs as the service account `fuelscout-updater@<project>.iam.gserviceaccount.com`, which can only
read those three secrets and start the job.

## Setup

1. **GitHub repo.** Create a public repo `fuelscout-data` and push this folder to `main`.

2. **GitHub token.** **Settings → Developer settings → Fine-grained tokens**: only the `fuelscout-data` repo,
   permission **Contents: Read and write**, nothing else. Set a reminder to renew it before it expires.

3. **Google Cloud project.** Create a project at [console.cloud.google.com](https://console.cloud.google.com),
   link billing (a card is required), and add a small budget alert under **Billing → Budgets & alerts**.
   Install the [gcloud CLI](https://cloud.google.com/sdk/docs/install), then:
   ```bash
   gcloud auth login
   gcloud config set project <project-id>
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com
   gcloud iam service-accounts create fuelscout-updater --display-name="FuelScout updater"
   ```

4. **Secrets.** For each of `FUEL_FINDER_CLIENT_ID`, `FUEL_FINDER_CLIENT_SECRET` (from the
   [Fuel Finder developer portal](https://www.developer.fuel-finder.service.gov.uk/access-latest-fuelprices))
   and `GITHUB_TOKEN`, paste the value when prompted:
   ```bash
   read -s "v?Value: " && printf '%s' "$v" | gcloud secrets create FUEL_FINDER_CLIENT_ID --replication-policy=user-managed --locations=europe-west2 --data-file=- ; unset v
   gcloud secrets add-iam-policy-binding FUEL_FINDER_CLIENT_ID --member=serviceAccount:fuelscout-updater@<project-id>.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
   ```
   To change a value later, use `gcloud secrets versions add <NAME> --data-file=-` the same way.

5. **Deploy and run the job.**
   ```bash
   gcloud run jobs deploy fuelscout-updater --source . --region europe-west2 \
     --service-account fuelscout-updater@<project-id>.iam.gserviceaccount.com \
     --set-secrets FUEL_FINDER_CLIENT_ID=FUEL_FINDER_CLIENT_ID:latest,FUEL_FINDER_CLIENT_SECRET=FUEL_FINDER_CLIENT_SECRET:latest,GITHUB_TOKEN=GITHUB_TOKEN:latest \
     --set-env-vars SITE_URL=https://<you>.github.io/fuelscout-data/,GITHUB_REPO=<you>/fuelscout-data \
     --memory 512Mi --task-timeout 20m --max-retries 0
   gcloud run jobs execute fuelscout-updater --region europe-west2 --wait
   ```

6. **Turn on Pages.** Repo **Settings → Pages → Deploy from a branch → `gh-pages` / root**.
   Then open `https://<you>.github.io/fuelscout-data/meta.json`; `stationCount` should be several thousand.

7. **Schedule it.**
   ```bash
   gcloud run jobs add-iam-policy-binding fuelscout-updater --region europe-west2 --member=serviceAccount:fuelscout-updater@<project-id>.iam.gserviceaccount.com --role=roles/run.invoker
   gcloud scheduler jobs create http fuelscout-every-15-min --location europe-west2 --schedule="*/15 * * * *" --http-method=POST \
     --uri="https://run.googleapis.com/v2/projects/<project-id>/locations/europe-west2/jobs/fuelscout-updater:run" \
     --oauth-service-account-email=fuelscout-updater@<project-id>.iam.gserviceaccount.com
   ```

8. **Point the app at it.** In the app project, set `AppConfig.dataURL` to `https://<you>.github.io/fuelscout-data`.

After changing the scripts, redeploy with the command in step 5.

## Good to know

- **Failures are safe.** If a run fails (e.g. the API is down), the previous data stays published.
  See **Cloud Run → Jobs → fuelscout-updater → Logs**.
- **Force a full re-download** with
  `gcloud run jobs execute fuelscout-updater --region europe-west2 --update-env-vars FORCE_FULL=true`.
- **Incremental by design.** Each run reads the last published `snapshot.json` and asks Fuel Finder only for changes.
  A full re-download happens weekly.
- **Rate limits.** Fuel Finder allows 100 requests a minute, one at a time; the script makes one request at a time.
- **Terms.** Fuel Finder's developer guidelines say "don't redistribute raw API data". This repo publishes reshaped
  area files plus `snapshot.json`; confirm with the Fuel Finder team that this is acceptable.
- Prices sent in pounds (1.379) or tenths of a penny (1379) are converted to pence; values outside 50–400p are dropped.
