// 교육 신청/취소 접수 Cloud Function.
// - 이메일 발송(접수처 + 신청자 확인용) 후 신청건수를 트랜잭션으로 즉시 반영(실시간 잔여석).
// - 첨부파일은 메모리에서 메일로 중계만 하고 어디에도 저장하지 않는다.
// - 개인정보(이메일 주소·첨부)는 Firestore에 저장하지 않는다. 접수 문서에는
//   접수번호 해시·과정ID·인원수·상태만 남는다.
// - 취소는 신청 시 발급한 접수번호로 본인 확인(해시 대조) 후 잔여석 복구.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
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
    let attachment = null;
    let receiptCode = "";
    if (kind === "apply") {
      count = Number(d.count);
      if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) bad(`신청 인원은 1~${MAX_COUNT} 사이여야 합니다.`);
      if (d.attachment) {
        const a = d.attachment;
        const name = str(a.name, 200, "첨부파일명", true).replace(/[\r\n"]/g, "_");
        if (typeof a.dataBase64 !== "string" || !a.dataBase64) bad("첨부파일 데이터가 비었습니다.");
        const bytes = Math.floor(a.dataBase64.length * 3 / 4);
        if (bytes > MAX_ATTACH_BYTES) bad("첨부파일은 5MB 이하만 가능합니다.");
        attachment = { filename: name, content: Buffer.from(a.dataBase64, "base64") };
      }
    } else {
      receiptCode = str(d.receiptCode, 16, "접수번호", true).toUpperCase().replace(/\s/g, "");
    }

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
        // 개인정보 없음: 접수번호 해시·수치·상태만.
        tx.set(appRef, {
          codeHash: sha256(code), courseId, courseName, count,
          status: "active", createdAt: admin.firestore.FieldValue.serverTimestamp(),
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
          attachments: attachment ? [attachment] : [],
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
      tx.update(appDoc.ref, { status: "cancelled", cancelledAt: admin.firestore.FieldValue.serverTimestamp() });
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
      });
    } catch (e) {
      // 취소 자체는 성공 — 메일만 실패했음을 알린다(잔여석 이중 복구 방지 위해 원복하지 않음).
      return { ok: true, cancelled: true, courseName, mailFailed: true };
    }
    return { ok: true, cancelled: true, courseName };
  }
);
