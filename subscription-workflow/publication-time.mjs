const shanghai = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

export function publicationDateFromSeconds(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function publicationMetadata(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return `**发布日期**：${value}`;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `**发布时间**：${shanghai.format(date)}（北京时间）`
    : "";
}
