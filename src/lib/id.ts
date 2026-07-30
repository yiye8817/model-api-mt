/** 生成唯一 ID；公网 HTTP（非安全上下文）下 crypto.randomUUID 不可用，需回退。 */
export function newUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* 非 HTTPS / 非 localhost 时 randomUUID 可能抛错 */
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
