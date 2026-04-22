apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-{{ ENV }}
  labels:
    app: postgres
    env: "{{ ENV }}"
spec:
  serviceName: postgres-{{ ENV }}
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
