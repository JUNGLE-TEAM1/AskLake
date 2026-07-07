import { useEffect, useMemo, useState } from "react";
import { Check, Database, RefreshCw, Search, X } from "lucide-react";
import { listTargetDatabases, type TargetDatabaseOption } from "../../services/targetDatabaseApi";

type DatabaseFieldProps = {
  onChange: (databaseName: string) => void;
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

export function DatabaseField({ onChange, value }: DatabaseFieldProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="database-field">
      <div className="database-display" title={value}>
        {value.trim() ? <span>{value}</span> : <em>DB를 선택하세요</em>}
      </div>
      <button className="secondary-button database-field-action" type="button" onClick={() => setPickerOpen(true)}>
        <Database size={14} />
        찾아보기
      </button>
      {pickerOpen ? (
        <DatabasePicker
          value={value}
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
  value,
}: {
  onCancel: () => void;
  onSelect: (databaseName: string) => void;
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
    <div className="s3-picker-backdrop" role="presentation" onMouseDown={onCancel}>
      <section aria-label="DB 선택" aria-modal="true" className="s3-picker-dialog database-picker-dialog" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header className="s3-picker-header">
          <div>
            <h2>DB 선택</h2>
            <p>최종 데이터셋을 등록할 데이터베이스를 선택합니다.</p>
          </div>
          <button className="s3-picker-close" type="button" onClick={onCancel} aria-label="DB 선택 닫기">
            <X size={16} />
          </button>
        </header>

        <div className="s3-picker-toolbar database-picker-toolbar">
          <label className="field">
            <span>DB 검색</span>
            <div className="s3-picker-search">
              <Search size={14} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="데이터베이스 검색" />
            </div>
          </label>
        </div>

        {error ? (
          <div className="s3-picker-error">
            <span>{error}</span>
            <button type="button" onClick={loadDatabases}>
              <RefreshCw size={13} />
              다시 시도
            </button>
          </div>
        ) : null}

        <div className="database-picker-body">
          {loading ? <div className="database-picker-state">DB 목록을 불러오는 중입니다.</div> : null}
          {!loading && filteredDatabases.length === 0 ? <div className="database-picker-state">선택할 DB가 없습니다.</div> : null}
          {!loading && filteredDatabases.length > 0 ? (
            <div className="database-picker-list">
              {filteredDatabases.map((database) => {
                const selected = selectedName === database.name;
                return (
                  <button
                    className={selected ? "database-picker-option active" : "database-picker-option"}
                    key={database.name}
                    type="button"
                    onClick={() => setSelectedName(database.name)}
                  >
                    <Database size={15} />
                    <span>
                      <strong>{database.name}</strong>
                      <em>{database.description}</em>
                    </span>
                    {selected ? <Check size={15} /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <footer className="s3-picker-footer">
          <div className="s3-picker-preview" title={selectedName}>{selectedName ? `선택 DB: ${selectedName}` : "선택된 DB가 없습니다."}</div>
          <button className="secondary-button" type="button" onClick={onCancel}>취소</button>
          <button className="primary-button" disabled={!selectedName} type="button" onClick={() => onSelect(selectedName)}>선택</button>
        </footer>
      </section>
    </div>
  );
}
