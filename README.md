# 항공보안 교육 운영관리 시스템

KAC 항공보안교육훈련센터 교육 운영 업무 전자화 웹시스템. **개인정보를 처리하지 않는 범위**로 한정.
바닐라 HTML/CSS/JS + Firebase v10 modular SDK(CDN), 빌드 도구 미사용, GitHub Pages 배포.

## 구현 현황 (1단계)

- [x] 관리자 인증(Firebase Auth 로그인/로그아웃 게이트)
- [x] 과정·차수 마스터 CRUD (과정코드/과정명/차수/정원/교육기간/교육장)
- [x] 강의 시간표 입력 CRUD (일자/과목/시작·종료시각/강의실/강사)
- [x] 강의실 시간 중복 검증 경고

후속 단계(설문 수집·집계·통계·내보내기·원문 파기 등)는 미구현.

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

## 데이터 모델 메모

CLAUDE.md 5절 대비 1단계 조정 사항(운영 협의 반영):

- `sessions`의 `period` → `startTime` / `endTime`(과목별 시간 배분이 달라 시각 드롭다운으로 입력).
- `sessions`의 `instructorCode` → `instructor`(강사 자유 텍스트).
- 강의실은 고정 7개: A/B/C/D강의실, CBT실습실, X-ray실습실, 온라인스튜디오.

## 개인정보 처리 원칙

성명·소속·연락처·사번 등 개인 식별정보 입력 필드를 어떤 화면에도 두지 않는다.
실제 Firebase 키·실명 데이터는 커밋하지 않는다(public repo).
