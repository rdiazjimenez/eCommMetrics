# Changelog

---

## 2026-05-25 — Phase 1 Implementation + Deployment

### What was built

Full end-to-end TikTok stats pipeline on Azure Functions Python v2:

- **Timer Trigger** — runs daily at 08:00 UTC, rotates TikTok OAuth tokens via Key Vault, fetches all videos via TikTok Content Creator API v2, upserts to `tiktoksnapshots` and `tiktoklatest`, runs deletion diff, writes `pipelinerunstatus`.
- **HTTP Trigger `/api/stats`** — serves stored stats as CSV or JSON; params: `platform`, `view`, `format`, `from`, `to`, `limit`, `accountId`.
- **HTTP Trigger `/api/health`** — anonymous, reads `pipelinerunstatus`, returns `unknown` on first run.
- Unit tests: `test_tiktok_client.py`, `test_table_storage_client.py`, `test_function_app.py`.
- Setup scripts: `setup/create_tables.py`, `setup/one_time_oauth.py`.

### Azure resources created

| Resource | Name |
|---|---|
| Resource Group | `mcpp-purchase` (existing) |
| Storage Account | `ecommmetricssa` (LRS, East US) |
| Key Vault | `ecommmetrics-kv` (RBAC mode) |
| Function App | `ecommmetrics-func` (Linux, Python 3.11, Consumption, East US) |
| Application Insights | `ecommmetrics-func` (auto-created with Function App) |
| Action Group | `ecommmetrics-alerts` (email: info@ilafiukids.com) |
| Monitor Alert | `ecommmetrics-pipeline-failure` (exceptions in App Insights, every 5 min) |

### OAuth authorization (one-time)

Ran `setup/one_time_oauth.py` → browser flow → tokens stored in Key Vault:
- `tiktok-refresh-token`
- `tiktok-access-token`
- `tiktok-open-id` = `<TIKTOK_OPEN_ID>`

### Bugs found and fixed during deployment

#### 1. TikTok PKCE non-standard encoding
- **Symptom:** OAuth authorization code exchange returned `access_token_invalid` or token exchange failed silently.
- **Root cause:** TikTok uses `HEX(SHA256(verifier))` not the RFC-standard `BASE64URL(SHA256(verifier))`. Documented in TikTok Login Kit Desktop docs as `CryptoJS.SHA256(code_verifier).toString(CryptoJS.enc.Hex)`.
- **Fix:** `code_challenge = hashlib.sha256(code_verifier.encode()).hexdigest()` in `setup/one_time_oauth.py`.

#### 2. TikTok `fields` must be a URL query parameter
- **Symptom:** `fetch_video_list` returned `fetch_complete=False`; health showed `status: error` with message "TikTok fetch incomplete".
- **Root cause:** TikTok `/v2/video/list/` requires `fields` as a URL query parameter, not in the JSON POST body. The implementation put `fields` in the JSON payload.
- **Fix in `tiktok_client.py`:**
  ```python
  # Before (broken):
  payload = {"max_count": 20, "fields": VIDEO_FIELDS}
  resp = _post_with_retry(TIKTOK_VIDEO_LIST_URL, json=payload)

  # After (fixed):
  payload = {"max_count": 20}
  resp = _post_with_retry(f"{TIKTOK_VIDEO_LIST_URL}?fields={VIDEO_FIELDS}", json=payload)
  ```

#### 3. `#` is a forbidden character in Azure Table Storage RowKey
- **Symptom:** `upsert_video_snapshot` raised `OutOfRangeInput` error from Table Storage.
- **Root cause:** Azure Table Storage forbids `/`, `\`, `#`, `?` in PartitionKey and RowKey. The composite RowKey `{open_id}#{video_id}` used `#` as separator.
- **Fix in `table_storage_client.py`:**
  ```python
  # Before (broken):
  "RowKey": f"{open_id}#{video_id}",

  # After (fixed):
  "RowKey": f"{open_id}_{video_id}",
  ```
- **Note:** PRD schema diagram still shows `open_id#video_id` — updated below.

#### 4. `az functionapp deployment source config-zip` skips Oryx build
- **Symptom:** Function App deployed but `/api/health` returned 404. Python packages not installed.
- **Root cause:** `config-zip` sets `WEBSITE_RUN_FROM_PACKAGE` to a blob URL, which mounts the zip as-is without running `pip install`. Python Function Apps need Oryx to install dependencies.
- **Fix:** Deploy via Kudu `/api/zipdeploy` endpoint instead. Oryx runs automatically and installs `requirements.txt`.

#### 5. `az functionapp config appsettings delete` wiped all settings
- **Symptom:** After deleting `WEBSITE_RUN_FROM_PACKAGE`, all other App Settings disappeared.
- **Root cause:** az CLI bug / unexpected behavior — `delete --setting-names X` deleted all settings.
- **Fix:** Restored all settings via ARM REST API PUT to `/config/appsettings`.

### Deployment process (what actually works)

```powershell
# Build zip (root-level Python files only)
Compress-Archive -Path @("config.py","exceptions.py","keyvault_client.py","tiktok_client.py",
  "table_storage_client.py","platform_registry.py","function_app.py","host.json","requirements.txt") `
  -DestinationPath "deploy.zip" -Force

# Get Kudu credentials
$creds = az webapp deployment list-publishing-credentials `
  --resource-group mcpp-purchase --name ecommmetrics-func `
  --query "{user:publishingUserName,pass:publishingPassword}" -o json | ConvertFrom-Json
$base64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($creds.user):$($creds.pass)"))

# Deploy (triggers Oryx pip install)
$wc = New-Object System.Net.WebClient
$wc.Headers.Add("Authorization", "Basic $base64")
$wc.Headers.Add("Content-Type", "application/zip")
$wc.UploadData("https://ecommmetrics-func.scm.azurewebsites.net/api/zipdeploy?isAsync=true", "POST",
  [System.IO.File]::ReadAllBytes("deploy.zip")) | Out-Null
# Wait ~90s for Oryx build
```

### First successful run

- Timestamp: `2026-05-26T01:35:49Z`
- Videos fetched: 1
- Video: "Nuestro corazón está contigo" (`7642856386220641537`)

### Excel Power Query connected

Live URL (latest, CSV):
```
https://ecommmetrics-func.azurewebsites.net/api/stats?code=<AZURE_FUNCTION_KEY>&platform=tiktok&view=latest&format=csv
```
