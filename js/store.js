// 공용 Firestore 실시간 컬렉션 헬퍼.
// 각 메뉴 모듈이 onSnapshot 보일러플레이트를 반복하지 않도록 캐시+구독을 제공.
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  setDoc,
  doc,
  onSnapshot,
  getDoc,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";

const caches = {};    // collName -> 최신 문서 배열
const listeners = {}; // collName -> 콜백 배열
const unsubs = {};    // collName -> onSnapshot 해제 함수

// 컬렉션 실시간 구독 시작(한 번만). orderField 지정 시 서버 정렬.
export function watchCollection(collName, orderField) {
  if (unsubs[collName]) return;
  caches[collName] = caches[collName] || [];
  listeners[collName] = listeners[collName] || [];
  const base = collection(db, collName);
  const q = orderField ? query(base, orderBy(orderField)) : base;
  unsubs[collName] = onSnapshot(q, (snap) => {
    caches[collName] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    listeners[collName].forEach((cb) => cb(caches[collName]));
  });
}

// 컬렉션 변경 구독. 등록 즉시 현재 캐시로 1회 호출.
export function onCollection(collName, cb) {
  listeners[collName] = listeners[collName] || [];
  listeners[collName].push(cb);
  cb(caches[collName] || []);
  return () => {
    listeners[collName] = listeners[collName].filter((f) => f !== cb);
  };
}

export function getCache(collName) {
  return caches[collName] || [];
}

export function addItem(collName, data) {
  return addDoc(collection(db, collName), data);
}
export function updateItem(collName, id, data) {
  return updateDoc(doc(db, collName, id), data);
}
export function removeItem(collName, id) {
  return deleteDoc(doc(db, collName, id));
}

// 문서 ID 지정 저장(설정 문서 등).
export function setDocById(collName, id, data) {
  return setDoc(doc(db, collName, id), data);
}
export async function getDocById(collName, id) {
  const s = await getDoc(doc(db, collName, id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}
