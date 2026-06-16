# ECommMetrics Stats Pipeline

Azure Functions pipeline that fetches daily TikTok video stats and serves them to Excel via Power Query.

**Phase 1:** TikTok only. Architecture supports adding Instagram, YouTube, Meta Ads, Pinterest without restructuring.

---

## Repo Layout

```
ECommMetrics/
├── function_app.py          # Azure Functions entry point (Timer + HTTP triggers)
├── config.py                # Reads env vars at import time
├── exceptions.py            # MultiPlatformRunError
├── keyvault_client.py       # Key Vault read/write (cached SecretClient)
├── tiktok_client.py         # TikTok OAuth token refresh + paginated video fetch
├── table_storage_client.py  # Table Storage upsert, deletion diff, query methods
├── platform_registry.py     # Maps platform name → fetch adapter (TikTokAdapter)
│
├── host.json                # Azure Functions runtime config
├── requirements.txt         # Python dependencies
├── .funcignore              # Files excluded from deployment zip
├── local.settings.json.example  # Template — copy to local.settings.json for local dev
│
├── setup/                   # One-time scripts (not deployed to Azure)
│   ├── create_tables.py     # Creates Table Storage tables (idempotent)
│   └── one_time_oauth.py    # Browser OAuth flow → stores tokens in Key Vault
│
├── tests/                   # Unit tests (pytest)
│   ├── test_tiktok_client.py
│   ├── test_table_storage_client.py
│   └── test_function_app.py
│
└── docs/
    ├── prd-tiktok-stats-pipeline.md  # Full PRD
    ├── CHANGELOG.md                  # Session log
    └── adr/                          # Architecture Decision Records
        ├── 0001-per-platform-tables-shared-run-status.md
        ├── 0002-single-stats-endpoint-with-platform-param.md
        ├── 0003-tiktoklatest-deletion-on-full-fetch.md
        └── 0004-multi-platform-timer-failure-isolation.md
```

> **Note:** Python source files must remain at the repo root. Azure Functions v2 resolves `function_app.py` and all its imports from the root directory.

---

## Azure Resources

| Resource | Name | Purpose |
|---|---|---|
| Resource Group | `mcpp-purchase` | Container for all resources |
| Function App | `ecommmetrics-func` | Linux, Python 3.11, Consumption plan, East US |
| Storage Account | `ecommmetricssa` | Table Storage (stats) + Azure Files (Functions host) |
| Key Vault | `ecommmetrics-kv` | TikTok OAuth tokens |
| Application Insights | `ecommmetrics-func` | Logs and failure alerts |
| Action Group | `ecommmetrics-alerts` | Email on pipeline failure |

---

## Live Endpoints

| Endpoint | Auth | URL |
|---|---|---|
| Health | Anonymous | `https://ecommmetrics-func.azurewebsites.net/api/health` |
| Stats | Function Key | `https://ecommmetrics-func.azurewebsites.net/api/stats?code=<KEY>` |

**Excel Power Query (latest, CSV):**
```
https://ecommmetrics-func.azurewebsites.net/api/stats?code=<FUNCTION_KEY>&platform=tiktok&view=latest&format=csv
```

**Historical:**
```
https://ecommmetrics-func.azurewebsites.net/api/stats?code=<FUNCTION_KEY>&platform=tiktok&view=history&from=2026-01-01&format=csv
```

---

## First-Time Setup

### Prerequisites

- Azure CLI (`az`) logged in: `az login`
- Python 3.11+
- pip

### 1. Install dependencies

```bash
pip install -r requirements.txt
# Also install setup script deps:
pip install azure-identity azure-keyvault-secrets requests azure-data-tables
```

### 2. Create Azure resources

```bash
# Resource group
az group create --name mcpp-purchase --location eastus

# Storage account
az storage account create --name ecommmetricssa --resource-group mcpp-purchase --sku Standard_LRS

# Key Vault (RBAC mode)
az keyvault create --name ecommmetrics-kv --resource-group mcpp-purchase --enable-rbac-authorization true

# Assign yourself Key Vault Secrets Officer
az role assignment create \
  --role "Key Vault Secrets Officer" \
  --assignee $(az account show --query user.name -o tsv) \
  --scope $(az keyvault show --name ecommmetrics-kv --query id -o tsv)

# Function App (Python 3.11, Linux, Consumption)
az functionapp create \
  --resource-group mcpp-purchase \
  --name ecommmetrics-func \
  --storage-account ecommmetricssa \
  --consumption-plan-location eastus \
  --runtime python \
  --runtime-version 3.11 \
  --functions-version 4 \
  --os-type Linux
```

### 3. Configure App Settings

```bash
STORAGE_CONN="<connection string from Storage Account → Access keys>"

az functionapp config appsettings set \
  --resource-group mcpp-purchase \
  --name ecommmetrics-func \
  --settings \
    "AZURE_KEY_VAULT_URL=https://ecommmetrics-kv.vault.azure.net/" \
    "AZURE_STORAGE_CONNECTION_STRING=$STORAGE_CONN" \
    "TIKTOK_CLIENT_KEY=<your TikTok app client key>" \
    "TIKTOK_CLIENT_SECRET=<your TikTok app client secret>" \
    "CONFIGURED_PLATFORMS=tiktok" \
    "TIMER_SCHEDULE=0 0 8 * * *"
```

### 4. Enable Managed Identity → Key Vault access

```bash
# Enable system-assigned identity
az functionapp identity assign --resource-group mcpp-purchase --name ecommmetrics-func

# Get the principal ID
PRINCIPAL=$(az functionapp identity show --resource-group mcpp-purchase --name ecommmetrics-func --query principalId -o tsv)

# Grant it Key Vault access
az role assignment create \
  --role "Key Vault Secrets Officer" \
  --assignee $PRINCIPAL \
  --scope $(az keyvault show --name ecommmetrics-kv --query id -o tsv)
```

### 5. Create Table Storage tables

```bash
# Set env vars for the script
export AZURE_STORAGE_CONNECTION_STRING="<connection string>"
python setup/create_tables.py
```

### 6. TikTok OAuth (one-time)

Add `http://localhost:8080/callback` as a redirect URI in your TikTok Developer Portal app (Desktop app type).

```bash
export AZURE_KEY_VAULT_URL="https://ecommmetrics-kv.vault.azure.net/"
export TIKTOK_CLIENT_KEY="<client key>"
export TIKTOK_CLIENT_SECRET="<client secret>"
python setup/one_time_oauth.py
```

Browser opens → authorize → tokens stored in Key Vault automatically.

**TikTok PKCE note:** TikTok uses `HEX(SHA256(verifier))` not the standard `BASE64URL(SHA256(verifier))`. The script handles this correctly.

### 7. Deploy

```bash
# Build zip (from repo root)
zip -r deploy.zip config.py exceptions.py keyvault_client.py tiktok_client.py \
  table_storage_client.py platform_registry.py function_app.py host.json requirements.txt

# Deploy via Kudu (Oryx runs pip install automatically)
curl -X POST \
  -u "<kudu-user>:<kudu-pass>" \
  -H "Content-Type: application/zip" \
  --data-binary @deploy.zip \
  "https://ecommmetrics-func.scm.azurewebsites.net/api/zipdeploy"
```

Or use the `az functionapp deployment source config-zip` command (sets `WEBSITE_RUN_FROM_PACKAGE` — packages **not** installed automatically, avoid for Python).

### 8. Set up failure alerts (optional)

```bash
# Action group
az monitor action-group create \
  --resource-group mcpp-purchase \
  --name ecommmetrics-alerts \
  --short-name eccmalerts \
  --action email email-notify your@email.com

# Alert rule
AG_ID=$(az monitor action-group show --resource-group mcpp-purchase --name ecommmetrics-alerts --query id -o tsv)
AI_ID=$(az monitor app-insights component show --app ecommmetrics-func --resource-group mcpp-purchase --query id -o tsv)

az monitor scheduled-query create \
  --resource-group mcpp-purchase \
  --name "ecommmetrics-pipeline-failure" \
  --scopes $AI_ID \
  --condition "count 'exceptions' > 0" \
  --condition-query "exceptions | where cloud_RoleName == 'ecommmetrics-func'" \
  --evaluation-frequency 5m \
  --window-size 10m \
  --severity 2 \
  --action $AG_ID \
  --auto-mitigate false
```

### 9. Test

Trigger manually via admin endpoint:

```bash
MASTER_KEY=$(az functionapp keys list --resource-group mcpp-purchase --name ecommmetrics-func --query masterKey -o tsv)

curl -X POST \
  -H "Content-Type: application/json" \
  -H "x-functions-key: $MASTER_KEY" \
  -d '{"input":""}' \
  "https://ecommmetrics-func.azurewebsites.net/admin/functions/timer_trigger"

# Wait ~30s, then check:
curl "https://ecommmetrics-func.azurewebsites.net/api/health"
```

---

## Local Development

Copy `local.settings.json.example` to `local.settings.json` and fill in values.

```bash
pip install -r requirements.txt
pytest tests/ -v
```

Azure Functions local host requires [Azure Functions Core Tools](https://learn.microsoft.com/en-us/azure/azure-functions/functions-run-local).

---

## Re-authorization

The TikTok refresh token lasts ~1 year. If the pipeline fails with a token error:

1. Revoke and re-add the app in TikTok iOS → Settings → Security → Connected Apps (clears cached auth)
2. Re-run `python setup/one_time_oauth.py`

No other manual steps needed.

---

## Adding a Platform (Phase 2+)

1. Add Key Vault secrets: `{platform}-refresh-token`, `{platform}-access-token`, `{platform}-open-id`
2. Add `{platform}snapshots` and `{platform}latest` tables (extend `setup/create_tables.py`)
3. Add a fetch adapter to `platform_registry.py` and register it in `REGISTRY`
4. Add platform name to `CONFIGURED_PLATFORMS` App Setting
