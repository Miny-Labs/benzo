# Runbook - APP_MASTER_KEY Escrow

`APP_MASTER_KEY` is the 32-byte hex key used by `services/api/src/crypto/seal.ts`
to seal org treasury keys and auditor keys. It is not derived from a password or
mnemonic. Generate it with a CSPRNG once per environment:

```sh
openssl rand -hex 32
```

## Escrow Procedure

1. Write the exact 64-character hex value to at least two offline media items.
   Acceptable media: paper stored in a safe, a hardware password vault export
   held offline, or another offline hardware medium.
2. Store those media in at least two separate physical locations outside the VM.
3. Record the environment name, creation date, and checksum of the written value
   on the escrow envelope. Do not record the key in this repo, a server `.env`,
   a second VM, a shared chat, or cloud storage reachable by the app.
4. Verify the escrow copy by reading it back on an offline machine and checking:

   ```sh
   printf '%s' "$APP_MASTER_KEY" | wc -c
   # must print 64
   ```

5. Seal the physical envelope and update the custody log with location and
   holder names only, not the key value.

Optional stretch: split the key with Shamir secret sharing if the operator wants
multi-person recovery. That is additional process, not a substitute for the two
offline-location requirement.

## Restore Procedure

1. Start from a fresh VM or fresh API process with the restored Postgres
   database available.
2. Retrieve one escrow copy and set the exact 64-character value as
   `APP_MASTER_KEY` in the deployment secret manager for the API service.
3. Start the API and payroll worker with that value. Do not reseal or rotate as
   part of the emergency restore.
4. Run the restore drill or a targeted check that:
   - an `org_treasuries.sealed_eoa_key` unseals to the expected EOA key;
   - an `auditor_keys.sealed_key` unseals and decrypts a known pre-backup event.
5. Return the escrow copy to offline storage and record the access in the custody
   log.
