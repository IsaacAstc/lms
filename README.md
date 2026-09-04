# 항공보안 교육 운영관리 시스템

KAC 항공보안교육훈련센터 교육 운영 업무 전자화 웹시스템. **개인정보를 처리하지 않는 범위**로 한정.
바닐라 HTML/CSS/JS + Firebase v10 modular SDK(CDN), 빌드 도구 미사용, GitHub Pages 배포.

## 구현 현황

### 1단계
- [x] 관리자 인증(Firebase Auth 로그인/로그아웃 게이트)
- [x] 차수(운영) 관리 CRUD (과정코드/과정명/차수/정원/교육기간/교육장/커리큘럼 연결)
- [x] 강의 시간표 입력 CRUD (일자/과목/시작·종료시각/강의실/강사)
- [x] 강의실 시간 중복 검증 경고

### 2단계
- [x] 강의실 관리 CRUD (이름·정원·순서·비고)
- [x] 강사 관리 CRUD (강사만 개인정보 예외 — 관리자 전용 저장)
- [x] 과정 커리큘럼 관리 (과정 + 과목 배열: 일차·과목·시간·교관유형·교육내용)
- [x] 시간표 연동: 커리큘럼 불러오기(일괄 생성 후 개별 수정), 과목 제안(자유입력), 강사 마스터 검색 선택
- [x] 기준값 설정: 강사료 단가·월상한, 소속지별 여비
- [x] 강사료·집계: 교시 단위 시간 산정 → 강사유형별 계산 → 월상한 적용 → 여비(고정 자동/수동확인) → 월별·연간 강사별 집계
- [x] 초기 데이터 시드(강의실 7·강사 51·커리큘럼 24·기준값) — 「데이터」 탭

### 3단계 (설문 수집)
- [x] 강의실별 고유 공개 설문 URL (`survey.html?room=<강의실ID>`) — 강의실/설문 관리 탭에 표시
- [x] 시간표 등록/수정 완료 시 공개 설문(`publicSurveys/{차수ID}`) 자동 생성·갱신
- [x] KST(UTC+9) 기준 노출 창(종료 2시간 전 ~ 종료 후 6시간)에만 응답 가능
- [x] 교육만족도 6문항 + 강사만족도 3문항(과목명+강사명) + 주관식 2종, 5점 척도
- [x] 강사만족도에서 첫·마지막 과목(교육등록/평가/설문/수료) 자동 제외
- [x] 완전 익명 응답, 기기별 1회(localStorage) 중복 방지, 수집일 KST 일 단위, 180일 TTL
- [x] 설문 관리 탭: 노출창·응답수·URL·미리보기·재생성·삭제

집계 대시보드·CSV/XLSX 내보내기·원문 파기 배치는 후속 단계.

### 설문 동작(서버리스)
별도 서버 없이 동작한다. 관리자가 시간표를 등록하면 `publicSurveys` 문서가 생성되고,
강의실 URL 접속 시 브라우저가 KST 현재시각으로 노출 창을 판정해 설문을 표시한다.
응답은 공개 create만 허용(`surveyResponses`), 읽기는 관리자만.
관리자 미리보기: `survey.html?preview=1&course=<차수ID>`(제출 비활성).

### 최초 1회: 초기 데이터 등록
로그인 후 **데이터 탭 → 초기 데이터 시드 실행**을 눌러 강의실·강사·커리큘럼·기준값을 등록한다(이미 있으면 건너뜀).

## 파일 구조

```
index.html                     진입점(로그인 게이트 + 탭 셸)
css/styles.css                 반응형 공통 스타일
js/firebase-config.example.js  설정 템플릿(커밋됨)
js/firebase-config.js          실제 키(커밋 안 됨, .gitignore)
js/firebase.js                 SDK 초기화
js/constants.js                강의실 목록·시각 옵션
js/auth.js                     인증
js/courses.js                  과정·차수 마스터
js/sessions.js                 강의 시간표 + 중복검증
js/app.js                      탭 라우팅·공용 유틸
firestore.rules                보안규칙(수동 배포)
firestore-indexes.md           인덱스 안내
```

## 로컬 실행

ES modules는 `file://`에서 동작하지 않으므로 정적 서버로 연다.

```bash
cp js/firebase-config.example.js js/firebase-config.js
# js/firebase-config.js 에 실제 Firebase 프로젝트 값 입력
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000
```

관리자 계정은 Firebase 콘솔 > Authentication 에서 이메일/비밀번호로 사전 생성한다(회원가입 UI 없음).

## GitHub Pages 배포

`firebase-config.js`는 커밋하지 않으므로, 배포 시 GitHub Actions가 **Secrets 값으로 파일을 생성**한다.
(Firebase 웹 config의 apiKey는 비밀값이 아니며, 실제 보안은 Firestore 규칙 + Auth로 건다.)

1. 저장소 **Settings → Secrets and variables → Actions → New repository secret** 에서 아래 6개 등록:
   - `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`,
     `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID`
2. **Settings → Pages → Source** 를 **GitHub Actions** 로 설정.
3. 배포 실행:
   - `main` 에 병합하면 자동 배포, 또는
   - **Actions 탭 → Deploy to GitHub Pages → Run workflow** 로 수동 실행(브랜치 지정 가능).
4. 배포된 URL(예: `https://<계정>.github.io/lms/`)로 접속해 로그인.

> Firebase 콘솔 **Authentication → Settings → 승인된 도메인**에 `<계정>.github.io` 를 추가해야
> 배포본에서 로그인이 동작한다.

## 데이터 모델 메모

CLAUDE.md 5절 대비 1단계 조정 사항(운영 협의 반영):

- `sessions`의 `period` → `startTime` / `endTime`(과목별 시간 배분이 달라 시각 드롭다운으로 입력).
- `sessions`의 `instructorCode` → `instructor`(강사 자유 텍스트).
- 강의실은 고정 7개: A/B/C/D강의실, CBT실습실, X-ray실습실, 온라인스튜디오.

## 개인정보 처리 원칙

성명·소속·연락처·사번 등 개인 식별정보 입력 필드를 어떤 화면에도 두지 않는다.
실제 Firebase 키·실명 데이터는 커밋하지 않는다(public repo).

## 동거 앱 (LMS Firebase 프로젝트로 통합)

이 저장소는 LMS 외에 아래 정적 앱을 같은 GitHub Pages에서 서빙하며,
**둘 다 LMS의 Firebase 프로젝트를 사용한다. LMS 관리자 로그인이 그대로 통한다**
(같은 프로젝트·같은 도메인이라 로그인 세션 공유).

- `scfe/` — 항공보안 히어로 미션(부스 이벤트 앱). Firestore 컬렉션
  `events`/`scfeSettings`/`participants` 사용, 규칙은 루트 `firestore.rules`에 병합.
  App Check는 통합 시 제거. 관리자 권한 관리는 LMS 관리자 화면에서 일원화.
- `quiz.html` — Quiz! Battle(실시간 퀴즈). Realtime Database 사용,
  퀴즈 만들기·진행은 관리자 로그인 필수(참가자는 로그인 없이 PIN 입장).

### 통합 후 1회 설정 (Firebase 콘솔)
1. **Firestore 규칙 재배포**: 루트 `firestore.rules`를 콘솔에 게시(scfe 컬렉션 규칙 포함).
2. **Realtime Database 활성화**: 빌드 → Realtime Database → 데이터베이스 만들기
   (위치 자유, 프로덕션 모드) → 규칙 탭에 `rtdb.rules.json` 내용 게시.
3. **배포 Secret 추가**: 저장소 Settings → Secrets → Actions 에
   `FIREBASE_DATABASE_URL` = RTDB 주소(`https://…firebasedatabase.app`) 추가 후 재배포.
   로컬 `js/firebase-config.js`에도 `databaseURL` 필드 추가.

## 현장 안내 DID (`did.html`)

로비 대형 TV(16:9 가로)에 상시 표출하는 공개 안내 화면.
- **오늘의 교육**: 공개 현황 보드 데이터에서 오늘 진행 중인 과정 → 차수의 교육장 표시.
- **대관 행사**: `rentals` 컬렉션(행사명·기간·시간·장소·비고만 — 개인정보 없음, 공개 읽기).
- 항목이 한 화면(섹션당 6개)을 넘으면 10초 간격 자동 페이지 순환. 실시간 갱신·시계 포함.
- 관리: 관리자 화면 **현장 안내** 탭(대관 CRUD + DID 제목/안내문구/로고/배경 설정).
  설정은 `publicBoard/__did` 문서. 기관별 URL은 `did.html?org=<기관ID>`.
- 규칙: `rentals` 공개 읽기/관리자 쓰기 — `firestore.rules` 재배포 필요.

## 온라인 교육 신청 접수 (`functions/` — Cloud Functions, Blaze 필요)

공개 현황 보드에서 과정별 **신청/취소**를 받아 접수 이메일로 자동 발송하고,
잔여석을 **즉시 보드에 반영**하는 서버 함수(`submitApplication`).

- 신청: 인원·제목·내용·본인 이메일·첨부(공문 필수, 파일당 ≤5MB·합계 8MB) →
  잔여석 선점(트랜잭션) → 접수처+본인에게 메일 발송(실패 시 잔여석 원복) →
  **접수번호** 발급.
- **신청 마감 = 교육 시작일**. 시작일이 지난 과정은 보드에서 신청 버튼이
  '접수 마감'으로 잠기고 서버도 접수를 거부한다(취소는 계속 가능).
- 취소: 접수번호 대조(해시) 후 잔여석 복구 + 메일 통지. 익명 취소 공격 불가.
- **반려**(`rejectApplication`, 관리자 전용): 공문·명단 미비 시 관리자 화면
  '접수 이력'에서 사유를 입력해 반려 → 잔여석 즉시 복구 + 신청자에게 사유
  통지 + 상태 `rejected`(해당 접수번호는 이후 취소 불가 → 이중 차감 방지).
- **개인정보 최소 보관**: 첨부파일은 저장하지 않는다. 신청자 이메일은 반려
  통지 목적으로만 보관하고 ① 반려·취소 처리 즉시 삭제, ② 남은 건도 신청
  마감일 경과 후 매일 03:00(KST) `purgeApplicationEmails`가 자동 파기한다.
- 남용 방지: IP(해시)당 시간당 10회 제한, 인원 1~20, 잔여석 초과 거부.

### 배포 절차 (1회)
1. Firebase 콘솔 → 프로젝트 설정 → **요금제를 Blaze(종량제)로 업그레이드**
   (이 사용량 규모는 무료 구간 내 — 카드 등록만 필요).
2. 발신용 Gmail 계정에 2단계 인증 설정 → [앱 비밀번호](https://myaccount.google.com/apppasswords) 발급.
3. 로컬에서 (Node 20+, `npm i -g firebase-tools`):
   ```bash
   firebase login
   firebase use <프로젝트ID>
   firebase functions:secrets:set MAIL_USER   # 발신 Gmail 주소 입력
   firebase functions:secrets:set MAIL_PASS   # 앱 비밀번호 입력
   # 응답자 식별자 해시 키(기명 조사용). 무작위 32자 이상, 한 번 정하면 바꾸지 말 것 —
   # 바꾸면 기존 응답과 해시가 달라져 중복 판정이 어긋난다.
   # 기명 조사를 쓰지 않더라도 함수 배포에는 이 시크릿이 존재해야 하므로 반드시 등록한다.
   firebase functions:secrets:set SURVEY_ID_SALT
   cd functions && npm install && cd ..
   firebase deploy --only functions
   ```
   (자동 파기 함수 때문에 Cloud Scheduler API가 함께 활성화된다 — 작업 3개까지 무료.)
4. `firestore.rules` 재배포(`applications`/`rateLimits` 규칙 추가분).
5. 관리자 화면 → 공개 현황 보드 탭 → **접수 이메일 입력 + 신청 버튼 노출 체크 → 저장**.
   저장해야 보드에 신청/취소 버튼이 나타난다(체크 해제로 즉시 비활성화 가능).

기관(테넌트) 분리 운영 시 함수는 프로젝트별로 각각 배포해야 한다.

### 함수 자동 배포 (GitHub Actions — PC 없이 배포)
`.github/workflows/deploy-functions.yml`이 **main 머지 시 `functions/`·`firestore.rules`
변경분을 자동 배포**한다. 아래 시크릿을 한 번만 등록하면 이후 PC 작업이 필요 없다.

1. [Google Cloud 콘솔 → IAM 및 관리자 → 서비스 계정](https://console.cloud.google.com/iam-admin/serviceaccounts)
   에서 해당 프로젝트에 서비스 계정 생성(예: `github-deploy`).
2. 다음 역할 부여: **Firebase 관리자**, **Cloud Functions 관리자**,
   **서비스 계정 사용자**, **Artifact Registry 관리자**, **Cloud Build 편집자**,
   **Cloud Scheduler 관리자**, **Secret Manager 관리자**(함수가 쓰는
   `MAIL_USER`/`MAIL_PASS` 접근에 필요 — 없으면 배포가 403으로 실패).
   (간단히 하려면 **편집자**(Editor) 하나로도 가능하나 권한이 넓어지므로 권장하지 않음)
3. 해당 서비스 계정 → 키 → **새 키 만들기(JSON)** → 파일 다운로드.
4. GitHub 저장소 → Settings → Secrets and variables → Actions → **New repository secret**
   - `FIREBASE_SERVICE_ACCOUNT` : 내려받은 JSON 파일 **내용 전체** 붙여넣기
   - `FIREBASE_PROJECT_ID` : Firebase 프로젝트 ID
5. 이후 Actions 탭에서 `Deploy Functions & Rules` 워크플로를 수동 실행(`Run workflow`)해
   한 번 검증한다. 시크릿이 없으면 워크플로는 경고만 남기고 건너뛴다.

> 비상 수단: 브라우저만으로 배포하려면 [Google Cloud Shell](https://shell.cloud.google.com)
> 에서 `git clone` 후 `firebase deploy --only functions` 를 실행하면 된다(도구 사전 설치됨).

## 관리자 권한 (역할 · 계정별 탭)

- **마스터 관리자**: 모든 탭 + `데이터 관리`·`기관 관리` 전용 기능(원문 파기,
  보존정책·과정유형 변경, 기관 등록, 다른 계정의 역할·탭 권한 변경).
- **일반 관리자**: 마스터 전용 탭을 제외한 나머지. 여기에 더해 **계정별로 사용 가능한
  탭을 지정**할 수 있다(`admins/{email}.tabs` 배열, 필드가 없으면 전체 허용).
  설정 → 관리자 계정 탭의 '사용 가능 탭' 열에서 마스터가 체크로 지정한다.
- **참관자(observer)**: 허용된 탭을 **조회만** 할 수 있고 모든 저장·삭제가 차단된다
  (`role: 'observer'`). 규칙에서 쓰기를 전면 거부하고, 화면에서도 저장·등록·삭제류
  버튼을 눌러도 동작하지 않는다. 본인 비밀번호 변경은 가능.
- 차단은 **화면(탭 숨김) + 보안규칙(쓰기 차단)** 두 단계로 적용된다. 읽기는 탭 간
  데이터 참조가 많아 관리자 공통으로 두고, **편집 권한만 탭 단위로 분리**한다.
- 권한 상승 방지: 일반 관리자는 자신·타인의 `tabs`와 `role`을 바꿀 수 없다(규칙에서 차단).

## 수업 보드 (`pad.html` — 패들렛 벤치마킹 협업 게시판)

수강생이 링크·QR로 로그인 없이 의견·자료를 게시하는 수업 지원 도구.
- 관리: **수업 지원 → 수업 보드** 탭 — 보드 생성(형식: 셸프/담벼락/스트림,
  반응: 좋아요/투표/없음, 댓글 on/off, 승인제, 닉네임/익명), 게시물 관리(승인
  대기함), 복제(템플릿)·보관(아카이브)·CSV 내보내기.
- 참여: `pad.html?board=<ID>` — 제목·본문·이미지(자동 압축 내장)·링크(유튜브
  임베드), 카드 색, 실시간 동기화. 본인 글 수정·삭제는 작성한 기기에서만
  (무작위 기기 키 — 개인정보 아님). 비속어 간이 필터(승인제 병행 권장).
- 개인정보: 실명 입력란 없음(닉네임은 자유 필명), "개인 식별정보 기재 금지"
  고정 안내. 승인제 보드의 미승인 글은 관리자만 읽을 수 있다(규칙 차단).
- 규칙: `collabBoards`(공개 읽기/pad 탭 쓰기), `collabPosts`(공개 글 읽기·형식
  검증 create·반응/댓글/본인수정 update 제한) — 자동 배포에 포함.

## ICAO 로지보드 (`logi.html` — 국제과정 참가자 포털, 영어 전용)

Daily Schedule(강사명 미표시 스냅샷)·Bulletins·Polls·Ask Staff(1:1 Q&A)·Group Chat.
- 관리: **수업 지원 → ICAO 로지보드** 탭 — 차수 선택 후 활성화, 공지/투표 CRUD,
  Q&A 수신함(🔴 답장 필요), 채팅 모니터(삭제), QR·URL 공유, 시간표 재동기화,
  **운영기간 수정**(교육기간 전후 운영 대응 — 차수 데이터와 독립).
- 수강생 계정(선택, 가상 ID): 아이디+비밀번호만으로 가입 — **이메일 미수집**,
  내부적으로 `id@trainee.local` 형식 Firebase Auth 가상 계정. 기기가 바뀌어도
  Q&A 스레드가 유지되고, 채팅·Q&A **본인 메시지 수정('edited' 표시)·삭제** 가능.
  비밀번호 분실 시 복구 불가(새 계정 생성). 관리자 세션과 분리된 보조 앱
  인증이라 같은 브라우저의 관리자 로그인에 영향 없음.
  - Firebase 콘솔 주의: Authentication → 이메일/비밀번호 공급자가 켜져 있어야
    하고, "사용자 계정 만들기(가입) 차단"을 켜면 수강생 가입이 막힌다.
  - 보안: `@trainee.local` 계정은 admins 컬렉션에 없으므로 관리자 권한 불가.
    RTDB 규칙이 staff 쓰기를 비-trainee 이메일 계정으로 제한한다.
- 규칙: `logiBoards`/`logiBulletins`(공개 읽기/logi 탭 쓰기), `logiPolls`(투표
  update만 익명 허용), RTDB `logi/*`(본인 uid 메시지만 수정·삭제) — 자동 배포 포함.
- **FCM 푸시(앱 종료 상태에서도 수신)**: 새 공지·투표 생성/마감·Q&A staff 답장을
  구독 기기로 푸시. 발송은 관리자 조작 직후 `sendLogiPush` callable(관리자 전용)이
  수행 — 토큰은 `logiTokens/{token}`(courseId·threadKey), 무효 토큰은 발송 시 자동 정리.
  - **설정(1회)**: Firebase 콘솔 → 프로젝트 설정 → 클라우드 메시징 → 웹 푸시 인증서
    '키 쌍' 생성 → LMS **수업 지원 → ICAO 로지보드** 탭의 "푸시 키 저장"에 입력.
    미설정 시 푸시만 비활성(열림 상태 알림은 계속 동작).
  - 서비스워커 `firebase-messaging-sw.js`는 Firebase 설정을 커밋하지 않으므로
    등록 URL 쿼리(`?config=…`)로 전달받는다(기관별 프로젝트 대응).
  - iPhone(iOS 16.4+)은 홈 화면에 추가한 뒤에만 웹 푸시 수신 가능.

## 기관(테넌트) 분리 운영

코드는 이 저장소 하나를 공유하고, **기관별로 별도 Firebase 프로젝트**를 사용해
차수·시간표·마스터·설문 데이터를 완전히 격리한다(방안2). 기관 목록은 허브(기본
기관) 프로젝트의 `orgs/{orgId}` 컬렉션에 저장되며, 로그인 화면·상단바의 기관
선택과 공개 페이지의 `?org=` 파라미터가 이를 참조한다.

### 신규 기관 추가 절차
1. **Firebase 콘솔에서 새 프로젝트 생성**
   - Firestore Database 활성화(프로덕션 모드, `asia-northeast3` 권장)
   - Authentication → 이메일/비밀번호 활성화, 가입(신규 생성) 차단, 관리자 계정 생성
   - Firestore 규칙 탭에 이 저장소의 `firestore.rules` 게시
   - Authentication → Settings → 승인된 도메인에 `<계정>.github.io` 추가
   - (선택) 퀴즈를 기관별로 쓰려면 Realtime Database + `rtdb.rules.json` — 현재
     동거 앱(퀴즈·히어로 미션)은 기본 기관 전용이다.
2. **기관 등록**: 기본 기관에 마스터로 로그인 → 설정 → **기관 관리** →
   기관 ID(영문)·기관명·firebaseConfig(콘솔 복사값) 저장.
3. 이후 로그인 화면에서 기관을 선택해 접속한다. 공개 현황 보드·설문 URL은
   해당 기관으로 접속한 상태에서 복사하면 `?org=` 파라미터가 자동으로 붙는다.

주의: 기관 레지스트리(`orgs`)의 config는 공개값이며, 실제 접근 통제는 각
프로젝트의 보안규칙·Auth가 담당한다. 허브 규칙에 `orgs` 블록이 포함되도록
`firestore.rules`를 재배포해야 한다.
