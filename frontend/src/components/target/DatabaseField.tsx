import { useEffect, useMemo, useState } from "react";
import { Check, Database, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { PickerDialog } from "@/components/ui/picker-dialog";
import { listTargetDatabases, type TargetDatabaseOption } from "../../services/targetDatabaseApi";

type DatabaseFieldProps = {
  disabled?: boolean;
  onChange: (databaseName: string) => void;
  useShadcnStyles?: boolean;
  value: string;
};

export function DatabaseField({ disabled = false, onChange, useShadcnStyles = false, value }: DatabaseFieldProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="database-field">
      <div className="database-display" title={value}>
        {value.trim() ? <span>{value}</span> : <em>DB를 선택하세요</em>}
      </div>
      <Button className={useShadcnStyles ? undefined : "secondary-button database-field-action"} disabled={disabled} type="button" variant="outline" onClick={() => setPickerOpen(true)}>
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
  const [databases, setDatabases] = useState<TargetDatabaseOption[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState("");

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
      const nextDatabases = result.databases;
      setDatabases(nextDatabases);
      const configuredName = value.trim();
      const currentIsAvailable = nextDatabases.some((database) => database.name === configuredName);
      setSelectedName(currentIsAvailable ? configuredName : nextDatabases[0]?.name ?? "");
      if (nextDatabases.length === 0) {
        setError("사용 가능한 대상 DB가 없습니다. 서버의 Trino/Iceberg 대상 스키마 설정을 확인하세요.");
      } else if (configuredName && !currentIsAvailable) {
        setError(`현재 설정된 DB '${configuredName}'는 서버의 사용 가능 목록에 없습니다.`);
      }
    } catch (loadError) {
      setDatabases([]);
      setSelectedName("");
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
