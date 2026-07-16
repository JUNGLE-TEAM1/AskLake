import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyIcon, EmptyTitle } from "@/components/ui/empty";
import { FieldLabel, Field as ShadcnField } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  Check,
  CircleUser,
  Info,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal
} from "lucide-react";
import { useEffect, useState } from "react";
import { CreationFlowLayout, CreationTopActions } from "../../components/creation/CreationFlow";
import { EtlStepHeader } from "../../components/etl/EtlStepHeader";
import { fetchPermissionOptions } from "../../services/permissionApi";
import type { DraftPipeline, DraftPipelinePatch, PermissionAction, PermissionGrant, PermissionOptionsResponse } from "../../types";

import {
  buildPermissionDraftPatch,
  DEFAULT_OWNER,
  getPermissionDraftValues,
  inferPermissionPreset,
  normalizePermissionActions,
  PERMISSION_ACTION_LABELS,
  PERMISSION_ACTION_ORDER,
  PERMISSION_PRESETS,
  permissionGrantKey,
  PermissionGrantTab,
  permissionPresetActions,
  PermissionPresetId
} from "./targetModel";

export function PermissionPage({
  draft,
  onDraftChange,
  onNext,
  onPrev,
}: {
  draft: DraftPipeline;
  onDraftChange: (patch: DraftPipelinePatch) => void;
  onNext: () => void;
  onPrev: () => void;
  onSave: () => void;
}) {
  const initialPermission = getPermissionDraftValues(draft);
  const initialSelectedGrants = (draft.permission.grants ?? [])
    .filter((grant) => grant.principalType !== "public")
    .map((grant) => ({ ...grant, actions: normalizePermissionActions(grant.actions) }));
  const [permissionPreset, setPermissionPreset] = useState<PermissionPresetId>(() => inferPermissionPreset(initialSelectedGrants));
  const [selectedGrants, setSelectedGrants] = useState<PermissionGrant[]>(initialSelectedGrants);
  const [publicView, setPublicView] = useState(() => (
    draft.permission.grants?.some((grant) => grant.principalType === "public" && grant.actions.includes("view"))
    ?? initialPermission.visibility === "외부 공유"
  ));
  const [dataOwner, setDataOwner] = useState(initialPermission.owner);
  const [grantTab, setGrantTab] = useState<PermissionGrantTab>("groups");
  const [grantSearch, setGrantSearch] = useState("");
  const [permissionOptions, setPermissionOptions] = useState<PermissionOptionsResponse | null>(null);
  const [permissionOptionsError, setPermissionOptionsError] = useState("");
  const [permissionOptionsLoading, setPermissionOptionsLoading] = useState(true);
  const [permissionOptionsRequest, setPermissionOptionsRequest] = useState(0);
  const [permissionActionError, setPermissionActionError] = useState("");

  useEffect(() => {
    let active = true;
    setPermissionOptionsLoading(true);
    setPermissionOptionsError("");

    void fetchPermissionOptions(draft.id || undefined)
      .then((options) => {
        if (!active) return;
        const hasSavedGrants = draft.permission.grants !== undefined;
        const savedRoles = new Map((draft.permission.roles ?? []).map((role) => [role.name, role.checked]));
        const nextGrants = hasSavedGrants
          ? (draft.permission.grants ?? [])
            .filter((grant) => grant.principalType !== "public")
            .map((grant) => ({ ...grant, actions: normalizePermissionActions(grant.actions) }))
          : options.groups
            .filter((group, index) => savedRoles.get(group.name) ?? index === 0)
            .map((group) => ({
              actions: normalizePermissionActions(group.actions),
              principalId: group.id,
              principalType: "group" as const,
              source: "permission_ui",
            }));
        const nextPublicView = hasSavedGrants
          ? Boolean(draft.permission.grants?.some((grant) => grant.principalType === "public" && grant.actions.includes("view")))
          : initialPermission.visibility === "외부 공유";
        const firstAvailableOwner = options.users[0]?.name;
        const nextOwner = !draft.id && initialPermission.owner === DEFAULT_OWNER && firstAvailableOwner
          ? firstAvailableOwner
          : initialPermission.owner;
        const nextPreset = inferPermissionPreset(nextGrants);

        setPermissionOptions(options);
        setPermissionActionError("");
        setSelectedGrants(nextGrants);
        setPublicView(nextPublicView);
        setDataOwner(nextOwner);
        setPermissionPreset(nextPreset);
        onDraftChange(buildPermissionDraftPatch({
          grants: nextGrants,
          options,
          owner: nextOwner,
          preset: nextPreset,
          publicView: nextPublicView,
        }));
      })
      .catch((error) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "권한 대상 목록을 불러오지 못했습니다.";
        setPermissionOptionsError(message);
        setPermissionActionError(message);
      })
      .finally(() => {
        if (active) setPermissionOptionsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [draft.id, permissionOptionsRequest]);

  const applyPermissionState = ({
    grants = selectedGrants,
    owner = dataOwner,
    preset = permissionPreset,
    publicAccess = publicView,
  }: {
    grants?: PermissionGrant[];
    owner?: string;
    preset?: PermissionPresetId;
    publicAccess?: boolean;
  } = {}) => {
    if (!permissionOptions) return;
    const normalizedGrants = grants.map((grant) => ({ ...grant, actions: normalizePermissionActions(grant.actions) }));
    setSelectedGrants(normalizedGrants);
    setDataOwner(owner);
    setPermissionPreset(preset);
    setPublicView(publicAccess);
    onDraftChange(buildPermissionDraftPatch({
      grants: normalizedGrants,
      options: permissionOptions,
      owner,
      preset,
      publicView: publicAccess,
    }));
  };
  const goNext = () => {
    if (permissionOptionsLoading) {
      setPermissionActionError("권한 대상 목록을 불러오는 중입니다. 잠시 후 다시 시도해 주세요.");
      return;
    }
    if (permissionOptionsError || !permissionOptions || (permissionOptions.groups.length === 0 && permissionOptions.users.length === 0)) {
      setPermissionActionError(permissionOptionsError || "사용 가능한 권한 대상이 없어 다음 단계로 이동할 수 없습니다.");
      return;
    }
    setPermissionActionError("");
    applyPermissionState();
    onNext();
  };
  const applyPreset = (preset: PermissionPresetId) => {
    if (preset === "custom") {
      applyPermissionState({ preset });
      return;
    }
    const actions = permissionPresetActions(preset);
    applyPermissionState({
      grants: selectedGrants.map((grant) => ({ ...grant, actions })),
      preset,
    });
  };
  const togglePermissionTarget = ({
    actions,
    principalId,
    principalType,
  }: {
    actions: PermissionAction[];
    principalId: string;
    principalType: "group" | "user";
  }) => {
    const targetKey = `${principalType}:${principalId}`;
    const selected = selectedGrants.some((grant) => permissionGrantKey(grant) === targetKey);
    const nextGrants = selected
      ? selectedGrants.filter((grant) => permissionGrantKey(grant) !== targetKey)
      : [...selectedGrants, {
        actions: permissionPreset === "custom" ? normalizePermissionActions(actions) : permissionPresetActions(permissionPreset),
        principalId,
        principalType,
        source: "permission_ui",
      }];
    const nextPreset = permissionPreset === "custom" || nextGrants.length === 0
      ? permissionPreset
      : inferPermissionPreset(nextGrants);
    applyPermissionState({ grants: nextGrants, preset: nextPreset });
  };
  const togglePermissionAction = (targetKey: string, action: PermissionAction, checked: boolean) => {
    if (action === "view") return;
    const nextGrants = selectedGrants.map((grant) => {
      if (permissionGrantKey(grant) !== targetKey) return grant;
      const nextActions = checked
        ? [...grant.actions, action]
        : grant.actions.filter((candidate) => candidate !== action);
      return { ...grant, actions: normalizePermissionActions(nextActions) };
    });
    applyPermissionState({ grants: nextGrants, preset: inferPermissionPreset(nextGrants) });
  };
  const selectedGrantKeys = new Set(selectedGrants.map(permissionGrantKey));
  const normalizedGrantSearch = grantSearch.trim().toLocaleLowerCase();
  const filteredGroups = (permissionOptions?.groups ?? []).filter((group) => (
    `${group.name} ${group.description ?? ""}`.toLocaleLowerCase().includes(normalizedGrantSearch)
  ));
  const filteredUsers = (permissionOptions?.users ?? []).filter((user) => (
    `${user.name} ${user.email} ${user.role}`.toLocaleLowerCase().includes(normalizedGrantSearch)
  ));
  const ownerOptions = permissionOptions?.users ?? [];
  const ownerIsKnown = ownerOptions.some((user) => user.name === dataOwner);
  const targetDisplay = (grant: PermissionGrant) => {
    const group = permissionOptions?.groups.find((candidate) => grant.principalType === "group" && candidate.id === grant.principalId);
    const user = permissionOptions?.users.find((candidate) => grant.principalType === "user" && candidate.id === grant.principalId);
    if (group) return { description: group.description ?? "그룹", initials: group.name.slice(0, 2).toUpperCase(), label: group.name, type: "그룹" };
    if (user) return { description: `${user.email} · ${user.role}`, initials: user.initials, label: user.name, type: "사용자" };
    return {
      description: "기존 저장 권한",
      initials: grant.principalId.slice(0, 2).toUpperCase(),
      label: grant.principalId,
      type: grant.principalType === "role" ? "역할" : grant.principalType === "group" ? "그룹" : "사용자",
    };
  };

  return (
    <CreationFlowLayout
      variant="permission"
      actions={<CreationTopActions nextLabel="다음" split onPrev={onPrev} onNext={goNext} />}
    >
      <EtlStepHeader
        className="etl-step-standalone-header"
        icon={<ShieldCheck />}
        title="권한 설정"
      />
      {permissionActionError && <Alert className="mb-4" variant="destructive"><Info /><AlertTitle>권한 확인이 필요합니다.</AlertTitle><AlertDescription>{permissionActionError}</AlertDescription></Alert>}
      <div className="grid min-w-0 gap-4 pb-6" data-testid="permission-workflow">
        {permissionOptionsLoading ? (
          <Card className="min-w-0 p-5" data-testid="permission-options-loading">
            <div className="grid gap-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          </Card>
        ) : permissionOptionsError ? (
          <Alert variant="destructive">
            <Info />
            <AlertTitle>권한 대상 API를 불러오지 못했습니다.</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{permissionOptionsError}</span>
              <Button size="sm" type="button" variant="outline" onClick={() => setPermissionOptionsRequest((value) => value + 1)}>
                <RefreshCw data-icon="inline-start" />
                다시 시도
              </Button>
            </AlertDescription>
          </Alert>
        ) : permissionOptions ? (
          <>
            <Card className="min-w-0 overflow-hidden" size="none">
              <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-slate-200 px-5 py-4">
                <span className="etl-review-icon"><SlidersHorizontal size={17} /></span>
                <CardTitle>빠른 권한 설정</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">
                {PERMISSION_PRESETS.map((preset) => {
                  const selected = permissionPreset === preset.id;
                  return (
                    <Button
                      aria-pressed={selected}
                      className={cn(
                        "h-16 justify-center whitespace-normal px-4 py-3 text-center",
                        selected && "border-blue-400 bg-blue-50/80 text-blue-700 hover:bg-blue-100/80",
                      )}
                      key={preset.id}
                      type="button"
                      variant="outline"
                      onClick={() => applyPreset(preset.id)}
                    >
                      <strong>{preset.label}</strong>
                    </Button>
                  );
                })}
              </CardContent>
            </Card>

            <Card className="min-w-0 overflow-hidden" size="none">
              <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-slate-200 px-5 py-4">
                <span className="etl-review-icon schema"><CircleUser size={17} /></span>
                <CardTitle>권한 대상</CardTitle>
                <span className="text-sm font-semibold text-slate-500">{selectedGrants.length}개 선택</span>
              </CardHeader>
              <CardContent className="p-5">
                <Tabs
                  className="grid min-w-0 gap-4"
                  value={grantTab}
                  onValueChange={(value) => {
                    setGrantTab(value as PermissionGrantTab);
                    setGrantSearch("");
                  }}
                >
                  <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <TabsList aria-label="권한 대상 유형">
                      <TabsTrigger value="groups">그룹</TabsTrigger>
                      <TabsTrigger value="users">사용자</TabsTrigger>
                    </TabsList>
                    <InputGroup className="sm:max-w-80">
                      <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
                      <InputGroupInput
                        aria-label={grantTab === "groups" ? "그룹 검색" : "사용자 검색"}
                        placeholder={grantTab === "groups" ? "그룹 검색" : "사용자 검색"}
                        value={grantSearch}
                        onChange={(event) => setGrantSearch(event.target.value)}
                      />
                    </InputGroup>
                  </div>
                  <Separator />

                  <TabsContent className="mt-0" value="groups">
                    {filteredGroups.length > 0 ? (
                      <div className="grid gap-2">
                        {filteredGroups.map((group) => {
                          const selected = selectedGrantKeys.has(`group:${group.id}`);
                          return (
                            <div
                              aria-selected={selected}
                              className={cn(
                                "flex min-w-0 flex-col gap-3 rounded-md border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between",
                                selected && "border-blue-400 bg-blue-50/70",
                              )}
                              key={group.id}
                            >
                              <div className="flex min-w-0 items-center gap-3">
                                <Avatar><AvatarFallback>{group.name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
                                <div className="grid min-w-0 gap-1">
                                  <strong className="truncate text-sm">{group.name}</strong>
                                  <span className="truncate text-sm text-slate-500">{group.description}</span>
                                </div>
                              </div>
                              <Button
                                aria-pressed={selected}
                                size="sm"
                                type="button"
                                variant={selected ? "outline" : "subtle"}
                                onClick={() => togglePermissionTarget({ actions: group.actions, principalId: group.id, principalType: "group" })}
                              >
                                {selected ? "제거" : "추가"}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    ) : <PermissionGrantEmpty query={grantSearch} />}
                  </TabsContent>

                  <TabsContent className="mt-0" value="users">
                    {filteredUsers.length > 0 ? (
                      <div className="grid gap-2">
                        {filteredUsers.map((user) => {
                          const selected = selectedGrantKeys.has(`user:${user.id}`);
                          return (
                            <div
                              aria-selected={selected}
                              className={cn(
                                "flex min-w-0 flex-col gap-3 rounded-md border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between",
                                selected && "border-blue-400 bg-blue-50/70",
                              )}
                              key={user.id}
                            >
                              <div className="flex min-w-0 items-center gap-3">
                                <Avatar><AvatarFallback>{user.initials}</AvatarFallback></Avatar>
                                <div className="grid min-w-0 gap-1">
                                  <strong className="truncate text-sm">{user.name}</strong>
                                  <span className="truncate text-sm text-slate-500">{user.email} · {user.role}</span>
                                </div>
                              </div>
                              <Button
                                aria-pressed={selected}
                                size="sm"
                                type="button"
                                variant={selected ? "outline" : "subtle"}
                                onClick={() => togglePermissionTarget({ actions: ["view"], principalId: user.id, principalType: "user" })}
                              >
                                {selected ? "제거" : "추가"}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    ) : <PermissionGrantEmpty query={grantSearch} />}
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>

            <Card className="min-w-0 overflow-hidden" size="none">
              <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-slate-200 px-5 py-4">
                <span className="etl-review-icon permission"><ShieldCheck size={17} /></span>
                <CardTitle>허용 작업</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 p-5">
                {selectedGrants.length > 0 ? selectedGrants.map((grant) => {
                  const target = targetDisplay(grant);
                  const targetKey = permissionGrantKey(grant);
                  return (
                    <div className="grid min-w-0 gap-4 rounded-md border border-slate-200 p-4 lg:grid-cols-[minmax(13rem,0.8fr)_minmax(0,2fr)] lg:items-center" key={targetKey}>
                      <div className="flex min-w-0 items-center gap-3">
                        <Avatar><AvatarFallback>{target.initials}</AvatarFallback></Avatar>
                        <div className="grid min-w-0 gap-1">
                          <strong className="truncate text-sm">{target.label}</strong>
                          <span className="truncate text-sm text-slate-500">{target.type} · {target.description}</span>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" role="group" aria-label={`${target.label} 허용 작업`}>
                        {PERMISSION_ACTION_ORDER.map((action) => {
                          const checkboxId = `permission-${targetKey}-${action}`;
                          return (
                            <label
                              className={cn(
                                "flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm font-semibold",
                                grant.actions.includes(action) && "border-blue-300 bg-blue-50/70 text-blue-700",
                                action === "view" && "cursor-default",
                              )}
                              htmlFor={checkboxId}
                              key={action}
                            >
                              <Checkbox
                                checked={grant.actions.includes(action)}
                                disabled={action === "view"}
                                id={checkboxId}
                                onCheckedChange={(checked) => togglePermissionAction(targetKey, action, checked === true)}
                              />
                              <span>{PERMISSION_ACTION_LABELS[action]}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                }) : (
                  <Empty className="py-8" size="sm" variant="plain">
                    <EmptyIcon><CircleUser aria-hidden="true" /></EmptyIcon>
                    <EmptyHeader>
                      <EmptyTitle>권한 대상을 먼저 추가하세요.</EmptyTitle>
                      <EmptyDescription>그룹이나 사용자를 추가하면 허용 작업을 직접 설정할 수 있습니다.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </CardContent>
            </Card>

            <Card className="min-w-0 overflow-hidden" size="none">
              <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-slate-200 px-5 py-4">
                <span className="etl-review-icon schema"><CircleUser size={17} /></span>
                <CardTitle>담당자와 전체 조회</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-5 p-5 md:grid-cols-2">
                <ShadcnField>
                  <FieldLabel htmlFor="permission-owner">작업 담당자</FieldLabel>
                  <Select value={dataOwner} onValueChange={(owner) => applyPermissionState({ owner })}>
                    <SelectTrigger aria-label="작업 담당자" id="permission-owner" size="sm">
                      <SelectValue placeholder="담당자 선택" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {!ownerIsKnown && dataOwner ? <SelectItem value={dataOwner}>{dataOwner} · 기존 담당자</SelectItem> : null}
                        {ownerOptions.map((user) => <SelectItem key={user.id} value={user.name}>{user.name} · {user.email}</SelectItem>)}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <span className="text-sm text-slate-500">담당자는 모든 권한을 자동으로 가집니다.</span>
                </ShadcnField>
                <div className="flex min-w-0 items-center justify-between gap-4 rounded-md border border-slate-200 p-4">
                  <div className="grid min-w-0 gap-1">
                    <label className="text-sm font-semibold text-slate-950" htmlFor="permission-public-view">모든 사용자에게 조회 허용</label>
                    <span className="text-sm text-slate-500">로그인한 모든 사용자에게 조회 권한을 추가합니다.</span>
                  </div>
                  <Switch
                    checked={publicView}
                    id="permission-public-view"
                    onCheckedChange={(publicAccess) => applyPermissionState({ publicAccess })}
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="min-w-0 overflow-hidden" size="none">
              <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-slate-200 px-5 py-4">
                <span className="etl-review-icon permission"><Check size={17} /></span>
                <CardTitle>저장될 권한</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2 p-5">
                <div className="flex min-w-0 flex-col gap-2 rounded-md border border-blue-300 bg-blue-50/70 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="grid min-w-0 gap-1">
                    <strong className="truncate text-sm">{dataOwner}</strong>
                    <span className="text-sm text-slate-500">담당자 · 변경하거나 제거할 수 없는 자동 권한</span>
                  </div>
                  <span className="text-sm font-semibold text-blue-700">전체 권한 (자동)</span>
                </div>
                {selectedGrants.map((grant) => {
                  const target = targetDisplay(grant);
                  return (
                    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between" key={`summary-${permissionGrantKey(grant)}`}>
                      <div className="grid min-w-0 gap-1">
                        <strong className="truncate text-sm">{target.label}</strong>
                        <span className="text-sm text-slate-500">{target.type}</span>
                      </div>
                      <span className="text-sm font-semibold text-slate-700">{grant.actions.map((action) => PERMISSION_ACTION_LABELS[action]).join(" · ")}</span>
                    </div>
                  );
                })}
                {publicView ? (
                  <div className="flex min-w-0 flex-col gap-2 rounded-md border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="grid min-w-0 gap-1">
                      <strong className="text-sm">모든 사용자</strong>
                      <span className="text-sm text-slate-500">로그인한 사용자 전체</span>
                    </div>
                    <span className="text-sm font-semibold text-slate-700">조회</span>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </CreationFlowLayout>
  );
}

function PermissionGrantEmpty({ query }: { query: string; }) {
  return (
    <Empty className="py-10" size="sm" variant="plain">
      <EmptyIcon><Search aria-hidden="true" /></EmptyIcon>
      <EmptyHeader>
        <EmptyTitle>검색 결과가 없습니다.</EmptyTitle>
        <EmptyDescription>{query ? `“${query}”와 일치하는 권한 대상을 찾지 못했습니다.` : "표시할 권한 대상이 없습니다."}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
