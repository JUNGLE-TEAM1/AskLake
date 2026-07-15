{{- define "asklake-ingress.labels" -}}
app.kubernetes.io/name: asklake
app.kubernetes.io/part-of: asklake
app.kubernetes.io/managed-by: {{ .Release.Service }}
asklake.io/environment: {{ trimPrefix "asklake-" .Values.namespace | quote }}
{{- end -}}

{{- define "asklake-ingress.annotations" -}}
alb.ingress.kubernetes.io/target-type: {{ .Values.targetType | quote }}
alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
alb.ingress.kubernetes.io/ssl-redirect: "443"
{{- end -}}
