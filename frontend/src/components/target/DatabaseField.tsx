import { useEffect, useMemo, useState } from "react";
import { Check, Database, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { PickerDialog } from "@/components/ui/picker-dialog";
import { listTargetDatabases, type TargetDatabaseOption } from "../../services/targetDatabaseApi";

type DatabaseFieldProps = {
  onChange: (databaseName: string) => void;
  useShadcnStyles?: boolean;
  value: string;
};

const FALLBACK_DATABASES: TargetDatabaseOption[] = [
  { description: "기본 AskLake 카탈로그 DB", name: "asklake" },
  { description: "정제 데이터셋 저장 DB", name: "asklake_gold" },
  { description: "분석용 데이터 마트 DB", name: "analytics" },
  { description: "마케팅/고객 데이터 DB", name: "marketing" },
];

function mergeCurrentDatabase(databases: TargetDatabaseOption[], currentName: string) {
  const normalizedName = currentName.trim();
  if (!normalizedName || databases.some((database) => database.name === normalizedName)) return databases;
  return [{ description: "현재 설정된 DB", name: normalizedName }, ...databases];
}

export function DatabaseField({ onChange, useShadcnStyles = false, value }: DatabaseFieldProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="database-field">
      <div className="database-display" title={value}>
        {value.trim() ? <span>{value}</span> : <em>DB를 선택하세요</em>}
      </div>
      <Button className={useShadcnStyles ? undefined : "secondary-button database-field-action"} type="button" variant="outline" onClick={() => setPickerOpen(true)}>
        <Database data-icon="inline-start" />
        찾아보기
      </Button>
      {pickerOpen ? (
        <DatabasePicker
          value={value}
          useShadcnStyles={useShadcnStyles}
          onCancel={() => setPickerOpen(false)}
          onSelect={(databaseName) => {
            onChange(databaseName);
            setPickerOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function DatabasePicker({
  onCancel,
  onSelect,
  useShadcnStyles,
  value,
}: {
  onCancel: () => void;
  onSelect: (databaseName: string) => void;
  useShadcnStyles: boolean;
  value: string;
}) {
  const [databases, setDatabases] = useState<TargetDatabaseOption[]>(() => mergeCurrentDatabase(FALLBACK_DATABASES, value));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState(value.trim() || FALLBACK_DATABASES[0]?.name || "");

  const filteredDatabases = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return databases;
    return databases.filter((database) => (
      database.name.toLowerCase().includes(normalizedQuery)
      || database.description.toLowerCase().includes(normalizedQuery)
    ));
  }, [databases, query]);

  const loadDatabases = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await listTargetDatabases();
      const nextDatabases = mergeCurrentDatabase(result.databases.length > 0 ? result.databases : FALLBACK_DATABASES, value);
      setDatabases(nextDatabases);
      setSelectedName((currentName) => currentName || nextDatabases[0]?.name || "");
    } catch (loadError) {
      setDatabases((currentDatabases) => mergeCurrentDatabase(currentDatabases.length > 0 ? currentDatabases : FALLBACK_DATABASES, value));
      setError(loadError instanceof Error ? loadError.message : "DB 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDatabases();
  }, []);

  return (
    <PickerDialog
      contentClassName="s3-picker-dialog database-picker-dialog"
      description="최종 데이터셋을 등록할 데이터베이스를 선택합니다."
      footer={(
        <>
          <div className="s3-picker-preview" title={selectedName}>{selectedName ? `선택 DB: ${selectedName}` : "선택된 DB가 없습니다."}</div>
          <Button className={useShadcnStyles ? undefined : "secondary-button"} type="button" variant="outline" onClick={onCancel}>취소</Button>
          <Button className={useShadcnStyles ? undefined : "primary-button"} disabled={!selectedName} type="button" onClick={() => onSelect(selectedName)}>선택</Button>
        </>
      )}
      footerClassName="s3-picker-footer"
      headerClassName="s3-picker-header"
      onClose={onCancel}
      title="DB 선택"
      toolbar={(
        <div className="s3-picker-toolbar database-picker-toolbar">
          <Field className="field">
            <FieldLabel>DB 검색</FieldLabel>
            <InputGroup className="s3-picker-search">
              <InputGroupAddon>
                <Search size={14} />
              </InputGroupAddon>
              <InputGroupInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="데이터베이스 검색" />
            </InputGroup>
          </Field>
        </div>
      )}
      error={error ? (
        <div className="s3-picker-error">
          <span>{error}</span>
          <Button size="sm" type="button" variant="link" onClick={loadDatabases}>
            <RefreshCw data-icon="inline-start" />
            다시 시도
          </Button>
        </div>
      ) : null}
    >
      <div className="database-picker-body">
          {loading ? <div className="database-picker-state">DB 목록을 불러오는 중입니다.</div> : null}
          {!loading && filteredDatabases.length === 0 ? <div className="database-picker-state">선택할 DB가 없습니다.</div> : null}
          {!loading && filteredDatabases.length > 0 ? (
            <div className="database-picker-list">
              {filteredDatabases.map((database) => {
                const selected = selectedName === database.name;
                return (
                  <Button
                    className={selected ? "database-picker-option active" : "database-picker-option"}
                    key={database.name}
                    type="button"
                    variant="outline"
                    onClick={() => setSelectedName(database.name)}
                  >
                    <Database data-icon="inline-start" />
                    <span>
                      <strong>{database.name}</strong>
                      <em>{database.description}</em>
                    </span>
                    {selected ? <Check data-icon="inline-end" /> : null}
                  </Button>
                );
              })}
            </div>
          ) : null}
        </div>
    </PickerDialog>
  );
}
