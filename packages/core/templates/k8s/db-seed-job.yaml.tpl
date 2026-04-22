apiVersion: batch/v1
kind: Job
metadata:
  name: db-seed-{{ ENV }}-{{ NAME_TAG }}
  labels:
    app.kubernetes.io/name: db-seed
    app.kubernetes.io/component: seed
    app.kubernetes.io/instance: "{{ ENV }}"
    app.kubernetes.io/version: "{{ TAG }}"
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: db-seed
        app.kubernetes.io/component: seed
        app.kubernetes.io/instance: "{{ ENV }}"
        app.kubernetes.io/version: "{{ TAG }}"
    spec:
      restartPolicy: Never
      containers:
        - name: seed
          image: "{{ IMAGE_REPO }}:{{ TAG }}"
          command: ["/app", "seed"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: app-{{ ENV }}
                  key: database_url
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
