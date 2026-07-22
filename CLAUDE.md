# 항공보안 교육 운영관리 시스템 (가칭)

## 1. 개요
KAC 항공보안교육훈련센터 교육 운영 업무의 전자화. **개인정보를 처리하지 않는 범위**로 한정한 운영관리 웹시스템.

- 배포: GitHub Pages (public repo)
- 스택: 바닐라 HTML/CSS/JS + Firebase v10 modular SDK (CDN), 빌드 도구 미사용
- 백엔드: Firebase Firestore + Firebase Authentication (Spark 무료 플랜)

## 2. 개발 범위 (포함)

| # | 기능 | 상세 |
|---|---|---|
| 1 | 과정·차수 마스터 | 과정명, 과정코드, 정원, 교육기간, 교육장 CRUD |
| 2 | 강의 시간표 입력 | 과목·일자·교시·강의실·강사코드 등록 |
| 3 | 스케줄링 검증 | 강사코드/강의실 시간 중복 자동 검출 및 경고 |
| 4 | 수강 slot 관리 | 차수별 정원/신청건수/잔여석 **수치만** 관리 (개인 신청 처리 없음) |
| 5 | 설문 수집 (온라인) | 완전 익명, QR/링크 진입, 객관식 + 주관식 |
| 6 | 주관식 원문 관리 | 관리자 전용 조회·검색, 분류/요약 입력 |
| 7 | 집계 데이터 | 과목별 응답수·평균·표준편차·척도 분포, 주관식 분류코드별 건수 |
| 8 | 통계 대시보드 | 과정별 운영현황, 과목별 만족도 추이, 차수 간 비교 |
| 9 | 내보내기 | CSV / XLSX 다운로드 |
| 10 | 관리자 인증 | Firebase Auth 로그인, 읽기/쓰기 권한 분리 |
| 11 | 원문 자동 파기 | 주관식 원문 180일 후 삭제 |

## 3. 개발 범위 (제외 — 구현하지 말 것)
- CBT 필기평가
- 입과신청서 온라인 접수
- 교육생 개인 출석 확인 (QR 출결 포함)
- 강사 출강 확인
- 전자이수확인증 발급
- 개인별 수강 승인 처리
- 성명·연락처·사번·주민번호 등 개인 식별정보 입력 필드 일체

## 4. 개인정보 처리 원칙 (필수 준수)
1. 개인 식별정보 입력 필드를 **어떤 화면에도 만들지 않는다**.
2. 설문 응답 시 로그인·이름·사번을 수집하지 않는다. IP·User-Agent를 저장하지 않는다.
3. 타임스탬프는 일(日) 단위까지만 저장한다.
4. 중복응답 방지는 1회용 토큰 방식. **토큰과 응답 문서를 연결 저장하지 않는다.**
5. 강사는 실명이 아닌 강사코드로만 다룬다. 코드↔실명 대응표는 시스템 외부에 둔다.
6. 설문 시작 화면에 안내 문구 고정 노출: "개인을 식별할 수 있는 정보(성명, 소속, 연락처 등)는 기재하지 마십시오."
7. 저장소는 public이므로 설정값·내부 문서·실명 데이터를 커밋하지 않는다.

## 5. 데이터 모델 (Firestore)

```
courses/{courseId}
  code, name, capacity, startDate, endDate, venue, round

sessions/{sessionId}            // 시간표
  courseId, date, period, subject, room, instructorCode

surveyResponses/{responseId}    // 주관식 원문 포함, 180일 TTL
  courseId, subject, collectedDate (YYYY-MM-DD),
  ratings: { q1: 5, q2: 4, ... },
  freeText: string,
  expireAt: Timestamp           // collectedDate + 180d, TTL 필드

surveyAggregates/{aggregateId}  // 영구 보관
  courseId, subject, responseCount,
  mean, stddev, distribution: { 5: n, 4: n, ... },
  categories: [ { code, label, count } ],
  summary: string               // 개인·강사 지목 없는 일반 서술
  actionTaken: string

surveyTokens/{tokenId}          // 1회용, 사용여부만
  courseId, used: boolean, expireAt
```

## 6. 보안 규칙 요건
- `surveyResponses`: `create`만 공개 허용, `read`/`update`/`delete`는 인증된 관리자만.
- `create` 시 `expireAt`이 서버 기준 수집일+180일과 일치하는지 규칙에서 검증(클라이언트 조작 방지).
- `surveyAggregates`: 읽기 범위 최소화, 쓰기는 관리자만.
- `courses`, `sessions`: 읽기는 관리자만, 쓰기는 관리자만.
- `surveyTokens`: 토큰 사용 처리 외 읽기 금지.

## 7. 파기 처리
- Firestore TTL 정책을 `surveyResponses.expireAt`에 설정.
- TTL 삭제는 만료 후 즉시가 아니며 지연될 수 있음 → 관리자 페이지에 "만료 원문 일괄 삭제" 수동 버튼 병행.
- 삭제 이행 여부 분기 1회 점검 절차를 관리자 화면에 체크리스트로 제공.

## 8. 구현 지침
- ES modules 사용. Firebase는 CDN modular SDK v10.
- 복합 인덱스가 필요한 쿼리는 별도 문서에 정리해 수동 생성할 수 있게 안내.
- `firebase-config.js`는 별도 파일로 분리.
- 반응형(모바일 설문 응답 대응 필수).
- 한국어 UI.
- 정원 카운트 갱신은 Firestore 트랜잭션 사용.

## 9. 확인 필요 (미확정 항목)
- KAC 내부 클라우드·외부서비스 이용 지침 적용 여부
- KAC 기록물 관리 규정상 설문 원문 보존연한 (현재 180일은 임의 지정값)
- 설문 문항 구성 및 척도 (기존 정기/초기/특별 과정 설문지 기준)
- 과정 코드 체계
