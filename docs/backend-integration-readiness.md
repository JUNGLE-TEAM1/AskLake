# AskLake Backend Integration Readiness

??ë¬¸ì„œ???„ì¬ ?„ë¡ ?¸ì—”?œë? ë°±ì—”?œì? ?°ê²°?˜ê¸° ?„ì— ?¨ì? ?‘ì—…, mock ?œê±° ?œì„œ, ?”ë©´ë³?API ?°ê²° ë²”ìœ„ë¥??•ë¦¬??ì²´í¬ ë¬¸ì„œ?…ë‹ˆ??
?ì„¸ ?”ì²­/?‘ë‹µ ?€?…ì? `docs/api-contract.md`ë¥?ê¸°ì??¼ë¡œ ?©ë‹ˆ??
API, mock fixture, frontend internal state???ì–´ canonical status valueë¥??¬ìš©?˜ê³ , ?œêµ­???”ë©´ ë¬¸êµ¬???„ë¡ ??mapper?ì„œ ë³€?˜í•©?ˆë‹¤.
E2E fallback ê²€ì¦?ê¸°ì??€ `docs/e2e-fallback-verification.md`ë¥?ê¸°ì??¼ë¡œ ?©ë‹ˆ??
10GB demo evidenceê°€ ?„ìš”??ê²½ìš° `docs/10gb-fallback-verification.md`ë¥?ì¶”ê?ë¡?ì°¸ì¡°?©ë‹ˆ??

## 1. ?„ì¬ ?íƒœ ?”ì•½

?„ì¬ ?„ë¡ ?¸ì—”?œëŠ” ?¨ìˆœ ?•ì  ?”ë©´???„ë‹ˆ?? ?„ë˜ ?ë¦„?€ React ?íƒœ?€ mock APIë¡??´ì–´???ˆìŠµ?ˆë‹¤.

| ?ë¦„ | ?„ì¬ ?íƒœ | ë°±ì—”???°ê²° ?íƒœ |
| --- | --- | --- |
| ?˜ì§‘/ì²˜ë¦¬ ëª©ë¡ | mock jobs ?œì‹œ, ?ì„¸/?¤í–‰/?˜ì •/?? œ ë²„íŠ¼ ?°ê²° | P0 ?¼ë? ì¤€ë¹?|
| ???˜ì§‘/ì²˜ë¦¬ ?ì„± | Source ??Schema ??Rule ??Schedule ??Permission ??Target ??Review ì§„í–‰ | `POST /api/etl/jobs` ?„í™˜ ê°€??|
| ?‘ì—… ëª…ë ¹ | ì¦‰ì‹œ ?¤í–‰, ?¬ì‹¤?? ?¼ì‹œ?•ì?, ì·¨ì†Œ ?íƒœ ë°˜ì˜ | `POST /api/etl/jobs/{jobId}/commands` ?„í™˜ ê°€??|
| ?‘ì—… ?ì„¸/?¤í–‰ ?´ë ¥/DAG | mock ?ì„¸ ?•ë³´, DAG ë²„íŠ¼, ?ì„¸ ?¨ë„ ?œì‹œ | ì¡°íšŒ API ?„ìš” |
| ì¹´íƒˆë¡œê·¸ | mock datasets ëª©ë¡/?ì„¸/ë¦¬ë‹ˆì§€ ?œì‹œ | hydrate API ?„ìš” |
| SQL ë¶„ì„ | dataset ê¸°ì? read-only SQL ?¤í–‰ mock | `POST /api/query/runs` ?„í™˜ ê°€??|
| ?€?œë³´??| SQL ê²°ê³¼ ê¸°ë°˜ builder/publish UI ?œì‹œ | ?€??ì¡°íšŒ API ?„ìš” |
| AI ?œìš© | placeholder ?”ë©´ | ë°±ì—”??ê¸°íš ë¯¸ì • |
| ê´€ë¦?| placeholder ?”ë©´ | ë°±ì—”??ê¸°íš ë¯¸ì • |
| ê°ì‚¬ ë¡œê·¸ | local state/localStorage ê¸°ë¡ | `POST /api/audit-logs` ?„ìš” |

## 2. ë°±ì—”???°ê²° ??ë°˜ë“œ???ë‚¼ ê²?

| ?°ì„ ?œìœ„ | ?‘ì—… | ?´ìœ  |
| --- | --- | --- |
| P0 | `POST /api/etl/jobs` êµ¬í˜„ | ?ì„± ?Œë¡œ?°ì˜ ìµœì¢… ?œì¶œ ì§€??|
| P0 | `POST /api/etl/jobs/{jobId}/commands` êµ¬í˜„ | ?¤í–‰/?¬ì‹¤???¼ì‹œ?•ì?/ì·¨ì†Œ ë²„íŠ¼???¤ì œ ?íƒœ ?„ì´ |
| P0 | `POST /api/query/runs` êµ¬í˜„ | SQL ?¤í–‰ ê²°ê³¼ë¥??€?œë³´?œë¡œ ?˜ê¸°???µì‹¬ ?ë¦„ |
| P1 | `GET /api/etl/jobs`?€ `GET /api/etl/jobs/{jobId}` êµ¬í˜„ | ?˜ì§‘/ì²˜ë¦¬ ëª©ë¡ê³??ì„¸ë¥??œë²„ ?°ì´?°ë¡œ hydrate |
| P1 | `GET /api/catalog/datasets`?€ ?ì„¸ API êµ¬í˜„ | ì¹´íƒˆë¡œê·¸/SQL/dashboards??ê³µí†µ ?°ì´???ì²œ |
| P1 | `POST /api/dashboards`, `PATCH /api/dashboards/{id}` êµ¬í˜„ | ?€?œë³´???€??ê²Œì‹œê°€ ?¤ì œ ë¦¬ì†Œ?¤ë¡œ ?¨ë„ë¡?ì²˜ë¦¬ |
| P2 | ê°ì‚¬ ë¡œê·¸ ?œë²„ ?€??| ë°œí‘œ/?´ì˜??ì¶”ì ???•ë³´ |
| P2 | AI ?œìš©/ê´€ë¦?ë©”ë‰´ API ê²°ì • | ?„ì¬??placeholder??ë²”ìœ„ ?•ì • ?„ìš” |

## 3. mock ?œê±° ?œì„œ

### 3.1 1ì°? P0 write API ?°ê²°

?´ë? `frontend/src/services/mockApi.ts`??mock/live ?„í™˜ ì§€?ì´ ?ˆìŠµ?ˆë‹¤.

`.env`:

```bash
VITE_API_BASE_URL=http://localhost:8080
VITE_USE_MOCK_API=false
```

?„í™˜ ???¤ì œ ?¸ì¶œ?˜ëŠ” API:

| ?„ë¡ ???¨ìˆ˜ | ?¤ì œ API |
| --- | --- |
| `createPipelineDraft` | `POST /api/etl/jobs` |
| `runJobCommand` | `POST /api/etl/jobs/{jobId}/commands` |
| `executeQueryDraft` | `POST /api/query/runs` |

???¨ê³„?ì„œ??ì´ˆê¸° ëª©ë¡?€ ?„ì§ mock?¼ë¡œ ?ê³ , ?ì„±/ëª…ë ¹/SQL ?¤í–‰ë§?ë°±ì—”?œì— ë¶™ì…?ˆë‹¤.

### 3.2 2ì°? hydrate API ?°ê²°

?¤ìŒ ?¨ê³„?ì„œ??`frontend/src/hooks/useAskLakeData.ts`??ì´ˆê¸° ?íƒœë¥?mock import ?€???œë²„ ì¡°íšŒë¡?ë°”ê¿‰?ˆë‹¤.

?€??

| ?„ì¬ mock | êµì²´ API |
| --- | --- |
| `etlJobs` | `GET /api/etl/jobs` |
| `catalogDatasets` | `GET /api/catalog/datasets` |
| `selectedJob` ?ì„¸ ?•ë³´ | `GET /api/etl/jobs/{jobId}` |
| `selectedDataset` ?ì„¸ ?•ë³´ | `GET /api/catalog/datasets/{datasetId}` |

ê¶Œì¥ ë°©ì‹:

1. ??ìµœì´ˆ ë¡œë”© ??jobs/datasetsë¥?ë³‘ë ¬ ì¡°íšŒ?©ë‹ˆ??
2. ì¡°íšŒ ?¤íŒ¨ ???¬ìš©?ì—ê²??°ê²° ?¤íŒ¨ ? ìŠ¤?¸ë? ë³´ì—¬ì£¼ê³  mock fallback ?¬ë?ë¥?ê²°ì •?©ë‹ˆ??
3. ?ì„±/ëª…ë ¹ ?„ì—???™ê????…ë°?´íŠ¸ë³´ë‹¤ ?œë²„ ?‘ë‹µê°’ì„ ê¸°ì??¼ë¡œ ?íƒœë¥?ê°±ì‹ ?©ë‹ˆ??
4. hydrate ?‘ë‹µ??`status`??`docs/03-api-reference.md`??canonical status valuesë¥??°ë¼???©ë‹ˆ??

### 3.3 3ì°? ?€?œë³´???€??ëª¨ë¸ ?°ê²°

?„ì¬ ?€?œë³´?œëŠ” ?”ë©´ ???íƒœë¡?builder/published viewë¥??„í™˜?©ë‹ˆ??
ë°±ì—”???°ê²° ???„ë˜ ë¦¬ì†Œ?¤ê? ?„ìš”?©ë‹ˆ??

| ê¸°ëŠ¥ | API ?„ë³´ |
| --- | --- |
| ?€?œë³´??ì´ˆì•ˆ ?ì„± | `POST /api/dashboards` ?ëŠ” `POST /api/dashboards/{dashboardId}/draft/ensure` |
| ?€?œë³´???€??| `PATCH /api/dashboards/{dashboardId}` ?ëŠ” draft revision page/widget/layout API |
| ?€?œë³´??ê²Œì‹œ | `POST /api/dashboards/{dashboardId}/publish` |
| ?€?¥ëœ ?€?œë³´??ì²?ëª©ë¡ | `GET /api/dashboards` |
| ?€?¥ëœ ?€?œë³´??ê²€???„í„° ëª©ë¡ | `POST /api/dashboards/query` |
| °Ô½Ã ´ë½Ãº¸µå »ó¼¼ | `GET /api/dashboards/{dashboardId}/published` |
| ÃÊ¾È ÆíÁı »ó¼¼ | `POST /api/dashboards/{dashboardId}/draft/ensure` |
| ÆäÀÌÁö Ãß°¡ | `POST /api/dashboards/{dashboardId}/draft/pages` |
| ÆäÀÌÁö »èÁ¦ | `DELETE /api/dashboards/{dashboardId}/draft/pages/{pageId}` |
| À§Á¬ Ãß°¡ | `POST /api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets` |
| ·¹ÀÌ¾Æ¿ô ÀúÀå | `PATCH /api/dashboards/{dashboardId}/draft/layouts` |
| ´ë½Ãº¸µå »ó¼¼ | `GET /api/dashboards/{dashboardId}` |
| ´ë½Ãº¸µå »èÁ¦ | `DELETE /api/dashboards/{dashboardId}` |
| legacy À§Á¬ Ãß°¡ | `POST /api/dashboards/{dashboardId}/widgets` |
| ?„ì ¯ ?˜ì • | `PATCH /api/dashboards/{dashboardId}/widgets/{widgetId}` |
| ?„ì ¯ ?? œ | `DELETE /api/dashboards/{dashboardId}/widgets/{widgetId}` |

`POST /api/dashboards`ëŠ” ìƒˆ dashboard cardë¥¼ `draft` ìƒíƒœë¡œ DBì— ë¨¼ì € ì €ì¥í•˜ëŠ” ìƒì„± APIë‹¤. ë‚´ë¶€ í¸ì§‘ í™”ë©´ì—ì„œ í•„ìš”í•œ draft revision/page/widget ì¤€ë¹„ëŠ” `POST /api/dashboards/{dashboardId}/draft/ensure`ê°€ ë‹´ë‹¹í•œë‹¤.

Draft widget creation API accepts only `metric`, `table`, `bar_chart`, `line_chart`, and `donut_chart` runtime types. Backend save/read responses must preserve the type-specific config contract from `frontend/src/types/dashboard.ts`; required field checks are `aggregation` for metric/bar/line/donut configs and `columns` for table configs.

?€?œë³´??ëª©ë¡??ê²€?? ?Œìœ ???„í„°, ?œê·¸ ?„í„°, ?•ë ¬, pagination?€ ?œë²„?ì„œ ì²˜ë¦¬?©ë‹ˆ??
?„ë¡ ?¸ëŠ” JSON bodyë¥?ë³´ë‚´ê³?`items`, `total`, `page`, `pageSize`, `filterOptions`ë¥?ë°›ì•„ ëª©ë¡ê³?pagination???œì‹œ?©ë‹ˆ??

## 4. ?”ë©´ë³??°ê²° ë²”ìœ„

### 4.1 ?˜ì§‘/ì²˜ë¦¬

| ë²„íŠ¼/ê¸°ëŠ¥ | ?„ì¬ ?™ì‘ | ?„ìš”??ë°±ì—”??|
| --- | --- | --- |
| `+ ???˜ì§‘/ì²˜ë¦¬ ?ì„±` | ?ì„± ?Œë¡œ???´ë™ | ?†ìŒ |
| `?ì„¸` | selectedJob ?¤ì • ???ì„¸ ?´ë™ | `GET /api/etl/jobs/{jobId}` |
| `ì¦‰ì‹œ ?¤í–‰` | mock ?íƒœë¥??¤í–‰ ì¤‘ìœ¼ë¡?ë³€ê²?| `POST /api/etl/jobs/{jobId}/commands` |
| `?¬ì‹¤?? | mock ?íƒœë¥??¬ì‹¤??ì¤‘ìœ¼ë¡?ë³€ê²?| `POST /api/etl/jobs/{jobId}/commands` |
| `?¼ì‹œ?•ì?` | mock ?íƒœë¥??¼ì‹œ?•ì?ë¡?ë³€ê²?| `POST /api/etl/jobs/{jobId}/commands` |
| `ì·¨ì†Œ` | mock ?íƒœë¥?ì·¨ì†Œ?¨ìœ¼ë¡?ë³€ê²?| `POST /api/etl/jobs/{jobId}/commands` |
| `?? œ` | ?„ë¡ ??ëª©ë¡?ì„œ ?œê±° | `DELETE /api/etl/jobs/{jobId}` |
| ?¤í–‰ ?´ë ¥ | mock run rows ?œì‹œ | `GET /api/etl/jobs/{jobId}/runs` |
| DAG | mock step graph ?œì‹œ | `GET /api/etl/jobs/{jobId}/dag` |

### 4.2 ???˜ì§‘/ì²˜ë¦¬ ?ì„±

| ?¨ê³„ | ?„ì¬ ?™ì‘ | ?„ìš”??ë°±ì—”??|
| --- | --- | --- |
| Source | connector ? íƒ, ?ŒìŠ¤??ë¯¸ë¦¬ë³´ê¸° mock | `POST /api/etl/sources/test`, `POST /api/etl/sources/preview` |
| Schema | ì¶”ë¡ /?¹ì¸ UI mock | `POST /api/etl/schema-inference`, `POST /api/etl/schema-inference/confirm` |
| Rule | rule ì¶”ê?/ê²€ì¦?UI mock | `POST /api/etl/rules`, `POST /api/etl/rules/revalidate` |
| Schedule | ?¤ì?ì¤?? íƒ ?íƒœ ?€??| ?ì„± request???¬í•¨ ?ëŠ” `PUT /api/etl/jobs/{jobId}/schedule` |
| Permission | ê¶Œí•œ ? íƒ ?íƒœ ?€??| ?ì„± request???¬í•¨ ?ëŠ” `PUT /api/etl/jobs/{jobId}/permissions` |
| Target Review | ìµœì¢… ?ì„± | `POST /api/etl/jobs` |

ì´ˆê¸° ë°±ì—”???°ê²°?ì„œ??ì¤‘ê°„ ?¨ê³„ APIë¥?ëª¨ë‘ êµ¬í˜„?˜ì? ?Šì•„???©ë‹ˆ??
ë°œí‘œ/?°ëª¨ ê¸°ì??¼ë¡œ??ìµœì¢… `POST /api/etl/jobs`ê°€ draft ?„ì²´ë¥?ë°›ì•„ ì²˜ë¦¬?˜ë©´ ì¶©ë¶„?©ë‹ˆ??

### 4.3 ì¹´íƒˆë¡œê·¸

| ê¸°ëŠ¥ | ?„ì¬ ?™ì‘ | ?„ìš”??ë°±ì—”??|
| --- | --- | --- |
| ëª©ë¡ | mock datasets ?œì‹œ | `GET /api/catalog/datasets` |
| ê²€???œê·¸/?„í„° | ?„ë¡ ???´ë²¤??ë¡œê·¸ ì¤‘ì‹¬ | `GET /api/catalog/datasets?q=&tag=&layer=` |
| ?ì„¸ | selectedDataset ?œì‹œ | `GET /api/catalog/datasets/{datasetId}` |
| ?¤í‚¤ë§?| dataset.schema ?œì‹œ | ?ì„¸ ?¬í•¨ ?ëŠ” `/schema` |
| ?˜í”Œ row | dataset.sampleRows ?œì‹œ | ?ì„¸ ?¬í•¨ ?ëŠ” `/sample-rows` |
| ë¦¬ë‹ˆì§€ | upstream/downstream ?œì‹œ | ?ì„¸ ?¬í•¨ ?ëŠ” `/lineage` |
| SQLë¡??´ê¸° | SQL ?”ë©´ ?´ë™ | ?†ìŒ, datasetId ? ì? |

### 4.4 SQL ë¶„ì„

| ê¸°ëŠ¥ | ?„ì¬ ?™ì‘ | ?„ìš”??ë°±ì—”??|
| --- | --- | --- |
| SQL ?¤í–‰ | mock result ?ì„± | `POST /api/query/runs` |
| SQL ?€??| ê°ì‚¬ ë¡œê·¸ë§?ê¸°ë¡ | `POST /api/query/saved` |
| ê²°ê³¼ Lake ?€??| ê°ì‚¬ ë¡œê·¸ë§?ê¸°ë¡ | `POST /api/query/results/lake` |
| CSV ?¤ìš´ë¡œë“œ | ê°ì‚¬ ë¡œê·¸ë§?ê¸°ë¡ | `GET /api/query/runs/{runId}/download` |
| ?€?œë³´???ì„± | `SqlResultDraft`ë¥?builderë¡??„ë‹¬ | `POST /api/dashboards` |

SQL ?¤í–‰ ë°±ì—”?œëŠ” ë°˜ë“œ??read-only guardë¥??¬ì•¼ ?©ë‹ˆ??

### 4.5 ?€?œë³´??

| ê¸°ëŠ¥ | ?„ì¬ ?™ì‘ | ?„ìš”??ë°±ì—”??|
| --- | --- | --- |
| ?„ì ¯ ?€??? íƒ | ?„ë¡ ???íƒœ ë³€ê²?| ?†ìŒ |
| ?„ì ¯ ì¶”ê? | draft canvas??ì¶”ê? | `POST /api/dashboards/{id}/draft/pages/{pageId}/widgets` |
| ?„ì ¯ ?? œ | local canvas?ì„œ ?œê±° | `DELETE /api/dashboards/{id}/widgets/{widgetId}` |
| Draft ì¡°íšŒ/?ì„± | DB-backed draft runtime | `POST /api/dashboards/{id}/draft/ensure` |
| Page ì¶”ê? | DB-backed draft page | `POST /api/dashboards/{id}/draft/pages` |
| Page ?? œ | DB-backed draft page ?? œ | `DELETE /api/dashboards/{id}/draft/pages/{pageId}` |
| Layout ?€??| DB-backed widget layout ?€??| `PATCH /api/dashboards/{id}/draft/layouts` |
| ?€??| localStorage snapshotê³?ê°ì‚¬ ë¡œê·¸ ê¸°ë¡ | draft revision page/widget/layout API ?ëŠ” `PATCH /api/dashboards/{id}` |
| Publish | published viewë¡??„í™˜ | `POST /api/dashboards/{id}/publish` |
| Published Á¶È¸ | DB-backed published revision snapshot | `GET /api/dashboards/{id}/published` |
| ¸ñ·Ï¿¡¼­ »èÁ¦ | È®ÀÎ ¸ğ´Ş ÈÄ ¸ñ·Ï ÀçÁ¶È¸ | `DELETE /api/dashboards/{id}` |
| Share | ÇöÀç´Â ÇÁ·ĞÆ®¿¡¼­ runtime ¸µÅ© º¹»ç¿Í feedback ÆĞ³Î Ç¥½Ã | ÇâÈÄ `POST /api/dashboards/{id}/share` |
| ?´ë³´?´ê¸° | local snapshot JSON ?¤ìš´ë¡œë“œ?€ ê°ì‚¬ ë¡œê·¸ ê¸°ë¡ | `GET /api/dashboards/{id}/export` |
| ?„ì²´?”ë©´/ì°¨íŠ¸ ?•ë? | ?„ë¡ ??ëª¨ë‹¬ ?œì‹œ | ë°±ì—”??ë¶ˆí•„??|

## 5. ?„ì§ ?¤ì œ ?€?¥ë˜ì§€ ?ŠëŠ” ê¸°ëŠ¥

?„ë˜ ê¸°ëŠ¥?€ ?„ì¬ UI ë°˜ì‘ê³?ê°ì‚¬ ë¡œê·¸ë§??ˆê³ , ?œë²„ ?€?¥ì? ?†ìŠµ?ˆë‹¤.

| ?ì—­ | ê¸°ëŠ¥ |
| --- | --- |
| ?˜ì§‘/ì²˜ë¦¬ | ?? œ, ?ì„¸ ?˜ì • ?€?? ?„í„° ì¡°ê±´ ?€??|
| ?ì„± ?Œë¡œ??| Source ì¤‘ê°„ ?ŒìŠ¤??ê²°ê³¼, Schema ?¹ì¸, Rule ì¶”ê?/ê²€ì¦?|
| ì¹´íƒˆë¡œê·¸ | ?€?¥ì†Œ ë³´ê?, ?œê·¸/?„í„° ?œë²„ ê²€??|
| SQL | ì¿¼ë¦¬ ?€?? Lake ?€?? CSV ?¤ìš´ë¡œë“œ |
| ?€?œë³´??| ?„ì ¯ ?€?? ê²Œì‹œ ?íƒœ ? ì?, ê³µìœ , ?´ë³´?´ê¸° |
| ê³µí†µ | ê°ì‚¬ ë¡œê·¸ ?œë²„ ?€?? ?¬ìš©???¸ì¦/ê¶Œí•œ |

## 6. ë°±ì—”???€???˜ê¸¸ ìµœì†Œ êµ¬í˜„ ë²”ìœ„

ìµœì†Œ ?°ëª¨ ?°ë™ë§?ëª©í‘œ?¼ë©´ ?„ë˜ 5ê°œë©´ ì¶©ë¶„?©ë‹ˆ??

1. `POST /api/etl/jobs`
2. `POST /api/etl/jobs/{jobId}/commands`
3. `GET /api/etl/jobs`
4. `GET /api/catalog/datasets`
5. `POST /api/query/runs`

?€?œë³´?œê¹Œì§€ ?¤ì œ ?€?¥í•˜?¤ë©´ ?„ë˜ APIë¥?ì¶”ê??©ë‹ˆ??

1. `GET /api/dashboards`
2. `POST /api/dashboards/query`
3. `GET /api/dashboards/{dashboardId}/published`
4. `POST /api/dashboards/{dashboardId}/draft/ensure`
5. `POST /api/dashboards/{dashboardId}/draft/pages`
6. `DELETE /api/dashboards/{dashboardId}/draft/pages/{pageId}`
7. `POST /api/dashboards/{dashboardId}/draft/pages/{pageId}/widgets`
8. `PATCH /api/dashboards/{dashboardId}/draft/layouts`
9. `POST /api/dashboards/{dashboardId}/publish`

## 7. ?„ë¡ ?¸ì—???¤ìŒ?????‘ì—…

ë°±ì—”??APIê°€ ì¤€ë¹„ë˜ê¸????„ë¡ ?¸ì—??ë¯¸ë¦¬ ?????ˆëŠ” ?‘ì—…?…ë‹ˆ??

| ?œì„œ | ?‘ì—… | ?Œì¼ |
| --- | --- | --- |
| 1 | `getJobs`, `getDatasets` API adapter ì¶”ê? | `frontend/src/services/mockApi.ts` |
| 2 | ì´ˆê¸° hydrate loading/error ?íƒœ ì¶”ê? | `frontend/src/hooks/useAskLakeData.ts` |
| 3 | dashboard adapter ì¶”ê? | `frontend/src/services/mockApi.ts` |
| 4 | audit log ?œë²„ ?€???µì…˜ ì¶”ê? | `frontend/src/hooks/useAuditLogs.ts` |
| 5 | ?? œ/?€??ê²Œì‹œ ?¤íŒ¨ ??rollback ì²˜ë¦¬ | `frontend/src/hooks/useAskLakeData.ts`, dashboard page |

## 8. ?¸ìˆ˜ ê¸°ì?

ë°±ì—”???°ê²°???ë‚¬?¤ê³  ?ë‹¨?˜ë ¤ë©??„ë˜ë¥??µê³¼?´ì•¼ ?©ë‹ˆ??

- `.env`?ì„œ `VITE_USE_MOCK_API=false`ë¡??¤í–‰?´ë„ ?±ì´ ?•ìƒ ë¡œë”©?©ë‹ˆ??
- ???˜ì§‘/ì²˜ë¦¬ ?ì„± ??ëª©ë¡ê³?ì¹´íƒˆë¡œê·¸???œë²„ ?‘ë‹µ ?°ì´?°ê? ?œì‹œ?©ë‹ˆ??
- ì¦‰ì‹œ ?¤í–‰/?¬ì‹¤???¼ì‹œ?•ì?/ì·¨ì†Œ ë²„íŠ¼???œë²„ ?íƒœ ?„ì´ë¥?ë°˜ì˜?©ë‹ˆ??
- SQL ?¤í–‰ ê²°ê³¼ê°€ ?œë²„ ?‘ë‹µ columns/rows ê·¸ë?ë¡??œì‹œ?©ë‹ˆ??
- SQL ê²°ê³¼?ì„œ ?€?œë³´???ì„± ??ê°™ì? `runId`ê°€ dashboard request???¬í•¨?©ë‹ˆ??
- ?ˆë¡œê³ ì¹¨ ?„ì—???€?¥ëœ ?€?œë³´???‘ì—…/?°ì´?°ì…‹??? ì??©ë‹ˆ??
- ?¤íŒ¨ ?‘ë‹µ?€ ? ìŠ¤?¸ì? ê°ì‚¬ ë¡œê·¸???¨ìŠµ?ˆë‹¤.
- ì½˜ì†”??React key/layout ê´€??errorê°€ ?†ì–´???©ë‹ˆ??
