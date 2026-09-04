// 교육 신청/취소 접수 Cloud Function.
// - 이메일 발송(접수처 + 신청자 확인용) 후 신청건수를 트랜잭션으로 즉시 반영(실시간 잔여석).
// - 첨부파일은 메모리에서 메일로 중계만 하고 어디에도 저장하지 않는다.
// - 첨부는 저장하지 않는다. 신청자 이메일은 '반려 통지' 목적으로만 한시 보관하며,
//   반려·취소 처리 즉시 삭제하고 남은 건도 신청 마감일(교육 시작일) 경과 후 자동 파기한다.
// - 취소는 신청 시 발급한 접수번호로 본인 확인(해시 대조) 후 잔여석 복구.
// - 반려는 관리자만(rejectApplication): 잔여석 복구 + 사유 통지 + 이메일 즉시 파기.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

admin.initializeApp();
const db = admin.firestore();

// Gmail 발신 계정(앱 비밀번호). 저장소가 아닌 Firebase Secret에 보관:
//   firebase functions:secrets:set MAIL_USER / MAIL_PASS
const MAIL_USER = defineSecret("MAIL_USER");
const MAIL_PASS = defineSecret("MAIL_PASS");

const MAX_ATTACH_BYTES = 5 * 1024 * 1024; // 첨부 5MB 상한
const MAX_COUNT = 20;                     // 1회 신청 인원 상한
const RATE_LIMIT_PER_HOUR = 10;           // IP당 시간당 요청 상한(남용 방지)
const NAMED_RATE_LIMIT_PER_HOUR = 300;    // 기명 조사 접수: 기관망 공유 IP를 고려한 별도 상한

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// KST 기준 오늘(YYYY-MM-DD). 신청 마감 판정은 일 단위.
function todayKST() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

// 관리자 판정(Admin SDK는 보안규칙을 우회하므로 함수에서 직접 확인).
const BOOTSTRAP_ADMINS = ["isaac@airport.co.kr"];
async function requireAdmin(req) {
  const email = String(req.auth?.token?.email || "").toLowerCase();
  if (!email) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  if (BOOTSTRAP_ADMINS.includes(email)) return email;
  const snap = await db.doc(`admins/${email}`).get();
  if (!snap.exists) throw new HttpsError("permission-denied", "관리자만 사용할 수 있습니다.");
  return email;
}

// 접수번호: 혼동 문자(0/O, 1/I/L) 제외 8자리.
function newReceiptCode() {
  const chars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let out = "";
  const buf = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) out += chars[buf[i] % chars.length];
  return out;
}

function bad(msg) { throw new HttpsError("invalid-argument", msg); }

// 문자열 필드 정리(타입·길이 검증).
function str(v, max, label, required) {
  if (v == null || v === "") {
    if (required) bad(`${label}을(를) 입력하세요.`);
    return "";
  }
  if (typeof v !== "string") bad(`${label} 형식이 올바르지 않습니다.`);
  const t = v.trim();
  if (t.length > max) bad(`${label}이(가) 너무 깁니다(최대 ${max}자).`);
  return t;
}

// IP 기준 시간당 호출 제한(간단한 남용 방지 — 해시로만 기록, 원IP 미저장).
async function checkRateLimit(rawIp, maxPerHour = RATE_LIMIT_PER_HOUR) {
  const hour = Math.floor(Date.now() / 3600000);
  const key = sha256(`${rawIp || "unknown"}:${hour}:${maxPerHour}`).slice(0, 32);
  const ref = db.collection("rateLimits").doc(key);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const n = snap.exists ? (snap.data().n || 0) : 0;
    if (n >= maxPerHour) {
      throw new HttpsError("resource-exhausted", "요청이 너무 잦습니다. 잠시 후 다시 시도하세요.");
    }
    tx.set(ref, { n: n + 1, expireAt: new Date(Date.now() + 2 * 3600000) });
  });
}

function mailer() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: MAIL_USER.value(), pass: MAIL_PASS.value() },
  });
}

exports.submitApplication = onCall(
  { region: "asia-northeast3", secrets: [MAIL_USER, MAIL_PASS], memory: "512MiB", timeoutSeconds: 60, maxInstances: 5 },
  async (req) => {
    const d = req.data || {};

    // ── 입력 검증 ──
    const kind = d.kind === "cancel" ? "cancel" : d.kind === "apply" ? "apply" : bad("요청 종류가 올바르지 않습니다.");
    const courseId = str(d.courseId, 64, "과정", true);
    const email = str(d.email, 254, "이메일", true);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad("이메일 주소 형식이 올바르지 않습니다.");
    const title = str(d.title, 200, "제목", false);
    const body = str(d.body, 5000, "내용", false);
    let count = 0;
    let receiptCode = "";
    if (kind === "apply") {
      count = Number(d.count);
      if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) bad(`신청 인원은 1~${MAX_COUNT} 사이여야 합니다.`);
    } else {
      receiptCode = str(d.receiptCode, 16, "접수번호", true).toUpperCase().replace(/\s/g, "");
    }

    // 첨부: 공문 필수(1개 이상), 최대 6개(공문+신청양식+기타 4), 파일당 5MB·전체 8MB.
    const rawAtt = Array.isArray(d.attachments) ? d.attachments : [];
    if (!rawAtt.length) bad("공문 파일을 첨부하세요(필수).");
    if (rawAtt.length > 6) bad("첨부는 최대 6개까지 가능합니다.");
    let totalBytes = 0;
    const attachments = rawAtt.map((a) => {
      const name = str(a && a.name, 200, "첨부파일명", true).replace(/[\r\n"]/g, "_");
      if (!a || typeof a.dataBase64 !== "string" || !a.dataBase64) bad(`첨부파일 데이터가 비었습니다. (${name})`);
      const bytes = Math.floor(a.dataBase64.length * 3 / 4);
      if (bytes > MAX_ATTACH_BYTES) bad(`첨부파일은 파일당 5MB 이하만 가능합니다. (${name})`);
      totalBytes += bytes;
      return { filename: name, content: Buffer.from(a.dataBase64, "base64") };
    });
    if (totalBytes > 8 * 1024 * 1024) bad("첨부파일 전체 합계는 8MB 이하만 가능합니다.");

    await checkRateLimit(req.rawRequest?.ip);

    // ── 접수 이메일 주소(관리자 화면에서 설정, settings/apply — 쉼표 구분 복수 가능) ──
    const applySnap = await db.doc("settings/apply").get();
    const applyTo = (applySnap.exists ? (applySnap.data().email || "") : "")
      .split(/[,;\s]+/).filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
    if (!applyTo.length) throw new HttpsError("failed-precondition", "접수 이메일이 설정되지 않았습니다. 관리자에게 문의하세요.");

    const courseRef = db.doc(`courses/${courseId}`);
    const boardRef = db.doc(`publicBoard/${courseId}`);

    if (kind === "apply") {
      // ── 신청: 잔여석 확인 + 선점(트랜잭션) → 메일 발송 → 실패 시 원복 ──
      const code = newReceiptCode();
      const appRef = db.collection("applications").doc();
      let courseName = "";
      await db.runTransaction(async (tx) => {
        const [cSnap, bSnap] = await Promise.all([tx.get(courseRef), tx.get(boardRef)]);
        if (!cSnap.exists || !bSnap.exists) throw new HttpsError("not-found", "신청할 수 없는 과정입니다.");
        const c = cSnap.data();
        courseName = `${c.name || ""}${c.round ? ` ${c.round}차수` : ""}`;
        // 신청 마감: 교육 시작일까지. 시작일이 지난 과정은 접수 불가(클라이언트 우회 차단).
        if (c.startDate && c.startDate < todayKST()) {
          throw new HttpsError("failed-precondition", "신청이 마감된 과정입니다(교육 시작일 경과).");
        }
        const cap = c.capacity || 0;
        const applied = c.appliedCount || 0;
        if (cap > 0 && applied + count > cap) {
          throw new HttpsError("failed-precondition", `잔여석이 부족합니다(잔여 ${Math.max(0, cap - applied)}석).`);
        }
        tx.update(courseRef, { appliedCount: applied + count });
        tx.update(boardRef, {
          appliedCount: applied + count,
          remaining: Math.max(0, cap - (applied + count)),
          updatedAtMs: Date.now(),
        });
        // 접수 기록: 접수번호 해시·수치·상태.
        // email은 '반려 통지' 목적으로만 보관하며, 반려·취소 처리 즉시 삭제하고
        // 남은 건도 신청 마감일(교육 시작일) 경과 후 자동 삭제한다(purgeAfter).
        tx.set(appRef, {
          codeHash: sha256(code), courseId, courseName, count,
          status: "active", createdAt: admin.firestore.FieldValue.serverTimestamp(),
          email, purgeAfter: c.startDate || "",
        });
      });

      try {
        await mailer().sendMail({
          from: `"교육신청 접수" <${MAIL_USER.value()}>`,
          to: applyTo,
          cc: email,
          subject: `[교육신청] ${courseName} ${count}명 (접수번호 ${code})${title ? ` - ${title}` : ""}`,
          text: [
            `과정: ${courseName}`, `신청 인원: ${count}명`, `접수번호: ${code}`,
            `신청자 이메일: ${email}`, "", body || "(내용 없음)", "",
            "※ 이 메일은 공개 현황 보드의 신청 양식에서 자동 발송되었습니다.",
            "※ 취소는 보드의 '신청 취소'에서 접수번호로 가능합니다.",
          ].join("\n"),
          attachments,
        });
      } catch (e) {
        // 메일 실패 → 선점한 잔여석 원복 + 접수 문서 제거.
        await db.runTransaction(async (tx) => {
          const cSnap = await tx.get(courseRef);
          if (cSnap.exists) {
            const c = cSnap.data();
            const applied = Math.max(0, (c.appliedCount || 0) - count);
            tx.update(courseRef, { appliedCount: applied });
            tx.update(boardRef, { appliedCount: applied, remaining: Math.max(0, (c.capacity || 0) - applied), updatedAtMs: Date.now() });
          }
          tx.delete(appRef);
        }).catch(() => {});
        throw new HttpsError("internal", "이메일 발송에 실패했습니다. 잠시 후 다시 시도하세요.");
      }
      return { ok: true, receiptCode: code, courseName };
    }

    // ── 취소: 접수번호 대조 → 잔여석 복구 → 메일 통지 ──
    const q = await db.collection("applications")
      .where("codeHash", "==", sha256(receiptCode)).limit(1).get();
    if (q.empty) throw new HttpsError("not-found", "접수번호를 찾을 수 없습니다.");
    const appDoc = q.docs[0];
    const app = appDoc.data();
    if (app.status === "rejected") throw new HttpsError("failed-precondition", "반려 처리된 접수번호입니다. 접수 담당자에게 문의하세요.");
    if (app.status !== "active") throw new HttpsError("failed-precondition", "이미 취소된 접수번호입니다.");

    let courseName = app.courseName || "";
    await db.runTransaction(async (tx) => {
      // Firestore 트랜잭션 규칙: 읽기를 전부 먼저, 쓰기는 그 뒤에.
      const cRef = db.doc(`courses/${app.courseId}`);
      const bRef = db.doc(`publicBoard/${app.courseId}`);
      const [aSnap, cSnap, bSnap] = await Promise.all([tx.get(appDoc.ref), tx.get(cRef), tx.get(bRef)]);
      if (!aSnap.exists || aSnap.data().status !== "active") {
        throw new HttpsError("failed-precondition", "이미 취소된 접수번호입니다.");
      }
      if (cSnap.exists) {
        const c = cSnap.data();
        const applied = Math.max(0, (c.appliedCount || 0) - (app.count || 0));
        tx.update(cRef, { appliedCount: applied });
        if (bSnap.exists) {
          tx.update(bRef, { appliedCount: applied, remaining: Math.max(0, (c.capacity || 0) - applied), updatedAtMs: Date.now() });
        }
      }
      // 취소 완료 건은 보관 목적이 사라지므로 이메일을 즉시 삭제한다.
      tx.update(appDoc.ref, {
        status: "cancelled", cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        email: admin.firestore.FieldValue.delete(),
      });
    });

    try {
      await mailer().sendMail({
        from: `"교육신청 접수" <${MAIL_USER.value()}>`,
        to: applyTo,
        cc: email,
        subject: `[교육신청 취소] ${courseName} ${app.count}명 (접수번호 ${receiptCode})${title ? ` - ${title}` : ""}`,
        text: [
          `과정: ${courseName}`, `취소 인원: ${app.count}명`, `접수번호: ${receiptCode}`,
          `요청자 이메일: ${email}`, "", body || "(내용 없음)", "",
          "※ 잔여석은 취소 즉시 공개 보드에 반영되었습니다.",
        ].join("\n"),
        attachments,
      });
    } catch (e) {
      // 취소 자체는 성공 — 메일만 실패했음을 알린다(잔여석 이중 복구 방지 위해 원복하지 않음).
      return { ok: true, cancelled: true, courseName, mailFailed: true };
    }
    return { ok: true, cancelled: true, courseName };
  }
);

/* ================================================================
 *  반려 처리 (관리자 전용)
 *  공문·명단 미비 등으로 접수를 반려한다: 잔여석 복구 + 상태 변경 +
 *  신청자에게 반려 사유 통지 메일 발송 + 보관 중이던 이메일 즉시 삭제.
 * ================================================================ */
exports.rejectApplication = onCall(
  { region: "asia-northeast3", secrets: [MAIL_USER, MAIL_PASS], memory: "256MiB", timeoutSeconds: 60, maxInstances: 5 },
  async (req) => {
    await requireAdmin(req);
    const d = req.data || {};
    const appId = str(d.applicationId, 64, "접수 ID", true);
    const reason = str(d.reason, 1000, "반려 사유", true);

    const appRef = db.doc(`applications/${appId}`);
    const snap = await appRef.get();
    if (!snap.exists) throw new HttpsError("not-found", "접수 기록을 찾을 수 없습니다.");
    const app = snap.data();
    if (app.status !== "active") throw new HttpsError("failed-precondition", "이미 취소·반려된 접수입니다.");

    const applicantEmail = app.email || "";

    // 잔여석 복구 + 상태를 'rejected'로 (이후 신청자가 접수번호로 취소해도 이중 차감되지 않음).
    await db.runTransaction(async (tx) => {
      const cRef = db.doc(`courses/${app.courseId}`);
      const bRef = db.doc(`publicBoard/${app.courseId}`);
      const [aSnap, cSnap, bSnap] = await Promise.all([tx.get(appRef), tx.get(cRef), tx.get(bRef)]);
      if (!aSnap.exists || aSnap.data().status !== "active") {
        throw new HttpsError("failed-precondition", "이미 취소·반려된 접수입니다.");
      }
      if (cSnap.exists) {
        const c = cSnap.data();
        const applied = Math.max(0, (c.appliedCount || 0) - (app.count || 0));
        tx.update(cRef, { appliedCount: applied });
        if (bSnap.exists) {
          tx.update(bRef, { appliedCount: applied, remaining: Math.max(0, (c.capacity || 0) - applied), updatedAtMs: Date.now() });
        }
      }
      tx.update(appRef, {
        status: "rejected", rejectReason: reason,
        rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
        email: admin.firestore.FieldValue.delete(), // 통지 목적 종료 → 즉시 파기
      });
    });

    // 통지 메일(접수처 + 신청자). 이메일이 이미 파기된 오래된 건은 접수처에만 발송.
    const applySnap = await db.doc("settings/apply").get();
    const applyTo = (applySnap.exists ? (applySnap.data().email || "") : "")
      .split(/[,;\s]+/).filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
    if (!applyTo.length) return { ok: true, rejected: true, mailFailed: true, noApplicantEmail: !applicantEmail };
    try {
      await mailer().sendMail({
        from: `"교육신청 접수" <${MAIL_USER.value()}>`,
        to: applyTo,
        cc: applicantEmail || undefined,
        subject: `[교육신청 반려] ${app.courseName || ""} ${app.count}명`,
        text: [
          `과정: ${app.courseName || ""}`, `신청 인원: ${app.count}명`, "",
          "아래 사유로 접수가 반려되었습니다. 보완 후 다시 신청해 주세요.", "",
          `[반려 사유] ${reason}`, "",
          "※ 반려에 따라 잔여석은 복구되었습니다.",
          "※ 기존 접수번호는 더 이상 사용할 수 없습니다(재신청 시 새 접수번호가 발급됩니다).",
        ].join("\n"),
      });
    } catch (e) {
      return { ok: true, rejected: true, mailFailed: true, noApplicantEmail: !applicantEmail };
    }
    return { ok: true, rejected: true, noApplicantEmail: !applicantEmail };
  }
);

/* ================================================================
 *  신청자 이메일 자동 파기 (매일 03:00 KST)
 *  신청 마감일(= 교육 시작일)이 지난 접수 기록의 email 필드를 삭제한다.
 *  개인정보 최소 보관 원칙 — 수치·상태·접수번호 해시는 그대로 남는다.
 * ================================================================ */
exports.purgeApplicationEmails = onSchedule(
  { region: "asia-northeast3", schedule: "0 3 * * *", timeZone: "Asia/Seoul" },
  async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
    const snap = await db.collection("applications")
      .where("purgeAfter", "<", today).limit(500).get();
    let n = 0;
    let batch = db.batch();
    snap.docs.forEach((d) => {
      if (d.data().email == null) return; // 이미 파기됨
      batch.update(d.ref, { email: admin.firestore.FieldValue.delete() });
      n++;
    });
    if (n) await batch.commit();
    console.log(`신청자 이메일 파기: ${n}건 (기준일 ${today})`);
  }
);

/* ================================================================
 *  sendLogiPush — 로지보드 FCM 푸시 발송 (관리자 전용 callable)
 *  Firestore/RTDB 트리거 대신 관리자 조작(공지·투표·Q&A 답장) 직후
 *  화면에서 호출한다(트리거 리전 제약 회피 + 발송 조건 명시적).
 *  대상: logiTokens/{token} — courseId(필수), threadKey(1:1 답장일 때만).
 *  무효 토큰(해지·만료)은 발송 결과를 보고 즉시 삭제한다.
 * ================================================================ */
exports.sendLogiPush = onCall(
  { region: "asia-northeast3", memory: "256MiB", timeoutSeconds: 30, maxInstances: 3 },
  async (req) => {
    await requireAdmin(req);
    const courseId = str(req.data?.courseId, 100, "과정 ID", true);
    const title = str(req.data?.title, 100, "제목", true);
    const body = str(req.data?.body, 300, "내용", false);
    const threadKey = str(req.data?.threadKey, 60, "스레드 키", false);
    const link = str(req.data?.link, 500, "링크", false);
    if (link && !/^https:\/\//.test(link)) bad("링크 형식이 올바르지 않습니다.");

    let q = db.collection("logiTokens").where("courseId", "==", courseId);
    if (threadKey) q = q.where("threadKey", "==", threadKey);
    const snap = await q.limit(500).get();
    const docs = snap.docs.filter((d) => typeof d.data().token === "string" && d.data().token);
    const tokens = [...new Set(docs.map((d) => d.data().token))];
    if (!tokens.length) return { sent: 0, targets: 0 };

    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body: body.slice(0, 200) },
      webpush: {
        notification: { icon: "icons/logi-192.png", badge: "icons/logi-192.png" },
        ...(link ? { fcmOptions: { link } } : {}),
      },
    });
    // 무효 토큰 정리(기기에서 알림 해제·앱 삭제 등).
    const dead = new Set();
    res.responses.forEach((r, i) => {
      const code = r.error?.code || "";
      if (!r.success && /not-registered|invalid-registration-token|invalid-argument/.test(code)) dead.add(tokens[i]);
    });
    if (dead.size) {
      const batch = db.batch();
      docs.filter((d) => dead.has(d.data().token)).forEach((d) => batch.delete(d.ref));
      await batch.commit().catch(() => {});
    }
    return { sent: res.successCount, targets: tokens.length, removed: dead.size };
  }
);

/* ================================================================
 *  submitSurveyPhotos — 설문 '사진 첨부' 문항 중계 (비로그인 공개 호출)
 *  사진은 저장하지 않고 메모리에서 담당자 메일로 첨부 발송만 한다.
 *  (설문 응답 본문은 클라이언트가 별도로 surveyResponses에 익명 기록)
 *  수신 주소: settings/surveyPhotoMail.byCourse[courseId] → 없으면 .default
 *  (관리자 전용 문서이므로 서버에서만 조회 — 공개 페이지에 주소가 노출되지 않는다)
 * ================================================================ */
exports.submitSurveyPhotos = onCall(
  { region: "asia-northeast3", secrets: [MAIL_USER, MAIL_PASS], memory: "512MiB", timeoutSeconds: 60, maxInstances: 5 },
  async (req) => {
    const d = req.data || {};
    const courseId = str(d.courseId, 100, "과정 ID", true);
    const roomId = str(d.roomId, 100, "강의실 ID", false);
    const answers = str(d.answers, 6000, "응답 요약", false);
    // 제출코드: 시스템에 남는 익명 응답 기록과 이 메일을 잇는 임의 식별자.
    const submitCode = str(d.submitCode, 16, "제출코드", false).toUpperCase().replace(/[^A-Z0-9]/g, "");

    // 남용 방지(설문은 비로그인 공개 제출이므로 신청 접수와 동일한 IP 제한 적용).
    await checkRateLimit(req.rawRequest?.ip || req.rawRequest?.headers?.["x-forwarded-for"] || "");

    // 메일 전용 입력(연락처 등) — 시스템에 저장되지 않고 이 메일에만 실린다.
    const rawTexts = Array.isArray(d.mailTexts) ? d.mailTexts : [];
    if (rawTexts.length > 10) bad("추가 입력 항목이 너무 많습니다.");
    const mailTexts = rawTexts.map((t) => ({
      label: str(t && t.label, 200, "항목명", false) || "추가 입력",
      text: str(t && t.text, 200, "입력값", true),
    }));

    const rawPhotos = Array.isArray(d.photos) ? d.photos : [];
    if (!rawPhotos.length && !mailTexts.length) bad("전송할 내용이 없습니다.");
    if (rawPhotos.length > 5) bad("사진은 최대 5장까지 첨부할 수 있습니다.");
    let totalBytes = 0;
    const attachments = rawPhotos.map((p, i) => {
      const label = str(p && p.label, 200, "문항명", false).replace(/[\r\n"]/g, "_") || `사진${i + 1}`;
      if (!p || typeof p.dataBase64 !== "string" || !p.dataBase64) bad("사진 데이터가 비었습니다.");
      const bytes = Math.floor(p.dataBase64.length * 3 / 4);
      if (bytes > MAX_ATTACH_BYTES) bad("사진은 장당 5MB 이하만 가능합니다.");
      totalBytes += bytes;
      return { filename: `${label}_${i + 1}.jpg`, content: Buffer.from(p.dataBase64, "base64") };
    });
    if (totalBytes > 8 * 1024 * 1024) bad("사진 전체 합계는 8MB 이하만 가능합니다.");

    // 과정명(메일 제목용)과 수신 주소 조회.
    let courseName = courseId;
    try {
      const c = await db.doc(`courses/${courseId}`).get();
      if (c.exists) courseName = `${c.data().name || courseId}${c.data().round ? ` ${c.data().round}차수` : ""}`;
    } catch { /* 이름 없이 진행 */ }

    let to = "";
    try {
      const s = await db.doc("settings/surveyPhotoMail").get();
      const cfg = s.exists ? s.data() : {};
      to = String((cfg.byCourse || {})[courseId] || cfg.default || "").trim();
    } catch { /* */ }
    if (!to) throw new HttpsError("failed-precondition", "사진 수신 이메일이 설정되지 않았습니다. 관리자에게 문의하세요.");

    const now = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date());
    try {
      await mailer().sendMail({
        from: MAIL_USER.value(),
        to,
        subject: `[설문 제출] ${courseName} — ${now}${submitCode ? ` (제출코드 ${submitCode})` : ""}`,
        text: [
          `과정: ${courseName}`,
          submitCode ? `제출코드: ${submitCode}  ← 설문 관리 탭의 '제출코드 조회'에 입력하면 이 사진에 해당하는 응답 기록을 볼 수 있습니다.` : "",
          roomId ? `강의실 ID: ${roomId}` : "",
          `제출 시각(KST): ${now}`,
          `첨부 사진: ${attachments.length}장`,
          ...(mailTexts.length ? ["", "─ 추가 입력(시스템 미저장) ─", ...mailTexts.map((t) => `${t.label}: ${t.text}`)] : []),
          "",
          "─ 응답 요약 ─",
          answers || "(요약 없음)",
          "",
          "※ 사진은 시스템에 저장되지 않으며 이 메일로만 전달됩니다.",
        ].filter(Boolean).join("\n"),
        attachments,
      });
    } catch (e) {
      throw new HttpsError("internal", "사진 메일 발송에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    }
    return { sent: attachments.length };
  }
);

/* ================================================================
 *  기명 조사(namedSurveys) — 익명 설문과 완전히 분리된 개인정보 처리 경로
 *
 *  익명 설문(surveyResponses)과 달리 이 경로는 개인정보를 처리한다.
 *  · 응답자 식별자(아이디 등)는 원문을 저장하지 않고 서버에서만 해시로 변환한다.
 *    해시 비밀값은 Firebase Secret(SURVEY_ID_SALT)에만 두며 저장소에 남기지 않는다.
 *    비밀값 없이는 응답을 받지 않는다(가명처리 전제가 깨진 상태로 수집 금지).
 *  · 선택 목적(경품 이벤트 등) 항목인 사진·연락처는 저장하지 않고 담당자 메일로만 전달한다.
 *  · 응답 문서에는 목적별 파기 예정일(purgeAt)을 함께 기록하고, 일일 배치가 파기한다.
 *  클라이언트는 namedResponses를 직접 읽거나 쓸 수 없다(보안규칙에서 전면 차단).
 * ================================================================ */
const SURVEY_ID_SALT = defineSecret("SURVEY_ID_SALT");
const NAMED_RESP = "namedResponses";      // 응답 본문 — 식별자를 붙이지 않는다
const NAMED_MARK = "namedRespondents";    // 중복 방지 표시 — 식별자 해시만, 응답과 연결선 없음

// 응답자 식별자 → 되돌릴 수 없는 해시.
// 대상 인원이 적어 단순 해시는 전수 대입으로 복원되므로, 서버 전용 비밀값을 키로 쓴다.
function hashRespondentId(surveyId, rawId) {
  const key = String(SURVEY_ID_SALT.value() || "");
  if (key.length < 16) {
    throw new HttpsError("failed-precondition",
      "조사 설정이 완료되지 않았습니다(식별자 보호 키 미설정). 관리자에게 문의하세요.");
  }
  const norm = String(rawId).trim().toLowerCase();
  return crypto.createHmac("sha256", key).update(`${surveyId}|${norm}`).digest("hex");
}

const addDays = (days) => new Date(Date.now() + days * 86400000);
// 수집일(KST) 자정 기준 + N일. 중복 방지 표시의 파기 예정일을 일 단위로 맞춰,
// 응답 문서의 파기 예정일(밀리초 정밀)과 대조해 두 문서를 잇지 못하게 한다.
function dayAlignedPurge(collectedDate, days) {
  return new Date(new Date(`${collectedDate}T00:00:00+09:00`).getTime() + (days + 1) * 86400000);
}

exports.submitNamedSurvey = onCall(
  { region: "asia-northeast3", secrets: [MAIL_USER, MAIL_PASS, SURVEY_ID_SALT], memory: "512MiB", timeoutSeconds: 60, maxInstances: 5 },
  async (req) => {
    const d = req.data || {};
    const surveyId = str(d.surveyId, 100, "조사 ID", true);
    // 대상자가 같은 기관망(하나의 공인 IP) 뒤에 몰릴 수 있어 접수 제한을 별도로 둔다.
    // 중복 응답은 식별자 해시로 막으므로 IP 제한은 남용 방지 용도에 한한다.
    await checkRateLimit(req.rawRequest?.ip || req.rawRequest?.headers?.["x-forwarded-for"] || "", NAMED_RATE_LIMIT_PER_HOUR);

    const snap = await db.doc(`namedSurveys/${surveyId}`).get();
    if (!snap.exists) bad("조사를 찾을 수 없습니다.");
    const sv = snap.data();
    const now = Date.now();
    if (sv.status !== "open") throw new HttpsError("failed-precondition", "현재 응답을 받지 않는 조사입니다.");
    if (sv.openMs && now < sv.openMs) throw new HttpsError("failed-precondition", "아직 시작되지 않은 조사입니다.");
    if (sv.closeMs && now > sv.closeMs) throw new HttpsError("failed-precondition", "응답 기간이 종료된 조사입니다.");

    // ── 필수 목적 동의 ──
    if (d.consentMain !== true) bad("필수 항목 수집·이용에 동의해야 응답할 수 있습니다.");
    const optEnabled = !!(sv.purposeOpt && sv.purposeOpt.enabled);
    const consentOpt = optEnabled && d.consentOpt === true;

    // ── 응답자 식별자(원문은 저장하지 않음) ──
    const rawId = str(d.respondentId, 100, sv.idLabel || "식별자", true);
    const idHash = hashRespondentId(surveyId, rawId);

    // ── 문항 응답 검증(정의 기준) ──
    const given = Array.isArray(d.answers) ? d.answers : [];
    const defs = Array.isArray(sv.questions) ? sv.questions : [];
    // 클라이언트가 함께 보낸 문항 라벨이 현재 정의와 어긋나면(응답 중 문항 개정 등)
    // 위치만 믿고 저장하지 않는다 — 엉뚱한 문항에 답이 붙는 것을 막는다.
    const seenLabels = Array.isArray(d.labels) ? d.labels : null;
    if (!seenLabels || seenLabels.length !== defs.length
        || defs.some((q, i) => String(q?.label || "") !== String(seenLabels[i] || ""))) {
      throw new HttpsError("failed-precondition",
        "설문 문항이 변경되었습니다. 페이지를 새로고침한 뒤 다시 제출해 주세요.");
    }
    const answers = [];
    for (let i = 0; i < defs.length; i++) {
      const q = defs[i] || {};
      const raw = given[i];
      const v = Array.isArray(raw) ? raw.map((x) => str(x, 200, q.label, false)).filter(Boolean)
        : str(raw, 1000, q.label || `문항 ${i + 1}`, false);
      const empty = Array.isArray(v) ? v.length === 0 : v === "";
      if (empty) {
        if (q.required) bad(`'${q.label || `문항 ${i + 1}`}' 항목에 응답해 주세요.`);
        continue;
      }
      answers.push({ label: String(q.label || `문항 ${i + 1}`).slice(0, 200), value: v });
    }

    // ── 선택 목적 항목(사진·연락처): 저장하지 않고 메일로만 ──
    const photos = consentOpt && Array.isArray(d.photos) ? d.photos : [];
    const rawTexts = consentOpt && Array.isArray(d.mailTexts) ? d.mailTexts : [];
    if (photos.length > 5) bad("사진은 최대 5장까지 첨부할 수 있습니다.");
    if (rawTexts.length > 10) bad("추가 입력 항목이 너무 많습니다.");
    const mailTexts = rawTexts.map((t) => ({
      label: str(t && t.label, 200, "항목명", false) || "추가 입력",
      text: str(t && t.text, 200, "입력값", true),
    }));
    let totalBytes = 0;
    const photoLabels = [];
    const attachments = photos.map((p, i) => {
      const label = str(p && p.label, 200, "문항명", false).replace(/[\r\n"]/g, "_") || `사진${i + 1}`;
      photoLabels.push(label);
      if (!p || typeof p.dataBase64 !== "string" || !p.dataBase64) bad("사진 데이터가 비었습니다.");
      const bytes = Math.floor(p.dataBase64.length * 3 / 4);
      if (bytes > MAX_ATTACH_BYTES) bad("사진은 장당 5MB 이하만 가능합니다.");
      totalBytes += bytes;
      return { filename: `${label}_${i + 1}.jpg`, content: Buffer.from(p.dataBase64, "base64") };
    });
    if (totalBytes > 8 * 1024 * 1024) bad("사진 전체 합계는 8MB 이하만 가능합니다.");

    // ── 중복 응답 차단 ──
    // 식별자 해시는 '응답을 마쳤다'는 표시로만 별도 컬렉션에 두고 응답 본문에는 붙이지 않는다.
    // 두 문서 사이에 연결선이 없으므로, 해시를 되돌리더라도 누가 응답했는지까지만 알 수 있고
    // 무엇이라고 답했는지는 알 수 없다(응답 본문은 그 자체로 특정 개인을 알아볼 수 없는 정보).
    // 문서 ID를 조사ID+해시로 고정해 트랜잭션으로 선점한다 — 조회 후 쓰기는 동시 제출에서 새어나간다.
    const markRef = db.collection(NAMED_MARK).doc(`${surveyId}__${idHash}`);

    // ── 접수 자리 선점(중복 차단) ──
    // 메일보다 먼저 선점해야 동시 제출에서 메일이 두 번 나가지 않는다.
    const mainDays = Math.max(1, Number(sv.purposeMain?.retainDays) || 365);
    const submitCode = (attachments.length || mailTexts.length) ? newReceiptCode() : "";
    const collectedDate = todayKST();
    const purgeAt = addDays(mainDays);
    const record = {
      surveyId,
      answers,
      consentMain: true,
      consentOpt,
      collectedDate,
      collectedAt: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }).format(new Date()),
      purgeAt,                                 // 필수 목적 보유기간 만료일
      createdAtMs: Date.now(),
    };
    if (submitCode) {
      record.submitCode = submitCode;          // 메일↔응답 매칭용 임의값
      record.optNotes = [
        ...attachments.map((a, i) => photoLabels[i]),
        ...mailTexts.map((t) => t.label),
      ].slice(0, 20).map((label) => ({ label, submitted: true }));
    }
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(markRef);
      if (cur.exists) {
        throw new HttpsError("already-exists", "이미 응답이 접수된 " + (sv.idLabel || "식별자") + "입니다.");
      }
      // 표시에는 조사·수집일·파기예정일만 둔다. 응답 문서 ID를 적지 않는다 —
      // 적는 순간 응답과 개인이 다시 이어져 분리 저장의 의미가 사라진다.
      // 시각도 일(日) 단위로 뭉갠다. 밀리초까지 남기면 같은 시각의 응답과 짝지어
      // 연결선을 복원할 수 있어(타임스탬프 대조) 분리가 무의미해진다.
      tx.create(markRef, { surveyId, collectedDate, purgeAt: dayAlignedPurge(collectedDate, mainDays) });
    });
    const respRef = db.collection(NAMED_RESP).doc();
    try {
      await respRef.create(record);
    } catch (e) {
      await markRef.delete().catch(() => { /* */ });
      throw new HttpsError("internal", "응답 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    }

    // ── 선택 목적 메일 발송 ──
    // 발송에 실패하면 접수를 통째로 되돌려, 응답만 남고 사진·연락처가 유실되는 상태를 막는다.
    const rollback = async () => {
      await respRef.delete().catch(() => { /* */ });
      await markRef.delete().catch(() => { /* 되돌리기 실패 시 재시도가 중복으로 걸린다 */ });
    };
    if (submitCode) {
      let to = "";
      try {
        const s = await db.doc("settings/namedSurveyMail").get();
        const cfg = s.exists ? s.data() : {};
        to = String((cfg.bySurvey || {})[surveyId] || cfg.default || "").trim();
      } catch { /* */ }
      if (!to) {
        await rollback();
        throw new HttpsError("failed-precondition", "제출물 수신 이메일이 설정되지 않았습니다. 관리자에게 문의하세요.");
      }
      const when = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date());
      try {
        await mailer().sendMail({
          from: MAIL_USER.value(),
          to,
          subject: `[${sv.title || "기명 조사"}] 선택 항목 제출 — ${when} (제출코드 ${submitCode})`,
          text: [
            `조사: ${sv.title || surveyId}`,
            `제출 일시: ${when}`,
            `제출코드: ${submitCode}`,
            "",
            mailTexts.length ? "─ 추가 입력(시스템 미저장) ─" : "",
            ...mailTexts.map((t) => `· ${t.label}: ${t.text}`),
            mailTexts.length ? "" : "",
            "※ 이 메일의 사진과 입력값은 시스템에 저장되지 않습니다.",
            `※ 목적: ${(sv.purposeOpt && sv.purposeOpt.label) || "선택 목적"} — 목적 달성 후 이 메일을 삭제해야 파기가 완료됩니다.`,
          ].filter((x) => x !== "").join("\n"),
          attachments,
        });
      } catch (e) {
        await rollback();
        if (e instanceof HttpsError) throw e;
        throw new HttpsError("internal", "제출물 발송에 실패했습니다. 잠시 후 다시 시도해 주세요.");
      }
    }

    return { ok: true, submitCode };
  }
);

// 보유기간이 지난 기명 응답 파기(일 1회). 익명 설문의 수동 파기와 달리 자동 실행한다 —
// 개인정보는 보유기간 경과 시 지체 없이 파기해야 하므로 담당자 조작에 의존하지 않는다.
exports.purgeNamedResponses = onSchedule(
  { region: "asia-northeast3", schedule: "10 3 * * *", timeZone: "Asia/Seoul" },
  async () => {
    // 응답 본문과 중복 방지 표시는 같은 보유기간을 가지므로 함께 파기한다.
    for (const coll of [NAMED_RESP, NAMED_MARK]) {
      const snap = await db.collection(coll).where("purgeAt", "<=", new Date()).limit(400).get();
      if (snap.empty) continue;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      console.log(`${coll} 파기: ${snap.size}건`);
    }
  }
);

/* ================================================================
 *  기명 조사 취급자 접속기록 (안전성 확보조치 — 법 제29조)
 *
 *  개인정보처리시스템(= 기명 조사 응답 화면)의 조회·내보내기·파기를 모두
 *  이 함수들을 거치게 하고, 호출마다 accessLogs에 기록을 남긴다.
 *  브라우저에서 namedResponses를 직접 읽지 못하게 규칙으로 막아 두었으므로
 *  기록되지 않는 열람 경로가 존재하지 않는다.
 *
 *  기록 항목: 계정 · 접속일시(KST) · 접속지 IP · 수행업무 · 대상 조사 · 처리 건수
 *  (취급자는 정보주체가 아닌 직원이므로 IP 기록이 익명 설문의 IP 미저장 원칙과 무관)
 *  보관: 1년 — 고유식별정보·민감정보를 처리하지 않고 규모도 5만 명 미만이라 2년 요건 밖.
 *  위·변조 방지: accessLogs는 이 함수만 기록하고 수정·삭제 경로를 두지 않는다.
 * ================================================================ */
const ACCESS_LOG = "accessLogs";
const ACCESS_LOG_KEEP_DAYS = 400; // 1년 + 여유

// 기명 조사 취급자 판정. 마스터이거나 'named' 탭을 명시적으로 받은 계정만.
// (참관자는 조회도 허용하지 않는다 — 보안규칙의 canTab과 동일 기준)
async function requireNamedTab(req) {
  const email = String(req.auth?.token?.email || "").toLowerCase();
  if (!email) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  // 부트스트랩 마스터는 admins 문서 없이도 규칙상 마스터이므로 동일하게 취급한다
  // (문서가 없다는 이유로 응답 조회·파기가 막히면 잠금 상태가 된다).
  if (BOOTSTRAP_ADMINS.includes(email)) return email;
  const snap = await db.doc(`admins/${email}`).get();
  if (!snap.exists) throw new HttpsError("permission-denied", "관리자만 사용할 수 있습니다.");
  const a = snap.data() || {};
  if (a.role === "observer") throw new HttpsError("permission-denied", "참관자 계정은 기명 조사에 접근할 수 없습니다.");
  if (a.role === "master") return email;
  const tabs = Array.isArray(a.tabs) ? a.tabs : null;
  if (!tabs || !tabs.includes("named")) {
    throw new HttpsError("permission-denied", "기명 조사 권한이 없는 계정입니다.");
  }
  return email;
}

const kstStamp = () => new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "medium",
}).format(new Date());

// 접속기록 1건. 기록 실패가 본 작업을 되돌리지는 못하므로, 파기·내보내기처럼
// 기록이 반드시 남아야 하는 작업은 호출부에서 기록을 먼저 남긴 뒤 수행한다.
async function writeAccessLog(entry) {
  await db.collection(ACCESS_LOG).add({
    ...entry,
    atMs: Date.now(),
    atKst: kstStamp(),
    expireAt: addDays(ACCESS_LOG_KEEP_DAYS),
  });
}
const ipOf = (req) => String(req.rawRequest?.ip || req.rawRequest?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();

const NAMED_OPTS = { region: "asia-northeast3", memory: "256MiB", timeoutSeconds: 60, maxInstances: 5 };

// 응답 목록 조회.
exports.namedResponsesList = onCall(NAMED_OPTS, async (req) => {
  const account = await requireNamedTab(req);
  const surveyId = str(req.data?.surveyId, 100, "조사 ID", true);
  const snap = await db.collection(NAMED_RESP).where("surveyId", "==", surveyId).get();
  const rows = snap.docs.map((d) => {
    const v = d.data();
    return {
      id: d.id,
      collectedDate: v.collectedDate || "",
      collectedAt: v.collectedAt || "",
      consentOpt: !!v.consentOpt,
      submitCode: v.submitCode || "",
      answers: v.answers || [],
      optNotes: v.optNotes || [],
      purgeAtMs: v.purgeAt?.toMillis ? v.purgeAt.toMillis() : 0,
      createdAtMs: v.createdAtMs || 0,
    };
  });
  await writeAccessLog({ account, ip: ipOf(req), op: "조회", surveyId, count: rows.length });
  return { rows };
});

// 내보내기(다운로드). 고시가 다운로드 사유 확인을 따로 요구하므로 사유를 필수로 받는다.
exports.namedResponsesExport = onCall(NAMED_OPTS, async (req) => {
  const account = await requireNamedTab(req);
  const surveyId = str(req.data?.surveyId, 100, "조사 ID", true);
  const reason = str(req.data?.reason, 300, "내보내기 사유", true);
  if (reason.length < 5) bad("내보내기 사유를 구체적으로 입력하세요(5자 이상).");
  const snap = await db.collection(NAMED_RESP).where("surveyId", "==", surveyId).get();
  const rows = snap.docs.map((d) => {
    const v = d.data();
    return {
      id: d.id,
      collectedDate: v.collectedDate || "",
      collectedAt: v.collectedAt || "",
      consentOpt: !!v.consentOpt,
      submitCode: v.submitCode || "",
      answers: v.answers || [],
    };
  });
  await writeAccessLog({ account, ip: ipOf(req), op: "내보내기", surveyId, count: rows.length, reason });
  return { rows };
});

// 수동 파기. 되돌릴 수 없는 작업이므로 기록을 먼저 남기고 삭제한다.
// 응답 본문과 중복 방지 표시는 서로 연결되어 있지 않으므로 개별 응답만 지우면 표시가 남는다.
// 그래서 수집일 범위 파기(range)에서는 같은 기간의 표시도 함께 지운다.
exports.namedResponsesDelete = onCall(NAMED_OPTS, async (req) => {
  const account = await requireNamedTab(req);
  const surveyId = str(req.data?.surveyId, 100, "조사 ID", true);
  const reason = str(req.data?.reason, 300, "파기 사유", true);
  if (reason.length < 2) bad("파기 사유를 입력하세요.");
  const from = str(req.data?.from, 10, "시작일", false);
  const to = str(req.data?.to, 10, "종료일", false);
  const ids = Array.isArray(req.data?.ids) ? req.data.ids : [];
  if (!ids.length) bad("파기할 응답이 없습니다.");
  if (ids.length > 400) bad("한 번에 400건까지 파기할 수 있습니다.");
  const refs = ids.map((id) => db.collection(NAMED_RESP).doc(str(id, 200, "응답 ID", true)));

  // 다른 조사의 응답이 섞여 들어오지 않는지 확인(권한 우회 방지).
  const docs = await db.getAll(...refs);
  const targets = docs.filter((d) => d.exists && d.data().surveyId === surveyId);
  if (!targets.length) bad("파기할 응답을 찾을 수 없습니다.");

  // 기간 파기일 때만 중복 방지 표시도 함께 지운다(같은 조사·같은 수집일 범위).
  let marks = [];
  if (from && to) {
    const ms = await db.collection(NAMED_MARK)
      .where("surveyId", "==", surveyId)
      .where("collectedDate", ">=", from).where("collectedDate", "<=", to)
      .limit(400).get();
    marks = ms.docs;
  }

  await writeAccessLog({
    account, ip: ipOf(req), op: "파기", surveyId,
    count: targets.length, reason: `${reason}${marks.length ? ` (중복 방지 표시 ${marks.length}건 포함)` : ""}`,
  });
  const batch = db.batch();
  targets.forEach((d) => batch.delete(d.ref));
  marks.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return { deleted: targets.length, marks: marks.length };
});

// 월 1회 점검 기록. 점검 자체도 기록으로 남겨 이행 여부를 확인할 수 있게 한다.
exports.namedAccessReview = onCall(NAMED_OPTS, async (req) => {
  const account = await requireNamedTab(req);
  const month = str(req.data?.month, 7, "점검 대상 월", true);
  if (!/^\d{4}-\d{2}$/.test(month)) bad("점검 대상 월은 YYYY-MM 형식입니다.");
  const note = str(req.data?.note, 500, "점검 의견", false);
  await writeAccessLog({ account, ip: ipOf(req), op: "점검", surveyId: "", count: 0, reason: `${month} 점검${note ? ` — ${note}` : ""}` });
  return { ok: true };
});

// 보관기간이 지난 접속기록 파기(일 1회).
exports.purgeAccessLogs = onSchedule(
  { region: "asia-northeast3", schedule: "20 3 * * *", timeZone: "Asia/Seoul" },
  async () => {
    const snap = await db.collection(ACCESS_LOG).where("expireAt", "<=", new Date()).limit(400).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    console.log(`접속기록 파기: ${snap.size}건`);
  }
);

// 응답 건수만 확인(조사 삭제 가능 여부 판단용).
// 개인정보를 반환하지 않으므로 열람이 아니며, 접속기록에 '조회'로 남기지 않는다.
exports.namedResponsesCount = onCall(NAMED_OPTS, async (req) => {
  await requireNamedTab(req);
  const surveyId = str(req.data?.surveyId, 100, "조사 ID", true);
  const agg = await db.collection(NAMED_RESP).where("surveyId", "==", surveyId).count().get();
  return { count: agg.data().count };
});
