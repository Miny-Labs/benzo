# Runbook - API Database Restore

Use this runbook to restore an encrypted dump produced by
`infra/scripts/db-backup.sh` into a fresh PostgreSQL database.

## Prerequisites

- The encrypted backup file, for example
  `benzo-api-20260707T031700Z.dump.age`.
- The matching `age` identity file kept outside the VM.
- A fresh target database URL.
- The escrowed `APP_MASTER_KEY` from [key-escrow.md](key-escrow.md).

## Restore

```sh
export RESTORE_DATABASE_URL='postgres://benzo:...@127.0.0.1:5432/benzo_restore'
export AGE_IDENTITY_FILE='/secure/offline/backup-age-key.txt'
export BACKUP_FILE='/secure/restore/benzo-api-20260707T031700Z.dump.age'

age -d -i "$AGE_IDENTITY_FILE" "$BACKUP_FILE" \
  | pg_restore --dbname="$RESTORE_DATABASE_URL" --clean --if-exists --no-owner --no-acl
```

If the target database is brand new, create it before running `pg_restore`.

## Bring API Back

1. Set the restored environment's `APP_MASTER_KEY` from the offline escrow copy.
2. Start the API and workers against `RESTORE_DATABASE_URL`.
3. Confirm the drill checks:
   - a managed org treasury key unseals;
   - an auditor request decrypts a transfer that existed before the backup.
4. Keep the encrypted backup and restore logs until the incident review is
   complete. Do not keep decrypted dump files.
