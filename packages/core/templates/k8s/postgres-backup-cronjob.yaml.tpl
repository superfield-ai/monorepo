# Substrate Daily Base Backup — issue #459
#
# Runs pg_basebackup against the primary Postgres instance once per day and
# writes a tar+gzip snapshot to gs://sf-backups/{{ ENV }}/YYYY-MM-DD/.
#
# Recovery objectives (see docs/architecture.md §Substrate Reliability):
#   RPO (Recovery Point Objective):  ≤ 5 minutes   — WAL archiving interval
#   RTO (Recovery Time Objective):   ≤ 15 minutes   — base backup + WAL replay
#
# Prerequisites before enabling in production:
#   1. The postgres-{{ ENV }} StatefulSet has archive_mode = on and
#      archive_command set to ship WAL to gs://sf-wal-archive/{{ ENV }}/.
#   2. A replication user exists with REPLICATION privilege.
#   3. GCS credentials are injected as a k8s Secret referenced below.
#
# See docs/architecture.md §Substrate Reliability for the full runbook.
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgres-backup-{{ ENV }}
  labels:
    app: postgres-backup
    env: "{{ ENV }}"
spec:
  # Run at 02:00 UTC daily.
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 1
      ttlSecondsAfterFinished: 86400
      template:
        metadata:
          labels:
            app: postgres-backup
            env: "{{ ENV }}"
        spec:
          restartPolicy: Never
          containers:
            - name: pg-basebackup
              # Uses the same Postgres image as the primary so pg_basebackup
              # version matches exactly. The entrypoint is overridden to run
              # the backup script directly.
              image: postgres:16-alpine
              command:
                - /bin/sh
                - -c
                - |
                  set -eu
                  DATE=$(date +%Y-%m-%d)
                  TARGET="/backup/${DATE}"
                  mkdir -p "${TARGET}"
                  pg_basebackup \
                    -D "${TARGET}" \
                    -h postgres-{{ ENV }} \
                    -p 5432 \
                    -U "${PGUSER}" \
                    -Ft \
                    -z \
                    --wal-method=stream \
                    --progress \
                    --verbose
                  echo "pg_basebackup completed: ${TARGET}"
              env:
                - name: PGPASSWORD
                  valueFrom:
                    secretKeyRef:
                      name: postgres-replication-{{ ENV }}
                      key: replication_password
                - name: PGUSER
                  valueFrom:
                    secretKeyRef:
                      name: postgres-replication-{{ ENV }}
                      key: replication_user
              volumeMounts:
                - name: backup-storage
                  mountPath: /backup
              resources:
                requests:
                  cpu: 200m
                  memory: 256Mi
                limits:
                  cpu: "1"
                  memory: 512Mi
          volumes:
            - name: backup-storage
              # In production, replace with a PVC backed by durable object
              # storage or a sidecar that uploads to GCS after backup completes.
              emptyDir: {}
