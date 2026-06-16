import os

KEY_VAULT_URL = os.environ.get("AZURE_KEY_VAULT_URL", "")
STORAGE_CONNECTION_STRING = os.environ.get("AZURE_STORAGE_CONNECTION_STRING", "")
TIKTOK_CLIENT_KEY = os.environ.get("TIKTOK_CLIENT_KEY", "")
TIKTOK_CLIENT_SECRET = os.environ.get("TIKTOK_CLIENT_SECRET", "")
CONFIGURED_PLATFORMS = [
    p.strip() for p in os.environ.get("CONFIGURED_PLATFORMS", "tiktok").split(",") if p.strip()
]
