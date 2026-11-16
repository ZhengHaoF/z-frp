/** HTTP 隧道用的完整域名校验，服务端注册与建隧道共用同一份规则。 */

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  if (host.length < 3 || host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => LABEL.test(label));
}
