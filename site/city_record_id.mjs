const CITY_RECORD_REQUEST_ID = /^\d{11}$/;

export function cityRecordRequestIdIsValid(value) {
  return CITY_RECORD_REQUEST_ID.test(String(value ?? "").trim());
}

export function cityRecordRequestUrl(value) {
  const id = String(value ?? "").trim();
  if (!cityRecordRequestIdIsValid(id)) return null;
  return `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`;
}
