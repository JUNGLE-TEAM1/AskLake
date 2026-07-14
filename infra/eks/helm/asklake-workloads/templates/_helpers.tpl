{{- define "asklake-workloads.commonLabels" -}}
app.kubernetes.io/part-of: asklake
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "asklake-workloads.selectorLabels" -}}
app.kubernetes.io/name: asklake
app.kubernetes.io/component: {{ .component | quote }}
{{- end -}}
