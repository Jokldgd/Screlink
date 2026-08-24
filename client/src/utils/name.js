/** 昵称本地存储（跨会话记住） */
const KEY = 'roomvoice:userName';

export function getStoredName() {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

export function storeName(name) {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    /* ignore */
  }
}
