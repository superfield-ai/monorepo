# Substrate Reliability — issue #385
#
# Recovery objectives:
#   RPO (Recovery Point Objective):  ≤ 5 minutes   — WAL archiving interval
#   RTO (Recovery Time Objective):   ≤ 15 minutes   — base backup + WAL replay
#   Standby replication lag:          ≤ 30 seconds  — streaming replication
#
# Production deployment MUST:
#   1. Replace storageClassName: local-path with a cloud-provider block-storage
#      class (e.g. pd-ssd on GKE) that survives node failure.
#   2. Enable WAL archiving:
#        postgresql.conf:  archive_mode = on
#                          archive_command = 'gsutil cp %p gs://sf-wal-archive/{{ ENV }}/%f'
#        Secrets:          GOOGLE_APPLICATION_CREDENTIALS injected as a k8s secret
#   3. Run a daily pg_basebackup job to gs://sf-backups/{{ ENV }}/
#   4. Deploy a hot standby replica (replicas: 2) with:
#        primary_conninfo set to replication user credentials
#        hot_standby = on
#      Alternatively use CloudSQL HA or equivalent managed Postgres.
#
# See docs/architecture.md §Substrate Reliability for the authoritative runbook.
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-{{ ENV }}
  labels:
    app: postgres
    env: "{{ ENV }}"
spec:
  serviceName: postgres-{{ ENV }}
  # SEAM: set replicas: 2 and configure streaming replication for production.
  # See §Substrate Reliability in docs/architecture.md.
  replicas: 1
  selector:
    matchLabels:
      app: postgres
      env: "{{ ENV }}"
  template:
    metadata:
      labels:
        app: postgres
        env: "{{ ENV }}"
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          ports:
            - name: postgres
              containerPort: 5432
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-{{ ENV }}
                  key: password
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
            # SEAM: inject POSTGRES_REPLICATION_USER / POSTGRES_REPLICATION_PASSWORD
            # from a k8s secret to enable streaming replication. Remove this comment
            # once the standby StatefulSet and replication secret are provisioned.
          volumeMounts:
            - name: postgres-data-{{ ENV }}
              mountPath: /var/lib/postgresql/data
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 1Gi
          livenessProbe:
            exec:
              command:
                - pg_isready
                - -U
                - postgres
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 6
          readinessProbe:
            exec:
              command:
                - pg_isready
                - -U
                - postgres
            initialDelaySeconds: 5
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 6
  volumeClaimTemplates:
    - metadata:
        name: postgres-data-{{ ENV }}
        labels:
          app: postgres
          env: "{{ ENV }}"
      spec:
        accessModes:
          - ReadWriteOnce
        # SEAM: replace local-path with a durable cloud block-storage class
        # (e.g. standard-rwo on GKE, gp3-csi on EKS) before enabling replication.
        # local-path storage does not survive node failure and cannot satisfy RPO ≤ 5 min.
        storageClassName: local-path
        resources:
          requests:
            storage: 20Gi
---
apiVersion: v1
kind: Service
metadata:
  name: postgres-{{ ENV }}
  labels:
    app: postgres
    env: "{{ ENV }}"
spec:
  type: ClusterIP
  selector:
    app: postgres
    env: "{{ ENV }}"
  ports:
    - name: postgres
      port: 5432
      targetPort: 5432
      protocol: TCP
