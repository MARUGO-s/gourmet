const SEP = "\u001e";

export function packIkyuUsername(storeId, operatorId) {
  const store = String(storeId ?? "").trim();
  const operator = String(operatorId ?? "").trim();
  if (!/^\d{6}$/.test(store) || !operator || operator.includes(SEP) || operator.length > 200) return null;
  return `${store}${SEP}${operator}`;
}

export function unpackIkyuUsername(username) {
  const parts = String(username ?? "").split(SEP);
  if (parts.length !== 2 || !/^\d{6}$/.test(parts[0]) || !parts[1]) return null;
  return { storeId: parts[0], operatorId: parts[1] };
}
