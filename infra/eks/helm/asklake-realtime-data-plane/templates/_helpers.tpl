{{- define "asklake-realtime.labels" -}}
app.kubernetes.io/name: asklake-realtime-data-plane
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
app.kubernetes.io/part-of: asklake
asklake.io/realtime-mode: {{ .Values.mode | quote }}
{{- end -}}

{{- define "asklake-realtime.selectorLabels" -}}
app.kubernetes.io/name: asklake-realtime-data-plane
app.kubernetes.io/instance: {{ .release | quote }}
app.kubernetes.io/component: {{ .component | quote }}
{{- end -}}

{{- define "asklake-realtime.image" -}}
{{ printf "%s@%s" (required "image repository is required" .repository) (required "image digest is required" .digest) }}
{{- end -}}
