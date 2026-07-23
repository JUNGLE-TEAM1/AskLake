{{- define "asklake-auto-mode.labels" -}}
app.kubernetes.io/name: asklake-auto-mode
app.kubernetes.io/managed-by: {{ .Release.Service }}
asklake.io/contract-phase: "12"
{{- end -}}

{{- define "asklake-auto-mode.requirePool" -}}
{{- $name := .name -}}
{{- $pool := .pool -}}
{{- if eq (len $pool.capacityTypes) 0 }}{{ fail (printf "%s.capacityTypes must be selected" $name) }}{{ end -}}
{{- if eq (len $pool.instanceCategories) 0 }}{{ fail (printf "%s.instanceCategories must be selected" $name) }}{{ end -}}
{{- if not $pool.instanceGenerationMin }}{{ fail (printf "%s.instanceGenerationMin must be selected" $name) }}{{ end -}}
{{- if not $pool.limits.cpu }}{{ fail (printf "%s.limits.cpu must be selected" $name) }}{{ end -}}
{{- if not $pool.limits.memory }}{{ fail (printf "%s.limits.memory must be selected" $name) }}{{ end -}}
{{- if not $pool.disruption.consolidationPolicy }}{{ fail (printf "%s.disruption.consolidationPolicy must be selected" $name) }}{{ end -}}
{{- if not $pool.disruption.consolidateAfter }}{{ fail (printf "%s.disruption.consolidateAfter must be selected" $name) }}{{ end -}}
{{- if not $pool.disruption.budget }}{{ fail (printf "%s.disruption.budget must be selected" $name) }}{{ end -}}
{{- if not $pool.expireAfter }}{{ fail (printf "%s.expireAfter must be selected" $name) }}{{ end -}}
{{- if not $pool.terminationGracePeriod }}{{ fail (printf "%s.terminationGracePeriod must be selected" $name) }}{{ end -}}
{{- end -}}
