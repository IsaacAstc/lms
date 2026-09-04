# Firestore 인덱스 안내

빌드 도구를 쓰지 않으므로 필요한 복합 인덱스는 콘솔에서 수동 생성한다.

## 1단계(과정·차수 마스터 / 시간표) 기준

- `courses`: `code` 단일 필드 정렬만 사용 → 자동 단일 인덱스로 충분. **추가 인덱스 불필요.**
- `sessions`: `where("courseId", "==", ...)` 단일 필드 필터만 사용하고, 일자·시작시각 정렬은 **클라이언트에서 처리**한다 → **복합 인덱스 불필요.**

## 향후 서버측 정렬로 전환 시

`sessions`를 `where("courseId","==",x)` + `orderBy("date")` + `orderBy("startTime")`로 바꾸면
아래 복합 인덱스가 필요하다. 콘솔 > Firestore > 색인 에서 생성:

| 컬렉션 | 필드 순서 |
|---|---|
| sessions | courseId (오름차순), date (오름차순), startTime (오름차순) |

> 쿼리 실행 시 콘솔 에러 메시지에 포함된 링크를 눌러 생성해도 된다.

## 2단계(강사/과정/강사료) 기준

- `rooms`, `instructors`, `programs`, `settings`: 단순 조회·정렬만 사용 → **추가 인덱스 불필요.**
  - `programs`의 과목(subjects)은 문서 내 배열로 저장하므로 별도 컬렉션/인덱스가 없다.
- 강사료·집계(`js/payroll.js`)는 `sessions` 전체를 구독한 뒤 **클라이언트에서 기간(date) 필터·강사별 집계**한다 → 복합 인덱스 불필요.
  - 데이터가 크게 늘어 서버측 기간 쿼리로 전환할 경우에만 `sessions`에 `date` 단일 인덱스(자동)로 충분하다.

## 3단계(설문) 기준

- `publicSurveys`: `where("roomId","==",...)` 단일 필드 → **추가 인덱스 불필요.** 노출 창 판정은 클라이언트에서 처리.
- `surveyResponses`: `where("courseId","==",...)` 단일 필드(응답수) → **추가 인덱스 불필요.**

## 무료 한도 최적화(기간 조회) 관련

읽기 한도(50k/일) 보호를 위해 집계 화면은 전체 구독 대신 **선택 기간만 조회**한다. 모두 단일 필드 범위 쿼리라 **복합 인덱스 불필요**(자동 단일 인덱스로 충분):
- 강사료·집계: `sessions` `where("date", ">=", …) & where("date","<=", …)`
- 설문 집계: `surveyResponses` `where("collectedDate", ">=", …) & where("collectedDate","<=", …)`

## 기명 조사 (개인정보 처리 경로)

- `namedSurveys`: 목록 전체 구독(필터 없음) → **추가 인덱스 불필요.**
- `namedResponses`: 모든 접근이 서버 함수 경유. 쿼리는 `where("surveyId","==",…)` 단일 필드와
  `where("purgeAt","<=",…)`(보유기간 만료 파기 배치) → 각각 단일 필드라 **추가 인덱스 불필요.**
- `namedRespondents`(중복 방지 표시 — 식별자 해시만, 응답과 연결선 없음):
  중복 차단은 쿼리가 아니라 문서 ID(`{조사ID}__{식별자해시}`) 선점으로 처리한다.
  기간 파기에서 `where("surveyId","==",…) + where("collectedDate",">=",…)+("<=",…)`를 쓰므로
  **`surveyId`(asc) + `collectedDate`(asc) 복합 인덱스 1개가 필요하다.**
  보유기간 만료 파기는 `where("purgeAt","<=",…)` 단일 필드.
- `accessLogs`: 화면 조회는 `orderBy("atMs","desc") + limit(300)` 단일 필드 정렬,
  파기 배치는 `where("expireAt","<=",…)` → **추가 인덱스 불필요.**
