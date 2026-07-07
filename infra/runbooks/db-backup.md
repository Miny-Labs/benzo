# Runbook - Nightly API Database Backup

`infra/scripts/db-backup.sh` creates an encrypted PostgreSQL custom-format dump
of the API database and uploads it off the VM. The dump is encrypted with `age`
before it touches the upload command.

## Install

Install `pg_dump` from the PostgreSQL client package and install `age` as a
single static binary from <https://age-encryption.org/>.

The upload tool is operator-selected. Examples include `rclone`, `gsutil`, or
`rsync`; the script only requires `BACKUP_UPLOAD_CMD`.

## Environment

```sh
export BACKUP_DATABASE_URL='postgres://benzo:...@127.0.0.1:5432/benzo'
export BACKUP_AGE_RECIPIENT='age1...'
export BACKUP_DIR='/var/backups/benzo-api'
export BACKUP_KEEP='14'
export BACKUP_UPLOAD_CMD='rclone copy "$BACKUP_FILE" remote:benzo-api-db/'
```

`BACKUP_DATABASE_URL` defaults to `DATABASE_URL` if unset. `BACKUP_UPLOAD_CMD`
is required unless `BACKUP_SKIP_UPLOAD=1` is set for local dry-runs.

## Cron Example

```cron
17 3 * * * /usr/bin/env bash -lc 'source /etc/benzo/backup.env && /opt/benzo/infra/scripts/db-backup.sh >> /var/log/benzo-db-backup.log 2>&1'
```

## systemd Timer Example

`/etc/systemd/system/benzo-db-backup.service`:

```ini
[Unit]
Description=Benzo API encrypted database backup

[Service]
Type=oneshot
EnvironmentFile=/etc/benzo/backup.env
WorkingDirectory=/opt/benzo
ExecStart=/opt/benzo/infra/scripts/db-backup.sh
```

`/etc/systemd/system/benzo-db-backup.timer`:

```ini
[Unit]
Description=Run Benzo API encrypted database backup nightly

[Timer]
OnCalendar=*-*-* 03:17:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with:

```sh
systemctl daemon-reload
systemctl enable --now benzo-db-backup.timer
```

## Retention

The script keeps the newest `BACKUP_KEEP` encrypted files in `BACKUP_DIR` and
prunes older local files after upload. Off-VM retention must be configured in
the remote backup target as well.
