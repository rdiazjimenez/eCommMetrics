from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
import config

_client: SecretClient | None = None


def _get_client() -> SecretClient:
    global _client
    if _client is None:
        _client = SecretClient(
            vault_url=config.KEY_VAULT_URL,
            credential=DefaultAzureCredential(),
        )
    return _client


def read_token(name: str) -> str:
    return _get_client().get_secret(name).value


def write_token(name: str, value: str) -> None:
    _get_client().set_secret(name, value)
