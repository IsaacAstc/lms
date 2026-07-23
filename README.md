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

후속 단계(설문 수집·집계·통계·내보내기·원문 파기 등)는 미구현.

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
