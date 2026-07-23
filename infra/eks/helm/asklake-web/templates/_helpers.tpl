{{- define "asklake-web.labels" -}}
app.kubernetes.io/name: asklake
app.kubernetes.io/part-of: asklake
app.kubernetes.io/managed-by: {{ .Release.Service }}
asklake.io/environment: {{ .Values.environment | quote }}
{{- end -}}
