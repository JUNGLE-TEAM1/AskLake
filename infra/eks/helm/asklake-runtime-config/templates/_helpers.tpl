{{- define "asklake-runtime-config.labels" -}}
app.kubernetes.io/name: asklake
app.kubernetes.io/component: runtime-config
app.kubernetes.io/part-of: asklake
app.kubernetes.io/managed-by: {{ .Release.Service }}
asklake.io/environment: dev
{{- end -}}
