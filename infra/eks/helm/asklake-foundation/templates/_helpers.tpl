{{- define "asklake-foundation.labels" -}}
app.kubernetes.io/name: asklake
app.kubernetes.io/part-of: asklake
app.kubernetes.io/managed-by: {{ .Release.Service }}
asklake.io/environment: {{ .Values.global.environment | quote }}
{{- end -}}
