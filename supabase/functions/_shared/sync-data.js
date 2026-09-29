// Node/Edge 共通の小さなヘルパー。
export const japanDate = (date = new Date()) => new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
}).format(date);

export async function must(query) {
  const { data, error } = await query;
  if (error) throw new Error(error.message || "データベース処理に失敗しました");
  return data;
}
