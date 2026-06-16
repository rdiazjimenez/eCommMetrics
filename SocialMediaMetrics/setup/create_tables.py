"""
Standalone script — not deployed to Azure.
Run once to create required Table Storage tables.

Usage:
    AZURE_STORAGE_CONNECTION_STRING="..." python setup/create_tables.py
"""

import os

from azure.data.tables import TableServiceClient

TABLES = ["tiktoksnapshots", "tiktoklatest", "pipelinerunstatus"]


def main() -> None:
    conn_str = os.environ["AZURE_STORAGE_CONNECTION_STRING"]
    service = TableServiceClient.from_connection_string(conn_str)

    for name in TABLES:
        try:
            service.create_table(name)
            print(f"Created: {name}")
        except Exception as exc:
            if "TableAlreadyExists" in type(exc).__name__ or "Conflict" in str(exc):
                print(f"Already exists: {name}")
            else:
                raise


if __name__ == "__main__":
    main()
