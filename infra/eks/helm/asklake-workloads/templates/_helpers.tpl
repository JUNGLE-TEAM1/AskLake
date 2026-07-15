{{- define "asklake-workloads.commonLabels" -}}
app.kubernetes.io/part-of: asklake
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "asklake-workloads.selectorLabels" -}}
app.kubernetes.io/name: asklake-workloads
app.kubernetes.io/instance: {{ .release | quote }}
app.kubernetes.io/component: {{ .component | quote }}
{{- end -}}
