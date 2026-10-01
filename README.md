# fuelscout-data

Backend for the FuelScout iPhone/CarPlay app: keeps UK fuel prices from the GOV.UK
[Fuel Finder](https://www.gov.uk/guidance/access-the-latest-fuel-prices-and-forecourt-data-via-api-or-email)
API in a private Cloud Storage bucket, and answers the app's "stations near me" requests.
Nothing is published as public files. Runs on Google Cloud in London and is expected to stay within the free allowance.

```
Fuel Finder API ──(every 15 min)──▶ job fuelscout-updater ──▶ private bucket: snapshot.json
                                                                  │
app ──GET /v1/stations?lat=…&lon=…&radiusMiles=…──▶ service fuelscout-api (reads the snapshot)
```

**Why London?** The Fuel Finder API only answers requests from UK addresses. Anything else (GitHub Actions,
AWS Stockholm, servers in the Netherlands, Germany or the US) gets an empty `403` from CloudFront.

## How it fits together

| Part | Runs as | Can access |
|---|---|---|
| Cloud Run job `fuelscout-updater` (`scripts/update.mjs`) | `fuelscout-updater@<project>.iam.gserviceaccount.com` | The two Fuel Finder secrets; read/write the bucket |
| Cloud Run service `fuelscout-api` (`scripts/server.mjs`) | `fuelscout-api@<project>.iam.gserviceaccount.com` | Read the bucket |
| Cloud Scheduler `fuelscout-every-15-min` | starts the job as `fuelscout-updater` | |
| Bucket `gs://<project>-data` | private, public access prevented | |

### The API

`GET /v1/stations?lat=51.5&lon=-0.12&radiusMiles=8` returns
`{ "version": 1, "updatedAt": "…", "stations": [ … ] }`: open forecourts with prices, within the radius.

- `radiusMiles` must be between 0 and 30 (the most the app asks for), and the point must be in the UK.
- Each client IP gets 60 requests per 10 minutes per server instance, then `429`.
- These limits slow down bulk copying but don't prevent it: anyone who knows the address can call it.
  Firebase App Check (only genuine copies of the app can call) is the next step if that matters.

## Setup

Replace `<project>` with your Google Cloud project ID.

1. **Google Cloud project.** Create one at [console.cloud.google.com](https://console.cloud.google.com),
   link billing (a card is required), and add a small budget alert under **Billing → Budgets & alerts**.
   Install the [gcloud CLI](https://cloud.google.com/sdk/docs/install), then:
   ```bash
   gcloud auth login
   gcloud config set project <project>
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com storage.googleapis.com
   gcloud iam service-accounts create fuelscout-updater --display-name="FuelScout updater"
   gcloud iam service-accounts create fuelscout-api --display-name="FuelScout API"
   ```

2. **Private bucket.**
   ```bash
   gcloud storage buckets create gs://<project>-data --location=europe-west2 --uniform-bucket-level-access --public-access-prevention
   gcloud storage buckets add-iam-policy-binding gs://<project>-data --member=serviceAccount:fuelscout-updater@<project>.iam.gserviceaccount.com --role=roles/storage.objectAdmin
   gcloud storage buckets add-iam-policy-binding gs://<project>-data --member=serviceAccount:fuelscout-api@<project>.iam.gserviceaccount.com --role=roles/storage.objectViewer
   ```

3. **Fuel Finder secrets** (from the [developer portal](https://www.developer.fuel-finder.service.gov.uk/access-latest-fuelprices)).
   Run once for `FUEL_FINDER_CLIENT_ID` and once for `FUEL_FINDER_CLIENT_SECRET`, pasting the value when prompted:
   ```bash
   read -s "v?Value: " && printf '%s' "$v" | gcloud secrets create FUEL_FINDER_CLIENT_ID --replication-policy=user-managed --locations=europe-west2 --data-file=- ; unset v
   gcloud secrets add-iam-policy-binding FUEL_FINDER_CLIENT_ID --member=serviceAccount:fuelscout-updater@<project>.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
   ```
   To change a value later, use `gcloud secrets versions add <NAME> --data-file=-` the same way.

4. **Deploy and run the job.** The first run downloads every forecourt.
   ```bash
   gcloud run jobs deploy fuelscout-updater --source . --region europe-west2 \
     --service-account fuelscout-updater@<project>.iam.gserviceaccount.com \
     --set-secrets FUEL_FINDER_CLIENT_ID=FUEL_FINDER_CLIENT_ID:latest,FUEL_FINDER_CLIENT_SECRET=FUEL_FINDER_CLIENT_SECRET:latest \
     --set-env-vars BUCKET=<project>-data --memory 512Mi --task-timeout 20m --max-retries 0
   gcloud run jobs execute fuelscout-updater --region europe-west2 --wait
   ```

5. **Deploy the API.** `--max-instances 2` caps the cost if it's ever hammered.
   ```bash
   gcloud run deploy fuelscout-api --source . --region europe-west2 \
     --service-account fuelscout-api@<project>.iam.gserviceaccount.com \
     --command node --args scripts/server.mjs --set-env-vars BUCKET=<project>-data \
     --allow-unauthenticated --memory 512Mi --max-instances 2
   ```
   It prints the service URL. Check it with
   `curl "<url>/v1/stations?lat=51.5&lon=-0.12&radiusMiles=3"`.

6. **Schedule the job.**
   ```bash
   gcloud run jobs add-iam-policy-binding fuelscout-updater --region europe-west2 --member=serviceAccount:fuelscout-updater@<project>.iam.gserviceaccount.com --role=roles/run.invoker
   gcloud scheduler jobs create http fuelscout-every-15-min --location europe-west2 --schedule="*/15 * * * *" --http-method=POST \
     --uri="https://run.googleapis.com/v2/projects/<project>/locations/europe-west2/jobs/fuelscout-updater:run" \
     --oauth-service-account-email=fuelscout-updater@<project>.iam.gserviceaccount.com
   ```

7. **Point the app at it.** Set `AppConfig.apiURL` to the service URL from step 5.

After changing the scripts, redeploy with the commands in steps 4 and 5.

## Good to know

- **Failures are safe.** If a job run fails (e.g. the Fuel Finder API is down), the API keeps serving the last snapshot.
  Logs: **Cloud Run → Jobs → fuelscout-updater** and **Cloud Run → Services → fuelscout-api**.
- **Force a full re-download** with
  `gcloud run jobs execute fuelscout-updater --region europe-west2 --update-env-vars FORCE_FULL=true`.
- **Incremental by design.** Each run reads the previous snapshot from the bucket and asks Fuel Finder only for changes.
  A full re-download happens weekly.
- **Rate limits.** Fuel Finder allows 100 requests a minute, one at a time; the job makes one request at a time.
- Prices sent in pounds (1.379) or tenths of a penny (1379) are converted to pence; values outside 50–400p are dropped.
