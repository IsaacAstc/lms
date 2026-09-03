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
async function checkRateLimit(rawIp) {
  const hour = Math.floor(Date.now() / 3600000);
  const key = sha256(`${rawIp || "unknown"}:${hour}`).slice(0, 32);
  const ref = db.collection("rateLimits").doc(key);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const n = snap.exists ? (snap.data().n || 0) : 0;
    if (n >= RATE_LIMIT_PER_HOUR) {
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

    const rawPhotos = Array.isArray(d.photos) ? d.photos : [];
    if (!rawPhotos.length) bad("전송할 사진이 없습니다.");
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
        subject: `[설문 사진] ${courseName} — ${now}${submitCode ? ` (제출코드 ${submitCode})` : ""}`,
        text: [
          `과정: ${courseName}`,
          submitCode ? `제출코드: ${submitCode}  ← 설문 관리 탭의 '제출코드 조회'에 입력하면 이 사진에 해당하는 응답 기록을 볼 수 있습니다.` : "",
          roomId ? `강의실 ID: ${roomId}` : "",
          `제출 시각(KST): ${now}`,
          `첨부 사진: ${attachments.length}장`,
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
